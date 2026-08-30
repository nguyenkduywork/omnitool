# omnitool

![CI](https://github.com/nguyenkduywork/omnitool/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)
![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6)

Everyday file tools — merge PDFs, convert and resize images, zip, hash, and
reformat data — that run entirely inside your browser tab.

**No file you open in omnitool ever leaves your device. There is no server.**
Every operation — merging, converting, hashing, zipping — runs in a Web Worker
on your own machine. omnitool makes zero network calls at runtime: no uploads,
no analytics, no telemetry, no CDN fetches. You could disconnect from the
internet after the page has loaded and every tool would keep working exactly
the same. Open your browser's network tab if you want to see for yourself — it
will stay empty.

Open source, MIT licensed.

## Contents

- [How it works](#how-it-works)
- [Getting around](#getting-around)
- [The tools](#the-tools)
- [Requirements](#requirements)
- [Getting started](#getting-started)
- [Scripts](#scripts)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Deployment](#deployment)
- [Known limitations (honest, on purpose)](#known-limitations-honest-on-purpose)
- [Contributing](#contributing)
- [Add a tool in 20 lines](#add-a-tool-in-20-lines)
- [License](#license)

## How it works

A **tool registry** plus a **Web Worker pipeline**. Drop files in; omnitool
sniffs their real type from magic bytes (never trusting a file extension);
the registry is filtered down to the tools that apply; you pick one and run
it in a worker, off the main thread. Results come back as real bytes you can
download individually or as a zip. Nothing about this shape depends on a
network round trip, which is exactly the point.

## Getting around

**Drop first, choose second.** Most tools of this kind make you pick an
operation and *then* hand over a file. omnitool inverts that: drop your files
and the tool grid narrows to what can actually run on them. Drop two PDFs and
you get PDF tools; drop PNGs and you get image tools.

- **Drag, paste, or pick.** Drop files anywhere in the window, paste with
  `Ctrl/Cmd+V`, or use the Choose files button.
- **Order matters for merging**, so the file tray is reorderable — drag a row,
  use its arrow buttons, or focus a row and press the arrow keys (`Home`/`End`
  jump to the ends, `Delete` removes). The buttons exist because drag needs a
  mouse and arrow keys need a keyboard, and a phone has neither.
- **`Ctrl/Cmd+K`** opens a command palette: type a few letters, press Enter,
  and the tool runs. If a tool can't apply to the files you have, the palette
  says why instead of failing silently.
- **Fully keyboard operable**, with visible focus rings, `aria-live`
  announcements for reordering and job progress, and WCAG AA contrast in both
  light and dark themes. This is covered by tests
  (`tests/e2e/a11y.spec.ts`), not just intent.
- **Respects `prefers-reduced-motion`** — every animation becomes an instant
  state change, and nothing functional depends on an animation finishing.

**Installable and offline.** A service worker precaches the app shell and
caches each tool's code chunk after first use, so a second visit is instant
and you can reload with the network off and keep working. Install it as an app
from your browser's address bar if you want it out of a tab.

## The tools

**PDF**
| Tool | What it does |
| --- | --- |
| Merge PDFs | Combine several PDFs into one, in file-tray order |
| Split PDF | One file per page, or by page range (`1-3,7,9-`) |
| Organize pages | Reorder, rotate, and delete pages on a visual page board |
| Shrink PDF | Re-encodes images inside the PDF; reports real before/after bytes |
| PDF to images | Rasterise every page to PNG or JPEG at a chosen DPI |
| Images to PDF | One image per page, in file-tray order |

**Images**
| Tool | What it does |
| --- | --- |
| Convert image | PNG, JPEG, WebP, or AVIF (see the AVIF note below) |
| Resize image | By exact dimensions or by percentage, with optional aspect lock |
| Compress image | Re-encode at a lower quality, same format |
| Crop image | Draw a crop box on a visual editor, in the image's own pixels |
| Rotate image | Turn in 90° steps, mirror left-to-right or top-to-bottom, with a live preview |
| Strip metadata | Remove EXIF, GPS, XMP and comments — without re-encoding |
| Merge into a sheet | Arrange several images into one contact sheet |

**Data & text**
| Tool | What it does |
| --- | --- |
| Create ZIP | Bundle the dropped files into one archive |
| Extract ZIP | Unpack every file from a ZIP archive |
| Create TAR | Bundle into one `.tar`, or a gzipped `.tar.gz` |
| Extract TAR | Unpack a `.tar` or `.tar.gz`, long names and pax included |
| Gzip | Compress to `.gz`, or decompress one back to bytes |
| Split file | Cut any file into fixed-size `.partNNN` pieces |
| Join file parts | Put the pieces back together, checking the sequence |
| Hash files | SHA-256, SHA-1, SHA-512, or MD5 |
| Base64 | Encode files to Base64 text, or decode back to bytes |
| CSV ⇄ JSON | Convert between CSV and JSON, with quoted-field and CRLF handling |
| Format JSON | Pretty-print or minify |
| Generate QR code | Turn text or a URL into a QR code, PNG or SVG |

## Requirements

**To use the app:** a current version of Chrome, Edge, Firefox, or Safari.
omnitool relies on standard, evergreen browser APIs — Web Workers,
`OffscreenCanvas`, `createImageBitmap`, and a service worker for the
installable/offline behaviour — and nothing beyond them; there's no
browser-specific code path. The CI suite runs the full app (unit, browser,
and end-to-end tests) against headless Chromium on every change, so that
combination is the most exhaustively verified.

**To build or develop it:** Node.js ≥ 20 (enforced by `package.json`'s
`engines` field) and npm.

## Getting started

```bash
git clone https://github.com/nguyenkduywork/omnitool.git
cd omnitool
npm install
npm run dev
```

Then open the printed local URL. There's no environment configuration, no
API keys, and no backend to stand up — the dev server is the entire stack.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the local dev server (Vite) |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | `tsc --noEmit`, strict mode |
| `npm run lint` | ESLint, including the import-boundary rules in [CONTRIBUTING.md](./CONTRIBUTING.md) |
| `npm run test` | Vitest — unit tests plus headless-Chromium browser tests |
| `npm run test:e2e` | Playwright, against a real production build |
| `npm run contrast` | Recomputes every ink/surface colour pairing in `src/styles/tokens.css` against WCAG AA, in both themes |
| `npm run size` | Verifies the CI-enforced initial-load size budget (see [CONTRIBUTING.md](./CONTRIBUTING.md)) |
| `npm run make-fixtures` | Regenerates the committed binary test fixtures in `tests/fixtures/` |

Before opening a PR, run the same gate CI runs:

```bash
npm run typecheck && npm run lint && npm run test && npm run build && npm run size && npm run test:e2e
```

## Project structure

```
src/
  types.ts          # the whole contract: Op, OpInput/Output, OpError, ToolDef — dependency-free
  core/              # registry, Web Worker pipeline, pool — never imports from ui/
  tools/
    pdf/             # one *.op.ts (+ optional *.editor.ts) per tool, DOM-free, pure functions
    image/
    data/
  ui/                # DOM, dropzone, results tray, command palette, animation — never runs in a worker
  styles/            # design tokens (tokens.css) + component styles (app.css)
tests/
  unit/              # vitest — plain Node for pure ops, headless Chromium for canvas/OffscreenCanvas ops
  e2e/               # Playwright, against a production build
  fixtures/          # real, format-valid binary fixtures (see make-fixtures.mjs) — never placeholders
docs/superpowers/     # the original design spec and implementation plan this app was built from
```

The dependency direction is strict and lint-enforced: `ui/` → `core/` →
`types.ts`, and `tools/**` imports only `types.ts` and its own npm
dependencies — never `core/` or `ui/`. That's what makes "copy one file, add
one registry line" a true description of adding a tool; see
[Add a tool in 20 lines](#add-a-tool-in-20-lines).

## Testing

Every op ships with the **four-test rule** from
[CONTRIBUTING.md](./CONTRIBUTING.md#2-the-four-test-rule): a happy path, a
typed error (a real `OpErrorCode`, never a bare `Error`), cancellation via
`AbortSignal`, and monotonic progress ending at exactly `1`. Ops that touch
`OffscreenCanvas`, `createImageBitmap`, or `convertToBlob` run under a
headless-Chromium Vitest project (`*.browser.test.ts`) since those APIs
don't exist in plain Node; everything else runs fast under Node.

End-to-end coverage (`tests/e2e/`) drives a real production build with
Playwright: golden flows for each tool family, the accessibility suite
(keyboard-only operation, focus visibility, `aria-live` announcements), and
the bespoke visual editors (PDF page board, image crop, rotate preview).

## Deployment

CI (`.github/workflows/ci.yml`) runs on every push and pull request:
typecheck, lint, colour-contrast check, unit/browser tests, production
build, size-budget check, and the full e2e suite.

Publishing to GitHub Pages (`.github/workflows/deploy.yml`) is
**manually triggered** (Actions → Deploy → Run workflow), not automatic on
push. GitHub Pages isn't available for a private repository below
GitHub Pro/Team/Enterprise, so this is intentional rather than a leftover —
run it by hand once the repo is public or on a plan that supports private
Pages.

## Known limitations (honest, on purpose)

- **AVIF encoding does not actually work in any browser today.** Canvas's
  `convertToBlob({ type: 'image/avif' })` doesn't throw for an unsupported
  encoder — it silently hands back a PNG instead. omnitool probes the real
  encoder at runtime (attempts a tiny encode and checks the blob's *actual*
  type against what was requested) and disables the AVIF option in the UI,
  with the reason shown, rather than ever labelling a PNG's bytes `.avif`.
  `'avif'` stays in the option schema because the probe makes offering it
  safe — it just comes back disabled in every browser we've tested. Genuine
  AVIF output needs a WASM encoder (e.g. `@jsquash/avif`), which is a
  deliberate v2 cut, not an oversight.
- **"Shrink PDF" re-encodes images inside the PDF — it is not general-purpose
  PDF compression.** It targets DCTDecode (JPEG) image XObjects that are
  8-bit RGB or grayscale. JPEG 2000, CCITT, JBIG2, CMYK images, and stencil
  masks are left untouched. If a PDF's size is dominated by fonts, vector
  content, or one of those untouched formats, don't expect this tool to move
  the needle — and it will never claim a reduction it didn't actually
  achieve: if the re-encoded output would be larger than the original, it
  returns the original unchanged and says so.
- **Rotating a JPEG re-encodes it.** A quarter turn through canvas decodes
  the picture to pixels and encodes them again, so it costs a little quality;
  the tool's quality slider is what that costs you, and PNG output ignores it
  because PNG is lossless either way. A genuinely lossless 90° JPEG rotate
  means transposing DCT coefficient blocks (what `jpegtran` does), which needs
  a JPEG codec omnitool does not carry. Rotating by 0 with no mirror hands
  back the original bytes rather than re-encoding for nothing. The tool's live
  preview is a claim about **orientation only** — it never re-encodes, so it
  cannot show you what the quality slider costs, and it says so rather than
  implying the result will look pixel-for-pixel like the preview.
- **"Strip metadata" covers JPEG, PNG and WebP, and nothing else.** Those are
  the containers whose metadata can be cut out without touching a pixel: it
  removes JPEG APP1/APP3-13/APP15 and COM segments, PNG `tEXt`/`zTXt`/`iTXt`/
  `eXIf`/`tIME` chunks, and WebP `EXIF`/`XMP ` chunks (clearing the VP8X flag
  bits that announced them). Anything else — GIF, AVIF, TIFF — is refused by
  name rather than quietly re-encoded, and the ICC colour profile is kept
  unless you ask for it too, because dropping it can change how the image
  looks. Every run writes a `metadata-report.txt` saying what came out of
  which file.
- **A batch with a bad file costs a re-run.** The op contract has no channel
  for an op to report "this one input failed, keep going" — its only way to
  signal a failure is to throw, naming the file. So when one input in a
  batch is bad, the worker drops it and **re-runs the whole op** on what's
  left, to still report the good outputs honestly instead of failing the
  whole batch. This is correct (a partial success is reported as partial,
  and an all-bad batch rejects rather than lying) and terminating (the
  remaining set shrinks every pass), but it isn't free: cost is roughly
  `(bad_files + 1) × full work`. Worst case is a few bad inputs positioned
  late — 50 images with the last 2 corrupt does about 3× the necessary work.
  Fixing this properly means letting an op return per-input outcomes instead
  of throwing, which touches every tool and is deliberately deferred to v2
  rather than made as a mid-flight change to a frozen contract.
- **Splitting a file gives you pieces, not documents.** Part 1 of a PDF is not
  a PDF; the parts are plain byte slices and only mean something once Join
  file parts puts them back. Join refuses parts that are out of sequence
  rather than producing a silently corrupt file.
- Audio/video conversion, OCR, and Office formats (`.docx`/`.xlsx`/`.pptx`)
  are out of scope — see the design spec's non-goals. Reading a PDF's text
  layer was tried and removed too: it only ever worked on PDFs that already
  contained text, and making it useful on scans meant carrying an OCR engine,
  which is more machinery than this project wants.

## Contributing

Contributions are welcome. Before sending a PR, read
[CONTRIBUTING.md](./CONTRIBUTING.md) — it covers the three things that are
mechanically enforced (import boundaries, the four-test rule, and the size
budget) rather than left to reviewer taste, plus the commands CI runs so you
can catch a failure locally first. Commit messages follow
[Conventional Commits](https://www.conventionalcommits.org/).

## Add a tool in 20 lines

Every tool is one function behind the same signature — no framework hooks,
no base class to extend. Here is a genuinely new one, start to finish. It
reverses the characters in a text file.

**1. The op** — `src/tools/data/text-reverse.op.ts`. This is the *entire*
file; it only imports from `src/types.ts`, per the import rules in
CONTRIBUTING.md.

```ts
import { OpError, type Op, type OpOutput } from '../../types';

const textReverse: Op = async (inputs, _options, ctx) => {
  if (inputs.length === 0) {
    throw new OpError('InvalidOptions', 'text-reverse needs at least one file');
  }

  const outputs: OpOutput[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    if (ctx.signal.aborted) throw new OpError('Cancelled', 'Cancelled');

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input.buffer);
    } catch {
      throw new OpError('CorruptFile', `${input.name} is not valid UTF-8 text`, input.name);
    }

    const reversed = [...text].reverse().join('');
    outputs.push({ name: input.name, type: 'text/plain', buffer: new TextEncoder().encode(reversed).buffer });
    ctx.onProgress((i + 1) / inputs.length);
  }
  return outputs;
};

export default textReverse;
```

**2. The registry entry** — one object appended to `PDF_TOOLS`'s sibling
array for its group, `src/core/registry.data.ts` (see §5 of the
implementation plan for why each tool group owns its own registry module):

```ts
{
  id: 'text-reverse',
  name: 'Reverse text',
  blurb: 'Reverse the characters in a text file.',
  group: 'data',
  accepts: ['text/plain', 'text/csv', 'application/json'],
  minInputs: 1,
  maxInputs: null,
  load: () => import('../tools/data/text-reverse.op'),
},
```

**3. The loader-map line** — one entry in `DATA_LOADERS`, in
`src/core/workers/loaders.data.ts`, so the worker can resolve the tool id to
the op:

```ts
'text-reverse': () => import('../../tools/data/text-reverse.op'),
```

**4. The test** — `tests/unit/data.test.ts` (or its own file), covering the
four cases every op needs per CONTRIBUTING.md: happy path, a typed error,
cancellation, and progress.

```ts
import { describe, expect, it } from 'vitest';
import textReverse from '../../src/tools/data/text-reverse.op';
import type { OpContext } from '../../src/types';

function input(name: string, text: string) {
  return { name, type: 'text/plain', buffer: new TextEncoder().encode(text).buffer };
}
function ctx(signal: AbortSignal = new AbortController().signal) {
  const seen: number[] = [];
  return { seen, ctx: { onProgress: (f: number) => seen.push(f), signal } satisfies OpContext };
}

describe('text-reverse', () => {
  it('reverses the characters of a text file', async () => {
    const [out] = await textReverse([input('a.txt', 'abc')], {}, ctx().ctx);
    expect(new TextDecoder().decode(out!.buffer)).toBe('cba');
  });

  it('raises CorruptFile on invalid UTF-8', async () => {
    const bad = { name: 'bad.txt', type: 'text/plain', buffer: new Uint8Array([0xff, 0xfe, 0xfd]).buffer };
    await expect(textReverse([bad], {}, ctx().ctx)).rejects.toMatchObject({ code: 'CorruptFile' });
  });

  it('raises Cancelled when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      textReverse([input('a.txt', 'abc')], {}, ctx(controller.signal).ctx),
    ).rejects.toMatchObject({ code: 'Cancelled' });
  });

  it('reports monotonic progress ending at 1', async () => {
    const { ctx: c, seen } = ctx();
    await textReverse([input('a.txt', 'ab'), input('b.txt', 'cd')], {}, c);
    expect(seen).toEqual([0.5, 1]);
  });
});
```

That's it — no router, no manual chunk config, nothing else to wire up. Vite
code-splits the op into its own lazily-loaded chunk automatically, and the
tool appears in the UI for exactly the file types listed in `accepts` the
moment its registry entry exists.

*(This example is compile-verified against the real, current
`src/types.ts` contract and actually executes correctly — see
CONTRIBUTING.md if you want to check it yourself; it isn't shipped as a real
tool here, to keep this README's example self-contained and out of the way
of the actual registry.)*

## License

MIT — see [LICENSE](./LICENSE).
