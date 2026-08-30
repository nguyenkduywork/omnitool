# omnitool — Design Spec

- **Date:** 2026-08-29
- **Status:** Approved
- **Owner:** Kim Duy NGUYEN

## 1. Overview

`omnitool` is an open-source (MIT), 100% client-side web app for the file operations
people actually need day to day: merging PDFs, merging and converting images,
changing file formats, zipping, hashing, and small data conversions.

Three non-negotiable properties:

1. **Private by construction.** No file ever leaves the device. There is no server.
2. **Extremely fast**, enforced by measurable budgets in CI (§6) rather than intent.
3. **Trivially extensible.** Adding a tool is one `.op.ts` file plus one registry entry.

Deployment is a static bundle to **GitHub Pages** (chosen over Cloudflare Pages
so the project needs no account beyond the one hosting the source). Routing is
hash-based accordingly. No backend, no runtime configuration.

## 2. Non-goals (v1)

Explicitly out of scope. Each is a deliberate cut, not an oversight:

- Audio/video conversion (`ffmpeg.wasm` costs ~25–30 MB of WASM; revisit in v2)
- OCR, and Office formats (`.docx` / `.xlsx` / `.pptx`)
  (OCR was later built and then removed again — see the note in §5.1.)
- User accounts, cloud storage, sync, sharing links
- Server-side processing of any kind
- i18n, analytics, telemetry
- Ghostscript-grade PDF compression (see the note on `pdf-shrink` in §5.1)

## 3. Architecture

A **tool registry** plus a **worker pipeline**. The application shell has no
knowledge of PDFs, images, or archives. It knows only how to:

1. sniff an incoming file's real type,
2. ask the registry which tools accept that type,
3. run the chosen tool in a worker, and
4. hand the results back to the user.

All format-specific knowledge lives inside individual tool modules ("ops"),
behind a single function signature.

### 3.1 Data flow

```
drop / pick files
      -> core/format.ts        sniff real type from magic bytes
      -> core/registry.ts      filter to tools accepting those types
      -> [user picks a tool, adjusts options]
      -> core/pipeline.ts      create Job, claim a worker from the pool
      -> runner.worker.ts      dynamic import() the op chunk, execute
                               (streams progress back over postMessage)
      -> outputs transferred back as ArrayBuffers
      -> core/fs.ts            single file -> direct download
                               multiple    -> zipped bundle download
```

### 3.2 The op contract

This is the whole plugin surface area:

```ts
export type OpInput  = { name: string; type: string; buffer: ArrayBuffer };
export type OpOutput = { name: string; type: string; buffer: ArrayBuffer };

export type OpContext = {
  onProgress(fraction: number): void;   // 0..1
  signal: AbortSignal;
};

export type Op = (
  inputs: OpInput[],
  options: Record<string, unknown>,
  ctx: OpContext,
) => Promise<OpOutput[]>;
```

Invariants an op must honour:

- Pure with respect to the DOM — an op must never touch `window` or `document`.
  It runs in a worker where they do not exist.
- Must call `ctx.onProgress` at least once per input processed.
- Must check `ctx.signal.aborted` between inputs and throw `Cancelled` if set.
- Must throw a typed error from §9 rather than a bare `Error`.
- Must not mutate its `inputs`.

Because ops are pure and DOM-free, they are unit-testable in plain Node under
vitest with fixture files — no browser harness required.

### 3.3 Module boundaries

```
src/
  types.ts                    DEPENDENCY-FREE: the op contract (§3.2), OptionSchema
                              (§7.4), ToolDef (§4), and OpError (§9). Imported by
                              core/ and tools/ alike; imports nothing itself.
  core/
    registry.ts               tool manifest: id, name, group, accepts, loader thunk
    pipeline.ts               run(toolId, files, options) -> Job { progress, result, cancel }
    format.ts                 magic-byte type sniffing + human-readable labels
    fs.ts                     file intake (drop/pick) and egress (download/zip-bundle)
    workers/
      pool.ts                 worker pool, transferables, cancellation, crash recovery
      runner.worker.ts        generic op host; imports and executes an op by id
  tools/
    pdf/     merge, split, organize, shrink, to-images, from-images
    image/   convert, resize, compress, crop, merge-sheet
    data/    zip-create, zip-extract, hash, base64, csv-json, json-format, qr
  ui/
    shell.ts                  layout, state, routing (hash-based)
    dropzone.ts               drag/drop + file picker surface
    filetray.ts               thumbnail tray with drag-to-reorder
    optionspanel.ts           renders a tool's option schema to controls
    progress.ts               progress ring + per-file status cards
    palette.ts                Cmd/Ctrl-K command palette
    motion.ts                 ALL anime.js usage; the single animation source of truth
  styles/
    tokens.css                colour / spacing / typography / motion tokens
    app.css
```

