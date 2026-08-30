import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { defineConfig, transformWithEsbuild, type Plugin } from 'vite';

type ManifestChunk = { file?: string; css?: string[]; imports?: string[]; isEntry?: boolean };
type Manifest = Record<string, ManifestChunk>;

/**
 * Emits `dist/sw.js` from `src/sw.ts` (Task 7).
 *
 * `src/sw.ts` is deliberately NOT a second Rollup entry: adding one would
 * mark it `isEntry` in `dist/.vite/manifest.json`, and
 * `scripts/size-budget.mjs` sums the JS of every `isEntry` chunk it can walk
 * — a service worker fetched long after first paint has no business in that
 * "initial load" figure. So this plugin runs AFTER the real build (once
 * `dist/.vite/manifest.json` exists), transforms `src/sw.ts` on its own with
 * Vite's own `transformWithEsbuild` (TS -> JS only — no bundling, no new
 * dependency), and prepends the real precache list as a literal
 * `const __PRECACHE__ = [...]` — see the comment at the top of `src/sw.ts`
 * for what reads it and why.
 */
function serviceWorkerPlugin(): Plugin {
  let outDir = 'dist';
  return {
    name: 'omnitool-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    async closeBundle() {
      const manifest: Manifest = JSON.parse(
        await readFile(path.join(outDir, '.vite', 'manifest.json'), 'utf8'),
      );

      // The app shell: every file reachable from an HTML entry via STATIC
      // imports only — exactly the set scripts/size-budget.mjs calls
      // "initial". A dynamicImports-only chunk (an *.op.ts, an editor, a
      // vendor engine) is reached instead by the runtime stale-while-
      // revalidate handler, the first time it is actually fetched.
      const shell = new Set<string>(['index.html']);
      const visited = new Set<string>();
      function walk(key: string): void {
        if (visited.has(key)) return;
        visited.add(key);
        const chunk = manifest[key];
        if (!chunk) return;
        if (chunk.file) shell.add(chunk.file);
        for (const cssFile of chunk.css ?? []) shell.add(cssFile);
        for (const importedKey of chunk.imports ?? []) walk(importedKey);
      }
      for (const key of Object.keys(manifest)) {
        if (manifest[key]?.isEntry) walk(key);
      }

      // Installability assets: the manifest itself and every generated icon.
      shell.add('manifest.webmanifest');
      const iconsDir = path.join(outDir, 'icons');
      for (const file of await readdir(iconsDir)) shell.add(`icons/${file}`);

      const source = await readFile(path.resolve('src/sw.ts'), 'utf8');
      const { code } = await transformWithEsbuild(source, 'sw.ts', {
        loader: 'ts',
        target: 'es2022',
      });
      const precache = `const __PRECACHE__ = ${JSON.stringify([...shell].sort())};\n`;
      await writeFile(path.join(outDir, 'sw.js'), precache + code);
    },
  };
}

// GitHub Pages + hash routing => relative base.
// Worker format 'es' so dynamic import() works inside workers.
// No manualChunks: Vite's default code-splitting already gives each
// dynamically-imported *.op.ts its own chunk; we don't want to interfere.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // Manifest lets scripts/size-budget.mjs (and serviceWorkerPlugin above)
    // find exactly which emitted files are part of the initial (first-paint)
    // load vs. lazy chunks.
    manifest: true,
  },
  worker: {
    format: 'es',
  },
  plugins: [serviceWorkerPlugin()],
});
