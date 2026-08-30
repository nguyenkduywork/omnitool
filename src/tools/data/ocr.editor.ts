// src/tools/data/ocr.editor.ts — bespoke options editor for the `ocr` tool.
//
// Implements ToolEditor from src/types.ts exactly: (mount, inputs, onChange)
// => teardown, emitting { languages, pages, dpi } — the same option names
// ocr.op.ts validates, so registry.data.ts's declarative schema stays the
// working fallback if this editor is ever bypassed.
//
// WHY THIS TOOL NEEDS A BESPOKE EDITOR
//
// The flat schema cannot:
//   1. Offer a MULTI-select of languages with each one's REAL download size —
//      that number lives in a generated manifest (scripts/vendor-ocr.mjs's
//      output, /ocr/languages.json), not in any static schema definition.
//   2. Show a running total of what the CURRENT selection will actually
//      download, which depends on which of those languages are already
//      cached from a previous run.
//   3. Validate a page range against a real page count, for PDF inputs.
//   4. Say up front, honestly, that a first use downloads real bytes over
//      the network — same-origin, once, cached thereafter — before the user
//      commits to it (this project's one qualification to "no file leaves
//      the device": nothing OF THE USER'S ever does, but the OCR ENGINE
//      itself has to arrive from somewhere the first time it runs).
//
// Cache detection is best-effort: it reads src/sw.ts's own runtime cache
// (Cache Storage, not tesseract.js's separate IndexedDB cache — reaching
// into that would mean depending on tesseract's internal cache-key format,
// which is not part of its public contract). The cache name string below
// MUST match RUNTIME_CACHE in src/sw.ts.

import type { ToolEditor } from '../../types';

import './ocr.editor.css';
import { DEFAULT_OCR_LANGUAGE, OCR_LANGUAGES } from './ocr-languages';

type Manifest = {
  languages: { code: string; name: string; bytes: number }[];
  core: { simd: { file: string; bytes: number }; fallback: { file: string; bytes: number } };
  worker: { file: string; bytes: number };
};

// Duplicated from src/sw.ts's own constant — see that file. Editors cannot
// import a worker/service-worker module, so this is a documented literal,
// not a shared import.
const RUNTIME_CACHE_NAME = 'omnitool-runtime';

