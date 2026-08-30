// src/tools/image/compress.op.ts — image-compress: re-encode at a lower
// quality to shrink file size, keeping the input's own format.
//
// Honest reporting (§1): re-encoding a tiny or already-optimal image can
// come back LARGER than the original (recompression overhead, lossless PNG
// has no quality knob at all). This tool never claims a reduction it did not
// achieve — if the recompressed bytes are not smaller, the original bytes
// are returned unchanged, under their own name AND their own mime. Bytes that
// were never re-encoded must not be labelled with the format they would have
// become: a GIF that the canvas would have turned into a PNG comes back as the
// GIF it still is. When the re-encode IS kept, and the canvas could not encode
// the input's format, the name moves with it (`renameForMime` in mime.ts).

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

/** Per-mime cache: the probe result never changes within one browser session. */
const encodeSupportCache = new Map<string, Promise<boolean>>();

async function canEncode(mime: string): Promise<boolean> {
  let probe = encodeSupportCache.get(mime);
  if (!probe) {
    probe = (async (): Promise<boolean> => {
      try {
        const canvas = new OffscreenCanvas(1, 1);
        // An OffscreenCanvas that never had a rendering context created
        // throws InvalidStateError from convertToBlob — touching the 2D
        // context first is required for the probe to mean anything
        // (verified empirically).
        canvas.getContext('2d');
        const blob = await canvas.convertToBlob({ type: mime });
        return blob.type === mime;
      } catch {
        return false;
      }
    })();
    encodeSupportCache.set(mime, probe);
  }
  return probe;
}

async function encodeCanvas(canvas: OffscreenCanvas, mime: string, quality?: number): Promise<ArrayBuffer> {
  const blob = await canvas.convertToBlob(quality === undefined ? { type: mime } : { type: mime, quality });
  if (blob.type !== mime) {
    throw new OpError(
      'EncoderUnavailable',
      `This browser's canvas encoder does not produce ${mime} — it returned ${blob.type || 'an empty type'} instead.`,
    );
  }
  return blob.arrayBuffer();
}

function validateQuality(raw: unknown): number {
  const value = raw === undefined ? 75 : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 10 || value > 100) {
    throw new OpError('InvalidOptions', `quality must be a number between 10 and 100, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const compress: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Compress needs at least one image.');
  }
  const quality = validateQuality(options.quality);

  stop(ctx.signal);

  const outputs: OpOutput[] = [];
  let done = 0;
  for (const input of inputs) {
    stop(ctx.signal);
    const bitmap = await decodeImage(input);
    stop(ctx.signal);

    const mime = outputMimeFor(input);
    const supported = await canEncode(mime);
    if (!supported) {
      bitmap.close();
      throw new OpError('EncoderUnavailable', `This browser cannot re-encode ${input.name} as ${mime}.`, input.name);
    }

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      throw new OpError('EncoderUnavailable', 'Could not acquire a 2D canvas context.');
    }
    context.drawImage(bitmap, 0, 0);
    bitmap.close();

    const isLossy = mime === 'image/jpeg' || mime === 'image/webp' || mime === 'image/avif';
    const buffer = await encodeCanvas(canvas, mime, isLossy ? quality / 100 : undefined);

    // Never claim a reduction that did not happen — and label whichever bytes
    // come back for what they actually are. Handing the ORIGINAL bytes back
    // means handing back the original name and mime with them: they are still
    // a GIF, whatever format the canvas would have re-encoded them to. Only
    // the re-encoded branch takes the output mime, and its name moves along
    // with it (see `renameForMime` in mime.ts).
    const smaller = buffer.byteLength < input.buffer.byteLength;
    outputs.push(
      smaller
        ? {
            name: input.type === mime ? input.name : renameForMime(input.name, mime),
            type: mime,
            buffer,
          }
        : {
            name: input.name,
            type: input.type || 'application/octet-stream',
            buffer: input.buffer.slice(0),
          },
    );

    done += 1;
    ctx.onProgress(done / inputs.length);
  }

  return outputs;
};

export default compress;
