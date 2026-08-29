// src/tools/pdf/to-images.op.ts — rasterise PDF pages to PNG/JPEG.
//
// pdfjs-dist configuration (this is the whole trick, and it is deliberate):
//
//   * ZERO network calls, no CDN. pdfjs normally spawns its own nested Worker
//     from `GlobalWorkerOptions.workerSrc`, and when that URL is cross-origin
//     it fabricates a CDN wrapper. Both are forbidden by §1. Instead we set
//     `globalThis.pdfjsWorker` to the *bundled* worker module before pdfjs is
//     used: `PDFWorker` checks `globalThis.pdfjsWorker?.WorkerMessageHandler`
//     first and, finding it, runs the worker code in-process over a
//     LoopbackPort. No `new Worker`, no `workerSrc`, no fetch. This op already
//     runs inside a Web Worker, so nothing blocks the UI thread anyway.
//
//   * `cMapUrl` / `standardFontDataUrl` are left unset, which is what keeps
//     pdfjs from fetching anything: with both null, pdfjs never even evaluates
//     its `useWorkerFetch` heuristic (which would touch `document.baseURI`).
//     Non-embedded standard-14 fonts therefore render from pdfjs's fallback
//     rather than downloaded font programs.
//
//   * `CanvasFactory` / `FilterFactory` are replaced with worker-safe versions.
//     pdfjs's defaults call `document.createElement('canvas')` and build SVG
//     filter elements — neither exists in a worker.
//
//   * `isEvalSupported: false`, `disableFontFace: true`, `useSystemFonts: false`
//     — no `new Function`, no FontFace registration, no DOM. Glyphs are drawn
//     as `Path2D` outlines, which works in a worker.

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

type PdfjsModule = typeof import('pdfjs-dist');

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

/** Import pdfjs once, worker-less, with the bundled worker module installed. */
export async function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= (async (): Promise<PdfjsModule> => {
    // Typed by the ambient shim in src/tools/pdf/pdfjs-dist-subpaths.d.ts —
    // pdfjs-dist ships no .d.ts of its own for this worker entry point.
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

function assertLooksLikePdf(input: OpInput): void {
  const head = new TextDecoder('latin1').decode(new Uint8Array(input.buffer, 0, Math.min(5, input.buffer.byteLength)));
  if (head !== PDF_HEADER) {
    throw new OpError('UnsupportedFormat', `${input.name} is not a PDF (missing the "%PDF-" header)`, input.name);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

const FORMATS = {
  png: { mime: 'image/png', ext: 'png' },
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
} as const;

const toImages: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) throw new OpError('InvalidOptions', 'pdf-to-images needs at least one PDF');

  const format = options['format'] === undefined ? 'png' : options['format'];
  if (format !== 'png' && format !== 'jpeg') {
    throw new OpError('InvalidOptions', `format must be "png" or "jpeg", got ${JSON.stringify(format)}`);
  }
  const dpi = options['dpi'] === undefined ? 150 : options['dpi'];
  if (typeof dpi !== 'number' || !Number.isFinite(dpi) || dpi < 72 || dpi > 300) {
    throw new OpError('InvalidOptions', `dpi must be a number from 72 to 300, got ${JSON.stringify(dpi)}`);
  }

  if (typeof OffscreenCanvas !== 'function') {
    throw new OpError('EncoderUnavailable', 'Rasterising PDFs needs OffscreenCanvas, which this environment does not provide');
  }

  const { mime, ext } = FORMATS[format];
  const scale = dpi / 72;
  const pdfjs = await loadPdfjs();
  const outputs: OpOutput[] = [];
  const fileCount = inputs.length;

  for (let f = 0; f < fileCount; f++) {
    const input = inputs[f];
    if (input === undefined) continue;
    throwIfAborted(ctx.signal);
    ctx.onProgress(f / fileCount);
    assertLooksLikePdf(input);

    // pdfjs takes ownership of (and detaches) the array it is handed, so pass a copy.
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
      const stem = baseName(input.name);
      const pageCount = doc.numPages;
      for (let p = 1; p <= pageCount; p++) {
        throwIfAborted(ctx.signal);
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.ceil(viewport.width));
        const height = Math.max(1, Math.ceil(viewport.height));
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        if (!context) throw new OpError('EncoderUnavailable', 'Could not obtain a 2d context for rasterising');

        // White ground: PDF pages are opaque paper, and a JPEG cannot carry alpha.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        await page.render({
          // pdfjs only calls the shared 2D drawing surface, which OffscreenCanvas
          // implements identically; its lib.dom type just isn't the DOM one.
          canvasContext: context as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;
        page.cleanup();

        const blob = await canvas.convertToBlob({ type: mime, quality: 0.92 });
        // Browsers silently substitute PNG instead of failing; refuse rather than
        // hand back a file whose bytes contradict its name.
        if (blob.type !== mime) {
          throw new OpError('EncoderUnavailable', `This browser cannot encode ${mime} (it produced ${blob.type || 'nothing'})`, input.name);
        }
        outputs.push({
          name: `${stem}-p${p}.${ext}`,
          type: mime,
          buffer: await blob.arrayBuffer(),
        });
        ctx.onProgress((f + p / pageCount) / fileCount);
      }
    } finally {
      await doc.destroy();
    }
  }

  ctx.onProgress(1);
  return outputs;
};

export default toImages;
