// src/tools/image/rotate.op.ts — image-rotate: turn an image in 90° steps
// and/or mirror it.
//
// HONESTY NOTE, and the reason `quality` exists: this re-encodes. Rotating a
// JPEG through canvas decodes it to pixels and encodes those pixels again,
// which is lossy — a genuinely lossless 90° JPEG rotate means transposing the
// DCT coefficient blocks (what jpegtran does), which needs a JPEG codec this
// tool does not carry. `quality` lets you choose what that second encode
// costs; it is ignored for PNG, which is lossless either way.
//
// Because of that cost, "rotate by 0 with no flip" returns the input's bytes
// UNCHANGED rather than round-tripping them through the encoder for nothing.
//
// Order of operations: the image is mirrored first, then rotated — so
// `angle: 90, flip: horizontal` means "mirror it, then turn it".

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';
import { decodeImage, encodeCanvas } from './convert.op';

type Angle = 0 | 90 | 180 | 270;
type Flip = 'none' | 'horizontal' | 'vertical';

const ANGLES: Angle[] = [0, 90, 180, 270];
const FLIPS: Flip[] = ['none', 'horizontal', 'vertical'];

/** Formats whose mime we can hand straight back to the canvas encoder. */
const KNOWN_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'];
const LOSSLESS_MIMES = ['image/png'];

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

/** The angle option arrives from a `select`, so it is a string of digits. */
function validateAngle(raw: unknown): Angle {
  const value = raw === undefined ? '90' : raw;
  const blank = typeof value === 'string' && value.trim() === '';
  // Number('') is 0, which would quietly become "no rotation".
  if ((typeof value !== 'string' && typeof value !== 'number') || blank) {
    throw new OpError('InvalidOptions', `angle must be one of ${ANGLES.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!ANGLES.includes(parsed as Angle)) {
    throw new OpError('InvalidOptions', `angle must be one of ${ANGLES.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return parsed as Angle;
}

function validateFlip(raw: unknown): Flip {
  const value = raw === undefined ? 'none' : raw;
  if (typeof value !== 'string' || !FLIPS.includes(value as Flip)) {
    throw new OpError('InvalidOptions', `flip must be one of ${FLIPS.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return value as Flip;
}

function validateQuality(raw: unknown): number {
  const value = raw === undefined ? 92 : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 10 || value > 100) {
    throw new OpError('InvalidOptions', `quality must be a number between 10 and 100, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function outputMimeFor(input: OpInput): string {
  return input.type && KNOWN_MIMES.includes(input.type) ? input.type : 'image/png';
}

const rotate: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Rotate needs at least one image.');
  }
  const angle = validateAngle(options.angle);
  const flip = validateFlip(options.flip);
  const quality = validateQuality(options.quality);

  stop(ctx.signal);

  const outputs: OpOutput[] = [];
  let done = 0;
  for (const input of inputs) {
    stop(ctx.signal);

    // Nothing to do: hand back the exact bytes instead of a lossy re-encode.
    if (angle === 0 && flip === 'none') {
      outputs.push({ name: input.name, type: input.type || 'application/octet-stream', buffer: input.buffer });
      done += 1;
      ctx.onProgress(done / inputs.length);
      continue;
    }

    const bitmap = await decodeImage(input);
    stop(ctx.signal);

    const quarterTurn = angle === 90 || angle === 270;
    const width = quarterTurn ? bitmap.height : bitmap.width;
    const height = quarterTurn ? bitmap.width : bitmap.height;

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      throw new OpError('EncoderUnavailable', 'Could not acquire a 2D canvas context.');
    }

    // Compose about the output's centre: translate -> rotate -> mirror, which
    // applies to source pixels in the reverse order (mirror, then rotate).
    context.translate(width / 2, height / 2);
    if (angle !== 0) context.rotate((angle * Math.PI) / 180);
    if (flip === 'horizontal') context.scale(-1, 1);
    else if (flip === 'vertical') context.scale(1, -1);
    context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    bitmap.close();

    const mime = outputMimeFor(input);
    const buffer = await encodeCanvas(canvas, mime, LOSSLESS_MIMES.includes(mime) ? undefined : quality / 100);
    outputs.push({ name: input.name, type: mime, buffer });

    done += 1;
    ctx.onProgress(done / inputs.length);
  }

  return outputs;
};

export default rotate;
