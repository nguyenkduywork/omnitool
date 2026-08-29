import { defineConfig } from 'vite';

// GitHub Pages + hash routing => relative base.
// Worker format 'es' so dynamic import() works inside workers.
// No manualChunks: Vite's default code-splitting already gives each
// dynamically-imported *.op.ts its own chunk; we don't want to interfere.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    // Manifest lets scripts/size-budget.mjs find exactly which emitted
    // files are part of the initial (first-paint) load vs. lazy chunks.
    manifest: true,
  },
  worker: {
    format: 'es',
  },
});
