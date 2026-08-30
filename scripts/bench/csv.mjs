// scripts/bench/csv.mjs — the CSV parser: is it still the same parser, and is
// it still faster?
//
// The rewrite in 7d0e86d changed parseCsv from appending one character at a
// time to scanning by character code and copying runs with slice. That is only
// a defensible change if it answers identically for every input, which is what
// the fuzz below establishes — against the REAL parser imported from src/, and
// the pre-rewrite parser pinned in reference/.

import { loadFromSource, cleanUp, measure, random } from './_bundle.mjs';
import { parseCsv as reference } from './reference/csv-parser-97aaa82.mjs';

const CASES = Number(process.env.BENCH_CASES ?? 200_000);
const SEED = Number(process.env.BENCH_SEED ?? 12_345);

/**
 * Fragments chosen to land on the parser's every decision: bare quotes,
 * doubled quotes, quoted fields holding delimiters and newlines, lone CRs,
 * CRLFs, and each candidate delimiter.
 */
const FRAGMENTS = [
  'a', 'bb', '', '"', '""', ',', ';', '\t', '\n', '\r', '\r\n', ' ', '  ',
  'x,y', '"q"', '"a,b"', '"a""b"', '"\n"', '"\r\n"', 'a"b', '""""', '"', 'é', '𝒳',
];

function fuzzCase(next) {
  let out = '';
  const pieces = 1 + Math.floor(next() * 24);
  for (let i = 0; i < pieces; i++) out += FRAGMENTS[Math.floor(next() * FRAGMENTS.length)];
  return out;
}

function makeCsv(rows) {
  const lines = [];
  for (let r = 0; r < rows; r++) {
    lines.push(`${r},name-${r},"quoted, field ${r}",${r * 3.5},plain text value ${r},"with ""escapes"" ${r}"`);
  }
  return lines.join('\n');
}

const { parseCsv } = await loadFromSource('src/tools/data/csv-json.op.ts');

// --------------------------------------------------------------- equivalence
console.log(`\ncsv — differential fuzz, ${CASES.toLocaleString('en')} cases, seed ${SEED}`);
const next = random(SEED);
let mismatches = 0;
for (let i = 0; i < CASES; i++) {
  const text = fuzzCase(next);
  const delimiter = i % 3 === 0 ? ';' : i % 3 === 1 ? '\t' : ',';

  let mine, theirs, myError = null, theirError = null;
  try {
    mine = JSON.stringify(parseCsv(text, delimiter));
  } catch (error) {
    myError = error.message;
  }
  try {
    theirs = JSON.stringify(reference(text, delimiter));
  } catch (error) {
    theirError = error.message;
  }

  if (mine !== theirs || myError !== theirError) {
    mismatches++;
    if (mismatches <= 5) {
      console.log(`  MISMATCH on ${JSON.stringify(text)} (delimiter ${JSON.stringify(delimiter)})`);
      console.log(`    current  : ${myError ?? mine}`);
      console.log(`    reference: ${theirError ?? theirs}`);
    }
  }
}
console.log(
  mismatches === 0
    ? '  identical on every case, error messages included'
    : `  ${mismatches} MISMATCHES — the rewrite is not the same parser`,
);

// ----------------------------------------------------------------- the speed
const csv = makeCsv(120_000);
console.log(`\ncsv — parse ${(csv.length / 1024 / 1024).toFixed(1)} MB / 120k rows`);
const current = measure((text) => parseCsv(text, ','), csv);
const before = measure((text) => reference(text, ','), csv);
console.log(`  current    ${current.toFixed(1).padStart(8)} ms`);
console.log(`  reference  ${before.toFixed(1).padStart(8)} ms   (${(before / current).toFixed(1)}x slower)`);

await cleanUp();
process.exitCode = mismatches === 0 ? 0 : 1;
