// Cloneable messages for the dedicated Text Diff preview worker.

import type { ComparisonIdentity, ComparisonRules, ComparisonSnapshot, SourceOrigin } from './text-diff.model';
import type { DiffStats, LineEnding, WordSegment } from './diff';

export const MAX_WINDOW_ROWS = 200;
export const MAX_WINDOW_CHARS = 100_000;
export const SLICE_TARGET = 4_000;

export type DiffDetail = 'line' | 'word' | 'character';
export type DiffContext = 0 | 3 | 10 | 'whole';
export type DiffSide = 'a' | 'b';

export type SourceRange = Readonly<{ side: DiffSide; start: number; end: number }>;
export type WindowCursor = Readonly<{ row: number; aOffset: number; bOffset: number }>;
export type GapExpansion = Readonly<{ startRow: number; lines: number }>;

export type LiveTextSource = Readonly<{ kind: 'text'; text: string; name: string; origin: SourceOrigin }>;
export type LiveFileSource = Readonly<{ kind: 'file'; file: File; name: string }>;
export type LiveSource = LiveTextSource | LiveFileSource;

/** Decode/validate a single pending source without inventing a second source. */
export type ReadRequest = Readonly<{
  kind: 'read';
  revision: number;
  requestId: number;
  source: LiveSource;
}>;

export type ComparisonRequest = Readonly<{
  kind: 'compare';
  revision: number;
  sources: readonly [LiveSource, LiveSource];
  rules: ComparisonRules;
}>;

export type WindowRequest = Readonly<{
  kind: 'window';
  revision: number;
  requestId: number;
  cursor: WindowCursor;
  detail: DiffDetail;
  context: DiffContext;
  expansions: readonly GapExpansion[];
  revealRow?: number;
}>;

export type FindRequest = Readonly<{
  kind: 'find';
  revision: number;
  requestId: number;
  query: string;
  matchCase: boolean;
  ordinal: number;
}>;

export type CopyRequest = Readonly<{
  kind: 'copy';
  revision: number;
  requestId: number;
  copy: 'changes' | 'source';
  side?: DiffSide;
  context?: DiffContext;
  range?: SourceRange;
}>;

export type MainToLiveWorker = ReadRequest | ComparisonRequest | WindowRequest | FindRequest | CopyRequest;

export type HunkTarget = Readonly<{
  id: string;
  kind: 'change' | 'metadata';
  row: number;
  endRow: number;
  aStart: number | null;
  aEnd: number | null;
  bStart: number | null;
  bEnd: number | null;
  message?: string;
}>;

export type WindowFragment = Readonly<{
  start: number;
  end: number;
  text: string;
  segments: readonly WordSegment[];
  sourceRange: SourceRange;
  complete: boolean;
  oversizedGrapheme: boolean;
}>;

export type WindowRow = Readonly<{
  kind: 'equal' | 'delete' | 'insert' | 'replace';
  row: number;
  aLine: number | null;
  bLine: number | null;
  a: WindowFragment | null;
  b: WindowFragment | null;
}>;

export type WindowGap = Readonly<{
  kind: 'gap';
  startRow: number;
  endRow: number;
  hiddenRows: number;
  expandable: number;
  /** Stable equal-run origin and cumulative revealed lines for successive clicks. */
  expansionStart: number;
  expandedLines: number;
}>;

export type WindowResponse = Readonly<{
  kind: 'window';
  revision: number;
  requestId: number;
  start: WindowCursor;
  next: WindowCursor | null;
  endOfComparison: boolean;
  rows: readonly (WindowRow | WindowGap)[];
  displayedRows: number;
  displayedCharacters: number;
  notices: readonly string[];
}>;

export type ReadyResponse = Readonly<{
  kind: 'ready';
  revision: number;
  snapshot: ComparisonSnapshot;
  identity: ComparisonIdentity;
  stats: DiffStats;
  sourceMeta: readonly [Readonly<{ lineCount: number; ending: LineEnding; hasBom: boolean; endsWithNewline: boolean }>, Readonly<{ lineCount: number; ending: LineEnding; hasBom: boolean; endsWithNewline: boolean }>];
  logicalRows: number;
  hunks: readonly HunkTarget[];
  notices: readonly string[];
}>;

export type SourceResponse = Readonly<{
  kind: 'source';
  revision: number;
  requestId: number;
  source: ComparisonSnapshot['sources'][number];
}>;

export type FindResponse = Readonly<{
  kind: 'find';
  revision: number;
  requestId: number;
  matchCount: number;
  ordinal: number | null;
  range: SourceRange | null;
  row: number | null;
  cursor: WindowCursor | null;
}>;

export type CopyResponse = Readonly<{
  kind: 'copy';
  revision: number;
  requestId: number;
  copy: 'changes' | 'source';
  text: string;
}>;

export type ProgressResponse = Readonly<{ kind: 'progress'; revision: number; progress: number }>;
export type LiveErrorCode = 'InvalidText' | 'InvalidSnapshot' | 'InvalidEncoding' | 'FileRead' | 'TooLarge' | 'NotReady' | 'InvalidRequest' | 'ExportTooLarge' | 'Internal';
export type ErrorResponse = Readonly<{ kind: 'error'; revision: number; requestId?: number; code: LiveErrorCode; message: string }>;
export type LiveWorkerToMain = ReadyResponse | SourceResponse | WindowResponse | FindResponse | CopyResponse | ProgressResponse | ErrorResponse;
