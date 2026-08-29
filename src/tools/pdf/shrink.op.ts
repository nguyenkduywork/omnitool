// src/tools/pdf/shrink.op.ts — re-encode images inside a PDF, honestly.
//
// WHAT IT ACTUALLY DOES, precisely:
//
//   1. Re-encodes embedded image XObjects that are BASELINE/PROGRESSIVE JPEG
//      (`/Filter /DCTDecode`, 8 bits per component, `/DeviceRGB`, `/DeviceGray`
//      or no explicit colour space, not an `/ImageMask`) at the requested
//      quality, keeping the pixel dimensions identical so every `/Width`,
//      `/Height`, `/SMask` and `/Mask` reference stays valid. Decoding uses
//      `createImageBitmap`; encoding uses `OffscreenCanvas.convertToBlob`.
//      The re-encoded stream is written back with `/ColorSpace /DeviceRGB`
//      (canvas always hands back 3-channel data) and any `/Decode` /
//      `/DecodeParms` entry removed.
//
//   2. Leaves EVERY OTHER encoding untouched: `/JPXDecode` (JPEG 2000),
//      `/CCITTFaxDecode`, `/JBIG2Decode`, `/FlateDecode` raw bitmaps,
//      `/RunLengthDecode`, `/Indexed` and `/ICCBased` colour spaces, 1/2/4/16
//      bit depths, CMYK JPEGs, and stencil masks. Those need a full image
//      codec and colour pipeline that this op does not have, and guessing
//      would corrupt the document.
//
//   3. Rewrites the file with cross-reference/object streams, which is the
//      only saving available when nothing in (1) applies.
//
//   4. Measures REAL before/after byte counts. If the rewrite is not smaller
//      than the input, it returns the ORIGINAL bytes byte-for-byte, names the
//      output `-unchanged.pdf`, and says so in `shrink-report.txt`. It never
//      hands back a bigger file while implying a saving.
//
// Where `OffscreenCanvas`/`createImageBitmap` are unavailable (e.g. plain
// Node), step 1 is skipped and the report says so — it does not pretend.

import { PDFDocument, PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream } from 'pdf-lib';
import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

const PDF_HEADER = '%PDF-';
const ALLOWED_COLOUR_SPACES = new Set(['/DeviceRGB', '/DeviceGray']);

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
    // only throws a plain TypeError on that first resolution (from inside
    // doc.save(), for this op). Force it now, inside this guarded block,
    // instead of letting it escape unguarded from a later call.
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

/** True when this environment can decode and re-encode JPEG bytes at all. */
export function canReencodeImages(): boolean {
  return (
    typeof OffscreenCanvas === 'function' &&
    typeof createImageBitmap === 'function' &&
    typeof Blob === 'function'
  );
}

function filterNames(dict: PDFDict): string[] {
  const filter = dict.get(PDFName.of('Filter'));
  if (filter instanceof PDFName) return [filter.asString()];
  if (filter instanceof PDFArray) {
    const names: string[] = [];
    for (let i = 0; i < filter.size(); i++) {
      const entry = filter.get(i);
      if (entry instanceof PDFName) names.push(entry.asString());
      else return [];
    }
    return names;
  }
  return [];
}

/**
 * Is this raw stream a JPEG image we can safely round-trip through a canvas?
 * Deliberately strict — see the header comment for what is excluded and why.
 */
export function isReencodableJpeg(stream: PDFRawStream): boolean {
  const dict = stream.dict;
  const subtype = dict.get(PDFName.of('Subtype'));
  if (!(subtype instanceof PDFName) || subtype.asString() !== '/Image') return false;

  const filters = filterNames(dict);
  if (filters.length !== 1 || filters[0] !== '/DCTDecode') return false;

  const imageMask = dict.get(PDFName.of('ImageMask'));
  if (imageMask !== undefined && String(imageMask) === 'true') return false;

  const bpc = dict.get(PDFName.of('BitsPerComponent'));
  if (bpc !== undefined && !(bpc instanceof PDFNumber && bpc.asNumber() === 8)) return false;

  const colourSpace = dict.get(PDFName.of('ColorSpace'));
  if (colourSpace !== undefined && !(colourSpace instanceof PDFName && ALLOWED_COLOUR_SPACES.has(colourSpace.asString()))) {
    return false;
  }

  const width = dict.get(PDFName.of('Width'));
  const height = dict.get(PDFName.of('Height'));
  return width instanceof PDFNumber && height instanceof PDFNumber && width.asNumber() > 0 && height.asNumber() > 0;
}

