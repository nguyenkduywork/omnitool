import { readFile } from 'node:fs/promises';
import { PDFArray, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream, degrees } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { PDF_TOOLS } from '../../src/core/registry.pdf';
import { PDF_LOADERS } from '../../src/core/workers/loaders.pdf';
import { OpError, type OpContext, type OpInput } from '../../src/types';

async function run(inputs: OpInput[], options: Record<string, unknown> = {}, ctx = context().ctx) {
  const loader = PDF_LOADERS['pdf-watermark'];
  expect(loader).toBeTypeOf('function');
  return (await loader!()).default(inputs, options, ctx);
}

function context(onProgress?: (value: number, controller: AbortController) => void) {
  const controller = new AbortController();
  const progress: number[] = [];
  const ctx: OpContext = {
    signal: controller.signal,
    onProgress(value) {
      progress.push(value);
      onProgress?.(value, controller);
    },
  };
  return { ctx, progress, controller };
}

async function source(name = 'report.pdf', rotation = 0): Promise<OpInput> {
  const doc = await PDFDocument.create();
  doc.setTitle('Original title');
  doc.setAuthor('Original author');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const size of [[400, 600], [600, 400]]) {
    const page = doc.addPage(size as [number, number]);
    page.setRotation(degrees(rotation));
    page.drawText('Original page text', { x: 45, y: 90, font, size: 12 });
  }
  return { name, type: 'application/pdf', buffer: Uint8Array.from(await doc.save()).buffer };
}

function content(doc: PDFDocument, index: number): string {
  const value = doc.getPage(index).node.lookup(PDFName.of('Contents'));
  const streams = value instanceof PDFArray ? value.asArray() : [value];
  return streams.map((ref) => {
    const stream = doc.context.lookup(ref);
    expect(stream).toBeInstanceOf(PDFRawStream);
    return new TextDecoder().decode(decodePDFRawStream(stream as PDFRawStream).decode());
  }).join('\n');
}

