// src/tools/data/text-clean.op.ts — text-clean: line-level tidying for a text
// file. Sort, remove duplicates, trim trailing whitespace, drop blank lines,
// and normalise line endings.
//
// THE ORDER IS FIXED, and it is the only order that makes the options compose:
//
//   1. trim trailing whitespace   — so "a  " and "a" can be seen as equal
//   2. drop blank lines           — after trimming, a whitespace-only line IS blank
//   3. remove duplicates          — keeping the FIRST occurrence, in place
//   4. sort
//
// Deduplicating before trimming would keep both "a" and "a  "; dropping blanks
// before trimming would keep the line that is nothing but spaces.
//
// SORTING IS CODE-UNIT ORDER, not locale collation: `localeCompare` gives
// different answers in different runtimes and under different locales, and a
// tool whose output depends on where it ran is not a tool you can check into a
// repository. In practice that means uppercase sorts before lowercase ("Zebra"
// before "apple") and digits before letters — the same order `sort` gives you
// under `LC_ALL=C`.
//
// Two things are preserved on purpose, because losing them silently corrupts a
// file that other software reads: a leading UTF-8 byte-order mark, and whether
// the file ended with a newline. Leading whitespace is preserved too — it is
// indentation, and only the trailing kind is invisible noise.
//
// A file that comes out identical to the way it went in is handed back as its
// original bytes rather than re-encoded.

import { OpError, type Op, type OpOutput } from '../../types';

type Sort = 'none' | 'asc' | 'desc';
type Endings = 'keep' | 'lf' | 'crlf';

const SORTS: Sort[] = ['none', 'asc', 'desc'];
const ENDINGS: Endings[] = ['keep', 'lf', 'crlf'];

/** U+FEFF, written as an escape because it is invisible in a source file. */
const BOM = '\uFEFF';

function stop(signal: AbortSignal): void {
  if (signal.aborted) throw new OpError('Cancelled', 'Cancelled');
}

function validateChoice<T extends string>(raw: unknown, allowed: T[], def: T, label: string): T {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new OpError(
      'InvalidOptions',
      `${label} must be one of ${allowed.join(', ')}, got ${JSON.stringify(raw)}`,
    );
  }
  return value as T;
}

function validateBool(raw: unknown, def: boolean, label: string): boolean {
  const value = raw === undefined ? def : raw;
  if (typeof value !== 'boolean') {
    throw new OpError('InvalidOptions', `${label} must be a boolean, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Code-unit comparison: deterministic in every runtime, unlike localeCompare. */
function compare(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export type TextCleanOptions = {
  sort: Sort;
  dedupe: boolean;
  trim: boolean;
  dropBlank: boolean;
  endings: Endings;
};

/**
 * The whole transformation, as a pure string -> string function so it can be
 * tested (and reasoned about) without any file plumbing around it.
 */
export function cleanText(text: string, options: TextCleanOptions): string {
  const hasBom = text.startsWith(BOM);
  const body = hasBom ? text.slice(BOM.length) : text;

  // 'keep' follows the file: any CRLF at all means the file is a CRLF file.
  const eol = options.endings === 'crlf' || (options.endings === 'keep' && body.includes('\r\n'))
    ? '\r\n'
    : '\n';

  // A trailing newline is a terminator, not an empty last line — split would
  // turn it into one, and joining would then lose it.
  const endsWithNewline = /\r\n$|\n$|\r$/.test(body);
  const trimmedBody = endsWithNewline ? body.replace(/\r\n$|\n$|\r$/, '') : body;

  // An EMPTY FILE has no lines at all, and `''.split()` would claim it has one.
  // A file that is nothing but a newline, though, IS one blank line — which is
  // just what splitting its (now empty) body gives, so only `body` is guarded.
  let lines = body === '' ? [] : trimmedBody.split(/\r\n|\n|\r/);

  if (options.trim) lines = lines.map((line) => line.replace(/[ \t\f\v]+$/, ''));
  if (options.dropBlank) lines = lines.filter((line) => line !== '');
  if (options.dedupe) {
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const line of lines) {
      if (seen.has(line)) continue;
      seen.add(line);
      unique.push(line);
    }
    lines = unique;
  }
  if (options.sort !== 'none') {
    const direction = options.sort === 'asc' ? 1 : -1;
    lines = [...lines].sort((a, b) => direction * compare(a, b));
  }

  const joined = lines.join(eol);
  // No lines left (every one was blank, and blanks were dropped) means no
  // terminator either: a file emptied of content must not come back as a lone
  // newline.
  const tail = endsWithNewline && lines.length > 0 ? eol : '';
  return `${hasBom ? BOM : ''}${joined}${tail}`;
}

const textClean: Op = async (inputs, options, ctx): Promise<OpOutput[]> => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'Clean up text needs at least one text file.');
  }

  const settings: TextCleanOptions = {
    sort: validateChoice(options.sort, SORTS, 'none', 'sort'),
    dedupe: validateBool(options.dedupe, false, 'dedupe'),
    trim: validateBool(options.trim, true, 'trim'),
    dropBlank: validateBool(options.dropBlank, false, 'dropBlank'),
    endings: validateChoice(options.endings, ENDINGS, 'keep', 'endings'),
  };

  const outputs: OpOutput[] = [];

  for (let index = 0; index < inputs.length; index++) {
    stop(ctx.signal);
    const input = inputs[index];
    if (input === undefined) continue;

    let text: string;
    try {
      // `ignoreBOM` keeps the mark in the string so it can be put back; without
      // it the decoder eats the BOM and the output silently loses it.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(input.buffer);
    } catch {
      throw new OpError(
        'CorruptFile',
        `${input.name} is not valid UTF-8 text — this tool cannot read it`,
        input.name,
      );
    }

    const cleaned = cleanText(text, settings);
    outputs.push({
      name: input.name,
      type: input.type || 'text/plain',
      // Nothing changed: hand back the exact bytes rather than re-encoding.
      buffer: cleaned === text ? input.buffer : toArrayBuffer(cleaned),
    });

    ctx.onProgress((index + 1) / inputs.length);
  }

  return outputs;
};

function toArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

export default textClean;
