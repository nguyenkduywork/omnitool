// src/tools/pdf/organize.op.ts — reorder, rotate and delete pages.
//
// Driven entirely by the plan emitted by src/tools/pdf/organize.editor.ts:
//   { pages: { index: number; rotate: 0 | 90 | 180 | 270; keep: boolean }[] }
// The array order IS the output page order; `keep: false` drops a page.
//
// There is no OptionSchema for this tool, so a missing plan is a programming
// error rather than a default — it raises InvalidOptions instead of silently
// returning the document untouched, which would look like success.

import { PDFDocument, degrees } from 'pdf-lib';
import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

export type PagePlan = { index: number; rotate: 0 | 90 | 180 | 270; keep: boolean };

const ROTATIONS = [0, 90, 180, 270];

/** Validate the editor's payload against the real page count. */
export function parsePagePlan(value: unknown, pageCount: number): PagePlan[] {
  if (!Array.isArray(value)) {
    throw new OpError('InvalidOptions', 'pdf-organize needs a `pages` plan from its editor');
  }
  if (value.length === 0) {
    throw new OpError('InvalidOptions', 'The page plan is empty — nothing to organize');
  }

  const plan: PagePlan[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      throw new OpError('InvalidOptions', `Each page plan entry must be an object, got ${JSON.stringify(entry)}`);
    }
    const record = entry as Record<string, unknown>;
    const index = record['index'];
    const rotate = record['rotate'];
    const keep = record['keep'];

    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= pageCount) {
      throw new OpError('InvalidOptions', `Page index ${JSON.stringify(index)} is not a page of this document (0..${pageCount - 1})`);
    }
    if (seen.has(index)) {
      throw new OpError('InvalidOptions', `Page index ${index} appears twice in the plan`);
    }
    seen.add(index);
    if (typeof rotate !== 'number' || !ROTATIONS.includes(rotate)) {
      throw new OpError('InvalidOptions', `rotate must be 0, 90, 180 or 270, got ${JSON.stringify(rotate)}`);
    }
    if (typeof keep !== 'boolean') {
      throw new OpError('InvalidOptions', `keep must be a boolean, got ${JSON.stringify(keep)}`);
    }
    plan.push({ index, rotate: rotate as 0 | 90 | 180 | 270, keep });
  }

  if (!plan.some((p) => p.keep)) {
    throw new OpError('InvalidOptions', 'Every page is marked for deletion — a PDF must keep at least one page');
  }
  return plan;
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

/** See split.op.ts for why encryption is reported rather than bypassed. */
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

const organize: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  const input = inputs[0];
  if (inputs.length !== 1 || input === undefined) {
    throw new OpError('InvalidOptions', `pdf-organize works on exactly one PDF, got ${inputs.length}`);
  }

  throwIfAborted(ctx.signal);
  ctx.onProgress(0);

  const source = await loadPdf(input);
  const pageCount = source.getPageCount();
  if (pageCount === 0) throw new OpError('CorruptFile', `${input.name} has no pages`, input.name);

  const plan = parsePagePlan(options['pages'], pageCount).filter((p) => p.keep);

  const out = await PDFDocument.create();
  const copied = await out.copyPages(
    source,
    plan.map((p) => p.index),
  );

  for (let i = 0; i < plan.length; i++) {
    throwIfAborted(ctx.signal);
    const entry = plan[i];
    const page = copied[i];
    if (entry === undefined || page === undefined) continue;
    if (entry.rotate !== 0) {
      // Rotation composes with whatever the source page already carried.
      const existing = page.getRotation().angle;
      page.setRotation(degrees((existing + entry.rotate) % 360));
    }
    out.addPage(page);
    ctx.onProgress((i + 1) / (plan.length + 1));
  }

  const bytes = await out.save({ useObjectStreams: true });
  ctx.onProgress(1);

  return [
    {
      name: `${baseName(input.name)}-organized.pdf`,
      type: 'application/pdf',
      buffer: toArrayBuffer(bytes),
    },
  ];
};

export default organize;
