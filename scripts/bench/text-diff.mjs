// scripts/bench/text-diff.mjs — measure the shipped indexed Text Diff path.

import { cleanUp, loadFromSource, measure, report } from './_bundle.mjs';

const { diffLines } = await loadFromSource('src/tools/data/diff.ts');
const { createComparisonSnapshot } = await loadFromSource('src/tools/data/text-diff.model.ts');
const { buildViewIndex, findText, readRowWindow } = await loadFromSource('src/tools/data/diff-view.ts');

function snapshot(a, b) {
  return createComparisonSnapshot({
    revision: 1,
    sources: [{ text: a, name: 'a.txt', origin: 'text' }, { text: b, name: 'b.txt', origin: 'text' }],
    rules: { ignoreWhitespace: false, ignoreCase: false },
  });
}

function indexed(a, b) {
  const compared = diffLines(a, b);
  return buildViewIndex(snapshot(a, b), compared);
}

// 200k display lines combined, under 1 MiB, with a change hunk on every other
// row. This catches accidental full-row or verbose-hunk allocation.
const manyA = Array.from({ length: 100_000 }, (_, index) => `${index.toString(36)}\n`).join('');
const manyB = Array.from({ length: 100_000 }, (_, index) => `${index % 2 ? 'x' : ''}${index.toString(36)}\n`).join('');
const many = indexed(manyA, manyB);
if (many.logicalRows !== 100_000 || many.hunks.length < 49_000) throw new Error(`many-hunk fixture lost navigation targets (${many.logicalRows} rows, ${many.hunks.length} hunks)`);

// Physical metadata needs its own fixture: no display changes, but all ending
// differences must remain a navigable metadata target without full rows.
const endingsA = 'line\n'.repeat(60_000);
const endingsB = 'line\r\n'.repeat(60_000);
const endings = indexed(endingsA, endingsB);
if (!endings.hunks.some((hunk) => hunk.kind === 'metadata')) throw new Error('metadata fixture lost ending changes');

console.log('\ntext-diff — actual Vite-bundled indexed comparison');
report([
  { label: '100k rows / 50k hunks index', ms: measure(() => indexed(manyA, manyB), undefined, 3) },
  { label: '100k rows first bounded window', ms: measure(() => readRowWindow(many, { cursor: { row: 0, aOffset: 0, bOffset: 0 }, detail: 'word', context: 3, expansions: [] }), undefined, 5) },
  { label: '100k rows final hunk window', ms: measure(() => readRowWindow(many, { cursor: { row: 99_999, aOffset: 0, bOffset: 0 }, detail: 'word', context: 'whole', expansions: [] }), undefined, 5) },
  { label: 'mass ending metadata index', ms: measure(() => indexed(endingsA, endingsB), undefined, 3) },
  { label: 'literal Find original offset', ms: measure(() => findText(many, 'x', false, 49_999), undefined, 5) },
]);

await cleanUp();
