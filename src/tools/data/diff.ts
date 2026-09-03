// src/tools/data/diff.ts — the diff engine, shared by the op and its editor.
//
// A SIBLING MODULE, exactly like pdf/page-range.ts and data/tar.ts: it obeys
// the same rules its callers do (no core/, no ui/, no DOM), which is what lets
// `text-diff.op.ts` (a worker) and `text-diff.editor.ts` (the DOM viewer) share
// one implementation instead of drifting into two.
//
// THE ALGORITHM, AND WHY IT IS NOT JUST MYERS
//
// Myers' O(ND) diff is minimal — it finds the shortest edit script — but for
// source code "shortest" and "readable" are not the same thing. Given two
// versions of a file with several `}` lines, a minimal script happily matches
// the closing brace of one function with the closing brace of another and
// reports a change that no human would describe that way. That is why git
// ships `--patience`/`--histogram` at all.
//
// So this is patience-first, Myers-inside:
//
//   1. Trim the common prefix and suffix. On two versions of one file this
//      alone removes the overwhelming majority of the lines.
//   2. Find lines that occur EXACTLY ONCE in each side and are equal. Those
//      are unambiguous anchors — a line unique on both sides can only match
//      one thing. The longest increasing subsequence of them (in the order
//      they appear on side A) is the alignment skeleton.
//   3. Recurse into each gap between anchors, and only when a gap has no
//      unique line left in it does Myers run over that gap alone.
//
// The gaps are small, so Myers is fast and its O(D^2) snapshot memory stays
// bounded; MYERS_CAP is the belt-and-braces limit for a pathological gap, and
// when it trips the gap becomes one honest "this block was replaced" rather
// than a wrong alignment or a hang.
//
// EVERYTHING HERE COMPARES INTERNED LINE IDS, NOT STRINGS. Lines are mapped to
// integers once, under the caller's ignore-whitespace/ignore-case rules, so
// every comparison in the hot loops is an integer compare and the ignore
// options cost nothing per comparison.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LineEnding = 'lf' | 'crlf' | 'cr' | 'mixed' | 'none';

export type SplitText = {
  /** The lines, WITHOUT their terminators. A trailing newline is a terminator,
   *  not an empty last line — see text-clean.op.ts, which makes the same call. */
  lines: string[];
  ending: LineEnding;
  hasBom: boolean;
  endsWithNewline: boolean;
};

export type DiffBlock =
  | { kind: 'equal'; aStart: number; aCount: number; bStart: number; bCount: number }
  | { kind: 'delete'; aStart: number; aCount: number; bStart: number; bCount: 0 }
  | { kind: 'insert'; aStart: number; aCount: 0; bStart: number; bCount: number }
  | { kind: 'replace'; aStart: number; aCount: number; bStart: number; bCount: number };

/** One printed line of the comparison. `a`/`b` are 0-based line indices. */
export type DiffRow =
  | { kind: 'equal'; a: number; b: number }
  | { kind: 'delete'; a: number; b: null }
  | { kind: 'insert'; a: null; b: number }
  | { kind: 'replace'; a: number; b: number };

/**
 * A run of unchanged rows that was folded away, and how many it stands for.
 * `at` is where the run starts in the UNFOLDED rows, so a viewer that lets the
 * reader open a gap can slice it back out without searching for it.
 */
export type GapRow = { kind: 'gap'; count: number; at: number; a: number; b: number };

export type DiffStats = {
  added: number;
  removed: number;
  /** Lines paired up as a modification: counted once, not as an add AND a delete. */
  changed: number;
  unchanged: number;
  /** Contiguous runs of change — what "next change" steps through. */
  hunks: number;
  /** 0..1, unchanged lines over the larger side. 1 means the lines are identical. */
  similarity: number;
};

export type DiffOptions = {
  /** Compare lines with leading/trailing whitespace removed and internal runs
   *  collapsed to one space. Reindentation stops reading as a rewrite. */
  ignoreWhitespace?: boolean;
  ignoreCase?: boolean;
  /** Called periodically during the walk. Throw from it to abort. */
  check?: () => void;
};

