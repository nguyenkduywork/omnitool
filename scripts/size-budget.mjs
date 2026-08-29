#!/usr/bin/env node
// scripts/size-budget.mjs
//
// CI size-budget gate (§1 of the plan):
//   initial JS   ≤ 40 KB gzip
//   initial CSS  ≤ 12 KB gzip
//   total first-paint transfer ≤ 60 KB gzip
//
// "Initial" means: the files the browser must fetch to first-paint the app —
// the HTML entry's own emitted chunk plus everything it *statically* imports
// (manifest `imports`/`css`), walked recursively. Anything only reachable via
// `dynamicImports` (a lazily-imported *.op.ts, an editor, etc.) is deliberately
// excluded — that's the whole point of the lazy-loading architecture.
//
// 1 KB here means 1024 bytes (KiB), the conventional unit for gzip'd web
// asset budgets in bundler tooling. Documented explicitly because "KB" is
// otherwise ambiguous between 1000 and 1024.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { gzipSizeFromFile } from 'gzip-size';

const KB = 1024;
const BUDGETS = {
  js: 40 * KB,
  css: 12 * KB,
  total: 60 * KB,
};

const distDir = path.resolve(process.cwd(), 'dist');
const manifestPath = path.join(distDir, '.vite', 'manifest.json');

function fmtKB(bytes) {
  return `${(bytes / KB).toFixed(2)} KB`;
}

async function loadManifest() {
  let raw;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch (err) {
    console.error(`size-budget: could not read ${manifestPath}`);
    console.error('Did you run "npm run build" first? (build.manifest must stay enabled in vite.config.ts)');
    console.error(String(err));
    process.exit(1);
  }
  return JSON.parse(raw);
}

/** Collect every JS/CSS file reachable from the entry via *static* imports only. */
function collectInitialFiles(manifest) {
  const entryKeys = Object.keys(manifest).filter((key) => manifest[key]?.isEntry);
  if (entryKeys.length === 0) {
    console.error('size-budget: no isEntry chunk found in manifest.json');
    process.exit(1);
  }

  const jsFiles = new Set();
  const cssFiles = new Set();
  const visited = new Set();

  function walk(key) {
    if (visited.has(key)) return;
    visited.add(key);
    const chunk = manifest[key];
    if (!chunk) return;

    if (chunk.file) jsFiles.add(chunk.file);
    for (const cssFile of chunk.css ?? []) cssFiles.add(cssFile);

    // Static imports only — dynamicImports are lazy chunks, excluded on purpose.
    for (const importedKey of chunk.imports ?? []) walk(importedKey);
  }

  for (const entryKey of entryKeys) walk(entryKey);

  return { jsFiles: [...jsFiles], cssFiles: [...cssFiles] };
}

async function sumGzip(files) {
  let total = 0;
  const rows = [];
  for (const file of files) {
    const filePath = path.join(distDir, file);
    const size = await gzipSizeFromFile(filePath);
    total += size;
    rows.push({ file, size });
  }
  return { total, rows };
}

function printTable(rows) {
  const widest = Math.max(...rows.map((r) => r.label.length), 'Category'.length);
  const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));

  console.log(`${pad('Category', widest)}  ${'Size'.padStart(10)}  ${'Budget'.padStart(10)}  Status`);
  console.log('-'.repeat(widest + 34));
  for (const row of rows) {
    const status = row.ok ? 'PASS' : 'FAIL';
    console.log(
      `${pad(row.label, widest)}  ${fmtKB(row.size).padStart(10)}  ${fmtKB(row.budget).padStart(10)}  ${status}`,
    );
  }
}

async function main() {
  const manifest = await loadManifest();
  const { jsFiles, cssFiles } = collectInitialFiles(manifest);

  const [js, css] = await Promise.all([sumGzip(jsFiles), sumGzip(cssFiles)]);
  const total = js.total + css.total;

  console.log('Initial-load files:');
  for (const { file, size } of [...js.rows, ...css.rows]) {
    console.log(`  ${file}  (${fmtKB(size)})`);
  }
  console.log('');

  const rows = [
    { label: 'Initial JS', size: js.total, budget: BUDGETS.js, ok: js.total <= BUDGETS.js },
    { label: 'Initial CSS', size: css.total, budget: BUDGETS.css, ok: css.total <= BUDGETS.css },
    { label: 'Total first paint', size: total, budget: BUDGETS.total, ok: total <= BUDGETS.total },
  ];
  printTable(rows);

  const breached = rows.filter((r) => !r.ok);
  if (breached.length > 0) {
    console.error('');
    console.error(`size-budget: BREACH — ${breached.map((r) => r.label).join(', ')} exceeded budget.`);
    process.exit(1);
  }

  console.log('');
  console.log('size-budget: all budgets satisfied.');
}

main();
