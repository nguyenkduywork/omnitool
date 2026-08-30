// src/tools/pdf/organize.editor.ts — the bespoke options editor for pdf-organize.
//
// Implements ToolEditor from src/types.ts exactly:
//   (mount, inputs, onChange) => teardown
// and emits { pages: { index, rotate, keep }[] } on every change, where the
// ARRAY ORDER is the output page order.
//
// Unlike *.op.ts this file is DOM code by design: an editor is a UI. It still
// obeys the §1 import rule (only src/types.ts plus npm packages), so it loads
// pdfjs itself for thumbnails rather than reaching into src/core. Every DOM
// access goes through `mount.ownerDocument`, so the module never touches a
// bare `window`/`document` global.
//
// pdfjs is configured worker-less and network-free — `globalThis.pdfjsWorker`
// is set to the bundled worker module so pdfjs never constructs a nested
// Worker and never fabricates a CDN wrapper. See to-images.op.ts for the full
// reasoning. Here the editor runs on the main thread, so real <canvas>
// elements exist and pdfjs's default factories are fine.
//
// THREE DESIGN DECISIONS WORTH KNOWING BEFORE EDITING:
//
// 1. Thumbnails render LAZILY, driven by an IntersectionObserver, and the
//    PDF document is held open until teardown. Rendering all pages up front
//    meant a 138-page file did 138 sequential rasterisations before the board
//    settled. Now only what you can see is rendered, newest-visible-first.
//
// 2. The grid uses a ROVING TABINDEX: exactly one card is tabbable, and the
//    arrow keys act on the focused card. Making all 138 cards tabbable — plus
//    four buttons each — put 690 stops between this board and the Run button.
//    The overlay buttons are therefore tabindex="-1" (mouse/AT-reachable, not
//    tab-reachable); every action they offer has a key binding on the card.
//
// 3. Deleting is non-destructive and keeps the card in place, dimmed and
//    struck through, with the same button toggling back to Restore. Removing
//    cards outright would renumber everything under the pointer mid-edit.

import type { ToolEditor } from '../../types';

import './organize.editor.css';

type PdfjsModule = typeof import('pdfjs-dist');
type PdfDocument = Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;

type Rotation = 0 | 90 | 180 | 270;
type PageState = { index: number; rotate: Rotation; keep: boolean };

/** Raster width in CSS px. Cards are ~112px wide; 2x keeps them crisp. */
const THUMB_WIDTH = 224;

let pdfjsPromise: Promise<PdfjsModule> | null = null;

async function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= (async (): Promise<PdfjsModule> => {
    // Typed by the ambient shim in src/tools/pdf/pdfjs-dist-subpaths.d.ts —
    // pdfjs-dist ships no .d.ts of its own for this worker entry point.
    const workerModule = await import('pdfjs-dist/build/pdf.worker.mjs');
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = workerModule;
    return import('pdfjs-dist');
  })();
  return pdfjsPromise;
}

function nextRotation(current: Rotation): Rotation {
  return ((current + 90) % 360) as Rotation;
}

/** 16x16 stroke icons, drawn from currentColor so they follow the theme. */
const ICON_PATHS = {
  left: 'M10 4 6 8l4 4',
  right: 'M6 4l4 4-4 4',
  rotate: 'M12.5 6.5A5 5 0 1 0 13 10M12.5 3v3.5H9',
  remove: 'M4 5.5h8M6.5 5.5V4h3v1.5M5.5 5.5l.5 7h4l.5-7',
} as const;

const CONTROLS = [
  ['left', 'Move earlier'],
  ['rotate', 'Rotate 90 degrees'],
  ['right', 'Move later'],
  ['remove', 'Delete this page'],
] as const;

