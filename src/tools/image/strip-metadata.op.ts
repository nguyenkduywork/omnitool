// src/tools/image/strip-metadata.op.ts — image-strip-metadata: remove EXIF,
// GPS, XMP and comment blocks from an image.
//
// THE PIXELS ARE NEVER TOUCHED. This op does container surgery, not
// re-encoding: it walks the file's own segment/chunk structure and copies
// every byte through except the blocks that carry metadata. A JPEG's
// compressed scan data, a PNG's IDAT streams and a WebP's VP8/VP8L bitstream
// come out byte-for-byte identical, so there is no quality loss to trade off
// and no `quality` option to get wrong. That is also why this is not just
// "convert the image to itself": a canvas round-trip would drop the metadata
// as a side effect while silently re-compressing the picture.
//
// WHAT GOES, PRECISELY:
//
//   JPEG — APP1 (EXIF, including GPS, and XMP), APP2 that is not an ICC
//     profile, APP3-APP13 and APP15 (camera-maker and photo-editor blocks,
//     e.g. APP13's Photoshop/IPTC record), and COM comments. KEPT: APP0
//     (JFIF), APP14 (Adobe — it carries the colour-transform flag, and
//     dropping it can make a YCCK/CMYK JPEG decode with wrong colours), the
//     ICC profile unless you ask for it too, and every coding segment.
//   PNG — tEXt, zTXt, iTXt, eXIf and tIME chunks, plus anything appended
//     after IEND. Critical chunks and colour chunks (gAMA, cHRM, sRGB) stay.
//   WebP — the EXIF and 'XMP ' chunks, with the matching flag bits cleared in
//     the VP8X header so the file does not advertise metadata it no longer
//     carries.
//
// `keepColorProfile` (default true) decides the one genuinely visual case: an
// ICC profile is metadata, but removing it can change how the image looks.
// Turn it off to strip that too — JPEG APP2/ICC_PROFILE, PNG iCCP, WebP ICCP.
//
// Anything that is not JPEG, PNG or WebP raises UnsupportedFormat NAMING THE
// FILE, so the runner drops that one input and still reports the rest (see
// runner.worker.ts). It never returns a file it did not actually strip.

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

