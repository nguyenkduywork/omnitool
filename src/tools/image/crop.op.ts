// src/tools/image/crop.op.ts — image-crop: crop to a rect produced by
// crop.editor.ts, in SOURCE pixel coordinates: { x, y, width, height }.
//
// No option schema (the editor supplies the rect directly as `options`).
// Two honesty rules:
//   - A rect that exceeds the source bounds is CLAMPED to them — never
//     padded with transparent pixels the user didn't ask for.
//   - A zero or negative area rect is a user/editor error, not a valid crop:
//     it raises InvalidOptions rather than silently producing a 1x1 image.

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

function requireFiniteNumber(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new OpError('InvalidOptions', `${label} must be a finite number, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

const crop: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Crop needs an image.');
  }

  const rawX = requireFiniteNumber(options.x, 'x');
  const rawY = requireFiniteNumber(options.y, 'y');
  const rawWidth = requireFiniteNumber(options.width, 'width');
  const rawHeight = requireFiniteNumber(options.height, 'height');

  if (rawWidth <= 0 || rawHeight <= 0) {
    throw new OpError(
      'InvalidOptions',
      `Crop width and height must both be positive, got width=${rawWidth}, height=${rawHeight}.`,
    );
  }

  stop(ctx.signal);

  const outputs: OpOutput[] = [];
  let done = 0;
  for (const input of inputs) {
    stop(ctx.signal);
    const bitmap = await decodeImage(input);
    stop(ctx.signal);

    // Clamp the requested rect to the source bounds rather than padding any
    // overhang with transparent pixels.
    const x = Math.min(Math.max(0, Math.round(rawX)), Math.max(0, bitmap.width - 1));
    const y = Math.min(Math.max(0, Math.round(rawY)), Math.max(0, bitmap.height - 1));
    const maxWidth = bitmap.width - x;
    const maxHeight = bitmap.height - y;
    const width = Math.min(Math.round(rawWidth), maxWidth);
    const height = Math.min(Math.round(rawHeight), maxHeight);

    if (width <= 0 || height <= 0) {
      bitmap.close();
      throw new OpError(
        'InvalidOptions',
        `The crop rect for ${input.name} has no area once clamped to its ${bitmap.width}x${bitmap.height} bounds.`,
        input.name,
      );
    }

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      throw new OpError('EncoderUnavailable', 'Could not acquire a 2D canvas context.');
    }
    context.drawImage(bitmap, x, y, width, height, 0, 0, width, height);
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

export default crop;
