// src/tools/image/crop.editor.ts — the bespoke options editor for image-crop.
//
// Implements ToolEditor from src/types.ts exactly:
//   (mount, inputs, onChange) => teardown
// and emits { x, y, width, height } in SOURCE pixel coordinates — the pixels
// of the decoded image itself, not the CSS pixels it happens to be displayed
// at. That distinction is the classic bug this file exists to get right: the
// preview canvas is laid out at `width:100%` of whatever the host gives it,
// which is very often a different size than the source image's own
// resolution (a 4000x3000 photo previewed at 400 CSS px wide, or conversely a
// tiny 8x6 fixture stretched to fill a panel). Every pointer coordinate is
// converted through `naturalSize / displaySize` before it is ever compared
// against, or emitted as, a crop rect — never assumed to be 1:1.
//
// HOW THIS IS TESTED (see tests/unit/image.browser.test.ts): the test mounts
// this editor into a container whose CSS width is set to a value far from
// the fixture's natural size (e.g. a 400px-wide box around an 8x6 PNG, a 50x
// scale-up), reads the canvas's real getBoundingClientRect() after load, and
// dispatches synthetic PointerEvents at chosen CSS-pixel coordinates. It then
// asserts the emitted rect equals `cssDelta / scale` in SOURCE pixels — a
// value that is different from, and would be wrongly clamped-but-plausible
// under, a naive "pass the CSS pixels straight through" bug. That is the
// scale-mismatch scenario a display-size-agnostic implementation must get
// right, and a 1:1-assuming one would get wrong while still looking sane.
//
// Like organize.editor.ts, all DOM access goes through `mount.ownerDocument`
// (or an element's own `.ownerDocument`) — never a bare `window`/`document`
// global — and only src/types.ts plus browser APIs are imported, per §1.

import type { ToolEditor } from '../../types';

/** Canonical state: always SOURCE pixels. Never store a CSS-pixel rect. */
type Rect = { x: number; y: number; width: number; height: number };

type Handle = 'nw' | 'ne' | 'sw' | 'se';
const HANDLES: Handle[] = ['nw', 'ne', 'sw', 'se'];

type Preset = { label: string; ratio: number | null };
const PRESETS: Preset[] = [
  { label: 'Free', ratio: null },
  { label: '1:1', ratio: 1 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
];

type Drag =
  | { kind: 'create'; anchorX: number; anchorY: number }
  | { kind: 'move'; startPointer: { x: number; y: number }; startRect: Rect }
  | { kind: 'resize'; handle: Handle; startRect: Rect };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function defaultRect(width: number, height: number): Rect {
  const w = Math.max(1, Math.round(width * 0.8));
  const h = Math.max(1, Math.round(height * 0.8));
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h };
}