Rules that keep the boundaries honest:

- `registry.ts` holds **metadata and loader thunks only** — no logic, ever.
  It is a manifest. This is the file most likely to rot into a god-file, so the
  constraint is explicit and reviewable.
- `ui/` may import from `core/`. `core/` must never import from `ui/`.
- `tools/` may import **only** from `src/types.ts`, never from `core/` or `ui/`.
  An op receives everything else it needs as arguments. This keeps ops portable
  and independently testable. Enforced by an ESLint `no-restricted-imports` rule.
- `motion.ts` is the only module permitted to import `animejs`. Enforced by an
  ESLint `no-restricted-imports` rule.

### 3.4 Worker pool

- Size: `Math.max(1, Math.min(navigator.hardwareConcurrency ?? 4, 8) - 1)` —
  leaves one core for the main thread so animation stays smooth under load.
- Buffers move by **transfer**, not structured-clone copy, in both directions.
- A worker that dies (OOM on a very large file) is caught by the pool, removed,
  and replaced. The surrounding job reports a per-file failure; the app survives.
- `Job.cancel()` aborts via `AbortSignal`; if the worker does not yield promptly
  it is terminated and replaced.

## 4. Registry entry shape

```ts
export type ToolDef = {
  id: string;                        // 'pdf-merge'
  name: string;                      // 'Merge PDFs'
  blurb: string;                     // one line, shown on the card
  group: 'pdf' | 'image' | 'data';
  accepts: string[];                 // mime types or 'pdf' | 'image/*' | '*'
  minInputs: number;
  maxInputs: number | null;          // null = unbounded
  options?: OptionSchema;            // declarative; renders itself (§7.4)
  editor?: () => Promise<{ default: ToolEditor }>;   // escape hatch, see below
  load: () => Promise<{ default: Op }>;   // dynamic import, code-split by Vite
};
```

### 4.1 The `editor` escape hatch

Two v1 tools cannot express their input through a declarative `OptionSchema`,
because the user needs to manipulate the content visually:

- `pdf-organize` — a page-thumbnail grid with reorder, rotate, and delete
- `image-crop` — a draggable crop rectangle over a preview

Rather than distort `OptionSchema` to cover them, these tools supply an optional
`editor`: a lazily-loaded UI module that renders into the options area and whose
sole job is to produce the plain `options` object the op consumes. `pdf-organize`
yields `{ pages: [{ index, rotate, keep }] }`; `image-crop` yields
`{ x, y, width, height }`.

```ts
type ToolEditor = (
  mount: HTMLElement,
  inputs: File[],
  onChange: (options: Record<string, unknown>) => void,
) => () => void;   // returns a teardown function
```

The op stays pure and headless either way — the editor is only an options
producer, never a processor. Any tool without an `editor` uses the generic
schema-driven panel.

## 5. Tool inventory (v1)

### 5.1 PDF

**Removed 2026-08-30.** `pdf-extract-text` and the OCR tool that briefly
succeeded it were both dropped at the user's request as more machinery than the
project wants. Reading a text layer only ever helped PDFs that already contained
text; making it useful on scans meant carrying a ~3 MB OCR engine plus per-language
models. Sections below are left as written, for the record.
 — `pdf-lib` (write) + `pdfjs-dist` (render/text)

| id | Name | Behaviour |
|---|---|---|
| `pdf-merge` | Merge PDFs | Concatenate N PDFs in file-tray order |
| `pdf-split` | Split PDF | Into one file per page, or by page ranges (`1-3,7,9-`) |
| `pdf-organize` | Organize pages | Reorder, rotate, delete pages in one visual editor |
| `pdf-shrink` | Shrink PDF | Re-encode embedded raster images at reduced quality |
| `pdf-to-images` | PDF to images | Render each page to PNG or JPEG at chosen DPI |
| `pdf-from-images` | Images to PDF | Build a PDF from images; page size / fit options |

**Honesty note on `pdf-shrink`:** true client-side PDF compression is limited —
`pdf-lib` cannot resample embedded image streams as well as Ghostscript. The tool
is scoped to image downsampling and recompression, and **must be labelled
accordingly** in the UI ("Re-encodes images inside the PDF"). It must never claim
a compression ratio it cannot deliver, and must report actual before/after sizes.

### 5.2 Image — `OffscreenCanvas` + `createImageBitmap`

| id | Name | Behaviour |
|---|---|---|
| `image-convert` | Convert format | Between PNG / JPEG / WebP / AVIF |
| `image-resize` | Resize | By pixel dimensions or percentage; optional aspect lock |
| `image-compress` | Compress | Quality slider with a live output-size estimate |
| `image-crop` | Crop | Manual crop plus aspect-ratio presets |
| `image-merge-sheet` | Merge images | Contact sheet: grid, horizontal strip, or vertical strip |

