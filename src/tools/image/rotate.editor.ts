// src/tools/image/rotate.editor.ts — bespoke options editor for image-rotate.
//
// Implements ToolEditor from src/types.ts exactly:
//   (mount, inputs, onChange) => teardown
// and emits { angle, flip, quality } — the same option names, and the same
// value TYPES (angle as a string of digits, exactly as the `select` in
// registry.image.ts produces), that rotate.op.ts validates. The declarative
// schema therefore stays a working fallback if this chunk ever fails to load.
//
// WHY THIS TOOL NEEDS A BESPOKE EDITOR
//
// "90° clockwise" and "mirror top to bottom" are spatial claims, and a
// dropdown cannot make a spatial claim legible. Two things go wrong without a
// preview, and both are only discoverable by running the tool and looking at
// the download:
//
//   1. Clockwise vs anticlockwise is a coin flip for most people, and a
//      portrait photo turned the wrong way looks *exactly* as plausible in a
//      file listing as one turned the right way.
//   2. Rotation and mirroring COMPOSE, and the op composes them in a specific
//      order — mirror first, then rotate (see rotate.op.ts). "Mirror
//      left-to-right, then turn 90°" is a different picture from "turn, then
//      mirror", and no arrangement of two dropdowns can say which one you are
//      about to get.
//
// THE PREVIEW MUST NOT LIE. It is drawn with the same composition the op
// performs — translate to the output centre, rotate, then scale(-1, …) — so
// what is on screen is the arrangement of pixels that will come back. The
// only deliberate differences are resolution (the preview is capped, see
// PREVIEW_MAX) and that the preview never re-encodes, so it cannot show what
// the quality slider costs. Both are stated rather than glossed over: the
// preview is a claim about ORIENTATION, and it says so.
//
// Per §1 of CONTRIBUTING.md this imports only src/types.ts and browser APIs —
// no core/, no ui/ — and all DOM access goes through `mount.ownerDocument`,
// never a bare `document` global.

import type { ToolEditor } from '../../types';

import './rotate.editor.css';

type Angle = '0' | '90' | '180' | '270';
type Flip = 'none' | 'horizontal' | 'vertical';

/** Mirrors the `angle` select in registry.image.ts, in the same order. */
const ANGLES: readonly { value: Angle; label: string; short: string }[] = [
  { value: '90', label: '90° clockwise', short: '90°' },
  { value: '180', label: '180°', short: '180°' },
  { value: '270', label: '90° anticlockwise', short: '−90°' },
  { value: '0', label: 'No rotation', short: 'None' },
];

const FLIPS: readonly { value: Flip; label: string; short: string }[] = [
  { value: 'none', label: 'No mirror', short: 'None' },
  { value: 'horizontal', label: 'Left to right', short: 'Left ⇄ right' },
  { value: 'vertical', label: 'Top to bottom', short: 'Top ⇅ bottom' },
];

/**
 * Longest edge of the preview bitmap, in device pixels.
 *
 * A phone photo is 4000px on its long edge and gets redrawn on every click of
 * every control. Decoding it once at 640 and reusing that bitmap keeps each
 * redraw at a fraction of a millisecond and the memory cost bounded, and 640
 * is far more resolution than a panel-width preview can show anyway. The
 * bitmap is never scaled UP: a 4x2 test image previews at 4x2 (displayed
 * larger by CSS, with crisp-edges so it reads as pixels rather than mush).
 */
const PREVIEW_MAX = 640;

/** Formats rotate.op.ts hands straight to the canvas encoder. */
const KNOWN_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'];

/** The single format that ignores `quality`, because it is lossless. */
const LOSSLESS_MIMES = ['image/png'];

/** The output mime rotate.op.ts will choose for a file — same rule, same result. */
function outputMimeFor(file: File): string {
  return file.type && KNOWN_MIMES.includes(file.type) ? file.type : 'image/png';
}

function shortMime(mime: string): string {
  return (mime.split('/')[1] ?? mime).toUpperCase();
}

