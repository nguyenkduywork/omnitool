// src/tools/pdf/extract-images.op.ts — pdf-extract-images: pull the pictures
// EMBEDDED in a PDF back out as image files.
//
// This is not "PDF to images", and the difference is the whole point of the
// tool. That one rasterises PAGES: you get a picture of the page at a DPI you
// chose, with the layout around it and the photograph resampled to whatever
// the page happened to need. This one reaches into the document's object graph
// and hands back the picture that was put in there.
//
// WHAT COMES OUT:
//
//   /DCTDecode  -> the original JPEG, byte for byte. A DCTDecode stream's
//     contents ARE a JPEG file — extracting one is a copy, not a decode and
//     re-encode, so there is no quality to lose and no quality option to get
//     wrong. This is the case that covers photographs, which is most of what
//     anyone opens a PDF for.
//   /FlateDecode, 8 bits per component, DeviceGray or DeviceRGB (including
//     ICCBased with 1 or 3 components), no predictor -> a PNG. The pixels are
//     already raw in the file; this only wraps them in a container, so it is
//     lossless too.
//   Anything else -> LEFT ALONE and named in the report, with the reason.
//     JPEG 2000, CCITT and JBIG2 fax images, indexed palettes, 1-bit stencil
//     masks, filter chains: all real things that appear in real PDFs and none
//     of which this tool pretends to handle.
//
// PREDICTORS ARE REFUSED ON PURPOSE. When /DecodeParms asks for a predictor,
// pdf-lib undoes the Flate filter but NOT the predictor, so the bytes that come
// back are still predictor-encoded. Writing them into a PNG would produce a
// file that opens, looks like garbage, and gives no hint why. Refusing by name
// is the honest answer.
//
// SOFT MASKS are not composited: an image with an /SMask comes out opaque, and
// the report says so for that image rather than leaving you to discover it.
// The mask itself is NOT written out as a file of its own — it is an 8-bit
// grayscale image XObject and would otherwise pass every check here, leaving
// you with twice as many files as the document has pictures, half of them
// alpha channels.
//
// The same XObject drawn on forty pages is extracted ONCE, named for the first
// page it appears on.

import { zlibSync } from 'fflate';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

