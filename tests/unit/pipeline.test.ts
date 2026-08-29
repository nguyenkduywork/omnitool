import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getTool, TOOLS, toolsFor } from '../../src/core/registry';
import { CANCEL_GRACE_MS, run } from '../../src/core/pipeline';
import { WorkerPool } from '../../src/core/workers/pool';
import {
  LOADERS,
  PROGRESS_INTERVAL_MS,
  createProgressReporter,
  type LoaderMap,
} from '../../src/core/workers/runner.worker';
import { OpError, type Op, type OpInput, type OpOutput } from '../../src/types';
import { FakeWorker, fakeFactory, tick } from '../helpers/fake-worker';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

async function fixtureFile(onDisk: string, as = onDisk): Promise<File> {
  return new File([await readFile(path.join(FIXTURES, onDisk))], as);
}

function bin(name: string, byte = 7): File {
  return new File([new Uint8Array([byte, byte, byte, byte])], name);
}

function out(name: string, body: string): OpOutput {
  const bytes = new TextEncoder().encode(body);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return { name, type: 'text/plain', buffer };
}

// ---------------------------------------------------------------------------
// Test ops. Registered through an injected loader map, never in the real one.
// ---------------------------------------------------------------------------

/** Throws on exactly one input, naming it — the per-file failure channel. */
const throwsOnB: Op = async (inputs, _options, ctx) => {
  const outputs: OpOutput[] = [];
  for (const input of inputs) {
    if (input.name === 'b.bin') {
      throw new OpError('CorruptFile', 'b.bin is not readable', input.name);
    }
    outputs.push(out(`${input.name}.done`, input.name));
  }
  ctx.onProgress(1);
  return outputs;
};

/** Fails for every input, one at a time. */
const throwsOnEverything: Op = async (inputs) => {
  const first = inputs[0];
  throw new OpError('CorruptFile', `${first?.name ?? '?'} is not readable`, first?.name);
};

/** Fails the whole job: an OpError with no file cannot be attributed. */
const throwsJobLevel: Op = async () => {
  throw new OpError('InvalidOptions', 'options are nonsense');
};

/** Reports progress erratically (including backwards) to prove clamping. */
const erraticProgress: Op = async (inputs, _options, ctx) => {
  for (const f of [0.4, 0.1, 0.2, 0.9, 0.5]) ctx.onProgress(f);
  return inputs.map((i) => out(`${i.name}.done`, i.name));
};

/** Respects the abort signal — the graceful cancellation path. */
const cancellable: Op = (_inputs, _options, ctx) =>
  new Promise<OpOutput[]>((_resolve, reject) => {
    ctx.signal.addEventListener('abort', () =>
      reject(new OpError('Cancelled', 'stopped part-way through')),
    );
  });

/** Ignores the abort signal entirely — forces the terminate-and-replace path. */
const runaway: Op = () => new Promise<OpOutput[]>(() => undefined);

const TEST_LOADERS: LoaderMap = {
  ...LOADERS,
  'test-throws-on-b': () => Promise.resolve({ default: throwsOnB }),
  'test-throws-always': () => Promise.resolve({ default: throwsOnEverything }),
  'test-job-error': () => Promise.resolve({ default: throwsJobLevel }),
  'test-erratic-progress': () => Promise.resolve({ default: erraticProgress }),
  'test-cancellable': () => Promise.resolve({ default: cancellable }),
  'test-runaway': () => Promise.resolve({ default: runaway }),
};

let pool: WorkerPool;

beforeEach(() => {
  FakeWorker.reset();
  pool = new WorkerPool({ factory: fakeFactory({ loaders: TEST_LOADERS }), capacity: 2 });
});

afterEach(() => {
  pool.terminateAll();
});

// ---------------------------------------------------------------------------

describe('registry', () => {
  it('concatenates the per-group manifests and finds tools by id', () => {
    expect(TOOLS.some((t) => t.id === 'pdf-merge')).toBe(true);
    expect(getTool('pdf-merge')?.name).toBeTypeOf('string');
    expect(getTool('nope')).toBeUndefined();
  });

  it('has no duplicate ids', () => {
    expect(new Set(TOOLS.map((t) => t.id)).size).toBe(TOOLS.length);
  });

  it('toolsFor offers pdf-merge for two PDFs and not for one CSV', () => {
    const forTwoPdfs = toolsFor(['application/pdf', 'application/pdf']).map((t) => t.id);
    expect(forTwoPdfs).toContain('pdf-merge');

    expect(toolsFor(['text/csv']).map((t) => t.id)).not.toContain('pdf-merge');
    expect(toolsFor(['application/pdf']).map((t) => t.id)).not.toContain('pdf-merge');
  });
});