const editor: ToolEditor = (mount, inputs, onChange) => {
  const doc = mount.ownerDocument;
  let disposed = false;

  let angle: Angle = '90';
  let flip: Flip = 'none';
  let quality = 92;

  /** The decoded, downscaled source. Null until the first file has loaded. */
  let preview: ImageBitmap | null = null;
  /** The TRUE source dimensions, which the preview bitmap may not have. */
  let natural: { width: number; height: number } | null = null;

  mount.replaceChildren();
  const root = doc.createElement('div');
  root.className = 'rot';

  // ------------------------------------------------------------- controls

  function row(labelText: string): { row: HTMLElement; controls: HTMLElement } {
    const wrap = doc.createElement('div');
    wrap.className = 'rot__row';
    const label = doc.createElement('span');
    label.className = 'rot__label';
    label.textContent = labelText;
    const controls = doc.createElement('div');
    controls.className = 'rot__controls';
    wrap.append(label, controls);
    return { row: wrap, controls };
  }

  /**
   * A segmented control. `aria-pressed` is the state a screen reader reads, so
   * refreshSegs() keeps it authoritative on every redraw; the visible fill is
   * driven off that same attribute in CSS rather than a second class.
   */
  function segmented<T extends string>(
    items: readonly { value: T; label: string; short: string }[],
    current: () => T,
    pick: (value: T) => void,
    groupLabel: string,
  ): HTMLElement {
    const group = doc.createElement('div');
    group.className = 'rot__seg';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', groupLabel);
    for (const item of items) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.textContent = item.short;
      // The short label is a glyph-ish abbreviation; the full one is what a
      // screen reader should hear and what a tooltip should show.
      button.title = item.label;
      button.setAttribute('aria-label', item.label);
      button.dataset['value'] = item.value;
      button.addEventListener('click', () => {
        pick(item.value);
        sync();
      });
      group.append(button);
    }
    (group as HTMLElement & { __current?: () => string }).__current = current;
    return group;
  }

  const angleRow = row('Rotate');
  const angleSeg = segmented(
    ANGLES,
    () => angle,
    (value) => {
      angle = value;
    },
    'Rotation',
  );
  angleRow.controls.append(angleSeg);

  const flipRow = row('Mirror');
  const flipSeg = segmented(
    FLIPS,
    () => flip,
    (value) => {
      flip = value;
    },
    'Mirror',
  );
  flipRow.controls.append(flipSeg);

  const qualityRow = row('Re-encode quality');
  const qualityInput = doc.createElement('input');
  qualityInput.type = 'range';
  qualityInput.className = 'rot__range';
  qualityInput.min = '10';
  qualityInput.max = '100';
  qualityInput.step = '5';
  qualityInput.value = String(quality);
  qualityInput.setAttribute('aria-label', 'Re-encode quality');
  const qualityValue = doc.createElement('span');
  qualityValue.className = 'rot__value';
  qualityValue.textContent = `${quality}%`;
  qualityRow.controls.append(qualityInput, qualityValue);
  qualityInput.addEventListener('input', () => {
    quality = Number(qualityInput.value);
    sync();
  });

  // -------------------------------------------------------------- preview

  const stage = doc.createElement('div');
  stage.className = 'rot__stage';

  const canvas = doc.createElement('canvas');
  canvas.className = 'rot__canvas';
  // The preview is decorative in the accessibility tree: the summary line
  // below states the same facts in text, and a canvas cannot be read out.
  canvas.setAttribute('role', 'presentation');

  stage.append(canvas);

  const summary = doc.createElement('p');
  summary.className = 'rot__summary';
  summary.setAttribute('role', 'status');
  summary.textContent = 'Reading the image…';

  const note = doc.createElement('p');
  note.className = 'rot__note';

  root.append(angleRow.row, flipRow.row, qualityRow.row, stage, summary, note);
  mount.append(root);

  // ----------------------------------------------------------------- sync

  /** True when the op will actually re-encode — i.e. it is not a passthrough. */
  function transforms(): boolean {
    return angle !== '0' || flip !== 'none';
  }

  /** The output mimes across every input, deduplicated, in first-seen order. */
  function outputMimes(): string[] {
    return [...new Set(inputs.map(outputMimeFor))];
  }

  /** Whether any input will go through a LOSSY encoder, so quality bites. */
  function lossy(): boolean {
    return outputMimes().some((mime) => !LOSSLESS_MIMES.includes(mime));
  }

  function refreshSegs(): void {
    for (const group of [angleSeg, flipSeg]) {
      const current = (group as HTMLElement & { __current?: () => string }).__current?.();
      for (const button of group.querySelectorAll('button')) {
        button.setAttribute('aria-pressed', String(button.dataset['value'] === current));
      }
    }
  }

  /**
   * Draw the preview with the op's own composition.
   *
   * This mirrors rotate.op.ts exactly — translate to the OUTPUT centre,
   * rotate, then scale — which applies to source pixels in the reverse order:
   * mirrored first, then turned. Diverging here would produce a preview that
   * is confidently wrong for every mirror+rotate combination, which is worse
   * than having no preview at all.
   */
  function drawPreview(): void {
    if (!preview) return;
    const quarterTurn = angle === '90' || angle === '270';
    const width = quarterTurn ? preview.height : preview.width;
    const height = quarterTurn ? preview.width : preview.height;

    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return;

    context.clearRect(0, 0, width, height);
    context.save();
    context.translate(width / 2, height / 2);
    if (angle !== '0') context.rotate((Number(angle) * Math.PI) / 180);
    if (flip === 'horizontal') context.scale(-1, 1);
    else if (flip === 'vertical') context.scale(1, -1);
    context.drawImage(preview, -preview.width / 2, -preview.height / 2);
    context.restore();
  }

  function sync(): void {
    if (disposed) return;
    refreshSegs();

    // A quality slider that changes nothing is a lie about what the tool does:
    // PNG ignores it (lossless either way), and a passthrough run never
    // reaches an encoder at all.
    const showQuality = transforms() && lossy();
    qualityRow.row.hidden = !showQuality;
    qualityValue.textContent = `${quality}%`;

    drawPreview();
    stage.hidden = preview === null;

    summary.replaceChildren();
    const b = (text: string): HTMLElement =>
      Object.assign(doc.createElement('b'), { textContent: text });
    const code = (text: string): HTMLElement =>
      Object.assign(doc.createElement('code'), { textContent: text });

    if (natural === null) {
      summary.textContent = inputs.length === 0 ? 'Drop an image to rotate.' : 'Reading the image…';
    } else {
      const quarterTurn = angle === '90' || angle === '270';
      const out = {
        width: quarterTurn ? natural.height : natural.width,
        height: quarterTurn ? natural.width : natural.height,
      };
      summary.append(code(`${natural.width} × ${natural.height} px`));
      if (quarterTurn) {
        summary.append(' → ', code(`${out.width} × ${out.height} px`));
      } else {
        summary.append(' · ', 'same size');
      }
      if (inputs.length > 1) {
        // The preview can only show one picture; say whose, and say that the
        // setting is not somehow first-file-only.
        summary.append(
          ' · preview shows ',
          b(inputs[0]?.name ?? ''),
          `, applied to all ${inputs.length} images`,
        );
      }
    }

    // The honesty line, straight from what the op will actually do.
    if (!transforms()) {
      note.textContent =
        'No rotation and no mirror: the original bytes are handed back untouched, not re-encoded.';
    } else if (showQuality) {
      const formats = outputMimes()
        .filter((mime) => !LOSSLESS_MIMES.includes(mime))
        .map(shortMime)
        .join(' and ');
      note.textContent = `Turning ${formats} re-encodes the pixels, so it costs a little quality — the preview shows the orientation, not that cost.`;
    } else {
      note.textContent = 'PNG is lossless, so this turn costs no quality.';
    }

    emit();
  }

  function emit(): void {
    // `angle` stays a STRING here because that is what the schema's select
    // emits and what the op's validator is written against; sending a number
    // would work today only by accident of Number() coercion.
    onChange({ angle, flip, quality });
  }

  sync();

  // ------------------------------------------------------- read the image

  const ready = (async (): Promise<void> => {
    const file = inputs[0];
    if (file === undefined) {
      sync();
      return;
    }

    let full: ImageBitmap;
    try {
      full = await createImageBitmap(file);
    } catch {
      summary.textContent = `${file.name} could not be read as an image.`;
      note.textContent = '';
      return;
    }
    if (disposed) {
      full.close();
      return;
    }

    natural = { width: full.width, height: full.height };

    // Downscale ONCE, here, so every later redraw is cheap. Never upscale:
    // a scale above 1 would invent detail the source does not have.
    const scale = Math.min(1, PREVIEW_MAX / Math.max(full.width, full.height));
    if (scale < 1) {
      const width = Math.max(1, Math.round(full.width * scale));
      const height = Math.max(1, Math.round(full.height * scale));
      try {
        preview = await createImageBitmap(full, { resizeWidth: width, resizeHeight: height });
        full.close();
      } catch {
        // resizeWidth/resizeHeight is optional in the spec; a browser without
        // it still gets a correct (just heavier) preview.
        preview = full;
      }
    } else {
      preview = full;
    }

    if (disposed) {
      preview.close();
      preview = null;
      return;
    }
    sync();
  })();

  // Never leak an unhandled rejection into the host page.
  void ready.catch(() => {
    if (!disposed) summary.textContent = 'Could not load the image to preview.';
  });

  return (): void => {
    disposed = true;
    preview?.close();
    preview = null;
    mount.replaceChildren();
  };
};

export default editor;
