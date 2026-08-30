// src/tools/pdf/to-images.editor.ts — bespoke options editor for pdf-to-images.
//
// Implements ToolEditor from src/types.ts exactly:
//   (mount, inputs, onChange) => teardown
// and emits { format, dpi, quality, pages } — the same option names the op
// validates, so the declarative schema in registry.pdf.ts stays the fallback.
//
// WHY THIS TOOL NEEDS A BESPOKE EDITOR
//
// The generic schema panel renders one labelled control per key and cannot:
//
//   1. Compute anything from the document. "150 DPI" means nothing to most
//      people; "1240 x 1754 px" does. That number depends on the actual page
//      size, so it has to be read out of the PDF.
//   2. Say how many files a run will produce. Choosing this tool on a 138-page
//      report and getting 138 downloads is a nasty surprise, and the schema has
//      nowhere to warn about it.
//   3. Show a control conditionally. A JPEG quality slider next to a PNG
//      selection implies a knob that does nothing — PNG is lossless.
//   4. Validate a page range against the real page count, live.
//
// pdfjs is loaded here the same worker-less, network-free way as
// organize.editor.ts and to-images.op.ts. Only page 1's viewport is read, so
// this is cheap — no page is rasterised until the op runs.

import type { ToolEditor } from '../../types';

import './to-images.editor.css';
import { parsePageRanges } from './page-range';

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

/**
 * DPI presets, because nobody thinks in dots per inch. The labels say what the
 * number is FOR; the number stays visible for anyone who does think in DPI.
 */
const PRESETS = [
  { dpi: 72, label: 'Screen' },
  { dpi: 150, label: 'Standard' },
  { dpi: 300, label: 'Print' },
] as const;

const FORMATS = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
] as const;

/**
 * Bytes per output pixel, as a RANGE rather than a single figure.
 *
 * Output size depends enormously on what is on the page: a mostly-white text
 * page and a full-bleed photograph differ by more than an order of magnitude
 * at identical dimensions. Measured on real rasterised pages, a sparse text
 * page lands near the low end and a photographic one near the high end.
 *
 * A single midpoint here read "≈ 705 kB" for a 12-page text document that
 * actually produced 132 kB. Being 5x out is worse than being vague: the number
 * exists to answer "am I about to generate something enormous?", and a range
 * answers that honestly while a false point estimate quietly erodes trust in
 * every other number on screen.
 */
const BYTES_PER_PIXEL = {
  png: { low: 0.05, high: 0.6 },
  jpeg: { low: 0.02, high: 0.15 },
} as const;

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

