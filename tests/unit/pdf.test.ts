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

import { unzlibSync, zlibSync } from 'fflate';
import { PDFDict, PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { beforeAll, describe, expect, it } from 'vitest';

import { OpError, type OpContext, type OpInput, type OpOutput } from '../../src/types';
import split, { parsePageRanges } from '../../src/tools/pdf/split.op';
import organize, { parsePagePlan } from '../../src/tools/pdf/organize.op';
import shrink, { canReencodeImages } from '../../src/tools/pdf/shrink.op';
import toImages from '../../src/tools/pdf/to-images.op';
import fromImages, { imageKind } from '../../src/tools/pdf/from-images.op';
import metadata from '../../src/tools/pdf/metadata.op';
import extractImages from '../../src/tools/pdf/extract-images.op';
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
    'pdf-metadata',
    'pdf-extract-images',
  ];

  it('registers every pdf tool with a matching loader entry', () => {
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

    expect(byId.get('pdf-metadata')?.options).toEqual({
      keepTitle: { kind: 'toggle', label: 'Keep the document title', default: false },
      removeXmp: { kind: 'toggle', label: 'Remove XMP and application data', default: true },
    });

    expect(byId.get('pdf-extract-images')?.options).toEqual({
      minSize: { kind: 'number', label: 'Skip images under (px)', min: 0, max: 4096, step: 8, default: 0 },
    });

    // pdf-organize has no schema — it uses its editor instead.
    expect(byId.get('pdf-organize')?.options).toBeUndefined();
    expect(byId.get('pdf-organize')?.editor).toBeTypeOf('function');
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
// pdf-metadata
// ---------------------------------------------------------------------------

/** Saved PDF bytes as an OpInput, with a buffer the op is free to consume. */
async function asInput(bytes: Uint8Array, name: string): Promise<OpInput> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { name, type: 'application/pdf', buffer };
}

/** A copy of small.pdf carrying a full Info dictionary, and optionally XMP. */
async function pdfWithMetadata(xmp?: string): Promise<OpInput> {
  const doc = await PDFDocument.load(await load('small.pdf'), { updateMetadata: false });
  doc.setTitle('Quarterly numbers');
  doc.setAuthor('Kim Duy');
  doc.setSubject('Internal only');
  doc.setKeywords(['confidential', 'draft']);
  doc.setProducer('omnitool tests');
  doc.setCreator('omnitool tests');
  if (xmp !== undefined) {
    const stream = doc.context.stream(new TextEncoder().encode(xmp), { Type: 'Metadata', Subtype: 'XML' });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  }
  const bytes = await doc.save();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { name: 'meta.pdf', type: 'application/pdf', buffer };
}

/** A copy of small.pdf with an empty Info dictionary and no XMP. */
async function pdfWithoutMetadata(): Promise<OpInput> {
  const doc = await PDFDocument.load(await load('small.pdf'), { updateMetadata: false });
  const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
  for (const key of info.keys()) info.delete(key);
  const bytes = await doc.save();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { name: 'bare.pdf', type: 'application/pdf', buffer };
}

function reportOf(outputs: OpOutput[]): string {
  return new TextDecoder().decode(outputs.find((o) => o.name === 'pdf-metadata-report.txt')?.buffer);
}

/** Does this file contain `needle` anywhere in its raw bytes? */
function bytesContain(buffer: ArrayBuffer, needle: string): boolean {
  return new TextDecoder('latin1').decode(new Uint8Array(buffer)).includes(needle);
}

/** How pdf-lib writes a text value into a PDF: UTF-16BE, hex, with a BOM. */
function asPdfHex(text: string): string {
  let hex = 'feff';
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, '0');
  return hex;
}

/**
 * Re-save a document with object streams OFF, which expands every surviving
 * object into plain bytes. Searching *that* is what makes "no trace left"
 * checkable: pdf-lib's default save deflates the Info dictionary into a
 * compressed object stream, where a byte search would find nothing whether the
 * value was removed or not.
 */
async function flattened(buffer: ArrayBuffer): Promise<string> {
  const doc = await PDFDocument.load(buffer, { updateMetadata: false });
  const bytes = await doc.save({ useObjectStreams: false });
  return new TextDecoder('latin1').decode(bytes).toLowerCase();
}

