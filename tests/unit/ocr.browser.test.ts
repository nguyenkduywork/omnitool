// tests/unit/ocr.browser.test.ts — browser-side tests for the `ocr` tool.
//
// Real OCR needs OffscreenCanvas, createImageBitmap, a real Worker (which
// tesseract.js spawns its OWN nested Worker from), and fetch — none of
// which exist under plain Node — so this file runs in headless Chromium
// (see vitest.workspace.ts's "browser" project). Node-side option
// validation lives in tests/unit/ocr.test.ts.
import { commands } from '@vitest/browser/context';
import { describe, expect, it } from 'vitest';

import { OpError, type OpContext, type OpInput } from '../../src/types';
import ocr from '../../src/tools/data/ocr.op';

async function fixture(name: string): Promise<ArrayBuffer> {
  const url = new URL(`../fixtures/${name}`, import.meta.url).href;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fixture ${name}: ${res.status}`);
  return res.arrayBuffer();
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

async function rejectionOf(promise: Promise<unknown>): Promise<OpError> {
  const err = await promise.then(
    () => {
      throw new Error('expected the op to reject, but it resolved');
    },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OpError);
  return err as OpError;
}

async function ocrTextImageInput(name = 'ocr-text.png'): Promise<OpInput> {
  return { name, type: 'image/png', buffer: await fixture('ocr-text.png') };
}

async function smallPdfInput(name = 'small.pdf'): Promise<OpInput> {
  return { name, type: 'application/pdf', buffer: await fixture('small.pdf') };
}

describe('ocr.op (browser): happy path', () => {
  it(
    'recognises known rendered text from a photo/image input, with monotonic progress ending at 1',
    async () => {
      const { ctx, fractions } = recorder();
      const outputs = await ocr([await ocrTextImageInput()], { languages: 'eng' }, ctx);

      expect(outputs).toHaveLength(1);
      expect(outputs[0]?.type).toBe('text/plain');
      expect(outputs[0]?.name).toBe('ocr-text.txt');

      const text = new TextDecoder().decode(outputs[0]?.buffer);
      expect(text).toContain('--- Page 1 of 1 ---');
      expect(text).toContain('OMNITOOL OCR TEST');
      // A clean, large, high-contrast render must not trip the low-
      // confidence warning — asserting its ABSENCE is as important as the
      // text itself: a tool that cries wolf on good output is dishonest too.
      expect(text).not.toContain('WARNING');
      expectMonotonicEndingAtOne(fractions);
    },
    30_000,
  );

  it(
    'rasterises a multi-page PDF and OCRs each page (its OWN rendered text, not the text layer)',
    async () => {
      // small.pdf's pages each draw the text "Page 1" / "Page 2" / "Page 3"
      // (tests/fixtures/make-fixtures.mjs). ocr.op.ts always rasterises and
      // OCRs the pixels — it never reads the PDF's text layer — so a
      // correct recognition here is real proof the pdfjs-render-to-canvas
      // path feeds real bytes into tesseract, not a shortcut.
      const { ctx, fractions } = recorder();
      const outputs = await ocr([await smallPdfInput()], { languages: 'eng', dpi: 150 }, ctx);

      expect(outputs).toHaveLength(1);
      expect(outputs[0]?.name).toBe('small.txt');
      const text = new TextDecoder().decode(outputs[0]?.buffer);
      expect(text).toContain('--- Page 1 of 3 ---');
      expect(text).toContain('--- Page 2 of 3 ---');
      expect(text).toContain('--- Page 3 of 3 ---');
      expect(text).toMatch(/Page 1/);
      expect(text).toMatch(/Page 2/);
      expect(text).toMatch(/Page 3/);
      expectMonotonicEndingAtOne(fractions);
    },
    45_000,
  );

  it(
    'only OCRs the pages selected by the "pages" option',
    async () => {
      const outputs = await ocr(
        [await smallPdfInput()],
        { languages: 'eng', dpi: 100, pages: '1' },
        recorder().ctx,
      );
      const text = new TextDecoder().decode(outputs[0]?.buffer);
      expect(text).toContain('--- Page 1 of 3 ---');
      expect(text).not.toContain('Page 2 of 3');
      expect(text).not.toContain('Page 3 of 3');
    },
    30_000,
  );

  it(
    'handles a mixed batch of a PDF and a plain image in one run',
    async () => {
      const outputs = await ocr(
        [await smallPdfInput(), await ocrTextImageInput('photo.png')],
        { languages: 'eng', dpi: 100 },
        recorder().ctx,
      );
      expect(outputs.map((o) => o.name).sort()).toEqual(['photo.txt', 'small.txt']);
    },
    45_000,
  );
});

describe('ocr.op (browser): wrong input -> correct OpErrorCode', () => {
  it('raises UnsupportedFormat, naming the file, for a type this tool does not accept', async () => {
    const bad: OpInput = {
      name: 'notes.txt',
      type: 'text/plain',
      buffer: new TextEncoder().encode('just some text').buffer,
    };
    const err = await rejectionOf(ocr([bad], {}, recorder().ctx));
    expect(err.code).toBe('UnsupportedFormat');
    expect(err.file).toBe('notes.txt');
  });

  it('raises CorruptFile, naming the file, for a PDF that fails to parse', async () => {
    const buf = await fixture('corrupt.pdf');
    const bad: OpInput = { name: 'corrupt.pdf', type: 'application/pdf', buffer: buf };
    const err = await rejectionOf(ocr([bad], {}, recorder().ctx));
    expect(err.code).toBe('CorruptFile');
    expect(err.file).toBe('corrupt.pdf');
  });

  it('raises CorruptFile, naming the file, for bytes that claim to be an image but are not', async () => {
    const bad: OpInput = {
      name: 'fake.png',
      type: 'image/png',
      buffer: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer,
    };
    const err = await rejectionOf(ocr([bad], {}, recorder().ctx));
    expect(err.code).toBe('CorruptFile');
    expect(err.file).toBe('fake.png');
  });
});

describe('ocr.op (browser): cancellation', () => {
  it(
    'rejects with Cancelled when aborted mid-run, without reaching progress 1',
    async () => {
      const { ctx, fractions } = recorder((fraction, controller) => {
        if (fraction > 0) controller.abort();
      });
      const err = await rejectionOf(
        ocr([await smallPdfInput()], { languages: 'eng', dpi: 100 }, ctx),
      );
      expect(err.code).toBe('Cancelled');
      expect(fractions.length).toBeGreaterThan(1);
      expect(fractions.at(-1)).not.toBe(1);
    },
    30_000,
  );
});

describe('ocr.op (browser): honest confidence reporting', () => {
  it(
    'prepends a low-confidence warning for an image with no real text (random noise)',
    async () => {
      // Deterministic pseudo-random noise, no characters anywhere — tesseract
      // should recognise little to nothing, at low confidence, and this op
      // must say so up front rather than handing back whatever it guessed as
      // if it were reliable.
      const canvas = document.createElement('canvas');
      canvas.width = 300;
      canvas.height = 300;
      const canvasCtx = canvas.getContext('2d');
      if (!canvasCtx) throw new Error('no 2d context');
      let seed = 42;
      const next = (): number => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed >>> 8) / 0x7fffff;
      };
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const v = Math.floor(next() * 256);
          canvasCtx.fillStyle = `rgb(${v},${v},${v})`;
          canvasCtx.fillRect(x, y, 1, 1);
        }
      }
      const blob: Blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b as Blob), 'image/png'));
      const buffer = await blob.arrayBuffer();

      const outputs = await ocr(
        [{ name: 'noise.png', type: 'image/png', buffer }],
        { languages: 'eng' },
        recorder().ctx,
      );
      const text = new TextDecoder().decode(outputs[0]?.buffer);
      expect(text).toMatch(/^WARNING: low OCR confidence/);
      expect(text).toMatch(/low-resolution, skewed, or has an unusual font or pattern/);
    },
    30_000,
  );
});

describe('ocr.op (browser): network — same-origin only, including inside the nested worker', () => {
  it(
    'issues no request during a real OCR run except same-origin ones — captured at the browser-context level, which is the only thing that can see the nested worker tesseract.js spawns',
    async () => {
      // A plain `globalThis.fetch` monkey-patch (the technique
      // tests/unit/pdf-render.browser.test.ts's "makes zero network calls"
      // test uses) CANNOT prove this: tesseract.js's language-data download
      // happens inside its OWN nested Worker, which has a wholly separate
      // global object and therefore its own, unpatched `fetch`. Verified
      // directly (see tests/helpers/network-capture.commands.ts's header)
      // that such a patch sees zero calls even while the nested worker's
      // fetch genuinely succeeds — a trap that can't see the thing it's
      // supposed to guard is worse than no trap at all. Playwright's
      // BrowserContext-level request tracking, used here via a custom
      // Vitest browser "command" running server-side, does see it.
      await commands.startCapture();

      const outputs = await ocr([await ocrTextImageInput()], { languages: 'eng' }, recorder().ctx);
      expect(new TextDecoder().decode(outputs[0]?.buffer)).toContain('OMNITOOL OCR TEST');

      const captured = await commands.getCapturedUrls();
      // Sanity: the capture actually saw something (the /ocr/ engine
      // fetches at minimum) — an empty list would mean the command wiring
      // itself is broken, which must fail loudly, not pass by accident.
      expect(captured.length).toBeGreaterThan(0);
      expect(captured.some((u) => u.includes('/ocr/'))).toBe(true);

      const origin = location.origin;
      const thirdParty = captured.filter((u) => !u.startsWith(origin) && !u.startsWith('blob:'));
      expect(thirdParty).toEqual([]);
    },
    30_000,
  );
});
