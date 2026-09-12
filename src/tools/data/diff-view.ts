// Indexed, bounded presentation helpers for the Text Diff preview worker.

import { MAX_DETAIL_LINE, diffCharacters, diffWords, type DiffBlock, type DiffResult, type WordSegment } from './diff';
import { serializeChanges } from './text-diff.export';
import { rawLineRecords, type RawLine } from './text-diff.metadata';
import { comparisonIdentity, type ComparisonSnapshot } from './text-diff.model';
import {
  MAX_WINDOW_CHARS,
  MAX_WINDOW_ROWS,
  SLICE_TARGET,
  type DiffContext,
  type DiffDetail,
  type DiffSide,
  type GapExpansion,
  type HunkTarget,
  type SourceRange,
  type WindowCursor,
  type WindowFragment,
  type WindowGap,
  type WindowResponse,
  type WindowRow,
} from './text-diff.protocol';

export { rawLineRecords } from './text-diff.metadata';
type BlockMeta = Readonly<{ block: DiffBlock; row: number; rows: number }>;

export type ViewIndex = Readonly<{
  snapshot: ComparisonSnapshot;
  result: DiffResult;
  blocks: readonly BlockMeta[];
  logicalRows: number;
  aRawLines: readonly RawLine[];
  bRawLines: readonly RawLine[];
  hunks: readonly HunkTarget[];
  metadataRows: ReadonlySet<number>;
}>;

type IndexedRow = Readonly<{ kind: WindowRow['kind']; row: number; aLine: number | null; bLine: number | null }>;

function rowsIn(block: DiffBlock): number {
  return block.kind === 'equal' ? block.aCount : block.kind === 'delete' ? block.aCount : block.kind === 'insert' ? block.bCount : Math.max(block.aCount, block.bCount);
}

function blockAt(index: ViewIndex, row: number): { meta: BlockMeta; position: number } | null {
  if (row < 0 || row >= index.logicalRows) return null;
  let low = 0;
  let high = index.blocks.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const meta = index.blocks[middle];
    if (!meta) return null;
    if (row < meta.row) high = middle - 1;
    else if (row >= meta.row + meta.rows) low = middle + 1;
    else return { meta, position: middle };
  }
  return null;
}

function rowAt(index: ViewIndex, row: number): IndexedRow | null {
  const found = blockAt(index, row);
  if (!found) return null;
  const { meta } = found;
  const offset = row - meta.row;
  const block = meta.block;
      if (block.kind === 'equal') return { kind: 'equal', row, aLine: block.aStart + offset, bLine: block.bStart + offset };
      if (block.kind === 'delete') return { kind: 'delete', row, aLine: block.aStart + offset, bLine: null };
      if (block.kind === 'insert') return { kind: 'insert', row, aLine: null, bLine: block.bStart + offset };
      const paired = Math.min(block.aCount, block.bCount);
      if (offset < paired) return { kind: 'replace', row, aLine: block.aStart + offset, bLine: block.bStart + offset };
      if (offset < block.aCount) return { kind: 'delete', row, aLine: block.aStart + offset, bLine: null };
      return { kind: 'insert', row, aLine: null, bLine: block.bStart + offset };
}

function rowForLine(index: ViewIndex, side: DiffSide, line: number): number | null {
  for (const meta of index.blocks) {
    const block = meta.block;
    const start = side === 'a' ? block.aStart : block.bStart;
    const count = side === 'a' ? block.aCount : block.bCount;
    if (line < start || line >= start + count) continue;
    if (block.kind === 'insert' && side === 'a') continue;
    if (block.kind === 'delete' && side === 'b') continue;
    return meta.row + (line - start);
  }
  return null;
}

function lineForOffset(lines: readonly RawLine[], offset: number): number {
  let low = 0;
  let high = lines.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const line = lines[middle];
    if (!line) break;
    if (offset < line.start) high = middle - 1;
    else if (offset >= line.terminatorEnd && middle + 1 < lines.length) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(lines.length - 1, low));
}

