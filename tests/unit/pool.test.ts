import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_POOL_SIZE,
  WorkerPool,
  poolCapacity,
  size,
  type PooledWorker,
} from '../../src/core/workers/pool';
import type { RunMessage } from '../../src/core/workers/protocol';
import { OpError } from '../../src/types';
import { FakeWorker, fakeFactory, tick } from '../helpers/fake-worker';

function runMessage(jobId: string, bytes = 32): RunMessage {
  return {
    kind: 'run',
    jobId,
    toolId: 'no-such-tool',
    inputs: [{ name: 'a.bin', type: 'application/octet-stream', buffer: new ArrayBuffer(bytes) }],
    options: {},
  };
}

function newPool(capacity = 2): WorkerPool {
  return new WorkerPool({ factory: fakeFactory(), capacity });
}

let pools: WorkerPool[] = [];

beforeEach(() => {
  FakeWorker.reset();
  pools = [];
});

afterEach(() => {
  for (const p of pools) p.terminateAll();
});

function track(p: WorkerPool): WorkerPool {
  pools.push(p);
  return p;
}

describe('capacity', () => {
  it('is max(1, min(hardwareConcurrency ?? 4, 8) - 1)', () => {
    const hc = globalThis.navigator?.hardwareConcurrency;
    const expected = Math.max(1, Math.min(hc ?? 4, 8) - 1);

    expect(poolCapacity()).toBe(expected);
    expect(poolCapacity()).toBeGreaterThanOrEqual(1);
    expect(poolCapacity()).toBeLessThanOrEqual(MAX_POOL_SIZE - 1);
    expect(new WorkerPool({ factory: fakeFactory() }).capacity).toBe(expected);
  });
});

