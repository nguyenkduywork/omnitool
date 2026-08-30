// tests/unit/image.browser.test.ts — tests for the image tools.
//
// Every image op needs OffscreenCanvas / createImageBitmap / convertToBlob,
// none of which exist under plain Node — so, per the *.browser.test.ts
// convention, this whole file (including the plain registry-metadata checks
// that don't strictly need a browser) runs in headless Chromium under
// vitest's 'browser' project.
//
// Every op gets the §2 four tests: happy path; invalid input raising the
// correct OpErrorCode; mid-run cancellation via AbortSignal; onProgress
// monotonic ending at exactly 1. Fixture dimensions (from
// tests/fixtures/make-fixtures.mjs): a.png 4x4, b.png 6x4, c.png 8x6,
// a.jpg 5x5, a.webp 6x4.

import { describe, expect, it } from 'vitest';

import { OpError, type OpContext, type OpInput, type OpOutput } from '../../src/types';

import convert, { canEncode } from '../../src/tools/image/convert.op';
import resize from '../../src/tools/image/resize.op';
import compress from '../../src/tools/image/compress.op';
import crop from '../../src/tools/image/crop.op';
import mergeSheet from '../../src/tools/image/merge-sheet.op';
import rotate from '../../src/tools/image/rotate.op';
import watermark from '../../src/tools/image/watermark.op';
import { renameForMime } from '../../src/tools/image/mime';
import editor from '../../src/tools/image/crop.editor';
import rotateEditor from '../../src/tools/image/rotate.editor';

import { IMAGE_TOOLS } from '../../src/core/registry.image';
import { IMAGE_LOADERS } from '../../src/core/workers/loaders.image';

// ---------------------------------------------------------------------------
// Fixture / assertion helpers
// ---------------------------------------------------------------------------

const fixtureCache = new Map<string, ArrayBuffer>();