describe('pdf-metadata', () => {
  it('empties the Info dictionary and reports what came out', async () => {
    const source = await pdfWithMetadata();
    const { ctx, fractions } = recorder();
    const outputs = await metadata([source], {}, ctx);

    const pdf = outputs.find((o) => o.type === 'application/pdf');
    expect(pdf?.name).toBe('meta.pdf');

    const cleaned = await PDFDocument.load(pdf?.buffer as ArrayBuffer, { updateMetadata: false });
    expect(cleaned.getTitle()).toBeUndefined();
    expect(cleaned.getAuthor()).toBeUndefined();
    expect(cleaned.getSubject()).toBeUndefined();
    expect(cleaned.getKeywords()).toBeUndefined();
    expect(cleaned.getProducer()).toBeUndefined();
    expect(cleaned.getCreator()).toBeUndefined();
    expect(cleaned.getCreationDate()).toBeUndefined();
    expect(cleaned.getModificationDate()).toBeUndefined();
    // The document itself is untouched — this removes metadata, not content.
    expect(cleaned.getPageCount()).toBe(3);

    const report = reportOf(outputs);
    expect(report).toContain('removed Author: Kim Duy');
    expect(report).toContain('removed Title: Quarterly numbers');
    expect(report).toContain('removed Producer: omnitool tests');

    expectMonotonicEndingAtOne(fractions);
  });

  it('leaves no surviving object holding the removed values', async () => {
    const source = await pdfWithMetadata();
    // The check has teeth only if it finds the value before the op runs.
    expect(await flattened(source.buffer)).toContain(asPdfHex('Kim Duy'));

    const { ctx } = recorder();
    const outputs = await metadata([source], {}, ctx);
    const pdf = outputs.find((o) => o.type === 'application/pdf');

    expect(await flattened(pdf?.buffer as ArrayBuffer)).not.toContain(asPdfHex('Kim Duy'));
  });

  it('purges the XMP stream from the FILE, not just from the catalog', async () => {
    // The whole point of context.delete(): unlinking alone leaves the stream in
    // the file as an orphan object that pdf-lib faithfully writes back out.
    const xmp = '<?xpacket begin="" ?><x:xmpmeta><dc:creator>SECRETPERSON</dc:creator></x:xmpmeta>';
    const source = await pdfWithMetadata(xmp);
    expect(bytesContain(source.buffer, 'SECRETPERSON')).toBe(true);

    const { ctx } = recorder();
    const outputs = await metadata([source], {}, ctx);
    const pdf = outputs.find((o) => o.type === 'application/pdf');

    expect(bytesContain(pdf?.buffer as ArrayBuffer, 'SECRETPERSON')).toBe(false);
    const cleaned = await PDFDocument.load(pdf?.buffer as ArrayBuffer, { updateMetadata: false });
    expect(cleaned.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
    expect(cleaned.getPageCount()).toBe(3);
    expect(reportOf(outputs)).toContain('removed XMP metadata stream');
  });

  it('keeps the XMP stream when removeXmp is off, and says so', async () => {
    const xmp = '<?xpacket begin="" ?><x:xmpmeta><dc:creator>SECRETPERSON</dc:creator></x:xmpmeta>';
    const source = await pdfWithMetadata(xmp);
    const { ctx } = recorder();
    const outputs = await metadata([source], { removeXmp: false }, ctx);
    const pdf = outputs.find((o) => o.type === 'application/pdf');

    expect(bytesContain(pdf?.buffer as ArrayBuffer, 'SECRETPERSON')).toBe(true);
    // The Info dictionary still went.
    expect(bytesContain(pdf?.buffer as ArrayBuffer, 'Kim Duy')).toBe(false);
    expect(reportOf(outputs)).toContain('XMP / application data: kept');
  });

  it('keeps the document title when asked, and nothing else', async () => {
    const source = await pdfWithMetadata();
    const { ctx } = recorder();
    const outputs = await metadata([source], { keepTitle: true }, ctx);
    const cleaned = await PDFDocument.load(
      outputs.find((o) => o.type === 'application/pdf')?.buffer as ArrayBuffer,
      { updateMetadata: false },
    );

    expect(cleaned.getTitle()).toBe('Quarterly numbers');
    expect(cleaned.getAuthor()).toBeUndefined();
    expect(cleaned.getProducer()).toBeUndefined();
    expect(reportOf(outputs)).toContain('document title: kept');
  });

  it('returns the ORIGINAL bytes when there is no metadata to remove', async () => {
    const source = await pdfWithoutMetadata();
    const before = new Uint8Array(source.buffer.slice(0));
    const { ctx, fractions } = recorder();
    const outputs = await metadata([source], {}, ctx);

    const pdf = outputs.find((o) => o.type === 'application/pdf');
    expect(new Uint8Array(pdf?.buffer as ArrayBuffer)).toEqual(before);
    expect(reportOf(outputs)).toContain('no document metadata found');
    expectMonotonicEndingAtOne(fractions);
  });

  // Unlinking a key is not removing what it pointed at: pdf-lib writes orphaned
  // objects back out, so these three assert on the BYTES, not on a getter.
  it('removes an Info value that is stored as an indirect object', async () => {
    const doc = await PDFDocument.load(await load('small.pdf'), { updateMetadata: false });
    const info = doc.context.lookup(doc.context.trailerInfo.Info, PDFDict);
    info.set(PDFName.of('Author'), doc.context.register(PDFString.of('INDIRECTLEAKNAME')));
    const source = await asInput(await doc.save(), 'indirect.pdf');

    const { ctx } = recorder();
    const outputs = await metadata([source], {}, ctx);
    const pdf = outputs.find((o) => o.type === 'application/pdf');

    expect(await flattened(pdf?.buffer as ArrayBuffer)).not.toContain('indirectleakname');
    expect(reportOf(outputs)).toContain('removed Author: INDIRECTLEAKNAME');
  });

  it('removes a nested /PieceInfo tree, not just the entry pointing at it', async () => {
    const doc = await PDFDocument.load(await load('small.pdf'), { updateMetadata: false });
    // The shape a real editor leaves behind: catalog -> app dict -> /Private.
    const priv = doc.context.register(
      doc.context.stream(new TextEncoder().encode('PIECEINFOSECRETPAYLOAD'), {}),
    );
    const app = doc.context.register(
      doc.context.obj({ Private: priv, LastModified: PDFString.of('D:20260830') }),
    );
    doc.catalog.set(PDFName.of('PieceInfo'), doc.context.register(doc.context.obj({ Illustrator: app })));
    const source = await asInput(await doc.save(), 'piece.pdf');

    const { ctx } = recorder();
    const outputs = await metadata([source], {}, ctx);
    const bytes = await flattened(outputs.find((o) => o.type === 'application/pdf')?.buffer as ArrayBuffer);

    expect(bytes).not.toContain('pieceinfosecretpayload');
    expect(bytes).not.toContain('d:20260830');
    expect(reportOf(outputs)).toContain('removed application data (PieceInfo)');
  });

  it('leaves an unlinked object alone when live content still points at it', async () => {
    // The sweep must delete only what nothing else reaches — deleting a shared
    // object would corrupt the document it was asked to clean.
    const doc = await PDFDocument.load(await load('small.pdf'), { updateMetadata: false });
    const shared = doc.context.register(PDFString.of('SHAREDVALUE'));
    doc.context.lookup(doc.context.trailerInfo.Info, PDFDict).set(PDFName.of('Author'), shared);
    doc.catalog.set(PDFName.of('OmnitoolKeepMe'), shared);
    const source = await asInput(await doc.save(), 'shared.pdf');

    const { ctx } = recorder();
    const outputs = await metadata([source], {}, ctx);
    const pdf = outputs.find((o) => o.type === 'application/pdf');

    const cleaned = await PDFDocument.load(pdf?.buffer as ArrayBuffer, { updateMetadata: false });
    expect(cleaned.getAuthor()).toBeUndefined();
    expect(cleaned.getPageCount()).toBe(3);
    // Still reachable from the catalog, so it must still be in the file.
    expect(String(cleaned.catalog.lookup(PDFName.of('OmnitoolKeepMe')))).toContain('SHAREDVALUE');
  });

  it('raises UnsupportedFormat naming the file for a non-PDF', async () => {
    const { ctx } = recorder();
    await expectOpError(
      metadata([await input('sample.csv', 'text/csv')], {}, ctx),
      'UnsupportedFormat',
      'sample.csv',
    );
  });

  it('raises CorruptFile naming the file for corrupt.pdf', async () => {
    const { ctx } = recorder();
    await expectOpError(metadata([await input('corrupt.pdf')], {}, ctx), 'CorruptFile', 'corrupt.pdf');
  });

  it('raises CorruptFile naming the file for encrypted.pdf', async () => {
    const { ctx } = recorder();
    await expectOpError(
      metadata([await input('encrypted.pdf')], {}, ctx),
      'CorruptFile',
      'encrypted.pdf',
    );
  });

  it.each([[{ keepTitle: 'yes' }], [{ removeXmp: 1 }]])(
    'raises InvalidOptions for %j',
    async (options) => {
      const { ctx } = recorder();
      await expectOpError(metadata([await input('small.pdf')], options, ctx), 'InvalidOptions');
    },
  );

  it('raises InvalidOptions when given no files at all', async () => {
    const { ctx } = recorder();
    await expectOpError(metadata([], {}, ctx), 'InvalidOptions');
  });

  it('rejects with Cancelled when aborted mid-run', async () => {
    const { ctx, fractions } = recorder((fraction, controller) => {
      if (fraction > 0) controller.abort();
    });
    await expectOpError(
      metadata([await pdfWithMetadata(), await pdfWithMetadata()], {}, ctx),
      'Cancelled',
    );
    expect(fractions.length).toBe(1);
    expect(fractions.at(-1)).not.toBe(1);
  });

  it('reports progress once per file, ending at exactly 1', async () => {
    const { ctx, fractions } = recorder();
    await metadata([await pdfWithMetadata(), await pdfWithMetadata()], {}, ctx);
    expect(fractions).toEqual([0.5, 1]);
  });
});

// ---------------------------------------------------------------------------
// pdf-extract-images
//
// Every image below is built BY HAND, so the test knows the exact pixels that
// went into the PDF and can hold the extracted file against them. Nothing here
// needs a canvas: the op decodes a Flate stream and writes a PNG container
// itself, so it is testable in plain Node — which is the point of doing the
// PNG writing by hand rather than through OffscreenCanvas.
// ---------------------------------------------------------------------------

type ImageSpec = {
  width: number;
  height: number;
  contents: Uint8Array;
  dict: Record<string, unknown>;
  pages?: number[];
};

/** A PDF holding exactly the image XObjects described, on the pages named. */
async function pdfWithImages(images: ImageSpec[], pageCount = 1): Promise<OpInput> {
  const doc = await PDFDocument.create();
  const pages = Array.from({ length: pageCount }, () => doc.addPage([200, 200]));

  images.forEach((image, index) => {
    const ref = doc.context.register(
      doc.context.stream(image.contents, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: image.width,
        Height: image.height,
        ...image.dict,
      }),
    );
    for (const page of image.pages ?? [1]) {
      pages[page - 1]?.node.setXObject(PDFName.of(`Im${index}`), ref);
    }
  });

  const bytes = await doc.save();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { name: 'images.pdf', type: 'application/pdf', buffer };
}

