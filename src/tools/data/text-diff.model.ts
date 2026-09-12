// Immutable, serializable source contract shared by the workspace and export op.

import { splitLines } from './diff';

export const MAX_COMPARISON_BYTES = 10 * 1024 * 1024;
export const MAX_COMPARISON_LINES = 200_000;

export type ComparisonRules = Readonly<{ ignoreWhitespace: boolean; ignoreCase: boolean }>;
export type SourceOrigin = 'file' | 'text' | 'empty';

export type ReadySource = Readonly<{
  provided: true;
  text: string;
  name: string;
  origin: SourceOrigin;
  byteLength: number;
}>;

export type ComparisonSnapshot = Readonly<{
  schemaVersion: 1;
  revision: number;
  sources: readonly [ReadySource, ReadySource];
  rules: ComparisonRules;
}>;

export type SourceInput = Readonly<{
  text: string;
  name: string;
  origin: SourceOrigin;
}>;

export type ComparisonIdentity = Readonly<{
  rawIdentical: boolean;
  exactDisplayLinesIdentical: boolean;
  normalizedIdentical: boolean;
  metadataOnlyDifference: boolean;
}>;

export class TextDiffModelError extends Error {
  constructor(
    public readonly code: 'InvalidText' | 'InvalidSnapshot' | 'TooLarge',
    message: string,
  ) {
    super(message);
    this.name = 'TextDiffModelError';
  }
}

function hasOnlyValidSurrogates(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TextDiffModelError('InvalidSnapshot', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function freezeSource(input: SourceInput): ReadySource {
  if (typeof input.text !== 'string' || !hasOnlyValidSurrogates(input.text)) {
    throw new TextDiffModelError('InvalidText', 'Text contains an unpaired UTF-16 surrogate.');
  }
  if (typeof input.name !== 'string') {
    throw new TextDiffModelError('InvalidSnapshot', 'A source name must be a string.');
  }
  if (input.origin !== 'file' && input.origin !== 'text' && input.origin !== 'empty') {
    throw new TextDiffModelError('InvalidSnapshot', 'A source origin must be file, text, or empty.');
  }
  if (input.origin === 'empty' && input.text !== '') {
    throw new TextDiffModelError('InvalidSnapshot', 'An empty source must contain empty text.');
  }
  return Object.freeze({
    provided: true as const,
    text: input.text,
    name: input.name,
    origin: input.origin,
    // Recompute at the boundary; payload metadata is never an authority.
    byteLength: new TextEncoder().encode(input.text).byteLength,
  });
}

function enforceLimits(sources: readonly ReadySource[]): void {
  const bytes = sources.reduce((total, source) => total + source.byteLength, 0);
  if (bytes > MAX_COMPARISON_BYTES) {
    throw new TextDiffModelError('TooLarge', `Text Diff supports at most ${MAX_COMPARISON_BYTES} combined UTF-8 bytes.`);
  }
  const lines = sources.reduce((total, source) => total + splitLines(source.text).lines.length, 0);
  if (lines > MAX_COMPARISON_LINES) {
    throw new TextDiffModelError('TooLarge', `Text Diff supports at most ${MAX_COMPARISON_LINES} combined display lines.`);
  }
}

export function createComparisonSnapshot(input: {
  revision: number;
  sources: readonly [SourceInput, SourceInput];
  rules: ComparisonRules;
}): ComparisonSnapshot {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new TextDiffModelError('InvalidSnapshot', 'Snapshot revision must be a non-negative safe integer.');
  }
  if (typeof input.rules?.ignoreWhitespace !== 'boolean' || typeof input.rules?.ignoreCase !== 'boolean') {
    throw new TextDiffModelError('InvalidSnapshot', 'Snapshot rules must contain boolean ignoreWhitespace and ignoreCase values.');
  }
  const sources = [freezeSource(input.sources[0]), freezeSource(input.sources[1])] as const;
  enforceLimits(sources);
  return Object.freeze({
    schemaVersion: 1 as const,
    revision: input.revision,
    sources: Object.freeze(sources) as readonly [ReadySource, ReadySource],
    rules: Object.freeze({ ignoreWhitespace: input.rules.ignoreWhitespace, ignoreCase: input.rules.ignoreCase }),
  });
}

/** Parse an untrusted worker/op payload, recalculating derived byte metadata. */
export function validateComparisonSnapshot(value: unknown): ComparisonSnapshot {
  const snapshot = requireObject(value, 'comparisonSnapshot');
  if (snapshot.schemaVersion !== 1) {
    throw new TextDiffModelError('InvalidSnapshot', 'comparisonSnapshot.schemaVersion must be 1.');
  }
  if (!Array.isArray(snapshot.sources) || snapshot.sources.length !== 2) {
    throw new TextDiffModelError('InvalidSnapshot', 'comparisonSnapshot must contain exactly two provided sources.');
  }
  const sourceInput = snapshot.sources.map((value, index) => {
    const source = requireObject(value, `comparisonSnapshot.sources[${index}]`);
    if (source.provided !== true) {
      throw new TextDiffModelError('InvalidSnapshot', 'Only provided sources can form a comparison snapshot.');
    }
    return { text: source.text, name: source.name, origin: source.origin } as SourceInput;
  });
  const rules = requireObject(snapshot.rules, 'comparisonSnapshot.rules');
  return createComparisonSnapshot({
    revision: snapshot.revision as number,
    sources: [sourceInput[0] as SourceInput, sourceInput[1] as SourceInput],
    rules: { ignoreWhitespace: rules.ignoreWhitespace as boolean, ignoreCase: rules.ignoreCase as boolean },
  });
}

export function comparisonIdentity(snapshot: ComparisonSnapshot): ComparisonIdentity {
  const [a, b] = snapshot.sources;
  const rawIdentical = a.text === b.text;
  const aLines = splitLines(a.text).lines;
  const bLines = splitLines(b.text).lines;
  const same = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((line, index) => line === right[index]);
  const exactDisplayLinesIdentical = same(aLines, bLines);
  const normalize = (line: string): string => {
    let out = line;
    if (snapshot.rules.ignoreWhitespace) out = out.trim().replace(/\s+/g, ' ');
    if (snapshot.rules.ignoreCase) out = out.toLowerCase();
    return out;
  };
  const normalizedIdentical =
    aLines.length === bLines.length && aLines.every((line, index) => normalize(line) === normalize(bLines[index] as string));
  return Object.freeze({
    rawIdentical,
    exactDisplayLinesIdentical,
    normalizedIdentical,
    metadataOnlyDifference: !rawIdentical && exactDisplayLinesIdentical,
  });
}
