// src/tools/pdf/split.op.ts — split one PDF into several.
//
// Two modes:
//   'pages'  — one output PDF per page.
//   'ranges' — one output PDF per comma-separated group in `ranges`
//              (e.g. "1-3,7,9-" gives three files).
//
// `parsePageRanges` is exported on purpose: it is a pure function with its own
// tests, and the organize editor / UI can reuse it without importing the op.

import { PDFDocument } from 'pdf-lib';
import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

// Moved to ./page-range so tools without pdf-lib can parse ranges too.
// Re-exported here because this has been the public home of both names.
export { parsePageRanges, type PageRangeGroup } from './page-range';
import { parsePageRanges, type PageRangeGroup } from './page-range';


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

/** Cheap magic-byte gate so a non-PDF gets `UnsupportedFormat`, not `CorruptFile`. */
function assertLooksLikePdf(input: OpInput): void {
  const head = new TextDecoder('latin1').decode(new Uint8Array(input.buffer, 0, Math.min(5, input.buffer.byteLength)));
  if (head !== PDF_HEADER) {
    throw new OpError('UnsupportedFormat', `${input.name} is not a PDF (missing the "%PDF-" header)`, input.name);
  }
}

/**
 * Load a PDF with pdf-lib, mapping every failure — malformed structure,
 * encryption, anything pdf-lib throws, including plain TypeErrors from a
 * truncated file — onto `CorruptFile` naming the file. Encrypted documents
 * are deliberately NOT opened with `ignoreEncryption`: that "succeeds" while
 * leaving every stream RC4-scrambled, which would be a dishonest result.
 */
async function loadPdf(input: OpInput): Promise<PDFDocument> {
  assertLooksLikePdf(input);
  try {
    const doc = await PDFDocument.load(input.buffer, { updateMetadata: false });
    // pdf-lib parses the low-level object graph eagerly but resolves the page
    // tree lazily, on first getPageCount()/getPages()/save(). A document with
    // a broken catalog "Pages" entry (corrupt.pdf) parses without error and
    // only throws a plain TypeError on that first resolution. Force it now,
    // inside this guarded block, instead of letting it escape unguarded from
    // a later call.
    doc.getPageCount();
    return doc;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    const encrypted = /encrypt/i.test(why);
    throw new OpError(
      'CorruptFile',
      encrypted
        ? `${input.name} is password-protected — decrypt it first`
        : `${input.name} could not be parsed as a PDF (${why})`,
      input.name,
    );
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

const split: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) throw new OpError('InvalidOptions', 'pdf-split needs at least one PDF');

  const mode = options['mode'] === undefined ? 'pages' : options['mode'];
  if (mode !== 'pages' && mode !== 'ranges') {
    throw new OpError('InvalidOptions', `mode must be "pages" or "ranges", got ${JSON.stringify(mode)}`);
  }
  const rangesRaw = options['ranges'] ?? '';
  if (typeof rangesRaw !== 'string') {
    throw new OpError('InvalidOptions', `ranges must be a string, got ${typeof rangesRaw}`);
  }

  const outputs: OpOutput[] = [];
  const fileCount = inputs.length;

  for (let f = 0; f < fileCount; f++) {
    const input = inputs[f];
    if (input === undefined) continue;
    throwIfAborted(ctx.signal);
    ctx.onProgress(f / fileCount);

    const source = await loadPdf(input);
    const pageCount = source.getPageCount();
    if (pageCount === 0) {
      throw new OpError('CorruptFile', `${input.name} has no pages`, input.name);
    }

    const groups: PageRangeGroup[] =
      mode === 'ranges'
        ? parsePageRanges(rangesRaw, pageCount)
        : Array.from({ length: pageCount }, (_unused, i) => ({ label: `${i + 1}`, pages: [i] }));

    const stem = baseName(input.name);
    for (let g = 0; g < groups.length; g++) {
      throwIfAborted(ctx.signal);
      const group = groups[g];
      if (group === undefined) continue;

      const out = await PDFDocument.create();
      const copied = await out.copyPages(source, group.pages);
      for (const page of copied) out.addPage(page);
      const bytes = await out.save({ useObjectStreams: true });

      outputs.push({
        name: `${stem}-p${group.label}.pdf`,
        type: 'application/pdf',
        buffer: toArrayBuffer(bytes),
      });
      ctx.onProgress((f + (g + 1) / groups.length) / fileCount);
    }
  }

  ctx.onProgress(1);
  return outputs;
};

export default split;
