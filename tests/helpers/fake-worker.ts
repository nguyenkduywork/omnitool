// tests/helpers/fake-worker.ts
//
// A faithful stand-in for a real `Worker`, used because the vitest `node`
// environment has no global Worker (verified: `typeof Worker === 'undefined'`
// on Node 24). It is NOT a mock of the kernel: it hosts the REAL runner
// (`createRunner` from src/core/workers/runner.worker.ts) and moves messages
// with `structuredClone(msg, { transfer })`, which detaches transferred
// ArrayBuffers exactly the way `postMessage` does. So everything except the
// platform Worker class itself is the production code path.

import type { MainToWorkerMessage, WorkerToMainMessage } from '../../src/core/workers/protocol';
import type { WorkerLike } from '../../src/core/workers/pool';
import { LOADERS, createRunner, type LoaderMap } from '../../src/core/workers/runner.worker';

export type SentToMain = { message: WorkerToMainMessage; transfer: Transferable[] };

export type FakeWorkerOptions = {
  /** Override the id -> op map so a test can install a throwing/hanging op. */
  loaders?: LoaderMap;
};

type Listener = (event: unknown) => void;

export class FakeWorker implements WorkerLike {
  /** Every FakeWorker ever constructed, in creation order. */
  static instances: FakeWorker[] = [];

  static reset(): void {
    FakeWorker.instances = [];
  }

  /** Messages the worker posted to the main thread, with their transfer lists. */
  readonly sentToMain: SentToMain[] = [];
  /** Messages the worker received, as delivered (i.e. after transfer). */
  readonly received: MainToWorkerMessage[] = [];
  terminated = false;

  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly runner: { handle(message: MainToWorkerMessage): void };

  constructor(options: FakeWorkerOptions = {}) {
    FakeWorker.instances.push(this);
    this.runner = createRunner((message, transfer = []) => {
      this.sentToMain.push({ message, transfer });
      // A terminated worker can no longer reach the main thread.
      if (this.terminated) return;
      const delivered = structuredClone(message, { transfer });
      this.dispatch('message', { data: delivered });
    }, options.loaders ?? LOADERS);
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    if (this.terminated) return;
    // Real transfer semantics: listed buffers are MOVED; the sender's copies detach.
    const delivered = structuredClone(message, { transfer }) as MainToWorkerMessage;
    this.received.push(delivered);
    setTimeout(() => {
      if (!this.terminated) this.runner.handle(delivered);
    }, 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Test hook: simulate the browser firing `error` on this worker (e.g. OOM). */
  crash(message = 'simulated worker crash'): void {
    this.dispatch('error', { type: 'error', message });
  }

  /** Test hook: simulate an undeserialisable message arriving from the worker. */
  messageError(): void {
    this.dispatch('messageerror', { type: 'messageerror' });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

/** A worker factory that hands out FakeWorkers sharing one loader map. */
export function fakeFactory(options: FakeWorkerOptions = {}): () => WorkerLike {
  return () => new FakeWorker(options);
}

/** Wait for the fake worker's `setTimeout(0)` hops plus pending microtasks. */
export function tick(times = 4): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise<void>((r) => setTimeout(r, 0)));
  return p;
}
