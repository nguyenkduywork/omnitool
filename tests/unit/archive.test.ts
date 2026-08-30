// tests/unit/archive.test.ts
//
// gzip, tar-create and tar-extract. Every op gets the four tests CONTRIBUTING
// §2 requires — happy path, a typed error, cancellation, progress — plus the
// two things that are specific to reading someone else's archive:
//
//   * INTEROP. The .tar fixtures are written by GNU tar itself (see
//     make-fixtures.mjs), so these are tests against a real archiver's output,
//     including its long-name ('L') and pax ('x') headers, not against our own
//     writer's idea of the format.
//   * TRAVERSAL. traversal.tar holds a genuine "../evil.txt" entry, which must
//     not survive extraction.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { OpError } from '../../src/types';
import type { OpContext, OpInput } from '../../src/types';

import { DATA_TOOLS } from '../../src/core/registry.data';
import { DATA_LOADERS } from '../../src/core/workers/loaders.data';
import gzip from '../../src/tools/data/gzip.op';
import tarCreate from '../../src/tools/data/tar-create.op';
import tarExtract from '../../src/tools/data/tar-extract.op';

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

/** Mirrors LONG_NAME in make-fixtures.mjs: one path component past 100 bytes. */
const LONG_NAME = `${'long-'.repeat(24)}name.txt`;

