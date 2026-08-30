# Contributing to omnitool

This is a short document about why a PR gets rejected, so you can catch it
yourself before CI does. Everything here is mechanically enforced — by
ESLint, by the test suite, or by `scripts/size-budget.mjs` — nothing here is
a matter of taste to argue about.

Before sending a PR: `npm run typecheck && npm run lint && npm run test &&
npm run build && npm run size && npm run test:e2e` must all pass. CI runs
exactly this.

## 1. The import rules

omnitool's whole extensibility story depends on `src/tools/**` staying
inert: an op is a pure function that only knows about the bytes it's given,
never about the DOM, the registry, or the UI. This is enforced by
`eslint.config.js`, not by convention:

- **`src/tools/**` may import *only* from `src/types.ts` and its declared
  npm dependency (e.g. `pdf-lib`, `fflate`) — never from `src/core/**` or
  `src/ui/**`.** An op receives everything else it needs as function
  arguments (`inputs`, `options`, `ctx`). This is what keeps every op
  testable in plain Node/vitest with no browser and no mocking, and what
  makes "copy one file, add one registry line" actually true. A *sibling*
  module under `src/tools/**` is fine, and is how two ops share the format
  knowledge they both need — `pdf/page-range.ts`, `data/tar.ts`,
  `data/entry-name.ts` — as long as it obeys the same rules the ops do.
- **`src/core/**` must never import from `src/ui/**`.** The kernel (registry,
  pipeline, worker pool) has no idea the UI exists. The dependency only ever
  points one way: `ui/` → `core/` → `types.ts`.
- **Only `src/ui/motion.ts` may import `animejs`.** All animation is owned
  by one module so `prefers-reduced-motion` can be honoured in exactly one
  place (see the note on `*.op.ts` below) and so no other file can quietly
  start animating a layout property.
- **`*.op.ts` files are DOM-free.** No `window`, `document`, or
  `HTMLElement` — an op runs inside a Web Worker, where none of those exist.
  A sibling `*.editor.ts` (e.g. `pdf/organize.editor.ts`) is deliberately
  exempt from the DOM ban — it *is* DOM code, colocated with its op because
  the two change together — but it still can't import `core/` or `ui/`.

`npm run lint` fails the build on any of the above. If you think a tool
genuinely needs to reach into `core/` or `ui/`, that's a sign the
work belongs in the op's caller, not the op.

## 2. The four-test rule

**Every op, without exception, needs tests covering all four of:**

1. **Happy path** — correct output from valid input.
2. **A typed error** — a corrupt or invalid input raises the correct
   `OpErrorCode` from `src/types.ts` (never a bare `Error`), and names the
   offending file via `OpError`'s `file` field when the failure is
   attributable to one input.
3. **Cancellation** — aborting the `AbortSignal` on `ctx` part-way through
   settles the op with `Cancelled`.
4. **Progress** — `ctx.onProgress` is called at least once per input, the
   values are monotonically non-decreasing, and the run ends at exactly `1`.

A PR adding or changing an op without all four is incomplete, not just
under-tested — reviewers should ask for the missing case rather than wave it
through. See `README.md`'s "Add a tool in 20 lines" for a worked example
hitting all four, and any file in `tests/unit/{pdf,image,data}.test.ts` for
the real thing.

## 3. The size budget

CI builds the app and runs `scripts/size-budget.mjs` against `dist/`, which
fails the build if the **initial** payload — everything the browser must
fetch to first-paint the app, walked from the HTML entry's *static* imports
only — exceeds:

| | Budget |
| --- | --- |
| Initial JS (gzip) | 40 KB |
| Initial CSS (gzip) | 12 KB |
| Total first paint (gzip) | 60 KB |

"Initial" deliberately excludes anything reachable only via a *dynamic*
`import()` — a lazily-loaded `*.op.ts`, an `*.editor.ts`, `pdf-lib`,
`pdfjs-dist`, `fflate`, `qrcode`, all of it. That's the entire reason ops are
loaded through `ToolDef.load()` and the worker's static id → loader map
instead of being statically imported anywhere: a new tool, however heavy its
dependency, must never grow the entry bundle. If a change to `src/ui/**` or
`src/main.ts` pushes a *static* import of something heavy, the budget — not
a reviewer's judgement call — is what stops it. Run `npm run build && npm
run size` locally before opening a PR that touches anything outside
`src/tools/**`.

## Everything else

- TypeScript strict mode is on; no `any` in committed code, and no
  `@ts-ignore` without a one-line comment explaining why.
- Animation touches only `transform` and `opacity`; `prefers-reduced-motion:
  reduce` must disable it entirely (functionality can never depend on an
  animation finishing).
- No tool may claim an outcome it didn't achieve — see the "Shrink PDF" and
  AVIF notes in `README.md` for what "honest reporting" means in practice.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `test:`, `docs:`, `chore:`).
- `npm install` wires up a `pre-commit` hook (`scripts/verify-lockfile.mjs`,
  via `.githooks/`) that blocks a commit if `package-lock.json` is missing,
  empty, or invalid JSON. It exists because that exact corruption once
  reached `main` directly and broke CI until a follow-up commit fixed it —
  catching it before a commit is cheaper than catching it after.
