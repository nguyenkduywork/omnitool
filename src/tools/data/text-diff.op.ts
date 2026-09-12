// Text Diff export operation. Source snapshots are validated before work starts.

import { OpError, type Op, type OpInput, type OpOutput } from '../../types';

import { diffLines } from './diff';
import { serializeExactPatch, serializeHtmlReport, TextDiffExportError } from './text-diff.export';
import {
  createComparisonSnapshot,
  comparisonIdentity,
  TextDiffModelError,
  validateComparisonSnapshot,
  type ComparisonSnapshot,
  type SourceInput,
} from './text-diff.model';

type Format = 'html' | 'unified';
type Scope = 'changes' | 'whole';
type Detail = 'line' | 'word' | 'character';
type LegacySide = { name: string; text: string; fromFile: boolean };

const FORMATS: Format[] = ['html', 'unified'];
const SCOPES: Scope[] = ['changes', 'whole'];
const DETAILS: Detail[] = ['line', 'word', 'character'];
const PASTED = { left: 'original text', right: 'changed text' } as const;

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

function validateChoice<T extends string>(raw: unknown, allowed: T[], def: T, label: string): T {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new OpError('InvalidOptions', `${label} must be one of ${allowed.join(', ')}, got ${JSON.stringify(raw)}`);
  }
  return value as T;
}

function validateBool(raw: unknown, def: boolean, label: string): boolean {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'boolean') throw new OpError('InvalidOptions', `${label} must be a boolean, got ${JSON.stringify(raw)}`);
  return value;
}

function validateText(raw: unknown, label: string): string {
  const value = raw === undefined ? '' : raw;
  if (typeof value !== 'string') throw new OpError('InvalidOptions', `${label} must be a string, got ${JSON.stringify(raw)}`);
  return value;
}

function validateNumber(raw: unknown, def: number, min: number, max: number, label: string): number {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new OpError('InvalidOptions', `${label} must be a number between ${min} and ${max}, got ${JSON.stringify(raw)}`);
  }
  return Math.round(value);
}

function decodeText(input: OpInput): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.buffer);
  } catch {
    throw new OpError('UnsupportedFormat', `${input.name} is not valid UTF-8 text — this tool compares text and source files`, input.name);
  }
}

function stem(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

function toArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function modelError(error: unknown): never {
  if (error instanceof TextDiffModelError) throw new OpError(error.code === 'TooLarge' ? 'TooLarge' : 'InvalidOptions', error.message);
  if (error instanceof TextDiffExportError) throw new OpError('TooLarge', error.message);
  throw error;
}

function snapshotFromLegacy(
  inputs: OpInput[],
  options: Record<string, unknown>,
  leftText: string,
  rightText: string,
  rules: { ignoreWhitespace: boolean; ignoreCase: boolean },
): ComparisonSnapshot {
  const sideOf = (input: OpInput | undefined, pasted: string, fallbackName: string): LegacySide =>
    input ? { name: input.name, text: decodeText(input), fromFile: true } : { name: fallbackName, text: pasted, fromFile: false };
  const first = sideOf(inputs[0], leftText, PASTED.left);
  const second = sideOf(inputs[1], rightText, PASTED.right);
  const leftProvided = inputs[0] !== undefined || Object.hasOwn(options, 'leftText');
  const rightProvided = inputs[1] !== undefined || Object.hasOwn(options, 'rightText');
  if (!leftProvided && !rightProvided) {
    throw new OpError('InvalidOptions', 'Nothing to compare yet — provide two sources or an explicitly empty source.');
  }
  try {
    return createComparisonSnapshot({
      revision: 0,
      sources: [
        { text: first.text, name: first.name, origin: first.fromFile ? 'file' : leftProvided && first.text === '' ? 'empty' : 'text' },
        { text: second.text, name: second.name, origin: second.fromFile ? 'file' : rightProvided && second.text === '' ? 'empty' : 'text' },
      ] as [SourceInput, SourceInput],
      rules,
    });
  } catch (error) {
    return modelError(error);
  }
}

const textDiff: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length > 2) throw new OpError('InvalidOptions', `Compare text takes at most 2 files — it was given ${inputs.length}.`);
  const format = validateChoice(options.format, FORMATS, 'html', 'format');
  const scope = validateChoice(options.scope, SCOPES, 'changes', 'scope');
  const detail = validateChoice(options.detail, DETAILS, 'word', 'detail');
  const context = validateNumber(options.context, 3, 0, 100, 'context');
  const ignoreWhitespace = validateBool(options.ignoreWhitespace, false, 'ignoreWhitespace');
  const ignoreCase = validateBool(options.ignoreCase, false, 'ignoreCase');
  const swap = validateBool(options.swap, false, 'swap');
  const leftText = validateText(options.leftText, 'leftText');
  const rightText = validateText(options.rightText, 'rightText');
  const hasSnapshot = Object.hasOwn(options, 'comparisonSnapshot');
  if (hasSnapshot && (inputs.length !== 0 || Object.hasOwn(options, 'leftText') || Object.hasOwn(options, 'rightText') || Object.hasOwn(options, 'ignoreWhitespace') || Object.hasOwn(options, 'ignoreCase') || Object.hasOwn(options, 'swap'))) {
    throw new OpError('InvalidOptions', 'comparisonSnapshot cannot be combined with files or legacy source, rule, or direction options.');
  }

  stop(ctx.signal);
  let snapshot: ComparisonSnapshot;
  try {
    snapshot = hasSnapshot ? validateComparisonSnapshot(options.comparisonSnapshot) : snapshotFromLegacy(inputs, options, leftText, rightText, { ignoreWhitespace, ignoreCase });
  } catch (error) {
    return modelError(error);
  }
  ctx.onProgress(0.25);
  stop(ctx.signal);
  ctx.onProgress(0.5);

  const [first, second] = snapshot.sources;
  const left = swap ? second : first;
  const right = swap ? first : second;
  const result = diffLines(left.text, right.text, { ...snapshot.rules, check: () => stop(ctx.signal) });
  ctx.onProgress(0.8);
  stop(ctx.signal);
  const name = left.origin !== 'file' && right.origin !== 'file' ? 'comparison' : `${left.origin === 'file' ? stem(left.name) : 'pasted'}-vs-${right.origin === 'file' ? stem(right.name) : 'pasted'}`;

  try {
    if (format === 'unified') {
      const patch = serializeExactPatch(left.text, right.text, { target: left.name, context: scope === 'whole' ? Number.MAX_SAFE_INTEGER : context });
      ctx.onProgress(1);
      return patch ? [{ name: `${name}.diff`, type: 'text/plain', buffer: toArrayBuffer(patch) }] : [];
    }
    const html = serializeHtmlReport({
      result,
      names: { a: left.name, b: right.name },
      options: { ...snapshot.rules, check: () => stop(ctx.signal) },
      scope,
      context: scope === 'whole' ? Number.POSITIVE_INFINITY : context,
      detail,
      identity: comparisonIdentity(snapshot),
      rawSources: { a: left.text, b: right.text },
    });
    ctx.onProgress(1);
    return [{ name: `${name}.html`, type: 'text/html', buffer: toArrayBuffer(html) }];
  } catch (error) {
    return modelError(error);
  }
};

export default textDiff;