export type DiffResult = {
  a: SplitText;
  b: SplitText;
  blocks: DiffBlock[];
  stats: DiffStats;
  /** True when the LINES are all equal — the bytes may still differ, see below. */
  identicalLines: boolean;
  /** Identical lines, but the files are not byte-identical: the only remaining
   *  differences are the line terminators and/or a byte-order mark. Worth
   *  saying out loud, because otherwise a diff that reports "no changes" on two
   *  files of different sizes looks broken. */
  onlyEndingsDiffer: boolean;
  /** True when a gap was too tangled for Myers inside MYERS_CAP and became a
   *  wholesale replacement. Reported rather than hidden. */
  degraded: boolean;
};

export type WordSegment = { text: string; changed: boolean };

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

/** U+FEFF, written as an escape because it is invisible in a source file. */
const BOM = '﻿';

export function splitLines(text: string): SplitText {
  const hasBom = text.startsWith(BOM);
  const body = hasBom ? text.slice(BOM.length) : text;

  const crlf = body.includes('\r\n');
  // A lone \r that is not part of a \r\n is a classic-Mac terminator.
  const cr = /\r(?!\n)/.test(body);
  const lf = /(?<!\r)\n/.test(body);
  const kinds = (crlf ? 1 : 0) + (cr ? 1 : 0) + (lf ? 1 : 0);
  const ending: LineEnding =
    kinds === 0 ? 'none' : kinds > 1 ? 'mixed' : crlf ? 'crlf' : cr ? 'cr' : 'lf';

  const endsWithNewline = /\r\n$|\n$|\r$/.test(body);
  const trimmed = endsWithNewline ? body.replace(/\r\n$|\n$|\r$/, '') : body;
  const lines = body === '' ? [] : trimmed.split(/\r\n|\n|\r/);

  return { lines, ending, hasBom, endsWithNewline };
}

// ---------------------------------------------------------------------------
// Interning
// ---------------------------------------------------------------------------

function comparisonKey(line: string, options: DiffOptions): string {
  let key = line;
  if (options.ignoreWhitespace) key = key.trim().replace(/\s+/g, ' ');
  if (options.ignoreCase) key = key.toLowerCase();
  return key;
}

/** Map both sides' lines onto integers under one shared dictionary. */
function intern(a: string[], b: string[], options: DiffOptions): { aIds: Int32Array; bIds: Int32Array } {
  const ids = new Map<string, number>();
  const encode = (lines: string[]): Int32Array => {
    const out = new Int32Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      const key = comparisonKey(lines[i] as string, options);
      let id = ids.get(key);
      if (id === undefined) {
        id = ids.size;
        ids.set(key, id);
      }
      out[i] = id;
    }
    return out;
  };
  return { aIds: encode(a), bIds: encode(b) };
}

// ---------------------------------------------------------------------------
// The edit-script accumulator
// ---------------------------------------------------------------------------

type RawKind = 'equal' | 'delete' | 'insert';
type RawOp = { kind: RawKind; a: number; b: number; count: number };

/**
 * Collects per-line operations and merges contiguous ones as they arrive, so a
 * 5,000-line unchanged region is one entry rather than 5,000.
 */
class Script {
  readonly ops: RawOp[] = [];

  push(kind: RawKind, a: number, b: number, count: number): void {
    if (count <= 0) return;
    const last = this.ops[this.ops.length - 1];
    if (last && last.kind === kind) {
      const aEnd = last.a + (kind === 'insert' ? 0 : last.count);
      const bEnd = last.b + (kind === 'delete' ? 0 : last.count);
      if (aEnd === a && bEnd === b) {
        last.count += count;
        return;
      }
    }
    this.ops.push({ kind, a, b, count });
  }
}

// ---------------------------------------------------------------------------
// Myers, greedy forward with per-D snapshots
// ---------------------------------------------------------------------------