Encoder availability for AVIF and WebP is **detected at runtime** via
`OffscreenCanvas.convertToBlob`; unsupported targets are disabled in the UI with
a reason shown, never offered and then failed.

### 5.3 Data and text — `fflate`, `SubtleCrypto`, `qrcode`

| id | Name | Behaviour |
|---|---|---|
| `zip-create` | Create ZIP | Bundle dropped files; streaming, with progress |
| `zip-extract` | Extract ZIP | Unpack; per-entry listing before extraction |
| `hash` | Hash files | SHA-1 / SHA-256 / SHA-512 via SubtleCrypto; MD5 via a small local impl |
| `base64` | Base64 | Encode or decode, direction toggle |
| `csv-json` | CSV to/from JSON | Both directions; delimiter and header detection |
| `json-format` | Format JSON | Pretty-print, minify, validate with error position |
| `qr-generate` | Generate QR | Text or URL to PNG or SVG |

## 6. Performance requirements

These are **CI-enforced budgets**, not aspirations. A build that exceeds them fails.

| Metric | Budget |
|---|---|
| Initial JS (shell + router + motion + registry), gzip | ≤ 40 KB |
| Initial CSS, gzip | ≤ 12 KB |
| Total transfer for first paint | ≤ 60 KB |
| Tool click to first progress tick (engine chunk cached) | < 150 ms |
| Main-thread long tasks during any op | none > 50 ms |

### 6.1 The seven mechanisms

1. **No framework runtime.** Vanilla TypeScript; direct DOM. Nothing competes
   with anime.js for ownership of nodes.
2. **Zero eager engine loading.** `pdf-lib` (~150 KB), `pdfjs-dist` (~350 KB),
   `fflate` (~8 KB) are reached only through `ToolDef.load()`, so Vite emits them
   as separate chunks fetched on first use.
3. **All work off the main thread.** Every op runs in a module worker.
4. **Zero-copy transfer** of `ArrayBuffer`s in and out of workers.
5. **Intent prefetch.** On `pointerenter` (and keyboard focus) of a tool card,
   inject `<link rel="modulepreload">` for that tool's chunk. The engine is warm
   before the click lands. This is the largest perceived-speed win in the design.
6. **Service worker** caches hashed lib chunks — second visit is instant, and the
   app works offline. Installable as a PWA.
7. **Composited animation only.** anime.js touches `transform` and `opacity`
   exclusively; `will-change` is applied on animation start and removed on
   completion. No animation reads layout.

## 7. UX specification

### 7.1 Drop first, choose second

The differentiating decision. Comparable tools require choosing an operation
before providing files. omnitool inverts this: files arrive first, and the tool
grid then shows **only the tools applicable to those files**. Dropping two PDFs
surfaces PDF tools; dropping PNGs surfaces image tools. This removes a decision
and a page load from every task.

### 7.2 One screen

No page navigation to change tools. A single canvas: a large dropzone that morphs
into the file tray plus the filtered tool grid. Selecting a tool expands its
options inline. Results appear in a tray beneath.

### 7.3 Components

- **Dropzone** — full-area drag target with a visible drop affordance; also a
  click-to-pick button, and paste-from-clipboard support.
- **File tray** — thumbnails with name, real detected type, and size.
  **Drag to reorder** (essential for merge, and where competing tools are
  weakest). Per-file remove.
- **Tool grid** — cards grouped by family, filtered by applicability. Inapplicable
  tools are hidden, not greyed, to keep the grid scannable.
- **Options panel** — generated from the tool's declarative `OptionSchema`.
- **Progress** — a ring driven by real `onProgress` values, plus per-file status.
- **Results tray** — outputs with size delta, individual download, and
  download-all as ZIP. Outputs whose type is textual (`hash`, `json-format`,
  `base64`) additionally render **inline with a copy button**,
  since forcing a download to read a checksum would be absurd.
- **Command palette** — `Cmd/Ctrl-K`, fuzzy tool search, Enter to run.

### 7.4 Option schema

Options are declared, not hand-built, so every tool's controls look and behave
identically:

```ts
type OptionSchema = Record<string,
  | { kind: 'select'; label: string; choices: { value: string; label: string }[]; default: string }
  | { kind: 'number'; label: string; min: number; max: number; step: number; default: number }
  | { kind: 'range';  label: string; min: number; max: number; step: number; default: number }
  | { kind: 'toggle'; label: string; default: boolean }
  | { kind: 'text';   label: string; placeholder?: string; default: string }
>;
```

### 7.5 Theme and accessibility

- Dark-first palette; follows `prefers-color-scheme`, with a manual override.
- `prefers-reduced-motion: reduce` disables every timeline in `motion.ts`;
  state changes become instant. Functionality must not depend on animation.
