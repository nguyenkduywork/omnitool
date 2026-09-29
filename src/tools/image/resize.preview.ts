import type { ToolOptionsPreview } from '../../types';
import { readResizeOptions, resizeDimensions, type ImageSize, type ResizeOptions } from './resize-size';
import './resize.css';

// Keep only dimensions, not decoded pixels; File identity prevents same-name collisions.
const sizes = new WeakMap<File, Promise<ImageSize | null>>();
function sizeOf(file: File): Promise<ImageSize | null> {
  let pending = sizes.get(file);
  if (!pending) {
    pending = Promise.resolve().then(() => createImageBitmap(file)).then((bitmap) => {
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    }, () => null);
    sizes.set(file, pending);
  }
  return pending;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

const PAGE_SIZE = 20;
const dimensions = (size: ImageSize): string => `${size.width.toLocaleString()} × ${size.height.toLocaleString()}`;

const mount: ToolOptionsPreview = ({ actions, summary }, setValues) => {
  let files: readonly File[] = [];
  let settings = readResizeOptions({});
  let destroyed = false;
  let reading = false;
  let limit = PAGE_SIZE;
  type Row = { file: File; node: HTMLLIElement; size?: ImageSize | null; value: HTMLElement; note: HTMLElement };
  let rows: Row[] = [];

  actions.className = 'resize-presets';
  const choices = el('div', 'resize-presets__buttons');
  choices.setAttribute('role', 'group');
  choices.setAttribute('aria-label', 'Resize presets');
  const presets: { name: string; patch: Record<string, unknown>; matches(options: ResizeOptions): boolean }[] = [
    { name: '50%', patch: { mode: 'percent', percent: 50 }, matches: (o) => o.mode === 'percent' && o.percent === 50 },
    ...[1080, 1920].map((size) => ({
      name: `${size} px`, patch: { mode: 'dimensions', width: size, height: size, lockAspect: true },
      matches: (o: ResizeOptions) => o.mode === 'dimensions' && o.lockAspect && o.width === size && o.height === size,
    })),
  ];
  const buttons = presets.map((preset) => {
    const button = el('button', 'btn btn--ghost btn--sm', preset.name);
    button.type = 'button';
    button.addEventListener('click', () => setValues(preset.patch));
    choices.append(button);
    return button;
  });
  actions.append(el('p', 'resize-presets__label', 'Quick presets'), choices,
    el('p', 'resize-preview__hint', 'Pixel presets fit the longest edge and keep proportions.'));

  summary.className = 'resize-preview';
  summary.append(el('h3', 'resize-preview__title', 'Output dimensions'));
  const status = el('p', 'resize-preview__hint');
  status.setAttribute('aria-live', 'polite');
  const list = el('ul', 'resize-preview__list');
  list.setAttribute('aria-label', 'Original and output image dimensions');
  list.tabIndex = 0;
  const more = el('button', 'btn btn--quiet btn--sm resize-preview__more');
  more.type = 'button';
  more.addEventListener('click', () => {
    const start = rows.length;
    limit += PAGE_SIZE;
    addRows();
    rows[start]?.node.focus();
  });
  summary.append(status, list, more);

  function paint(row: Row): void {
    if (row.size === undefined) {
      row.value.textContent = 'Reading dimensions…';
      row.note.textContent = '';
    } else if (row.size === null) {
      row.value.textContent = 'Dimensions unavailable';
      row.note.textContent = 'Run will report any problem with this file.';
    } else {
      const target = resizeDimensions(row.size, settings);
      row.value.textContent = `${dimensions(row.size)} → ${dimensions(target)} px`;
      const same = target.width === row.size.width && target.height === row.size.height;
      row.note.textContent = same
        ? settings.withoutEnlargement ? 'Original file kept' : 'Same dimensions · re-encoded'
        : target.width > row.size.width || target.height > row.size.height ? 'Will enlarge' : 'Will reduce';
    }
  }

  function describe(): void {
    const pending = rows.filter((row) => row.size === undefined).length;
    status.textContent = files.length === 0 ? 'Add images to see their original and output sizes.'
      : pending > 0 ? `Reading dimensions · ${rows.length - pending} of ${rows.length}`
      : `Original → output · ${rows.length === files.length ? `${files.length} ${files.length === 1 ? 'image' : 'images'}` : `${rows.length} of ${files.length} images`}`;
    list.hidden = files.length === 0;
    more.hidden = rows.length === files.length;
    more.textContent = `Show ${Math.min(PAGE_SIZE, files.length - rows.length)} more`;
  }

  async function read(): Promise<void> {
    if (reading || destroyed) return;
    reading = true;
    try {
      // One decode at a time. Updating controls only recalculates numbers.
      while (!destroyed) {
        const row = rows.find((item) => item.size === undefined);
        if (!row) break;
        const size = await sizeOf(row.file);
        if (destroyed) break;
        row.size = size;
        if (rows.includes(row)) { paint(row); describe(); }
      }
    } finally { reading = false; }
  }

  function addRows(): void {
    for (const file of files.slice(rows.length, limit)) {
      const node = el('li', 'resize-preview__row');
      node.tabIndex = -1;
      const name = el('p', 'resize-preview__name', file.name);
      name.title = file.name;
      const row: Row = { file, node, value: el('p', 'resize-preview__value'), note: el('p', 'resize-preview__hint') };
      node.append(name, row.value, row.note);
      rows.push(row);
      list.append(node);
      paint(row);
    }
    describe();
    void read();
  }

  return {
    update(nextFiles, values) {
      if (destroyed) return;
      settings = readResizeOptions(values);
      for (const [index, button] of buttons.entries()) button.setAttribute('aria-pressed', String(presets[index]!.matches(settings)));
      if (files.length !== nextFiles.length || files.some((file, index) => file !== nextFiles[index])) {
        files = [...nextFiles];
        limit = PAGE_SIZE;
        rows = [];
        list.replaceChildren();
        addRows();
      } else {
        rows.forEach(paint);
        describe();
      }
    },
    destroy() {
      destroyed = true;
      files = [];
      rows = [];
      actions.replaceChildren();
      summary.replaceChildren();
    },
  };
};

export default mount;
