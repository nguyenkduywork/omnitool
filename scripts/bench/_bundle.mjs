// scripts/bench/_bundle.mjs — load a TypeScript module from src/ into Node.
//
// The whole value of these harnesses is that they measure THE SHIPPED CODE. A
// benchmark against a pasted copy of an implementation measures a fossil: it
// keeps reporting the same number long after the real function has changed,
// which is worse than having no benchmark at all.
//
// Node cannot import src/**/*.ts directly — the modules there import each other
// with `.js` specifiers that only exist after a build — so each entry goes
// through Vite's own build API, the same one `npm run build` uses. Vite is a
// declared devDependency, so this needs nothing that is not already installed.

import { rmSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'vite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Temp directories this process created, cleaned up on exit. */
const scratch = [];

process.on('exit', () => {
  // Best-effort: a leftover temp directory is untidy, not harmful.
  for (const dir of scratch) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

/**
 * Bundle `entry` (a path relative to the repository root) and import it.
 * Returns the module's exports.
 */
export async function loadFromSource(entry) {
  const result = await build({
    root: ROOT,
    configFile: false,
    logLevel: 'error',
    build: {
      write: false,
      minify: false,
      target: 'node20',
      lib: { entry: path.join(ROOT, entry), formats: ['es'], fileName: 'bundle' },
      rollupOptions: { external: (id) => id.startsWith('node:') },
    },
  });

  const output = Array.isArray(result) ? result[0].output : result.output;
  const code = output.find((chunk) => chunk.type === 'chunk')?.code;
  if (code === undefined) throw new Error(`nothing was bundled from ${entry}`);

  const dir = await mkdtemp(path.join(tmpdir(), 'omnitool-bench-'));
  scratch.push(dir);
  const file = path.join(dir, 'bundle.mjs');
  await writeFile(file, code, 'utf8');
  return import(pathToFileURL(file).href);
}

/** Remove this process's temp directories now, rather than at exit. */
export async function cleanUp() {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
  scratch.length = 0;
}

/**
 * Median wall-clock milliseconds over `runs`, after one warm-up. The median
 * rather than the mean because one GC pause should not become the headline.
 */
export function measure(fn, argument, runs = 5) {
  fn(argument);
  const times = [];
  for (let i = 0; i < runs; i++) {
    const started = process.hrtime.bigint();
    fn(argument);
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(runs / 2)];
}

/** A deterministic PRNG, so a fuzz failure is reproducible from its seed. */
export function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** Deterministic pseudo-random bytes — the same payload on every machine. */
export function bytes(length, seed = 1) {
  const next = random(seed);
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (next() * 256) | 0;
  return out;
}

export function report(rows) {
  const width = Math.max(...rows.map((row) => row.label.length));
  for (const row of rows) {
    const detail = row.detail === undefined ? '' : `   ${row.detail}`;
    console.log(`  ${row.label.padEnd(width)}  ${row.ms.toFixed(1).padStart(8)} ms${detail}`);
  }
}
