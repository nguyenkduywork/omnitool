// src/core/workers/pool.ts — main-thread worker pool.
//
// Three jobs, in order of importance:
//   1. TRANSFER, never clone. `post()` always hands `postMessage` a transfer
//      list, so an ArrayBuffer moves into the worker instead of being copied.
//   2. Crash recovery. On `error`/`messageerror` the worker is terminated,
//      dropped, and replaced, and ONLY that worker's in-flight job is rejected,
//      with `OutOfMemory` (the overwhelmingly likely cause of a worker dying).
//   3. Lazy creation. No worker is spawned until the first `acquire()`.
//
// The Worker constructor is injectable so the pool can be exercised headlessly:
// the vitest `node` environment has no global `Worker`.

import { OpError } from '../../types';
import type { MainToWorkerMessage, WorkerToMainMessage } from './protocol';

/** The slice of the `Worker` interface this pool depends on. */
export type WorkerLike = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
};

export type WorkerFactory = () => WorkerLike;

export type PooledWorkerHandlers = {
  /** Every message this worker posts while checked out. */
  message?: (message: WorkerToMainMessage) => void;
  /** The worker died. It is already terminated and replaced. */
  crash?: (error: OpError) => void;
};

export type PooledWorker = {
  readonly id: number;
  /** Post to the worker, MOVING every buffer in `transfer`. */
  post(message: MainToWorkerMessage, transfer?: Transferable[]): void;
  /** Install handlers for this checkout, replacing any previous ones. */
  listen(handlers: PooledWorkerHandlers): void;
};

/** The pool surface `pipeline.run()` needs; lets tests inject their own. */
export type WorkerPoolLike = {
  acquire(): Promise<PooledWorker>;
  release(worker: PooledWorker): void;
  discard(worker: PooledWorker): void;
};

/** Never spawn more than this many workers, however many cores there are. */
export const MAX_POOL_SIZE = 8;

/** One fewer than the (capped) core count, leaving a core for the UI thread. */
export function poolCapacity(): number {
  const cores = typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency;
  return Math.max(1, Math.min(cores ?? 4, MAX_POOL_SIZE) - 1);
}

function defaultFactory(): WorkerLike {
  // Vite must see this literally to emit the worker chunk.
  return new Worker(new URL('./runner.worker.ts', import.meta.url), { type: 'module' });
}

function crashMessage(event: unknown): string {
  if (typeof event === 'object' && event !== null && 'message' in event) {
    const { message } = event as { message?: unknown };
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return 'the worker stopped responding';
}

class Slot implements PooledWorker {
  busy = false;
  handlers: PooledWorkerHandlers = {};
  dead = false;

  constructor(
    readonly id: number,
    readonly worker: WorkerLike,
  ) {}

  post(message: MainToWorkerMessage, transfer: Transferable[] = []): void {
    // Always pass the transfer list: buffers move, they are never structured-cloned.
    this.worker.postMessage(message, transfer);
  }

  listen(handlers: PooledWorkerHandlers): void {
    this.handlers = handlers;
  }
}

export class WorkerPool implements WorkerPoolLike {
  readonly capacity: number;

  private readonly factory: WorkerFactory;
  private readonly slots: Slot[] = [];
  private readonly waiting: ((slot: Slot) => void)[] = [];
  private nextId = 1;

  constructor(options: { factory?: WorkerFactory; capacity?: number } = {}) {
    this.factory = options.factory ?? defaultFactory;
    this.capacity = Math.max(1, options.capacity ?? poolCapacity());
  }

  /** Number of LIVE workers. Zero until the first acquire (creation is lazy). */
  size(): number {
    return this.slots.length;
  }

  /** Number of live workers not currently checked out. */
  idle(): number {
    return this.slots.filter((s) => !s.busy).length;
  }

  async acquire(): Promise<PooledWorker> {
    const free = this.slots.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return free;
    }
    if (this.slots.length < this.capacity) {
      const slot = this.spawn();
      slot.busy = true;
      return slot;
    }
    return new Promise<PooledWorker>((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(worker: PooledWorker): void {
    const slot = this.slotOf(worker);
    if (!slot) return;
    // Drop the finished job's handlers so a late message cannot reach it.
    slot.handlers = {};
    this.handOverOrPark(slot);
  }

  /**
   * Terminate this worker and replace it. Used by the cancel-timeout path in
   * pipeline.ts, and internally on a crash.
   */
  discard(worker: PooledWorker): void {
    const slot = this.slotOf(worker);
    if (!slot) return;
    this.kill(slot);
    this.handOverOrPark(this.spawn());
  }

  /** Tear the whole pool down (tests, page unload). */
  terminateAll(): void {
    for (const slot of [...this.slots]) this.kill(slot);
  }

  private spawn(): Slot {
    const slot = new Slot(this.nextId++, this.factory());
    const onError = (event: unknown) => this.handleCrash(slot, event);
    slot.worker.addEventListener('error', onError);
    slot.worker.addEventListener('messageerror', onError);
    slot.worker.addEventListener('message', (event: unknown) => {
      const data = (event as { data?: unknown } | null)?.data as WorkerToMainMessage | undefined;
      if (data) slot.handlers.message?.(data);
    });
    this.slots.push(slot);
    return slot;
  }

  private kill(slot: Slot): void {
    slot.dead = true;
    slot.handlers = {};
    const at = this.slots.indexOf(slot);
    if (at >= 0) this.slots.splice(at, 1);
    slot.worker.terminate();
  }

  private handleCrash(slot: Slot, event: unknown): void {
    if (slot.dead) return;
    const { crash } = slot.handlers;
    this.kill(slot);
    // Replace it eagerly so capacity is restored before the next acquire.
    this.handOverOrPark(this.spawn());
    // Only this worker's job is affected; every other job runs on.
    crash?.(new OpError('OutOfMemory', `Worker stopped: ${crashMessage(event)}`));
  }

  /** Give the slot to the next waiter, or park it as idle. */
  private handOverOrPark(slot: Slot): void {
    const next = this.waiting.shift();
    if (next) {
      slot.busy = true;
      next(slot);
      return;
    }
    slot.busy = false;
  }

  private slotOf(worker: PooledWorker): Slot | undefined {
    return this.slots.find((s) => s === worker);
  }
}

let shared: WorkerPool | null = null;

/** The process-wide pool. Created on first use; spawns nothing until acquired. */
export function sharedPool(): WorkerPool {
  shared ??= new WorkerPool();
  return shared;
}

export function acquire(): Promise<PooledWorker> {
  return sharedPool().acquire();
}

export function release(worker: PooledWorker): void {
  sharedPool().release(worker);
}

/** Live worker count of the shared pool. */
export function size(): number {
  return sharedPool().size();
}

export function discard(worker: PooledWorker): void {
  sharedPool().discard(worker);
}
