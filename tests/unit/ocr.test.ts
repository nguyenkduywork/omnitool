// tests/unit/ocr.test.ts — Node-side tests for the `ocr` tool.
//
// Real OCR needs OffscreenCanvas, createImageBitmap, Worker and fetch —
// none of which exist under plain Node — so the four required-per-op tests
// (happy path, wrong input, cancellation, progress) live in
// tests/unit/ocr.browser.test.ts, which runs in headless Chromium. This
// file covers everything that must fail BEFORE any of that machinery is
// touched: option validation, and the registry/loader wiring.
import { describe, expect, it } from 'vitest';

import ocr from '../../src/tools/data/ocr.op';
import { DATA_LOADERS } from '../../src/core/workers/loaders.data';
import { DATA_TOOLS } from '../../src/core/registry.data';
import { OCR_LANGUAGE_CODES, OCR_LANGUAGES } from '../../src/tools/data/ocr-languages';
import type { OpContext, OpInput } from '../../src/types';
import { OpError } from '../../src/types';

function ctx(signal: AbortSignal = new AbortController().signal): { ctx: OpContext; seen: number[] } {
  const seen: number[] = [];
  return { seen, ctx: { onProgress: (f: number) => seen.push(f), signal } };
}

function pdfLikeInput(name = 'x.pdf'): OpInput {
  return { name, type: 'application/pdf', buffer: new TextEncoder().encode('%PDF-1.4\nnope').buffer };
}

async function expectOpError(promise: Promise<unknown>, code: string): Promise<OpError> {
  const err = await promise.then(
    () => {
      throw new Error('expected the op to reject, but it resolved');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OpError);
  expect((err as OpError).code).toBe(code);
  return err as OpError;
}

describe('ocr registry entry', () => {
  it('is registered with the exact shape the spec calls for', () => {
    const tool = DATA_TOOLS.find((t) => t.id === 'ocr');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('Scan to text');
    expect(tool?.blurb).toBe('Read text from scanned PDFs and photos, using OCR.');
    expect(tool?.group).toBe('data');
    expect(tool?.accepts).toEqual(['application/pdf', 'image/*']);
    expect(tool?.minInputs).toBe(1);
    expect(tool?.maxInputs).toBeNull();
    expect(typeof tool?.editor).toBe('function');
    expect(typeof tool?.load).toBe('function');
  });

  it('is present in the worker id -> loader map', () => {
    expect(typeof DATA_LOADERS['ocr']).toBe('function');
  });

  it('default language is a supported code', () => {
    expect(OCR_LANGUAGE_CODES.has('eng')).toBe(true);
    // Every vendored language actually has a name (used by the editor).
    for (const lang of OCR_LANGUAGES) {
      expect(lang.name.length).toBeGreaterThan(0);
    }
  });
});

describe('ocr option validation (fails before touching any engine)', () => {
  it('rejects an empty input list', async () => {
    await expectOpError(ocr([], {}, ctx().ctx), 'InvalidOptions');
  });

  it('rejects a non-string languages option', async () => {
    await expectOpError(ocr([pdfLikeInput()], { languages: 42 }, ctx().ctx), 'InvalidOptions');
  });

  it('rejects an empty languages string', async () => {
    await expectOpError(ocr([pdfLikeInput()], { languages: '   ' }, ctx().ctx), 'InvalidOptions');
  });

  it('rejects an unsupported language code, naming it', async () => {
    const err = await expectOpError(
      ocr([pdfLikeInput()], { languages: 'klingon' }, ctx().ctx),
      'InvalidOptions',
    );
    expect(err.message).toContain('klingon');
  });

  it('rejects one bad code even when combined with a supported one ("eng+klingon")', async () => {
    await expectOpError(ocr([pdfLikeInput()], { languages: 'eng+klingon' }, ctx().ctx), 'InvalidOptions');
  });

  // Explicit tuple type: these rows' `dpi` values have different runtime
  // types (number vs. string), which otherwise infers as a union of tuples
  // rather than one consistent tuple — see pdf.test.ts's it.each calls for
  // the same note.
  it.each<[Record<string, unknown>, string]>([
    [{ dpi: 0 }, 'below range'],
    [{ dpi: 601 }, 'above range'],
    [{ dpi: Number.NaN }, 'NaN'],
    [{ dpi: '300' }, 'a non-numeric dpi'],
  ])('rejects dpi %j (%s)', async (options) => {
    await expectOpError(ocr([pdfLikeInput()], options, ctx().ctx), 'InvalidOptions');
  });

  it('rejects a non-string pages option', async () => {
    await expectOpError(ocr([pdfLikeInput()], { pages: 3 }, ctx().ctx), 'InvalidOptions');
  });

  it('raises EncoderUnavailable under Node, where OffscreenCanvas/createImageBitmap do not exist', async () => {
    expect(typeof OffscreenCanvas).not.toBe('function');
    await expectOpError(ocr([pdfLikeInput()], {}, ctx().ctx), 'EncoderUnavailable');
  });
});