type Removal = { label: string; bytes: number };
type Stripped = { bytes: Uint8Array; removed: Removal[]; keptProfile: boolean };

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function startsWithAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function fourCC(bytes: Uint8Array, offset: number): string {
  let out = '';
  for (let i = 0; i < 4; i++) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

/** Markers that stand alone: no two-byte length follows them. */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

function jpegSegmentLabel(marker: number, payload: Uint8Array): string {
  if (marker === 0xfe) return 'comment (COM)';
  if (marker === 0xe1) {
    if (startsWithAscii(payload, 0, 'Exif\0\0')) return 'EXIF (APP1)';
    if (startsWithAscii(payload, 0, 'http://ns.adobe.com/xap/1.0/')) return 'XMP (APP1)';
    return 'APP1';
  }
  if (marker === 0xe2) return 'APP2';
  if (marker === 0xed && startsWithAscii(payload, 0, 'Photoshop 3.0')) return 'IPTC/Photoshop (APP13)';
  return `APP${marker - 0xe0}`;
}

function stripJpeg(bytes: Uint8Array, keepColorProfile: boolean, name: string): Stripped {
  const kept: Uint8Array[] = [];
  const removed: Removal[] = [];
  let keptProfile = false;

  kept.push(bytes.subarray(0, 2)); // SOI
  let at = 2;

  while (at < bytes.length) {
    if (bytes[at] !== 0xff) {
      throw new OpError('CorruptFile', `${name} is not a readable JPEG: expected a marker at byte ${at}.`, name);
    }
    // 0xFF may be repeated as fill before a marker; keep those bytes.
    let markerAt = at;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt += 1;
    if (markerAt >= bytes.length) {
      kept.push(bytes.subarray(at));
      break;
    }
    const marker = bytes[markerAt] as number;

    // SOS starts the entropy-coded scan, EOI ends the file: from here the
    // bytes are not segments any more, so they are copied verbatim.
    if (marker === 0xda || marker === 0xd9) {
      kept.push(bytes.subarray(at));
      break;
    }
    if (isStandaloneMarker(marker)) {
      kept.push(bytes.subarray(at, markerAt + 1));
      at = markerAt + 1;
      continue;
    }

    if (markerAt + 2 >= bytes.length) {
      throw new OpError('CorruptFile', `${name} ends inside a JPEG segment header.`, name);
    }
    const segmentLength = ((bytes[markerAt + 1] as number) << 8) | (bytes[markerAt + 2] as number);
    const end = markerAt + 1 + segmentLength;
    if (segmentLength < 2 || end > bytes.length) {
      throw new OpError('CorruptFile', `${name} declares a JPEG segment that runs past the end of the file.`, name);
    }
    const payload = bytes.subarray(markerAt + 3, end);

    const isApp = marker >= 0xe0 && marker <= 0xef;
    const isIccProfile = marker === 0xe2 && startsWithAscii(payload, 0, 'ICC_PROFILE\0');
    // APP0 (JFIF) and APP14 (Adobe) are structural, not metadata.
    const structural = marker === 0xe0 || marker === 0xee;
    const drop =
      marker === 0xfe || (isApp && !structural && (isIccProfile ? !keepColorProfile : true));

    if (drop) {
      removed.push({
        label: isIccProfile ? 'ICC colour profile (APP2)' : jpegSegmentLabel(marker, payload),
        bytes: end - at,
      });
    } else {
      if (isIccProfile) keptProfile = true;
      kept.push(bytes.subarray(at, end));
    }
    at = end;
  }

  return { bytes: concat(kept), removed, keptProfile };
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

function stripPng(bytes: Uint8Array, keepColorProfile: boolean, name: string): Stripped {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  const removed: Removal[] = [];
  let keptProfile = false;
  let at = 8;
  let sawEnd = false;

  while (at + 8 <= bytes.length) {
    const dataLength = view.getUint32(at);
    const type = fourCC(bytes, at + 4);
    const end = at + 12 + dataLength; // length + type + data + CRC
    if (end > bytes.length) {
      throw new OpError('CorruptFile', `${name} declares a PNG chunk that runs past the end of the file.`, name);
    }

    const isProfile = type === 'iCCP';
    const drop = PNG_METADATA_CHUNKS.has(type) || (isProfile && !keepColorProfile);
    if (drop) {
      removed.push({ label: `${type} chunk`, bytes: end - at });
    } else {
      if (isProfile) keptProfile = true;
      kept.push(bytes.subarray(at, end));
    }

    at = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }

  if (!sawEnd) {
    throw new OpError('CorruptFile', `${name} is not a readable PNG: no IEND chunk.`, name);
  }
  // Nothing is valid after IEND; anything there is a metadata tail or padding.
  if (at < bytes.length) {
    removed.push({ label: 'bytes appended after IEND', bytes: bytes.length - at });
  }

  return { bytes: concat(kept), removed, keptProfile };
}

// ---------------------------------------------------------------------------
// WebP (RIFF)
// ---------------------------------------------------------------------------

// VP8X flag bits, MSB first: Rsv Rsv ICC Alpha EXIF XMP Anim Rsv.
const VP8X_ICC = 0x20;
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

function stripWebp(bytes: Uint8Array, keepColorProfile: boolean, name: string): Stripped {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const removed: Removal[] = [];
  const body: Uint8Array[] = [];
  let keptProfile = false;
  let clearFlags = 0;
  let vp8xAt = -1;
  let at = 12;

  while (at + 8 <= bytes.length) {
    const type = fourCC(bytes, at);
    const dataLength = view.getUint32(at + 4, true);
    // RIFF chunks are padded to an even length.
    const end = at + 8 + dataLength + (dataLength % 2);
    if (at + 8 + dataLength > bytes.length) {
      throw new OpError('CorruptFile', `${name} declares a WebP chunk that runs past the end of the file.`, name);
    }

    const isProfile = type === 'ICCP';
    const drop = type === 'EXIF' || type === 'XMP ' || (isProfile && !keepColorProfile);
    if (drop) {
      removed.push({ label: `${type.trim()} chunk`, bytes: Math.min(end, bytes.length) - at });
      if (type === 'EXIF') clearFlags |= VP8X_EXIF;
      else if (type === 'XMP ') clearFlags |= VP8X_XMP;
      else clearFlags |= VP8X_ICC;
    } else {
      if (isProfile) keptProfile = true;
      if (type === 'VP8X') vp8xAt = body.reduce((sum, part) => sum + part.length, 0);
      body.push(bytes.subarray(at, Math.min(end, bytes.length)));
    }
    at = end;
  }

  if (body.length === 0) {
    throw new OpError('CorruptFile', `${name} is not a readable WebP: no chunks found.`, name);
  }

  const payload = concat(body);
  // The VP8X header advertises which optional chunks exist. Leaving a bit set
  // for a chunk we just removed would make the file lie about itself.
  if (vp8xAt >= 0 && clearFlags !== 0) {
    const flagsAt = vp8xAt + 8;
    payload[flagsAt] = (payload[flagsAt] as number) & ~clearFlags & 0xff;
  }

  const out = new Uint8Array(12 + payload.length);
  out.set(bytes.subarray(0, 12), 0);
  out.set(payload, 12);
  new DataView(out.buffer).setUint32(4, out.length - 8, true);

  return { bytes: out, removed, keptProfile };
}

// ---------------------------------------------------------------------------
// Op
// ---------------------------------------------------------------------------

function strip(input: OpInput, keepColorProfile: boolean): Stripped {
  const bytes = new Uint8Array(input.buffer);

  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return stripJpeg(bytes, keepColorProfile, input.name);
  }
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    return stripPng(bytes, keepColorProfile, input.name);
  }
  if (bytes.length >= 12 && fourCC(bytes, 0) === 'RIFF' && fourCC(bytes, 8) === 'WEBP') {
    return stripWebp(bytes, keepColorProfile, input.name);
  }
  throw new OpError(
    'UnsupportedFormat',
    `${input.name} is not a JPEG, PNG or WebP — those are the formats whose metadata this tool can remove without re-encoding the image.`,
    input.name,
  );
}

