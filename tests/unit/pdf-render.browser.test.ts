import { describe, expect, it } from 'vitest';

import { OpError, type OpContext, type OpInput } from '../../src/types';
import toImages from '../../src/tools/pdf/to-images.op';

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

async function smallPdfInput(): Promise<OpInput> {
  return { name: 'small.pdf', type: 'application/pdf', buffer: await fixture('small.pdf') };
}

/** Decode an output's real pixel dimensions — proof the bytes are what the mime claims. */
async function decodedSize(buffer: ArrayBuffer, mime: string): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(new Blob([buffer], { type: mime }));
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

describe('pdf-to-images.op (browser)', () => {
  // small.pdf's pages are 200x200pt (see tests/fixtures/make-fixtures.mjs);
  // this is the same ceil(pt * dpi/72) math to-images.op.ts itself applies.
  function expectedPx(dpi: number): number {
    return Math.ceil(200 * (dpi / 72));
  }

  it('makes zero network calls while rasterising — the pdfjs worker is bundled, never fetched from a CDN', async () => {
    // This runs first in the file, deliberately: it's the first call to toImages
    // anywhere in this suite, so it's the one that actually exercises the
    // dynamic import()s inside to-images.op.ts's loadPdfjs() under the trap,
    // not a cached no-op from an earlier test.
    const preloaded = await smallPdfInput(); // fetch the fixture BEFORE trapping fetch
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((...args: unknown[]) => {
      throw new Error(`NETWORK CALL ${String(args[0])}`);
    }) as unknown as typeof fetch;
    try {
      const { ctx } = recorder();
      const outputs = await toImages([preloaded], { format: 'png', dpi: 150 }, ctx);
      expect(outputs).toHaveLength(3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('rasterises a 3-page PDF into 3 outputs with correct mime, real dimensions, and monotonic progress (happy path)', async () => {
    const { ctx, fractions } = recorder();
    const outputs = await toImages([await smallPdfInput()], { format: 'png', dpi: 150 }, ctx);

    expect(outputs).toHaveLength(3);
    expect(outputs.map((o) => o.name)).toEqual(['small-p1.png', 'small-p2.png', 'small-p3.png']);
    for (const output of outputs) {
      expect(output.type).toBe('image/png');
      const size = await decodedSize(output.buffer, output.type);
      expect(size.width).toBe(expectedPx(150));
      expect(size.height).toBe(expectedPx(150));
    }
    expectMonotonicEndingAtOne(fractions);
  });

  it('encodes real JPEG bytes when format is "jpeg"', async () => {
    const { ctx } = recorder();
    const outputs = await toImages([await smallPdfInput()], { format: 'jpeg', dpi: 150 }, ctx);

    expect(outputs).toHaveLength(3);
    for (const output of outputs) {
      expect(output.type).toBe('image/jpeg');
      expect(output.name.endsWith('.jpg')).toBe(true);
      const size = await decodedSize(output.buffer, output.type);
      expect(size.width).toBe(expectedPx(150));
    }
  });

  it('scales real decoded pixel dimensions with the dpi option', async () => {
    const low = await toImages([await smallPdfInput()], { format: 'png', dpi: 72 }, recorder().ctx);
    const high = await toImages([await smallPdfInput()], { format: 'png', dpi: 288 }, recorder().ctx);

    const lowSize = await decodedSize((low[0] as { buffer: ArrayBuffer }).buffer, 'image/png');
    const highSize = await decodedSize((high[0] as { buffer: ArrayBuffer }).buffer, 'image/png');

    expect(lowSize.width).toBe(expectedPx(72));
    expect(highSize.width).toBe(expectedPx(288));
    // 288 is exactly 4x72, and 200 * 4 has no rounding remainder, so this is exact.
    expect(highSize.width).toBe(lowSize.width * 4);
    expect(highSize.height).toBe(lowSize.height * 4);
  });

  it('rejects with Cancelled when aborted mid-run, without reaching progress 1', async () => {
    const { ctx, fractions } = recorder((fraction, controller) => {
      if (fraction > 0) controller.abort();
    });
    const err = await toImages([await smallPdfInput()], { format: 'png', dpi: 150 }, ctx).then(
      () => {
        throw new Error('expected the op to reject, but it resolved');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OpError);
    expect((err as OpError).code).toBe('Cancelled');
    expect(fractions.length).toBeGreaterThan(1);
    expect(fractions.at(-1)).not.toBe(1);
  });
});

describe('pdf-to-images.op (browser): worker-less pdfjs mechanism proof', () => {
  it('loads a fixture', async () => {
    const buf = await fixture('small.pdf');
    expect(buf.byteLength).toBeGreaterThan(100);
    expect(new TextDecoder().decode(new Uint8Array(buf).slice(0, 5))).toBe('%PDF-');
  });

  it('renders a page with worker-less pdfjs into an OffscreenCanvas', async () => {
    globalThis.fetch = ((...args: unknown[]) => {
      throw new Error(`NETWORK CALL ${String(args[0])}`);
    }) as unknown as typeof fetch;
    const workerMod = await import('pdfjs-dist/build/pdf.worker.mjs');
    (globalThis as unknown as { pdfjsWorker: unknown }).pdfjsWorker = workerMod;
    const pdfjs = await import('pdfjs-dist/build/pdf.mjs');

    class OffscreenCanvasFactory {
      constructor(_opts: unknown) {}
      create(width: number, height: number) {
        const canvas = new OffscreenCanvas(width, height);
        return { canvas, context: canvas.getContext('2d') };
      }
      reset(cc: { canvas: OffscreenCanvas }, width: number, height: number) {
        cc.canvas.width = width;
        cc.canvas.height = height;
      }
      destroy(cc: { canvas: OffscreenCanvas | null }) {
        cc.canvas = null;
      }
    }
    class NoopFilterFactory {
      addFilter() {
        return 'none';
      }
      addHCMFilter() {
        return 'none';
      }
      addAlphaFilter() {
        return 'none';
      }
      addLuminosityFilter() {
        return 'none';
      }
      addHighlightHCMFilter() {
        return 'none';
      }
      destroy() {}
    }

    // small.pdf is 200x200 with text; also build one with a solid rect so we can
    // assert real ink without depending on standard-font data.
    const { PDFDocument, rgb } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([100, 50]);
    page.drawRectangle({ x: 0, y: 0, width: 100, height: 50, color: rgb(1, 0, 0) });
    const bytes = await doc.save();

    const task = pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      CanvasFactory: OffscreenCanvasFactory as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      FilterFactory: NoopFilterFactory as any,
    });
    const pdf = await task.promise;
    expect(pdf.numPages).toBe(1);
    const p = await pdf.getPage(1);
    const viewport = p.getViewport({ scale: 2 });
    expect(viewport.width).toBe(200);
    expect(viewport.height).toBe(100);

    const canvas = new OffscreenCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no ctx');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await p.render({ canvasContext: ctx as any, viewport } as any).promise;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const px = [data[0], data[1], data[2], data[3]];
    console.log('pixel at 0,0 =', px.join(','));
    expect(px[0]).toBeGreaterThan(200);
    expect(px[1]).toBeLessThan(60);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    expect(blob.type).toBe('image/png');
    await pdf.destroy();
  });
});
