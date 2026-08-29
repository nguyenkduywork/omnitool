// src/core/workers/runner.worker.ts — the generic op host.
//
// It knows nothing about PDFs, images or zips. It resolves a tool id through a
// STATIC id -> loader map (literal `import()` calls only — Vite cannot
// code-split a dynamic template string, so a computed specifier would silently
// bundle nothing), runs the op, and speaks the §3.1 protocol.
//
// Two behaviours matter more than the rest:
//   * PER-FILE FAILURE. When an op throws an OpError naming a file, that file
//     is dropped and the op is retried with what is left. The job then reports
//     the outputs it really produced plus a `failed` entry for the bad input,
//     instead of throwing the whole batch away. An error that cannot be
//     attributed to one input (or one that kills every input) fails the job.
//   * TRANSFER. Output buffers leave on the transfer list, so the bytes move
//     to the main thread instead of being copied.

import { OpError, type FileResult, type Op, type OpInput } from '../../types';
import { DATA_LOADERS } from './loaders.data';
import { IMAGE_LOADERS } from './loaders.image';
import { PDF_LOADERS } from './loaders.pdf';
import type { MainToWorkerMessage, RunMessage, WorkerToMainMessage } from './protocol';

export type LoaderMap = Record<string, () => Promise<{ default: Op }>>;

/** Every tool the worker can host, merged from the per-group manifests. */
export const LOADERS: LoaderMap = {
  ...PDF_LOADERS,
  ...IMAGE_LOADERS,
  ...DATA_LOADERS,
};

export type PostToMain = (message: WorkerToMainMessage, transfer?: Transferable[]) => void;

/** At most one progress message per this many ms (plus a guaranteed final 1). */
export const PROGRESS_INTERVAL_MS = 50;

export type ProgressReporter = {
  /** Throttled and monotonic: never emits less than it already emitted. */
  report(fraction: number): void;
  /** Emits exactly 1, unconditionally. Called once, on success. */
  finish(): void;
};

export function createProgressReporter(
  emit: (fraction: number) => void,
  now: () => number = () => Date.now(),
  intervalMs: number = PROGRESS_INTERVAL_MS,
): ProgressReporter {
  let highWater = 0;
  let lastEmit = Number.NEGATIVE_INFINITY;

  return {
    report(fraction: number): void {
      const clamped = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : highWater;
      // Monotonic: an op that reports backwards cannot un-progress the UI.
      highWater = Math.max(highWater, clamped);
      const at = now();
      if (at - lastEmit < intervalMs) return;
      lastEmit = at;
      emit(highWater);
    },
    finish(): void {
      highWater = 1;
      lastEmit = now();
      emit(1);
    },
  };
}

function asOpError(error: unknown): OpError {
  if (error instanceof OpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  // A thrown non-OpError is a bug in the op or a genuine allocation failure;
  // OutOfMemory is the only honest code for "the op died and did not say why".
  return new OpError('OutOfMemory', message);
}

function cancelled(): OpError {
  return new OpError('Cancelled', 'Cancelled');
}

function results(inputs: OpInput[], failures: Map<number, FileResult>): FileResult[] {
  return inputs.map(
    (input, index) => failures.get(index) ?? { status: 'ok' as const, name: input.name },
  );
}

async function runJob(
  post: PostToMain,
  loaders: LoaderMap,
  message: RunMessage,
  inFlight: Map<string, AbortController>,
): Promise<void> {
  const { jobId, toolId, inputs, options } = message;
  const controller = new AbortController();
  inFlight.set(jobId, controller);
  const progress = createProgressReporter((fraction) =>
    post({ kind: 'progress', jobId, fraction }),
  );

  try {
    const loader = loaders[toolId];
    if (!loader) throw new OpError('UnsupportedFormat', `Unknown tool: ${toolId}`);
    const op = (await loader()).default;

    let remaining = inputs.map((input, index) => ({ input, index }));
    const failures = new Map<number, FileResult>();

    for (;;) {
      if (controller.signal.aborted) throw cancelled();
      try {
        const outputs = await op(
          remaining.map((entry) => entry.input),
          options,
          {
            onProgress: (fraction) => progress.report(fraction),
            signal: controller.signal,
          },
        );
        progress.finish();
        post(
          { kind: 'done', jobId, outputs, results: results(inputs, failures) },
          [...new Set(outputs.map((output) => output.buffer))],
        );
        return;
      } catch (error) {
        if (controller.signal.aborted) throw cancelled();
        const opError = asOpError(error);
        const at =
          opError.file === undefined
            ? -1
            : remaining.findIndex((entry) => entry.input.name === opError.file);
        // Not attributable to a single input: the whole job failed.
        if (at < 0) throw opError;

        const bad = remaining[at];
        if (!bad) throw opError;
        remaining = remaining.filter((_, index) => index !== at);
        failures.set(bad.index, {
          status: 'failed',
          name: bad.input.name,
          code: opError.code,
          message: opError.message,
        });
        // Everything failed — there is no partial success to report.
        if (remaining.length === 0) throw opError;
      }
    }
  } catch (error) {
    const opError = asOpError(error);
    post({
      kind: 'error',
      jobId,
      code: opError.code,
      message: opError.message,
      ...(opError.file === undefined ? {} : { file: opError.file }),
    });
  } finally {
    inFlight.delete(jobId);
  }
}

export type Runner = { handle(message: MainToWorkerMessage): void };

/**
 * The worker's whole behaviour, with its two dependencies (how to reach the
 * main thread, and which ops exist) passed in — which is what lets the runner
 * be tested headlessly.
 */
export function createRunner(post: PostToMain, loaders: LoaderMap = LOADERS): Runner {
  const inFlight = new Map<string, AbortController>();

  return {
    handle(message: MainToWorkerMessage): void {
      if (message.kind === 'cancel') {
        inFlight.get(message.jobId)?.abort();
        return;
      }
      void runJob(post, loaders, message, inFlight);
    },
  };
}

// --- worker entry wiring ---------------------------------------------------
// Guarded so this module can also be imported by tests on the main thread
// (Node) without trying to install a message handler on nothing.

type WorkerScope = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
};

function workerScope(): WorkerScope | null {
  const scope = globalThis as {
    postMessage?: unknown;
    addEventListener?: unknown;
    window?: unknown;
    document?: unknown;
  };
  // A window/document means the main thread; no postMessage means Node.
  if (scope.window !== undefined || scope.document !== undefined) return null;
  if (typeof scope.postMessage !== 'function' || typeof scope.addEventListener !== 'function') {
    return null;
  }
  return globalThis as unknown as WorkerScope;
}

const scope = workerScope();
if (scope) {
  const runner = createRunner(
    (message, transfer = []) => scope.postMessage(message, transfer),
    LOADERS,
  );
  scope.addEventListener('message', (event) => {
    const data = event.data as MainToWorkerMessage | undefined;
    if (data) runner.handle(data);
  });
}
