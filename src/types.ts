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

/**
 * What KIND of thing a tool is. `accepts` describes a transform completely and
 * a generator not at all, which is why one axis was never enough.
 *
 *   transform — files in, files out; `accepts` is the whole story
 *   generate  — no files at all: options in, files out
 *   utility   — runs on any bytes; never the reason you opened the app
 */
export type ToolKind = 'transform' | 'generate' | 'utility';

/** All a registry predicate may see: metadata, never contents. */
export type SniffedFile = { name: string; size: number; type: string };

/** Option defaults derived from the inputs, each with a reason to show. */
export type Preset = {
  values: Record<string, unknown>;
  /** option key -> why it was preset, e.g. "from the file's gzip signature". */
  because: Record<string, string>;
};

export type ToolDef = {
  id: string;
  name: string;
  blurb: string;
  group: ToolGroup;
  kind: ToolKind;
  /** Mime types, or the wildcards 'image/*' / '*'. */
  accepts: string[];
  minInputs: number;
  /** null means unbounded. */
  maxInputs: number | null;
  options?: OptionSchema;
  editor?: () => Promise<{ default: ToolEditor }>;
  /** Defaults read off the inputs' metadata. Pure and synchronous — never
   *  reads file contents (see the design spec, §3.2). */
  preset?: (files: readonly SniffedFile[]) => Preset;
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
