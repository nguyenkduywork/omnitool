# omnitool

Everyday file tools — merge PDFs, convert and resize images, zip, hash, and
reformat data — that run entirely inside your browser tab.

**No file you open in omnitool ever leaves your device. There is no server.**
Every operation — merging, converting, hashing, zipping, OCR — runs in a Web
Worker on your own machine, and none of it is ever sent anywhere: no
uploads, no analytics, no telemetry, no CDN fetches of anything that touches
your files.

One honest qualification, and only one: **Scan to text (OCR)** runs on a
real OCR engine that has to come from somewhere. The first time you use it,
the engine and the specific language you pick are fetched once, from this
same site — never a third party — and cached in your browser; every later
run of OCR, in that language, works offline. That download carries none of
your data outward, in either direction: fetching a static model uploads
nothing. Every OTHER tool needs no download, ever, and works from the
moment the page has first loaded — you could disconnect from the internet
right now and merge PDFs, convert images, zip, hash, and reformat data with
it staying that way. Open your browser's network tab if you want to see for
yourself: it stays empty for everything except that one OCR download, once,
per language.

Open source, MIT licensed.

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
and you can reload with the network off and keep working. OCR's engine and
language packs are cached the same way, the first time each is actually
used — after that, OCR works offline too. Install it as an app from your
browser's address bar if you want it out of a tab.

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
| Extract text | Pull out the PDF's text layer as a `.txt` file |

**Images**
| Tool | What it does |
| --- | --- |
| Convert image | PNG, JPEG, WebP, or AVIF (see the AVIF note below) |
| Resize image | By exact dimensions or by percentage, with optional aspect lock |
| Compress image | Re-encode at a lower quality, same format |
| Crop image | Draw a crop box on a visual editor, in the image's own pixels |
| Merge into a sheet | Arrange several images into one contact sheet |

**Data & text**
| Tool | What it does |
| --- | --- |
| Create ZIP | Bundle the dropped files into one archive |
| Extract ZIP | Unpack every file from a ZIP archive |
| Hash files | SHA-256, SHA-1, SHA-512, or MD5 |
| Base64 | Encode files to Base64 text, or decode back to bytes |
| CSV ⇄ JSON | Convert between CSV and JSON, with quoted-field and CRLF handling |
| Format JSON | Pretty-print or minify |
| Generate QR code | Turn text or a URL into a QR code, PNG or SVG |
| Scan to text (OCR) | Read text from scanned PDFs and photos, in 15 languages |

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
- **OCR reports its own confidence, honestly.** tesseract.js scores every
  page it recognises from 0-100. Below a threshold, the output is prefixed
  with a plain-language warning naming the likely cause (usually a low-
  resolution, skewed, or oddly patterned source) instead of handing back
  garbled text dressed up as clean output. Accuracy also depends heavily on
  input resolution — for scanned PDFs, the DPI option controls this
  directly; a low DPI on a small font is the most common cause of a low
  score.
- **OCR is the one tool with a real, one-time network dependency.** The
  engine and each language are same-origin downloads (§ above), never a
  third party — but until a language has been fetched once, that language
  cannot run offline. Every other tool has no such dependency, ever.
- Audio/video conversion and Office formats (`.docx`/`.xlsx`/`.pptx`) are
  out of scope for v1 — see the design spec's non-goals. (OCR was originally
  on that list too; it shipped after all — see `src/tools/data/ocr.op.ts`.)

## Running it

Requires Node ≥ 20.

```bash
npm install
npm run dev        # local dev server
npm run build       # production build to dist/
npm run preview     # serve the production build locally
```

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run test         # vitest (unit + headless-Chromium browser tests)
npm run test:e2e     # playwright, against a production build
npm run size         # verify the CI-enforced size budget (see CONTRIBUTING.md)
```

Deployment is automatic: pushing to `main` builds and publishes to GitHub
Pages via `.github/workflows/deploy.yml`.

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
