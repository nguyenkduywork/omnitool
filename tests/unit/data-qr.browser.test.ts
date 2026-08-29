// tests/unit/data-qr.browser.test.ts
//
// qr-generate's PNG path rasterises onto an OffscreenCanvas, which does not
// exist under plain Node — so this file follows the *.browser.test.ts
// convention for the vitest browser project (headless Chromium) that a
// concurrent task is wiring up. If that project isn't picked up yet, every
// test below is skipped (via skipIf) rather than failing under the node
// project, which would otherwise try to run this file too and hit a
// ReferenceError on OffscreenCanvas.

import { describe, expect, it } from 'vitest';

import { OpError } from '../../src/types';
import type { OpContext, OpInput } from '../../src/types';

import qrGenerate from '../../src/tools/data/qr.op';

const hasOffscreenCanvas = typeof OffscreenCanvas !== 'undefined';

function makeCtx(signal = new AbortController().signal): OpContext & { progress: number[] } {
  const progress: number[] = [];
  return {
    signal,
    progress,
    onProgress(fraction: number) {
      progress.push(fraction);
    },
  };
}

describe.skipIf(!hasOffscreenCanvas)('qr-generate (PNG / OffscreenCanvas path)', () => {
  it('generates a real PNG at the requested size (happy path)', async () => {
    const outputs = await qrGenerate([] as OpInput[], { text: 'hello omnitool', format: 'png', size: 256 }, makeCtx());
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.name).toBe('qr.png');
    expect(outputs[0]?.type).toBe('image/png');

    const bytes = new Uint8Array(outputs[0]!.buffer);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('rejects an unknown format with InvalidOptions', async () => {
    await expect(qrGenerate([], { text: 'hi', format: 'gif', size: 256 }, makeCtx())).rejects.toMatchObject({
      code: 'InvalidOptions',
    });
  });

  it('cancels part-way through via AbortSignal', async () => {
    const controller = new AbortController();
    const ctx = makeCtx(controller.signal);

    const promise = qrGenerate([], { text: 'hello', format: 'png', size: 256 }, ctx);
    controller.abort();

    await expect(promise).rejects.toBeInstanceOf(OpError);
    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' });
  });

  it('reports monotonic progress ending at 1', async () => {
    const ctx = makeCtx();
    await qrGenerate([], { text: 'hello', format: 'png', size: 256 }, ctx);
    expect(ctx.progress.length).toBeGreaterThan(0);
    for (let i = 1; i < ctx.progress.length; i++) {
      expect(ctx.progress[i]).toBeGreaterThanOrEqual(ctx.progress[i - 1] as number);
    }
    expect(ctx.progress[ctx.progress.length - 1]).toBe(1);
  });
});