async function fixtureBuffer(name: string): Promise<ArrayBuffer> {
  const cached = fixtureCache.get(name);
  if (cached) return cached.slice(0);
  const url = new URL(`../fixtures/${name}`, import.meta.url).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture ${name}: ${res.status}`);
  const buf = await res.arrayBuffer();
  fixtureCache.set(name, buf);
  return buf.slice(0);
}

/** A fresh OpInput each time — ops may consume/transfer the buffer. */
async function opInput(name: string, type: string): Promise<OpInput> {
  return { name, type, buffer: await fixtureBuffer(name) };
}

type Recorder = { ctx: OpContext; fractions: number[]; controller: AbortController };

function recorder(): Recorder {
  const controller = new AbortController();
  const fractions: number[] = [];
  const ctx: OpContext = {
    onProgress(fraction: number): void {
      fractions.push(fraction);
    },
    signal: controller.signal,
  };
  return { ctx, fractions, controller };
}

function expectMonotonicEndingAtOne(fractions: number[]): void {
  expect(fractions.length).toBeGreaterThan(0);
  for (const f of fractions) {
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThanOrEqual(1);
  }
  for (let i = 1; i < fractions.length; i++) {
    expect(fractions[i]).toBeGreaterThanOrEqual(fractions[i - 1] as number);
  }
  expect(fractions.at(-1)).toBe(1);
}

async function expectOpError(promise: Promise<unknown>, code: string, fileName?: string): Promise<OpError> {
  const err = await promise.then(
    () => {
      throw new Error('expected the op to reject, but it resolved');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OpError);
  expect((err as OpError).code).toBe(code);
  if (fileName !== undefined) expect((err as OpError).file).toBe(fileName);
  return err as OpError;
}

/** Decode an OpOutput and report its REAL dimensions — never trust the options passed in. */
async function decodeOutput(output: OpOutput): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([output.buffer], { type: output.type }));
  const dims = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dims;
}

/** Decode an OpOutput and sample one real pixel from it via getImageData. */
async function samplePixel(output: OpOutput, x: number, y: number): Promise<[number, number, number, number]> {
  const bitmap = await createImageBitmap(new Blob([output.buffer], { type: output.type }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const data = context.getImageData(x, y, 1, 1).data;
  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ---------------------------------------------------------------------------
// image-rotate
// ---------------------------------------------------------------------------

/**
 * A 4x2 PNG with a distinguishable corner: left half red, right half blue,
 * and a single green pixel at (0, 0). Every fixture on disk is a solid
 * colour, which cannot tell a rotation from a no-op.
 */
async function twoTone(name = 'two-tone.png'): Promise<OpInput> {
  const canvas = new OffscreenCanvas(4, 2);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.fillStyle = '#ff0000';
  context.fillRect(0, 0, 2, 2);
  context.fillStyle = '#0000ff';
  context.fillRect(2, 0, 2, 2);
  context.fillStyle = '#00ff00';
  context.fillRect(0, 0, 1, 1);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { name, type: 'image/png', buffer: await blob.arrayBuffer() };
}

const GREEN: [number, number, number, number] = [0, 255, 0, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];

describe('image-rotate', () => {
  it('turns the image a quarter clockwise, swapping its dimensions and moving the corner (happy path)', async () => {
    const { ctx } = recorder();
    const outputs = await rotate([await twoTone()], { angle: '90', flip: 'none' }, ctx);
    const output = outputs[0] as OpOutput;

    // A 4x2 source becomes 2x4 — a rotation that only re-encoded would not.
    expect(await decodeOutput(output)).toEqual({ width: 2, height: 4 });
    // Clockwise puts the source's top-left pixel at the top RIGHT.
    expect(await samplePixel(output, 1, 0)).toEqual(GREEN);
  });

  it('turns it the other way for 270, and end-over-end for 180', async () => {
    const { ctx } = recorder();
    const anticlockwise = await rotate([await twoTone()], { angle: '270' }, ctx);
    expect(await samplePixel(anticlockwise[0] as OpOutput, 0, 3)).toEqual(GREEN);

    const halfTurn = await rotate([await twoTone()], { angle: '180' }, recorder().ctx);
    expect(await decodeOutput(halfTurn[0] as OpOutput)).toEqual({ width: 4, height: 2 });
    expect(await samplePixel(halfTurn[0] as OpOutput, 3, 1)).toEqual(GREEN);
  });

  it('mirrors left-to-right without rotating', async () => {
    const { ctx } = recorder();
    const outputs = await rotate([await twoTone()], { angle: '0', flip: 'horizontal' }, ctx);
    const output = outputs[0] as OpOutput;

    expect(await decodeOutput(output)).toEqual({ width: 4, height: 2 });
    expect(await samplePixel(output, 3, 0)).toEqual(GREEN);
    // The red half is now on the right, so the left edge reads blue.
    expect(await samplePixel(output, 0, 1)).toEqual(BLUE);
  });

  it('mirrors first and then rotates, for a combination of the two', async () => {
    const { ctx } = recorder();
    const outputs = await rotate([await twoTone()], { angle: '90', flip: 'horizontal' }, ctx);
    // Mirroring moves the green pixel to the top-right; a quarter turn
    // clockwise then carries it to the bottom-right.
    expect(await samplePixel(outputs[0] as OpOutput, 1, 3)).toEqual(GREEN);
  });

  it('hands back the original bytes for no rotation and no mirror, rather than re-encoding', async () => {
    const input = await twoTone();
    const before = new Uint8Array(input.buffer.slice(0));
    const { ctx } = recorder();

    const outputs = await rotate([input], { angle: '0', flip: 'none' }, ctx);

    expect(new Uint8Array((outputs[0] as OpOutput).buffer)).toEqual(before);
  });

  it('rejects an angle that is not a quarter turn with InvalidOptions', async () => {
    const { ctx } = recorder();
    await expectOpError(rotate([await twoTone()], { angle: '45' }, ctx), 'InvalidOptions');
    await expectOpError(rotate([await twoTone()], { flip: 'diagonal' }, recorder().ctx), 'InvalidOptions');
  });

  it('raises UnsupportedFormat naming the file for a non-image input, never crashing', async () => {
    const input = await opInput('corrupt.pdf', 'application/pdf');
    const { ctx } = recorder();
    await expectOpError(rotate([input], { angle: '90' }, ctx), 'UnsupportedFormat', 'corrupt.pdf');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const { ctx, controller } = recorder();
    const promise = rotate([await twoTone(), await twoTone('second.png')], { angle: '90' }, ctx);
    controller.abort();
    await expectOpError(promise, 'Cancelled');
  });

  it('reports monotonic progress ending at exactly 1', async () => {
    const { ctx, fractions } = recorder();
    await rotate([await twoTone(), await twoTone('second.png')], { angle: '90' }, ctx);
    expectMonotonicEndingAtOne(fractions);
  });
});

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

describe('image registry entries', () => {
  const expected = [
    'image-convert',
    'image-resize',
    'image-compress',
    'image-crop',
    'image-merge-sheet',
    'image-rotate',
    'image-strip-metadata',
    'image-watermark',
  ];

  it('registers every image tool with a matching loader entry', () => {
    const ids = IMAGE_TOOLS.map((tool) => tool.id);
    for (const id of expected) {
      expect(ids).toContain(id);
      expect(IMAGE_LOADERS[id]).toBeTypeOf('function');
    }
  });

  it('uses exactly the option schemas the plan specifies', () => {
    const byId = new Map(IMAGE_TOOLS.map((tool) => [tool.id, tool]));

    expect(byId.get('image-convert')?.options).toEqual({
      format: {
        kind: 'select',
        label: 'Format',
        choices: [
          { value: 'png', label: 'PNG' },
          { value: 'jpeg', label: 'JPEG' },
          { value: 'webp', label: 'WebP' },
          { value: 'avif', label: 'AVIF' },
        ],
        default: 'webp',
      },
      quality: { kind: 'range', label: 'Quality', min: 10, max: 100, step: 5, default: 85 },
    });

    expect(byId.get('image-resize')?.options).toEqual({
      mode: {
        kind: 'select',
        label: 'Resize by',
        choices: [
          { value: 'dimensions', label: 'Dimensions' },
          { value: 'percent', label: 'Percent' },
        ],
        default: 'dimensions',
      },
      width: { kind: 'number', label: 'Width (px)', min: 1, max: 20000, step: 1, default: 1920 },
      height: { kind: 'number', label: 'Height (px)', min: 1, max: 20000, step: 1, default: 1080 },
      percent: { kind: 'range', label: 'Percent', min: 5, max: 200, step: 5, default: 50 },
      lockAspect: { kind: 'toggle', label: 'Lock aspect ratio', default: true },
    });

    expect(byId.get('image-compress')?.options).toEqual({
      quality: { kind: 'range', label: 'Quality', min: 10, max: 100, step: 5, default: 75 },
    });

    expect(byId.get('image-crop')?.options).toBeUndefined();
    expect(byId.get('image-crop')?.editor).toBeTypeOf('function');
    expect(byId.get('image-crop')?.minInputs).toBe(1);
    expect(byId.get('image-crop')?.maxInputs).toBe(1);

    // image-rotate keeps its declarative schema — it is what the op's defaults
    // come from, and the fallback if the editor chunk ever fails to load — AND
    // gains the preview editor that supersedes it in the UI. Losing either half
    // is a silent regression: the schema alone means no preview, the editor
    // alone means no fallback.
    expect(byId.get('image-rotate')?.editor).toBeTypeOf('function');
    expect(byId.get('image-rotate')?.options).toEqual({
      angle: {
        kind: 'select',
        label: 'Rotate',
        choices: [
          { value: '90', label: '90° clockwise' },
          { value: '180', label: '180°' },
          { value: '270', label: '90° anticlockwise' },
          { value: '0', label: 'No rotation' },
        ],
        default: '90',
      },
      flip: {
        kind: 'select',
        label: 'Mirror',
        choices: [
          { value: 'none', label: 'No mirror' },
          { value: 'horizontal', label: 'Left to right' },
          { value: 'vertical', label: 'Top to bottom' },
        ],
        default: 'none',
      },
      quality: { kind: 'range', label: 'Re-encode quality', min: 10, max: 100, step: 5, default: 92 },
    });

    expect(byId.get('image-watermark')?.options?.['text']).toEqual({
      kind: 'text',
      label: 'Text',
      placeholder: 'CONFIDENTIAL',
      default: 'CONFIDENTIAL',
    });
    expect(byId.get('image-watermark')?.options?.['position']).toMatchObject({
      kind: 'select',
      default: 'bottom-right',
    });
    expect(byId.get('image-watermark')?.options?.['size']).toEqual({
      kind: 'range',
      label: 'Text size (%)',
      min: 1,
      max: 25,
      step: 1,
      default: 6,
    });
    expect(byId.get('image-watermark')?.options?.['opacity']).toMatchObject({
      kind: 'range',
      default: 35,
    });
    expect(byId.get('image-watermark')?.options?.['colour']).toMatchObject({
      kind: 'select',
      default: 'white',
    });
    expect(byId.get('image-watermark')?.options?.['quality']).toMatchObject({
      kind: 'range',
      default: 92,
    });
    expect(byId.get('image-watermark')?.accepts).toEqual(['image/*']);

    expect(byId.get('image-merge-sheet')?.options).toEqual({
      layout: {
        kind: 'select',
        label: 'Layout',
        choices: [
          { value: 'grid', label: 'Grid' },
          { value: 'row', label: 'Single row' },
          { value: 'column', label: 'Single column' },
        ],
        default: 'grid',
      },
      columns: { kind: 'number', label: 'Columns', min: 1, max: 12, step: 1, default: 3 },
      gap: { kind: 'number', label: 'Gap (px)', min: 0, max: 64, step: 1, default: 8 },
      background: {
        kind: 'select',
        label: 'Background',
        choices: [
          { value: 'white', label: 'White' },
          { value: 'black', label: 'Black' },
          { value: 'transparent', label: 'Transparent' },
        ],
        default: 'white',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// canEncode — the encoder probe
// ---------------------------------------------------------------------------

describe('canEncode', () => {
  it('reports the REAL encoder support of this environment, not the schema\'s wishlist', async () => {
    const results = {
      png: await canEncode('image/png'),
      jpeg: await canEncode('image/jpeg'),
      webp: await canEncode('image/webp'),
      avif: await canEncode('image/avif'),
    };
    expect(results.png).toBe(true);
    expect(results.jpeg).toBe(true);
    expect(results.webp).toBe(true);
    // Measured 2026-08-29 on Chrome for Testing 151 (headless): canvas AVIF
    // ENCODING silently falls back to PNG — canEncode must report that
    // truthfully as `false` rather than trusting the mime that was asked for.
    expect(results.avif).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// image-convert
// ---------------------------------------------------------------------------

describe('image-convert', () => {
  it('converts a PNG to WebP with the real output mime and dimensions (happy path)', async () => {
    const input = await opInput('a.png', 'image/png'); // 4x4
    const { ctx } = recorder();
    const outputs = await convert([input], { format: 'webp', quality: 85 }, ctx);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.type).toBe('image/webp');
    expect(outputs[0]?.name).toBe('a.webp');
    expect(await decodeOutput(outputs[0] as OpOutput)).toEqual({ width: 4, height: 4 });
  });

  it('rejects an unknown format with InvalidOptions', async () => {
    const input = await opInput('a.png', 'image/png');
    const { ctx } = recorder();
    await expectOpError(convert([input], { format: 'bmp' }, ctx), 'InvalidOptions');
  });

  it('raises EncoderUnavailable for AVIF instead of silently returning a PNG labelled .avif', async () => {
    const input = await opInput('a.png', 'image/png');
    const { ctx } = recorder();
    const err = await expectOpError(convert([input], { format: 'avif', quality: 85 }, ctx), 'EncoderUnavailable');
    expect(err.message).toMatch(/avif/i);
  });

  it('raises UnsupportedFormat naming the file for a non-image input, never crashing', async () => {
    const input = await opInput('corrupt.pdf', 'application/pdf');
    const { ctx } = recorder();
    await expectOpError(convert([input], { format: 'png' }, ctx), 'UnsupportedFormat', 'corrupt.pdf');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const input = await opInput('a.png', 'image/png');
    const { ctx, controller } = recorder();
    const promise = convert([input], { format: 'webp', quality: 85 }, ctx);
    controller.abort();
    await expectOpError(promise, 'Cancelled');
  });

  it('reports monotonic progress ending at exactly 1', async () => {
    const inputs = [await opInput('a.png', 'image/png'), await opInput('b.png', 'image/png')];
    const { ctx, fractions } = recorder();
    await convert(inputs, { format: 'png', quality: 85 }, ctx);
    expectMonotonicEndingAtOne(fractions);
  });
});

// ---------------------------------------------------------------------------
// image-resize
// ---------------------------------------------------------------------------

describe('image-resize', () => {
  it('preserves aspect ratio under lockAspect by fitting inside the box — verified against the real decoded output (happy path)', async () => {
    const input = await opInput('b.png', 'image/png'); // 6x4, aspect 1.5
    const { ctx } = recorder();
    const outputs = await resize(
      [input],
      { mode: 'dimensions', width: 12, height: 12, percent: 50, lockAspect: true },
      ctx,
    );
    const dims = await decodeOutput(outputs[0] as OpOutput);
    // A stretch-to-box bug would give 12x12 (aspect 1:1, WRONG). Fitting a
    // 6x4 (1.5:1) source uniformly inside a 12x12 box gives 12x8.
    expect(dims).toEqual({ width: 12, height: 8 });
    expect(dims.width / dims.height).toBeCloseTo(6 / 4, 5);
  });

  it('scales both axes uniformly in percent mode', async () => {
    const input = await opInput('c.png', 'image/png'); // 8x6
    const { ctx } = recorder();
    const outputs = await resize(
      [input],
      { mode: 'percent', percent: 50, width: 1920, height: 1080, lockAspect: true },
      ctx,
    );
    expect(await decodeOutput(outputs[0] as OpOutput)).toEqual({ width: 4, height: 3 });
  });

  it('rejects an out-of-range percent with InvalidOptions', async () => {
    const input = await opInput('a.png', 'image/png');
    const { ctx } = recorder();
    await expectOpError(resize([input], { mode: 'percent', percent: 500 }, ctx), 'InvalidOptions');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const input = await opInput('a.png', 'image/png');
    const { ctx, controller } = recorder();
    const promise = resize([input], { mode: 'dimensions', width: 10, height: 10, lockAspect: true }, ctx);
    controller.abort();
    await expectOpError(promise, 'Cancelled');
  });

  it('reports monotonic progress ending at exactly 1', async () => {
    const inputs = [await opInput('a.png', 'image/png'), await opInput('b.png', 'image/png')];
    const { ctx, fractions } = recorder();
    await resize(inputs, { mode: 'percent', percent: 50 }, ctx);
    expectMonotonicEndingAtOne(fractions);
  });
});

// ---------------------------------------------------------------------------
// image-compress
// ---------------------------------------------------------------------------

describe('image-compress', () => {
  it('re-encodes and returns a real, decodable image at the same dimensions (happy path)', async () => {
    const input = await opInput('a.jpg', 'image/jpeg'); // 5x5
    const { ctx } = recorder();
    const outputs = await compress([input], { quality: 40 }, ctx);
    expect(outputs[0]?.type).toBe('image/jpeg');
    expect(await decodeOutput(outputs[0] as OpOutput)).toEqual({ width: 5, height: 5 });
  });

  it('never claims a reduction it did not achieve — output never exceeds the original', async () => {
    const input = await opInput('a.jpg', 'image/jpeg');
    const { ctx } = recorder();
    const outputs = await compress([input], { quality: 100 }, ctx);
    expect(outputs[0]?.buffer.byteLength).toBeLessThanOrEqual(input.buffer.byteLength);
  });

  it('rejects an out-of-range quality with InvalidOptions', async () => {
    const input = await opInput('a.jpg', 'image/jpeg');
    const { ctx } = recorder();
    await expectOpError(compress([input], { quality: 5 }, ctx), 'InvalidOptions');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const input = await opInput('a.jpg', 'image/jpeg');
    const { ctx, controller } = recorder();
    const promise = compress([input], { quality: 50 }, ctx);
    controller.abort();
    await expectOpError(promise, 'Cancelled');
  });

  it('reports monotonic progress ending at exactly 1', async () => {
    const inputs = [await opInput('a.jpg', 'image/jpeg'), await opInput('a.webp', 'image/webp')];
    const { ctx, fractions } = recorder();
    await compress(inputs, { quality: 50 }, ctx);
    expectMonotonicEndingAtOne(fractions);
  });
});

// ---------------------------------------------------------------------------
// image-crop
// ---------------------------------------------------------------------------

describe('image-crop', () => {
  it('clamps a rect exceeding the source bounds instead of padding it with transparency (happy path)', async () => {
    // a.png is a solid, fully-opaque 4x4 red fixture (220,40,40).
    const input = await opInput('a.png', 'image/png');
    const { ctx } = recorder();
    const outputs = await crop([input], { x: 2, y: 2, width: 100, height: 100 }, ctx);

    // Clamped to the 2x2 area actually inside the 4x4 source — never padded
    // out to the requested 100x100.
    expect(await decodeOutput(outputs[0] as OpOutput)).toEqual({ width: 2, height: 2 });

    const [r, g, b, a] = await samplePixel(outputs[0] as OpOutput, 0, 0);
    // Every pixel of the clamped crop must be REAL, fully-opaque source
    // colour — never a transparent padding pixel a "pad to the requested
    // size" bug would introduce.
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(150);
    expect(g).toBeLessThan(100);
    expect(b).toBeLessThan(100);
  });

  it('rejects a zero-area rect with InvalidOptions', async () => {
    const input = await opInput('a.png', 'image/png');
    const { ctx } = recorder();
    await expectOpError(crop([input], { x: 0, y: 0, width: 0, height: 4 }, ctx), 'InvalidOptions');
  });

  it('rejects a negative-area rect with InvalidOptions', async () => {
    const input = await opInput('a.png', 'image/png');
    const { ctx } = recorder();
    await expectOpError(crop([input], { x: 0, y: 0, width: -5, height: 4 }, ctx), 'InvalidOptions');
  });

  it('raises UnsupportedFormat naming the file for a non-image input, never crashing', async () => {
    const input = await opInput('corrupt.pdf', 'application/pdf');
    const { ctx } = recorder();
    await expectOpError(crop([input], { x: 0, y: 0, width: 1, height: 1 }, ctx), 'UnsupportedFormat', 'corrupt.pdf');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const input = await opInput('a.png', 'image/png');
    const { ctx, controller } = recorder();
    const promise = crop([input], { x: 0, y: 0, width: 2, height: 2 }, ctx);
    controller.abort();
    await expectOpError(promise, 'Cancelled');
  });

  it('reports monotonic progress ending at exactly 1', async () => {
    const input = await opInput('c.png', 'image/png');
    const { ctx, fractions } = recorder();
    await crop([input], { x: 0, y: 0, width: 4, height: 4 }, ctx);
    expectMonotonicEndingAtOne(fractions);
  });
});

// ---------------------------------------------------------------------------
// image-merge-sheet
// ---------------------------------------------------------------------------

describe('image-merge-sheet', () => {
  it('fills an opaque background as WHITE for its JPEG output, never black (happy path + pixel proof)', async () => {
    const inputs = [await opInput('a.png', 'image/png'), await opInput('b.png', 'image/png')]; // 4x4, 6x4
    const { ctx } = recorder();
    const outputs = await mergeSheet(inputs, { layout: 'row', columns: 3, gap: 20, background: 'white' }, ctx);

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.type).toBe('image/jpeg');
    expect(outputs[0]?.name).toBe('sheet.jpg');

    // Row layout, 2 images: cellWidth = max(4,6) = 6, cellHeight = max(4,4) = 4.
    // canvas width = 2*6 + 1*20 = 32, height = 4.
    expect(await decodeOutput(outputs[0] as OpOutput)).toEqual({ width: 32, height: 4 });

    // (15,2) sits squarely inside the 20px gap strip between the two cells
    // (cell 0's image spans x in [1,5), cell 1's spans x in [26,32)) — nothing
    // is drawn there, so this pixel is pure background fill.
    const [r, g, b] = await samplePixel(outputs[0] as OpOutput, 15, 2);
    // The bug this op exists to prevent: an unpainted OffscreenCanvas is
    // transparent BLACK, and letting that leak into a JPEG (no alpha channel)
    // leaves literal (0,0,0) behind. A real threshold is what actually proves
    // "white, not black" — JPEG's own DCT quantisation is the only reason
    // this isn't exactly 255.
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
  });

  it("actually preserves alpha for background:'transparent' by switching to PNG", async () => {
    const inputs = [await opInput('a.png', 'image/png'), await opInput('b.png', 'image/png')]; // 4x4, 6x4
    const { ctx } = recorder();
    const outputs = await mergeSheet(inputs, { layout: 'row', columns: 3, gap: 20, background: 'transparent' }, ctx);

    // JPEG has no alpha channel, so a transparent sheet MUST NOT be JPEG —
    // encoding it as one would silently flatten the transparency requested.
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.type).toBe('image/png');
    expect(outputs[0]?.name).toBe('sheet.png');
    expect(await decodeOutput(outputs[0] as OpOutput)).toEqual({ width: 32, height: 4 });

    // Same gap pixel as the opaque case. Here nothing was ever painted, so it
    // must still be fully transparent. Before this fix 'transparent' mapped to
    // '#ffffff' and emitted a JPEG, making it byte-identical to 'white' — the
    // option existed but did nothing. Asserting alpha === 0 is what pins that
    // down; the colour channels are irrelevant when alpha is 0.
    const [, , , alpha] = await samplePixel(outputs[0] as OpOutput, 15, 2);
    expect(alpha).toBe(0);
  });

  it("does not produce identical output for 'transparent' and 'white'", async () => {
    const opts = { layout: 'row', columns: 3, gap: 20 };
    const mk = async (background: string): Promise<OpOutput> => {
      const inputs = [await opInput('a.png', 'image/png'), await opInput('b.png', 'image/png')];
      const { ctx } = recorder();
      const outputs = await mergeSheet(inputs, { ...opts, background }, ctx);
      return outputs[0] as OpOutput;
    };
    const [transparent, white] = [await mk('transparent'), await mk('white')];

    // The regression guard: these two options must be distinguishable.
    expect(transparent.type).not.toBe(white.type);
    expect(new Uint8Array(transparent.buffer)).not.toEqual(new Uint8Array(white.buffer));
  });

  it('uses tray order and composites real image content, not just a solid fill', async () => {
    const inputs = [await opInput('a.png', 'image/png'), await opInput('c.png', 'image/png')]; // red 4x4, blue 8x6
    const { ctx } = recorder();
    const outputs = await mergeSheet(inputs, { layout: 'row', columns: 2, gap: 0, background: 'white' }, ctx);

    // cellWidth = max(4,8) = 8, cellHeight = max(4,6) = 6. a.png (index 0)
    // is centred in its cell: offset x=(8-4)/2=2, y=(6-4)/2=1, spanning
    // x in [2,6), y in [1,5).
    const [r, g] = await samplePixel(outputs[0] as OpOutput, 4, 3);
    expect(r).toBeGreaterThan(150); // a.png is red-dominant (220,40,40)
    expect(g).toBeLessThan(120); // rules out both white background and c.png's blue (40,80,220)
  });

  it('rejects an unknown layout with InvalidOptions', async () => {
    const inputs = [await opInput('a.png', 'image/png'), await opInput('b.png', 'image/png')];
    const { ctx } = recorder();
    await expectOpError(mergeSheet(inputs, { layout: 'diagonal' }, ctx), 'InvalidOptions');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const inputs = [await opInput('a.png', 'image/png'), await opInput('b.png', 'image/png')];
    const { ctx, controller } = recorder();
    const promise = mergeSheet(inputs, { layout: 'grid', columns: 2, gap: 8, background: 'white' }, ctx);
    controller.abort();
    await expectOpError(promise, 'Cancelled');
  });

  it('reports monotonic progress ending at exactly 1', async () => {
    const inputs = [await opInput('a.png', 'image/png'), await opInput('b.png', 'image/png'), await opInput('c.png', 'image/png')];
    const { ctx, fractions } = recorder();
    await mergeSheet(inputs, { layout: 'grid', columns: 2, gap: 8, background: 'white' }, ctx);
    expectMonotonicEndingAtOne(fractions);
  });
});

// ---------------------------------------------------------------------------
// crop.editor — SOURCE-pixel coordinates, draggable rect, aspect presets
// ---------------------------------------------------------------------------

describe('crop.editor', () => {
  it('emits a crop rect in SOURCE pixels, correctly divided out of a deliberately mismatched CSS display size', async () => {
    const buf = await fixtureBuffer('c.png'); // 8x6 natural size
    const file = new File([buf], 'c.png', { type: 'image/png' });

    const mount = document.createElement('div');
    mount.style.width = '400px'; // 50x the natural width — proves the conversion isn't 1:1
    document.body.appendChild(mount);

    const events: Array<{ x: number; y: number; width: number; height: number }> = [];
    const teardown = editor(mount, [file], (opts) => {
      events.push(opts as { x: number; y: number; width: number; height: number });
    });

    try {
      await waitFor(() => events.length > 0); // the initial default-rect emission proves load finished

      const canvas = mount.querySelector('canvas');
      expect(canvas).not.toBeNull();
      const box = (canvas as HTMLCanvasElement).getBoundingClientRect();
      // 8x6 natural, forced to 400 CSS px wide -> height:auto keeps the 4:3 ratio.
      expect(box.width).toBeCloseTo(400, 0);
      expect(box.height).toBeCloseTo(300, 0);

      events.length = 0; // isolate the drag's own emission(s)

      (canvas as HTMLCanvasElement).dispatchEvent(
        new PointerEvent('pointerdown', { clientX: box.left, clientY: box.top, pointerId: 7, bubbles: true }),
      );
      (canvas as HTMLCanvasElement).dispatchEvent(
        new PointerEvent('pointermove', { clientX: box.left + 200, clientY: box.top + 100, pointerId: 7, bubbles: true }),
      );

      expect(events.length).toBeGreaterThan(0);
      const last = events[events.length - 1] as { x: number; y: number; width: number; height: number };
      // Scale is 400/8 = 50 on both axes. 200 CSS px / 50 = 4 SOURCE px;
      // 100 CSS px / 50 = 2 SOURCE px. A bug that emitted raw CSS pixels
      // (clamped to the 8x6 source bounds) would report width 8, height 6
      // here instead — a plausible-looking but wrong answer this catches.
      expect(last).toEqual({ x: 0, y: 0, width: 4, height: 2 });

      (canvas as HTMLCanvasElement).dispatchEvent(
        new PointerEvent('pointerup', { clientX: box.left + 200, clientY: box.top + 100, pointerId: 7, bubbles: true }),
      );
    } finally {
      teardown();
      mount.remove();
    }
  });

  it('applies an aspect preset by recomputing height from the current width, in source pixels', async () => {
    const buf = await fixtureBuffer('c.png'); // 8x6
    const file = new File([buf], 'c.png', { type: 'image/png' });
    const mount = document.createElement('div');
    mount.style.width = '400px';
    document.body.appendChild(mount);

    const events: Array<{ x: number; y: number; width: number; height: number }> = [];
    const teardown = editor(mount, [file], (opts) => {
      events.push(opts as { x: number; y: number; width: number; height: number });
    });
    try {
      await waitFor(() => events.length > 0);
      events.length = 0;

      const squareButton = Array.from(mount.querySelectorAll('button')).find((b) => b.textContent === '1:1');
      expect(squareButton).toBeDefined();
      squareButton?.click();

      expect(events.length).toBeGreaterThan(0);
      const last = events[events.length - 1] as { x: number; y: number; width: number; height: number };
      expect(last.width).toBe(last.height);
      // Still SOURCE pixels within the 8x6 image, not CSS pixels.
      expect(last.width).toBeLessThanOrEqual(8);
      expect(last.height).toBeLessThanOrEqual(6);
    } finally {
      teardown();
      mount.remove();
    }
  });

  it('teardown removes all listeners and clears the mount', async () => {
    const buf = await fixtureBuffer('a.png');
    const file = new File([buf], 'a.png', { type: 'image/png' });
    const mount = document.createElement('div');
    mount.style.width = '200px';
    document.body.appendChild(mount);

    const events: unknown[] = [];
    const teardown = editor(mount, [file], (opts) => events.push(opts));
    try {
      await waitFor(() => events.length > 0);

      teardown();
      expect(mount.childElementCount).toBe(0);

      const countBefore = events.length;
      mount.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, clientY: 0, pointerId: 9, bubbles: true }));
      mount.dispatchEvent(new PointerEvent('pointermove', { clientX: 50, clientY: 50, pointerId: 9, bubbles: true }));
      expect(events.length).toBe(countBefore);
    } finally {
      mount.remove();
    }
  });
});

// ---------------------------------------------------------------------------
// rotate.editor — a preview that must not lie about orientation
// ---------------------------------------------------------------------------

/** The two-tone OpInput as a File, which is what a ToolEditor is handed. */
async function twoToneFile(name = 'two-tone.png', type = 'image/png'): Promise<File> {
  const input = await twoTone(name);
  return new File([input.buffer], name, { type });
}

/** Read one real pixel out of the editor's preview canvas. */
function canvasPixel(canvas: HTMLCanvasElement, x: number, y: number): [number, number, number, number] {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  const data = context.getImageData(x, y, 1, 1).data;
  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0, data[3] ?? 0];
}

type MountedEditor = {
  mount: HTMLElement;
  canvas: HTMLCanvasElement;
  events: Record<string, unknown>[];
  teardown: () => void;
};

/** Mount the editor and wait until the image has been decoded and drawn. */
async function mountRotateEditor(files: File[]): Promise<MountedEditor> {
  const mount = document.createElement('div');
  mount.style.width = '400px';
  document.body.appendChild(mount);

  const events: Record<string, unknown>[] = [];
  const teardown = rotateEditor(mount, files, (opts) => events.push(opts));

  // The stage stays hidden until a bitmap exists, so un-hiding it is the
  // editor's own "the preview is real now" signal — not an arbitrary wait.
  const stage = mount.querySelector('.rot__stage') as HTMLElement | null;
  await waitFor(() => stage !== null && !stage.hidden);

  return { mount, canvas: mount.querySelector('canvas') as HTMLCanvasElement, events, teardown };
}

function segButton(mount: HTMLElement, label: string): HTMLButtonElement {
  const button = mount.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`no segmented button labelled ${label}`);
  return button as HTMLButtonElement;
}

function qualityRow(mount: HTMLElement): HTMLElement {
  const row = mount.querySelector('input[type="range"]')?.closest('.rot__row');
  if (!row) throw new Error('no quality row');
  return row as HTMLElement;
}

describe('rotate.editor', () => {
  it('previews the same pixels the op produces, for the same options', async () => {
    const { mount, canvas, teardown } = await mountRotateEditor([await twoToneFile()]);

    try {
      // The default is 90° clockwise: a 4x2 source previews as 2x4, exactly as
      // the op's own output decodes (see the image-rotate happy path above).
      expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 2, height: 4 });

      const output = (await rotate([await twoTone()], { angle: '90', flip: 'none' }, recorder().ctx))[0] as OpOutput;
      expect(await decodeOutput(output)).toEqual({ width: canvas.width, height: canvas.height });
      // The corner pixel is the whole point: it is what distinguishes a real
      // rotation from a re-encode, and clockwise from anticlockwise.
      expect(canvasPixel(canvas, 1, 0)).toEqual(await samplePixel(output, 1, 0));
      expect(canvasPixel(canvas, 1, 0)).toEqual(GREEN);
    } finally {
      teardown();
      mount.remove();
    }
  });

  it("composes mirror-then-rotate in the op's order, not the reverse", async () => {
    const { mount, canvas, teardown } = await mountRotateEditor([await twoToneFile()]);

    try {
      segButton(mount, 'Left to right').click(); // with the default 90° still selected

      const output = (await rotate([await twoTone()], { angle: '90', flip: 'horizontal' }, recorder().ctx))[0] as OpOutput;
      // Mirror-then-rotate carries the green corner to the BOTTOM-right (1, 3).
      // Rotate-then-mirror — the plausible wrong order — would land it at the
      // top-right (1, 0) instead. This pixel is what proves the preview is
      // honest about a combination two dropdowns could never have shown.
      expect(canvasPixel(canvas, 1, 3)).toEqual(await samplePixel(output, 1, 3));
      expect(canvasPixel(canvas, 1, 3)).toEqual(GREEN);
      expect(canvasPixel(canvas, 1, 0)).not.toEqual(GREEN);
    } finally {
      teardown();
      mount.remove();
    }
  });

  it('redraws for every turn, swapping the dimensions on a quarter turn only', async () => {
    const { mount, canvas, teardown } = await mountRotateEditor([await twoToneFile()]);

    try {
      segButton(mount, '180°').click();
      expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 4, height: 2 });
      expect(canvasPixel(canvas, 3, 1)).toEqual(GREEN); // end over end

      segButton(mount, '90° anticlockwise').click();
      expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 2, height: 4 });
      expect(canvasPixel(canvas, 0, 3)).toEqual(GREEN);

      segButton(mount, 'No rotation').click();
      expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 4, height: 2 });
      expect(canvasPixel(canvas, 0, 0)).toEqual(GREEN);
    } finally {
      teardown();
      mount.remove();
    }
  });

  it('emits the option names, values and TYPES the op validates', async () => {
    const { mount, events, teardown } = await mountRotateEditor([await twoToneFile()]);

    try {
      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1]).toEqual({ angle: '90', flip: 'none', quality: 92 });

      segButton(mount, '180°').click();
      segButton(mount, 'Top to bottom').click();
      const last = events[events.length - 1] as Record<string, unknown>;
      // A string, because that is what the schema's `select` emits and what
      // rotate.op.ts's validator is written against.
      expect(last['angle']).toBe('180');
      expect(last['flip']).toBe('vertical');
      expect(typeof last['quality']).toBe('number');

      // And those emitted options really do drive the op: no rejection, and
      // the dimensions the summary promised.
      const outputs = await rotate([await twoTone()], last, recorder().ctx);
      expect(await decodeOutput(outputs[0] as OpOutput)).toEqual({ width: 4, height: 2 });
    } finally {
      teardown();
      mount.remove();
    }
  });

  it('drives its own no-op selection through the real op as a byte-identical passthrough', async () => {
    const input = await twoTone();
    const file = new File([input.buffer.slice(0)], input.name, { type: input.type });
    const { mount, events, teardown } = await mountRotateEditor([file]);

    try {
      // The default flip is already 'none'; clicking it anyway makes the
      // no-op selection explicit rather than relying on the initial state.
      segButton(mount, 'No rotation').click();
      segButton(mount, 'No mirror').click();
      const last = events[events.length - 1] as Record<string, unknown>;

      const outputs = await rotate([input], last, recorder().ctx);
      const output = outputs[0] as OpOutput;
      // Not just "no rejection" — the editor's OWN emitted no-op selection
      // must reach the op's passthrough branch, byte for byte.
      expect(new Uint8Array(output.buffer)).toEqual(new Uint8Array(input.buffer));
    } finally {
      teardown();
      mount.remove();
    }
  });

  it('shows the quality slider only when the run re-encodes something lossy', async () => {
    const jpeg = new File([await fixtureBuffer('a.jpg')], 'a.jpg', { type: 'image/jpeg' });
    const { mount, teardown } = await mountRotateEditor([jpeg]);

    try {
      expect(qualityRow(mount).hidden).toBe(false);
      // A passthrough run never reaches an encoder, so the slider would be a
      // knob that changes nothing.
      segButton(mount, 'No rotation').click();
      expect(qualityRow(mount).hidden).toBe(true);
      expect(mount.textContent).toContain('handed back untouched');
    } finally {
      teardown();
      mount.remove();
    }
  });

  it('hides the quality slider for PNG, which ignores it, and says why', async () => {
    const { mount, teardown } = await mountRotateEditor([await twoToneFile()]);

    try {
      expect(qualityRow(mount).hidden).toBe(true);
      expect(mount.textContent).toContain('PNG is lossless');
    } finally {
      teardown();
      mount.remove();
    }
  });

  it('names the previewed file and the batch it stands for when several are dropped', async () => {
    const files = [
      await twoToneFile('first.png'),
      await twoToneFile('second.png'),
      await twoToneFile('third.png'),
    ];
    const { mount, teardown } = await mountRotateEditor(files);

    try {
      const summary = mount.querySelector('.rot__summary') as HTMLElement;
      expect(summary.textContent).toContain('first.png');
      expect(summary.textContent).toContain('all 3 images');
      // Source and result dimensions, in the SOURCE's own pixels — never the
      // preview bitmap's, which is capped.
      expect(summary.textContent).toContain('4 × 2 px');
      expect(summary.textContent).toContain('2 × 4 px');
    } finally {
      teardown();
      mount.remove();
    }
  });

  it('reports an unreadable file in the panel rather than throwing', async () => {
    const notAnImage = new File([await fixtureBuffer('corrupt.pdf')], 'corrupt.pdf', {
      type: 'application/pdf',
    });
    const mount = document.createElement('div');
    document.body.appendChild(mount);
    const teardown = rotateEditor(mount, [notAnImage], () => {});

    try {
      await waitFor(() => (mount.textContent ?? '').includes('could not be read'));
      expect(mount.textContent).toContain('corrupt.pdf');
      expect((mount.querySelector('.rot__stage') as HTMLElement).hidden).toBe(true);
    } finally {
      teardown();
      mount.remove();
    }
  });

  it('teardown clears the mount and stops further emissions', async () => {
    const { mount, events, teardown } = await mountRotateEditor([await twoToneFile()]);
    const buttons = Array.from(mount.querySelectorAll('button'));

    teardown();
    expect(mount.childElementCount).toBe(0);

    const countBefore = events.length;
    for (const button of buttons) button.click(); // detached, but still live objects
    expect(events.length).toBe(countBefore);
    mount.remove();
  });
});

// ---------------------------------------------------------------------------
// image-watermark
//
// Asserted on REAL PIXELS, never on "the op returned something": a watermark
// that renders nothing at all would still produce a valid, correctly sized
// image, so every test here decodes the output and looks at it.
// ---------------------------------------------------------------------------

/** The flat grey every watermark fixture starts as, so any mark stands out. */
const BACKGROUND = 0x80;

/** A solid grey image, big enough for text to actually land on. */
async function plain(
  name = 'plain.png',
  type = 'image/png',
  width = 240,
  height = 160,
): Promise<OpInput> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.fillStyle = '#808080';
  context.fillRect(0, 0, width, height);
  const blob = await canvas.convertToBlob({ type });
  return { name, type, buffer: await blob.arrayBuffer() };
}

type Box = { x: number; y: number; width: number; height: number };

/**
 * How much of `box` is no longer the flat background: `count` is the number of
 * pixels that moved, `peak` the largest single deviation. The tolerance keeps
 * JPEG's ringing from counting as ink.
 */
async function inkIn(output: OpOutput, box: Box, tolerance = 12): Promise<{ count: number; peak: number }> {
  const bitmap = await createImageBitmap(new Blob([output.buffer], { type: output.type }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('no 2d context');
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const { data } = context.getImageData(box.x, box.y, box.width, box.height);
  let count = 0;
  let peak = 0;
  for (let i = 0; i < data.length; i += 4) {
    const deviation = Math.abs((data[i] ?? 0) - BACKGROUND);
    if (deviation > tolerance) count += 1;
    if (deviation > peak) peak = deviation;
  }
  return { count, peak };
}

const TOP_LEFT: Box = { x: 0, y: 0, width: 120, height: 80 };
const BOTTOM_RIGHT: Box = { x: 120, y: 80, width: 120, height: 80 };
const TOP_RIGHT: Box = { x: 120, y: 0, width: 120, height: 80 };
const BOTTOM_LEFT: Box = { x: 0, y: 80, width: 120, height: 80 };

describe('image-watermark', () => {
  it('stamps the text into the pixels, in the corner asked for (happy path)', async () => {
    const { ctx, fractions } = recorder();
    const outputs = await watermark(
      [await plain()],
      { text: 'DRAFT', position: 'bottom-right', size: 12, opacity: 100 },
      ctx,
    );

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.name).toBe('plain.png');
    expect(outputs[0]?.type).toBe('image/png');
    // The picture keeps its size — a watermark is drawn on, not around.
    expect(await decodeOutput(outputs[0] as OpOutput)).toEqual({ width: 240, height: 160 });

    expect((await inkIn(outputs[0] as OpOutput, BOTTOM_RIGHT)).count).toBeGreaterThan(0);
    expect((await inkIn(outputs[0] as OpOutput, TOP_LEFT)).count).toBe(0);

    expectMonotonicEndingAtOne(fractions);
  });

  it('moves the stamp to the opposite corner on request', async () => {
    const { ctx } = recorder();
    const outputs = await watermark(
      [await plain()],
      { text: 'DRAFT', position: 'top-left', size: 12, opacity: 100 },
      ctx,
    );

    expect((await inkIn(outputs[0] as OpOutput, TOP_LEFT)).count).toBeGreaterThan(0);
    expect((await inkIn(outputs[0] as OpOutput, BOTTOM_RIGHT)).count).toBe(0);
  });

  it('covers every corner when tiled', async () => {
    const { ctx } = recorder();
    const outputs = await watermark(
      [await plain()],
      { text: 'DRAFT', position: 'tile', size: 8, opacity: 100 },
      ctx,
    );

    for (const box of [TOP_LEFT, TOP_RIGHT, BOTTOM_LEFT, BOTTOM_RIGHT]) {
      expect((await inkIn(outputs[0] as OpOutput, box)).count).toBeGreaterThan(0);
    }
  });

  it('leaves a fainter mark at a lower opacity', async () => {
    const { ctx } = recorder();
    const faint = await watermark(
      [await plain()],
      { text: 'DRAFT', position: 'center', size: 14, opacity: 15 },
      ctx,
    );
    const solid = await watermark(
      [await plain()],
      { text: 'DRAFT', position: 'center', size: 14, opacity: 100 },
      ctx,
    );

    const faintPeak = (await inkIn(faint[0] as OpOutput, BOTTOM_RIGHT, 0)).peak;
    const solidPeak = (await inkIn(solid[0] as OpOutput, BOTTOM_RIGHT, 0)).peak;
    expect(faintPeak).toBeGreaterThan(0);
    expect(solidPeak).toBeGreaterThan(faintPeak * 2);
  });

  it('marks more pixels at a bigger size', async () => {
    const { ctx } = recorder();
    const small = await watermark(
      [await plain()],
      { text: 'DRAFT', position: 'center', size: 3, opacity: 100 },
      ctx,
    );
    const large = await watermark(
      [await plain()],
      { text: 'DRAFT', position: 'center', size: 20, opacity: 100 },
      ctx,
    );

    const smallInk = (await inkIn(small[0] as OpOutput, BOTTOM_RIGHT)).count;
    const largeInk = (await inkIn(large[0] as OpOutput, BOTTOM_RIGHT)).count;
    expect(largeInk).toBeGreaterThan(smallInk);
  });

  it('keeps a JPEG a JPEG, name and all', async () => {
    const { ctx } = recorder();
    const outputs = await watermark(
      [await plain('photo.jpg', 'image/jpeg')],
      { text: 'DRAFT', position: 'center', size: 14, opacity: 100, quality: 90 },
      ctx,
    );

    expect(outputs[0]?.type).toBe('image/jpeg');
    expect(outputs[0]?.name).toBe('photo.jpg');
    expect((await inkIn(outputs[0] as OpOutput, BOTTOM_RIGHT)).count).toBeGreaterThan(0);
  });

  it('renames the file when the output format has to change', async () => {
    // A format canvas cannot encode comes back as PNG. The input here carries
    // PNG bytes under a GIF label — createImageBitmap sniffs the real content,
    // so this exercises exactly the naming path a real GIF would take.
    const source = await plain('animation.gif');
    const { ctx } = recorder();
    const outputs = await watermark(
      [{ ...source, type: 'image/gif' }],
      { text: 'DRAFT', position: 'center', size: 14, opacity: 100 },
      ctx,
    );

    expect(outputs[0]?.type).toBe('image/png');
    expect(outputs[0]?.name).toBe('animation.png');
  });

  it.each([
    [{ text: '' }],
    [{ text: '   ' }],
    [{ text: 42 }],
    [{ text: 'DRAFT', position: 'middle' }],
    [{ text: 'DRAFT', colour: 'red' }],
    [{ text: 'DRAFT', size: 0 }],
    [{ text: 'DRAFT', size: 30 }],
    [{ text: 'DRAFT', opacity: 200 }],
    [{ text: 'DRAFT', quality: 5 }],
  ])('raises InvalidOptions for %j', async (options) => {
    const { ctx } = recorder();
    await expectOpError(watermark([await plain()], options, ctx), 'InvalidOptions');
  });

  it('raises UnsupportedFormat naming the file for a non-image input, never crashing', async () => {
    const input = await opInput('corrupt.pdf', 'application/pdf');
    const { ctx } = recorder();
    await expectOpError(watermark([input], { text: 'DRAFT' }, ctx), 'UnsupportedFormat', 'corrupt.pdf');
  });

  it('raises CorruptFile naming the file for bytes that are not a decodable image', async () => {
    const input: OpInput = {
      name: 'broken.png',
      type: 'image/png',
      buffer: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]).buffer,
    };
    const { ctx } = recorder();
    await expectOpError(watermark([input], { text: 'DRAFT' }, ctx), 'CorruptFile', 'broken.png');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const { ctx, controller } = recorder();
    const promise = watermark([await plain()], { text: 'DRAFT' }, ctx);
    controller.abort();
    await expectOpError(promise, 'Cancelled');
  });

  it('reports monotonic progress ending at exactly 1', async () => {
    const { ctx, fractions } = recorder();
    await watermark([await plain('a.png'), await plain('b.png')], { text: 'DRAFT' }, ctx);
    expect(fractions).toEqual([0.5, 1]);
    expectMonotonicEndingAtOne(fractions);
  });
});

// ---------------------------------------------------------------------------
// renameForMime — the pure half of "never label bytes with the wrong extension"
// ---------------------------------------------------------------------------

describe('renameForMime', () => {
  it('swaps the extension to match the mime', () => {
    expect(renameForMime('holiday.gif', 'image/png')).toBe('holiday.png');
    expect(renameForMime('scan.png', 'image/jpeg')).toBe('scan.jpg');
    expect(renameForMime('no-extension', 'image/webp')).toBe('no-extension.webp');
    expect(renameForMime('two.dots.here.bmp', 'image/png')).toBe('two.dots.here.png');
  });

  it('leaves the name alone for a mime it has no extension for', () => {
    // A wrong extension is worse than an absent one.
    expect(renameForMime('mystery.xyz', 'application/octet-stream')).toBe('mystery.xyz');
  });
});