/**
 * The largest edit distance Myers is allowed to reach inside one gap.
 *
 * Cost is the reason for a ceiling at all: the algorithm keeps one snapshot per
 * D, so memory is O(D^2). At 3,000 that is ~9M int32 worst case (~36 MB) and it
 * is only ever approached by two files with no shared structure at all — which
 * is exactly the case where a line-by-line alignment is worthless anyway.
 */
const MYERS_CAP = 3000;

/**
 * Shortest edit script between a[aLo,aHi) and b[bLo,bHi), or null if it would
 * cost more than `cap` edits.
 *
 * Snapshots hold the window k in [-d-1, d+1] rather than [-d, d]: the backtrack
 * below reads v[k-1] and v[k+1], and a window sized exactly to the pass would
 * put those one step out of bounds on the edges.
 */
function myers(
  a: Int32Array,
  b: Int32Array,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  cap: number,
  check: (() => void) | undefined,
): RawOp[] | null {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const max = n + m;
  if (max === 0) return [];

  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  let found = -1;
  for (let d = 0; d <= max && d <= cap; d++) {
    if (check && (d & 0x3f) === 0) check();
    trace.push(v.slice(offset - d - 1, offset + d + 2));

    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number));
      let x = down ? (v[offset + k + 1] as number) : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }

  if (found < 0) return null;

  // Walk the trace back to the origin, newest snapshot first.
  const reversed: RawOp[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const snapshot = trace[d] as Int32Array;
    const window = d + 1; // snapshot[i] holds k = i - window
    const k = x - y;
    const down =
      k === -d ||
      (k !== d && (snapshot[k - 1 + window] as number) < (snapshot[k + 1 + window] as number));
    const prevK = down ? k + 1 : k - 1;
    const prevX = snapshot[prevK + window] as number;
    const prevY = prevX - prevK;

    if (x > prevX && y > prevY) {
      const run = Math.min(x - prevX, y - prevY);
      reversed.push({ kind: 'equal', a: aLo + x - run, b: bLo + y - run, count: run });
      x -= run;
      y -= run;
    }
    if (down) reversed.push({ kind: 'insert', a: aLo + x, b: bLo + y - 1, count: 1 });
    else reversed.push({ kind: 'delete', a: aLo + x - 1, b: bLo + y, count: 1 });
    x = prevX;
    y = prevY;
  }
  if (x > 0) reversed.push({ kind: 'equal', a: aLo, b: bLo, count: x });

  return reversed.reverse();
}

// ---------------------------------------------------------------------------
// Patience anchoring
// ---------------------------------------------------------------------------

/** How deep the anchor recursion may go before it hands the rest to Myers. */
const MAX_DEPTH = 32;

/** Lines occurring exactly once on BOTH sides, paired, in A order. */
function uniqueAnchors(
  a: Int32Array,
  b: Int32Array,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
): { a: number; b: number }[] {
  const inA = new Map<number, number>();
  const atA = new Map<number, number>();
  for (let i = aLo; i < aHi; i++) {
    const id = a[i] as number;
    inA.set(id, (inA.get(id) ?? 0) + 1);
    atA.set(id, i);
  }
  const inB = new Map<number, number>();
  const atB = new Map<number, number>();
  for (let j = bLo; j < bHi; j++) {
    const id = b[j] as number;
    inB.set(id, (inB.get(id) ?? 0) + 1);
    atB.set(id, j);
  }

  const pairs: { a: number; b: number }[] = [];
  for (const [id, countA] of inA) {
    if (countA !== 1 || inB.get(id) !== 1) continue;
    pairs.push({ a: atA.get(id) as number, b: atB.get(id) as number });
  }
  pairs.sort((p, q) => p.a - q.a);
  return pairs;
}

/**
 * Longest strictly-increasing subsequence of `pairs` by their B index — the
 * anchors that can all hold at once without the alignment crossing itself.
 * Patience sorting, O(n log n), with parent links to rebuild the sequence.
 */
