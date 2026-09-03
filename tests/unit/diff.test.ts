// tests/unit/diff.test.ts — the diff engine (src/tools/data/diff.ts).
//
// The engine is patience-anchored with Myers inside each gap, and neither half
// is something you can eyeball for correctness. So the load-bearing tests here
// are PROPERTY tests over randomly generated file pairs:
//
//   1. Every script it produces must REPLAY: applying the deletes and inserts
//      to side A has to reconstruct side B exactly. A script that does not
//      replay is wrong no matter how pretty it looks.
//   2. Every `equal` block must actually be equal, under the comparison rules
//      in force. This is the one an off-by-one in the Myers backtrack breaks.
//   3. The unified output must round-trip: parsing back the '-'/' ' lines has
//      to give side A, and the '+'/' ' lines side B.
//
// The seeded generator makes a failure reproducible — the seed is printed with
// the assertion, and re-running it replays the identical case.

import { describe, expect, it } from 'vitest';

import { OpError } from '../../src/types';
import type { OpContext, OpInput } from '../../src/types';
import { DATA_TOOLS } from '../../src/core/registry.data';
import { DATA_LOADERS } from '../../src/core/workers/loaders.data';
import textDiff from '../../src/tools/data/text-diff.op';
import {
  collapseRows,
  diffLines,
  diffWords,
  splitLines,
  toRows,
  toUnified,
  type DiffBlock,
  type DiffOptions,
  type DiffRow,
  type GapRow,
} from '../../src/tools/data/diff';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replay a script: apply it to A and see whether B comes out. */
function replay(blocks: readonly DiffBlock[], a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'equal':
        for (let i = 0; i < block.aCount; i++) out.push(a[block.aStart + i] as string);
        break;
      case 'delete':
        break;
      case 'insert':
      case 'replace':
        for (let i = 0; i < block.bCount; i++) out.push(b[block.bStart + i] as string);
        break;
    }
  }
  return out;
}

/** Every block must consume A and B contiguously, in order, leaving no gaps. */
function assertContiguous(blocks: readonly DiffBlock[], aLen: number, bLen: number): void {
  let a = 0;
  let b = 0;
  for (const block of blocks) {
    expect(block.aStart).toBe(a);
    expect(block.bStart).toBe(b);
    a += block.aCount;
    b += block.bCount;
  }
  expect(a).toBe(aLen);
  expect(b).toBe(bLen);
}

/** A tiny deterministic PRNG, so a failing case can be replayed from its seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomFile(random: () => number, lines: number, alphabet: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(`line ${Math.floor(random() * alphabet)}`);
  }
  return out;
}

/** A realistic edit: a few insertions, deletions and rewrites, not noise. */
function mutate(random: () => number, lines: string[], edits: number): string[] {
  const out = [...lines];
  for (let i = 0; i < edits; i++) {
    if (out.length === 0 || random() < 0.34) {
      out.splice(Math.floor(random() * (out.length + 1)), 0, `added ${Math.floor(random() * 1000)}`);
    } else if (random() < 0.5) {
      out.splice(Math.floor(random() * out.length), 1);
    } else {
      out[Math.floor(random() * out.length)] = `changed ${Math.floor(random() * 1000)}`;
    }
  }
  return out;
}

const rowKinds = (rows: readonly (DiffRow | GapRow)[]): string[] => rows.map((row) => row.kind);

// ---------------------------------------------------------------------------
// splitLines
// ---------------------------------------------------------------------------

