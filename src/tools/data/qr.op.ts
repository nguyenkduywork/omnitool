// src/tools/data/qr.op.ts
//
// qr-generate — turns text/a URL into a QR code.
//
// Both output formats share the same source of truth: qrcode's `create()`
// matrix/segments API (pure JS, no canvas or fs dependency at that layer).
//   - SVG is built as a plain string directly from the module matrix — fully
//     synchronous and node-testable (see tests/unit/data.test.ts).
//   - PNG rasterises that same matrix onto an OffscreenCanvas, which does not
//     exist under Node — that path is exercised only in the real-browser
//     test tests/unit/data-qr.browser.test.ts.

import { create as createQrMatrix } from 'qrcode';

import { OpError } from '../../types.js';
import type { Op, OpOutput } from '../../types.js';

// `qrcode` is typed via the ambient shim in ./qrcode.d.ts (module ships no
// types of its own). Narrow the one call we make to createQrMatrix() here.
type QrMatrixResult = { modules: { size: number; data: Uint8Array } };

type Format = 'png' | 'svg';

const MODULE_MARGIN = 4; // modules of whitespace border, matches qrcode's own default margin

function buildSvg(moduleData: Uint8Array, moduleSize: number, pixelSize: number): string {
  const total = moduleSize + MODULE_MARGIN * 2;
  let rects = '';
  for (let row = 0; row < moduleSize; row++) {
    for (let col = 0; col < moduleSize; col++) {
      if (moduleData[row * moduleSize + col]) {
        rects += `<rect x="${col + MODULE_MARGIN}" y="${row + MODULE_MARGIN}" width="1" height="1"/>`;
      }
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges">` +
    `<rect x="0" y="0" width="${total}" height="${total}" fill="#ffffff"/>` +
    `<g fill="#000000">${rects}</g></svg>`
  );
}

/**
 * Rasterises the QR module matrix onto an OffscreenCanvas and encodes PNG.
 * Only reachable when format === 'png', which is only exercised in the
 * browser test project (tests/unit/data-qr.browser.test.ts) — OffscreenCanvas
 * does not exist under plain Node.
 */
async function buildPng(moduleData: Uint8Array, moduleSize: number, pixelSize: number): Promise<ArrayBuffer> {
  if (typeof OffscreenCanvas === 'undefined') {
    throw new OpError('EncoderUnavailable', 'PNG rendering requires OffscreenCanvas, unavailable in this environment');
  }
  const total = moduleSize + MODULE_MARGIN * 2;
  const scale = pixelSize / total;

  const canvas = new OffscreenCanvas(pixelSize, pixelSize);
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) {
    throw new OpError('EncoderUnavailable', 'could not acquire a 2D OffscreenCanvas context');
  }

  ctx2d.fillStyle = '#ffffff';
  ctx2d.fillRect(0, 0, pixelSize, pixelSize);
  ctx2d.fillStyle = '#000000';
  for (let row = 0; row < moduleSize; row++) {
    for (let col = 0; col < moduleSize; col++) {
      if (moduleData[row * moduleSize + col]) {
        ctx2d.fillRect((col + MODULE_MARGIN) * scale, (row + MODULE_MARGIN) * scale, scale, scale);
      }
    }
  }

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  if (blob.type !== 'image/png') {
    throw new OpError('EncoderUnavailable', `PNG encoder unavailable — got ${blob.type}`);
  }
  return blob.arrayBuffer();
}

const VALID_FORMATS: Format[] = ['png', 'svg'];

const qrGenerateOp: Op = async (_inputs, options, ctx) => {
  if (ctx.signal.aborted) throw new OpError('Cancelled', 'qr-generate cancelled');

  const rawText = options.text;
  const text = rawText === undefined ? '' : rawText;
  if (typeof text !== 'string' || text.length === 0) {
    throw new OpError('InvalidOptions', 'text is required to generate a QR code');
  }

  const rawFormat = options.format;
  const format = rawFormat === undefined ? 'png' : rawFormat;
  if (typeof format !== 'string' || !VALID_FORMATS.includes(format as Format)) {
    throw new OpError('InvalidOptions', `format must be one of ${VALID_FORMATS.join(', ')}, got ${JSON.stringify(rawFormat)}`);
  }
  const resolvedFormat: Format = format as Format;

  const rawSize = options.size;
  const size = rawSize === undefined ? 512 : rawSize;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 128 || size > 1024) {
    throw new OpError('InvalidOptions', `size must be an integer between 128 and 1024, got ${JSON.stringify(rawSize)}`);
  }

  ctx.onProgress(0);

  let matrix: { size: number; data: Uint8Array };
  try {
    const qr = createQrMatrix(text) as QrMatrixResult;
    matrix = qr.modules;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/too big/i.test(message)) {
      throw new OpError('TooLarge', `text is too long to encode as a QR code: ${message}`);
    }
    throw new OpError('InvalidOptions', `could not generate QR code: ${message}`);
  }

  // Deliberate yield: gives an in-flight cancellation a real point to land on
  // even for the fully-synchronous SVG path (see tests/unit/data.test.ts).
  await Promise.resolve();
  if (ctx.signal.aborted) throw new OpError('Cancelled', 'qr-generate cancelled');
  ctx.onProgress(0.5);

  let output: OpOutput;
  if (resolvedFormat === 'svg') {
    const svg = buildSvg(matrix.data, matrix.size, size);
    output = { name: 'qr.svg', type: 'image/svg+xml', buffer: new TextEncoder().encode(svg).buffer };
  } else {
    const buffer = await buildPng(matrix.data, matrix.size, size);
    output = { name: 'qr.png', type: 'image/png', buffer };
  }

  if (ctx.signal.aborted) throw new OpError('Cancelled', 'qr-generate cancelled');
  ctx.onProgress(1);

  return [output];
};

export default qrGenerateOp;
