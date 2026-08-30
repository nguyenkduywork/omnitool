/// <reference types="vite/client" />
// src/tools/data/ocr.op.ts — OCR scanned PDFs and photos to text.
//
// tesseract.js is the engine. It spawns its OWN nested Worker, from inside
// THIS op's Worker, to run the actual recognition. Everything below exists
// to make that nested worker fetch nothing but same-origin bytes.
//
// NESTED WORKERS — VERIFIED, NOT ASSUMED
//
// Measured directly (headless Chromium via the Playwright provider, the same
// browser this project's `*.browser.test.ts` suite and CI both use): a
// `type: 'module'` Worker (what `runner.worker.ts` is, and what tesseract.js
// itself runs inside once loaded there) CAN create its own nested `Worker`,
// and messages flow both ways normally. So this op uses tesseract.js's
// public, ordinary `createWorker()` — no in-process fallback was needed.
//
// THE ONE THING THAT MUST BE SET: `workerBlobURL: false`
//
// tesseract.js defaults to wrapping its worker script in a
// `Blob([\`importScripts("${workerPath}")\`])` and creating the worker from
// that blob: URL, rather than from `workerPath` directly. That default
// silently breaks asset loading here. Verified directly: inside a worker
// created from such a blob: URL, `self.location.href` IS the opaque blob:
// URL (not `workerPath`), and `new URL(".", thatBlobUrl)` — which is exactly
// how tesseract-core's emscripten glue locates its own sibling `.wasm`
// binary — throws `TypeError: Failed to construct 'URL': Invalid URL`. With
// `workerBlobURL: false`, tesseract spawns the worker directly from
// `workerPath`, so `self.location` stays a normal, resolvable URL for the
// lifetime of that worker — including through every later `importScripts()`
// call (a worker's `self.location` never changes after creation, no matter
// how many scripts it subsequently imports), which is what lets the core
// glue find the `.wasm` file we vendor right next to `worker.min.js`.
//
// SAME-ORIGIN, SUB-PATH-SAFE ASSET URLS
//
// `workerPath` / `corePath` / `langPath` must be same-origin (§1: zero
// third-party network calls, ever) — verified with a real network capture
// spanning the nested worker's own realm; see
// tests/unit/ocr.browser.test.ts's network-trap test and
// tests/helpers/network-capture.commands.ts for why a plain
// `globalThis.fetch` patch (as tests/unit/pdf-render.browser.test.ts uses)
// can't prove this on its own — a nested Worker has a wholly separate global
// object, so it has its own, unpatched `fetch`.
//
// They must ALSO survive a sub-path deployment (this project's GitHub Pages
// target — see vite.config.ts's `base: './'`), which rules out
// `self.location.origin + '/ocr/...'`: that ignores the sub-path entirely.
// `ocrAssetUrl()` below instead resolves relative to `self.location` itself
// (this worker's own URL), which is where every op in this file actually
// runs regardless of how deep its own dynamically-imported chunk is nested —
// the one remaining wrinkle is that Vite's dev server serves this worker
// from its real source path while a production build flattens every chunk
// into one `assets/` directory, so the two modes sit a different number of
// directories below the site root. `import.meta.env.DEV` picks the right one
// (measured against this project's actual `vite build` output).
//
// SIMD, PROBED OURSELVES
//
// tesseract.js can auto-pick a core build from a directory, but that
// auto-detection also considers a THIRD build ("relaxed SIMD") that this
// project deliberately does not vendor (scripts/vendor-ocr.mjs vendors
// exactly two: SIMD and plain). Passing `corePath` as a specific `.js` file
// (rather than a directory) skips that auto-detection entirely, so this op
// does its own minimal SIMD probe — the same technique the `wasm-feature-
// detect` package uses (a tiny WebAssembly module that only validates when
// the SIMD proposal is implemented) — and picks between exactly the two
// files vendored.
//
// HONESTY
//
// tesseract reports a 0-100 confidence per page it recognises. A batch of
// garbled OCR handed back as if it were clean text is exactly the failure
// this project's tools must never commit (§1: "Honest reporting"). Below a
// threshold, the output is prefixed with a plain warning naming the likely
// cause, instead of silently shipping nonsense as if it were reliable.

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';
import { parsePageRanges } from '../pdf/page-range';
import { OCR_LANGUAGE_CODES } from './ocr-languages';

