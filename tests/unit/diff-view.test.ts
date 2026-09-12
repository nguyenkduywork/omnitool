import { describe, expect, it } from 'vitest';

import { diffLines, toRows } from '../../src/tools/data/diff';
import { buildViewIndex, findText, formatChanges, readRowWindow } from '../../src/tools/data/diff-view';
import { MAX_COMPARISON_BYTES, createComparisonSnapshot } from '../../src/tools/data/text-diff.model';

function index(a: string, b: string) {
  const snapshot = createComparisonSnapshot({
    revision: 1,
    sources: [{ text: a, name: 'a.txt', origin: 'text' }, { text: b, name: 'b.txt', origin: 'text' }],
    rules: { ignoreWhitespace: false, ignoreCase: false },
  });
  return buildViewIndex(snapshot, diffLines(a, b));
}

describe('indexed Text Diff view', () => {
  it('includes aligned physical ending changes in worker copy with changed text', () => {
    const copy = formatChanges(index('alpha\r\nold\n', 'alpha\nnew\n'), 3);
    expect(copy).toContain('Original source: MIXED line endings');
    expect(copy).toContain('Revised source: LF line endings');
    expect(copy).toContain('Aligned line endings differ.');
    expect(copy).toContain('- old\n+ new');
    expect(copy).not.toContain('Metadata-only difference');
  });

  it('agrees with full small-input expansion and reaches a hunk after row 4,000', () => {
    const lines = Array.from({ length: 4_600 }, (_, index) => `line ${index}`);
    const a = `${lines.join('\n')}\n`;
    const b = `${lines.map((line, row) => row === 4_321 ? 'changed' : line).join('\n')}\n`;
    const view = index(a, b);

    expect(view.logicalRows).toBe(toRows(diffLines(a, b).blocks).length);
    expect(view.hunks.find((hunk) => hunk.kind === 'change')?.row).toBe(4_321);

    const page = readRowWindow(view, { cursor: { row: 4_321, aOffset: 0, bOffset: 0 }, detail: 'word', context: 'whole', expansions: [] });
    expect(page.rows[0]).toMatchObject({ row: 4_321, kind: 'replace' });
  });

  it('projects every row of a seeded comparison exactly like full toRows expansion', () => {
    const a = Array.from({ length: 310 }, (_, row) => `line-${row}`).join('\n');
    const b = a.replace('line-17', 'changed-17').replace('line-205', 'changed-205');
    const view = index(a, b);
    const actual: unknown[] = [];
    let cursor = { row: 0, aOffset: 0, bOffset: 0 };
    while (true) {
      const page = readRowWindow(view, { cursor, detail: 'line', context: 'whole', expansions: [] });
      actual.push(...page.rows.filter((row) => row.kind !== 'gap').map((row) => ({ kind: row.kind, a: row.aLine, b: row.bLine, aText: row.a?.text ?? null, bText: row.b?.text ?? null })));
      if (!page.next) break;
      cursor = page.next;
    }
    const expected = toRows(view.result.blocks).map((row) => ({ kind: row.kind, a: row.a, b: row.b, aText: row.a === null ? null : view.result.a.lines[row.a], bText: row.b === null ? null : view.result.b.lines[row.b] }));
    expect(actual).toEqual(expected);
  });

  it('uses original string offsets for case-insensitive literal Find', () => {
    const view = index('AİB', 'unchanged');
    const found = findText(view, 'b', false, 0);
    expect(found.range).toEqual({ side: 'a', start: 2, end: 3 });
    expect(found.cursor).toEqual({ row: 0, aOffset: 2, bOffset: 0 });
  });

  it('preserves every grapheme while paging a long paired row within character caps', () => {
    const long = `${'e\u0301'.repeat(2_400)}${'👩‍👩‍👧‍👦'.repeat(300)}`;
    const view = index(long, long);
    let cursor = { row: 0, aOffset: 0, bOffset: 0 };
    let a = '';
    let b = '';
    for (let pages = 0; pages < 20; pages++) {
      const page = readRowWindow(view, { cursor, detail: 'character', context: 'whole', expansions: [] });
      expect(page.displayedCharacters).toBeLessThanOrEqual(100_000);
      for (const row of page.rows) if (row.kind !== 'gap') {
        a += row.a?.text ?? '';
        b += row.b?.text ?? '';
      }
      if (!page.next) break;
      expect(page.next).not.toEqual(cursor);
      cursor = page.next;
    }
    expect(a).toBe(long);
    expect(b).toBe(long);
  });

  it('does not report metadata merely because an insertion shifts raw line ordinals', () => {
    const view = index('a\r\nb\nc\n', 'new\na\r\nb\nc\n');
    expect(view.hunks.filter((hunk) => hunk.kind === 'metadata')).toHaveLength(0);
  });

  it('keeps BOM-only and physical-ending changes navigable without materializing rows', () => {
    const bom = index('\ufeff', '');
    expect(bom.logicalRows).toBe(0);
    expect(bom.hunks.some((hunk) => hunk.kind === 'metadata')).toBe(true);

    const endings = index('a\r\nb\r\n', 'a\nb\n');
    expect(endings.hunks.filter((hunk) => hunk.kind === 'metadata')).toHaveLength(1);

    const lines = Array.from({ length: 5_100 }, (_, row) => `line-${row}`);
    const a = `${lines.join('\n')}\n`;
    const b = a.replace('line-1\n', 'line-1\r\n').replace('line-5000\n', 'line-5000\r\n');
    expect(index(a, b).hunks.filter((hunk) => hunk.kind === 'metadata')).toHaveLength(2);
  });

  it('shows unchanged content when there are no hunks to anchor context', () => {
    const view = index('same\nsecond\n', 'same\nsecond\n');
    const page = readRowWindow(view, { cursor: { row: 0, aOffset: 0, bOffset: 0 }, detail: 'line', context: 3, expansions: [] });
    expect(page.rows.map((row) => row.kind)).toEqual(['equal', 'equal']);
  });

  it('defers paired large graphemes, and uses a range-only placeholder beyond the hard page cap', () => {
    const large = `a${'\u0301'.repeat(69_999)}`;
    const paired = index(large, large);
    const first = readRowWindow(paired, { cursor: { row: 0, aOffset: 0, bOffset: 0 }, detail: 'character', context: 'whole', expansions: [] });
    const firstRow = first.rows.find((row) => row.kind !== 'gap');
    expect(first.rows).toHaveLength(1);
    expect(first.displayedCharacters).toBeLessThanOrEqual(100_000);
    expect(firstRow?.a?.text.length).toBe(large.length);
    expect(first.next).toEqual({ row: 0, aOffset: large.length, bOffset: 0 });
    const second = readRowWindow(paired, { cursor: first.next!, detail: 'character', context: 'whole', expansions: [] });
    const secondRow = second.rows.find((row) => row.kind !== 'gap');
    expect(secondRow?.b?.text).toBe(large);

    const oversizedText = `a${'\u0301'.repeat(100_000)}`;
    const oversized = readRowWindow(index(oversizedText, ''), { cursor: { row: 0, aOffset: 0, bOffset: 0 }, detail: 'character', context: 'whole', expansions: [] });
    const row = oversized.rows.find((item) => item.kind !== 'gap');
    if (!row) throw new Error('expected an oversized row');
    expect(row.a?.oversizedGrapheme).toBe(true);
    expect(oversizedText.slice(row.a!.sourceRange.start, row.a!.sourceRange.end)).toBe(oversizedText);
  });

  it('floors a long-line Find cursor to the containing grapheme and enforces model caps', () => {
    const text = `x${'e\u0301'.repeat(2_500)}z`;
    const found = findText(index(text, ''), '\u0301', true, 0);
    expect(found.range).toMatchObject({ start: 2, end: 3 });
    expect(found.cursor).toMatchObject({ aOffset: 1 });

    expect(() => createComparisonSnapshot({ revision: 1, sources: [{ text: '\n'.repeat(100_001), name: 'a', origin: 'text' }, { text: '\n'.repeat(100_001), name: 'b', origin: 'text' }], rules: { ignoreWhitespace: false, ignoreCase: false } })).toThrow(/display lines/);
    expect(() => createComparisonSnapshot({ revision: 1, sources: [{ text: 'x'.repeat(MAX_COMPARISON_BYTES + 1), name: 'a', origin: 'text' }, { text: '', name: 'b', origin: 'empty' }], rules: { ignoreWhitespace: false, ignoreCase: false } })).toThrow(/UTF-8 bytes/);
  });

  it('expands only the requested leading portion of a folded equal run', () => {
    const lines = Array.from({ length: 120 }, (_, index) => `line ${index}`);
    const view = index(`${lines.join('\n')}\n`, `${[...lines.slice(0, 119), 'changed'].join('\n')}\n`);
    const page = readRowWindow(view, { cursor: { row: 0, aOffset: 0, bOffset: 0 }, detail: 'line', context: 3, expansions: [{ startRow: 0, lines: 50 }] });
    // 50 explicitly expanded rows, then the three trailing context rows and
    // the changed row after the folded run.
    expect(page.rows.filter((row) => row.kind !== 'gap')).toHaveLength(54);
    expect(page.rows.find((row) => row.kind === 'gap')).toMatchObject({ startRow: 50, expandable: 50 });
  });

  it('returns a stable expansion origin and cumulative count through two clicks', () => {
    const lines = Array.from({ length: 180 }, (_, row) => `line-${row}`);
    const view = index(lines.join('\n'), [...lines.slice(0, -1), 'changed'].join('\n'));
    const input = { cursor: { row: 0, aOffset: 0, bOffset: 0 }, detail: 'line' as const, context: 3 as const };
    const first = readRowWindow(view, { ...input, expansions: [] });
    const gap1 = first.rows.find((row) => row.kind === 'gap');
    if (!gap1 || gap1.kind !== 'gap') throw new Error('first gap missing');
    expect(gap1).toMatchObject({ expansionStart: 0, expandedLines: 0 });
    const second = readRowWindow(view, { ...input, expansions: [{ startRow: gap1.expansionStart, lines: gap1.expandedLines + gap1.expandable }] });
    const gap2 = second.rows.find((row) => row.kind === 'gap');
    if (!gap2 || gap2.kind !== 'gap') throw new Error('second gap missing');
    expect(gap2).toMatchObject({ startRow: 50, expansionStart: 0, expandedLines: 50 });
    const third = readRowWindow(view, { ...input, expansions: [{ startRow: gap2.expansionStart, lines: gap2.expandedLines + gap2.expandable }] });
    expect(third.rows.find((row) => row.kind === 'gap')).toMatchObject({ startRow: 100, expansionStart: 0, expandedLines: 100 });
    expect(third.rows.filter((row) => row.kind !== 'gap').slice(50, 100).map((row) => row.a?.text)).toEqual(lines.slice(50, 100));
  });

  it('keeps distant physical-ending metadata visible in default-context paging', () => {
    const lines = Array.from({ length: 5_101 }, (_, row) => `line-${row}`);
    const a = `${lines.join('\n')}\n`;
    const b = a.replace('line-1\n', 'line-1\r\n').replace('line-5000\n', 'line-5000\r\n');
    const view = index(a, b);
    const targets = view.hunks.filter((hunk) => hunk.kind === 'metadata');
    expect(targets.map((hunk) => [hunk.row, hunk.endRow])).toEqual([[1, 2], [5_000, 5_001]]);
    const seen: number[] = [];
    let cursor = { row: 0, aOffset: 0, bOffset: 0 };
    const initial = readRowWindow(view, { cursor, detail: 'line', context: 3, expansions: [] });
    const middleGap = initial.rows.find((row) => row.kind === 'gap' && row.startRow > 1);
    if (!middleGap || middleGap.kind !== 'gap') throw new Error('middle gap missing');
    expect(middleGap).toMatchObject({ expansionStart: 2, expandedLines: 0 });
    const expanded = readRowWindow(view, { cursor, detail: 'line', context: 3,
      expansions: [{ startRow: middleGap.expansionStart, lines: middleGap.expandedLines + middleGap.expandable }] });
    expect(expanded.rows.filter((row) => row.kind !== 'gap').map((row) => row.row)).toContain(54);
    expect(expanded.rows.find((row) => row.kind === 'gap' && row.startRow > middleGap.startRow)).toMatchObject({ expansionStart: 2, expandedLines: 50 });
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const page = readRowWindow(view, { cursor, detail: 'line', context: 3, expansions: [] });
      seen.push(...page.rows.filter((row) => row.kind !== 'gap').map((row) => row.row));
      if (!page.next) break;
      expect(page.next).not.toEqual(cursor);
      cursor = page.next;
    }
    expect(seen).toContain(1);
    expect(seen).toContain(5_000);
  });

  it('does not split a surrogate pair without Intl.Segmenter when only one code unit remains', () => {
    const original = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    Object.defineProperty(Intl, 'Segmenter', { configurable: true, value: undefined });
    try {
      const equal = Array.from({ length: 12 }, () => 'x'.repeat(4_000));
      const a = [...equal, 'a'.repeat(1_999), '😀'].join('\n');
      const b = [...equal, 'b'.repeat(2_000), '😀'].join('\n');
      const view = index(a, b);
      const first = readRowWindow(view, { cursor: { row: 0, aOffset: 0, bOffset: 0 }, detail: 'line', context: 'whole', expansions: [] });
      expect(first.displayedCharacters).toBeLessThanOrEqual(100_000);
      expect(first.rows.flatMap((row) => row.kind === 'gap' ? [] : [row.a?.text ?? '', row.b?.text ?? '']).join('')).not.toContain('\ud83d');
      expect(first.next).toMatchObject({ row: 13, aOffset: 0, bOffset: 0 });
      const second = readRowWindow(view, { cursor: first.next!, detail: 'line', context: 'whole', expansions: [] });
      const firstRow = second.rows[0];
      expect(firstRow?.kind === 'gap' ? null : firstRow?.a?.text).toBe('😀');
    } finally {
      if (original) Object.defineProperty(Intl, 'Segmenter', original);
    }
  });
});