/** A Flate-compressed RGB image, and the pixels it was built from. */
function rgbImage(width: number, height: number, extra: Record<string, unknown> = {}): { spec: ImageSpec; pixels: Uint8Array } {
  const pixels = new Uint8Array(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 37 + 11) & 0xff;
  return {
    pixels,
    spec: {
      width,
      height,
      contents: zlibSync(pixels, { level: 6 }),
      dict: { ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode', ...extra },
    },
  };
}

function reportOfExtraction(outputs: OpOutput[]): string {
  return new TextDecoder().decode(outputs.find((o) => o.name === 'extract-images-report.txt')?.buffer);
}

function imagesFrom(outputs: OpOutput[]): OpOutput[] {
  return outputs.filter((o) => o.name !== 'extract-images-report.txt');
}

/** Read a PNG back: header fields, and the pixels its IDAT actually carries. */
function readPng(buffer: ArrayBuffer): { width: number; height: number; depth: number; colourType: number; pixels: Uint8Array } {
  const bytes = new Uint8Array(buffer);
  expect(Array.from(bytes.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const view = new DataView(buffer);
  const chunks = new Map<string, Uint8Array>();
  let at = 8;
  while (at + 12 <= bytes.length) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    chunks.set(type, bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }

  const header = chunks.get('IHDR');
  expect(header).toBeDefined();
  expect(chunks.has('IEND')).toBe(true);
  const headerView = new DataView((header as Uint8Array).buffer, (header as Uint8Array).byteOffset, 13);
  const width = headerView.getUint32(0);
  const height = headerView.getUint32(4);
  const depth = (header as Uint8Array)[8] as number;
  const colourType = (header as Uint8Array)[9] as number;

  // Undo the per-scanline filter byte (the op writes filter 0, "stored").
  const raw = unzlibSync(chunks.get('IDAT') as Uint8Array);
  const channels = colourType === 0 ? 1 : 3;
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(0);
    pixels.set(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride), y * stride);
  }
  return { width, height, depth, colourType, pixels };
}

describe('pdf-extract-images', () => {
  it('hands back an embedded JPEG byte for byte, never re-encoded (happy path)', async () => {
    const jpeg = await load('a.jpg');
    const doc = await PDFDocument.create();
    const embedded = await doc.embedJpg(jpeg);
    doc.addPage([200, 200]).drawImage(embedded, { x: 0, y: 0, width: 50, height: 50 });
    const saved = await doc.save();
    const buffer = new ArrayBuffer(saved.byteLength);
    new Uint8Array(buffer).set(saved);

    const { ctx, fractions } = recorder();
    const outputs = await extractImages([{ name: 'photo.pdf', type: 'application/pdf', buffer }], {}, ctx);

    const images = imagesFrom(outputs);
    expect(images).toHaveLength(1);
    expect(images[0]?.name).toBe('photo-p1-1.jpg');
    expect(images[0]?.type).toBe('image/jpeg');
    // The claim in the file header, asserted: these are the original bytes.
    expect(new Uint8Array(images[0]!.buffer)).toEqual(jpeg);
    expect(reportOfExtraction(outputs)).toContain('JPEG 5x5');

    expectMonotonicEndingAtOne(fractions);
  });

  it('wraps raw Flate pixels in a PNG that carries exactly those pixels', async () => {
    const { spec, pixels } = rgbImage(4, 3);
    const { ctx } = recorder();
    const outputs = await extractImages([await pdfWithImages([spec])], {}, ctx);

    const images = imagesFrom(outputs);
    expect(images).toHaveLength(1);
    expect(images[0]?.name).toBe('images-p1-1.png');
    expect(images[0]?.type).toBe('image/png');

    const png = readPng(images[0]!.buffer);
    expect(png).toMatchObject({ width: 4, height: 3, depth: 8, colourType: 2 });
    // Lossless is a claim about bytes, so compare bytes.
    expect(png.pixels).toEqual(pixels);
  });

  it('writes grayscale as a grayscale PNG, not a padded RGB one', async () => {
    const pixels = new Uint8Array([0, 64, 128, 255, 32, 96]);
    const spec: ImageSpec = {
      width: 3,
      height: 2,
      contents: zlibSync(pixels, { level: 6 }),
      dict: { ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode' },
    };
    const { ctx } = recorder();
    const outputs = await extractImages([await pdfWithImages([spec])], {}, ctx);

    const png = readPng(imagesFrom(outputs)[0]!.buffer);
    expect(png).toMatchObject({ width: 3, height: 2, colourType: 0 });
    expect(png.pixels).toEqual(pixels);
  });

  it('reads an ICCBased colour space through to its component count', async () => {
    // Real PDFs wrap DeviceRGB in an ICC profile constantly; refusing those
    // would gut the Flate path.
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const profile = doc.context.register(doc.context.stream(new Uint8Array([0, 1, 2]), { N: 3 }));
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const ref = doc.context.register(
      doc.context.stream(zlibSync(pixels, { level: 6 }), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 2,
        Height: 1,
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        ColorSpace: doc.context.obj(['ICCBased', profile]),
      }),
    );
    page.node.setXObject(PDFName.of('Im0'), ref);
    const saved = await doc.save();
    const buffer = new ArrayBuffer(saved.byteLength);
    new Uint8Array(buffer).set(saved);

    const { ctx } = recorder();
    const outputs = await extractImages([{ name: 'icc.pdf', type: 'application/pdf', buffer }], {}, ctx);

    const png = readPng(imagesFrom(outputs)[0]!.buffer);
    expect(png).toMatchObject({ width: 2, height: 1, colourType: 2 });
    expect(png.pixels).toEqual(pixels);
  });

  it('extracts a shared image once, named for the first page it appears on', async () => {
    const { spec } = rgbImage(4, 4);
    const input = await pdfWithImages([{ ...spec, pages: [2, 3] }], 3);
    const { ctx } = recorder();
    const outputs = await extractImages([input], {}, ctx);

    const images = imagesFrom(outputs);
    expect(images).toHaveLength(1);
    expect(images[0]?.name).toBe('images-p2-1.png');
  });

  it('refuses what it cannot honestly extract, and says why for each', async () => {
    const { spec: rgb } = rgbImage(4, 4);
    const input = await pdfWithImages([
      { width: 4, height: 4, contents: new Uint8Array([1, 2, 3]), dict: { Filter: 'JPXDecode' } },
      { width: 4, height: 4, contents: new Uint8Array([1, 2, 3]), dict: { Filter: 'CCITTFaxDecode' } },
      { width: 4, height: 4, contents: new Uint8Array([1, 2, 3]), dict: { Filter: 'JBIG2Decode' } },
      {
        width: 4,
        height: 4,
        contents: new Uint8Array([1, 2, 3]),
        dict: { Filter: 'FlateDecode', ImageMask: true, BitsPerComponent: 1 },
      },
      {
        // Predictor-encoded: pdf-lib undoes the filter but not the predictor,
        // so writing these bytes into a PNG would produce visible garbage.
        ...rgb,
        dict: {
          ...rgb.dict,
          DecodeParms: { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: 4 },
        },
      },
      {
        width: 4,
        height: 4,
        contents: new Uint8Array([1, 2, 3]),
        dict: { Filter: 'FlateDecode', BitsPerComponent: 4, ColorSpace: 'DeviceRGB' },
      },
      {
        width: 4,
        height: 4,
        contents: new Uint8Array([1, 2, 3]),
        dict: { Filter: 'FlateDecode', BitsPerComponent: 8, ColorSpace: 'DeviceCMYK' },
      },
    ]);

    const { ctx } = recorder();
    const outputs = await extractImages([input], {}, ctx);

    expect(imagesFrom(outputs)).toHaveLength(0);
    const report = reportOfExtraction(outputs);
    expect(report).toContain('it is JPEG 2000');
    expect(report).toContain('it is CCITT fax data');
    expect(report).toContain('it is JBIG2 data');
    expect(report).toContain('1-bit stencil mask');
    expect(report).toContain('predictor-encoded');
    expect(report).toContain('4 bits per component');
    expect(report).toContain('not grayscale or RGB');
    expect(report).toContain('nothing could be extracted');
  });

  it('does not write another image\'s soft mask out as a picture of its own', async () => {
    // Any RGBA PNG placed in a PDF produces this shape: an RGB image plus a
    // grayscale /SMask that would otherwise pass every check in the op.
    const { spec, pixels } = rgbImage(2, 2);
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 100]);
    const mask = doc.context.register(
      doc.context.stream(zlibSync(new Uint8Array([255, 128, 64, 0]), { level: 6 }), {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 2,
        Height: 2,
        ColorSpace: 'DeviceGray',
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
      }),
    );
    const image = doc.context.register(
      doc.context.stream(spec.contents, { Type: 'XObject', Subtype: 'Image', Width: 2, Height: 2, ...spec.dict, SMask: mask }),
    );
    page.node.setXObject(PDFName.of('Im0'), image);
    const source = await asInput(await doc.save(), 'masked.pdf');

    const { ctx } = recorder();
    const outputs = await extractImages([source], {}, ctx);

    const images = imagesFrom(outputs);
    expect(images).toHaveLength(1);
    expect(images[0]?.name).toBe('masked-p1-1.png');
    expect(readPng(images[0]!.buffer).pixels).toEqual(pixels);
    // The picture's own line still discloses that its mask was left behind.
    expect(reportOfExtraction(outputs)).toContain('extracted opaque');
  });

  it('reads a /Filter that is stored as an indirect reference', async () => {
    // Reporting "no filter" for a stream that plainly has one is the wrong
    // reason, which in this tool is the whole defect.
    const { spec, pixels } = rgbImage(2, 2);
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 100]);
    const filterRef = doc.context.register(PDFName.of('FlateDecode'));
    const image = doc.context.register(
      doc.context.stream(spec.contents, {
        Type: 'XObject',
        Subtype: 'Image',
        Width: 2,
        Height: 2,
        ColorSpace: 'DeviceRGB',
        BitsPerComponent: 8,
        Filter: filterRef,
      }),
    );
    page.node.setXObject(PDFName.of('Im0'), image);

    const { ctx } = recorder();
    const outputs = await extractImages([await asInput(await doc.save(), 'indirect.pdf')], {}, ctx);

    const images = imagesFrom(outputs);
    expect(images).toHaveLength(1);
    expect(readPng(images[0]!.buffer).pixels).toEqual(pixels);
  });

  it('extracts a stream with no filter at all, whose contents are already pixels', async () => {
    const pixels = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const spec: ImageSpec = {
      width: 2,
      height: 2,
      contents: pixels,
      dict: { ColorSpace: 'DeviceRGB', BitsPerComponent: 8 },
    };

    const { ctx } = recorder();
    const outputs = await extractImages([await pdfWithImages([spec])], {}, ctx);

    const images = imagesFrom(outputs);
    expect(images).toHaveLength(1);
    expect(readPng(images[0]!.buffer).pixels).toEqual(pixels);
  });

  it('says so, rather than failing, when a PDF holds no images at all', async () => {
    const { ctx, fractions } = recorder();
    const outputs = await extractImages([await input('small.pdf')], {}, ctx);

    expect(imagesFrom(outputs)).toHaveLength(0);
    expect(reportOfExtraction(outputs)).toContain('no embedded images found');
    expectMonotonicEndingAtOne(fractions);
  });

  it('applies the size filter, and records what it dropped', async () => {
    const { spec: small } = rgbImage(8, 8);
    const { spec: big } = rgbImage(64, 64);
    const { ctx } = recorder();
    const outputs = await extractImages([await pdfWithImages([small, big])], { minSize: 32 }, ctx);

    const images = imagesFrom(outputs);
    expect(images).toHaveLength(1);
    const png = readPng(images[0]!.buffer);
    expect(png.width).toBe(64);
    expect(reportOfExtraction(outputs)).toContain('8x8 is under the size filter');
  });

  it('raises UnsupportedFormat naming the file for a non-PDF', async () => {
    const { ctx } = recorder();
    await expectOpError(
      extractImages([await input('sample.csv', 'text/csv')], {}, ctx),
      'UnsupportedFormat',
      'sample.csv',
    );
  });

  it('raises CorruptFile naming the file for corrupt.pdf and encrypted.pdf', async () => {
    await expectOpError(extractImages([await input('corrupt.pdf')], {}, recorder().ctx), 'CorruptFile', 'corrupt.pdf');
    await expectOpError(
      extractImages([await input('encrypted.pdf')], {}, recorder().ctx),
      'CorruptFile',
      'encrypted.pdf',
    );
  });

  it.each([[{ minSize: -1 }], [{ minSize: 9000 }], [{ minSize: '64' }]])(
    'raises InvalidOptions for %j',
    async (options) => {
      await expectOpError(extractImages([await input('small.pdf')], options, recorder().ctx), 'InvalidOptions');
    },
  );

  it('raises InvalidOptions when given no files at all', async () => {
    await expectOpError(extractImages([], {}, recorder().ctx), 'InvalidOptions');
  });

  it('rejects with Cancelled when aborted mid-run', async () => {
    const { ctx, fractions } = recorder((fraction, controller) => {
      if (fraction > 0) controller.abort();
    });
    const { spec } = rgbImage(4, 4);
    await expectOpError(
      extractImages([await pdfWithImages([spec]), await pdfWithImages([spec])], {}, ctx),
      'Cancelled',
    );
    expect(fractions.at(-1)).not.toBe(1);
  });

  it('reports progress once per file, ending at exactly 1', async () => {
    const { spec } = rgbImage(4, 4);
    const { ctx, fractions } = recorder();
    await extractImages([await pdfWithImages([spec]), await pdfWithImages([spec])], {}, ctx);
    expect(fractions).toEqual([0.5, 1]);
  });
});
