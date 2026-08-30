// src/ui/dropzone.ts — file intake. Drop first, choose second (§7.1).
//
// Three ways in, all equal citizens:
//   1. drag and drop ANYWHERE in the window, not just onto a small rectangle
//   2. click to pick, from either the hero surface or the compact add-bar
//   3. paste from the clipboard (Ctrl/Cmd-V) — screenshots go straight in
//
// This module owns both intake surfaces because they share one hidden <input>
// and one set of document-level listeners.

import { el, icon, type IconName } from './dom';

export type DropzoneHandle = {
  /** The big first-run surface: drop panel, proof points and the tool preview. */
  readonly hero: HTMLElement;
  /** The slim "add more files" bar shown once the workbench is up. */
  readonly addbar: HTMLElement;
  /** Open the OS file picker (also reachable from the palette in Task 7). */
  pick(): void;
  /** Put keyboard focus on the hero's own pick button. */
  focus(): void;
  destroy(): void;
};

/** True when a drag actually carries files, not text or an internal reorder. */
function carriesFiles(transfer: DataTransfer | null): boolean {
  if (!transfer) return false;
  const types = [...transfer.types];
  // A file-tray reorder sets its own type; never treat it as an intake.
  if (types.includes('application/x-omnitool-reorder')) return false;
  return types.includes('Files');
}

const MOD = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl';

/**
 * The three claims on the landing screen. They are the product, not decoration:
 * every one of them is a statement a visitor can check for themselves, which is
 * why they are phrased as facts rather than adjectives.
 */
const FACTS: { icon: IconName; title: string; body: string }[] = [
  {
    icon: 'shield',
    title: 'Nothing is uploaded',
    body: 'There is no server to upload to. Open your network tab and watch it stay empty.',
  },
  {
    icon: 'bolt',
    title: 'Runs in a worker',
    body: 'Every job runs off the main thread, on your own machine, at local-disk speed.',
  },
  {
    icon: 'offline',
    title: 'Works offline',
    body: 'Install it, pull the plug, keep working. The tools are already on your device.',
  },
];

/** What is waiting behind the drop, so the empty screen still says what this is. */
const FAMILIES: { icon: IconName; kind: string; title: string; body: string }[] = [
  {
    icon: 'file',
    kind: 'pdf',
    title: 'PDF',
    body: 'Merge, split, organise pages, shrink, and convert to or from images.',
  },
  {
    icon: 'image',
    kind: 'image',
    title: 'Images',
    body: 'Convert, resize, compress, crop, and arrange into one contact sheet.',
  },
  {
    icon: 'braces',
    kind: 'data',
    title: 'Data & text',
    body: 'Zip and unzip, hash, Base64, CSV ⇄ JSON, format JSON, make a QR code.',
  },
];