const editor: ToolEditor = (mount, inputs, onChange) => {
  const doc = mount.ownerDocument;
  let disposed = false;

  let format: 'png' | 'jpeg' = 'png';
  let dpi = 150;
  let quality = 85;
  let pagesSpec = '';

  /** Page count and page-1 size at 72 DPI, once the PDF has been read. */
  let pageCount: number | null = null;
  let basePt: { width: number; height: number } | null = null;

  mount.replaceChildren();
  const root = doc.createElement('div');
  root.className = 'tiu';

  // ---------------------------------------------------------------- helpers

  function row(labelText: string): { row: HTMLElement; controls: HTMLElement } {
    const wrap = doc.createElement('div');
    wrap.className = 'tiu__row';
    const label = doc.createElement('span');
    label.className = 'tiu__label';
    label.textContent = labelText;
    const controls = doc.createElement('div');
    controls.className = 'tiu__controls';
    wrap.append(label, controls);
    return { row: wrap, controls };
  }

  function segmented<T extends string>(
    items: readonly { value: T; label: string }[],
    current: () => T,
    pick: (value: T) => void,
    groupLabel: string,
  ): HTMLElement {
    const group = doc.createElement('div');
    group.className = 'tiu__seg';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', groupLabel);
    for (const item of items) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = item.label;
      button.dataset['value'] = item.value;
      button.addEventListener('click', () => {
        pick(item.value);
        sync();
      });
      group.append(button);
    }
    // aria-pressed is the state a screen reader reads, so keep it authoritative.
    group.dataset['sync'] = 'seg';
    (group as HTMLElement & { __current?: () => string }).__current = current;
    return group;
  }

  // ----------------------------------------------------------------- format

  const formatRow = row('Format');
  const formatSeg = segmented(
    FORMATS,
    () => format,
    (value) => {
      format = value;
    },
    'Output format',
  );
  formatRow.controls.append(formatSeg);

  // -------------------------------------------------------------- resolution

  const dpiRow = row('Resolution');
  const dpiSeg = segmented(
    PRESETS.map((p) => ({ value: String(p.dpi), label: p.label })),
    () => String(dpi),
    (value) => {
      dpi = Number(value);
      dpiInput.value = String(dpi);
    },
    'Resolution preset',
  );
  const dpiInput = doc.createElement('input');
  dpiInput.type = 'number';
  dpiInput.className = 'tiu__num';
  dpiInput.min = '72';
  dpiInput.max = '600';
  dpiInput.step = '1';
  dpiInput.value = String(dpi);
  dpiInput.setAttribute('aria-label', 'Resolution in DPI');
  const dpiUnit = doc.createElement('span');
  dpiUnit.className = 'tiu__value';
  dpiUnit.textContent = 'DPI';
  dpiRow.controls.append(dpiSeg, dpiInput, dpiUnit);

  dpiInput.addEventListener('input', () => {
    const next = Number(dpiInput.value);
    // Clamp silently on the way out but leave what was typed alone, so the
    // field does not fight the user mid-keystroke.
    dpi = Number.isFinite(next) ? Math.max(72, Math.min(600, Math.round(next))) : 150;
    sync();
  });

  // ----------------------------------------------------------- jpeg quality

  const qualityRow = row('JPEG quality');
  const qualityInput = doc.createElement('input');
  qualityInput.type = 'range';
  qualityInput.className = 'tiu__range';
  qualityInput.min = '10';
  qualityInput.max = '100';
  qualityInput.step = '5';
  qualityInput.value = String(quality);
  qualityInput.setAttribute('aria-label', 'JPEG quality');
  const qualityValue = doc.createElement('span');
  qualityValue.className = 'tiu__value';
  qualityValue.textContent = `${quality}%`;
  qualityRow.controls.append(qualityInput, qualityValue);
  qualityInput.addEventListener('input', () => {
    quality = Number(qualityInput.value);
    sync();
  });

  // ------------------------------------------------------------- page range

  const pagesRow = row('Pages');
  const pagesInput = doc.createElement('input');
  pagesInput.type = 'text';
  pagesInput.className = 'tiu__text';
  pagesInput.placeholder = 'all pages';
  pagesInput.setAttribute('aria-label', 'Pages to convert');
  const pagesHint = doc.createElement('p');
  pagesHint.className = 'tiu__hint';
  pagesRow.controls.append(pagesInput, pagesHint);
  pagesInput.addEventListener('input', () => {
    pagesSpec = pagesInput.value;
    sync();
  });

  // ---------------------------------------------------------------- summary

  const summary = doc.createElement('p');
  summary.className = 'tiu__summary';
  summary.setAttribute('role', 'status');
  summary.textContent = 'Reading the PDF…';

  root.append(formatRow.row, dpiRow.row, qualityRow.row, pagesRow.row, summary);
  mount.append(root);

  // ------------------------------------------------------------------- sync

  /** How many pages the current spec selects, or an error to show. */
  function selection(): { count: number; error: string | null } {
    if (pageCount === null) return { count: 0, error: null };
    if (pagesSpec.trim() === '') return { count: pageCount, error: null };
    try {
      const groups = parsePageRanges(pagesSpec, pageCount);
      const unique = new Set(groups.flatMap((g) => g.pages));
      return { count: unique.size, error: null };
    } catch (err) {
      return { count: 0, error: err instanceof Error ? err.message : 'Invalid page range' };
    }
  }

  function refreshSegs(): void {
    for (const group of [formatSeg, dpiSeg]) {
      const current = (group as HTMLElement & { __current?: () => string }).__current?.();
      for (const button of group.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String(button.dataset['value'] === current));
      }
    }
  }

  function sync(): void {
    if (disposed) return;
    refreshSegs();

    // PNG is lossless, so a quality control there would be a lie.
    qualityRow.row.hidden = format !== 'jpeg';
    qualityValue.textContent = `${quality}%`;

    const { count, error } = selection();
    pagesInput.setAttribute('aria-invalid', String(error !== null));
    pagesHint.classList.toggle('tiu__hint--error', error !== null);
    pagesHint.textContent =
      error ??
      (pageCount === null
        ? ''
        : `Leave empty for all ${pageCount} pages, or try 1-3,7,9- for a selection.`);

    if (pageCount === null || basePt === null) {
      summary.textContent = error ?? 'Reading the PDF…';
      emit();
      return;
    }

    const scale = dpi / 72;
    const px = {
      w: Math.max(1, Math.ceil(basePt.width * scale)),
      h: Math.max(1, Math.ceil(basePt.height * scale)),
    };
    const pixels = px.w * px.h * count;
    const band = BYTES_PER_PIXEL[format];
    const low = pixels * band.low;
    const high = pixels * band.high;
    const fileWord = count === 1 ? 'image' : 'images';

    summary.replaceChildren();
    if (error !== null) {
      summary.append(Object.assign(doc.createElement('span'), { className: 'tiu__warn', textContent: error }));
    } else {
      const parts: (string | HTMLElement)[] = [];
      const b = (text: string): HTMLElement =>
        Object.assign(doc.createElement('b'), { textContent: text });
      const code = (text: string): HTMLElement =>
        Object.assign(doc.createElement('code'), { textContent: text });

      parts.push(b(String(count)), ` ${fileWord} · `, code(`${px.w}x${px.h} px`), ' each · ');
      // Count and dimensions are exact; only the byte total is a guess, so only
      // it is hedged. "roughly A-B" is the honest shape of what we know.
      parts.push('roughly ', b(`${formatBytes(low)}-${formatBytes(high)}`), ' total');
      summary.append(...parts);

      // A big run is worth flagging BEFORE it happens, not after 138 files
      // have landed in the downloads folder.
      if (count > 25) {
        const warn = doc.createElement('span');
        warn.className = 'tiu__warn';
        warn.textContent = `· that is a lot of files — they arrive as one zip`;
        summary.append(' ', warn);
      }
      if (px.w * px.h > 40e6) {
        const warn = doc.createElement('span');
        warn.className = 'tiu__warn';
        warn.textContent = '· very large pages may run out of memory';
        summary.append(' ', warn);
      }
    }
    emit();
  }

  function emit(): void {
    onChange({ format, dpi, quality, pages: pagesSpec });
  }

  sync();

  // ------------------------------------------------------------ read the PDF

  const ready = (async (): Promise<void> => {
    const file = inputs[0];
    if (file === undefined) {
      summary.textContent = 'Drop a PDF to convert its pages.';
      return;
    }

    const buffer = await file.arrayBuffer();
    if (disposed) return;

    let pdf: Awaited<ReturnType<PdfjsModule['getDocument']>['promise']> | null = null;
    try {
      const pdfjs = await loadPdfjs();
      if (disposed) return;
      pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false })
        .promise;
      if (disposed) return;
      pageCount = pdf.numPages;
      // Page 1 at scale 1 is the 72-DPI size in CSS pixels, which is what the
      // DPI readout scales from. Mixed-size documents are reported from page 1
      // rather than pretending to a single answer they do not have.
      const first = await pdf.getPage(1);
      const viewport = first.getViewport({ scale: 1 });
      basePt = { width: viewport.width, height: viewport.height };
      first.cleanup();
    } catch (err) {
      const encrypted = err instanceof Error && err.name === 'PasswordException';
      summary.textContent = encrypted
        ? `${file.name} is password-protected — decrypt it first.`
        : `${file.name} could not be read as a PDF.`;
      return;
    } finally {
      await pdf?.destroy();
    }

    if (inputs.length > 1) {
      // Multi-file runs are supported by the op; the readout describes the
      // first file rather than silently averaging over all of them.
      pagesInput.placeholder = 'all pages (applied to each PDF)';
    }
    sync();
  })();

  void ready.catch(() => {
    if (!disposed) summary.textContent = 'Could not read the PDF.';
  });

  return (): void => {
    disposed = true;
    mount.replaceChildren();
  };
};

export default editor;
