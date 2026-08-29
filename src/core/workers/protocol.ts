// src/core/workers/protocol.ts — §3.1 of the plan, verbatim. Canonical worker message protocol.

import type { OpInput, OpOutput, OpErrorCode, FileResult } from '../../types';

// main -> worker
export type RunMessage = {
  kind: 'run';
  jobId: string;
  toolId: string;
  inputs: OpInput[];                    // buffers TRANSFERRED, not cloned
  options: Record<string, unknown>;
};
export type CancelMessage = { kind: 'cancel'; jobId: string };

// worker -> main
export type ProgressMessage = { kind: 'progress'; jobId: string; fraction: number };
export type DoneMessage     = { kind: 'done'; jobId: string; outputs: OpOutput[]; results: FileResult[] };
export type ErrorMessage    = { kind: 'error'; jobId: string; code: OpErrorCode; message: string; file?: string };

export type MainToWorkerMessage = RunMessage | CancelMessage;
export type WorkerToMainMessage = ProgressMessage | DoneMessage | ErrorMessage;
