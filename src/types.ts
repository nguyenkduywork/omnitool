// src/types.ts — dependency-free. Imports nothing. Imported by core/, ui/, tools/.

export type OpInput  = { name: string; type: string; buffer: ArrayBuffer };
export type OpOutput = { name: string; type: string; buffer: ArrayBuffer };

export type OpContext = {
  /** Report progress in the range 0..1. Must be called at least once per input. */
  onProgress(fraction: number): void;
  signal: AbortSignal;
};

export type Op = (
  inputs: OpInput[],
  options: Record<string, unknown>,
  ctx: OpContext,
) => Promise<OpOutput[]>;

export type OpErrorCode =
  | 'UnsupportedFormat'
  | 'CorruptFile'
  | 'TooLarge'
  | 'EncoderUnavailable'
  | 'InvalidOptions'
  | 'Cancelled'
  | 'OutOfMemory';

export class OpError extends Error {
  constructor(
    public readonly code: OpErrorCode,
    message: string,
    public readonly file?: string,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

export type OptionDef =
  | { kind: 'select'; label: string; choices: { value: string; label: string }[]; default: string }
  | { kind: 'number'; label: string; min: number; max: number; step: number; default: number }
  | { kind: 'range';  label: string; min: number; max: number; step: number; default: number }
  | { kind: 'toggle'; label: string; default: boolean }
  | { kind: 'text';   label: string; placeholder?: string; default: string };

export type OptionSchema = Record<string, OptionDef>;

export type ToolGroup = 'pdf' | 'image' | 'data';

/** Renders a bespoke options editor. Returns a teardown function. */
export type ToolEditor = (
  mount: HTMLElement,
  inputs: File[],
  onChange: (options: Record<string, unknown>) => void,
) => () => void;

export type ToolDef = {
  id: string;
  name: string;
  blurb: string;
  group: ToolGroup;
  /** Mime types, or the wildcards 'image/*' / '*'. */
  accepts: string[];
  minInputs: number;
  /** null means unbounded. */
  maxInputs: number | null;
  options?: OptionSchema;
  editor?: () => Promise<{ default: ToolEditor }>;
  load: () => Promise<{ default: Op }>;
};

/** Per-input outcome. A job reports partial success honestly. */
export type FileResult =
  | { status: 'ok'; name: string }
  | { status: 'failed'; name: string; code: OpErrorCode; message: string };

export type JobResult = {
  outputs: OpOutput[];
  results: FileResult[];
  /** True when at least one input failed but others succeeded. */
  partial: boolean;
};

export type Job = {
  readonly id: string;
  onProgress(cb: (fraction: number) => void): void;
  cancel(): void;
  readonly done: Promise<JobResult>;
};
