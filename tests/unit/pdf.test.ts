// tests/unit/pdf.test.ts — Node-side tests for the PDF tools.
//
// Anything that needs a canvas (pdf-to-images, and pdf-shrink's JPEG
// re-encoding) lives in tests/unit/pdf-render.browser.test.ts, which runs in
// headless Chromium. This file covers everything that does not.
//
// Every op gets the four §2 tests: happy path, the correct OpErrorCode for bad
// input, mid-run cancellation via AbortSignal, and monotonic progress ending at
// exactly 1. Encrypted and corrupt PDFs are asserted against every op that
// parses a PDF.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';

import { OpError, type OpContext, type OpInput, type OpOutput } from '../../src/types';
import split, { parsePageRanges } from '../../src/tools/pdf/split.op';
import organize, { parsePagePlan } from '../../src/tools/pdf/organize.op';
import shrink, { canReencodeImages } from '../../src/tools/pdf/shrink.op';
import toImages from '../../src/tools/pdf/to-images.op';
import fromImages, { imageKind } from '../../src/tools/pdf/from-images.op';
import extractText, { joinTextItems } from '../../src/tools/pdf/extract-text.op';
import { PDF_TOOLS } from '../../src/core/registry.pdf';
import { PDF_LOADERS } from '../../src/core/workers/loaders.pdf';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

const bytes = new Map<string, Uint8Array>();

async function load(name: string): Promise<Uint8Array> {
  const cached = bytes.get(name);
  if (cached) return cached;
  const buf = new Uint8Array(await readFile(path.join(FIXTURES, name)));
  bytes.set(name, buf);
  return buf;
}

/** A fresh OpInput each time — ops may detach or consume the buffer. */
async function input(name: string, type = 'application/pdf'): Promise<OpInput> {
  const source = await load(name);
  const buffer = new ArrayBuffer(source.byteLength);
  new Uint8Array(buffer).set(source);
  return { name, type, buffer };
}

type Recorder = { ctx: OpContext; fractions: number[]; controller: AbortController };