describe('lazy creation', () => {
  it('creates no worker until the first acquire', async () => {
    const pool = track(newPool());

    expect(pool.size()).toBe(0);
    expect(FakeWorker.instances).toHaveLength(0);

    await pool.acquire();

    expect(pool.size()).toBe(1);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('the module-level shared pool starts empty too', () => {
    expect(size()).toBe(0);
  });

  it('reuses a released worker rather than spawning another', async () => {
    const pool = track(newPool());

    const first = await pool.acquire();
    pool.release(first);
    const second = await pool.acquire();

    expect(second).toBe(first);
    expect(pool.size()).toBe(1);
  });

  it('queues acquires past capacity until a worker is released', async () => {
    const pool = track(newPool(1));

    const first = await pool.acquire();
    let handed: PooledWorker | undefined;
    const pending = pool.acquire().then((w) => {
      handed = w;
    });

    await tick(1);
    expect(handed).toBeUndefined();
    expect(pool.size()).toBe(1);

    pool.release(first);
    await pending;
    expect(handed).toBe(first);
  });
});

// REQUIREMENT 1 (main -> worker direction): buffers move, they are not cloned.
describe('transfer, never clone', () => {
  it('detaches the sender-side ArrayBuffer when posting a run message', async () => {
    const pool = track(newPool());
    const worker = await pool.acquire();
    const message = runMessage('j1', 64);
    const buffer = message.inputs[0]!.buffer;

    expect(buffer.byteLength).toBe(64);

    worker.post(message, [buffer]);

    // The observable proof of transfer: the sending side's buffer is gone.
    expect(buffer.byteLength).toBe(0);
    // ...and the worker got the bytes.
    const fake = FakeWorker.instances[0]!;
    const received = fake.received[0]!;
    expect(received.kind).toBe('run');
    expect(received.kind === 'run' && received.inputs[0]?.buffer.byteLength).toBe(64);
  });

  it('post() with no transfer list still delivers (cancel messages carry no buffers)', async () => {
    const pool = track(newPool());
    const worker = await pool.acquire();

    worker.post({ kind: 'cancel', jobId: 'j1' });

    expect(FakeWorker.instances[0]!.received[0]).toEqual({ kind: 'cancel', jobId: 'j1' });
  });
});

// REQUIREMENT 3: worker crash recovery.
describe('crash recovery', () => {
  it('terminates, drops, replaces, and rejects only that worker\'s in-flight job', async () => {
    const pool = track(newPool(2));

    const a = await pool.acquire();
    const b = await pool.acquire();
    const crashes: Record<string, OpError | undefined> = {};
    a.listen({ crash: (err) => (crashes.a = err) });
    b.listen({ crash: (err) => (crashes.b = err) });

    const crashedFake = FakeWorker.instances[0]!;
    expect(crashedFake.terminated).toBe(false);

    crashedFake.crash('out of memory');

    // Terminated and removed, with a replacement created eagerly.
    expect(crashedFake.terminated).toBe(true);
    expect(pool.size()).toBe(2);
    expect(FakeWorker.instances).toHaveLength(3);

    // Only the crashed worker's job is rejected, and with OutOfMemory.
    expect(crashes.a).toBeInstanceOf(OpError);
    expect(crashes.a?.code).toBe('OutOfMemory');
    expect(crashes.b).toBeUndefined();
  });

  it('treats messageerror as a crash as well', async () => {
    const pool = track(newPool());
    const worker = await pool.acquire();
    let err: OpError | undefined;
    worker.listen({ crash: (e) => (err = e) });

    FakeWorker.instances[0]!.messageError();

    expect(err?.code).toBe('OutOfMemory');
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });

  it('stays usable after a crash: the next acquire gets a fresh, working worker', async () => {
    const pool = track(newPool(1));

    const dead = await pool.acquire();
    dead.listen({ crash: () => undefined });
    FakeWorker.instances[0]!.crash();

    const fresh = await pool.acquire();
    expect(fresh).not.toBe(dead);
    expect(pool.size()).toBe(1);

    const seen: unknown[] = [];
    fresh.listen({ message: (m) => seen.push(m) });
    fresh.post(runMessage('after-crash'), []);
    await tick();

    // The replacement really runs the runner: an unknown tool id comes back as an error message.
    expect(seen).toEqual([
      expect.objectContaining({ kind: 'error', jobId: 'after-crash', code: 'UnsupportedFormat' }),
    ]);
  });

  it('replaces an idle worker that crashes without rejecting anything', async () => {
    const pool = track(newPool());
    const w = await pool.acquire();
    pool.release(w);

    FakeWorker.instances[0]!.crash();

    expect(pool.size()).toBe(1);
    expect(FakeWorker.instances).toHaveLength(2);
  });
});

describe('discard (used by the cancel-timeout path)', () => {
  it('terminates the worker and eagerly creates a replacement', async () => {
    const pool = track(newPool());
    const w = await pool.acquire();

    pool.discard(w);

    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    expect(pool.size()).toBe(1);
    expect(FakeWorker.instances).toHaveLength(2);
    await expect(pool.acquire()).resolves.not.toBe(w);
  });

  it('hands the replacement to a queued waiter', async () => {
    const pool = track(newPool(1));
    const w = await pool.acquire();
    let handed: PooledWorker | undefined;
    const pending = pool.acquire().then((x) => {
      handed = x;
    });

    pool.discard(w);
    await pending;

    expect(handed).toBeDefined();
    expect(handed).not.toBe(w);
  });

  it('discarding twice is a no-op, not a leak', async () => {
    const pool = track(newPool());
    const w = await pool.acquire();

    pool.discard(w);
    pool.discard(w);

    expect(pool.size()).toBe(1);
    expect(FakeWorker.instances).toHaveLength(2);
  });
});

describe('release', () => {
  it('detaches the previous checkout\'s listeners so late messages cannot leak', async () => {
    const pool = track(newPool());
    const w = await pool.acquire();
    const seen: unknown[] = [];
    w.listen({ message: (m) => seen.push(m) });

    pool.release(w);
    w.post(runMessage('late'), []);
    await tick();

    expect(seen).toEqual([]);
  });
});
