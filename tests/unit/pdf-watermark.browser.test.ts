import { PDFDocument, degrees } from 'pdf-lib';
import { getDocument } from 'pdfjs-dist';
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import { describe, expect, it } from 'vitest';

import { type OpContext, type OpInput } from '../../src/types';
import watermark from '../../src/tools/pdf/watermark.op';

function context(): OpContext {
  return { signal: new AbortController().signal, onProgress: () => {} };
}

async function rotatedPages(): Promise<OpInput> {
  const doc = await PDFDocument.create();
  for (const rotation of [0, 90, 180, 270]) {
    const page = doc.addPage([300, 400]);
    page.setCropBox(40, 30, 160, 240);
    page.setRotation(degrees(rotation));
  }
  return { name: 'rotated.pdf', type: 'application/pdf', buffer: Uint8Array.from(await doc.save()).buffer };
}

// Render independently of the app's rasterizer, with standard-font substitution
// enabled as in a normal PDF viewer. No CDN or font fetch is needed.
Object.assign(globalThis, { pdfjsWorker });

async function renderedPages(buffer: ArrayBuffer): Promise<OffscreenCanvas[]> {
  const doc = await getDocument({
    data: new Uint8Array(buffer.slice(0)), isEvalSupported: false,
    disableFontFace: false, useSystemFonts: true,
  }).promise;
  try {
    const canvases: OffscreenCanvas[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = new OffscreenCanvas(viewport.width, viewport.height);
      await page.render({
        canvasContext: canvas.getContext('2d') as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
      canvases.push(canvas);
    }
    return canvases;
  } finally {
    await doc.destroy();
  }
}

/** Measure actual ink after an independent PDF.js renderer paints the output. */
function inkBounds(canvas: OffscreenCanvas) {
  const { width, height } = canvas;
  const ctx = canvas.getContext('2d')!;
  const pixels = ctx.getImageData(0, 0, width, height).data;
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4]! >= 245) continue;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  expect(right).toBeGreaterThan(left);
  expect(bottom).toBeGreaterThan(top);
  return { left, right, top, bottom, width, height };
}

describe('PDF watermark rendered placement', () => {
  it.each(['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center', 'diagonal'])(
    'places %s text in the visible crop for every quarter-turn rotation', async (position) => {
      const [output] = await watermark([await rotatedPages()], {
        text: 'DRAFT', position, colour: 'black', opacity: 100,
      }, context());
      const rendered = await renderedPages(output!.buffer);
      expect(rendered).toHaveLength(4);
      for (const image of rendered) {
        const bounds = inkBounds(image);
        const x = (bounds.left + bounds.right) / 2 / bounds.width;
        const y = (bounds.top + bounds.bottom) / 2 / bounds.height;
        expect(bounds.left).toBeGreaterThan(0);
        expect(bounds.top).toBeGreaterThan(0);
        expect(bounds.right).toBeLessThan(bounds.width - 1);
        expect(bounds.bottom).toBeLessThan(bounds.height - 1);
        if (position.endsWith('left')) expect(x).toBeLessThan(0.4);
        else if (position.endsWith('right')) expect(x).toBeGreaterThan(0.6);
        else expect(x).toBeCloseTo(0.5, 1);
        if (position.startsWith('top')) expect(y).toBeLessThan(0.2);
        else if (position.startsWith('bottom')) expect(y).toBeGreaterThan(0.8);
        else expect(y).toBeCloseTo(0.5, 1);
      }
    },
  );

  it('renders the default watermark visibly on every page', async () => {
    const [output] = await watermark([await rotatedPages()], {}, context());
    const rendered = await renderedPages(output!.buffer);
    for (const image of rendered) inkBounds(image);
  });
});
