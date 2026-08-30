// tests/unit/file-parts.test.ts
//
// file-split and file-join, the two halves of getting a file past a size
// limit. Beyond the four tests CONTRIBUTING §2 requires, the case that earns
// its own attention is a refused join: file-join rejects parts that are out of
// order, and that rejection must NOT name a file — an OpError carrying a file
// name tells the worker to drop that input and retry (runner.worker.ts), which
// would join the remaining parts into exactly the silently-corrupt output the
// check exists to prevent.

import { describe, expect, it } from 'vitest';

import { OpError } from '../../src/types';
import type { OpContext, OpInput } from '../../src/types';

import { DATA_TOOLS } from '../../src/core/registry.data';
import { DATA_LOADERS } from '../../src/core/workers/loaders.data';
import fileJoin from '../../src/tools/data/file-join.op';
import fileSplit from '../../src/tools/data/file-split.op';

function bytesInput(name: string, length: number, seed = 1): OpInput {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (i * seed + 7) % 251;
  return { name, type: 'application/octet-stream', buffer: bytes.buffer };
}

function textInput(name: string, text: string): OpInput {
  return { name, type: 'text/plain', buffer: new TextEncoder().encode(text).buffer };
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

const KB = { size: 1, unit: 'KB' };

// ---------------------------------------------------------------------------
// file-split
// ---------------------------------------------------------------------------

describe('file-split', () => {
  it('cuts a file into numbered parts of the requested size (happy path)', async () => {
    const outputs = await fileSplit([bytesInput('data.bin', 2500)], KB, makeCtx());

    expect(outputs.map((o) => o.name)).toEqual(['data.bin.part001', 'data.bin.part002', 'data.bin.part003']);
    expect(outputs.map((o) => o.buffer.byteLength)).toEqual([1024, 1024, 452]);
  });

  it('round-trips through file-join back to the original bytes', async () => {
    const original = bytesInput('data.bin', 2500, 3);
    const parts = await fileSplit([original], KB, makeCtx());
    const joined = await fileJoin(
      parts.map((part) => ({ name: part.name, type: part.type, buffer: part.buffer })),
      {},
      makeCtx(),
    );

    expect(joined).toHaveLength(1);
    expect(joined[0]?.name).toBe('data.bin');
    expect(new Uint8Array(joined[0]!.buffer)).toEqual(new Uint8Array(original.buffer));
  });

  it('makes a single part when the file is smaller than the part size', async () => {
    const outputs = await fileSplit([bytesInput('small.bin', 10)], KB, makeCtx());
    expect(outputs.map((o) => o.name)).toEqual(['small.bin.part001']);
    expect(outputs[0]?.buffer.byteLength).toBe(10);
  });

  it('splits several files independently, numbering each from 1', async () => {
    const outputs = await fileSplit([bytesInput('a.bin', 1500), bytesInput('b.bin', 1100)], KB, makeCtx());
    expect(outputs.map((o) => o.name)).toEqual([
      'a.bin.part001',
      'a.bin.part002',
      'b.bin.part001',
      'b.bin.part002',
    ]);
  });

  it('rejects an out-of-range part size with InvalidOptions', async () => {
    await expectOpError(fileSplit([bytesInput('a.bin', 10)], { size: 0 }, makeCtx()), 'InvalidOptions');
    await expectOpError(fileSplit([bytesInput('a.bin', 10)], { unit: 'GB' }, makeCtx()), 'InvalidOptions');
  });

  it('refuses to make more parts than the limit, naming the file', async () => {
    const error = await expectOpError(
      fileSplit([bytesInput('huge.bin', 1000 * 1024 + 1)], KB, makeCtx()),
      'InvalidOptions',
    );
    expect(error.file).toBe('huge.bin');
    expect(error.message).toContain('1001 parts');
  });

  it('cancels part-way through via AbortSignal', async () => {
    const controller = new AbortController();
    const ctx = makeCtx(controller.signal);
    const original = ctx.onProgress.bind(ctx);
    ctx.onProgress = (fraction: number) => {
      original(fraction);
      controller.abort();
    };

    await expectOpError(fileSplit([bytesInput('a.bin', 5000)], KB, ctx), 'Cancelled');
  });

  it('reports monotonic progress ending at 1', async () => {
    const ctx = makeCtx();
    await fileSplit([bytesInput('a.bin', 2500), bytesInput('b.bin', 1500)], KB, ctx);
    assertMonotonicEndingAtOne(ctx.progress);
  });
});

// ---------------------------------------------------------------------------
// file-join
// ---------------------------------------------------------------------------

describe('file-join', () => {
  it('concatenates .partNNN files back into their original name (happy path)', async () => {
    const outputs = await fileJoin(
      [textInput('notes.txt.part001', 'hello '), textInput('notes.txt.part002', 'world')],
      {},
      makeCtx(),
    );

    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.name).toBe('notes.txt');
    expect(new TextDecoder().decode(outputs[0]!.buffer)).toBe('hello world');
  });

  it('understands the <file.ext>.NNN convention other splitters use', async () => {
    const outputs = await fileJoin(
      [textInput('video.mp4.001', 'aa'), textInput('video.mp4.002', 'bb')],
      {},
      makeCtx(),
    );
    expect(outputs[0]?.name).toBe('video.mp4');
  });

  it('joins unnumbered files in tray order under a .joined name', async () => {
    const outputs = await fileJoin([textInput('one.bin', 'aa'), textInput('two.bin', 'bb')], {}, makeCtx());
    expect(outputs[0]?.name).toBe('one.bin.joined');
    expect(new TextDecoder().decode(outputs[0]!.buffer)).toBe('aabb');
  });

  it('treats notes.2024 as a file name, not as part 2024 of "notes"', async () => {
    const outputs = await fileJoin([textInput('notes.2024', 'aa'), textInput('notes.2025', 'bb')], {}, makeCtx());
    expect(outputs[0]?.name).toBe('notes.2024.joined');
  });

  it('refuses parts that are out of order, WITHOUT naming a file', async () => {
    const error = await expectOpError(
      fileJoin(
        [textInput('a.bin.part002', 'bb'), textInput('a.bin.part001', 'aa')],
        {},
        makeCtx(),
      ),
      'InvalidOptions',
    );
    // Naming a file here would make the worker drop it and "succeed" with a
    // subset of the parts — a silently truncated file.
    expect(error.file).toBeUndefined();
    expect(error.message).toContain('not in order');
  });

  it('refuses a set whose first part is missing', async () => {
    const error = await expectOpError(
      fileJoin([textInput('a.bin.part002', 'bb'), textInput('a.bin.part003', 'cc')], {}, makeCtx()),
      'InvalidOptions',
    );
    expect(error.file).toBeUndefined();
    expect(error.message).toContain('part 1 is missing');
  });

  it('refuses a duplicated part', async () => {
    await expectOpError(
      fileJoin([textInput('a.bin.part001', 'aa'), textInput('a.bin.part001', 'aa')], {}, makeCtx()),
      'InvalidOptions',
    );
  });

  it('needs at least two parts', async () => {
    await expectOpError(fileJoin([textInput('a.bin.part001', 'aa')], {}, makeCtx()), 'InvalidOptions');
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
      fileJoin(
        [textInput('a.bin.part001', 'aa'), textInput('a.bin.part002', 'bb'), textInput('a.bin.part003', 'cc')],
        {},
        ctx,
      ),
      'Cancelled',
    );
  });

  it('reports monotonic progress ending at 1', async () => {
    const ctx = makeCtx();
    await fileJoin([textInput('a.bin.part001', 'aa'), textInput('a.bin.part002', 'bb')], {}, ctx);
    assertMonotonicEndingAtOne(ctx.progress);
  });
});

// ---------------------------------------------------------------------------
// Registry wiring
// ---------------------------------------------------------------------------

describe('file-part registry entries', () => {
  it('registers file-split and file-join with matching loader entries', () => {
    const ids = DATA_TOOLS.map((tool) => tool.id);
    for (const id of ['file-split', 'file-join']) {
      expect(ids).toContain(id);
      expect(DATA_LOADERS[id]).toBeTypeOf('function');
    }
  });

  it('needs two files before file-join can run at all', () => {
    expect(DATA_TOOLS.find((tool) => tool.id === 'file-join')?.minInputs).toBe(2);
  });
});