const editor: ToolEditor = (mount, inputs, onChange) => {
  const doc = mount.ownerDocument;
  let disposed = false;

  let naturalWidth = 0;
  let naturalHeight = 0;
  let displayWidth = 0;
  let displayHeight = 0;
  let rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  let ratio: number | null = null;
  let drag: Drag | null = null;
  let activePointerId: number | null = null;

  mount.replaceChildren();

  const root = doc.createElement('div');
  root.className = 'image-crop';

  const status = doc.createElement('p');
  status.className = 'image-crop__status';
  status.setAttribute('role', 'status');
  status.textContent = 'Reading the image…';

  const toolbar = doc.createElement('div');
  toolbar.className = 'image-crop__toolbar';
  toolbar.setAttribute('role', 'group');
  toolbar.setAttribute('aria-label', 'Aspect ratio presets');

  const presetButtons: HTMLButtonElement[] = [];
  function onPresetClick(nextRatio: number | null): void {
    ratio = nextRatio;
    if (ratio === null) return;
    const height = clamp(Math.round(rect.width / ratio), 1, naturalHeight);
    setRect({ ...rect, height });
  }
  for (const preset of PRESETS) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.textContent = preset.label;
    button.addEventListener('click', () => onPresetClick(preset.ratio));
    presetButtons.push(button);
    toolbar.append(button);
  }

  const stage = doc.createElement('div');
  stage.className = 'image-crop__stage';
  stage.style.position = 'relative';
  stage.style.display = 'block';
  stage.style.width = '100%';
  stage.style.touchAction = 'none';

  const canvas = doc.createElement('canvas');
  canvas.className = 'image-crop__canvas';
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = 'auto';

  const overlay = doc.createElement('div');
  overlay.className = 'image-crop__rect';
  overlay.style.position = 'absolute';
  overlay.style.boxSizing = 'border-box';
  overlay.style.border = '2px solid #4da3ff';
  overlay.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.35)';
  overlay.style.cursor = 'move';
  overlay.style.touchAction = 'none';

  const handleEls = new Map<Handle, HTMLDivElement>();
  for (const h of HANDLES) {
    const el = doc.createElement('div');
    el.className = `image-crop__handle image-crop__handle--${h}`;
    el.style.position = 'absolute';
    el.style.width = '12px';
    el.style.height = '12px';
    el.style.background = '#4da3ff';
    el.style.touchAction = 'none';
    el.style.left = h.includes('e') ? 'calc(100% - 6px)' : '-6px';
    el.style.top = h.includes('s') ? 'calc(100% - 6px)' : '-6px';
    handleEls.set(h, el);
    overlay.append(el);
  }

  stage.append(canvas, overlay);
  root.append(status, toolbar, stage);
  mount.append(root);

  function measure(): void {
    const box = canvas.getBoundingClientRect();
    displayWidth = box.width;
    displayHeight = box.height;
  }

  function scale(): { sx: number; sy: number } {
    return {
      sx: displayWidth > 0 && naturalWidth > 0 ? displayWidth / naturalWidth : 1,
      sy: displayHeight > 0 && naturalHeight > 0 ? displayHeight / naturalHeight : 1,
    };
  }

  /** Re-derive the overlay's CSS geometry from the canonical SOURCE rect. */
  function renderOverlay(): void {
    const { sx, sy } = scale();
    overlay.style.left = `${rect.x * sx}px`;
    overlay.style.top = `${rect.y * sy}px`;
    overlay.style.width = `${rect.width * sx}px`;
    overlay.style.height = `${rect.height * sy}px`;
  }

  function emit(): void {
    onChange({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
  }

  /** THE conversion that matters: a CSS-pixel point on the stage becomes a
   * SOURCE-pixel point by dividing out the display/natural scale — never
   * assumed to be 1:1. */
  function toSourcePoint(clientX: number, clientY: number): { x: number; y: number } {
    const stageBox = stage.getBoundingClientRect();
    const { sx, sy } = scale();
    const displayX = clamp(clientX - stageBox.left, 0, displayWidth);
    const displayY = clamp(clientY - stageBox.top, 0, displayHeight);
    return {
      x: clamp(Math.round(displayX / sx), 0, naturalWidth),
      y: clamp(Math.round(displayY / sy), 0, naturalHeight),
    };
  }

  function setRect(next: Rect): void {
    const width = clamp(Math.round(next.width), 1, naturalWidth);
    const height = clamp(Math.round(next.height), 1, naturalHeight);
    const x = clamp(Math.round(next.x), 0, Math.max(0, naturalWidth - width));
    const y = clamp(Math.round(next.y), 0, Math.max(0, naturalHeight - height));
    rect = { x, y, width, height };
    renderOverlay();
    emit();
  }

  function beginDrag(event: PointerEvent, mode: Drag): void {
    measure();
    drag = mode;
    activePointerId = event.pointerId;
    try {
      // Not all pointerIds are "active" from the browser's point of view for
      // a synthetically-dispatched event; capture is a nice-to-have for real
      // drags off the element, not a correctness requirement, so failure here
      // must never abort the drag.
      stage.setPointerCapture(event.pointerId);
    } catch {
      /* see comment above */
    }
    event.preventDefault();
  }

  function onStagePointerDown(event: PointerEvent): void {
    if (event.target !== canvas) return; // overlay/handles have their own handlers
    const point = toSourcePoint(event.clientX, event.clientY);
    beginDrag(event, { kind: 'create', anchorX: point.x, anchorY: point.y });
  }

  function onOverlayPointerDown(event: PointerEvent): void {
    if (event.target !== overlay) return; // a handle click bubbles here too; ignore it
    const point = toSourcePoint(event.clientX, event.clientY);
    beginDrag(event, { kind: 'move', startPointer: point, startRect: { ...rect } });
  }

  function makeHandlePointerDown(handle: Handle): (event: PointerEvent) => void {
    return (event) => beginDrag(event, { kind: 'resize', handle, startRect: { ...rect } });
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag || event.pointerId !== activePointerId) return;
    const point = toSourcePoint(event.clientX, event.clientY);

    if (drag.kind === 'create') {
      const x = Math.min(drag.anchorX, point.x);
      const y = Math.min(drag.anchorY, point.y);
      const width = Math.max(1, Math.abs(point.x - drag.anchorX));
      const height = ratio !== null ? Math.max(1, Math.round(width / ratio)) : Math.max(1, Math.abs(point.y - drag.anchorY));
      setRect({ x, y, width, height });
    } else if (drag.kind === 'move') {
      const dx = point.x - drag.startPointer.x;
      const dy = point.y - drag.startPointer.y;
      setRect({ ...drag.startRect, x: drag.startRect.x + dx, y: drag.startRect.y + dy });
    } else {
      const { startRect, handle } = drag;
      const anchorX = handle.includes('w') ? startRect.x + startRect.width : startRect.x;
      const anchorY = handle.includes('n') ? startRect.y + startRect.height : startRect.y;
      const width = Math.max(1, Math.abs(point.x - anchorX));
      const height = Math.max(1, Math.abs(point.y - anchorY));
      setRect({ x: Math.min(point.x, anchorX), y: Math.min(point.y, anchorY), width, height });
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (!drag || event.pointerId !== activePointerId) return;
    drag = null;
    activePointerId = null;
  }

  stage.addEventListener('pointerdown', onStagePointerDown);
  overlay.addEventListener('pointerdown', onOverlayPointerDown);
  const handleListeners = new Map<Handle, (event: PointerEvent) => void>();
  for (const h of HANDLES) {
    const listener = makeHandlePointerDown(h);
    handleListeners.set(h, listener);
    handleEls.get(h)?.addEventListener('pointerdown', listener);
  }
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', onPointerUp);
  stage.addEventListener('pointercancel', onPointerUp);

  const ready = (async (): Promise<void> => {
    const file = inputs[0];
    if (file === undefined) {
      status.textContent = 'Drop an image to crop.';
      return;
    }

    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      status.textContent = `${file.name} could not be read as an image.`;
      return;
    }
    if (disposed) {
      bitmap.close();
      return;
    }

    naturalWidth = bitmap.width;
    naturalHeight = bitmap.height;
    canvas.width = naturalWidth;
    canvas.height = naturalHeight;
    const context = canvas.getContext('2d');
    context?.drawImage(bitmap, 0, 0);
    bitmap.close();

    measure();
    rect = defaultRect(naturalWidth, naturalHeight);
    status.textContent = `${naturalWidth} × ${naturalHeight}px — drag to draw a crop box, or move/resize the one shown.`;
    renderOverlay();
    emit();
  })();

  // Never leak an unhandled rejection into the host page.
  void ready.catch(() => {
    if (!disposed) status.textContent = 'Could not load the image to crop.';
  });

  return (): void => {
    disposed = true;
    drag = null;
    stage.removeEventListener('pointerdown', onStagePointerDown);
    overlay.removeEventListener('pointerdown', onOverlayPointerDown);
    for (const h of HANDLES) {
      const listener = handleListeners.get(h);
      if (listener) handleEls.get(h)?.removeEventListener('pointerdown', listener);
    }
    stage.removeEventListener('pointermove', onPointerMove);
    stage.removeEventListener('pointerup', onPointerUp);
    stage.removeEventListener('pointercancel', onPointerUp);
    handleEls.clear();
    presetButtons.length = 0;
    mount.replaceChildren();
  };
};

export default editor;