function ocrAssetUrl(file: string): string {
  return new URL(`ocr/${file}`, document.baseURI).href;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] ?? 'GB'}`;
}

/** Best-effort: is this exact URL already sitting in the runtime cache? */
async function isCached(url: string): Promise<boolean> {
  try {
    if (typeof caches === 'undefined') return false;
    const cache = await caches.open(RUNTIME_CACHE_NAME);
    return (await cache.match(url)) !== undefined;
  } catch {
    return false;
  }
}

type PdfjsModule = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfjsModule> | null = null;
async function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= (async (): Promise<PdfjsModule> => {
    const workerModule = await import('pdfjs-dist/build/pdf.worker.mjs');
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = workerModule;
    return import('pdfjs-dist');
  })();
  return pdfjsPromise;
}

async function loadManifest(): Promise<Manifest | null> {
  try {
    const res = await fetch(ocrAssetUrl('languages.json'));
    if (!res.ok) return null;
    return (await res.json()) as Manifest;
  } catch {
    return null;
  }
}

const editor: ToolEditor = (mount, inputs, onChange) => {
  const doc = mount.ownerDocument;
  let disposed = false;

  const selected = new Set<string>([DEFAULT_OCR_LANGUAGE]);
  let pagesSpec = '';
  let dpi = 300;

  /** Real byte sizes from the generated manifest, once loaded. */
  let sizeByCode = new Map<string, number>();
  /** Best-effort cache status, refreshed whenever the selection changes. */
  let cachedByCode = new Map<string, boolean>();

  /** Page count of the first PDF among the dropped files, if any. */
  let pageCount: number | null = null;
  let hasPdf = false;
  let sawNonPdfImage = false;

  mount.replaceChildren();
  const root = doc.createElement('div');
  root.className = 'ocru';

  function row(labelText: string): { row: HTMLElement; controls: HTMLElement } {
    const wrap = doc.createElement('div');
    wrap.className = 'ocru__row';
    const label = doc.createElement('span');
    label.className = 'ocru__label';
    label.textContent = labelText;
    const controls = doc.createElement('div');
    controls.className = 'ocru__controls';
    wrap.append(label, controls);
    return { row: wrap, controls };
  }

  // ------------------------------------------------------- download notice

  const notice = doc.createElement('p');
  notice.className = 'ocru__notice';
  notice.append(
    Object.assign(doc.createElement('b'), { textContent: 'One-time download: ' }),
    doc.createTextNode(
      'the OCR engine and each language you pick are fetched from this site the first time ' +
        'you use them (same origin — nothing of yours is ever sent anywhere). After that, they ' +
        'are cached in your browser and further runs work offline.',
    ),
  );

  // ------------------------------------------------------------ languages

  const langRow = row('Languages');
  const langList = doc.createElement('div');
  langList.className = 'ocru__langs';
  langList.setAttribute('role', 'group');
  langList.setAttribute('aria-label', 'OCR languages');

  const checkboxes = new Map<string, HTMLInputElement>();
  const sizeLabels = new Map<string, HTMLElement>();

  for (const lang of OCR_LANGUAGES) {
    const item = doc.createElement('label');
    item.className = 'ocru__lang';

    const checkbox = doc.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selected.has(lang.code);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(lang.code);
      else selected.delete(lang.code);
      void refreshCacheStatus().then(sync);
    });
    checkboxes.set(lang.code, checkbox);

    const name = doc.createElement('span');
    name.className = 'ocru__lang-name';
    name.textContent = lang.name;

    const size = doc.createElement('span');
    size.className = 'ocru__lang-size';
    size.textContent = '…';
    sizeLabels.set(lang.code, size);

    item.append(checkbox, name, size);
    langList.append(item);
  }
  langRow.controls.append(langList);

  // ------------------------------------------------------------- page range

  const pagesRow = row('Pages (PDF only)');
  const pagesInput = doc.createElement('input');
  pagesInput.type = 'text';
  pagesInput.className = 'ocru__text';
  pagesInput.placeholder = 'all pages';
  pagesInput.setAttribute('aria-label', 'Pages to scan');
  const pagesHint = doc.createElement('p');
  pagesHint.className = 'ocru__hint';
  pagesRow.controls.append(pagesInput, pagesHint);
  pagesInput.addEventListener('input', () => {
    pagesSpec = pagesInput.value;
    sync();
  });

  // -------------------------------------------------------------- resolution

  const dpiRow = row('Resolution (DPI)');
  const dpiInput = doc.createElement('input');
  dpiInput.type = 'number';
  dpiInput.className = 'ocru__num';
  dpiInput.min = '72';
  dpiInput.max = '600';
  dpiInput.step = '1';
  dpiInput.value = String(dpi);
  dpiInput.setAttribute('aria-label', 'Resolution in DPI, for PDF pages');
  const dpiHint = doc.createElement('span');
  dpiHint.className = 'ocru__value';
  dpiHint.textContent = 'Higher = more accurate, slower (PDF pages only)';
  dpiRow.controls.append(dpiInput, dpiHint);
  dpiInput.addEventListener('input', () => {
    const next = Number(dpiInput.value);
    dpi = Number.isFinite(next) ? Math.max(72, Math.min(600, Math.round(next))) : 300;
    sync();
  });

  // ---------------------------------------------------------------- summary

  const summary = doc.createElement('p');
  summary.className = 'ocru__summary';
  summary.setAttribute('role', 'status');
  summary.textContent = 'Reading the dropped files…';

  root.append(notice, langRow.row, pagesRow.row, dpiRow.row, summary);
  mount.append(root);

  // ------------------------------------------------------------------- sync

  function selection(): { count: number; error: string | null } {
    if (!hasPdf) return { count: 0, error: null };
    if (pageCount === null) return { count: 0, error: null };
    if (pagesSpec.trim() === '') return { count: pageCount, error: null };
    // Lazily import so a page-range typo doesn't force pdf-lib-adjacent code
    // into this editor's own chunk before it's needed.
    return parsePagesSafely(pagesSpec, pageCount);
  }

  function parsePagesSafely(spec: string, count: number): { count: number; error: string | null } {
    // parsePageRanges lives in ../pdf/page-range.ts, imported lazily below
    // via cachedParseRanges so a malformed spec never throws synchronously
    // during typing.
    if (cachedParser === null) return { count: 0, error: null };
    try {
      const groups = cachedParser(spec, count);
      const unique = new Set(groups.flatMap((g) => g.pages));
      return { count: unique.size, error: null };
    } catch (err) {
      return { count: 0, error: err instanceof Error ? err.message : 'Invalid page range' };
    }
  }

  type ParseRanges = (spec: string, pageCount: number) => { pages: number[] }[];
  let cachedParser: ParseRanges | null = null;
  void import('../pdf/page-range').then((mod) => {
    cachedParser = mod.parsePageRanges;
    sync();
  });

  async function refreshCacheStatus(): Promise<void> {
    const entries = await Promise.all(
      [...selected].map(async (code) => {
        const url = ocrAssetUrl(`lang-data/${code}.traineddata.gz`);
        return [code, await isCached(url)] as const;
      }),
    );
    cachedByCode = new Map(entries);
  }

  function sync(): void {
    if (disposed) return;

    for (const lang of OCR_LANGUAGES) {
      const bytes = sizeByCode.get(lang.code);
      const label = sizeLabels.get(lang.code);
      if (!label) continue;
      const cached = cachedByCode.get(lang.code) === true;
      label.textContent = bytes === undefined ? '…' : `${formatBytes(bytes)}${cached ? ' · cached' : ''}`;
      label.classList.toggle('ocru__lang-size--cached', cached);
    }

    const { count, error } = selection();
    pagesRow.row.hidden = !hasPdf;
    pagesInput.setAttribute('aria-invalid', String(error !== null));
    pagesHint.classList.toggle('ocru__hint--error', error !== null);
    pagesHint.textContent =
      error ??
      (hasPdf && pageCount !== null
        ? `Leave empty for all ${pageCount} pages, or try 1-3,7,9- for a selection.`
        : '');
    dpiRow.row.hidden = !hasPdf;

    const toDownload = [...selected].filter((code) => cachedByCode.get(code) !== true);
    const downloadBytes = toDownload.reduce((sum, code) => sum + (sizeByCode.get(code) ?? 0), 0);

    summary.replaceChildren();
    if (error !== null) {
      summary.append(Object.assign(doc.createElement('span'), { className: 'ocru__warn', textContent: error }));
    } else if (selected.size === 0) {
      summary.append(
        Object.assign(doc.createElement('span'), { className: 'ocru__warn', textContent: 'Pick at least one language.' }),
      );
    } else {
      const b = (text: string): HTMLElement => Object.assign(doc.createElement('b'), { textContent: text });
      const langNames = OCR_LANGUAGES.filter((l) => selected.has(l.code))
        .map((l) => l.name)
        .join(' + ');
      const parts: (string | HTMLElement)[] = [];

      if (hasPdf && count > 0) {
        const pageWord = count === 1 ? 'page' : 'pages';
        parts.push(b(String(count)), ` ${pageWord}`, sawNonPdfImage ? ' plus the photo(s) dropped' : '', ' · ');
      } else if (sawNonPdfImage) {
        parts.push('the dropped photo(s) · ');
      }
      parts.push('reading in ', b(langNames || '(none)'), '.');
      if (downloadBytes > 0) {
        parts.push(' ', b(formatBytes(downloadBytes)), ' will download first (one time).');
      } else if (toDownload.length === 0 && selected.size > 0 && sizeByCode.size > 0) {
        parts.push(' Already cached — nothing to download.');
      }
      summary.append(...parts);
    }

    onChange({ languages: [...selected].join('+'), pages: pagesSpec, dpi });
  }

  sync();

  // ---------------------------------------------------------- load manifest

  void loadManifest().then((manifest) => {
    if (disposed || !manifest) return;
    sizeByCode = new Map(manifest.languages.map((l) => [l.code, l.bytes]));
    void refreshCacheStatus().then(sync);
  });

  // ------------------------------------------------------------ read files

  const ready = (async (): Promise<void> => {
    for (const file of inputs) {
      if (file.type === 'application/pdf') {
        hasPdf = true;
        const buffer = await file.arrayBuffer();
        if (disposed) return;
        let pdf: Awaited<ReturnType<PdfjsModule['getDocument']>['promise']> | null = null;
        try {
          const pdfjs = await loadPdfjs();
          if (disposed) return;
          pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
          pageCount = pdf.numPages;
        } catch {
          // Leave pageCount null — the summary just won't validate a range
          // for this file; ocr.op.ts still reports a clear CorruptFile error
          // when the run actually happens.
        } finally {
          await pdf?.destroy();
        }
        break; // first PDF only, same convention as to-images.editor.ts
      } else if (file.type.startsWith('image/')) {
        sawNonPdfImage = true;
      }
    }
    if (inputs.some((f) => f.type === 'application/pdf')) hasPdf = true;
    sync();
  })();

  void ready.catch(() => {
    if (!disposed) sync();
  });

  return (): void => {
    disposed = true;
    mount.replaceChildren();
  };
};

export default editor;