const editor: ToolEditor = (mount, inputs, onChange) => {
  const doc = mount.ownerDocument;
  let disposed = false;
  let pages: PageState[] = [];
  let pdf: PdfDocument | null = null;
  /** Index of the card that owns the single tab stop (roving tabindex). */
  let tabStop = 0;
  let dragIndex: number | null = null;

  const items = new Map<number, HTMLLIElement>();
  const rendered = new Set<number>();
  const queue: number[] = [];
  let draining = false;

  mount.replaceChildren();

  const root = doc.createElement('div');
  root.className = 'pdf-organize';

  const bar = doc.createElement('div');
  bar.className = 'pdf-organize__bar';

  const status = doc.createElement('p');
  status.className = 'pdf-organize__status';
  status.setAttribute('role', 'status');
  status.textContent = 'Reading the PDF…';

  const spacer = doc.createElement('span');
  spacer.className = 'pdf-organize__spacer';

  const reset = doc.createElement('button');
  reset.type = 'button';
  reset.className = 'pdf-organize__reset';
  reset.textContent = 'Reset';
  reset.title = 'Restore the original order, rotation and every deleted page';
  reset.disabled = true;

  const hint = doc.createElement('p');
  hint.className = 'pdf-organize__hint';
  hint.innerHTML =
    'Drag to reorder. With a page focused: <kbd>←</kbd><kbd>→</kbd> move, ' +
    '<kbd>R</kbd> rotate, <kbd>Del</kbd> delete, <kbd>Home</kbd>/<kbd>End</kbd> send to either end.';

  bar.append(status, spacer, reset, hint);

  const list = doc.createElement('ol');
  list.className = 'pdf-organize__pages';
  list.setAttribute('aria-label', 'Pages — drag to reorder, or use the arrow keys');

  root.append(bar, list);
  mount.append(root);

  function emit(): void {
    onChange({ pages: pages.map((p) => ({ index: p.index, rotate: p.rotate, keep: p.keep })) });
  }

  function isPristine(): boolean {
    return pages.every((p, position) => p.index === position && p.rotate === 0 && p.keep);
  }

  /** Reflect `pages` into the DOM (order, rotation, kept/deleted) and emit. */
  function refresh(): void {
    // Moving a focused node can drop focus, so put it back afterwards.
    const active = doc.activeElement;

    for (let position = 0; position < pages.length; position++) {
      const state = pages[position];
      if (state === undefined) continue;
      const item = items.get(state.index);
      if (item === undefined) continue;

      // Re-appending in state order is what makes reordering visible.
      list.append(item);
      item.dataset['keep'] = String(state.keep);
      item.tabIndex = position === tabStop ? 0 : -1;
      item.setAttribute(
        'aria-label',
        `Page ${state.index + 1}, position ${position + 1} of ${pages.length}, rotated ${state.rotate} degrees, ${state.keep ? 'kept' : 'deleted'}`,
      );

      const paper = item.querySelector<HTMLElement>('.pdf-organize__paper');
      if (paper) paper.style.transform = `rotate(${state.rotate}deg)`;

      const num = item.querySelector('.pdf-organize__num');
      if (num) num.textContent = String(position + 1);

      // Accent marks pages you have actually touched. On a 138-page board the
      // useful question is "what did I change?", and 138 identically
      // highlighted badges cannot answer it.
      item.dataset['moved'] = String(state.index !== position || state.rotate !== 0);

      // Per-card, not board-wide: the source number is only worth showing when
      // it differs from the position badge. Revealing all 40 the moment any one
      // page moves means 38 chips saying "p.6" under a badge reading "6".
      const src = item.querySelector<HTMLElement>('.pdf-organize__src');
      if (src) {
        src.hidden = state.index === position;
        src.textContent = `p.${state.index + 1}`;
      }

      const remove = item.querySelector<HTMLButtonElement>('[data-action="remove"]');
      if (remove) {
        remove.setAttribute('aria-label', state.keep ? 'Delete this page' : 'Restore this page');
        remove.title = state.keep ? 'Delete this page' : 'Restore this page';
      }

      // Disabling the ends is honest: nothing happens there anyway, and a
      // dead-but-live button is worse than a visibly unavailable one.
      const left = item.querySelector<HTMLButtonElement>('[data-action="left"]');
      if (left) left.disabled = position === 0;
      const right = item.querySelector<HTMLButtonElement>('[data-action="right"]');
      if (right) right.disabled = position === pages.length - 1;
    }

    const kept = pages.filter((p) => p.keep).length;
    const deleted = pages.length - kept;
    status.innerHTML =
      `<b>${kept}</b> of ${pages.length} page${pages.length === 1 ? '' : 's'} kept` +
      (deleted > 0 ? ` · <i>${deleted} deleted</i>` : '');
    reset.disabled = isPristine();

    if (active instanceof HTMLElement && !doc.contains(active)) active.focus();
    emit();
  }

  function move(index: number, delta: number): void {
    const from = pages.findIndex((p) => p.index === index);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= pages.length) return;
    const [entry] = pages.splice(from, 1);
    if (entry === undefined) return;
    pages.splice(to, 0, entry);
    tabStop = to;
    refresh();
    items.get(index)?.focus();
  }

  /** Move `index` so it lands at `to`, used by both drag-drop and Home/End. */
  function moveTo(index: number, to: number): void {
    const from = pages.findIndex((p) => p.index === index);
    if (from < 0 || to < 0 || to >= pages.length || from === to) return;
    const [entry] = pages.splice(from, 1);
    if (entry === undefined) return;
    pages.splice(to, 0, entry);
    tabStop = to;
    refresh();
  }

  function act(action: string, index: number): void {
    const state = pages.find((p) => p.index === index);
    if (state === undefined) return;
    if (action === 'left') move(index, -1);
    else if (action === 'right') move(index, 1);
    else if (action === 'rotate') {
      state.rotate = nextRotation(state.rotate);
      refresh();
    } else if (action === 'remove') {
      state.keep = !state.keep;
      refresh();
    }
  }

  function itemIndex(from: Element | null): number | null {
    const item = from?.closest('li[data-index]') as HTMLLIElement | null;
    if (!item) return null;
    const index = Number(item.dataset['index']);
    return Number.isInteger(index) ? index : null;
  }

  function onClick(event: Event): void {
    const button = (event.target as Element | null)?.closest(
      'button[data-action]',
    ) as HTMLButtonElement | null;
    if (!button || button.disabled) return;
    const index = itemIndex(button);
    if (index === null) return;
    event.preventDefault();
    act(button.dataset['action'] ?? '', index);
  }

  /** Keyboard equivalent of drag-to-reorder: focus a page, then use the keys. */
  function onKeyDown(event: KeyboardEvent): void {
    const index = itemIndex(event.target as Element | null);
    if (index === null) return;
    const position = pages.findIndex((p) => p.index === index);
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        move(index, -1);
        return;
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        move(index, 1);
        return;
      case 'Home':
        event.preventDefault();
        moveTo(index, 0);
        items.get(index)?.focus();
        return;
      case 'End':
        event.preventDefault();
        moveTo(index, pages.length - 1);
        items.get(index)?.focus();
        return;
      case 'r':
      case 'R':
        event.preventDefault();
        act('rotate', index);
        return;
      case 'Delete':
      case 'Backspace':
        event.preventDefault();
        act('remove', index);
        return;
      case 'Tab':
        // Let Tab leave the board, but make sure the stop we leave behind is
        // the card the user was actually on.
        if (position >= 0) tabStop = position;
        return;
      default:
        return;
    }
  }

  function onFocusIn(event: FocusEvent): void {
    const index = itemIndex(event.target as Element | null);
    if (index === null) return;
    const position = pages.findIndex((p) => p.index === index);
    if (position < 0 || position === tabStop) return;
    tabStop = position;
    for (let i = 0; i < pages.length; i++) {
      const state = pages[i];
      if (state === undefined) continue;
      const item = items.get(state.index);
      if (item) item.tabIndex = i === tabStop ? 0 : -1;
    }
  }

  // ------------------------------------------------------------ drag/drop

  function clearDropCues(): void {
    for (const item of items.values()) delete item.dataset['drop'];
  }

  function onDragStart(event: DragEvent): void {
    const index = itemIndex(event.target as Element | null);
    if (index === null) return;
    dragIndex = index;
    const item = items.get(index);
    if (item) item.dataset['dragging'] = 'true';
    event.dataTransfer?.setData('text/plain', String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(event: DragEvent): void {
    if (dragIndex === null) return;
    const overIndex = itemIndex(event.target as Element | null);
    if (overIndex === null || overIndex === dragIndex) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const item = items.get(overIndex);
    if (!item) return;
    // Which half of the card the pointer is in decides before/after, so a drop
    // never lands somewhere the indicator did not promise.
    const box = item.getBoundingClientRect();
    const after = event.clientX > box.left + box.width / 2;
    clearDropCues();
    item.dataset['drop'] = after ? 'after' : 'before';
  }

  function onDrop(event: DragEvent): void {
    if (dragIndex === null) return;
    const overIndex = itemIndex(event.target as Element | null);
    clearDropCues();
    if (overIndex === null || overIndex === dragIndex) return;
    event.preventDefault();

    const item = items.get(overIndex);
    if (!item) return;
    const box = item.getBoundingClientRect();
    const after = event.clientX > box.left + box.width / 2;

    const from = pages.findIndex((p) => p.index === dragIndex);
    const overPos = pages.findIndex((p) => p.index === overIndex);
    if (from < 0 || overPos < 0) return;
    // Removing the dragged card first shifts every later position down by one,
    // so the target index has to be computed against the post-removal array.
    let target = after ? overPos + 1 : overPos;
    if (from < target) target -= 1;
    moveTo(dragIndex, target);
  }

  function onDragEnd(): void {
    if (dragIndex !== null) {
      const item = items.get(dragIndex);
      if (item) delete item.dataset['dragging'];
    }
    dragIndex = null;
    clearDropCues();
  }

  list.addEventListener('click', onClick);
  list.addEventListener('keydown', onKeyDown);
  list.addEventListener('focusin', onFocusIn);
  list.addEventListener('dragstart', onDragStart);
  list.addEventListener('dragover', onDragOver);
  list.addEventListener('drop', onDrop);
  list.addEventListener('dragend', onDragEnd);
  list.addEventListener('dragleave', clearDropCues);

  reset.addEventListener('click', () => {
    pages = pages
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((p) => ({ index: p.index, rotate: 0 as Rotation, keep: true }));
    tabStop = 0;
    refresh();
  });

  // ------------------------------------------------- lazy thumbnail render

  /**
   * Render queued pages one at a time. Serial on purpose: pdfjs rasterising
   * several pages at once on the main thread produces visibly janky scrolling
   * for no throughput gain.
   */
  async function drain(): Promise<void> {
    if (draining || pdf === null) return;
    draining = true;
    try {
      while (queue.length > 0 && !disposed) {
        // FIFO, deliberately. Items are observed in DOM order, so this fills
        // the board top-down, the direction people read it. Draining LIFO to
        // "prioritise the newest scroll position" instead made the first
        // screenful appear bottom-up, which looks broken. The backlog is only
        // ever about a screenful anyway, thanks to the modest rootMargin.
        const index = queue.shift();
        if (index === undefined || rendered.has(index)) continue;
        rendered.add(index);
        const item = items.get(index);
        if (!item) continue;

        const proxy = await pdf.getPage(index + 1);
        if (disposed) return;
        const unscaled = proxy.getViewport({ scale: 1 });
        const viewport = proxy.getViewport({ scale: THUMB_WIDTH / unscaled.width });
        const canvas = doc.createElement('canvas');
        canvas.className = 'pdf-organize__paper';
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) continue;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await proxy.render({ canvasContext: context, viewport }).promise;
        proxy.cleanup();
        if (disposed) return;

        const state = pages.find((p) => p.index === index);
        canvas.style.transform = `rotate(${state?.rotate ?? 0}deg)`;
        // Insert BEFORE the controls overlay and drop only a previous canvas.
        // replaceChildren() here would wipe the controls, which live inside
        // the thumb so they can sit over the page image — every rendered
        // thumbnail would silently lose its own buttons.
        const thumb = item.querySelector('.pdf-organize__thumb');
        thumb?.querySelector('canvas')?.remove();
        thumb?.prepend(canvas);
      }
    } finally {
      draining = false;
    }
  }

  const observer =
    typeof IntersectionObserver === 'undefined'
      ? null
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const index = itemIndex(entry.target);
              if (index === null || rendered.has(index)) continue;
              queue.push(index);
              observer?.unobserve(entry.target);
            }
            void drain();
          },
          // Start a screenful early so scrolling rarely meets a placeholder.
          { root: list, rootMargin: '240px 0px' },
        );

  function buildRows(pageCount: number): void {
    pages = Array.from({ length: pageCount }, (_unused, i) => ({
      index: i,
      rotate: 0 as Rotation,
      keep: true,
    }));

    for (const page of pages) {
      const item = doc.createElement('li');
      item.dataset['index'] = String(page.index);
      item.className = 'pdf-organize__page';
      item.draggable = true;
      item.tabIndex = page.index === 0 ? 0 : -1;

      const thumb = doc.createElement('div');
      thumb.className = 'pdf-organize__thumb';

      const controls = doc.createElement('div');
      controls.className = 'pdf-organize__controls';
      for (const [action, label] of CONTROLS) {
        const button = doc.createElement('button');
        button.type = 'button';
        // Not a tab stop: see decision (2) in the file header. Every action
        // here also has a key binding on the card itself.
        button.tabIndex = -1;
        button.dataset['action'] = action;
        button.setAttribute('aria-label', label);
        button.title = label;
        const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('aria-hidden', 'true');
        const path = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', ICON_PATHS[action]);
        svg.append(path);
        button.append(svg);
        controls.append(button);
      }
      thumb.append(controls);

      const meta = doc.createElement('div');
      meta.className = 'pdf-organize__meta';
      const num = doc.createElement('span');
      num.className = 'pdf-organize__num';
      const src = doc.createElement('span');
      src.className = 'pdf-organize__src';
      src.hidden = true;
      meta.append(num, src);

      item.append(thumb, meta);
      items.set(page.index, item);
      list.append(item);
      observer?.observe(item);
    }

    refresh();

    // No IntersectionObserver (very old browser, or a test harness): fall back
    // to rendering everything rather than showing permanent placeholders.
    if (observer === null) {
      queue.push(...pages.map((p) => p.index));
      void drain();
    }
  }

  const ready = (async (): Promise<void> => {
    const file = inputs[0];
    if (file === undefined) {
      status.textContent = 'Drop a PDF to organize its pages.';
      return;
    }

    const buffer = await file.arrayBuffer();
    if (disposed) return;

    try {
      const pdfjs = await loadPdfjs();
      if (disposed) return;
      pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false })
        .promise;
    } catch (err) {
      const encrypted = err instanceof Error && err.name === 'PasswordException';
      status.textContent = encrypted
        ? `${file.name} is password-protected — decrypt it before organizing it.`
        : `${file.name} could not be read as a PDF.`;
      return;
    }
    if (disposed) {
      await pdf.destroy();
      pdf = null;
      return;
    }

    // The board is usable and emitting before a single thumbnail exists.
    buildRows(pdf.numPages);
  })();

  // Never leak an unhandled rejection into the host page.
  void ready.catch(() => {
    if (!disposed) status.textContent = 'Could not build page thumbnails.';
  });

  return (): void => {
    disposed = true;
    observer?.disconnect();
    list.removeEventListener('click', onClick);
    list.removeEventListener('keydown', onKeyDown);
    list.removeEventListener('focusin', onFocusIn);
    list.removeEventListener('dragstart', onDragStart);
    list.removeEventListener('dragover', onDragOver);
    list.removeEventListener('drop', onDrop);
    list.removeEventListener('dragend', onDragEnd);
    list.removeEventListener('dragleave', clearDropCues);
    items.clear();
    queue.length = 0;
    // The document is held open for lazy rendering, so teardown owns closing
    // it. `ready` may still be in flight; it checks `disposed` and cleans up.
    void pdf?.destroy();
    pdf = null;
    mount.replaceChildren();
  };
};

export default editor;
