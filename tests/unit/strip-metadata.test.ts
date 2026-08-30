// tests/unit/strip-metadata.test.ts
//
// image-strip-metadata. This op is pure byte surgery — no canvas, no decoding
// — so it is tested under plain Node, and the assertions are about bytes:
// the metadata block is gone, and everything else in the file is untouched.
//
// The fixtures genuinely carry what is being removed (see make-fixtures.mjs):
// exif.jpg has an EXIF record with GPS coordinates written by libvips,
// meta.png has tEXt and eXIf chunks, meta.webp is a VP8X file with EXIF and
// XMP chunks and the flag bits that advertise them.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { OpError } from '../../src/types';
import type { OpContext, OpInput, OpOutput } from '../../src/types';

import { IMAGE_TOOLS } from '../../src/core/registry.image';
import { IMAGE_LOADERS } from '../../src/core/workers/loaders.image';
import stripMetadata from '../../src/tools/image/strip-metadata.op';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function loadFixture(name: string, type: string): OpInput {
  const buf = readFileSync(path.join(FIXTURES_DIR, name));
  return { name, type, buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}

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

function assertMonotonicEndingAtOne(progress: number[]): void {
  expect(progress.length).toBeGreaterThan(0);
  for (let i = 1; i < progress.length; i++) {
    expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1] as number);
  }
  expect(progress[progress.length - 1]).toBe(1);
}

async function expectOpError(promise: Promise<unknown>, code: string): Promise<OpError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(OpError);
    expect((e as OpError).code).toBe(code);
    return e as OpError;
  }
  throw new Error('expected promise to reject with an OpError, but it resolved');
}

/** True when `text` appears anywhere in `buffer` as raw bytes. */
function contains(buffer: ArrayBuffer, text: string): boolean {
  const bytes = new Uint8Array(buffer);
  const needle = [...text].map((c) => c.charCodeAt(0));
  outer: for (let at = 0; at + needle.length <= bytes.length; at++) {
    for (let i = 0; i < needle.length; i++) {
      if (bytes[at + i] !== needle[i]) continue outer;
    }
    return true;
  }
  return false;
}

function pngChunkTypes(buffer: ArrayBuffer): string[] {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const types: string[] = [];
  let at = 8;
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at);
    types.push(String.fromCharCode(...bytes.subarray(at + 4, at + 8)));
    at += 12 + length;
  }
  return types;
}

function outputNamed(outputs: OpOutput[], name: string): OpOutput {
  const found = outputs.find((output) => output.name === name);
  if (!found) throw new Error(`no output named ${name} (got ${outputs.map((o) => o.name).join(', ')})`);
  return found;
}

function reportText(outputs: OpOutput[]): string {
  return new TextDecoder().decode(outputNamed(outputs, 'metadata-report.txt').buffer);
}