function loadFixture(name: string, type = 'application/octet-stream'): OpInput {
  const buf = readFileSync(path.join(FIXTURES_DIR, name));
  return { name, type, buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
}

function textInput(name: string, text: string, type = 'text/plain'): OpInput {
  return { name, type, buffer: new TextEncoder().encode(text).buffer };
}

function bufferToText(buffer: ArrayBuffer): string {
  return new TextDecoder().decode(buffer);
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

// ---------------------------------------------------------------------------
// gzip
// ---------------------------------------------------------------------------

describe('gzip', () => {
  it('round-trips a file through compress and decompress (happy path)', async () => {
    const packed = await gzip([textInput('notes.txt', 'hello from omnitool')], { direction: 'encode' }, makeCtx());
    expect(packed).toHaveLength(1);
    expect(packed[0]?.name).toBe('notes.txt.gz');
    expect(packed[0]?.type).toBe('application/gzip');
    expect(new Uint8Array(packed[0]!.buffer).subarray(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));

    const unpacked = await gzip(
      [{ name: 'notes.txt.gz', type: 'application/gzip', buffer: packed[0]!.buffer }],
      { direction: 'decode' },
      makeCtx(),
    );
    expect(unpacked[0]?.name).toBe('notes.txt');
    expect(bufferToText(unpacked[0]!.buffer)).toBe('hello from omnitool');
  });

  it('names a decompressed .tgz as .tar', async () => {
    const packed = await gzip([textInput('photos.tar', 'not really a tar')], { direction: 'encode' }, makeCtx());
    const unpacked = await gzip(
      [{ name: 'photos.tgz', type: 'application/gzip', buffer: packed[0]!.buffer }],
      { direction: 'decode' },
      makeCtx(),
    );
    expect(unpacked[0]?.name).toBe('photos.tar');
  });

  it('writes mtime 0, so the same input and level give the same bytes', async () => {
    const once = await gzip([textInput('a.txt', 'deterministic')], { direction: 'encode' }, makeCtx());
    const twice = await gzip([textInput('a.txt', 'deterministic')], { direction: 'encode' }, makeCtx());
    expect(new Uint8Array(once[0]!.buffer)).toEqual(new Uint8Array(twice[0]!.buffer));
    // Bytes 4..8 of a gzip header are MTIME.
    expect(new Uint8Array(once[0]!.buffer).subarray(4, 8)).toEqual(new Uint8Array([0, 0, 0, 0]));
  });

  it('raises UnsupportedFormat naming the file when asked to decompress a non-gzip', async () => {
    const error = await expectOpError(
      gzip([textInput('plain.txt', 'no gzip header here')], { direction: 'decode' }, makeCtx()),
      'UnsupportedFormat',
    );
    expect(error.file).toBe('plain.txt');
  });

  it('raises CorruptFile naming the file for a truncated gzip', async () => {
    const packed = await gzip([textInput('a.txt', 'x'.repeat(500))], { direction: 'encode' }, makeCtx());
    const truncated = packed[0]!.buffer.slice(0, 12);
    const error = await expectOpError(
      gzip([{ name: 'a.txt.gz', type: 'application/gzip', buffer: truncated }], { direction: 'decode' }, makeCtx()),
      'CorruptFile',
    );
    expect(error.file).toBe('a.txt.gz');
  });

  it('rejects an out-of-range level with InvalidOptions', async () => {
    await expectOpError(gzip([textInput('a.txt', 'x')], { level: 12 }, makeCtx()), 'InvalidOptions');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const controller = new AbortController();
    const inputs = [textInput('a.txt', 'x'), textInput('b.txt', 'y'), textInput('c.txt', 'z')];
    const ctx = makeCtx(controller.signal);
    const original = ctx.onProgress.bind(ctx);
    ctx.onProgress = (fraction: number) => {
      original(fraction);
      if (fraction >= 1 / inputs.length) controller.abort();
    };

    await expectOpError(gzip(inputs, {}, ctx), 'Cancelled');
  });

  it('reports monotonic progress ending at 1', async () => {
    const ctx = makeCtx();
    await gzip([textInput('a.txt', 'x'), textInput('b.txt', 'y')], {}, ctx);
    assertMonotonicEndingAtOne(ctx.progress);
  });
});

// ---------------------------------------------------------------------------
// tar-create
// ---------------------------------------------------------------------------

describe('tar-create', () => {
  it('writes an archive tar-extract reads back entry for entry (happy path)', async () => {
    const inputs = [textInput('a.txt', 'hello a'), textInput('dir/b.txt', 'hello b')];
    const outputs = await tarCreate(inputs, { name: 'bundle' }, makeCtx());

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.name).toBe('bundle.tar');
    expect(outputs[0]?.type).toBe('application/x-tar');
    expect(outputs[0]!.buffer.byteLength % 512).toBe(0);

    const extracted = await tarExtract(
      [{ name: 'bundle.tar', type: 'application/x-tar', buffer: outputs[0]!.buffer }],
      {},
      makeCtx(),
    );
    const byName = new Map(extracted.map((o) => [o.name, bufferToText(o.buffer)]));
    expect(byName.get('a.txt')).toBe('hello a');
    expect(byName.get('dir/b.txt')).toBe('hello b');
  });

  it('writes the same header fields GNU tar writes for the same file', async () => {
    // sample.tar was produced by GNU tar with --mtime=@0 --owner=0 --group=0,
    // which is exactly what this writer emits, so the first 148 bytes — name,
    // mode, uid, gid, size, mtime — must match byte for byte. (Bytes 148+
    // differ: GNU stamps the old "ustar  " magic where this writes POSIX
    // ustar, and the checksum follows the magic.)
    const gnu = new Uint8Array(loadFixture('sample.tar').buffer);
    const ours = await tarCreate([textInput('hello.txt', 'hello from omnitool\n')], {}, makeCtx());
    const header = new Uint8Array(ours[0]!.buffer);

    expect(header.subarray(0, 148)).toEqual(gnu.subarray(0, 148));
    expect(header[156]).toBe(gnu[156]); // typeflag '0'
    expect(String.fromCharCode(...header.subarray(257, 262))).toBe('ustar');
  });

  it('gzips the archive when asked, and tar-extract still reads it', async () => {
    const outputs = await tarCreate([textInput('a.txt', 'hello a')], { name: 'bundle', gzip: true }, makeCtx());
    expect(outputs[0]?.name).toBe('bundle.tar.gz');
    expect(outputs[0]?.type).toBe('application/gzip');

    const extracted = await tarExtract(
      [{ name: 'bundle.tar.gz', type: 'application/gzip', buffer: outputs[0]!.buffer }],
      {},
      makeCtx(),
    );
    expect(bufferToText(extracted[0]!.buffer)).toBe('hello a');
  });

  it('raises InvalidOptions naming the file for a name no ustar header can hold', async () => {
    const impossible = `${'x'.repeat(150)}.txt`;
    const error = await expectOpError(tarCreate([textInput(impossible, 'x')], {}, makeCtx()), 'InvalidOptions');
    expect(error.file).toBe(impossible);
  });

  it('cancels part-way through via AbortSignal', async () => {
    const controller = new AbortController();
    const inputs = [textInput('a.txt', 'x'), textInput('b.txt', 'y'), textInput('c.txt', 'z')];
    const ctx = makeCtx(controller.signal);
    const original = ctx.onProgress.bind(ctx);
    ctx.onProgress = (fraction: number) => {
      original(fraction);
      if (fraction >= 1 / inputs.length) controller.abort();
    };

    await expectOpError(tarCreate(inputs, {}, ctx), 'Cancelled');
  });

  it('reports monotonic progress ending at 1', async () => {
    const ctx = makeCtx();
    await tarCreate([textInput('a.txt', 'x'), textInput('b.txt', 'y')], {}, ctx);
    assertMonotonicEndingAtOne(ctx.progress);

    const gzipped = makeCtx();
    await tarCreate([textInput('a.txt', 'x'), textInput('b.txt', 'y')], { gzip: true }, gzipped);
    assertMonotonicEndingAtOne(gzipped.progress);
  });
});

// ---------------------------------------------------------------------------
// tar-extract
// ---------------------------------------------------------------------------

describe('tar-extract', () => {
  it('extracts every entry from a GNU tar, long names included (happy path)', async () => {
    const outputs = await tarExtract([loadFixture('sample.tar', 'application/x-tar')], {}, makeCtx());
    const byName = new Map(outputs.map((o) => [o.name, bufferToText(o.buffer)]));

    expect(byName.get('hello.txt')).toBe('hello from omnitool\n');
    expect(byName.get('dir/nested.txt')).toBe('nested file contents\n');
    // Stored by GNU tar as an 'L' long-name entry, not in the 100-byte field.
    expect(byName.get(LONG_NAME)).toBe('stored under a name too long for a ustar header\n');
  });

  it('reads a pax archive, taking the name from its "path=" record', async () => {
    const outputs = await tarExtract([loadFixture('pax.tar', 'application/x-tar')], {}, makeCtx());
    const names = outputs.map((o) => o.name);

    expect(names).toContain('hello.txt');
    expect(names).toContain('dir/nested.txt');
    // The ustar name beside a pax header is truncated to 100 bytes; using it
    // would silently rename the file.
    expect(names).toContain(LONG_NAME);
  });

  it('gunzips a .tar.gz before reading it', async () => {
    const outputs = await tarExtract([loadFixture('sample.tar.gz', 'application/gzip')], {}, makeCtx());
    const byName = new Map(outputs.map((o) => [o.name, bufferToText(o.buffer)]));
    expect(byName.get('hello.txt')).toBe('hello from omnitool\n');
  });

  it('neutralises path traversal in traversal.tar so nothing escapes the extraction root', async () => {
    const outputs = await tarExtract([loadFixture('traversal.tar', 'application/x-tar')], {}, makeCtx());

    expect(outputs.some((o) => o.name === '../evil.txt')).toBe(false);
    for (const output of outputs) {
      expect(output.name.startsWith('/')).toBe(false);
      expect(output.name.split('/')).not.toContain('..');
    }
    const byName = new Map(outputs.map((o) => [o.name, bufferToText(o.buffer)]));
    expect(byName.get('ok.txt')).toBe('this one is fine\n');
    expect(byName.get('evil.txt')).toBe('if you can read this, traversal succeeded\n');
  });

  it('prefixes entries with the archive stem when several archives are extracted at once', async () => {
    const outputs = await tarExtract(
      [loadFixture('sample.tar', 'application/x-tar'), loadFixture('sample.tar.gz', 'application/gzip')],
      {},
      makeCtx(),
    );
    expect(outputs.some((o) => o.name === 'sample/hello.txt')).toBe(true);
  });

  it('raises CorruptFile naming the file when a header checksum does not match', async () => {
    const fixture = loadFixture('sample.tar', 'application/x-tar');
    const bytes = new Uint8Array(fixture.buffer);
    bytes[0] = bytes[0] === 0x61 ? 0x62 : 0x61; // corrupt the name, not the checksum

    const error = await expectOpError(
      tarExtract([{ name: 'sample.tar', type: 'application/x-tar', buffer: bytes.buffer }], {}, makeCtx()),
      'CorruptFile',
    );
    expect(error.file).toBe('sample.tar');
  });

  it('refuses a gzip whose contents are not a tar, naming the file', async () => {
    const packed = await gzip([textInput('notes.txt', 'just some text')], { direction: 'encode' }, makeCtx());
    const error = await expectOpError(
      tarExtract([{ name: 'notes.txt.gz', type: 'application/gzip', buffer: packed[0]!.buffer }], {}, makeCtx()),
      'UnsupportedFormat',
    );
    expect(error.file).toBe('notes.txt.gz');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const controller = new AbortController();
    const ctx = makeCtx(controller.signal);
    const original = ctx.onProgress.bind(ctx);
    ctx.onProgress = (fraction: number) => {
      original(fraction);
      if (fraction >= 0.5) controller.abort();
    };

    await expectOpError(
      tarExtract(
        [loadFixture('sample.tar', 'application/x-tar'), loadFixture('pax.tar', 'application/x-tar')],
        {},
        ctx,
      ),
      'Cancelled',
    );
  });

  it('reports monotonic progress ending at 1', async () => {
    const ctx = makeCtx();
    await tarExtract(
      [loadFixture('sample.tar', 'application/x-tar'), loadFixture('pax.tar', 'application/x-tar')],
      {},
      ctx,
    );
    assertMonotonicEndingAtOne(ctx.progress);
  });
});

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

describe('archive registry entries', () => {
  it('registers gzip, tar-create and tar-extract with matching loader entries', () => {
    const ids = DATA_TOOLS.map((tool) => tool.id);
    for (const id of ['gzip', 'tar-create', 'tar-extract']) {
      expect(ids).toContain(id);
      expect(DATA_LOADERS[id]).toBeTypeOf('function');
    }
  });

  it('offers tar-extract for the archive types format.ts can sniff', () => {
    const tarExtractTool = DATA_TOOLS.find((tool) => tool.id === 'tar-extract');
    expect(tarExtractTool?.accepts).toEqual(['application/x-tar', 'application/gzip']);
  });
});