function longestIncreasing(pairs: { a: number; b: number }[]): { a: number; b: number }[] {
  if (pairs.length === 0) return [];
  const tails: number[] = []; // index into pairs of the smallest tail per length
  const parent = new Int32Array(pairs.length).fill(-1);

  for (let i = 0; i < pairs.length; i++) {
    const value = (pairs[i] as { b: number }).b;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pairs[tails[mid] as number] as { b: number }).b < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) parent[i] = tails[lo - 1] as number;
    tails[lo] = i;
  }

  const out: { a: number; b: number }[] = [];
  let cursor = tails[tails.length - 1] as number;
  while (cursor >= 0) {
    out.push(pairs[cursor] as { a: number; b: number });
    cursor = parent[cursor] as number;
  }
  return out.reverse();
}

type Walk = { degraded: boolean };

function walk(
  a: Int32Array,
  b: Int32Array,
  aLo: number,
  aHi: number,
  bLo: number,
  bHi: number,
  script: Script,
  depth: number,
  options: DiffOptions,
  state: Walk,
): void {
  options.check?.();

  // 1. Common prefix.
  let lo = 0;
  while (aLo + lo < aHi && bLo + lo < bHi && a[aLo + lo] === b[bLo + lo]) lo++;
  if (lo > 0) {
    script.push('equal', aLo, bLo, lo);
    aLo += lo;
    bLo += lo;
  }

  // 2. Common suffix, held back until the middle has been emitted.
  let hi = 0;
  while (aHi - hi > aLo && bHi - hi > bLo && a[aHi - hi - 1] === b[bHi - hi - 1]) hi++;
  aHi -= hi;
  bHi -= hi;

  middle: {
    if (aLo === aHi && bLo === bHi) break middle;
    if (aLo === aHi) {
      script.push('insert', aLo, bLo, bHi - bLo);
      break middle;
    }
    if (bLo === bHi) {
      script.push('delete', aLo, bLo, aHi - aLo);
      break middle;
    }

    const anchors = depth < MAX_DEPTH ? longestIncreasing(uniqueAnchors(a, b, aLo, aHi, bLo, bHi)) : [];

    if (anchors.length === 0) {
      const ops = myers(a, b, aLo, aHi, bLo, bHi, MYERS_CAP, options.check);
      if (ops) {
        for (const op of ops) script.push(op.kind, op.a, op.b, op.count);
      } else {
        // Too tangled to align inside the budget. Say so, and report the gap
        // as the wholesale replacement it effectively is, rather than guess.
        state.degraded = true;
        script.push('delete', aLo, bLo, aHi - aLo);
        script.push('insert', aHi, bLo, bHi - bLo);
      }
      break middle;
    }

    let aCursor = aLo;
    let bCursor = bLo;
    for (const anchor of anchors) {
      walk(a, b, aCursor, anchor.a, bCursor, anchor.b, script, depth + 1, options, state);
      script.push('equal', anchor.a, anchor.b, 1);
      aCursor = anchor.a + 1;
      bCursor = anchor.b + 1;
    }
    walk(a, b, aCursor, aHi, bCursor, bHi, script, depth + 1, options, state);
  }

  if (hi > 0) script.push('equal', aHi, bHi, hi);
}

// ---------------------------------------------------------------------------
// Blocks, rows, stats
// ---------------------------------------------------------------------------

/** Fold a delete immediately followed by an insert (or vice versa) into one
 *  `replace`, which is what lets the two sides sit on the same row. */
