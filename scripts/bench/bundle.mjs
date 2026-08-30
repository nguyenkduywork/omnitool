// scripts/bench/bundle.mjs — "Download all": what storing already-compressed
// output saves, and what deflating the rest still earns.
//
// fs.ts picks a per-entry deflate level. This measures both halves of that
// decision with the REAL policy function, so the day someone adds a mime type
// to the wrong side of it, the number moves here.

import { zip } from 'fflate';

import { loadFromSource, cleanUp, bytes } from './_bundle.mjs';

const KB = 1024;
const { zipLevelFor } = await loadFromSource('src/core/fs.ts');

function timedZip(entries) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    zip(entries, {}, (error, data) => {
      if (error) reject(error);
      else resolve({ ms: Number(process.hrtime.bigint() - started) / 1e6, size: data.length });
    });
  });
}

function atLevel(files, level) {
  const entries = {};
  for (const [name, data] of Object.entries(files)) entries[name] = [data, { level }];
  return entries;
}

/** What the shipped policy would choose, entry by entry. */
function asShipped(files, type) {
  const level = zipLevelFor(type);
  const entries = {};
  for (const [name, data] of Object.entries(files)) entries[name] = [data, { level }];
  return { entries, level };
}

// Already-compressed output: a PNG's bytes are deflate output and a JPEG's are
// DCT plus Huffman — different codecs, both incompressible, which is the only
// property that matters. Pseudo-random bytes model that exactly.
const images = {};
for (let i = 0; i < 40; i++) images[`shot-${i}.png`] = bytes(500 * KB, i + 1);

// Text output, where deflate earns its keep many times over.
const text = {};
const line = 'id,name,value,notes\n1,alpha,42,"a fairly typical csv row with words in it"\n';
for (let i = 0; i < 40; i++) text[`rows-${i}.csv`] = new TextEncoder().encode(line.repeat(4000));

const png = asShipped(images, 'image/png');
const csv = asShipped(text, 'text/csv');

const results = [
  ['40 images, level 6 (the old way)', await timedZip(atLevel(images, 6))],
  [`40 images, level ${png.level} (shipped)`, await timedZip(png.entries)],
  ['40 CSVs,   level 0 (store)', await timedZip(atLevel(text, 0))],
  [`40 CSVs,   level ${csv.level} (shipped)`, await timedZip(csv.entries)],
];

console.log('\ndownload-all bundling — time, and the size it costs');
const width = Math.max(...results.map(([label]) => label.length));
for (const [label, result] of results) {
  console.log(`  ${label.padEnd(width)}  ${result.ms.toFixed(0).padStart(6)} ms   ${(result.size / 1024 / 1024).toFixed(2).padStart(6)} MB`);
}

console.log('\n  The policy, as the shipped code reports it:');
for (const type of ['image/png', 'image/jpeg', 'application/zip', 'application/gzip', 'text/csv', 'application/pdf', 'text/plain']) {
  console.log(`    ${type.padEnd(18)} -> level ${zipLevelFor(type)} ${zipLevelFor(type) === 0 ? '(stored)' : '(deflated)'}`);
}

await cleanUp();
