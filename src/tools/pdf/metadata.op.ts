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
// UNLINKING IS NOT REMOVING, and this is the part that is easy to get wrong.
// Dropping a key leaves whatever it pointed at in the file as an orphan object,
// and pdf-lib writes orphans back out: the payload is still sitting in the
// bytes for anyone who opens the file in a hex editor, while every getter says
// it is gone. It bites in three places, because PDF lets ANY value be indirect:
//
//   * a /Metadata XMP stream, which is always indirect;
//   * an Info value — /Author may be an indirect string, not a literal one;
//   * a /PieceInfo, which is a whole nested tree of application dictionaries
//     with the private payload two levels down.
//
// So removal here is unlink-then-SWEEP: every object the removed values pointed
// at is remembered, the graph is walked from the catalog and the Info
// dictionary afterwards, and anything remembered that nothing still reaches is
// deleted outright. Sweeping only what this op unlinked (rather than every
// unreachable object in the file) keeps the blast radius to this tool's own
// edits, and checking reachability first means an object that some other part
// of the document shares is left alone. The tests grep the output bytes for
// each payload rather than trusting a getter to be the whole story.
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

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFStream, type PDFObject } from 'pdf-lib';

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
 * Every indirect object reachable from `value`, added to `into`. Iterative
 * rather than recursive: a page tree or a deeply nested /PieceInfo is a graph
 * of unknown depth, and a stack overflow inside a cleanup pass would be a
 * spectacularly bad way to fail.
 */
function collectRefs(doc: PDFDocument, value: PDFObject | undefined, into: Map<string, PDFRef>): void {
  const stack: (PDFObject | undefined)[] = [value];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;

    if (current instanceof PDFRef) {
      const id = current.toString();
      if (visited.has(id)) continue;
      visited.add(id);
      into.set(id, current);
      stack.push(doc.context.lookup(current));
      continue;
    }
    if (current instanceof PDFStream) {
      stack.push(current.dict);
      continue;
    }
    if (current instanceof PDFDict) {
      for (const entry of current.values()) stack.push(entry);
      continue;
    }
    if (current instanceof PDFArray) {
      for (let i = 0; i < current.size(); i++) stack.push(current.get(i));
    }
    // Everything else — names, numbers, strings, booleans — has no children.
  }
}

/**
 * Delete the unlinked objects that nothing else in the document still points
 * at. `candidates` is only ever what this op unlinked, so an object shared with
 * live content (however unlikely) survives, and nothing else in the file is
 * touched.
 */
function sweep(doc: PDFDocument, candidates: Map<string, PDFRef>): number {
  if (candidates.size === 0) return 0;

  const live = new Map<string, PDFRef>();
  collectRefs(doc, doc.catalog, live);
  const infoRef = doc.context.trailerInfo.Info;
  if (infoRef !== undefined) collectRefs(doc, infoRef as PDFObject, live);

  let deleted = 0;
  for (const [id, ref] of candidates) {
    if (live.has(id)) continue;
    doc.context.delete(ref);
    deleted += 1;
  }
  return deleted;
}

/**
 * Unlink `key` from `container`, remembering everything it pointed at so the
 * sweep can delete it. Returns the removed value's size in bytes, or undefined
 * if there was no such key.
 */
function unlink(
  doc: PDFDocument,
  container: PDFDict,
  key: string,
  candidates: Map<string, PDFRef>,
): number | undefined {
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

  collectRefs(doc, value, candidates);
  container.delete(name);
  return bytes ?? 0;
}

/** Strip one loaded document in place. Returns what was taken out of it. */
function cleanDocument(doc: PDFDocument, keepTitle: boolean, removeXmp: boolean): Removal[] {
  const removed: Removal[] = [];
  // What this pass unlinks, so the sweep at the end can delete the objects the
  // removed values pointed at rather than leaving them orphaned in the file.
  const candidates = new Map<string, PDFRef>();

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
      // An Info value can itself be an indirect object — unlinking the key is
      // not enough to get the string out of the file.
      unlink(doc, info, field.key, candidates);
    }
    // Everything else in the dictionary, whatever a producer decided to call it.
    for (const key of info.keys()) {
      const bare = key.asString().slice(1);
      if (described.has(bare)) continue;
      removed.push({ label: `custom field ${bare}` });
      unlink(doc, info, bare, candidates);
    }
  }

  if (removeXmp) {
    const catalogXmp = unlink(doc, doc.catalog, 'Metadata', candidates);
    if (catalogXmp !== undefined) removed.push({ label: 'XMP metadata stream', bytes: catalogXmp });
    const catalogPiece = unlink(doc, doc.catalog, 'PieceInfo', candidates);
    if (catalogPiece !== undefined) {
      removed.push({ label: 'application data (PieceInfo)', bytes: catalogPiece });
    }

    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const node = pages[i]?.node;
      if (node === undefined) continue;
      const pageXmp = unlink(doc, node, 'Metadata', candidates);
      if (pageXmp !== undefined) {
        removed.push({ label: `XMP metadata on page ${i + 1}`, bytes: pageXmp });
      }
      const piece = unlink(doc, node, 'PieceInfo', candidates);
      if (piece !== undefined) {
        removed.push({ label: `application data on page ${i + 1}`, bytes: piece });
      }
    }
  }

  // Nothing is actually gone until the objects behind it are, and that has to
  // happen after every unlink so a value shared by two of them is judged once.
  sweep(doc, candidates);

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