describe('splitLines', () => {
  it('treats a trailing newline as a terminator, not an empty last line', () => {
    expect(splitLines('a\nb\n')).toMatchObject({ lines: ['a', 'b'], endsWithNewline: true });
    expect(splitLines('a\nb')).toMatchObject({ lines: ['a', 'b'], endsWithNewline: false });
  });

  it('reports an empty file as no lines at all', () => {
    expect(splitLines('').lines).toEqual([]);
    expect(splitLines('\n').lines).toEqual(['']);
  });

  it('names the line ending, and calls a file with both mixed', () => {
    expect(splitLines('a\nb\n').ending).toBe('lf');
    expect(splitLines('a\r\nb\r\n').ending).toBe('crlf');
    expect(splitLines('a\rb\r').ending).toBe('cr');
    expect(splitLines('a\r\nb\n').ending).toBe('mixed');
    expect(splitLines('one line').ending).toBe('none');
  });

  it('spots a byte-order mark and keeps it out of the first line', () => {
    const split = splitLines('﻿a\nb');
    expect(split.hasBom).toBe(true);
    expect(split.lines[0]).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// diffLines — the shape of the answer
// ---------------------------------------------------------------------------

describe('diffLines', () => {
  it('reports identical files as identical', () => {
    const result = diffLines('a\nb\nc\n', 'a\nb\nc\n');
    expect(result.identicalLines).toBe(true);
    expect(result.onlyEndingsDiffer).toBe(false);
    expect(result.stats).toMatchObject({ added: 0, removed: 0, changed: 0, unchanged: 3, hunks: 0 });
    expect(result.stats.similarity).toBe(1);
  });

  it('separates a line-ending-only difference from a real one', () => {
    const result = diffLines('a\nb\n', 'a\r\nb\r\n');
    expect(result.identicalLines).toBe(true);
    // The whole point: a CRLF/LF pair must not read as "every line changed".
    expect(result.stats.changed).toBe(0);
    expect(result.onlyEndingsDiffer).toBe(true);
  });

  it('counts a rewritten line as one change, not an add plus a delete', () => {
    const result = diffLines('a\nb\nc\n', 'a\nB\nc\n');
    expect(result.stats).toMatchObject({ changed: 1, added: 0, removed: 0, unchanged: 2, hunks: 1 });
  });

  it('counts a pure insertion and a pure deletion separately', () => {
    expect(diffLines('a\nc\n', 'a\nb\nc\n').stats).toMatchObject({ added: 1, removed: 0, changed: 0 });
    expect(diffLines('a\nb\nc\n', 'a\nc\n').stats).toMatchObject({ added: 0, removed: 1, changed: 0 });
  });

  it('counts runs of change as hunks, which is what "next change" steps through', () => {
    const a = 'a\nb\nc\nd\ne\nf\ng\n';
    const b = 'a\nB\nc\nd\ne\nF\ng\n';
    expect(diffLines(a, b).stats.hunks).toBe(2);
  });

  it('handles an empty file on either side', () => {
    expect(diffLines('', 'a\nb\n').stats).toMatchObject({ added: 2, removed: 0 });
    expect(diffLines('a\nb\n', '').stats).toMatchObject({ added: 0, removed: 2 });
    expect(diffLines('', '').identicalLines).toBe(true);
  });

  it('ignores whitespace changes when asked, and only then', () => {
    const a = 'if (x) {\n  go();\n}\n';
    const b = 'if (x) {\n\t\tgo();\n}\n';
    expect(diffLines(a, b).stats.changed).toBe(1);
    expect(diffLines(a, b, { ignoreWhitespace: true }).identicalLines).toBe(true);
  });

  it('ignores case when asked, and only then', () => {
    expect(diffLines('Alpha\n', 'alpha\n').stats.changed).toBe(1);
    expect(diffLines('Alpha\n', 'alpha\n', { ignoreCase: true }).identicalLines).toBe(true);
  });

  it('aligns on unique lines rather than on stray braces', () => {
    // The patience case. A minimal edit script is free to pair the `}` that
    // closes `alpha` with the one that closes `beta`; anchoring on the unique
    // signature lines is what stops it.
    const a = 'function alpha() {\n  return 1;\n}\n';
    const b = 'function alpha() {\n  return 1;\n}\n\nfunction beta() {\n  return 2;\n}\n';
    const result = diffLines(a, b);
    expect(result.stats).toMatchObject({ removed: 0, changed: 0, added: 4 });
    // Every line of A survives, in order, as an `equal`.
    expect(replay(result.blocks, splitLines(a).lines, splitLines(b).lines)).toEqual(
      splitLines(b).lines,
    );
  });

  it('propagates cancellation out of `check`', () => {
    const a = `${Array.from({ length: 400 }, (_, i) => `a${i}`).join('\n')}\n`;
    const b = `${Array.from({ length: 400 }, (_, i) => `b${i}`).join('\n')}\n`;
    expect(() =>
      diffLines(a, b, {
        check: () => {
          throw new Error('stop');
        },
      }),
    ).toThrow('stop');
  });
});

// ---------------------------------------------------------------------------
// The property tests
// ---------------------------------------------------------------------------

describe('diffLines — properties that must hold for every input', () => {
  const OPTION_SETS: DiffOptions[] = [{}, { ignoreWhitespace: true }, { ignoreCase: true }];

  it('produces a script that replays A into B (200 seeded cases)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = rng(seed);
      const alphabet = 3 + Math.floor(random() * 40);
      const aLines = randomFile(random, Math.floor(random() * 60), alphabet);
      const bLines = mutate(random, aLines, Math.floor(random() * 20));
      const options = OPTION_SETS[seed % OPTION_SETS.length] as DiffOptions;

      const aText = aLines.map((line) => `${line}\n`).join('');
      const bText = bLines.map((line) => `${line}\n`).join('');
      const result = diffLines(aText, bText, options);

      expect(replay(result.blocks, aLines, bLines), `seed ${seed}`).toEqual(bLines);
      assertContiguous(result.blocks, aLines.length, bLines.length);
    }
  });

  it('never marks two different lines equal (200 seeded cases)', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = rng(seed);
      // A small alphabet makes repeated lines common — the case where a wrong
      // alignment is easiest to produce and hardest to notice.
      const aLines = randomFile(random, Math.floor(random() * 50), 4);
      const bLines = mutate(random, aLines, Math.floor(random() * 25));
      const result = diffLines(
        aLines.map((line) => `${line}\n`).join(''),
        bLines.map((line) => `${line}\n`).join(''),
      );

      for (const block of result.blocks) {
        if (block.kind !== 'equal') continue;
        for (let i = 0; i < block.aCount; i++) {
          expect(aLines[block.aStart + i], `seed ${seed}`).toBe(bLines[block.bStart + i]);
        }
      }
    }
  });

  it('produces the same number of rows as lines on each side', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const random = rng(seed * 7);
      const aLines = randomFile(random, Math.floor(random() * 40), 10);
      const bLines = mutate(random, aLines, Math.floor(random() * 15));
      const result = diffLines(
        aLines.map((line) => `${line}\n`).join(''),
        bLines.map((line) => `${line}\n`).join(''),
      );
      const rows = toRows(result.blocks);

      expect(rows.filter((row) => row.a !== null)).toHaveLength(aLines.length);
      expect(rows.filter((row) => row.b !== null)).toHaveLength(bLines.length);
      // And they must be in order on both sides.
      let lastA = -1;
      let lastB = -1;
      for (const row of rows) {
        if (row.a !== null) {
          expect(row.a).toBeGreaterThan(lastA);
          lastA = row.a;
        }
        if (row.b !== null) {
          expect(row.b).toBeGreaterThan(lastB);
          lastB = row.b;
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Rows and folding
// ---------------------------------------------------------------------------

describe('toRows', () => {
  it('pairs the two halves of a replacement onto one row', () => {
    const rows = toRows(diffLines('a\nb\nc\n', 'a\nB\nc\n').blocks);
    expect(rowKinds(rows)).toEqual(['equal', 'replace', 'equal']);
  });

  it('leaves the excess of an uneven replacement as its own rows', () => {
    const rows = toRows(diffLines('a\nb\nc\nd\n', 'a\nB\n').blocks);
    expect(rowKinds(rows)).toEqual(['equal', 'replace', 'delete', 'delete']);
  });
});

describe('collapseRows', () => {
  it('folds a long unchanged run into one gap, keeping the context', () => {
    const a = `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const b = a.replace('line 20', 'LINE 20');
    const rows = collapseRows(toRows(diffLines(a, b).blocks), 3);

    const gaps = rows.filter((row) => row.kind === 'gap');
    expect(gaps).toHaveLength(2);
    expect(rows.filter((row) => row.kind === 'equal')).toHaveLength(6);
    // Nothing is lost: the gaps account for every folded line.
    const folded = gaps.reduce((sum, row) => sum + (row as GapRow).count, 0);
    expect(folded + 6 + 1).toBe(40);
  });

  it('keeps everything when the context is unbounded', () => {
    const a = `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const b = a.replace('line 10', 'LINE 10');
    const rows = collapseRows(toRows(diffLines(a, b).blocks), Number.POSITIVE_INFINITY);
    expect(rows).toHaveLength(30);
    expect(rows.some((row) => row.kind === 'gap')).toBe(false);
  });

  it('never folds a run that is not longer than the context it would keep', () => {
    const a = 'x\n1\n2\n3\ny\n';
    const b = 'X\n1\n2\n3\nY\n';
    const rows = collapseRows(toRows(diffLines(a, b).blocks), 3);
    expect(rows.some((row) => row.kind === 'gap')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Word-level diff
// ---------------------------------------------------------------------------

describe('diffWords', () => {
  it('marks only the token that changed', () => {
    const { a, b } = diffWords('const total = price * 2;', 'const total = price * 3;');
    expect(a.filter((s) => s.changed).map((s) => s.text)).toEqual(['2']);
    expect(b.filter((s) => s.changed).map((s) => s.text)).toEqual(['3']);
  });

  it('treats an identifier as one token rather than a run of letters', () => {
    const { b } = diffWords('format(x)', 'for(x)');
    expect(b.filter((s) => s.changed).map((s) => s.text)).toEqual(['for']);
  });

  it('reassembles both sides exactly', () => {
    const pairs: [string, string][] = [
      ['', 'added'],
      ['removed', ''],
      ['  indented', '\tindented'],
      ['a(b, c)', 'a(b, c, d)'],
      ['héllo wörld', 'hello world'],
    ];
    for (const [left, right] of pairs) {
      const { a, b } = diffWords(left, right);
      expect(a.map((s) => s.text).join('')).toBe(left);
      expect(b.map((s) => s.text).join('')).toBe(right);
    }
  });

  it('marks nothing when the lines are identical', () => {
    const { a, b } = diffWords('same()', 'same()');
    expect(a.some((s) => s.changed)).toBe(false);
    expect(b.some((s) => s.changed)).toBe(false);
  });

  it('merges neighbouring segments of the same kind', () => {
    const { b } = diffWords('a', 'a bc de');
    expect(b.filter((s) => s.changed)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Unified output
// ---------------------------------------------------------------------------

describe('toUnified', () => {
  const unified = (a: string, b: string, context = 3): string =>
    toUnified(diffLines(a, b), { aName: 'old.txt', bName: 'new.txt', context });

  it('writes the headers and a correctly numbered hunk', () => {
    const text = unified('a\nb\nc\n', 'a\nB\nc\n');
    expect(text.split('\n').slice(0, 3)).toEqual([
      '--- a/old.txt',
      '+++ b/new.txt',
      '@@ -1,3 +1,3 @@',
    ]);
    expect(text).toContain('-b');
    expect(text).toContain('+B');
  });

  it('numbers a pure insertion from the line before it', () => {
    // Appending to a file: nothing of A is in the hunk beyond its context.
    const text = unified('a\n', 'a\nb\n');
    expect(text).toContain('@@ -1,1 +1,2 @@');
  });

  it('emits one hunk per run of change, not one for the whole file', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const a = `${lines.join('\n')}\n`;
    const b = `${lines.map((line, i) => (i === 2 || i === 30 ? `${line}!` : line)).join('\n')}\n`;
    expect(unified(a, b).match(/^@@ /gm)).toHaveLength(2);
  });

  it('round-trips: the minus side rebuilds A and the plus side rebuilds B', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const random = rng(seed * 13);
      const aLines = randomFile(random, 5 + Math.floor(random() * 40), 12);
      const bLines = mutate(random, aLines, 1 + Math.floor(random() * 12));
      const aText = `${aLines.join('\n')}\n`;
      const bText = `${bLines.join('\n')}\n`;

      // With unbounded context every line is in the patch, so it can be read
      // straight back — the check that the +/- lines carry the right text.
      const text = toUnified(diffLines(aText, bText), {
        aName: 'a',
        bName: 'b',
        context: Number.MAX_SAFE_INTEGER,
      });
      const body = text.split('\n').slice(3, -1);
      const minus = body.filter((l) => l.startsWith('-') || l.startsWith(' ')).map((l) => l.slice(1));
      const plus = body.filter((l) => l.startsWith('+') || l.startsWith(' ')).map((l) => l.slice(1));

      expect(minus, `seed ${seed}`).toEqual(aLines);
      expect(plus, `seed ${seed}`).toEqual(bLines);
    }
  });

  it('marks a missing final newline the way patch does', () => {
    expect(unified('a\nb', 'a\nc')).toContain('\\ No newline at end of file');
  });

  it('writes only headers when nothing changed', () => {
    expect(unified('a\n', 'a\n')).toBe('--- a/old.txt\n+++ b/new.txt\n');
  });
});

// ---------------------------------------------------------------------------
// The op
// ---------------------------------------------------------------------------

describe('text-diff (the op)', () => {
  const decode = (buffer: ArrayBuffer): string => new TextDecoder().decode(buffer);

  function textInput(name: string, text: string): OpInput {
    return { name, type: 'text/plain', buffer: new TextEncoder().encode(text).buffer as ArrayBuffer };
  }

  function makeCtx(signal = new AbortController().signal): OpContext & { progress: number[] } {
    const progress: number[] = [];
    return {
      signal,
      progress,
      onProgress(fraction: number) {
        progress.push(fraction);
      },
    };
  }

  async function expectOpError(promise: Promise<unknown>, code: string): Promise<OpError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(OpError);
      expect((error as OpError).code).toBe(code);
      return error as OpError;
    }
    throw new Error('expected the op to reject with an OpError, but it resolved');
  }

  const OLD = 'function total(items) {\n  return items.length;\n}\n';
  const NEW = 'function total(items) {\n  return items.length * 2;\n}\n';

  // ---- 1. happy path ------------------------------------------------------

  it('builds a self-contained HTML report naming both files', async () => {
    const ctx = makeCtx();
    const [output] = await textDiff([textInput('old.js', OLD), textInput('new.js', NEW)], {}, ctx);

    expect(output?.name).toBe('old-vs-new.html');
    expect(output?.type).toBe('text/html');
    const html = decode(output?.buffer as ArrayBuffer);
    expect(html).toContain('old.js');
    expect(html).toContain('new.js');
    // The word-level highlight is the point of the report, not a nicety.
    expect(html).toContain('<mark>');
  });

  it('never references anything off the machine', async () => {
    const ctx = makeCtx();
    const [output] = await textDiff([textInput('a.txt', OLD), textInput('b.txt', NEW)], {}, ctx);
    const html = decode(output?.buffer as ArrayBuffer);

    // The whole app makes no network calls; a report that needed a CDN to
    // render would quietly break that promise the moment it was opened.
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
  });

  it('escapes file content rather than letting it become markup', async () => {
    // A pure insertion, so the line is escaped as a whole rather than split
    // into word-level marks — the escaping is what is under test here, and the
    // marks are asserted in the report test above.
    const [output] = await textDiff(
      [textInput('a.html', 'kept\n'), textInput('b.html', 'kept\n<b onclick="x">one & two</b>\n')],
      {},
      makeCtx(),
    );
    const html = decode(output?.buffer as ArrayBuffer);

    expect(html).toContain('&lt;b onclick=&quot;x&quot;&gt;one &amp; two&lt;/b&gt;');
    expect(html).not.toContain('<b onclick');
  });

  it('writes a real unified patch when asked for one', async () => {
    const ctx = makeCtx();
    const [output] = await textDiff(
      [textInput('old.js', OLD), textInput('new.js', NEW)],
      { format: 'unified' },
      ctx,
    );

    expect(output?.name).toBe('old-vs-new.diff');
    expect(output?.type).toBe('text/plain');
    const patch = decode(output?.buffer as ArrayBuffer);
    expect(patch).toContain('--- a/old.js');
    expect(patch).toContain('+++ b/new.js');
    expect(patch).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
    expect(patch).toContain('-  return items.length;');
    expect(patch).toContain('+  return items.length * 2;');
  });

  it('honours swap, so the export matches the view it came from', async () => {
    const ctx = makeCtx();
    const [output] = await textDiff(
      [textInput('old.js', OLD), textInput('new.js', NEW)],
      { format: 'unified', swap: true },
      ctx,
    );

    expect(output?.name).toBe('new-vs-old.diff');
    const patch = decode(output?.buffer as ArrayBuffer);
    expect(patch).toContain('--- a/new.js');
    expect(patch).toContain('-  return items.length * 2;');
  });

  it('ignores whitespace and case only when told to', async () => {
    const reindented = 'function total(items) {\n\treturn items.length;\n}\n';
    const plain = await textDiff(
      [textInput('a.js', OLD), textInput('b.js', reindented)],
      { format: 'unified' },
      makeCtx(),
    );
    expect(decode(plain[0]?.buffer as ArrayBuffer)).toContain('@@');

    const relaxed = await textDiff(
      [textInput('a.js', OLD), textInput('b.js', reindented)],
      { format: 'unified', ignoreWhitespace: true },
      makeCtx(),
    );
    expect(decode(relaxed[0]?.buffer as ArrayBuffer)).not.toContain('@@');
  });

  it('says so, rather than nothing, when the files are the same', async () => {
    const [output] = await textDiff(
      [textInput('a.txt', OLD), textInput('b.txt', OLD)],
      {},
      makeCtx(),
    );
    expect(decode(output?.buffer as ArrayBuffer)).toContain('identical contents');
  });

  it('calls a line-ending-only difference what it is', async () => {
    const [output] = await textDiff(
      [textInput('unix.txt', 'a\nb\n'), textInput('dos.txt', 'a\r\nb\r\n')],
      {},
      makeCtx(),
    );
    expect(decode(output?.buffer as ArrayBuffer)).toContain('line endings');
  });

  it('keeps the whole file when the scope asks for it', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const a = `${lines.join('\n')}\n`;
    const b = `${lines.map((line, i) => (i === 30 ? 'CHANGED' : line)).join('\n')}\n`;

    const folded = decode(
      (await textDiff([textInput('a.txt', a), textInput('b.txt', b)], {}, makeCtx()))[0]
        ?.buffer as ArrayBuffer,
    );
    const whole = decode(
      (
        await textDiff(
          [textInput('a.txt', a), textInput('b.txt', b)],
          { scope: 'whole' },
          makeCtx(),
        )
      )[0]?.buffer as ArrayBuffer,
    );

    expect(folded).toContain('unchanged line');
    expect(folded).not.toContain('line 5<');
    expect(whole).not.toContain('unchanged line');
    expect(whole).toContain('line 5<');
  });

  // ---- 2. a typed error ---------------------------------------------------

  it('refuses a file that is not text, naming it', async () => {
    // A lone 0xff byte is not valid UTF-8 in any position.
    const binary: OpInput = {
      name: 'photo.png',
      type: 'image/png',
      buffer: new Uint8Array([0x89, 0x50, 0xff, 0xfe, 0x00]).buffer as ArrayBuffer,
    };
    const error = await expectOpError(
      textDiff([textInput('a.txt', 'hello\n'), binary], {}, makeCtx()),
      'UnsupportedFormat',
    );
    expect(error.file).toBe('photo.png');
  });

  it('refuses a count it cannot compare, without naming a file', async () => {
    // No file name: naming one tells runner.worker.ts to drop that input and
    // retry, and retrying with one file left would fail exactly the same way.
    const error = await expectOpError(
      textDiff([textInput('only.txt', 'hello\n')], {}, makeCtx()),
      'InvalidOptions',
    );
    expect(error.file).toBeUndefined();
  });

  it('rejects options it cannot honour rather than guessing', async () => {
    const two = [textInput('a.txt', OLD), textInput('b.txt', NEW)];
    await expectOpError(textDiff(two, { format: 'pdf' }, makeCtx()), 'InvalidOptions');
    await expectOpError(textDiff(two, { scope: 'everything' }, makeCtx()), 'InvalidOptions');
    await expectOpError(textDiff(two, { context: -1 }, makeCtx()), 'InvalidOptions');
    await expectOpError(textDiff(two, { ignoreCase: 'yes' }, makeCtx()), 'InvalidOptions');
  });

  // ---- 3. cancellation ----------------------------------------------------

  it('settles as Cancelled when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    await expectOpError(
      textDiff([textInput('a.txt', OLD), textInput('b.txt', NEW)], {}, makeCtx(controller.signal)),
      'Cancelled',
    );
  });

  it('stops once the walk is already under way, not only before it starts', async () => {
    // Aborting AFTER the op has begun. The op reads its inputs, reports 0.5,
    // and only then starts comparing — so a signal that trips at 0.5 is one
    // the engine's own `check` callback has to notice mid-walk. Two files with
    // nothing in common make that walk long enough to matter.
    const a = `${Array.from({ length: 2000 }, (_, i) => `alpha ${i}`).join('\n')}\n`;
    const b = `${Array.from({ length: 2000 }, (_, i) => `beta ${i}`).join('\n')}\n`;
    const controller = new AbortController();
    const progress: number[] = [];
    const ctx: OpContext = {
      signal: controller.signal,
      onProgress(fraction) {
        progress.push(fraction);
        if (fraction === 0.5) controller.abort();
      },
    };

    await expectOpError(textDiff([textInput('a.txt', a), textInput('b.txt', b)], {}, ctx), 'Cancelled');
    // It really did get as far as the comparison, and no further.
    expect(progress).toEqual([0.25, 0.5]);
  });

  // ---- 4. progress --------------------------------------------------------

  it('reports progress once per input, monotonically, ending at exactly 1', async () => {
    const ctx = makeCtx();
    await textDiff([textInput('a.txt', OLD), textInput('b.txt', NEW)], {}, ctx);

    expect(ctx.progress.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < ctx.progress.length; i++) {
      expect(ctx.progress[i]).toBeGreaterThanOrEqual(ctx.progress[i - 1] as number);
    }
    expect(ctx.progress[ctx.progress.length - 1]).toBe(1);
  });

  // ---- registry wiring ----------------------------------------------------

  it('is registered, loadable by the worker, and takes exactly two files', () => {
    const tool = DATA_TOOLS.find((entry) => entry.id === 'text-diff');
    expect(tool).toBeDefined();
    expect(tool?.minInputs).toBe(2);
    expect(tool?.maxInputs).toBe(2);
    expect(tool?.editor).toBeTypeOf('function');
    // The worker's static id -> loader map is what actually runs the op; a
    // registry entry without one is a tool that cannot run.
    expect(DATA_LOADERS['text-diff']).toBeTypeOf('function');
  });

  it('declares every option the editor emits', () => {
    const tool = DATA_TOOLS.find((entry) => entry.id === 'text-diff');
    // The editor supersedes the schema in the UI, but the schema is still the
    // documented contract — an option only the editor knows about is one the
    // op can be handed without anything having declared it.
    expect(Object.keys(tool?.options ?? {}).sort()).toEqual([
      'context',
      'format',
      'ignoreCase',
      'ignoreWhitespace',
      'scope',
      'swap',
    ]);
  });
});

describe('toUnified — hunk numbering with no context at all', () => {
  // `context: 0` is where a hunk can contain rows from only ONE side, which is
  // where a header taken from "the first row that has an A index" silently
  // becomes `@@ -0,0`: right for an insertion at the top of the file, wrong for
  // an insertion anywhere else.
  const zero = (a: string, b: string): string =>
    toUnified(diffLines(a, b), { aName: 'a', bName: 'b', context: 0 });

  it('numbers an insertion in the middle from the line before it', () => {
    expect(zero('one\ntwo\n', 'one\nNEW\ntwo\n')).toContain('@@ -1,0 +2,1 @@');
  });

  it('numbers an insertion at the very top from line 0', () => {
    expect(zero('one\n', 'NEW\none\n')).toContain('@@ -0,0 +1,1 @@');
  });

  it('numbers an insertion at the very end from the last line', () => {
    expect(zero('one\ntwo\n', 'one\ntwo\nNEW\n')).toContain('@@ -2,0 +3,1 @@');
  });

  it('numbers a deletion the same way from the other side', () => {
    expect(zero('one\ntwo\nthree\n', 'one\nthree\n')).toContain('@@ -2,1 +1,0 @@');
  });

  it('keeps every hunk numbered from where it really is', () => {
    const a = `${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const b = a.replace('line 4', 'line 4\nINSERTED').replace('line 15', 'CHANGED');
    const headers = zero(a, b).match(/^@@ .*$/gm) ?? [];

    expect(headers).toEqual(['@@ -5,0 +6,1 @@', '@@ -16,1 +17,1 @@']);
  });
});