async function reencodeJpeg(bytes: Uint8Array, quality: number): Promise<Uint8Array | null> {
  // Copied into a freshly-owned ArrayBuffer: `bytes` may be a view into pdf-lib's
  // larger parse buffer, and Blob's typings want a plain (non-shared) buffer.
  const jpeg = new Uint8Array(bytes.byteLength);
  jpeg.set(bytes);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(new Blob([jpeg.buffer], { type: 'image/jpeg' }));
  } catch {
    return null; // Undecodable by this engine — leave the original alone.
  }
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    // Browsers silently fall back to PNG rather than erroring; a PNG here would
    // not be a valid /DCTDecode stream, so refuse it instead of corrupting.
    if (blob.type !== 'image/jpeg') return null;
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

type ShrinkStats = { imagesSeen: number; imagesReencoded: number; imageBytesSaved: number };

async function reencodeImages(doc: PDFDocument, quality: number, signal: AbortSignal): Promise<ShrinkStats> {
  const stats: ShrinkStats = { imagesSeen: 0, imagesReencoded: 0, imageBytesSaved: 0 };
  if (!canReencodeImages()) return stats;

  for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
    throwIfAborted(signal);
    if (!(object instanceof PDFRawStream)) continue;
    if (!isReencodableJpeg(object)) continue;
    stats.imagesSeen++;

    const original = object.contents;
    const replacement = await reencodeJpeg(original, quality);
    if (replacement === null || replacement.length >= original.length) continue;

    const width = object.dict.get(PDFName.of('Width'));
    const height = object.dict.get(PDFName.of('Height'));
    if (!(width instanceof PDFNumber) || !(height instanceof PDFNumber)) continue;

    const dict = object.dict.clone(doc.context);
    dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
    dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    dict.delete(PDFName.of('Decode'));
    dict.delete(PDFName.of('DecodeParms'));
    doc.context.assign(ref, PDFRawStream.of(dict, replacement));

    stats.imagesReencoded++;
    stats.imageBytesSaved += original.length - replacement.length;
  }
  return stats;
}

const shrink: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) throw new OpError('InvalidOptions', 'pdf-shrink needs at least one PDF');

  const rawQuality = options['quality'] ?? 70;
  if (typeof rawQuality !== 'number' || !Number.isFinite(rawQuality) || rawQuality < 10 || rawQuality > 100) {
    throw new OpError('InvalidOptions', `quality must be a number from 10 to 100, got ${JSON.stringify(rawQuality)}`);
  }
  const quality = rawQuality / 100;

  const outputs: OpOutput[] = [];
  const lines: string[] = [
    'pdf-shrink report',
    `quality: ${rawQuality}`,
    canReencodeImages()
      ? 'JPEG (/DCTDecode) image re-encoding: enabled'
      : 'JPEG (/DCTDecode) image re-encoding: UNAVAILABLE in this environment — structural rewrite only',
    '',
  ];

  const fileCount = inputs.length;
  for (let f = 0; f < fileCount; f++) {
    const input = inputs[f];
    if (input === undefined) continue;
    throwIfAborted(ctx.signal);
    ctx.onProgress(f / fileCount);

    const before = input.buffer.byteLength;
    const doc = await loadPdf(input);
    const stats = await reencodeImages(doc, quality, ctx.signal);
    ctx.onProgress((f + 0.75) / fileCount);

    throwIfAborted(ctx.signal);
    const rewritten = await doc.save({ useObjectStreams: true });
    const after = rewritten.byteLength;
    const stem = baseName(input.name);
    const smaller = after < before;

    outputs.push({
      name: smaller ? `${stem}-shrunk.pdf` : `${stem}-unchanged.pdf`,
      type: 'application/pdf',
      // NOT smaller => hand back the input, byte for byte. Never a larger file
      // dressed up as a saving.
      buffer: smaller ? toArrayBuffer(rewritten) : toArrayBuffer(new Uint8Array(input.buffer)),
    });

    const reported = smaller ? after : before;
    const percent = before === 0 ? 0 : Math.round(((before - reported) / before) * 1000) / 10;
    lines.push(
      `${input.name}`,
      `  before: ${before} bytes`,
      `  after:  ${reported} bytes (${percent}% ${percent === 0 ? 'change' : 'smaller'})`,
      `  images: ${stats.imagesReencoded} of ${stats.imagesSeen} re-encodable JPEG(s) replaced, ${stats.imageBytesSaved} image bytes saved`,
      smaller
        ? `  result: smaller — returned the rewritten file`
        : `  result: NOT smaller (rewrite was ${after} bytes) — returned the original file unchanged`,
      '',
    );

    ctx.onProgress((f + 1) / fileCount);
  }

  outputs.push({
    name: 'shrink-report.txt',
    type: 'text/plain',
    buffer: toArrayBuffer(new TextEncoder().encode(lines.join('\n'))),
  });

  ctx.onProgress(1);
  return outputs;
};

export default shrink;