function toBlocks(ops: RawOp[]): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] as RawOp;
    if (op.kind === 'equal') {
      blocks.push({ kind: 'equal', aStart: op.a, aCount: op.count, bStart: op.b, bCount: op.count });
      continue;
    }
    const next = ops[i + 1];
    if (op.kind === 'delete' && next && next.kind === 'insert') {
      blocks.push({
        kind: 'replace',
        aStart: op.a,
        aCount: op.count,
        bStart: next.b,
        bCount: next.count,
      });
      i++;
      continue;
    }
    if (op.kind === 'insert' && next && next.kind === 'delete') {
      blocks.push({
        kind: 'replace',
        aStart: next.a,
        aCount: next.count,
        bStart: op.b,
        bCount: op.count,
      });
      i++;
      continue;
    }
    if (op.kind === 'delete') {
      blocks.push({ kind: 'delete', aStart: op.a, aCount: op.count, bStart: op.b, bCount: 0 });
    } else {
      blocks.push({ kind: 'insert', aStart: op.a, aCount: 0, bStart: op.b, bCount: op.count });
    }
  }
  return blocks;
}

/** One row per printed line, with the two sides of a `replace` paired up so a
 *  word-level highlight has something to compare against. */
export function toRows(blocks: readonly DiffBlock[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'equal':
        for (let i = 0; i < block.aCount; i++) {
          rows.push({ kind: 'equal', a: block.aStart + i, b: block.bStart + i });
        }
        break;
      case 'delete':
        for (let i = 0; i < block.aCount; i++) rows.push({ kind: 'delete', a: block.aStart + i, b: null });
        break;
      case 'insert':
        for (let i = 0; i < block.bCount; i++) rows.push({ kind: 'insert', a: null, b: block.bStart + i });
        break;
      case 'replace': {
        const paired = Math.min(block.aCount, block.bCount);
        for (let i = 0; i < paired; i++) {
          rows.push({ kind: 'replace', a: block.aStart + i, b: block.bStart + i });
        }
        for (let i = paired; i < block.aCount; i++) {
          rows.push({ kind: 'delete', a: block.aStart + i, b: null });
        }
        for (let i = paired; i < block.bCount; i++) {
          rows.push({ kind: 'insert', a: null, b: block.bStart + i });
        }
        break;
      }
    }
  }
  return rows;
}

/**
 * Replace every unchanged run longer than `context * 2` with a gap marker,
 * keeping `context` rows on each side of it. `context` of Infinity keeps the
 * whole file. This is what both the viewer and the report use — the fold is
 * the same in both, so what you saw is what you exported.
 */
export function collapseRows(rows: readonly DiffRow[], context: number): (DiffRow | GapRow)[] {
  if (!Number.isFinite(context)) return [...rows];

  const out: (DiffRow | GapRow)[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index] as DiffRow;
    if (row.kind !== 'equal') {
      out.push(row);
      index++;
      continue;
    }
    let end = index;
    while (end < rows.length && (rows[end] as DiffRow).kind === 'equal') end++;
    const run = end - index;

    // A run at the very start or end only needs trimming on its inner side.
    const leading = index === 0 ? 0 : context;
    const trailing = end === rows.length ? 0 : context;
    if (run <= leading + trailing) {
      for (let i = index; i < end; i++) out.push(rows[i] as DiffRow);
    } else {
      for (let i = index; i < index + leading; i++) out.push(rows[i] as DiffRow);
      const at = index + leading;
      const first = rows[at] as DiffRow;
      out.push({ kind: 'gap', count: run - leading - trailing, at, a: first.a ?? 0, b: first.b ?? 0 });
      for (let i = end - trailing; i < end; i++) out.push(rows[i] as DiffRow);
    }
    index = end;
  }
  return out;
}

