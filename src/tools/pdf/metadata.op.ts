// src/tools/pdf/metadata.op.ts — pdf-metadata: remove a PDF's document
// metadata.
//
// The PDF counterpart to image-strip-metadata, and it makes the same promise:
// the page content is never re-encoded. This edits the document's object graph
// — the Info dictionary and the XMP metadata streams — and rewrites the file
// around content streams it does not touch.
//
// WHAT GOES, PRECISELY:
//
//   The Info dictionary — EVERY key, not a known-name list: /Title, /Author,
//     /Subject, /Keywords, /Creator, /Producer, /CreationDate, /ModDate, and
//     any custom key a producer invented (/Company, /SourceModified, ...).
//     Cleaning only the names one has heard of is how a leak survives.
//   The XMP metadata stream (/Metadata) on the catalog AND on every page, plus
//     /PieceInfo — the private application data editors leave behind.
//
// UNLINKING IS NOT REMOVING. Dropping /Metadata from the catalog leaves the
// stream in the file as an orphan object, and pdf-lib writes orphans back out:
// the XMP payload is still sitting in the bytes for anyone who opens the file
// in a hex editor. Verified, and the reason every removal here also calls
// `context.delete(ref)` to purge the object itself. A test greps the output
// bytes for the payload rather than trusting the catalog to be the whole story.
//
// WHAT THIS IS NOT: redaction. Metadata is data *about* the document; this
// removes that and nothing else. Text on the page, images (including any EXIF
// inside an embedded image), annotations, form-field values, attachments and
// bookmarks are content, and they all survive untouched. A file whose first
// page says your name still says your name afterwards.
//
// Every run writes a `pdf-metadata-report.txt` saying what came out of which
// file, and a file that carried no metadata at all is handed back as its
// original bytes rather than re-saved for nothing.

import { PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

const PDF_HEADER = '%PDF-';

/** One thing taken out of one file, for the report. */
type Removal = { label: string; bytes?: number };

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Cheap magic-byte gate so a non-PDF gets `UnsupportedFormat`, not `CorruptFile`. */
function assertLooksLikePdf(input: OpInput): void {
  const head = new TextDecoder('latin1').decode(
    new Uint8Array(input.buffer, 0, Math.min(5, input.buffer.byteLength)),
  );
  if (head !== PDF_HEADER) {
    throw new OpError(
      'UnsupportedFormat',
      `${input.name} is not a PDF (missing the "%PDF-" header)`,
      input.name,
    );
  }
}

/**
 * Load a PDF, mapping every failure onto `CorruptFile` naming the file.
 *
 * `updateMetadata: false` is load-bearing here, not tidiness: pdf-lib's
 * default is to stamp its own /Producer and a fresh /ModDate onto the
 * document, which in this op would mean writing new metadata into the very
 * file we were asked to clean.
 */
async function loadPdf(input: OpInput): Promise<PDFDocument> {
  assertLooksLikePdf(input);
  try {
    const doc = await PDFDocument.load(input.buffer, { updateMetadata: false });
    // Resolve the page tree inside this guarded block: pdf-lib resolves it
    // lazily, so a broken catalog only throws on first access (see split.op.ts).
    doc.getPageCount();
    return doc;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    throw new OpError(
      'CorruptFile',
      /encrypt/i.test(why)
        ? `${input.name} is password-protected — decrypt it first`
        : `${input.name} could not be parsed as a PDF (${why})`,
      input.name,
    );
  }
}

function validateBool(raw: unknown, def: boolean, label: string): boolean {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'boolean') {
    throw new OpError('InvalidOptions', `${label} must be a boolean, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** A getter that refuses to be the reason a whole job fails. */
function readField(read: () => string | Date | undefined): string | undefined {
  let value: string | Date | undefined;
  try {
    value = read();
  } catch {
    // A malformed value (wrong PDF object type for the key) is still deleted
    // below — it just cannot be quoted in the report.
    return undefined;
  }
  if (value === undefined) return undefined;
  const text = value instanceof Date ? value.toISOString() : value;
  return text.trim() === '' ? undefined : text;
}

/** Report values are the user's own data, but a runaway one must not fill the file. */
function ellipsis(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Delete `key` from `container` AND purge the object it pointed at, so the
 * payload leaves the file instead of surviving as an orphan (see the header).
 * Returns the removed object's size in bytes, or undefined if there was none.
 */
function purge(doc: PDFDocument, container: PDFDict, key: string): number | undefined {
  const name = PDFName.of(key);
  const value = container.get(name);
  if (value === undefined) return undefined;

  let bytes: number | undefined;
  try {
    const target = value instanceof PDFRef ? doc.context.lookup(value) : value;
    bytes = target?.sizeInBytes();
  } catch {
    bytes = undefined;
  }

  container.delete(name);
  if (value instanceof PDFRef) doc.context.delete(value);
  return bytes ?? 0;
}

/** Strip one loaded document in place. Returns what was taken out of it. */
function cleanDocument(doc: PDFDocument, keepTitle: boolean, removeXmp: boolean): Removal[] {
  const removed: Removal[] = [];

  const named: { key: string; label: string; read: () => string | Date | undefined }[] = [
    { key: 'Title', label: 'Title', read: () => doc.getTitle() },
    { key: 'Author', label: 'Author', read: () => doc.getAuthor() },
    { key: 'Subject', label: 'Subject', read: () => doc.getSubject() },
    { key: 'Keywords', label: 'Keywords', read: () => doc.getKeywords() },
    { key: 'Creator', label: 'Creator', read: () => doc.getCreator() },
    { key: 'Producer', label: 'Producer', read: () => doc.getProducer() },
    { key: 'CreationDate', label: 'Created', read: () => doc.getCreationDate() },
    { key: 'ModDate', label: 'Modified', read: () => doc.getModificationDate() },
  ];

  const infoRef = doc.context.trailerInfo.Info;
  let info: PDFDict | undefined;
  try {
    info = infoRef === undefined ? undefined : doc.context.lookup(infoRef, PDFDict);
  } catch {
    info = undefined;
  }

  if (info !== undefined) {
    const described = new Set<string>();
    for (const field of named) {
      if (info.get(PDFName.of(field.key)) === undefined) continue;
      described.add(field.key);
      if (field.key === 'Title' && keepTitle) continue;
      const value = readField(field.read);
      removed.push({
        label: value === undefined ? field.label : `${field.label}: ${ellipsis(value)}`,
      });
      info.delete(PDFName.of(field.key));
    }
    // Everything else in the dictionary, whatever a producer decided to call it.
    for (const key of info.keys()) {
      const bare = key.asString().slice(1);
      if (described.has(bare)) continue;
      removed.push({ label: `custom field ${bare}` });
      info.delete(key);
    }
  }

  if (removeXmp) {
    const catalogXmp = purge(doc, doc.catalog, 'Metadata');
    if (catalogXmp !== undefined) removed.push({ label: 'XMP metadata stream', bytes: catalogXmp });
    const catalogPiece = purge(doc, doc.catalog, 'PieceInfo');
    if (catalogPiece !== undefined) {
      removed.push({ label: 'application data (PieceInfo)', bytes: catalogPiece });
    }

    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const node = pages[i]?.node;
      if (node === undefined) continue;
      const pageXmp = purge(doc, node, 'Metadata');
      if (pageXmp !== undefined) {
        removed.push({ label: `XMP metadata on page ${i + 1}`, bytes: pageXmp });
      }
      const piece = purge(doc, node, 'PieceInfo');
      if (piece !== undefined) {
        removed.push({ label: `application data on page ${i + 1}`, bytes: piece });
      }
    }
  }

  return removed;
}

const metadata: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Clean PDF metadata needs at least one PDF.');
  }
  const keepTitle = validateBool(options.keepTitle, false, 'keepTitle');
  const removeXmp = validateBool(options.removeXmp, true, 'removeXmp');

  const outputs: OpOutput[] = [];
  const lines: string[] = [
    'pdf-metadata report',
    `document title: ${keepTitle ? 'kept' : 'removed'}`,
    `XMP / application data: ${removeXmp ? 'removed' : 'kept'}`,
    '',
  ];

  for (let index = 0; index < inputs.length; index++) {
    stop(ctx.signal);
    const input = inputs[index];
    if (input === undefined) continue;

    const doc = await loadPdf(input);
    stop(ctx.signal);

    const removed = cleanDocument(doc, keepTitle, removeXmp);
    const before = input.buffer.byteLength;

    if (removed.length === 0) {
      // Nothing found: hand back the original bytes rather than re-saving.
      outputs.push({ name: input.name, type: 'application/pdf', buffer: input.buffer });
      lines.push(input.name, '  no document metadata found — returned the original file unchanged', '');
      ctx.onProgress((index + 1) / inputs.length);
      continue;
    }

    stop(ctx.signal);
    const bytes = await doc.save({ useObjectStreams: true });

    outputs.push({ name: input.name, type: 'application/pdf', buffer: toArrayBuffer(bytes) });
    lines.push(input.name);
    for (const item of removed) {
      lines.push(`  removed ${item.label}${item.bytes === undefined ? '' : ` (${item.bytes} bytes)`}`);
    }
    lines.push(`  ${before} bytes -> ${bytes.length} bytes`);
    lines.push('');

    ctx.onProgress((index + 1) / inputs.length);
  }

  outputs.push({
    name: 'pdf-metadata-report.txt',
    type: 'text/plain',
    buffer: toArrayBuffer(new TextEncoder().encode(lines.join('\n'))),
  });

  return outputs;
};

export default metadata;