describe('PDF text watermarks', () => {
  it('is available as a batch PDF tool with a worker loader and usable defaults', async () => {
    const tool = PDF_TOOLS.find((entry) => entry.id === 'pdf-watermark');
    expect(tool).toMatchObject({
      name: 'Watermark PDF', accepts: ['application/pdf'], minInputs: 1, maxInputs: null,
    });
    expect(PDF_LOADERS['pdf-watermark']).toBeTypeOf('function');
    expect(tool?.options?.text?.default).toBe('CONFIDENTIAL');
    const outputs = await (await tool!.load()).default([await source()], {}, context().ctx);
    expect(outputs).toHaveLength(1);
  });

  it('adds text to every page while preserving content, page sizes, metadata, and the source bytes', async () => {
    const input = await source();
    const originalBytes = input.buffer.slice(0);
    const original = await PDFDocument.load(originalBytes);
    const [output] = await run([input], { text: 'DRAFT' });
    expect(output).toMatchObject({ name: 'report-watermarked.pdf', type: 'application/pdf' });
    const result = await PDFDocument.load(output!.buffer);
    expect(result.getPageCount()).toBe(2);
    expect(result.getTitle()).toBe('Original title');
    expect(result.getAuthor()).toBe('Original author');
    for (let i = 0; i < 2; i++) {
      expect(result.getPage(i).getSize()).toEqual(original.getPage(i).getSize());
      expect(content(result, i)).toContain('<4452414654> Tj');
      expect(content(result, i)).toContain('<4F726967696E616C20706167652074657874> Tj');
    }
    expect(input.buffer).toEqual(originalBytes);
  });

  it.each(['diagonal', 'center', 'top-left', 'top-right', 'bottom-left', 'bottom-right'])(
    'draws the requested %s placement on cropped, rotated pages', async (position) => {
      const input = await source('cropped.pdf', 90);
      const doc = await PDFDocument.load(input.buffer);
      doc.getPages().forEach((page) => page.setCropBox(25, 40, 300, 300));
      input.buffer = Uint8Array.from(await doc.save()).buffer;
      const [output] = await run([input], { text: 'DRAFT', position });
      const result = await PDFDocument.load(output!.buffer);
      for (let i = 0; i < 2; i++) {
        expect(result.getPage(i).getRotation().angle).toBe(90);
        expect(result.getPage(i).getCropBox()).toEqual({ x: 25, y: 40, width: 300, height: 300 });
        expect(content(result, i)).toContain('<4452414654> Tj');
      }
    },
  );

  it('fits a long single-line label without splitting it across lines', async () => {
    const [output] = await run([await source()], { text: 'CONFIDENTIAL '.repeat(30), size: 25, position: 'center' });
    const result = await PDFDocument.load(output!.buffer);
    const commands = content(result, 0);
    const fontSize = Number([...commands.matchAll(/\/Helvetica-Bold[^\s]* ([\d.]+) Tf/g)].at(-1)?.[1]);
    const font = await result.embedFont(StandardFonts.HelveticaBold);
    expect(fontSize).toBeGreaterThan(0);
    expect(font.widthOfTextAtSize('CONFIDENTIAL '.repeat(30).trim(), fontSize)).toBeLessThanOrEqual(368.001);
  });

  it('produces separate named outputs for a batch and reports monotonic progress ending at one', async () => {
    const { ctx, progress } = context();
    const outputs = await run([await source('first.pdf'), await source('second.PDF')], {}, ctx);
    expect(outputs.map((output) => output.name)).toEqual(['first-watermarked.pdf', 'second-watermarked.pdf']);
    expect(progress.length).toBeGreaterThanOrEqual(4);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((value, i) => value >= 0 && value <= 1 && (i === 0 || value >= progress[i - 1]!))).toBe(true);
  });

  it.each(['corrupt.pdf', 'encrypted.pdf'])('names %s in a typed parse error', async (name) => {
    const bytes = await readFile(new URL(`../fixtures/${name}`, import.meta.url));
    await expect(run([{ name, type: 'application/pdf', buffer: Uint8Array.from(bytes).buffer }]))
      .rejects.toMatchObject({ name: 'OpError', code: 'CorruptFile', file: name });
  });

  it('rejects non-PDF bytes with a named UnsupportedFormat error', async () => {
    await expect(run([{ name: 'notes.txt', type: 'text/plain', buffer: new TextEncoder().encode('hello').buffer }]))
      .rejects.toMatchObject({ code: 'UnsupportedFormat', file: 'notes.txt' });
  });

  it.each([
    { text: '' }, { text: '   ' }, { text: 42 }, { text: 'two\nlines' }, { text: 'DRAFT\tCOPY' },
    { text: '\u4f60\u597d' }, { text: '\ud83d\udd12' }, { position: 'tile' }, { colour: 'blue' },
    { size: 0 }, { size: 26 }, { size: '8' }, { size: Number.NaN },
    { opacity: 0 }, { opacity: 101 }, { opacity: Number.POSITIVE_INFINITY },
  ])('raises InvalidOptions for %j', async (options) => {
    await expect(run([await source()], options)).rejects.toMatchObject({ name: 'OpError', code: 'InvalidOptions' });
  });

  it('rejects an empty batch', async () => {
    await expect(run([])).rejects.toMatchObject({ code: 'InvalidOptions' });
  });

  it('cancels between pages without reporting completion', async () => {
    const { ctx, progress } = context((value, controller) => { if (value > 0) controller.abort(); });
    await expect(run([await source()], {}, ctx)).rejects.toMatchObject({ code: 'Cancelled' });
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toBeLessThan(1);
  });

  it('honours an already aborted signal', async () => {
    const { ctx, controller, progress } = context();
    controller.abort();
    const error = await run([await source()], {}, ctx).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(OpError);
    expect(error).toMatchObject({ code: 'Cancelled' });
    expect(progress).toEqual([]);
  });
});