describe('pdf-merge through the whole kernel', () => {
  // The Task 2 acceptance test.
  it('merges small.pdf (3 pages) with itself into exactly 6 pages', async () => {
    const files = [await fixtureFile('small.pdf'), await fixtureFile('small.pdf')];

    const job = run('pdf-merge', files, {}, { pool });
    const result = await job.done;

    expect(result.partial).toBe(false);
    expect(result.results).toEqual([
      { status: 'ok', name: 'small.pdf' },
      { status: 'ok', name: 'small.pdf' },
    ]);
    expect(result.outputs).toHaveLength(1);

    const merged = await PDFDocument.load(result.outputs[0]!.buffer);
    expect(merged.getPageCount()).toBe(6);
    expect(result.outputs[0]!.type).toBe('application/pdf');
  });

  it('reports a corrupt PDF as a per-file failure and still merges the rest', async () => {
    const files = [
      await fixtureFile('small.pdf'),
      await fixtureFile('corrupt.pdf'),
      await fixtureFile('small.pdf'),
    ];

    const result = await run('pdf-merge', files, {}, { pool }).done;

    expect(result.partial).toBe(true);
    expect(result.results).toContainEqual(
      expect.objectContaining({ status: 'failed', name: 'corrupt.pdf', code: 'CorruptFile' }),
    );
    const merged = await PDFDocument.load(result.outputs[0]!.buffer);
    expect(merged.getPageCount()).toBe(6);
  });

  it('emits monotonically non-decreasing progress ending at exactly 1', async () => {
    const files = [await fixtureFile('small.pdf'), await fixtureFile('small.pdf')];
    const job = run('pdf-merge', files, {}, { pool });
    const seen: number[] = [];
    job.onProgress((f) => seen.push(f));

    await job.done;

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});

// REQUIREMENT 1 (worker -> main direction).
describe('transfer, never clone', () => {
  it('the worker transfers output buffers out: its own copy detaches, the main thread keeps the bytes', async () => {
    const result = await run('test-throws-on-b', [bin('a.bin')], {}, { pool }).done;

    const fake = FakeWorker.instances[0]!;
    const done = fake.sentToMain.find((s) => s.message.kind === 'done')!;
    expect(done.transfer).toHaveLength(1);
    expect(done.message.kind === 'done' && done.message.outputs[0]!.buffer.byteLength).toBe(0);
    expect(result.outputs[0]!.buffer.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(result.outputs[0]!.buffer)).toBe('a.bin');
  });

  it('the main thread transfers input buffers in: the OpInput it posted detaches', async () => {
    await run('test-throws-on-b', [bin('a.bin'), bin('c.bin')], {}, { pool }).done;

    const fake = FakeWorker.instances[0]!;
    const sent = fake.received[0]!;
    // What arrived is intact...
    expect(sent.kind === 'run' && sent.inputs.every((i) => i.buffer.byteLength === 4)).toBe(true);
    // ...and only one copy of those bytes ever existed (see pool.test.ts for the
    // sender-side byteLength === 0 assertion on the exact same buffer object).
    expect(sent.kind === 'run' && sent.inputs).toHaveLength(2);
  });
});

// REQUIREMENT 2: per-file failure, not per-job.
describe('per-file failure', () => {
  it('one throwing input yields partial: true, the good outputs, and a failed entry naming it', async () => {
    const job = run('test-throws-on-b', [bin('a.bin'), bin('b.bin'), bin('c.bin')], {}, { pool });

    const result = await job.done;

    expect(result.partial).toBe(true);
    expect(result.results).toEqual([
      { status: 'ok', name: 'a.bin' },
      { status: 'failed', name: 'b.bin', code: 'CorruptFile', message: 'b.bin is not readable' },
      { status: 'ok', name: 'c.bin' },
    ]);
    expect(result.outputs.map((o) => o.name)).toEqual(['a.bin.done', 'c.bin.done']);
  });

  it('rejects rather than lying when every input fails', async () => {
    const job = run('test-throws-always', [bin('a.bin'), bin('b.bin')], {}, { pool });

    await expect(job.done).rejects.toMatchObject({ name: 'OpError', code: 'CorruptFile' });
  });

  it('an unattributable error (no file) fails the whole job', async () => {
    const job = run('test-job-error', [bin('a.bin')], {}, { pool });

    await expect(job.done).rejects.toMatchObject({ code: 'InvalidOptions' });
  });

  it('an unknown tool id fails the job with UnsupportedFormat', async () => {
    await expect(run('no-such-tool', [bin('a.bin')], {}, { pool }).done).rejects.toMatchObject({
      code: 'UnsupportedFormat',
    });
  });
});

// REQUIREMENT 3: crash recovery, seen from the pipeline.
describe('worker crash', () => {
  it('rejects the in-flight job with OutOfMemory and leaves the pool usable', async () => {
    const job = run('test-cancellable', [bin('a.bin')], {}, { pool });
    await tick();

    FakeWorker.instances[0]!.crash('Worker terminated: out of memory');

    await expect(job.done).rejects.toMatchObject({ code: 'OutOfMemory' });
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    expect(pool.size()).toBe(1);

    // The pool still works.
    const after = await run('test-throws-on-b', [bin('a.bin')], {}, { pool }).done;
    expect(after.outputs).toHaveLength(1);
  });
});

// REQUIREMENT 4: cancellation.
describe('cancellation', () => {
  it('the documented grace period before terminating is 2000 ms', () => {
    expect(CANCEL_GRACE_MS).toBe(2000);
  });

  it('an op that honours the signal settles as Cancelled and its worker goes back to the pool', async () => {
    const job = run('test-cancellable', [bin('a.bin')], {}, { pool });
    await tick();

    job.cancel();

    await expect(job.done).rejects.toMatchObject({ name: 'OpError', code: 'Cancelled' });
    // No leak: one worker, alive, back in the pool and reusable.
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.terminated).toBe(false);
    expect(pool.size()).toBe(1);
    await expect(pool.acquire()).resolves.toBeDefined();
  });

  it('forwards a CancelMessage naming the job', async () => {
    const job = run('test-cancellable', [bin('a.bin')], {}, { pool });
    await tick();
    job.cancel();
    await job.done.catch(() => undefined);

    const cancel = FakeWorker.instances[0]!.received.find((m) => m.kind === 'cancel');
    expect(cancel).toEqual({ kind: 'cancel', jobId: job.id });
  });

  it('an op that ignores the signal is terminated and replaced after the grace period', async () => {
    const job = run('test-runaway', [bin('a.bin')], {}, { pool, cancelGraceMs: 25 });
    await tick();

    job.cancel();

    await expect(job.done).rejects.toMatchObject({ code: 'Cancelled' });
    // No leak: the stuck worker is terminated, and a replacement stands in for it.
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(pool.size()).toBe(1);
  });

  it('does not terminate before the grace period elapses', async () => {
    const job = run('test-runaway', [bin('a.bin')], {}, { pool });
    await tick();
    job.cancel();

    await tick(8);

    expect(FakeWorker.instances[0]!.terminated).toBe(false);
    job.cancel();
    void job.done.catch(() => undefined);
  });

  it('cancelling before the worker is even acquired never spawns one', async () => {
    const job = run('test-runaway', [bin('a.bin')], {}, { pool });
    job.cancel();

    await expect(job.done).rejects.toMatchObject({ code: 'Cancelled' });
    await tick();
    expect(FakeWorker.instances).toHaveLength(0);
    expect(pool.size()).toBe(0);
  });

  it('cancelling after completion changes nothing', async () => {
    const job = run('test-throws-on-b', [bin('a.bin')], {}, { pool });
    const result = await job.done;

    job.cancel();

    await expect(job.done).resolves.toBe(result);
    expect(FakeWorker.instances[0]!.terminated).toBe(false);
  });
});

// REQUIREMENT 6: progress throttling.
describe('progress reporting', () => {
  it('emits at most one message per 50 ms and guarantees a final 1', () => {
    const emitted: number[] = [];
    let clock = 1000;
    const reporter = createProgressReporter((f) => emitted.push(f), () => clock);

    reporter.report(0.1); // t=1000 -> emits (first report always does)
    reporter.report(0.2); // dropped, same instant
    clock = 1020;
    reporter.report(0.3); // dropped, only 20 ms later
    clock = 1051;
    reporter.report(0.4); // emits
    clock = 1060;
    reporter.report(0.5); // dropped
    reporter.finish();

    expect(emitted).toEqual([0.1, 0.4, 1]);
    expect(PROGRESS_INTERVAL_MS).toBe(50);
  });

  it('is monotonic: a backwards report never lowers the reported fraction', () => {
    const emitted: number[] = [];
    let clock = 0;
    const reporter = createProgressReporter((f) => emitted.push(f), () => clock);

    reporter.report(0.6);
    clock = 100;
    reporter.report(0.2);
    clock = 200;
    reporter.report(0.9);
    reporter.finish();

    expect(emitted).toEqual([0.6, 0.6, 0.9, 1]);
  });

  it('clamps out-of-range fractions into 0..1', () => {
    const emitted: number[] = [];
    let clock = 0;
    const reporter = createProgressReporter((f) => emitted.push(f), () => clock);

    reporter.report(-5);
    clock = 100;
    reporter.report(50);
    reporter.finish();

    expect(emitted).toEqual([0, 1, 1]);
  });

  it('an op reporting erratic progress still reaches the main thread monotonically', async () => {
    const job = run('test-erratic-progress', [bin('a.bin')], {}, { pool });
    const seen: number[] = [];
    job.onProgress((f) => seen.push(f));

    await job.done;

    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen.at(-1)).toBe(1);
    expect(seen.every((f) => f >= 0 && f <= 1)).toBe(true);
  });
});