function validateBool(raw: unknown, def: boolean, label: string): boolean {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'boolean') {
    throw new OpError('InvalidOptions', `${label} must be a boolean, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const stripMetadata: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Strip metadata needs at least one image.');
  }
  const keepColorProfile = validateBool(options.keepColorProfile, true, 'keepColorProfile');

  const outputs: OpOutput[] = [];
  const lines: string[] = [
    'image-strip-metadata report',
    `colour profile: ${keepColorProfile ? 'kept' : 'removed too'}`,
    '',
  ];

  for (let index = 0; index < inputs.length; index++) {
    stop(ctx.signal);
    const input = inputs[index];
    if (input === undefined) continue;

    const before = input.buffer.byteLength;
    const result = strip(input, keepColorProfile);
    const after = result.bytes.length;
    const changed = result.removed.length > 0;

    outputs.push({
      name: input.name,
      type: input.type || 'application/octet-stream',
      // Nothing found means nothing to rewrite: hand back the input's bytes.
      buffer: changed ? toArrayBuffer(result.bytes) : input.buffer,
    });

    lines.push(input.name);
    if (changed) {
      for (const removal of result.removed) lines.push(`  removed ${removal.label} (${removal.bytes} bytes)`);
      if (result.keptProfile) lines.push('  kept the ICC colour profile');
      lines.push(`  ${before} bytes -> ${after} bytes`);
    } else {
      lines.push('  no metadata found — returned the original file unchanged');
    }
    lines.push('');

    ctx.onProgress((index + 1) / inputs.length);
  }

  outputs.push({
    name: 'metadata-report.txt',
    type: 'text/plain',
    buffer: toArrayBuffer(new TextEncoder().encode(lines.join('\n'))),
  });

  return outputs;
};

export default stripMetadata;