const PDF_HEADER = '%PDF-';

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function baseName(name: string): string {
  const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  const stem = cut >= 0 ? name.slice(cut + 1) : name;
  const dot = stem.lastIndexOf('.');
  return dot > 0 ? stem.slice(0, dot) : stem;
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

/** Load a PDF, mapping every failure onto `CorruptFile` naming the file. */
async function loadPdf(input: OpInput): Promise<PDFDocument> {
  assertLooksLikePdf(input);
  try {
    const doc = await PDFDocument.load(input.buffer, { updateMetadata: false });
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

// ---------------------------------------------------------------------------
// PNG writing — for the images that are stored as raw pixels
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG's chunk checksum. The table is built once; the loop runs per byte. */
const CRC_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** Wrap raw 8-bit grayscale or RGB pixels in a PNG container. Lossless. */
function encodePng(pixels: Uint8Array, width: number, height: number, channels: 1 | 3): Uint8Array {
  const stride = width * channels;
  // PNG scanlines carry a leading filter byte; 0 means "stored as-is".
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = channels === 1 ? 0 : 2; // colour type: grayscale or truecolour
  // compression, filter and interlace methods: the only values PNG defines.

  return concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlibSync(raw, { level: 6 })),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Reading the image XObjects
// ---------------------------------------------------------------------------

/**
 * The filters on a stream, in order. An empty array means there genuinely are
 * none — the contents are raw — while `null` means /Filter is there but is not
 * something this tool can read. Telling those two apart matters: they lead to
 * opposite outcomes, and a tool whose selling point is naming its reason must
 * not name the wrong one.
 *
 * Both /Filter itself and the entries of a /Filter array may be indirect
 * references, which is why every read here goes through `lookup`.
 */
function filterNames(dict: PDFDict): string[] | null {
  const filter = dict.lookup(PDFName.of('Filter'));
  if (filter === undefined) return [];
  if (filter instanceof PDFName) return [filter.asString()];
  if (filter instanceof PDFArray) {
    const names: string[] = [];
    for (let i = 0; i < filter.size(); i++) {
      const entry = filter.lookup(i);
      if (!(entry instanceof PDFName)) return null;
      names.push(entry.asString());
    }
    return names;
  }
  return null;
}

/**
 * The image XObjects that are some other image's soft or stencil mask. They
 * are 8-bit grayscale images in their own right, so they sail through every
 * check below — but they are an alpha channel, not a picture, and writing one
 * out as a file means handing back twice as many images as the document has,
 * half of them meaningless on their own. Any RGBA PNG placed in a PDF produces
 * one, so this is the common case rather than an exotic one.
 */
function maskRefs(doc: PDFDocument): Set<string> {
  const masks = new Set<string>();
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    if (String(object.dict.get(PDFName.of('Subtype'))) !== '/Image') continue;
    for (const key of ['SMask', 'Mask']) {
      // /Mask can also be an array of colour-key ranges, which is not a ref.
      const ref = object.dict.get(PDFName.of(key));
      if (ref instanceof PDFRef) masks.add(ref.toString());
    }
  }
  return masks;
}

/** How many 8-bit components a colour space has, or null if we cannot tell. */
function componentsOf(doc: PDFDocument, dict: PDFDict): 1 | 3 | null {
  const space = dict.get(PDFName.of('ColorSpace'));

  if (space instanceof PDFName) {
    if (space.asString() === '/DeviceGray') return 1;
    if (space.asString() === '/DeviceRGB') return 3;
    return null;
  }

  // [/ICCBased <stream>] — the stream's /N says how many components it has.
  // Common enough in real PDFs that skipping it would gut the Flate path.
  const resolved = space instanceof PDFRef ? doc.context.lookup(space) : space;
  if (resolved instanceof PDFArray && resolved.size() === 2) {
    const family = resolved.get(0);
    if (!(family instanceof PDFName) || family.asString() !== '/ICCBased') return null;
    const profile = doc.context.lookup(resolved.get(1));
    const n = profile instanceof PDFRawStream ? profile.dict.get(PDFName.of('N')) : undefined;
    if (n instanceof PDFNumber && (n.asNumber() === 1 || n.asNumber() === 3)) {
      return n.asNumber() as 1 | 3;
    }
  }
  return null;
}

/** Does /DecodeParms ask for a predictor we would have to undo ourselves? */
function hasPredictor(doc: PDFDocument, dict: PDFDict): boolean {
  const raw = dict.get(PDFName.of('DecodeParms'));
  const parms = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
  const candidates = parms instanceof PDFArray ? parms.asArray() : [parms];
  for (const candidate of candidates) {
    const resolved = candidate instanceof PDFRef ? doc.context.lookup(candidate) : candidate;
    if (!(resolved instanceof PDFDict)) continue;
    const predictor = resolved.get(PDFName.of('Predictor'));
    if (predictor instanceof PDFNumber && predictor.asNumber() > 1) return true;
  }
  return false;
}

type Picture = { bytes: Uint8Array; extension: string; kind: string };
type Extraction = Picture | { skipped: string };

function isSkipped(result: Extraction): result is { skipped: string } {
  return 'skipped' in result;
}

/** Decide what, if anything, can be pulled out of one image XObject. */
function extract(doc: PDFDocument, stream: PDFRawStream, minSize: number): Extraction | null {
  const dict = stream.dict;
  if (String(dict.get(PDFName.of('Subtype'))) !== '/Image') return null;

  const width = dict.get(PDFName.of('Width'));
  const height = dict.get(PDFName.of('Height'));
  if (!(width instanceof PDFNumber) || !(height instanceof PDFNumber)) {
    return { skipped: 'it declares no usable size' };
  }
  const w = width.asNumber();
  const h = height.asNumber();
  if (w <= 0 || h <= 0) return { skipped: 'it declares no usable size' };

  if (String(dict.get(PDFName.of('ImageMask'))) === 'true') {
    return { skipped: 'it is a 1-bit stencil mask, not a picture' };
  }

  // Before anything expensive: an image under the size filter is not extracted,
  // so there is no reason to have compressed it first.
  if (minSize > 0 && (w < minSize || h < minSize)) {
    return { skipped: `${w}x${h} is under the size filter` };
  }

  const filters = filterNames(dict);
  if (filters === null) {
    return { skipped: 'its /Filter entry is not a filter name this tool can read' };
  }
  if (filters.length > 1) {
    return { skipped: `its filters are chained (${filters.join(' + ')})` };
  }

  // `undefined` here means the stream carries no filter at all, and its
  // contents are already the raw pixels — the easiest case in the whole op.
  const filter = filters[0];

  // The headline case: these bytes already ARE a JPEG file.
  if (filter === '/DCTDecode') {
    return { bytes: stream.contents, extension: 'jpg', kind: `JPEG ${w}x${h}` };
  }

  if (filter !== undefined && filter !== '/FlateDecode') {
    const known: Record<string, string> = {
      '/JPXDecode': 'it is JPEG 2000',
      '/CCITTFaxDecode': 'it is CCITT fax data',
      '/JBIG2Decode': 'it is JBIG2 data',
      '/LZWDecode': 'it is LZW-compressed',
      '/RunLengthDecode': 'it is run-length encoded',
    };
    return { skipped: known[filter ?? ''] ?? `its filter ${filter} is not supported` };
  }

  const bpc = dict.get(PDFName.of('BitsPerComponent'));
  if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 8) {
    return { skipped: `it is ${bpc instanceof PDFNumber ? bpc.asNumber() : '?'} bits per component, not 8` };
  }
  if (dict.get(PDFName.of('Decode')) !== undefined) {
    return { skipped: 'it carries a /Decode array that would invert or remap its pixels' };
  }
  if (hasPredictor(doc, dict)) {
    // See the header: pdf-lib undoes the filter but not the predictor.
    return { skipped: 'its pixels are predictor-encoded, which this tool will not guess at' };
  }

  const channels = componentsOf(doc, dict);
  if (channels === null) {
    return { skipped: `its colour space (${String(dict.get(PDFName.of('ColorSpace')))}) is not grayscale or RGB` };
  }

  let pixels: Uint8Array;
  if (filter === undefined) {
    pixels = stream.contents;
  } else {
    try {
      pixels = decodePDFRawStream(stream).decode();
    } catch (error) {
      return {
        skipped: `its stream could not be decompressed (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }
  const expected = w * h * channels;
  if (pixels.length < expected) {
    return { skipped: `its pixel data is short (${pixels.length} bytes for a ${w}x${h} image needing ${expected})` };
  }

  return {
    bytes: encodePng(pixels.subarray(0, expected), w, h, channels),
    extension: 'png',
    kind: `${channels === 1 ? 'grayscale' : 'RGB'} ${w}x${h}`,
  };
}

/**
 * First page number each image XObject is drawn on, so files can be named for
 * where they came from. Form XObjects are walked too, since a picture placed
 * through one is still on that page.
 */
function pageOfEachImage(doc: PDFDocument): Map<string, number> {
  const found = new Map<string, number>();
  const pages = doc.getPages();

  const walk = (resources: PDFDict | undefined, page: number, seen: Set<string>): void => {
    const xObjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (xObjects === undefined) return;
    for (const key of xObjects.keys()) {
      const ref = xObjects.get(key);
      if (!(ref instanceof PDFRef)) continue;
      const id = ref.toString();
      if (seen.has(id)) continue; // a form that contains itself, however it got that way
      seen.add(id);

      const target = doc.context.lookup(ref);
      if (!(target instanceof PDFRawStream)) continue;
      const subtype = String(target.dict.get(PDFName.of('Subtype')));
      if (subtype === '/Image') {
        if (!found.has(id)) found.set(id, page);
      } else if (subtype === '/Form') {
        walk(target.dict.lookupMaybe(PDFName.of('Resources'), PDFDict), page, seen);
      }
    }
  };

  for (let i = 0; i < pages.length; i++) {
    walk(pages[i]?.node.lookupMaybe(PDFName.of('Resources'), PDFDict), i + 1, new Set());
  }
  return found;
}

function validateMinSize(raw: unknown): number {
  const value = raw === undefined ? 0 : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 4096) {
    throw new OpError(
      'InvalidOptions',
      `minSize must be a number between 0 and 4096, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

const extractImages: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Extract images needs at least one PDF.');
  }
  const minSize = validateMinSize(options.minSize);

  const outputs: OpOutput[] = [];
  const lines: string[] = [
    'pdf-extract-images report',
    minSize > 0 ? `skipping anything smaller than ${minSize}px on a side` : 'no size filter',
    '',
  ];

  for (let index = 0; index < inputs.length; index++) {
    stop(ctx.signal);
    const input = inputs[index];
    if (input === undefined) continue;

    const doc = await loadPdf(input);
    stop(ctx.signal);

    const pageOf = pageOfEachImage(doc);
    const masks = maskRefs(doc);
    const stem = baseName(input.name);
    lines.push(input.name);

    let taken = 0;
    let counter = 0;
    for (const [ref, object] of doc.context.enumerateIndirectObjects()) {
      stop(ctx.signal);
      if (!(object instanceof PDFRawStream)) continue;
      // Another image's alpha channel is not a picture of its own; the image
      // that owns it says so on its own line below.
      if (masks.has(ref.toString())) continue;

      const result = extract(doc, object, minSize);
      if (result === null) continue; // not an image XObject at all

      counter += 1;
      const page = pageOf.get(ref.toString());
      const where = page === undefined ? `image ${counter}` : `page ${page}, image ${counter}`;

      if (isSkipped(result)) {
        lines.push(`  skipped ${where} — ${result.skipped}`);
        continue;
      }

      const name = page === undefined ? `${stem}-image-${counter}` : `${stem}-p${page}-${counter}`;
      outputs.push({
        name: `${name}.${result.extension}`,
        type: result.extension === 'jpg' ? 'image/jpeg' : 'image/png',
        buffer: toArrayBuffer(result.bytes),
      });
      taken += 1;

      const masked = object.dict.get(PDFName.of('SMask')) !== undefined;
      lines.push(
        `  ${name}.${result.extension} — ${result.kind}${masked ? ', extracted opaque (its soft mask was left behind)' : ''}`,
      );
    }

    if (counter === 0) lines.push('  no embedded images found');
    else if (taken === 0) lines.push('  nothing could be extracted — see the reasons above');
    lines.push('');

    ctx.onProgress((index + 1) / inputs.length);
  }

  outputs.push({
    name: 'extract-images-report.txt',
    type: 'text/plain',
    buffer: toArrayBuffer(new TextEncoder().encode(lines.join('\n'))),
  });

  return outputs;
};

export default extractImages;
