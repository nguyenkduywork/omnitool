// src/tools/image/convert.op.ts — image-convert: re-encode images to PNG,
// JPEG, WebP or AVIF.
//
// Shares merge.op.ts's shape: (inputs, options, ctx) -> Promise<OpOutput[]>,
// progress reported per input, ctx.signal honoured, and an OpError NAMING THE
// FILE when one input is at fault so the runner can drop it and retry with
// what is left (see runner.worker.ts's per-file-failure loop).
//
// THE ENCODER PROBE — the most important thing in this file.
// `OffscreenCanvas#convertToBlob({ type })` does NOT throw for an unsupported
// encoder: it silently returns a PNG instead. Measured 2026-08-29 on Chrome
// for Testing 151 (headless): requesting 'image/avif' returns
// `{ type: 'image/png', size: 103 }`. So every encode here strictly compares
// the returned `blob.type` to what was requested and raises
// `EncoderUnavailable` on mismatch — a tool must never hand back a PNG's
// bytes labelled `.avif`. `canEncode()` below is the same probe, exported so
// the UI (Task 6) can disable an unsupported format up front, with a reason,
// instead of offering it and then failing.

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'avif';

const FORMATS: ImageFormat[] = ['png', 'jpeg', 'webp', 'avif'];

const MIME_OF: Record<ImageFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
};

const EXT_OF: Record<ImageFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
};

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

function replaceExtension(name: string, ext: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return `${base}.${ext}`;
}

/**
 * Decodes an OpInput into an ImageBitmap. `createImageBitmap` rejects with a
 * plain DOMException for undecodable bytes — that is wrapped here into an
 * OpError naming the file, never left to crash the worker.
 */
export async function decodeImage(input: OpInput): Promise<ImageBitmap> {
  if (input.type && !input.type.startsWith('image/')) {
    throw new OpError(
      'UnsupportedFormat',
      `${input.name} is not an image (detected ${input.type}).`,
      input.name,
    );
  }
  try {
    const blob = input.type ? new Blob([input.buffer], { type: input.type }) : new Blob([input.buffer]);
    return await createImageBitmap(blob);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new OpError('CorruptFile', `Could not decode ${input.name} as an image: ${reason}`, input.name);
  }
}

/** Per-mime cache: the probe result never changes within one browser session. */
const encodeSupportCache = new Map<string, Promise<boolean>>();

async function probeEncode(mime: string): Promise<boolean> {
  try {
    const canvas = new OffscreenCanvas(1, 1);
    // An OffscreenCanvas that never had a rendering context created throws
    // InvalidStateError from convertToBlob — touching the 2D context first
    // is required for the probe to mean anything (verified empirically).
    canvas.getContext('2d');
    const blob = await canvas.convertToBlob({ type: mime });
    return blob.type === mime;
  } catch {
    return false;
  }
}

/**
 * True when this environment's canvas encoder genuinely produces `mime` —
 * not merely accepts the request and silently falls back to PNG. Cached per
 * mime for the life of the module.
 */
export async function canEncode(mime: string): Promise<boolean> {
  let probe = encodeSupportCache.get(mime);
  if (!probe) {
    probe = probeEncode(mime);
    encodeSupportCache.set(mime, probe);
  }
  return probe;
}

/** Encode a canvas and verify the browser actually honoured the requested mime. */
export async function encodeCanvas(canvas: OffscreenCanvas, mime: string, quality?: number): Promise<ArrayBuffer> {
  const blob = await canvas.convertToBlob(quality === undefined ? { type: mime } : { type: mime, quality });
  if (blob.type !== mime) {
    throw new OpError(
      'EncoderUnavailable',
      `This browser's canvas encoder does not produce ${mime} — it returned ${blob.type || 'an empty type'} instead.`,
    );
  }
  return blob.arrayBuffer();
}

function validateFormat(raw: unknown): ImageFormat {
  const value = raw === undefined ? 'webp' : raw;
  if (typeof value !== 'string' || !FORMATS.includes(value as ImageFormat)) {
    throw new OpError('InvalidOptions', `format must be one of ${FORMATS.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return value as ImageFormat;
}

function validateQuality(raw: unknown): number {
  const value = raw === undefined ? 85 : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 10 || value > 100) {
    throw new OpError('InvalidOptions', `quality must be a number between 10 and 100, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const convert: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Convert needs at least one image.');
  }
  const format = validateFormat(options.format);
  const quality = validateQuality(options.quality);
  const mime = MIME_OF[format];

  stop(ctx.signal);
  const supported = await canEncode(mime);
  stop(ctx.signal);
  if (!supported) {
    throw new OpError(
      'EncoderUnavailable',
      `This browser cannot encode ${format.toUpperCase()} images — the canvas encoder is unavailable.`,
    );
  }

  const outputs: OpOutput[] = [];
  let done = 0;
  for (const input of inputs) {
    stop(ctx.signal);
    const bitmap = await decodeImage(input);
    stop(ctx.signal);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      throw new OpError('EncoderUnavailable', 'Could not acquire a 2D canvas context.');
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();

    const buffer = await encodeCanvas(canvas, mime, format === 'png' ? undefined : quality / 100);
    outputs.push({ name: replaceExtension(input.name, EXT_OF[format]), type: mime, buffer });

    done += 1;
    ctx.onProgress(done / inputs.length);
  }

  return outputs;
};

export default convert;