type PdfjsModule = typeof import('pdfjs-dist');
type TesseractModule = typeof import('tesseract.js');
type TesseractWorker = Awaited<ReturnType<TesseractModule['createWorker']>>;

// ---------------------------------------------------------------------------
// pdfjs setup — copied, not imported, from src/tools/pdf/to-images.op.ts.
// Each *.op.ts is its own lazily-loaded chunk; importing one op from another
// would fuse their bundles (see extract-text.op.ts's header for the same
// note). See to-images.op.ts for the full reasoning behind every option set
// below — worker-less via `globalThis.pdfjsWorker`, no cMap/font URLs so
// pdfjs never fetches anything, worker-safe Canvas/Filter factories.
// ---------------------------------------------------------------------------

/** Worker-safe replacement for pdfjs's DOMCanvasFactory. */
class OffscreenCanvasFactory {
  create(width: number, height: number): { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D } {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('2d context unavailable');
    return { canvas, context };
  }
  reset(entry: { canvas: OffscreenCanvas | null }, width: number, height: number): void {
    if (!entry.canvas) throw new Error('Canvas is not specified');
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    entry.canvas.width = width;
    entry.canvas.height = height;
  }
  destroy(entry: { canvas: OffscreenCanvas | null; context: OffscreenCanvasRenderingContext2D | null }): void {
    if (entry.canvas) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
    entry.canvas = null;
    entry.context = null;
  }
}

/** pdfjs's filter factory builds SVG <filter> elements; a worker has none. */
class NoFilterFactory {
  addFilter(): string {
    return 'none';
  }
  addHCMFilter(): string {
    return 'none';
  }
  addAlphaFilter(): string {
    return 'none';
  }
  addLuminosityFilter(): string {
    return 'none';
  }
  addHighlightHCMFilter(): string {
    return 'none';
  }
  destroy(): void {
    /* nothing to release */
  }
}

let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= (async (): Promise<PdfjsModule> => {
    const workerModule = await import('pdfjs-dist/build/pdf.worker.mjs');
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = workerModule;
    return import('pdfjs-dist');
  })();
  return pdfjsPromise;
}

const PDF_HEADER = '%PDF-';