function changeHunks(blocks: readonly BlockMeta[]): HunkTarget[] {
  const out: HunkTarget[] = [];
  let current: HunkTarget | null = null;
  for (const meta of blocks) {
    const block = meta.block;
    if (block.kind === 'equal') {
      current = null;
      continue;
    }
    const aStart = block.aCount ? block.aStart : null;
    const bStart = block.bCount ? block.bStart : null;
    const candidate: HunkTarget = {
      id: `change-${out.length}`,
      kind: 'change',
      row: meta.row,
      endRow: meta.row + meta.rows,
      aStart,
      aEnd: aStart === null ? null : block.aStart + block.aCount,
      bStart,
      bEnd: bStart === null ? null : block.bStart + block.bCount,
    };
    if (current && current.endRow === candidate.row) {
      const merged: HunkTarget = { ...current, endRow: candidate.endRow, aEnd: candidate.aEnd ?? current.aEnd, bEnd: candidate.bEnd ?? current.bEnd };
      out[out.length - 1] = merged;
      current = merged;
    } else {
      out.push(candidate);
      current = candidate;
    }
  }
  return out;
}

function metadataHunks(index: Omit<ViewIndex, 'hunks' | 'metadataRows'>): HunkTarget[] {
  const out: HunkTarget[] = [];
  const [aSource, bSource] = index.snapshot.sources;
  if (aSource.text.charCodeAt(0) !== bSource.text.charCodeAt(0) && (aSource.text.charCodeAt(0) === 0xfeff || bSource.text.charCodeAt(0) === 0xfeff)) {
    out.push({ id: 'metadata-bom', kind: 'metadata', row: 0, endRow: 0, aStart: 0, aEnd: 0, bStart: 0, bEnd: 0, message: 'Byte-order mark changed.' });
  }
  let active: HunkTarget | null = null;
  // Compare physical terminators only after the diff's actual alignment. Raw
  // line ordinals are not comparable after an insertion/deletion.
  for (let row = 0; row < index.logicalRows; row++) {
    const aligned = rowAt(index as ViewIndex, row);
    if (!aligned || aligned.aLine === null || aligned.bLine === null) continue;
    const a = index.aRawLines[aligned.aLine];
    const b = index.bRawLines[aligned.bLine];
    if (a?.terminator === b?.terminator) {
      active = null;
      continue;
    }
    // A deliberately compact metadata navigation target. Alternating endings
    // across 200k lines must not clone 100k verbose hunk objects in `ready`.
    const hunk: HunkTarget = { id: 'metadata-endings', kind: 'metadata', row, endRow: row + 1, aStart: aligned.aLine, aEnd: aligned.aLine + 1, bStart: aligned.bLine, bEnd: aligned.bLine + 1, message: 'One or more line endings changed.' };
    if (active) {
      const merged: HunkTarget = { ...active, endRow: hunk.endRow, aEnd: hunk.aEnd ?? active.aEnd, bEnd: hunk.bEnd ?? active.bEnd };
      out[out.length - 1] = merged;
      active = merged;
    } else { out.push(hunk); active = hunk; }
  }
  return out;
}

export function buildViewIndex(snapshot: ComparisonSnapshot, result: DiffResult): ViewIndex {
  let row = 0;
  const blocks = result.blocks.map((block) => {
    const meta = { block, row, rows: rowsIn(block) } as const;
    row += meta.rows;
    return meta;
  });
  const partial = { snapshot, result, blocks, logicalRows: row, aRawLines: rawLineRecords(snapshot.sources[0].text), bRawLines: rawLineRecords(snapshot.sources[1].text) };
  const hunks = [...changeHunks(blocks), ...metadataHunks(partial)].sort((a, b) => a.row - b.row || a.kind.localeCompare(b.kind));
  return Object.freeze({ ...partial, hunks: Object.freeze(hunks), metadataRows: new Set(hunks.filter((hunk) => hunk.kind === 'metadata').flatMap((hunk) => Array.from({ length: hunk.endRow - hunk.row }, (_, offset) => hunk.row + offset))) });
}