function statsOf(blocks: readonly DiffBlock[], aLines: number, bLines: number): DiffStats {
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  let hunks = 0;
  let inHunk = false;

  for (const block of blocks) {
    if (block.kind === 'equal') {
      unchanged += block.aCount;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      hunks++;
      inHunk = true;
    }
    if (block.kind === 'delete') removed += block.aCount;
    else if (block.kind === 'insert') added += block.bCount;
    else {
      const paired = Math.min(block.aCount, block.bCount);
      changed += paired;
      removed += block.aCount - paired;
      added += block.bCount - paired;
    }
  }

  const widest = Math.max(aLines, bLines);
  return {
    added,
    removed,
    changed,
    unchanged,
    hunks,
    similarity: widest === 0 ? 1 : unchanged / widest,
  };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

export function diffLines(aText: string, bText: string, options: DiffOptions = {}): DiffResult {
  const a = splitLines(aText);
  const b = splitLines(bText);
  const { aIds, bIds } = intern(a.lines, b.lines, options);

  const script = new Script();
  const state: Walk = { degraded: false };
  walk(aIds, bIds, 0, aIds.length, 0, bIds.length, script, 0, options, state);

  const blocks = toBlocks(script.ops);
  const stats = statsOf(blocks, a.lines.length, b.lines.length);
  const identicalLines = stats.added === 0 && stats.removed === 0 && stats.changed === 0;

  return {
    a,
    b,
    blocks,
    stats,
    identicalLines,
    onlyEndingsDiffer:
      identicalLines &&
      (a.ending !== b.ending || a.hasBom !== b.hasBom || a.endsWithNewline !== b.endsWithNewline),
    degraded: state.degraded,
  };
}

// ---------------------------------------------------------------------------
// Word-level diff, for the two halves of a changed line
// ---------------------------------------------------------------------------

/**
 * Tokens a programmer would recognise: an identifier, a number, a run of
 * whitespace, or a single other character. Splitting on characters instead
 * would highlight the three letters `for` shares with `format` and call it a
 * change; splitting on spaces alone would repaint a whole call because one
 * argument moved.
 */
const TOKEN = /[A-Za-z_$][A-Za-z0-9_$]*|\d+(?:\.\d+)?|\s+|[^\s]/gy;

function tokenize(line: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  let match = TOKEN.exec(line);
  while (match !== null) {
    tokens.push(match[0]);
    match = TOKEN.exec(line);
  }
  // A sticky regex that fails mid-string would silently truncate the line, so
  // fall back to characters rather than lose text we are about to display.
  if (tokens.join('') !== line) return [...line];
  return tokens;
}

/** Adjacent segments of the same kind, merged, so the DOM gets one mark per run. */
function packSegments(parts: WordSegment[]): WordSegment[] {
  const out: WordSegment[] = [];
  for (const part of parts) {
    if (part.text === '') continue;
    const last = out[out.length - 1];
    if (last && last.changed === part.changed) last.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

/**
 * What changed WITHIN a pair of lines. Both sides come back as segment lists so
 * the removed and added halves can be highlighted in place — the thing that
 * turns "this line changed" into "this argument changed".
 */
export function diffWords(
  aLine: string,
  bLine: string,
  options: DiffOptions = {},
): { a: WordSegment[]; b: WordSegment[] } {
  if (aLine === bLine) {
    return { a: [{ text: aLine, changed: false }], b: [{ text: bLine, changed: false }] };
  }

  const aTokens = tokenize(aLine);
  const bTokens = tokenize(bLine);
  const { aIds, bIds } = intern(aTokens, bTokens, options);

  // A line is short, so a plain Myers is right here: there are no unique-line
  // anchors to find inside one line, and the cap can be generous.
  const ops =
    myers(aIds, bIds, 0, aIds.length, 0, bIds.length, aTokens.length + bTokens.length, undefined) ??
    [
      { kind: 'delete' as const, a: 0, b: 0, count: aTokens.length },
      { kind: 'insert' as const, a: 0, b: 0, count: bTokens.length },
    ];

  const aOut: WordSegment[] = [];
  const bOut: WordSegment[] = [];
  for (const op of ops) {
    if (op.kind === 'equal') {
      const text = aTokens.slice(op.a, op.a + op.count).join('');
      aOut.push({ text, changed: false });
      bOut.push({ text: bTokens.slice(op.b, op.b + op.count).join(''), changed: false });
    } else if (op.kind === 'delete') {
      aOut.push({ text: aTokens.slice(op.a, op.a + op.count).join(''), changed: true });
    } else {
      bOut.push({ text: bTokens.slice(op.b, op.b + op.count).join(''), changed: true });
    }
  }

  return { a: packSegments(aOut), b: packSegments(bOut) };
}

// ---------------------------------------------------------------------------
// Unified diff
// ---------------------------------------------------------------------------

export type UnifiedOptions = {
  aName: string;
  bName: string;
  context: number;
};

/**
 * A real unified diff — the format `patch` and `git apply` read, with `@@`
 * hunk headers counted in 1-based lines and the `\ No newline at end of file`
 * marker where a side does not end with one.
 */
export function toUnified(result: DiffResult, options: UnifiedOptions): string {
  const rows = toRows(result.blocks);
  const context = Math.max(0, Math.min(options.context, rows.length));
  const out: string[] = [`--- a/${options.aName}`, `+++ b/${options.bName}`];

  // Group rows into hunks: every changed row, plus `context` unchanged rows on
  // each side of it, with overlapping neighbourhoods merged.
  const keep = new Uint8Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i] as DiffRow).kind === 'equal') continue;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) {
      keep[j] = 1;
    }
  }

  const line = (index: number, side: 'a' | 'b'): string => {
    const text = side === 'a' ? result.a.lines[index] : result.b.lines[index];
    return text ?? '';
  };
  const noNewline = (side: 'a' | 'b', index: number): boolean => {
    const source = side === 'a' ? result.a : result.b;
    return !source.endsWithNewline && index === source.lines.length - 1;
  };

  // `aSeen`/`bSeen` count the lines of each side consumed BEFORE the current
  // row. Reading a hunk's start off its first row instead would be right only
  // when that side is present in the hunk at all: a hunk of pure insertions has
  // no A row to read, and `@@ -0,0` (the correct header only for an insertion at
  // the very top of the file) is what you get for an insertion anywhere. At
  // `context: 0` that is every pure insertion in the file.
  let index = 0;
  let aSeen = 0;
  let bSeen = 0;
  while (index < rows.length) {
    if (!keep[index]) {
      const skipped = rows[index] as DiffRow;
      if (skipped.a !== null) aSeen++;
      if (skipped.b !== null) bSeen++;
      index++;
      continue;
    }
    let end = index;
    while (end < rows.length && keep[end]) end++;

    const body: string[] = [];
    let aCount = 0;
    let bCount = 0;
    const aStart = aSeen;
    const bStart = bSeen;

    for (let i = index; i < end; i++) {
      const row = rows[i] as DiffRow;
      if (row.a !== null) aSeen++;
      if (row.b !== null) bSeen++;
      if (row.kind === 'equal') {
        body.push(` ${line(row.a, 'a')}`);
        if (noNewline('a', row.a)) body.push('\\ No newline at end of file');
        aCount++;
        bCount++;
      } else if (row.kind === 'delete') {
        body.push(`-${line(row.a, 'a')}`);
        if (noNewline('a', row.a)) body.push('\\ No newline at end of file');
        aCount++;
      } else if (row.kind === 'insert') {
        body.push(`+${line(row.b, 'b')}`);
        if (noNewline('b', row.b)) body.push('\\ No newline at end of file');
        bCount++;
      } else {
        body.push(`-${line(row.a, 'a')}`);
        if (noNewline('a', row.a)) body.push('\\ No newline at end of file');
        body.push(`+${line(row.b, 'b')}`);
        if (noNewline('b', row.b)) body.push('\\ No newline at end of file');
        aCount++;
        bCount++;
      }
    }

    // An empty side is numbered from the line BEFORE it, which is what every
    // other implementation emits and what patch expects for a pure insertion —
    // `aStart` already counts the lines before the hunk, so it IS that number.
    const aFrom = aCount === 0 ? aStart : aStart + 1;
    const bFrom = bCount === 0 ? bStart : bStart + 1;
    out.push(`@@ -${aFrom},${aCount} +${bFrom},${bCount} @@`);
    out.push(...body);
    index = end;
  }

  return `${out.join('\n')}\n`;
}
