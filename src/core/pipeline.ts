// src/core/pipeline.ts — turn (toolId, files, options) into a running Job.
//
// `run()` returns synchronously; reading the files and acquiring a worker
// happen behind the returned Job. The pipeline itself knows nothing about
// formats: it relays the §3.1 protocol and enforces the two policies the
// contract cares about.
//
//   * PARTIAL SUCCESS IS REPORTED, NOT HIDDEN. A DoneMessage carrying a mix of
//     ok/failed FileResults resolves with `partial: true` — the job is not
//     thrown away because one input was bad. Only a job-level ErrorMessage
//     (nothing succeeded, or the failure cannot be blamed on one file) rejects.
//   * CANCEL HAS A DEADLINE. `cancel()` asks the worker to stop; if it has not
//     settled within CANCEL_GRACE_MS the worker is terminated and replaced, so
//     a runaway op cannot hold a core forever.
//
// Tool ids are NOT validated against the registry here — the worker's loader
// map is the authority, and an unknown id comes back as UnsupportedFormat.

import { OpError, type Job, type JobResult } from '../types';
import { readFiles } from './fs';
import { sharedPool, type PooledWorker, type WorkerPoolLike } from './workers/pool';
import type { WorkerToMainMessage } from './workers/protocol';

/** How long a cancelled worker gets to settle before it is terminated. */
export const CANCEL_GRACE_MS = 2000;

/** Injection seam: tests (and the browser test project) supply their own pool. */
export type RunDeps = {
  pool?: WorkerPoolLike;
  cancelGraceMs?: number;
};

let jobCounter = 0;

function nextJobId(): string {
  jobCounter += 1;
  return `job-${Date.now().toString(36)}-${jobCounter}`;
}

function cancelledError(): OpError {
  return new OpError('Cancelled', 'Cancelled');
}

function asOpError(error: unknown): OpError {
  if (error instanceof OpError) return error;
  return new OpError('OutOfMemory', error instanceof Error ? error.message : String(error));
}

export function run(
  toolId: string,
  files: File[],
  options: Record<string, unknown>,
  deps: RunDeps = {},
): Job {
  const pool = deps.pool ?? sharedPool();
  const graceMs = deps.cancelGraceMs ?? CANCEL_GRACE_MS;
  const id = nextJobId();

  const subscribers: ((fraction: number) => void)[] = [];
  let fraction = 0;
  let settled = false;
  let cancelRequested = false;
  let worker: PooledWorker | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;

  let settleResolve!: (result: JobResult) => void;
  let settleReject!: (error: OpError) => void;
  const done = new Promise<JobResult>((resolve, reject) => {
    settleResolve = resolve;
    settleReject = reject;
  });

  function emit(next: number): void {
    // Monotonic on this side too: a stale message cannot rewind the UI.
    fraction = Math.max(fraction, Math.min(1, Math.max(0, next)));
    for (const subscriber of subscribers) subscriber(fraction);
  }

  function clearGrace(): void {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  }

  /** Return the worker to the pool, or bin it if it can no longer be trusted. */
  function letGo(bin: boolean): void {
    const held = worker;
    worker = null;
    if (!held) return;
    if (bin) pool.discard(held);
    else pool.release(held);
  }

  function succeed(result: JobResult): void {
    if (settled) return;
    settled = true;
    clearGrace();
    letGo(false);
    emit(1);
    settleResolve(result);
  }

  function abandon(error: OpError, bin = false): void {
    if (settled) return;
    settled = true;
    clearGrace();
    letGo(bin);
    settleReject(error);
  }

  function onMessage(message: WorkerToMainMessage): void {
    if (message.jobId !== id || settled) return;
    switch (message.kind) {
      case 'progress':
        emit(message.fraction);
        return;
      case 'done': {
        const failed = message.results.filter((r) => r.status === 'failed').length;
        const ok = message.results.length - failed;
        succeed({
          outputs: message.outputs,
          results: message.results,
          partial: failed > 0 && ok > 0,
        });
        return;
      }
      case 'error':
        abandon(new OpError(message.code, message.message, message.file));
        return;
    }
  }

  void (async () => {
    try {
      if (cancelRequested) return;
      const inputs = await readFiles(files);
      if (cancelRequested || settled) return;

      const checkout = await pool.acquire();
      if (cancelRequested || settled) {
        pool.release(checkout);
        return;
      }
      worker = checkout;
      checkout.listen({
        message: onMessage,
        crash: (error) => {
          // The pool already terminated and replaced it; do not touch it again.
          worker = null;
          abandon(error);
        },
      });

      // TRANSFER, never clone: the buffers move into the worker.
      checkout.post(
        { kind: 'run', jobId: id, toolId, inputs, options },
        inputs.map((input) => input.buffer),
      );
    } catch (error) {
      abandon(asOpError(error));
    }
  })();

  return {
    id,
    onProgress(cb: (fraction: number) => void): void {
      subscribers.push(cb);
      // A late subscriber (e.g. a UI that mounted mid-job) sees where we are.
      if (fraction > 0) cb(fraction);
    },
    cancel(): void {
      if (settled || cancelRequested) return;
      cancelRequested = true;
      const held = worker;
      if (!held) {
        // Nothing is running yet; the driver above will stop before it starts.
        abandon(cancelledError());
        return;
      }
      held.post({ kind: 'cancel', jobId: id });
      graceTimer = setTimeout(() => {
        graceTimer = null;
        // The op ignored the signal: terminate and replace the worker.
        abandon(cancelledError(), true);
      }, graceMs);
    },
    done,
  };
}
