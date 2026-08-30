// src/tools/image/watermark.op.ts — image-watermark: draw a line of text over
// an image.
//
// HONESTY NOTE 1 — this re-encodes, exactly as image-rotate does. The
// watermark is painted into the pixels, so the file is decoded and encoded
// again; for a JPEG that costs a little quality, and `quality` is what you
// spend. PNG ignores it, being lossless either way.
//
// HONESTY NOTE 2 — a drawn watermark is a *label*, not a lock. It is pixels
// like any other pixels: it can be cropped off, painted over, or removed by
// anyone willing to spend a few minutes on it. Use it to mark provenance or
// state ("DRAFT", "CONFIDENTIAL"), never as access control.
//
// The text is sized as a PERCENTAGE OF THE IMAGE'S SHORTER SIDE rather than in
// pixels, so one setting looks the same on a phone screenshot and on a 6000px
// photograph — a fixed point size would be a banner on one and unreadable on
// the other. It is drawn with a thin outline in the opposite colour so it stays
// legible over both light and dark areas of the picture.

import { OpError, type Op, type OpOutput } from '../../types';
import { decodeImage, encodeCanvas } from './convert.op';
import { LOSSLESS_MIMES, outputMimeFor, renameForMime } from './mime';

type Position = 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left' | 'center' | 'tile';
type Colour = 'white' | 'black';

const POSITIONS: Position[] = [
  'bottom-right',
  'bottom-left',
  'top-right',
  'top-left',
  'center',
  'tile',
];
const COLOURS: Colour[] = ['white', 'black'];

/** The angle tiled text is laid at — the diagonal that reads as a watermark. */
const TILE_RADIANS = -Math.PI / 6;

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

function validateText(raw: unknown): string {
  const value = raw === undefined ? 'CONFIDENTIAL' : raw;
  if (typeof value !== 'string') {
    throw new OpError('InvalidOptions', `text must be a string, got ${typeof raw}`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    // Silently stamping nothing would hand back a lossy re-encode of the
    // original and call it a watermark.
    throw new OpError('InvalidOptions', 'Enter the text to stamp on the image.');
  }
  return trimmed;
}

function validatePosition(raw: unknown): Position {
  const value = raw === undefined ? 'bottom-right' : raw;
  if (typeof value !== 'string' || !POSITIONS.includes(value as Position)) {
    throw new OpError(
      'InvalidOptions',
      `position must be one of ${POSITIONS.join(', ')}, got ${JSON.stringify(raw)}`,
    );
  }
  return value as Position;
}

function validateColour(raw: unknown): Colour {
  const value = raw === undefined ? 'white' : raw;
  if (typeof value !== 'string' || !COLOURS.includes(value as Colour)) {
    throw new OpError(
      'InvalidOptions',
      `colour must be one of ${COLOURS.join(', ')}, got ${JSON.stringify(raw)}`,
    );
  }
  return value as Colour;
}

function validateNumber(raw: unknown, def: number, min: number, max: number, label: string): number {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new OpError(
      'InvalidOptions',
      `${label} must be a number between ${min} and ${max}, got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

/** Where a single stamp sits, in canvas coordinates, with its alignment. */
function anchor(
  position: Exclude<Position, 'tile'>,
  width: number,
  height: number,
  margin: number,
  fontSize: number,
): { x: number; y: number; align: CanvasTextAlign } {
  // Half the text's height keeps a 'middle' baseline clear of the edge.
  const inset = margin + fontSize / 2;
  switch (position) {
    case 'bottom-right':
      return { x: width - margin, y: height - inset, align: 'right' };
    case 'bottom-left':
      return { x: margin, y: height - inset, align: 'left' };
    case 'top-right':
      return { x: width - margin, y: inset, align: 'right' };
    case 'top-left':
      return { x: margin, y: inset, align: 'left' };
    case 'center':
      return { x: width / 2, y: height / 2, align: 'center' };
  }
}

const watermark: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Watermark needs at least one image.');
  }
  const text = validateText(options.text);
  const position = validatePosition(options.position);
  const colour = validateColour(options.colour);
  const size = validateNumber(options.size, 6, 1, 25, 'size');
  const opacity = validateNumber(options.opacity, 35, 5, 100, 'opacity');
  const quality = validateNumber(options.quality, 92, 10, 100, 'quality');

  stop(ctx.signal);

  const outputs: OpOutput[] = [];
  let done = 0;

  for (const input of inputs) {
    stop(ctx.signal);
    const bitmap = await decodeImage(input);
    stop(ctx.signal);

    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      throw new OpError('EncoderUnavailable', 'Could not acquire a 2D canvas context.');
    }

    context.drawImage(bitmap, 0, 0);
    bitmap.close();

    const shorter = Math.min(width, height);
    // A floor of 8px keeps the stamp readable on a thumbnail, where 1% of the
    // shorter side would round to nothing.
    const fontSize = Math.max(8, Math.round((size / 100) * shorter));
    const margin = Math.max(2, Math.round(shorter * 0.04));

    context.font = `600 ${fontSize}px sans-serif`;
    context.textBaseline = 'middle';
    context.globalAlpha = opacity / 100;
    context.fillStyle = colour;
    context.strokeStyle = colour === 'white' ? 'black' : 'white';
    context.lineWidth = Math.max(1, fontSize / 16);
    context.lineJoin = 'round';

    if (position === 'tile') {
      const textWidth = context.measureText(text).width;
      // Cover the image's diagonal so the grid still fills every corner once
      // the canvas is rotated. Steps are bounded below by fontSize, which
      // bounds the loop at roughly (diagonal / fontSize)^2 draws.
      const reach = Math.hypot(width, height) / 2;
      const stepX = Math.max(fontSize, textWidth + fontSize * 2);
      const stepY = Math.max(fontSize, fontSize * 3);

      context.save();
      context.translate(width / 2, height / 2);
      context.rotate(TILE_RADIANS);
      context.textAlign = 'center';
      for (let y = -reach; y <= reach; y += stepY) {
        for (let x = -reach; x <= reach; x += stepX) {
          context.strokeText(text, x, y);
          context.fillText(text, x, y);
        }
      }
      context.restore();
    } else {
      const spot = anchor(position, width, height, margin, fontSize);
      context.textAlign = spot.align;
      context.strokeText(text, spot.x, spot.y);
      context.fillText(text, spot.x, spot.y);
    }

    const mime = outputMimeFor(input);
    const buffer = await encodeCanvas(
      canvas,
      mime,
      LOSSLESS_MIMES.includes(mime) ? undefined : quality / 100,
    );
    // A format canvas cannot encode (GIF, say) comes back as PNG — so the name
    // has to move with it rather than label PNG bytes `.gif`.
    const name = input.type === mime ? input.name : renameForMime(input.name, mime);
    outputs.push({ name, type: mime, buffer });

    done += 1;
    ctx.onProgress(done / inputs.length);
  }

  return outputs;
};

export default watermark;