function segmenter(): Intl.Segmenter | undefined {
  const Segmenter = (Intl as typeof Intl & { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  return Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : undefined;
}

function safeEnd(text: string, start: number, wanted: number, hardBudget: number, graphemes: Intl.Segmenter | undefined): { end: number; oversized: boolean } {
  if (start >= text.length) return { end: start, oversized: false };
  if (wanted <= 0) return { end: start, oversized: false };
  const limit = Math.min(text.length, start + wanted);
  if (!graphemes) {
    let end = limit;
    if (end < text.length && /[\uDC00-\uDFFF]/u.test(text.charAt(end))) {
      if (end > start + 1) end--;
      else if (hardBudget >= 2) end++;
      else end = start;
    }
    return { end, oversized: false };
  }
  let end = start;
  for (const part of graphemes.segment(text.slice(start))) {
    const next = end + part.segment.length;
    if (next > limit) {
      if (end !== start) return { end, oversized: false };
      if (next - start > MAX_WINDOW_CHARS) return { end: next, oversized: true };
      return next - start <= hardBudget ? { end: next, oversized: false } : { end: start, oversized: false };
    }
    end = next;
    if (end === limit) break;
  }
  return { end, oversized: false };
}

function sliceSegments(segments: readonly WordSegment[], start: number, end: number): WordSegment[] {
  const out: WordSegment[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const next = cursor + segment.text.length;
    const from = Math.max(start, cursor);
    const to = Math.min(end, next);
    if (from < to) out.push({ text: segment.text.slice(from - cursor, to - cursor), changed: segment.changed });
    cursor = next;
  }
  return out;
}

function detailSegments(row: IndexedRow, index: ViewIndex, detail: DiffDetail): { a: readonly WordSegment[]; b: readonly WordSegment[] } {
  const aText = row.aLine === null ? '' : (index.result.a.lines[row.aLine] ?? '');
  const bText = row.bLine === null ? '' : (index.result.b.lines[row.bLine] ?? '');
  if (row.kind !== 'replace') return { a: aText === '' ? [] : [{ text: aText, changed: row.kind === 'delete' }], b: bText === '' ? [] : [{ text: bText, changed: row.kind === 'insert' }] };
  if (detail === 'line') return { a: [{ text: aText, changed: false }], b: [{ text: bText, changed: false }] };
  if (detail === 'word') return diffWords(aText, bText, index.snapshot.rules);
  const characters = diffCharacters(aText, bText, index.snapshot.rules);
  return { a: characters.a, b: characters.b };
}

function fragment(side: DiffSide, text: string, raw: RawLine | undefined, offset: number, budget: number, segments: readonly WordSegment[], graphemes: Intl.Segmenter | undefined): WindowFragment | null {
  if (!raw) return null;
  const { end, oversizedGrapheme } = (() => {
    const cut = safeEnd(text, offset, Math.min(SLICE_TARGET, budget), budget, graphemes);
    return { end: cut.end, oversizedGrapheme: cut.oversized };
  })();
  const sourceRange: SourceRange = { side, start: raw.start + offset, end: raw.start + end };
  const textPart = oversizedGrapheme ? '' : text.slice(offset, end);
  return { start: offset, end, text: textPart, segments: oversizedGrapheme ? [] : sliceSegments(segments, offset, end), sourceRange, complete: end === text.length, oversizedGrapheme };
}

function equalRun(index: ViewIndex, row: number): { start: number; end: number } | null {
  const found = blockAt(index, row);
  if (!found || found.meta.block.kind !== 'equal') return null;
  let start = found.meta.row;
  let end = start + found.meta.rows;
  for (let position = found.position - 1; position >= 0 && index.blocks[position]?.block.kind === 'equal'; position--) start = index.blocks[position]?.row ?? start;
  for (let position = found.position + 1; position < index.blocks.length && index.blocks[position]?.block.kind === 'equal'; position++) end = (index.blocks[position]?.row ?? end) + (index.blocks[position]?.rows ?? 0);
  return { start, end };
}

function gapAt(index: ViewIndex, row: number, context: DiffContext, expansions: readonly GapExpansion[], revealRow: number | undefined): WindowGap | null {
  if (index.hunks.length === 0) return null;
  if (context === 'whole' || row === revealRow || index.metadataRows.has(row)) return null;
  const run = equalRun(index, row);
  if (!run) return null;
  let segmentStart = run.start;
  let segmentEnd = run.end;
  // Physical metadata and a requested reveal split an otherwise equal run
  // into separately expandable segments. A click on a later gap must open
  // that gap rather than add lines to the beginning of the original run.
  for (const target of index.hunks) {
    if (target.kind !== 'metadata' || target.row < run.start || target.row >= run.end) continue;
    const protectedEnd = Math.max(target.row + 1, target.endRow);
    if (target.row <= row && row < protectedEnd) return null;
    if (protectedEnd <= row) segmentStart = Math.max(segmentStart, protectedEnd);
    if (target.row > row) { segmentEnd = Math.min(segmentEnd, target.row); break; }
  }
  if (revealRow !== undefined && revealRow >= run.start && revealRow < run.end) {
    if (revealRow < row) segmentStart = Math.max(segmentStart, revealRow + 1);
    if (revealRow > row) segmentEnd = Math.min(segmentEnd, revealRow);
  }
  const before = segmentStart === 0 ? 0 : context;
  const after = segmentEnd === index.logicalRows ? 0 : context;
  const expansion = expansions.find((item) => item.startRow === segmentStart)?.lines ?? 0;
  const hiddenStart = segmentStart + before + Math.min(expansion, Math.max(0, segmentEnd - segmentStart - before - after));
  const hiddenEnd = Math.max(segmentStart, segmentEnd - after);
  if (row < hiddenStart || row >= hiddenEnd || row === revealRow) return null;
  if (row !== hiddenStart) return { kind: 'gap', startRow: row, endRow: hiddenEnd, hiddenRows: hiddenEnd - row, expandable: Math.min(50, hiddenEnd - row), expansionStart: segmentStart, expandedLines: expansion };
  if (hiddenStart >= hiddenEnd) return null;
  return { kind: 'gap', startRow: hiddenStart, endRow: hiddenEnd, hiddenRows: hiddenEnd - hiddenStart, expandable: Math.min(50, hiddenEnd - hiddenStart), expansionStart: segmentStart, expandedLines: expansion };
}

export function readRowWindow(index: ViewIndex, input: { cursor: WindowCursor; detail: DiffDetail; context: DiffContext; expansions: readonly GapExpansion[]; revealRow?: number }): Omit<WindowResponse, 'kind' | 'revision' | 'requestId'> {
  const notices: string[] = [];
  const graphemes = segmenter();
  if (!graphemes) notices.push('Grapheme segmentation is unavailable; character detail is disabled and previews use code-point-safe slices.');
  const start = input.cursor;
  const rows: (WindowRow | WindowGap)[] = [];
  let cursor = { ...start };
  let displayedRows = 0;
  let displayedCharacters = 0;
  while (cursor.row < index.logicalRows && displayedRows < MAX_WINDOW_ROWS && displayedCharacters < MAX_WINDOW_CHARS) {
    const gap = gapAt(index, cursor.row, input.context, input.expansions, input.revealRow);
    if (gap) {
      if (cursor.row !== gap.startRow) cursor = { row: gap.startRow, aOffset: 0, bOffset: 0 };
      rows.push(gap);
      cursor = { row: gap.endRow, aOffset: 0, bOffset: 0 };
      continue;
    }
    const logical = rowAt(index, cursor.row);
    if (!logical) break;
    const aText = logical.aLine === null ? '' : (index.result.a.lines[logical.aLine] ?? '');
    const bText = logical.bLine === null ? '' : (index.result.b.lines[logical.bLine] ?? '');
    if (input.detail !== 'line' && logical.kind === 'replace' && (aText.length > MAX_DETAIL_LINE || bText.length > MAX_DETAIL_LINE) && !notices.includes('Long changed lines use line detail.')) {
      notices.push('Long changed lines use line detail.');
    }
    const details = detailSegments(logical, index, graphemes ? input.detail : 'line');
    const remaining = MAX_WINDOW_CHARS - displayedCharacters;
    const aNeeded = logical.aLine !== null && cursor.aOffset < aText.length;
    const bNeeded = logical.bLine !== null && cursor.bOffset < bText.length;
    const a = logical.aLine === null ? null : fragment('a', aText, index.aRawLines[logical.aLine], cursor.aOffset, remaining, details.a, graphemes);
    const aChars = a?.text.length ?? 0;
    const b = logical.bLine === null ? null : fragment('b', bText, index.bRawLines[logical.bLine], cursor.bOffset, remaining - aChars, details.b, graphemes);
    const bChars = b?.text.length ?? 0;
    if ((aNeeded && (!a || a.end === cursor.aOffset)) && (bNeeded && (!b || b.end === cursor.bOffset))) break;
    rows.push({ kind: logical.kind, row: logical.row, aLine: logical.aLine, bLine: logical.bLine, a, b });
    displayedRows++;
    displayedCharacters += aChars + bChars;
    const aDone = !a || a.complete;
    const bDone = !b || b.complete;
    if (aDone && bDone) cursor = { row: cursor.row + 1, aOffset: 0, bOffset: 0 };
    else cursor = { row: cursor.row, aOffset: a?.end ?? 0, bOffset: b?.end ?? 0 };
    if (!aDone || !bDone) break;
  }
  return { start, next: cursor.row >= index.logicalRows ? null : cursor, endOfComparison: cursor.row >= index.logicalRows, rows, displayedRows, displayedCharacters, notices };
}

function literalExpression(query: string, matchCase: boolean): RegExp | null {
  if (query === '') return null;
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'gu' : 'giu');
}

function graphemeFloor(text: string, offset: number): number {
  const bounded = Math.max(0, Math.min(offset, text.length));
  const graphemes = segmenter();
  if (!graphemes) return bounded > 0 && /[\uDC00-\uDFFF]/u.test(text.charAt(bounded)) ? bounded - 1 : bounded;
  let start = 0;
  for (const part of graphemes.segment(text)) {
    const end = start + part.segment.length;
    if (bounded <= end) return bounded === end ? end : start;
    start = end;
  }
  return text.length;
}

export function findText(index: ViewIndex, query: string, matchCase: boolean, ordinal: number): { matchCount: number; ordinal: number | null; range: SourceRange | null; row: number | null; cursor: WindowCursor | null } {
  const expression = literalExpression(query, matchCase);
  if (!expression) return { matchCount: 0, ordinal: null, range: null, row: null, cursor: null };
  let count = 0;
  for (const text of [index.snapshot.sources[0].text, index.snapshot.sources[1].text]) {
    expression.lastIndex = 0;
    for (let found = expression.exec(text); found; found = expression.exec(text)) count++;
  }
  if (!count) return { matchCount: 0, ordinal: null, range: null, row: null, cursor: null };
  const chosenOrdinal = Math.max(0, Math.min(ordinal, count - 1));
  let range: SourceRange | null = null;
  let seen = 0;
  for (const [side, text] of [['a', index.snapshot.sources[0].text], ['b', index.snapshot.sources[1].text]] as const) {
    expression.lastIndex = 0;
    for (let found = expression.exec(text); found; found = expression.exec(text)) {
      if (seen++ === chosenOrdinal) { range = { side, start: found.index, end: found.index + found[0].length }; break; }
    }
    if (range) break;
  }
  if (!range) return { matchCount: count, ordinal: chosenOrdinal, range: null, row: null, cursor: null };
  const rawLines = range.side === 'a' ? index.aRawLines : index.bRawLines;
  const sourceLine = lineForOffset(rawLines, range.start);
  const row = rowForLine(index, range.side, sourceLine);
  if (row === null) return { matchCount: count, ordinal: chosenOrdinal, range, row: null, cursor: null };
  const raw = rawLines[sourceLine];
  const display = range.side === 'a' ? (index.result.a.lines[sourceLine] ?? '') : (index.result.b.lines[sourceLine] ?? '');
  const offset = graphemeFloor(display, Math.max(0, Math.min(display.length, range.start - (raw?.start ?? range.start))));
  return { matchCount: count, ordinal: chosenOrdinal, range, row, cursor: { row, aOffset: range.side === 'a' ? offset : 0, bOffset: range.side === 'b' ? offset : 0 } };
}

export function formatChanges(index: ViewIndex, context: DiffContext): string {
  return serializeChanges({ result: index.result, names: { a: index.snapshot.sources[0].name, b: index.snapshot.sources[1].name }, context: context === 'whole' ? Number.POSITIVE_INFINITY : context, scope: context === 'whole' ? 'whole' : 'changes', rules: index.snapshot.rules, identity: comparisonIdentity(index.snapshot), rawSources: { a: index.snapshot.sources[0].text, b: index.snapshot.sources[1].text } });
}
