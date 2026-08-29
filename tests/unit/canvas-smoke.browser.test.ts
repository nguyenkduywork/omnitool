import { describe, expect, it } from 'vitest';

describe('browser project smoke test (OffscreenCanvas / createImageBitmap)', () => {
  it('encodes a 4x4 OffscreenCanvas to a webp blob and round-trips it via createImageBitmap', async () => {
    const canvas = new OffscreenCanvas(4, 4);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');

    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 4, 4);

    const blob = await canvas.convertToBlob({ type: 'image/webp' });

    expect(blob.type).toBe('image/webp');
    expect(blob.size).toBeGreaterThan(0);

    const bitmap = await createImageBitmap(blob);
    expect(bitmap.width).toBe(4);
    expect(bitmap.height).toBe(4);
  });
});
