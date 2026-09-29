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
import { readResizeOptions, resizeDimensions } from './resize-size';

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

const resize: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Resize needs at least one image.');
  }
  const settings = readResizeOptions(options);

  stop(ctx.signal);

  const outputs: OpOutput[] = [];
  let done = 0;
  for (const input of inputs) {
    stop(ctx.signal);
    const bitmap = await decodeImage(input);
    try {
      stop(ctx.signal);
      const target = resizeDimensions(bitmap, settings);
      if (settings.withoutEnlargement && target.width === bitmap.width && target.height === bitmap.height) {
        outputs.push({ ...input });
      } else {
        const canvas = new OffscreenCanvas(target.width, target.height);
        const context = canvas.getContext('2d');
        if (!context) throw new OpError('EncoderUnavailable', 'Could not acquire a 2D canvas context.');
        context.drawImage(bitmap, 0, 0, target.width, target.height);
        bitmap.close();
        const mime = outputMimeFor(input);
        const buffer = await encodeCanvas(canvas, mime);
        const name = input.type === mime ? input.name : renameForMime(input.name, mime);
        outputs.push({ name, type: mime, buffer });
      }
    } finally {
      bitmap.close();
    }

    done += 1;
    ctx.onProgress(done / inputs.length);
  }

  return outputs;
};

export default resize;
