// src/tools/pdf/extract-text.op.ts — pull the text layer out of a PDF.
//
// Uses the same worker-less, network-free pdfjs configuration as
// to-images.op.ts; see that file's header for the full reasoning. The setup is
// repeated rather than shared because src/tools/** files are independent lazy
// chunks — importing one op from another would fuse their bundles.
//
// This op reads the PDF's *text layer*. A scanned page has no text layer, so it
// yields nothing for that page and says so rather than pretending.

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

type PdfjsModule = typeof import('pdfjs-dist');

/** No canvas is created for text extraction, but pdfjs constructs its factories
 *  eagerly and the DOM defaults would reach for `document`. */
class NoCanvasFactory {
  create(): never {
    throw new Error('pdf-extract-text does not rasterise pages');
  }
  reset(): void {
    /* never used */
  }
  destroy(): void {
    /* never used */
  }
}

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

/** Join pdfjs text items into lines, honouring its end-of-line markers. */
export function joinTextItems(items: { str: string; hasEOL?: boolean }[]): string {
  let out = '';
  for (const item of items) {
    out += item.str;
    if (item.hasEOL === true) out += '\n';
  }
  return out.replace(/[ \t]+\n/g, '\n').trimEnd();
}

const extractText: Op = async (inputs, _options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) throw new OpError('InvalidOptions', 'pdf-extract-text needs at least one PDF');

  const pdfjs = await loadPdfjs();
  const outputs: OpOutput[] = [];
  const fileCount = inputs.length;

  for (let f = 0; f < fileCount; f++) {
    const input = inputs[f];
    if (input === undefined) continue;
    throwIfAborted(ctx.signal);
    ctx.onProgress(f / fileCount);
    assertLooksLikePdf(input);

    // pdfjs detaches the array it is given, so hand it a copy.
    const data = new Uint8Array(input.buffer.byteLength);
    data.set(new Uint8Array(input.buffer));

    let doc: Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;
    try {
      doc = await pdfjs.getDocument({
        data,
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        CanvasFactory: NoCanvasFactory,
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
      const parts: string[] = [];
      for (let p = 1; p <= pageCount; p++) {
        throwIfAborted(ctx.signal);
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        // content.items mixes TextItem with TextMarkedContent; only the former has `str`.
        const items = content.items.flatMap((item) => ('str' in item ? [{ str: item.str, hasEOL: item.hasEOL }] : []));
        const text = joinTextItems(items);
        parts.push(`--- Page ${p} of ${pageCount} ---\n${text === '' ? '(no text layer on this page)' : text}\n`);
        page.cleanup();
        ctx.onProgress((f + p / pageCount) / fileCount);
      }
      outputs.push({
        name: `${baseName(input.name)}.txt`,
        type: 'text/plain',
        buffer: toArrayBuffer(new TextEncoder().encode(parts.join('\n'))),
      });
    } finally {
      await doc.destroy();
    }
  }

  ctx.onProgress(1);
  return outputs;
};

export default extractText;
