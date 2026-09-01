# omnitool

![CI](https://github.com/nguyenkduywork/omnitool/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)
![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6)

Everyday file tools — merge PDFs, convert and resize images, zip, hash, and reformat
data — that run entirely inside your browser tab.

**No file you open ever leaves your device.** There is no server. Every operation runs
in a Web Worker on your own machine, and the app makes no network calls at runtime: no
uploads, no analytics, no telemetry, no CDN fetches. Open your browser's network tab
and it stays empty. Disconnect from the internet after the page loads and every tool
keeps working.

## Use it online

**<https://nguyenkduywork.github.io/omnitool/>**

Nothing to install and nothing to sign up for. Open the page and drop a file on it.

- **Install it as an app.** A service worker precaches the app shell, so your browser
  will offer to install omnitool from the address bar. Once installed it runs in its
  own window and works offline.
- **It works offline after the first visit.** Tool code is cached the first time you
  use each tool; a reload with the network off keeps working.
- **Every tool has its own address.** `…/#/pdf-merge` is bookmarkable and shareable,
  and the back button moves between a tool and the catalogue. Files are never in the
  URL, so a link you share opens the tool empty — it can never carry your data.

## Using it

Two ways in, both first-class:

- **Drop files first.** Drag them anywhere in the window, paste with `Ctrl/Cmd+V`, or
  use Choose files. The tool list narrows to what can actually run on them.
- **Pick a tool first.** Choose from the catalogue and bring the files after — the tool
  tells you what it needs rather than refusing. Tools that need no files at all, like
  the QR code generator, just open and run.

`Ctrl/Cmd+K` searches the tools. The file tray is reorderable, which matters for
merging — drag a row, use its arrow buttons, or focus a row and press the arrow keys.

Fully keyboard operable, with visible focus rings, `aria-live` announcements, and WCAG
AA contrast in both light and dark themes — covered by tests, not just intent.

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
| Clean PDF metadata | Strip the author, dates, and XMP a PDF carries — without touching a page |
| Extract images | Pull the pictures embedded in a PDF back out as image files |

**Images**
| Tool | What it does |
| --- | --- |
| Convert image | PNG, JPEG, WebP, or AVIF (see Limitations) |
| Resize image | By exact dimensions or by percentage, with optional aspect lock |
| Compress image | Re-encode at a lower quality, same format |
| Crop image | Draw a crop box on a visual editor, in the image's own pixels |
| Rotate image | Turn in 90° steps, mirror left-to-right or top-to-bottom, with a live preview |
| Strip metadata | Remove EXIF, GPS, XMP and comments — without re-encoding |
| Merge into a sheet | Arrange several images into one contact sheet |
| Watermark image | Stamp a line of text over an image, in a corner or tiled diagonally |

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
| Clean up text | Sort, deduplicate, trim, and normalise the lines of a text file |

## Run it locally

**Prerequisites:** [Node.js](https://nodejs.org) 20 or newer, and npm. Nothing else —
no database, no API keys, no environment configuration.

```bash
git clone https://github.com/nguyenkduywork/omnitool.git
cd omnitool
npm install
npm run dev
```

Then open the URL it prints (`http://localhost:5173` by default).

To check a production build instead:

```bash
npm run build
npm run preview
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the dev server with hot reload |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run typecheck` | `tsc --noEmit`, strict mode |
| `npm run lint` | ESLint, including the import-boundary rules |
| `npm test` | Unit tests — Node plus headless Chromium |
| `npm run test:e2e` | Playwright, against a real production build |
| `npm run contrast` | Check every colour pairing against WCAG AA, both themes |
| `npm run size` | Verify the initial-load size budget |
| `npm run bench` | Re-run the performance measurements |
| `npm run make-fixtures` | Regenerate the binary test fixtures |

Before opening a pull request, run the same gate CI runs:

```bash
npm run typecheck && npm run lint && npm test && npm run build && npm run size && npm run test:e2e
```

Playwright needs its browsers once: `npx playwright install --with-deps chromium`.

## Requirements

A current version of Chrome, Edge, Firefox, or Safari. omnitool uses standard evergreen
browser APIs — Web Workers, `OffscreenCanvas`, `createImageBitmap`, and a service worker
— with no browser-specific code paths. CI runs the full suite against headless Chromium
on every change, so that combination is the most exhaustively verified.

## Limitations

Behaviour worth knowing before you rely on it. See [docs/known-issues.md](docs/known-issues.md)
for open engineering items.

- **AVIF export does not work in any browser today.** Canvas silently returns a PNG
  when asked for AVIF, so omnitool probes the real encoder at startup and disables the
  option with the reason shown, rather than handing you PNG bytes named `.avif`.
- **Shrink PDF re-encodes images, and only some of them.** It targets 8-bit RGB and
  grayscale JPEG images inside the PDF. JPEG 2000, CCITT, JBIG2, CMYK and stencil masks
  are left alone, so a PDF dominated by fonts or vectors will barely move. It never
  claims a reduction it did not achieve — if the result would be larger, you get the
  original back.
- **Resize, Compress, Crop, Rotate and Watermark re-encode the image.** A quarter turn
  costs a little quality, and the quality slider is what it costs; PNG output ignores it
  because PNG is lossless. Formats the browser can decode but not encode — GIF, BMP,
  TIFF, SVG — come back as PNG, and the filename changes with them.
- **Strip metadata covers JPEG, PNG and WebP only.** Those are the containers whose
  metadata can be cut without touching a pixel. Anything else is refused by name rather
  than quietly re-encoded. The ICC colour profile is kept unless you ask for it too.
- **Clean PDF metadata is not redaction.** It empties the document's Info dictionary and
  purges XMP, then sweeps what it unlinked. It does not touch page content: text, images
  and their EXIF, annotations, form values, attachments and bookmarks all survive. A PDF
  with your name printed on page one still has your name on page one.
- **A watermark is a label, not a lock.** It paints text into the pixels, so it can be
  cropped off or painted over. It marks provenance, it does not protect anything.
- **Clean up text sorts in code-unit order, not your locale's** — uppercase before
  lowercase, digits before letters, like `sort` under `LC_ALL=C`. It reads UTF-8 only.
- **Extract images gets the pictures out, not every picture.** JPEG streams come out
  byte for byte and raw pixels are wrapped losslessly in PNG. JPEG 2000, fax formats,
  indexed palettes, stencil masks and predictor-encoded data are skipped and named in
  the report with the reason.
- **A batch with one bad file costs a re-run.** An op can only signal failure by
  throwing, so the worker drops the bad input and re-runs on what is left in order to
  report the good outputs honestly. Cost is roughly `(bad files + 1) ×` the work.

## Deployment

CI runs on every push and pull request: typecheck, lint, colour contrast, unit and
browser tests, production build, size budget, and the full end-to-end suite.

Publishing to GitHub Pages is a manual trigger — **Actions → Deploy → Run workflow**.
`vite.config.ts` sets `base: './'`, so the build is host-agnostic and Pages serves
`dist/` as-is.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the import-boundary rules, the per-tool
test requirements, the size budget, and how performance claims are measured.

## License

MIT — see [LICENSE](./LICENSE).