- Full keyboard operation: tab order, visible focus rings, palette shortcut.
- Drag-to-reorder has a keyboard equivalent (select an item, arrow keys to move).
- Progress and completion announced via an `aria-live` region.
- Contrast meets WCAG AA.

## 8. Animation specification (anime.js v4)

anime.js v4 is ESM and tree-shakeable; only the used functions ship. Every
animation is defined in `ui/motion.ts` with shared duration and easing tokens.

| Moment | Motion |
|---|---|
| Files dropped | Dropzone to file-tray FLIP morph, ~320 ms |
| Tool grid appears | Card stagger, ~24 ms offset, first paint of the grid only |
| Op running | Progress ring stroke driven by actual `onProgress` |
| Op complete | Outputs animate into the results tray |
| Drag reorder | Spring settle on drop |
| Palette open | Scale and fade, ~180 ms |

Motion has to justify itself: it shows where something came from or where it
went. Decorative motion is cut. Exact anime.js v4 API names are to be confirmed
against the installed version at implementation time.

## 9. Error handling

```ts
class OpError extends Error {
  constructor(public code: OpErrorCode, message: string, public file?: string) { super(message); }
}

type OpErrorCode =
  | 'UnsupportedFormat'   // not the type it claimed, or an unsupported variant
  | 'CorruptFile'         // parse failed
  | 'TooLarge'            // beyond what can be held in memory
  | 'EncoderUnavailable'  // e.g. AVIF encoding unsupported in this browser
  | 'InvalidOptions'      // e.g. an unparseable page range
  | 'Cancelled'
  | 'OutOfMemory';
```

Two rules that shape the whole design:

1. **Failure is per-file, not per-job.** Merging 20 PDFs where one is corrupt
   produces the merge of the 19 and a clear, specific flag on the one that
   failed. Partial success is reported as partial success — never silently
   truncated, and never reported as full success.
2. **A worker crash never kills the app.** The pool catches the death, replaces
   the worker, and the job reports which file caused it.

Every error message names the file and says what to do next. Errors surface as
cards in the results tray, not as alerts or console output.

## 10. Testing strategy

**Unit (vitest, Node)** — ops tested directly against real fixtures committed to
`tests/fixtures/`: a small valid PDF, a **deliberately corrupt PDF**, an
encrypted PDF, PNG / JPEG / WebP images, a valid ZIP, and a ZIP containing a
path-traversal entry name. Every op is tested for: happy path, corrupt input,
cancellation mid-run, and progress monotonicity.

**Integration (Playwright)** — three golden flows, run headless in CI:

1. drop two PDFs, merge, and assert the downloaded file has the combined page count
2. drop five PNGs, convert to WebP, download all, assert the ZIP holds five `.webp`
3. drop a ZIP, extract, assert the expected entries appear in the results tray

**Budget (CI)** — asserts the §6 byte ceilings against the built output and fails
the build on regression. This is the mechanism by which "extremely fast" remains
true after months of outside contributions.

**Security** — `zip-extract` must sanitise entry names against path traversal
(`../`, absolute paths) even though output goes through the download API; a
fixture test covers this.

## 11. Repository and tooling

```
package.json  tsconfig.json  vite.config.ts  vitest.config.ts
playwright.config.ts  eslint.config.js
index.html  LICENSE (MIT)  README.md  CONTRIBUTING.md
.github/workflows/ci.yml       typecheck + lint + unit + e2e + size budget
.github/workflows/deploy.yml   build + publish static site
src/  tests/  docs/
```

Runtime dependencies, deliberately few: `animejs`, `pdf-lib`, `pdfjs-dist`,
`fflate`, `qrcode`. Dev: `typescript`, `vite`, `vitest`, `@playwright/test`,
`eslint`.

`README.md` must contain an **"Add a tool in 20 lines"** section with a complete
worked example — the op file, the registry entry, and the test. Ease of
contribution is a product requirement, not documentation garnish.

## 12. Milestones

| # | Deliverable |
|---|---|
| M0 | Scaffold: Vite + TS + vitest + ESLint + CI with the size-budget gate |
| M1 | Kernel: `types`, `format`, `registry`, `pipeline`, `pool`, `runner.worker`, `fs`, plus `pdf-merge` working end-to-end under vitest — no UI |
| M2 | UI shell: dropzone, file tray with reorder, tool grid, schema-driven options panel, progress, results tray, `motion.ts` |
| M3 | Remaining PDF tools, including the `pdf-organize` editor (§4.1) |
| M4 | Image tools, including the `image-crop` editor (§4.1) |
| M5 | Data and text tools |
| M6 | Command palette, service worker / PWA, accessibility and reduced-motion pass |
| M7 | README, CONTRIBUTING, LICENSE, Playwright golden flows, deploy workflow |

M1 completing before M2 is deliberate: the kernel is proven headlessly with a
real tool before any UI is written.
