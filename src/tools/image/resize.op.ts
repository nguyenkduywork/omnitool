// src/tools/image/resize.op.ts — image-resize: resize by exact dimensions or
// by percentage, with an optional aspect-ratio lock.
//
// `lockAspect: true` in 'dimensions' mode treats width/height as a bounding
// box: the image is scaled uniformly (never stretched) to fit inside that
// box. `percent` mode scales both axes by the same factor regardless of
// lockAspect, so it always preserves aspect ratio by construction.
//
// Output keeps the input's own mime/extension (this tool has no `format`
// option) — falling back to PNG for anything not already png/jpeg/webp/avif,
// in which case the FILENAME moves to `.png` with the bytes rather than
// staying behind on a `.gif` that is no longer a GIF.

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';
import { outputMimeFor, renameForMime } from './mime';

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

/** Decodes an OpInput into an ImageBitmap; wraps createImageBitmap's plain
 * DOMException into an OpError naming the file, never left to crash the worker. */
async function decodeImage(input: OpInput): Promise<ImageBitmap> {
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

/** Encode a canvas and verify the browser actually honoured the requested mime. */
async function encodeCanvas(canvas: OffscreenCanvas, mime: string): Promise<ArrayBuffer> {
  const blob = await canvas.convertToBlob({ type: mime });
  if (blob.type !== mime) {
    throw new OpError(
      'EncoderUnavailable',
      `This browser's canvas encoder does not produce ${mime} — it returned ${blob.type || 'an empty type'} instead.`,
    );
  }
  return blob.arrayBuffer();
}

type Mode = 'dimensions' | 'percent';
const MODES: Mode[] = ['dimensions', 'percent'];

function validateMode(raw: unknown): Mode {
  const value = raw === undefined ? 'dimensions' : raw;
  if (typeof value !== 'string' || !MODES.includes(value as Mode)) {
    throw new OpError('InvalidOptions', `mode must be one of ${MODES.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return value as Mode;
}

function validateRange(raw: unknown, def: number, min: number, max: number, label: string): number {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new OpError('InvalidOptions', `${label} must be a number between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function validateBool(raw: unknown, def: boolean, label: string): boolean {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'boolean') {
    throw new OpError('InvalidOptions', `${label} must be a boolean, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const resize: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Resize needs at least one image.');
  }
  const mode = validateMode(options.mode);
  const width = validateRange(options.width, 1920, 1, 20000, 'width');
  const height = validateRange(options.height, 1080, 1, 20000, 'height');
  const percent = validateRange(options.percent, 50, 5, 200, 'percent');
  const lockAspect = validateBool(options.lockAspect, true, 'lockAspect');

  stop(ctx.signal);

  const outputs: OpOutput[] = [];
  let done = 0;
  for (const input of inputs) {
    stop(ctx.signal);
    const bitmap = await decodeImage(input);
    stop(ctx.signal);

    let targetWidth: number;
    let targetHeight: number;
    if (mode === 'percent') {
      const scale = percent / 100;
      targetWidth = Math.max(1, Math.round(bitmap.width * scale));
      targetHeight = Math.max(1, Math.round(bitmap.height * scale));
    } else if (lockAspect) {
      // Fit inside the width x height box, uniformly — this is what actually
      // preserves aspect ratio, unlike stretching to width x height directly.
      const scale = Math.min(width / bitmap.width, height / bitmap.height);
      targetWidth = Math.max(1, Math.round(bitmap.width * scale));
      targetHeight = Math.max(1, Math.round(bitmap.height * scale));
    } else {
      targetWidth = width;
      targetHeight = height;
    }

    const canvas = new OffscreenCanvas(targetWidth, targetHeight);
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      throw new OpError('EncoderUnavailable', 'Could not acquire a 2D canvas context.');
    }
    context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    bitmap.close();

    const mime = outputMimeFor(input);
    const buffer = await encodeCanvas(canvas, mime);
    // `outputMimeFor` falls back to PNG for a format the canvas cannot encode
    // (GIF, BMP, TIFF, SVG), so the NAME has to move with the bytes instead of
    // labelling a PNG `.gif`.
    const name = input.type === mime ? input.name : renameForMime(input.name, mime);
    outputs.push({ name, type: mime, buffer });

    done += 1;
    ctx.onProgress(done / inputs.length);
  }

  return outputs;
};

export default resize;
