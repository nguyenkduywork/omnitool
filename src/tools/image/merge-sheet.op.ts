// src/tools/image/merge-sheet.op.ts — image-merge-sheet: arrange several
// images into one contact sheet, in tray (input) order.
//
// Output is always a flattened JPEG — a contact sheet is for viewing/sharing,
// and JPEG has no alpha channel to preserve anyway. That is exactly why the
// 'background' option matters: an unpainted OffscreenCanvas is transparent
// BLACK (0,0,0,0), and letting that show through convertToBlob's JPEG path
// drops the alpha and leaves literal black pixels behind. This op fills an
// explicit opaque colour BEFORE drawing anything, and 'transparent' maps to
// white for the same reason — there is no alpha channel in a JPEG to actually
// preserve, so leaving the canvas unpainted would just be the black bug by
// another name.

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

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

async function encodeCanvas(canvas: OffscreenCanvas, mime: string, quality: number): Promise<ArrayBuffer> {
  const blob = await canvas.convertToBlob({ type: mime, quality });
  if (blob.type !== mime) {
    throw new OpError(
      'EncoderUnavailable',
      `This browser's canvas encoder does not produce ${mime} — it returned ${blob.type || 'an empty type'} instead.`,
    );
  }
  return blob.arrayBuffer();
}

type Layout = 'grid' | 'row' | 'column';
const LAYOUTS: Layout[] = ['grid', 'row', 'column'];

type Background = 'white' | 'black' | 'transparent';
const BACKGROUNDS: Background[] = ['white', 'black', 'transparent'];

// JPEG output has no alpha channel: 'transparent' cannot mean "leave it
// transparent" here, only "don't force white/black" — and since the target
// format has no way to represent that, it falls back to white rather than
// letting the canvas's transparent-black default leak through as literal
// black pixels.
const BACKGROUND_FILL: Record<Background, string> = {
  white: '#ffffff',
  black: '#000000',
  transparent: '#ffffff',
};

function validateLayout(raw: unknown): Layout {
  const value = raw === undefined ? 'grid' : raw;
  if (typeof value !== 'string' || !LAYOUTS.includes(value as Layout)) {
    throw new OpError('InvalidOptions', `layout must be one of ${LAYOUTS.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return value as Layout;
}

function validateBackground(raw: unknown): Background {
  const value = raw === undefined ? 'white' : raw;
  if (typeof value !== 'string' || !BACKGROUNDS.includes(value as Background)) {
    throw new OpError('InvalidOptions', `background must be one of ${BACKGROUNDS.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return value as Background;
}

function validateInt(raw: unknown, def: number, min: number, max: number, label: string): number {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new OpError('InvalidOptions', `${label} must be a number between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

const mergeSheet: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Merge sheet needs at least one image.');
  }
  const layout = validateLayout(options.layout);
  const columnsOption = validateInt(options.columns, 3, 1, 12, 'columns');
  const gap = validateInt(options.gap, 8, 0, 64, 'gap');
  const background = validateBackground(options.background);

  stop(ctx.signal);

  const bitmaps: ImageBitmap[] = [];
  try {
    let decoded = 0;
    for (const input of inputs) {
      stop(ctx.signal);
      bitmaps.push(await decodeImage(input));
      decoded += 1;
      // Reserve the final slice of progress for compositing + encoding.
      ctx.onProgress(decoded / (inputs.length + 1));
    }
    stop(ctx.signal);

    const cols =
      layout === 'column' ? 1 : layout === 'row' ? bitmaps.length : Math.max(1, Math.min(columnsOption, bitmaps.length));
    const rows = Math.max(1, Math.ceil(bitmaps.length / cols));
    const cellWidth = Math.max(...bitmaps.map((b) => b.width));
    const cellHeight = Math.max(...bitmaps.map((b) => b.height));
    const canvasWidth = cols * cellWidth + (cols - 1) * gap;
    const canvasHeight = rows * cellHeight + (rows - 1) * gap;

    const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
    const context = canvas.getContext('2d');
    if (!context) {
      throw new OpError('EncoderUnavailable', 'Could not acquire a 2D canvas context.');
    }

    context.fillStyle = BACKGROUND_FILL[background];
    context.fillRect(0, 0, canvasWidth, canvasHeight);

    bitmaps.forEach((bitmap, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = col * (cellWidth + gap) + (cellWidth - bitmap.width) / 2;
      const y = row * (cellHeight + gap) + (cellHeight - bitmap.height) / 2;
      context.drawImage(bitmap, x, y);
    });

    stop(ctx.signal);
    const buffer = await encodeCanvas(canvas, 'image/jpeg', 0.92);
    ctx.onProgress(1);

    return [{ name: 'sheet.jpg', type: 'image/jpeg', buffer }];
  } finally {
    for (const bitmap of bitmaps) bitmap.close();
  }
};

export default mergeSheet;
