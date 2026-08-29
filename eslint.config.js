// eslint.config.js — encodes the §1 import-boundary rules (flat config, ESM).
//
// Rules enforced here (see docs/superpowers/plans/2026-08-29-omnitool.md §1):
//   1. src/tools/** may import only from src/types.ts and its declared npm engine —
//      never from src/core/** or src/ui/**.
//   2. src/core/** must never import from src/ui/**.
//   3. Only src/ui/motion.ts may import 'animejs'.
// Plus: src/tools/** is DOM-free — no `window`, `document`, or `HTMLElement`.
//
// IMPORTANT: a rule *name* (e.g. `no-restricted-imports`) that appears in two config
// objects both matching the same file gets fully OVERWRITTEN by whichever object is
// later in this array — ESLint flat config does not merge two settings for the same
// rule name. So each directory's restrictions (core/ui ban, animejs ban, etc.) are
// combined into a single `no-restricted-imports` call per block below, rather than
// spread across separate blocks that would otherwise clobber one another.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

const CORE_UI_MESSAGE =
  'src/tools/** may import only from src/types.ts and its declared npm engine — never from src/core/** or src/ui/**.';
const UI_MESSAGE = 'src/core/** must never import from src/ui/**.';
const ANIME_MESSAGE = "Only src/ui/motion.ts may import 'animejs'.";

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'playwright-report/**', 'test-results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  // Node-context files: config files, build/CI scripts, and tests (vitest runs under Node).
  {
    files: ['eslint.config.js', 'vite.config.ts', 'vitest.workspace.ts', 'playwright.config.ts', 'scripts/**/*.mjs', 'tests/**/*.mjs', 'tests/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // App code: runs on the main thread in a browser tab. src/tools/** and the
  // worker entry (src/core/workers/*.worker.ts) are excluded here (see the
  // worker-scope block below) so they never see `window`/`document` as
  // defined globals in the first place. src/core/workers/pool.ts itself is
  // main-thread code (it creates and manages Workers) and belongs here.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/tools/**/*.ts', '**/*.worker.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  // Worker-scope code: ops (src/tools/**) and the worker entry point
  // (*.worker.ts) run inside a Web Worker — no window/document, deliberately.
  {
    files: ['src/tools/**/*.ts', '**/*.worker.ts'],
    languageOptions: {
      globals: { ...globals.worker },
    },
  },

  // 1. src/tools/**: only src/types.ts + npm packages. No core/, no ui/, no animejs.
  //    Plus: DOM-free — no window/document/HTMLElement (ops run in a worker).
  {
    files: ['src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['**/core/*', '**/core/**', '**/ui/*', '**/ui/**'], message: CORE_UI_MESSAGE }],
          paths: [{ name: 'animejs', message: ANIME_MESSAGE }],
        },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'window', message: 'Ops are DOM-free — no `window` in src/tools/**.' },
        { name: 'document', message: 'Ops are DOM-free — no `document` in src/tools/**.' },
        { name: 'HTMLElement', message: 'Ops are DOM-free — no `HTMLElement` in src/tools/**.' },
      ],
    },
  },

  // 2. src/core/**: never src/ui/. Also no animejs (only motion.ts may import it).
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [{ group: ['**/ui/*', '**/ui/**'], message: UI_MESSAGE }],
          paths: [{ name: 'animejs', message: ANIME_MESSAGE }],
        },
      ],
    },
  },

  // 3a. src/ui/** (except motion.ts): no animejs.
  {
    files: ['src/ui/**/*.ts'],
    ignores: ['src/ui/motion.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'animejs', message: ANIME_MESSAGE }] }],
    },
  },

  // 3b. Everything else (main.ts, scripts/, tests/): no animejs either.
  {
    files: ['**/*.ts'],
    ignores: ['src/ui/**/*.ts', 'src/tools/**/*.ts', 'src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'animejs', message: ANIME_MESSAGE }] }],
    },
  },
);
