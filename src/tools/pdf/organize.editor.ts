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

import type { ToolEditor } from '../../types';

type PdfjsModule = typeof import('pdfjs-dist');

type Rotation = 0 | 90 | 180 | 270;
type PageState = { index: number; rotate: Rotation; keep: boolean };

const THUMB_WIDTH = 96;

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

const CONTROLS = [
  ['left', '◀', 'Move earlier'],
  ['rotate', '⟳', 'Rotate 90°'],
  ['right', '▶', 'Move later'],
  ['remove', 'Delete', 'Delete or restore this page'],
] as const;

const editor: ToolEditor = (mount, inputs, onChange) => {
  const doc = mount.ownerDocument;
  let disposed = false;
  let pages: PageState[] = [];
  const items = new Map<number, HTMLLIElement>();

  mount.replaceChildren();

  const root = doc.createElement('div');
  root.className = 'pdf-organize';

  const status = doc.createElement('p');
  status.className = 'pdf-organize__status';
  status.setAttribute('role', 'status');
  status.textContent = 'Reading the PDF…';

  const list = doc.createElement('ol');
  list.className = 'pdf-organize__pages';
  list.setAttribute('aria-label', 'Pages — reorder, rotate or delete');

  root.append(status, list);
  mount.append(root);

  function emit(): void {
    onChange({ pages: pages.map((p) => ({ index: p.index, rotate: p.rotate, keep: p.keep })) });
  }

  /** Reflect `pages` into the DOM (order, rotation, kept/deleted) and emit. */
  function refresh(): void {
    for (let position = 0; position < pages.length; position++) {
      const state = pages[position];
      if (state === undefined) continue;
      const item = items.get(state.index);
      if (item === undefined) continue;

      // Re-appending in state order is what makes reordering visible.
      list.append(item);
      item.dataset['keep'] = String(state.keep);
      item.dataset['rotate'] = String(state.rotate);
      item.setAttribute(
        'aria-label',
        `Page ${state.index + 1}, position ${position + 1} of ${pages.length}, rotated ${state.rotate} degrees, ${state.keep ? 'kept' : 'deleted'}`,
      );

      const frame = item.querySelector('.pdf-organize__thumb') as HTMLElement | null;
      if (frame) {
        frame.style.transform = `rotate(${state.rotate}deg)`;
        frame.style.opacity = state.keep ? '1' : '0.35';
      }
      const label = item.querySelector('.pdf-organize__label');
      if (label) label.textContent = `${position + 1}. page ${state.index + 1}${state.keep ? '' : ' (deleted)'}`;
      const remove = item.querySelector('[data-action="remove"]');
      if (remove) remove.textContent = state.keep ? 'Delete' : 'Restore';
    }

    const kept = pages.filter((p) => p.keep).length;
    status.textContent = `${pages.length} page${pages.length === 1 ? '' : 's'} — ${kept} kept, ${pages.length - kept} deleted`;
    emit();
  }

  function move(index: number, delta: number): void {
    const from = pages.findIndex((p) => p.index === index);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= pages.length) return;
    const [entry] = pages.splice(from, 1);
    if (entry === undefined) return;
    pages.splice(to, 0, entry);
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
    const button = (event.target as Element | null)?.closest('button[data-action]') as HTMLButtonElement | null;
    if (!button) return;
    const index = itemIndex(button);
    if (index === null) return;
    event.preventDefault();
    act(button.dataset['action'] ?? '', index);
  }

  /** Keyboard equivalent of drag-to-reorder: focus a page, then use the arrows. */
  function onKeyDown(event: KeyboardEvent): void {
    const index = itemIndex(event.target as Element | null);
    if (index === null) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      move(index, -1);
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      move(index, 1);
    } else if (event.key === 'r' || event.key === 'R') {
      event.preventDefault();
      act('rotate', index);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      act('remove', index);
    }
  }

  list.addEventListener('click', onClick);
  list.addEventListener('keydown', onKeyDown);

  function buildRows(pageCount: number): void {
    pages = Array.from({ length: pageCount }, (_unused, i) => ({ index: i, rotate: 0 as Rotation, keep: true }));
    for (const page of pages) {
      const item = doc.createElement('li');
      item.dataset['index'] = String(page.index);
      item.tabIndex = 0;
      item.className = 'pdf-organize__page';

      const frame = doc.createElement('div');
      frame.className = 'pdf-organize__thumb';

      const label = doc.createElement('span');
      label.className = 'pdf-organize__label';

      const controls = doc.createElement('div');
      controls.className = 'pdf-organize__controls';
      for (const [action, text, title] of CONTROLS) {
        const button = doc.createElement('button');
        button.type = 'button';
        button.dataset['action'] = action;
        button.textContent = text;
        button.title = title;
        controls.append(button);
      }

      item.append(frame, label, controls);
      items.set(page.index, item);
      list.append(item);
    }
    refresh();
  }

  const ready = (async (): Promise<void> => {
    const file = inputs[0];
    if (file === undefined) {
      status.textContent = 'Drop a PDF to organize its pages.';
      return;
    }

    const buffer = await file.arrayBuffer();
    if (disposed) return;

    let pdf: Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>;
    try {
      const pdfjs = await loadPdfjs();
      if (disposed) return;
      pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
    } catch (err) {
      const encrypted = err instanceof Error && err.name === 'PasswordException';
      status.textContent = encrypted
        ? `${file.name} is password-protected — decrypt it before organizing it.`
        : `${file.name} could not be read as a PDF.`;
      return;
    }
    if (disposed) {
      await pdf.destroy();
      return;
    }

    buildRows(pdf.numPages);

    // Thumbnails last: the list is already usable and emitting without them.
    try {
      for (const page of pages) {
        if (disposed) break;
        const proxy = await pdf.getPage(page.index + 1);
        const unscaled = proxy.getViewport({ scale: 1 });
        const viewport = proxy.getViewport({ scale: THUMB_WIDTH / unscaled.width });
        const canvas = doc.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        if (!context) continue;
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await proxy.render({ canvasContext: context, viewport }).promise;
        proxy.cleanup();
        if (disposed) break;
        const frame = items.get(page.index)?.querySelector('.pdf-organize__thumb');
        frame?.replaceChildren(canvas);
      }
    } finally {
      await pdf.destroy();
    }
  })();

  // Never leak an unhandled rejection into the host page.
  void ready.catch(() => {
    if (!disposed) status.textContent = 'Could not build page thumbnails.';
  });

  return (): void => {
    disposed = true;
    list.removeEventListener('click', onClick);
    list.removeEventListener('keydown', onKeyDown);
    items.clear();
    mount.replaceChildren();
  };
};

export default editor;