function baseName(name: string): string {
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const stem = cut >= 0 ? name.slice(cut + 1) : name;
  const dot = stem.lastIndexOf('.');
  return dot > 0 ? stem.slice(0, dot) : stem;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function assertLooksLikePdf(input: OpInput): void {
  const head = new TextDecoder('latin1').decode(new Uint8Array(input.buffer, 0, Math.min(5, input.buffer.byteLength)));
  if (head !== PDF_HEADER) {
    throw new OpError('UnsupportedFormat', `${input.name} is not a PDF (missing the "%PDF-" header)`, input.name);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

// ---------------------------------------------------------------------------
// tesseract.js — same-origin asset resolution and worker startup.
// ---------------------------------------------------------------------------

/** A tiny WebAssembly module that only validates when the SIMD proposal is
 *  implemented — the same probe technique `wasm-feature-detect` uses. Kept
 *  as a few inline bytes rather than a dependency: it is a handful of bytes,
 *  and this project prefers a small vendored implementation to a new
 *  package for something this narrow (see hash.op.ts's MD5 for precedent). */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

function supportsWasmSimd(): boolean {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

/**
 * Absolute, same-origin URL to a file under the vendored `/ocr/` directory
 * (see scripts/vendor-ocr.mjs). Resolved relative to `self.location` — this
 * worker's OWN URL — rather than `self.location.origin`, so a sub-path
 * deployment (vite.config.ts's `base: './'`, for GitHub Pages project sites)
 * still resolves correctly: `origin` alone discards the sub-path entirely.
 *
 * Every op in this worker shares the SAME `self.location` (there is one
 * global per worker; dynamically importing an op module does not create a
 * new one), so this is anchored to runner.worker.ts's own URL, not to
 * however deeply this specific op's chunk happens to be nested. That URL
 * sits a DIFFERENT number of directories below the site root depending on
 * dev vs. build (measured against this project's actual output):
 *   - `vite dev`:     ".../src/core/workers/runner.worker.ts?worker_file..."
 *     → three directories up to the site root.
 *   - `vite build`:   ".../assets/runner.worker-<hash>.js"
 *     → one directory up (Vite's default `build.assetsDir`, unchanged here).
 */
function ocrAssetUrl(file: string): string {
  const up = import.meta.env.DEV ? '../../../' : '../';
  return new URL(`${up}ocr/${file}`, self.location.href).href;
}

let tesseractPromise: Promise<TesseractModule> | null = null;

async function loadTesseract(): Promise<TesseractModule> {
  tesseractPromise ??= import('tesseract.js');
  return tesseractPromise;
}

async function createOcrWorker(languages: string): Promise<TesseractWorker> {
  const tesseract = await loadTesseract();
  const core = supportsWasmSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
  try {
    return await tesseract.createWorker(languages, tesseract.OEM.LSTM_ONLY, {
      workerPath: ocrAssetUrl('worker.min.js'),
      corePath: ocrAssetUrl(core),
      langPath: ocrAssetUrl('lang-data'),
      workerBlobURL: false,
      // This op drives its own ctx.onProgress at page granularity; tesseract's
      // logger would otherwise print to the console by default.
      logger: () => {
        /* progress is reported by the caller, per page */
      },
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new OpError(
      'EncoderUnavailable',
      `Could not start the OCR engine (${why}). The first use of a language needs a one-time ` +
        `same-origin download — check the connection and try again.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Confidence-based honesty check (§1: no tool may claim an outcome it did
// not achieve — garbled OCR handed back as clean text is exactly that).
// ---------------------------------------------------------------------------

const LOW_CONFIDENCE_THRESHOLD = 60;

function confidenceWarning(meanConfidence: number): string {
  if (!Number.isFinite(meanConfidence) || meanConfidence >= LOW_CONFIDENCE_THRESHOLD) return '';
  return (
    `WARNING: low OCR confidence (mean ${meanConfidence.toFixed(0)}%). The text below is ` +
    `likely unreliable. This usually means the source is low-resolution, skewed, or has an ` +
    `unusual font or pattern. Review it carefully — or rescan at a higher resolution — before ` +
    `trusting it.\n\n`
  );
}

function mean(values: number[]): number {
  return values.length === 0 ? Number.NaN : values.reduce((sum, v) => sum + v, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Per-input OCR
// ---------------------------------------------------------------------------

function isImageType(type: string): boolean {
  return type.startsWith('image/');
}

async function ocrPdf(
  input: OpInput,
  worker: TesseractWorker,
  dpi: number,
  pagesSpec: string,
  signal: AbortSignal,
  report: (fraction: number) => void,
): Promise<OpOutput> {
  assertLooksLikePdf(input);
  const pdfjs = await loadPdfjs();
  const scale = dpi / 72;

  // pdfjs takes ownership of (and detaches) the array it is handed.
  const data = new Uint8Array(input.buffer.byteLength);
  data.set(new Uint8Array(input.buffer));

  let doc: Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;
  try {
    doc = await pdfjs.getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      CanvasFactory: OffscreenCanvasFactory,
      FilterFactory: NoFilterFactory,
    }).promise;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const encrypted = err instanceof Error && err.name === 'PasswordException';
    throw new OpError(
      'CorruptFile',
      encrypted
        ? `${input.name} is password-protected — decrypt it first`
        : `${input.name} could not be parsed as a PDF (${why})`,
      input.name,
    );
  }

  try {
    const pageCount = doc.numPages;
    const wanted =
      pagesSpec.trim() === ''
        ? Array.from({ length: pageCount }, (_unused, i) => i + 1)
        : [
            ...new Set(
              parsePageRanges(pagesSpec, pageCount).flatMap((group) =>
                group.pages.map((zeroBased) => zeroBased + 1),
              ),
            ),
          ].sort((a, b) => a - b);

    const parts: string[] = [];
    const confidences: number[] = [];

    for (let i = 0; i < wanted.length; i++) {
      const p = wanted[i];
      if (p === undefined) continue;
      throwIfAborted(signal);

      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      const canvas = new OffscreenCanvas(width, height);
      const canvasCtx = canvas.getContext('2d');
      if (!canvasCtx) {
        throw new OpError('EncoderUnavailable', 'Could not obtain a 2d context for rasterising', input.name);
      }

      // White ground: PDF pages are opaque paper, and a scan of a page with
      // a transparent or black background OCRs as noise.
      canvasCtx.fillStyle = '#ffffff';
      canvasCtx.fillRect(0, 0, width, height);
      await page.render({
        canvasContext: canvasCtx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      page.cleanup();

      const blob = await canvas.convertToBlob({ type: 'image/png' });
      const result = await worker.recognize(blob);
      parts.push(`--- Page ${p} of ${pageCount} ---\n${result.data.text.trim()}\n`);
      confidences.push(result.data.confidence);

      // Progress tracks pages RENDERED-AND-RECOGNISED, not page numbers, so
      // selecting only the last page of many does not sit near 0% and then
      // jump straight to done.
      report((i + 1) / wanted.length);
    }

    const header = confidenceWarning(mean(confidences));
    return {
      name: `${baseName(input.name)}.txt`,
      type: 'text/plain',
      buffer: toArrayBuffer(new TextEncoder().encode(header + parts.join('\n'))),
    };
  } finally {
    await doc.destroy();
  }
}

async function ocrImage(
  input: OpInput,
  worker: TesseractWorker,
): Promise<OpOutput> {
  const blob = new Blob([input.buffer], { type: input.type });

  // Validate decodability before handing the blob to tesseract, so a file
  // that merely CLAIMS to be an image (via its sniffed type) fails with a
  // specific, honest CorruptFile rather than a raw engine error.
  try {
    const bitmap = await createImageBitmap(blob);
    bitmap.close();
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new OpError('CorruptFile', `${input.name} could not be decoded as an image (${why})`, input.name);
  }

  const result = await worker.recognize(blob);
  const header = confidenceWarning(result.data.confidence);
  return {
    name: `${baseName(input.name)}.txt`,
    type: 'text/plain',
    buffer: toArrayBuffer(new TextEncoder().encode(`${header}--- Page 1 of 1 ---\n${result.data.text.trim()}\n`)),
  };
}

// ---------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------

const ocr: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) throw new OpError('InvalidOptions', 'ocr needs at least one PDF or image');

  const languagesRaw = options['languages'] === undefined ? 'eng' : options['languages'];
  if (typeof languagesRaw !== 'string' || languagesRaw.trim() === '') {
    throw new OpError('InvalidOptions', `languages must be a non-empty string like "eng" or "eng+fra", got ${JSON.stringify(languagesRaw)}`);
  }
  const languageCodes = languagesRaw.split('+').map((code) => code.trim());
  for (const code of languageCodes) {
    if (!OCR_LANGUAGE_CODES.has(code)) {
      throw new OpError(
        'InvalidOptions',
        `"${code}" is not a supported OCR language. Supported: ${[...OCR_LANGUAGE_CODES].sort().join(', ')}`,
      );
    }
  }
  const languages = languageCodes.join('+');

  const dpi = options['dpi'] === undefined ? 300 : options['dpi'];
  if (typeof dpi !== 'number' || !Number.isFinite(dpi) || dpi < 72 || dpi > 600) {
    throw new OpError('InvalidOptions', `dpi must be a number from 72 to 600, got ${JSON.stringify(dpi)}`);
  }

  // Empty means every page of every PDF — the common case, and it must not
  // require typing. Ignored for plain image inputs, which have no pages.
  const pagesSpec = options['pages'] === undefined ? '' : options['pages'];
  if (typeof pagesSpec !== 'string') {
    throw new OpError('InvalidOptions', `pages must be a string like "1-3,7", got ${JSON.stringify(pagesSpec)}`);
  }

  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    throw new OpError('EncoderUnavailable', 'OCR needs OffscreenCanvas and createImageBitmap, which this environment does not provide');
  }

  const worker = await createOcrWorker(languages);
  try {
    const outputs: OpOutput[] = [];
    const fileCount = inputs.length;

    for (let f = 0; f < fileCount; f++) {
      const input = inputs[f];
      if (input === undefined) continue;
      throwIfAborted(ctx.signal);
      ctx.onProgress(f / fileCount);

      const report = (fraction: number): void => ctx.onProgress((f + fraction) / fileCount);

      if (input.type === 'application/pdf') {
        outputs.push(await ocrPdf(input, worker, dpi, pagesSpec, ctx.signal, report));
      } else if (isImageType(input.type)) {
        outputs.push(await ocrImage(input, worker));
        report(1);
      } else {
        throw new OpError(
          'UnsupportedFormat',
          `${input.name} is not a PDF or image — ocr only reads application/pdf or image/*`,
          input.name,
        );
      }
    }

    ctx.onProgress(1);
    return outputs;
  } finally {
    await worker.terminate();
  }
};

export default ocr;