export function createDropzone(init: {
  onFiles: (files: File[]) => void;
  /** Opens the command palette, so the tools are browsable before any file is in. */
  onBrowse: () => void;
  /** How many tools exist, counted from the registry rather than written down. */
  toolCount: number;
}): DropzoneHandle {
  const picker = el('input', 'sr-only');
  picker.type = 'file';
  picker.multiple = true;
  picker.tabIndex = -1;
  picker.setAttribute('aria-hidden', 'true');

  function deliver(files: FileList | null | undefined): void {
    const list = [...(files ?? [])];
    if (list.length > 0) init.onFiles(list);
  }

  picker.addEventListener('change', () => {
    deliver(picker.files);
    // Reset so picking the same file twice in a row still fires `change`.
    picker.value = '';
  });

  function pick(): void {
    picker.click();
  }

  // ---- hero -------------------------------------------------------------
  // The landing screen has one job — get files in — but an empty screen that
  // only says "drop files" tells a first-time visitor nothing about what they
  // are dropping them into. So the drop panel is the loud part, and beneath it
  // sit the claims and the tool families: readable in one scroll-free glance,
  // gone the instant a file arrives.
  const hero = el('section', 'hero');
  hero.setAttribute('aria-labelledby', 'hero-title');

  const drop = el('div', 'hero__drop');

  const panel = el('div', 'hero__panel');

  const eyebrow = el('p', 'hero__eyebrow');
  eyebrow.append(el('span', 'hero__pip'), el('span', undefined, 'No upload · no server · no account'));

  const title = el('h1', 'hero__title');
  title.id = 'hero-title';
  title.append(
    el('span', 'hero__line', 'Drop files.'),
    el('span', 'hero__line hero__line--accent', 'Pick a tool.'),
  );

  const sub = el(
    'p',
    'hero__sub',
    'Merge, convert, shrink, hash, zip. Everything happens inside this tab — the files never travel anywhere, because there is nowhere for them to go.',
  );

  const actions = el('div', 'hero__actions');
  const pickButton = el('button', 'btn btn--primary btn--lg', 'Choose files');
  pickButton.type = 'button';
  pickButton.addEventListener('click', pick);

  const browseButton = el('button', 'btn btn--ghost btn--lg', 'Browse the tools');
  browseButton.type = 'button';
  browseButton.append(el('kbd', undefined, `${MOD} K`));
  browseButton.addEventListener('click', () => init.onBrowse());
  actions.append(pickButton, browseButton);

  const hint = el('p', 'hero__hint');
  hint.append(
    document.createTextNode('or drag them anywhere in this window, or paste with '),
    el('kbd', undefined, MOD),
    document.createTextNode(' '),
    el('kbd', undefined, 'V'),
  );

  panel.append(eyebrow, title, sub, actions, hint);
  drop.append(panel);

  const facts = el('ul', 'facts');
  for (const fact of FACTS) {
    const item = el('li', 'fact');
    const glyph = el('span', 'fact__icon');
    glyph.append(icon(fact.icon));
    const body = el('div', 'fact__body');
    body.append(el('h2', 'fact__title', fact.title), el('p', 'fact__text', fact.body));
    item.append(glyph, body);
    facts.append(item);
  }

  const families = el('div', 'families');
  families.append(
    el('h2', 'families__title', `${init.toolCount} tools, in three families`),
  );
  const familyList = el('ul', 'families__list');
  for (const family of FAMILIES) {
    const item = el('li', 'family');
    item.dataset.kind = family.kind;
    const glyph = el('span', 'family__icon');
    glyph.append(icon(family.icon));
    const body = el('div', 'family__body');
    body.append(el('h3', 'family__name', family.title), el('p', 'family__text', family.body));
    item.append(glyph, body);
    familyList.append(item);
  }
  families.append(familyList);
  families.append(
    el(
      'p',
      'families__note',
      'Drop a file and this list narrows to the tools that can actually run on it.',
    ),
  );

  hero.append(drop, facts, families, picker);

  // ---- compact add-bar --------------------------------------------------
  const addbar = el('div', 'addbar');
  const addButton = el('button', 'btn btn--ghost');
  addButton.type = 'button';
  addButton.append(icon('plus'), el('span', undefined, 'Add files'));
  addButton.addEventListener('click', pick);
  addbar.append(addButton, el('span', 'addbar__hint', `Drop or paste (${MOD}+V) anywhere`));

  // ---- window-wide drag target -----------------------------------------
  // A counter, because dragenter/dragleave fire for every descendant crossed.
  let depth = 0;

  function setDragging(on: boolean): void {
    document.documentElement.classList.toggle('is-dragging', on);
  }

  const onDragEnter = (event: DragEvent): void => {
    if (!carriesFiles(event.dataTransfer)) return;
    depth += 1;
    setDragging(true);
  };

  const onDragOver = (event: DragEvent): void => {
    if (!carriesFiles(event.dataTransfer)) return;
    // Without preventDefault the browser navigates away to the dropped file.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  };

  const onDragLeave = (event: DragEvent): void => {
    if (!carriesFiles(event.dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) setDragging(false);
  };

  const onDrop = (event: DragEvent): void => {
    if (!carriesFiles(event.dataTransfer)) return;
    event.preventDefault();
    depth = 0;
    setDragging(false);
    deliver(event.dataTransfer?.files);
  };

  const onPaste = (event: ClipboardEvent): void => {
    const files = event.clipboardData?.files;
    if (!files || files.length === 0) return;
    // Only hijack the paste when it actually carries files, so pasting text
    // into an option field keeps working.
    event.preventDefault();
    deliver(files);
  };

  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);
  document.addEventListener('paste', onPaste);

  return {
    hero,
    addbar,
    pick,
    focus(): void {
      pickButton.focus();
    },
    destroy(): void {
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('paste', onPaste);
      setDragging(false);
    },
  };
}