/** exif.jpg with an ICC_PROFILE APP2 segment spliced in after SOI. */
function withIccSegment(input: OpInput): OpInput {
  const source = new Uint8Array(input.buffer);
  const marker = new TextEncoder().encode('ICC_PROFILE\0');
  const profile = new Uint8Array(16).fill(0x2a);
  const payloadLength = marker.length + profile.length;

  const segment = new Uint8Array(payloadLength + 4);
  segment[0] = 0xff;
  segment[1] = 0xe2;
  segment[2] = ((payloadLength + 2) >> 8) & 0xff;
  segment[3] = (payloadLength + 2) & 0xff;
  segment.set(marker, 4);
  segment.set(profile, 4 + marker.length);

  const out = new Uint8Array(source.length + segment.length);
  out.set(source.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(source.subarray(2), 2 + segment.length);
  return { name: 'icc.jpg', type: 'image/jpeg', buffer: out.buffer };
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

describe('image-strip-metadata: JPEG', () => {
  it('removes the EXIF record, GPS and all, leaving the scan untouched (happy path)', async () => {
    const input = loadFixture('exif.jpg', 'image/jpeg');
    expect(contains(input.buffer, 'Exif\0\0')).toBe(true);
    expect(contains(input.buffer, 'Fixture Camera')).toBe(true);

    const outputs = await stripMetadata([input], {}, makeCtx());
    const stripped = outputNamed(outputs, 'exif.jpg');

    expect(contains(stripped.buffer, 'Exif\0\0')).toBe(false);
    expect(contains(stripped.buffer, 'Fixture Camera')).toBe(false);
    expect(stripped.type).toBe('image/jpeg');

    // The file still starts with SOI and still ends with the same entropy-coded
    // scan: only the APP1 segment in between is gone.
    const before = new Uint8Array(input.buffer);
    const after = new Uint8Array(stripped.buffer);
    expect(after.subarray(0, 2)).toEqual(new Uint8Array([0xff, 0xd8]));
    // exif.jpg's APP1 is its first segment; its declared length + the 2 marker
    // bytes is exactly what removal costs.
    const app1Length = ((before[4] as number) << 8) | (before[5] as number);
    expect(after.length).toBe(before.length - (app1Length + 2));
    expect(after.subarray(after.length - 128)).toEqual(before.subarray(before.length - 128));
  });

  it('keeps the ICC colour profile by default and removes it on request', async () => {
    const withIcc = withIccSegment(loadFixture('exif.jpg', 'image/jpeg'));
    expect(contains(withIcc.buffer, 'ICC_PROFILE')).toBe(true);

    const kept = await stripMetadata([withIcc], {}, makeCtx());
    expect(contains(outputNamed(kept, 'icc.jpg').buffer, 'ICC_PROFILE')).toBe(true);
    expect(reportText(kept)).toContain('kept the ICC colour profile');

    const dropped = await stripMetadata([withIcc], { keepColorProfile: false }, makeCtx());
    expect(contains(outputNamed(dropped, 'icc.jpg').buffer, 'ICC_PROFILE')).toBe(false);
    expect(reportText(dropped)).toContain('ICC colour profile');
  });

  it('raises CorruptFile naming the file for a JPEG that ends inside a segment', async () => {
    const input = loadFixture('exif.jpg', 'image/jpeg');
    const truncated = { ...input, name: 'cut.jpg', buffer: input.buffer.slice(0, 40) };

    const error = await expectOpError(stripMetadata([truncated], {}, makeCtx()), 'CorruptFile');
    expect(error.file).toBe('cut.jpg');
  });
});

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

describe('image-strip-metadata: PNG', () => {
  it('drops text and eXIf chunks while keeping image data (happy path)', async () => {
    const input = loadFixture('meta.png', 'image/png');
    expect(pngChunkTypes(input.buffer)).toEqual(expect.arrayContaining(['tEXt', 'eXIf']));

    const outputs = await stripMetadata([input], {}, makeCtx());
    const stripped = outputNamed(outputs, 'meta.png');
    const types = pngChunkTypes(stripped.buffer);

    expect(types).not.toContain('tEXt');
    expect(types).not.toContain('eXIf');
    expect(types[0]).toBe('IHDR');
    expect(types).toContain('IDAT');
    expect(types[types.length - 1]).toBe('IEND');
    expect(contains(stripped.buffer, 'built by make-fixtures')).toBe(false);
    expect(stripped.buffer.byteLength).toBeLessThan(input.buffer.byteLength);
  });

  it('returns the original bytes when there is no metadata to remove', async () => {
    const input = loadFixture('a.png', 'image/png');
    const outputs = await stripMetadata([input], {}, makeCtx());

    expect(new Uint8Array(outputNamed(outputs, 'a.png').buffer)).toEqual(new Uint8Array(input.buffer));
    expect(reportText(outputs)).toContain('no metadata found');
  });

  it('raises CorruptFile naming the file for a PNG with no IEND', async () => {
    const input = loadFixture('meta.png', 'image/png');
    const cut = { ...input, name: 'cut.png', buffer: input.buffer.slice(0, input.buffer.byteLength - 5) };

    const error = await expectOpError(stripMetadata([cut], {}, makeCtx()), 'CorruptFile');
    expect(error.file).toBe('cut.png');
  });
});

// ---------------------------------------------------------------------------
// WebP
// ---------------------------------------------------------------------------

describe('image-strip-metadata: WebP', () => {
  it('drops EXIF and XMP chunks and clears the VP8X flags that announced them', async () => {
    const input = loadFixture('meta.webp', 'image/webp');
    expect(contains(input.buffer, 'EXIF')).toBe(true);
    expect(contains(input.buffer, 'XMP ')).toBe(true);

    const outputs = await stripMetadata([input], {}, makeCtx());
    const stripped = outputNamed(outputs, 'meta.webp');
    const bytes = new Uint8Array(stripped.buffer);

    expect(contains(stripped.buffer, 'EXIF')).toBe(false);
    expect(contains(stripped.buffer, 'XMP ')).toBe(false);

    // The RIFF header still describes the file it is now.
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('RIFF');
    expect(new DataView(stripped.buffer).getUint32(4, true)).toBe(bytes.length - 8);

    // VP8X is still the first chunk, and its EXIF/XMP bits are clear.
    expect(String.fromCharCode(...bytes.subarray(12, 16))).toBe('VP8X');
    expect((bytes[20] as number) & 0x0c).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

describe('image-strip-metadata: contract', () => {
  it('raises UnsupportedFormat naming a file it cannot strip without re-encoding', async () => {
    const error = await expectOpError(
      stripMetadata([loadFixture('small.pdf', 'application/pdf')], {}, makeCtx()),
      'UnsupportedFormat',
    );
    expect(error.file).toBe('small.pdf');
  });

  it('rejects a non-boolean keepColorProfile with InvalidOptions', async () => {
    await expectOpError(
      stripMetadata([loadFixture('a.png', 'image/png')], { keepColorProfile: 'yes' }, makeCtx()),
      'InvalidOptions',
    );
  });

  it('cancels part-way through via AbortSignal', async () => {
    const controller = new AbortController();
    const ctx = makeCtx(controller.signal);
    const original = ctx.onProgress.bind(ctx);
    ctx.onProgress = (fraction: number) => {
      original(fraction);
      controller.abort();
    };

    await expectOpError(
      stripMetadata(
        [loadFixture('exif.jpg', 'image/jpeg'), loadFixture('meta.png', 'image/png')],
        {},
        ctx,
      ),
      'Cancelled',
    );
  });

  it('reports monotonic progress ending at 1', async () => {
    const ctx = makeCtx();
    await stripMetadata([loadFixture('exif.jpg', 'image/jpeg'), loadFixture('meta.png', 'image/png')], {}, ctx);
    assertMonotonicEndingAtOne(ctx.progress);
  });

  it('names every file it looked at in one report', async () => {
    const outputs = await stripMetadata(
      [loadFixture('exif.jpg', 'image/jpeg'), loadFixture('a.png', 'image/png')],
      {},
      makeCtx(),
    );
    const report = reportText(outputs);
    expect(report).toContain('exif.jpg');
    expect(report).toContain('a.png');
    expect(report).toContain('EXIF (APP1)');
  });

  it('is registered with a matching loader entry, for the formats it can handle', () => {
    const tool = IMAGE_TOOLS.find((entry) => entry.id === 'image-strip-metadata');
    expect(tool?.accepts).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(IMAGE_LOADERS['image-strip-metadata']).toBeTypeOf('function');
  });
});