function recorder(onEach?: (fraction: number, controller: AbortController) => void): Recorder {
  const controller = new AbortController();
  const fractions: number[] = [];
  const ctx: OpContext = {
    onProgress(fraction: number): void {
      fractions.push(fraction);
      onEach?.(fraction, controller);
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
  const opError = err as OpError;
  expect(opError.code).toBe(code);
  if (fileName !== undefined) expect(opError.file).toBe(fileName);
  return opError;
}

async function pageCountOf(output: OpOutput): Promise<number> {
  const doc = await PDFDocument.load(output.buffer, { updateMetadata: false });
  return doc.getPageCount();
}

beforeAll(async () => {
  // Fail loudly and early if the fixtures are not what every test below assumes.
  const small = await PDFDocument.load(await load('small.pdf'), { updateMetadata: false });
  expect(small.getPageCount()).toBe(3);
});

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

describe('pdf registry entries', () => {
  const expected = [
    'pdf-split',
    'pdf-organize',
    'pdf-shrink',
    'pdf-to-images',
    'pdf-from-images',
    'pdf-extract-text',
  ];

  it('registers all six pdf tools with matching loader entries', () => {
    const ids = PDF_TOOLS.map((tool) => tool.id);
    for (const id of expected) {
      expect(ids).toContain(id);
      expect(PDF_LOADERS[id]).toBeTypeOf('function');
    }
  });

  it('uses exactly the option schemas the plan specifies', () => {
    const byId = new Map(PDF_TOOLS.map((tool) => [tool.id, tool]));

    expect(byId.get('pdf-split')?.options).toEqual({
      mode: {
        kind: 'select',
        label: 'Split by',
        choices: [
          { value: 'pages', label: 'Every page' },
          { value: 'ranges', label: 'Page ranges' },
        ],
        default: 'pages',
      },
      ranges: { kind: 'text', label: 'Ranges', placeholder: '1-3,7,9-', default: '' },
    });
    expect(byId.get('pdf-shrink')?.options?.['quality']).toEqual({
      kind: 'range',
      label: 'Image quality',
      min: 10,
      max: 100,
      step: 5,
      default: 70,
    });
    // Widened to 600 when pdf-to-images gained its bespoke editor: 300 DPI is
    // the print floor, not the ceiling, and the editor now shows the resulting
    // pixel size and estimated total so a high DPI is an informed choice.
    expect(byId.get('pdf-to-images')?.options?.['dpi']).toEqual({
      kind: 'number',
      label: 'Resolution (DPI)',
      min: 72,
      max: 600,
      step: 1,
      default: 150,
    });
    // JPEG quality and page selection came with the editor. They stay in the
    // schema so the op's defaults have a declared home and the generic panel
    // remains a working fallback.
    expect(byId.get('pdf-to-images')?.options?.['quality']).toEqual({
      kind: 'range',
      label: 'JPEG quality',
      min: 10,
      max: 100,
      step: 5,
      default: 85,
    });
    expect(byId.get('pdf-to-images')?.options?.['pages']).toEqual({
      kind: 'text',
      label: 'Pages',
      placeholder: 'all pages',
      default: '',
    });
    // The editor must be wired up, or all of the above silently reverts to the
    // flat schema panel this tool outgrew.
    expect(typeof byId.get('pdf-to-images')?.editor).toBe('function');
    expect(byId.get('pdf-to-images')?.options?.['format']).toMatchObject({ kind: 'select', default: 'png' });
    expect(byId.get('pdf-from-images')?.options?.['pageSize']).toMatchObject({ kind: 'select', default: 'fit' });
    expect(byId.get('pdf-from-images')?.options?.['margin']).toEqual({
      kind: 'number',
      label: 'Margin (points)',
      min: 0,
      max: 72,
      step: 1,
      default: 0,
    });

    // pdf-organize has no schema — it uses its editor instead.
    expect(byId.get('pdf-organize')?.options).toBeUndefined();
    expect(byId.get('pdf-organize')?.editor).toBeTypeOf('function');
    // pdf-extract-text has no options at all.
    expect(byId.get('pdf-extract-text')?.options).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parsePageRanges — pure helper
// ---------------------------------------------------------------------------

describe('parsePageRanges', () => {
  it('parses the plan\'s own example "1-3,7,9-" into 0-based groups', () => {
    expect(parsePageRanges('1-3,7,9-', 10)).toEqual([
      { label: '1-3', pages: [0, 1, 2] },
      { label: '7', pages: [6] },
      { label: '9-10', pages: [8, 9] },
    ]);
  });

  it('accepts surrounding whitespace and a single page', () => {
    expect(parsePageRanges('  2 ,  3-3 ', 5)).toEqual([
      { label: '2', pages: [1] },
      { label: '3', pages: [2] },
    ]);
  });

  it('expands an open-ended range to the last page', () => {
    expect(parsePageRanges('2-', 3)).toEqual([{ label: '2-3', pages: [1, 2] }]);
  });

  it.each([
    ['', 'an empty spec'],
    ['   ', 'whitespace only'],
    ['abc', 'a non-numeric token'],
    ['0', 'page zero'],
    ['-3', 'a leading dash'],
    ['3-1', 'a reversed range'],
    ['1-3,,7', 'an empty group'],
    ['1-3,', 'a trailing comma'],
    ['1--3', 'a doubled dash'],
    ['1.5', 'a fractional page'],
    ['4', 'a page past the end'],
    ['1-9', 'a range past the end'],
    ['1 3', 'a space-separated pair'],
  ])('raises InvalidOptions for %j (%s)', (spec) => {
    let thrown: unknown;
    try {
      parsePageRanges(spec, 3);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OpError);
    expect((thrown as OpError).code).toBe('InvalidOptions');
  });

  it('rejects a nonsensical page count', () => {
    expect(() => parsePageRanges('1', 0)).toThrow(OpError);
  });
});

// ---------------------------------------------------------------------------
// pdf-split
// ---------------------------------------------------------------------------

describe('pdf-split', () => {
  it('splits a 3-page PDF into 3 single-page PDFs (happy path)', async () => {
    const { ctx, fractions } = recorder();
    const outputs = await split([await input('small.pdf')], { mode: 'pages', ranges: '' }, ctx);

    expect(outputs.map((o) => o.name)).toEqual(['small-p1.pdf', 'small-p2.pdf', 'small-p3.pdf']);
    for (const output of outputs) {
      expect(output.type).toBe('application/pdf');
      expect(await pageCountOf(output)).toBe(1);
    }
    expectMonotonicEndingAtOne(fractions);
  });

  it('splits by range groups, with real page counts loaded back via pdf-lib', async () => {
    const { ctx } = recorder();
    const outputs = await split([await input('small.pdf')], { mode: 'ranges', ranges: '1-2,3' }, ctx);

    expect(outputs.map((o) => o.name)).toEqual(['small-p1-2.pdf', 'small-p3.pdf']);
    expect(await pageCountOf(outputs[0] as OpOutput)).toBe(2);
    expect(await pageCountOf(outputs[1] as OpOutput)).toBe(1);
  });

  it('raises InvalidOptions for a malformed range spec', async () => {
    const { ctx } = recorder();
    await expectOpError(split([await input('small.pdf')], { mode: 'ranges', ranges: '9-4' }, ctx), 'InvalidOptions');
  });

  it('raises InvalidOptions for an unknown mode', async () => {
    const { ctx } = recorder();
    await expectOpError(split([await input('small.pdf')], { mode: 'sideways' }, ctx), 'InvalidOptions');
  });

  it('raises CorruptFile naming the file for corrupt.pdf', async () => {
    const { ctx } = recorder();
    await expectOpError(split([await input('corrupt.pdf')], {}, ctx), 'CorruptFile', 'corrupt.pdf');
  });

  it('raises CorruptFile naming the file for encrypted.pdf', async () => {
    const { ctx } = recorder();
    const err = await expectOpError(split([await input('encrypted.pdf')], {}, ctx), 'CorruptFile', 'encrypted.pdf');
    expect(err.message).toMatch(/password/i);
  });

  it('raises UnsupportedFormat for a file that is not a PDF at all', async () => {
    const { ctx } = recorder();
    await expectOpError(split([await input('a.png', 'image/png')], {}, ctx), 'UnsupportedFormat', 'a.png');
  });

  it('rejects with Cancelled when aborted mid-run', async () => {
    const { ctx, fractions } = recorder((fraction, controller) => {
      if (fraction > 0) controller.abort();
    });
    await expectOpError(split([await input('small.pdf')], { mode: 'pages' }, ctx), 'Cancelled');
    // It really was mid-run: some progress happened, but it never reached 1.
    expect(fractions.length).toBeGreaterThan(1);
    expect(fractions.at(-1)).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// pdf-organize
// ---------------------------------------------------------------------------

describe('parsePagePlan', () => {
  it('accepts a well-formed plan', () => {
    expect(
      parsePagePlan(
        [
          { index: 2, rotate: 90, keep: true },
          { index: 0, rotate: 0, keep: false },
        ],
        3,
      ),
    ).toEqual([
      { index: 2, rotate: 90, keep: true },
      { index: 0, rotate: 0, keep: false },
    ]);
  });

  // Explicitly typed as [unknown, string][] (matching parsePagePlan's own
  // `value: unknown` parameter): the row values have deliberately different
  // shapes (undefined, arrays of objects with different key sets, an array
  // of strings), and without this annotation TS infers a union of
  // differently-shaped tuples that vitest's `.each` overload cannot spread
  // into a single callback signature (TS2345).
  it.each<[unknown, string]>([
    [undefined, 'a missing plan'],
    [[], 'an empty plan'],
    [[{ index: 5, rotate: 0, keep: true }], 'an out-of-range index'],
    [[{ index: -1, rotate: 0, keep: true }], 'a negative index'],
    [[{ index: 1.5, rotate: 0, keep: true }], 'a fractional index'],
    [
      [
        { index: 0, rotate: 0, keep: true },
        { index: 0, rotate: 0, keep: true },
      ],
      'a duplicated index',
    ],
    [[{ index: 0, rotate: 45, keep: true }], 'an unsupported rotation'],
    [[{ index: 0, rotate: 0, keep: 'yes' }], 'a non-boolean keep'],
    [[{ index: 0, rotate: 0 }], 'a missing keep'],
    [['nope'], 'a non-object entry'],
    [[{ index: 0, rotate: 0, keep: false }], 'every page deleted'],
  ])('raises InvalidOptions for %j (%s)', (plan) => {
    let thrown: unknown;
    try {
      parsePagePlan(plan, 3);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OpError);
    expect((thrown as OpError).code).toBe('InvalidOptions');
  });
});

describe('pdf-organize', () => {
  it('reorders, rotates and deletes pages (happy path)', async () => {
    const { ctx, fractions } = recorder();
    const outputs = await organize(
      [await input('small.pdf')],
      {
        pages: [
          { index: 2, rotate: 90, keep: true },
          { index: 0, rotate: 180, keep: true },
          { index: 1, rotate: 0, keep: false },
        ],
      },
      ctx,
    );

    expect(outputs).toHaveLength(1);
    const output = outputs[0] as OpOutput;
    expect(output.name).toBe('small-organized.pdf');
    const doc = await PDFDocument.load(output.buffer, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
    expect(doc.getPage(1).getRotation().angle).toBe(180);
    expectMonotonicEndingAtOne(fractions);
  });

  it('raises InvalidOptions when the editor supplied no plan', async () => {
    const { ctx } = recorder();
    await expectOpError(organize([await input('small.pdf')], {}, ctx), 'InvalidOptions');
  });

  it('raises InvalidOptions for more than one input', async () => {
    const { ctx } = recorder();
    await expectOpError(
      organize([await input('small.pdf'), await input('small.pdf')], { pages: [] }, ctx),
      'InvalidOptions',
    );
  });

  it('raises CorruptFile naming the file for corrupt.pdf', async () => {
    const { ctx } = recorder();
    await expectOpError(organize([await input('corrupt.pdf')], { pages: [] }, ctx), 'CorruptFile', 'corrupt.pdf');
  });

  it('raises CorruptFile naming the file for encrypted.pdf', async () => {
    const { ctx } = recorder();
    await expectOpError(organize([await input('encrypted.pdf')], { pages: [] }, ctx), 'CorruptFile', 'encrypted.pdf');
  });

  it('rejects with Cancelled when aborted mid-run', async () => {
    const { ctx, fractions } = recorder((fraction, controller) => {
      if (fraction > 0) controller.abort();
    });
    await expectOpError(
      organize(
        [await input('small.pdf')],
        {
          pages: [
            { index: 0, rotate: 0, keep: true },
            { index: 1, rotate: 0, keep: true },
            { index: 2, rotate: 0, keep: true },
          ],
        },
        ctx,
      ),
      'Cancelled',
    );
    expect(fractions.at(-1)).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// pdf-shrink
// ---------------------------------------------------------------------------

describe('pdf-shrink', () => {
  it('returns the ORIGINAL bytes and says so when the rewrite is not smaller', async () => {
    const source = await input('small.pdf');
    const before = source.buffer.byteLength;
    const { ctx, fractions } = recorder();
    const outputs = await shrink([source], { quality: 70 }, ctx);

    const pdf = outputs.find((o) => o.type === 'application/pdf');
    const report = outputs.find((o) => o.name === 'shrink-report.txt');
    expect(pdf).toBeDefined();
    expect(report).toBeDefined();

    // small.pdf is already minimal, so this is the honesty path.
    expect(pdf?.name).toBe('small-unchanged.pdf');
    expect(pdf?.buffer.byteLength).toBe(before);
    expect(new Uint8Array(pdf?.buffer as ArrayBuffer)).toEqual(await load('small.pdf'));

    const text = new TextDecoder().decode(report?.buffer);
    expect(text).toContain(`before: ${before} bytes`);
    expect(text).toContain(`after:  ${before} bytes`);
    expect(text).toContain('NOT smaller');
    expect(text).toContain('returned the original file unchanged');
    // In Node there is no OffscreenCanvas, and the report must admit it.
    expect(canReencodeImages()).toBe(false);
    expect(text).toContain('UNAVAILABLE in this environment');

    expectMonotonicEndingAtOne(fractions);
  });

  it('never claims a reduction it did not achieve', async () => {
    const source = await input('small.pdf');
    const { ctx } = recorder();
    const outputs = await shrink([source], { quality: 10 }, ctx);
    const report = new TextDecoder().decode(outputs.find((o) => o.name === 'shrink-report.txt')?.buffer);
    expect(report).not.toContain('% smaller');
    expect(report).toContain('0% change');
  });

  it.each([[5], [101], ['70'], [Number.NaN]])('raises InvalidOptions for quality %j', async (quality) => {
    const { ctx } = recorder();
    await expectOpError(shrink([await input('small.pdf')], { quality }, ctx), 'InvalidOptions');
  });

  it('raises CorruptFile naming the file for corrupt.pdf', async () => {
    const { ctx } = recorder();
    await expectOpError(shrink([await input('corrupt.pdf')], {}, ctx), 'CorruptFile', 'corrupt.pdf');
  });

  it('raises CorruptFile naming the file for encrypted.pdf', async () => {
    const { ctx } = recorder();
    await expectOpError(shrink([await input('encrypted.pdf')], {}, ctx), 'CorruptFile', 'encrypted.pdf');
  });

  it('rejects with Cancelled when aborted mid-run', async () => {
    const { ctx, fractions } = recorder((fraction, controller) => {
      if (fraction > 0) controller.abort();
    });
    await expectOpError(
      shrink([await input('small.pdf'), await input('small.pdf')], { quality: 70 }, ctx),
      'Cancelled',
    );
    expect(fractions.length).toBeGreaterThan(1);
    expect(fractions.at(-1)).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// pdf-to-images (Node side: it must refuse rather than pretend)
// ---------------------------------------------------------------------------

describe('pdf-to-images under Node', () => {
  it('raises EncoderUnavailable where OffscreenCanvas does not exist', async () => {
    expect(typeof OffscreenCanvas).not.toBe('function');
    const { ctx } = recorder();
    await expectOpError(toImages([await input('small.pdf')], { format: 'png', dpi: 150 }, ctx), 'EncoderUnavailable');
  });

  // See the pdf-organize it.each above for why the explicit tuple type is
  // needed: these rows' option objects have different key sets.
  it.each<[Record<string, unknown>, string]>([
    [{ format: 'tiff' }, 'an unsupported format'],
    [{ dpi: 10 }, 'a dpi below the minimum'],
    [{ dpi: 1200 }, 'a dpi above the maximum'],
    [{ dpi: '150' }, 'a non-numeric dpi'],
  ])('raises InvalidOptions for %j (%s) before touching a canvas', async (options) => {
    const { ctx } = recorder();
    await expectOpError(toImages([await input('small.pdf')], options, ctx), 'InvalidOptions');
  });
});

// ---------------------------------------------------------------------------
// pdf-from-images
// ---------------------------------------------------------------------------

describe('imageKind', () => {
  it('sniffs PNG and JPEG by magic bytes, not extension', async () => {
    const png = await input('a.png', 'image/png');
    const jpg = await input('a.jpg', 'image/jpeg');
    const pdf = await input('small.pdf');
    expect(imageKind(png.buffer)).toBe('png');
    expect(imageKind(jpg.buffer)).toBe('jpeg');
    expect(imageKind(pdf.buffer)).toBeNull();
    expect(imageKind(new ArrayBuffer(0))).toBeNull();
  });
});

describe('pdf-from-images', () => {
  it('builds one page per image at the image size (happy path)', async () => {
    const { ctx, fractions } = recorder();
    const outputs = await fromImages(
      [
        await input('a.png', 'image/png'),
        await input('b.png', 'image/png'),
        await input('a.jpg', 'image/jpeg'),
      ],
      { pageSize: 'fit', margin: 0 },
      ctx,
    );

    expect(outputs).toHaveLength(1);
    const output = outputs[0] as OpOutput;
    expect(output.name).toBe('a.pdf');
    expect(output.type).toBe('application/pdf');

    const doc = await PDFDocument.load(output.buffer, { updateMetadata: false });
    expect(doc.getPageCount()).toBe(3);
    // Fixture dimensions: a.png 4x4, b.png 6x4, a.jpg 5x5.
    expect(doc.getPage(0).getSize()).toEqual({ width: 4, height: 4 });
    expect(doc.getPage(1).getSize()).toEqual({ width: 6, height: 4 });
    expect(doc.getPage(2).getSize()).toEqual({ width: 5, height: 5 });
    expectMonotonicEndingAtOne(fractions);
  });

  it('honours the margin in fit mode', async () => {
    const { ctx } = recorder();
    const outputs = await fromImages([await input('a.png', 'image/png')], { pageSize: 'fit', margin: 10 }, ctx);
    const doc = await PDFDocument.load((outputs[0] as OpOutput).buffer, { updateMetadata: false });
    expect(doc.getPage(0).getSize()).toEqual({ width: 24, height: 24 });
  });

  it('uses a fixed A4 page when asked', async () => {
    const { ctx } = recorder();
    const outputs = await fromImages([await input('a.png', 'image/png')], { pageSize: 'a4', margin: 0 }, ctx);
    const doc = await PDFDocument.load((outputs[0] as OpOutput).buffer, { updateMetadata: false });
    const size = doc.getPage(0).getSize();
    expect(size.width).toBeCloseTo(595.28, 1);
    expect(size.height).toBeCloseTo(841.89, 1);
  });

  it('raises UnsupportedFormat naming the file for a WebP input', async () => {
    const { ctx } = recorder();
    await expectOpError(
      fromImages([await input('a.webp', 'image/webp')], { pageSize: 'fit' }, ctx),
      'UnsupportedFormat',
      'a.webp',
    );
  });

  // See the pdf-organize it.each above for why the explicit tuple type is
  // needed: these rows' option objects have different key sets.
  it.each<[Record<string, unknown>, string]>([
    [{ pageSize: 'a3' }, 'an unknown page size'],
    [{ margin: -1 }, 'a negative margin'],
    [{ margin: 500 }, 'an oversized margin'],
  ])('raises InvalidOptions for %j (%s)', async (options) => {
    const { ctx } = recorder();
    await expectOpError(fromImages([await input('a.png', 'image/png')], options, ctx), 'InvalidOptions');
  });

  it('rejects with Cancelled when aborted mid-run', async () => {
    const { ctx, fractions } = recorder((fraction, controller) => {
      if (fraction > 0) controller.abort();
    });
    await expectOpError(
      fromImages(
        [
          await input('a.png', 'image/png'),
          await input('b.png', 'image/png'),
          await input('c.png', 'image/png'),
        ],
        { pageSize: 'fit' },
        ctx,
      ),
      'Cancelled',
    );
    expect(fractions.length).toBeGreaterThan(1);
    expect(fractions.at(-1)).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// pdf-extract-text
// ---------------------------------------------------------------------------

describe('joinTextItems', () => {
  it('joins runs and honours pdfjs end-of-line markers', () => {
    expect(joinTextItems([{ str: 'Hello ' }, { str: 'world', hasEOL: true }, { str: 'again' }])).toBe(
      'Hello world\nagain',
    );
  });

  it('returns an empty string for no items', () => {
    expect(joinTextItems([])).toBe('');
  });
});

describe('pdf-extract-text', () => {
  it('extracts the real text of every page (happy path)', async () => {
    const { ctx, fractions } = recorder();
    const outputs = await extractText([await input('small.pdf')], {}, ctx);

    expect(outputs).toHaveLength(1);
    const output = outputs[0] as OpOutput;
    expect(output.name).toBe('small.txt');
    expect(output.type).toBe('text/plain');

    const text = new TextDecoder().decode(output.buffer);
    expect(text).toContain('--- Page 1 of 3 ---');
    expect(text).toContain('Page 1');
    expect(text).toContain('Page 2');
    expect(text).toContain('Page 3');
    expectMonotonicEndingAtOne(fractions);
  });

  it('refuses a scan outright instead of "succeeding" with an empty file', async () => {
    // A page holding only an image is what a scanner or a phone photo produces.
    // The old behaviour wrote a 49-byte file reading "(no text layer on this
    // page)" and reported success, which the results tray then decorated with a
    // green "100% smaller". The job plainly failed; it must say so.
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    // A 2x2 PNG is enough: the point is a page with image content and no text.
    const png = await doc.embedPng(
      Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z/CfgQmEGGEEAwMDAA5+Av7x6vGxAAAAAElFTkSuQmCC',
        ),
        (c) => c.charCodeAt(0),
      ),
    );
    const page = doc.addPage([200, 200]);
    page.drawImage(png, { x: 0, y: 0, width: 200, height: 200 });
    const buffer = (await doc.save()).slice().buffer as ArrayBuffer;

    const { ctx } = recorder();
    const err = await expectOpError(
      extractText([{ name: 'scan.pdf', type: 'application/pdf', buffer }], {}, ctx),
      'UnsupportedFormat',
      'scan.pdf',
    );
    // The message has to be actionable, not just negative: say it is a scan,
    // say OCR is what would be needed, and point at the tool that does it.
    // (Previously pointed at "PDF to images", back when omnitool had no OCR
    // tool of its own — see src/tools/data/ocr.op.ts.)
    expect(err.message).toMatch(/no text layer/i);
    expect(err.message).toMatch(/OCR/);
    expect(err.message).toMatch(/Scan to text/i);
  });

  it('still delivers a mixed PDF, but flags the pages that had no text', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([200, 200]).drawText('real words here', { x: 20, y: 100, size: 12, font });
    doc.addPage([200, 200]); // deliberately blank — no text layer
    const buffer = (await doc.save()).slice().buffer as ArrayBuffer;

    const { ctx } = recorder();
    const outputs = await extractText([{ name: 'mixed.pdf', type: 'application/pdf', buffer }], {}, ctx);
    const text = new TextDecoder().decode((outputs[0] as OpOutput).buffer);

    expect(text).toContain('real words here');
    // The warning belongs at the TOP, where it will be read — not only buried
    // inline next to the page that was empty.
    expect(text.slice(0, 200)).toMatch(/NOTE: 1 of 2 pages have no text layer/);
    expect(text.slice(0, 200)).toMatch(/page 2/);
  });

  it('raises CorruptFile naming the file for corrupt.pdf', async () => {
    const { ctx } = recorder();
    await expectOpError(extractText([await input('corrupt.pdf')], {}, ctx), 'CorruptFile', 'corrupt.pdf');
  });

  it('raises CorruptFile naming the file for encrypted.pdf', async () => {
    const { ctx } = recorder();
    const err = await expectOpError(
      extractText([await input('encrypted.pdf')], {}, ctx),
      'CorruptFile',
      'encrypted.pdf',
    );
    expect(err.message).toMatch(/password/i);
  });

  it('raises UnsupportedFormat for a non-PDF input', async () => {
    const { ctx } = recorder();
    await expectOpError(extractText([await input('a.png', 'image/png')], {}, ctx), 'UnsupportedFormat', 'a.png');
  });

  it('rejects with Cancelled when aborted mid-run', async () => {
    const { ctx, fractions } = recorder((fraction, controller) => {
      if (fraction > 0) controller.abort();
    });
    await expectOpError(extractText([await input('small.pdf')], {}, ctx), 'Cancelled');
    expect(fractions.length).toBeGreaterThan(1);
    expect(fractions.at(-1)).not.toBe(1);
  });
});