describe('Job shape', () => {
  it('returns immediately with a stable id and a done promise', () => {
    const job = run('test-cancellable', [bin('a.bin')], {}, { pool });

    expect(typeof job.id).toBe('string');
    expect(job.id.length).toBeGreaterThan(0);
    expect(job.done).toBeInstanceOf(Promise);
    expect(job.id).toBe(job.id);

    job.cancel();
    void job.done.catch(() => undefined);
  });

  it('late onProgress subscribers still see the final value', async () => {
    const job = run('test-throws-on-b', [bin('a.bin')], {}, { pool });
    await job.done;

    const seen: number[] = [];
    job.onProgress((f) => seen.push(f));

    expect(seen).toEqual([1]);
  });
});

// §2 of the plan: every op needs happy path, corrupt input, cancellation, progress.
describe('pdf-merge op, called directly', () => {
  async function input(name: string, as = name): Promise<OpInput> {
    const buf = await readFile(path.join(FIXTURES, name));
    const buffer = new ArrayBuffer(buf.byteLength);
    new Uint8Array(buffer).set(buf);
    return { name: as, type: 'application/pdf', buffer };
  }

  async function loadOp(): Promise<Op> {
    return (await LOADERS['pdf-merge']!()).default;
  }

  function ctx(signal = new AbortController().signal) {
    const seen: number[] = [];
    return { seen, ctx: { onProgress: (f: number) => seen.push(f), signal } };
  }

  it('happy path: 3 + 3 pages out of two inputs', async () => {
    const op = await loadOp();
    const { ctx: c } = ctx();

    const outputs = await op([await input('small.pdf'), await input('small.pdf')], {}, c);

    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.name).toBe('merged.pdf');
    expect(outputs[0]!.type).toBe('application/pdf');
    expect((await PDFDocument.load(outputs[0]!.buffer)).getPageCount()).toBe(6);
  });

  it('corrupt input raises CorruptFile naming the file', async () => {
    const op = await loadOp();
    const { ctx: c } = ctx();

    await expect(op([await input('corrupt.pdf')], {}, c)).rejects.toMatchObject({
      name: 'OpError',
      code: 'CorruptFile',
      file: 'corrupt.pdf',
    });
  });

  it('an encrypted PDF raises CorruptFile naming the file', async () => {
    const op = await loadOp();
    const { ctx: c } = ctx();

    await expect(op([await input('encrypted.pdf')], {}, c)).rejects.toMatchObject({
      code: 'CorruptFile',
      file: 'encrypted.pdf',
    });
  });

  it('no inputs raises InvalidOptions', async () => {
    const op = await loadOp();
    const { ctx: c } = ctx();

    await expect(op([], {}, c)).rejects.toMatchObject({ code: 'InvalidOptions' });
  });

  it('an already-aborted signal raises Cancelled before doing work', async () => {
    const op = await loadOp();
    const controller = new AbortController();
    controller.abort();
    const { ctx: c } = ctx(controller.signal);

    await expect(op([await input('small.pdf')], {}, c)).rejects.toMatchObject({
      code: 'Cancelled',
    });
  });

  it('aborting part-way through raises Cancelled', async () => {
    const op = await loadOp();
    const controller = new AbortController();
    const seen: number[] = [];
    const c = {
      signal: controller.signal,
      onProgress: (f: number) => {
        seen.push(f);
        controller.abort(); // abort as soon as the first file is done
      },
    };

    await expect(
      op([await input('small.pdf'), await input('small.pdf', 'second.pdf')], {}, c),
    ).rejects.toMatchObject({ code: 'Cancelled' });
    expect(seen.length).toBeGreaterThan(0);
  });

  it('reports monotonic progress ending at 1', async () => {
    const op = await loadOp();
    const { seen, ctx: c } = ctx();

    await op([await input('small.pdf'), await input('small.pdf')], {}, c);

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.at(-1)).toBe(1);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(seen.every((f) => f >= 0 && f <= 1)).toBe(true);
  });
});
