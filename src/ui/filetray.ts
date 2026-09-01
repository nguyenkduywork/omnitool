// src/ui/filetray.ts — the file tray, with reorder as a first-class feature.
//
// Order is DATA here, not decoration: `pdf-merge` concatenates in tray order and
// `image-merge-sheet` lays out in tray order. So reorder has to be good, and it
// has to be reachable two ways:
//
//   MOUSE / TOUCH : drag an item; an insertion line shows where it will land.
//   KEYBOARD      : focus an item and press
//                     Arrow Up / Arrow Left   move it one earlier
//                     Arrow Down / Arrow Right move it one later
//                     Home / End               move it to the start / end
//                     Delete / Backspace       remove it
//                   Focus follows the item, and every move is announced through
//                   the shell's aria-live region. (§7.5 — this is a hard
//                   requirement, not a nicety.)
//
// Both paths end in the same `move()`, which does a FLIP measurement and hands
// the displacement to motion.settleReorder. Nodes are MOVED in the DOM rather
// than re-rendered, so focus, thumbnails and their object URLs all survive.

import { label } from '../core/format';
import { el, formatBytes, icon, iconButton } from './dom';
import { settleReorder, type Displacement } from './motion';
import type { FileEntry } from './state';

/** The tray renders exactly what the state machine holds. */
export type TrayEntry = FileEntry;

export type FileTrayHandle = {
  readonly el: HTMLElement;
  /**
   * Replace the whole list. Call this when files are ADDED or CLEARED — not in
   * response to `onChange`, which the tray fires after mutating itself.
   */
  setEntries(entries: TrayEntry[]): void;
  entries(): TrayEntry[];
  /**
   * Freeze (or unfreeze) every control that MUTATES the list — drag, the
   * keyboard reorder shortcuts, and the per-row nudge/remove buttons — while a
   * job is running. A running job already captured its own copy of the file
   * list (see `shell.ts`'s `start()`), so nothing the tray does can reach it
   * any more; letting it keep mutating anyway would just let what's ON SCREEN
   * drift from what the job is actually processing, which is confusing in
   * exactly the way `zones/files.ts`'s "Remove all files" being disabled
   * during a run already avoids for the whole-tray case. Intake (adding MORE
   * files) is deliberately NOT frozen by this — see shell.ts's `intake` and
   * the F1 write-up in the final-fix report for why that line was drawn here.
   */
  setRunning(on: boolean): void;
  destroy(): void;
};

export type FileTrayInit = {
  onChange: (entries: TrayEntry[]) => void;
  announce: (message: string) => void;
};

const REORDER_MIME = 'application/x-omnitool-reorder';

/** A short badge for a file with no thumbnail: 'PDF', 'ZIP', 'CSV', ... */
function badgeFor(entry: TrayEntry): string {
  const subtype = entry.type.slice(entry.type.indexOf('/') + 1).replace(/^x-|\+.*$/g, '');
  if (entry.type === 'application/octet-stream') {
    const dot = entry.file.name.lastIndexOf('.');
    const ext = dot > 0 ? entry.file.name.slice(dot + 1) : '';
    return (ext || 'file').slice(0, 4).toUpperCase();
  }
  return subtype.slice(0, 4).toUpperCase();
}

/**
 * Which tool family a file belongs to, for the row's identity tint only. It
 * deliberately mirrors the three groups in the tool grid so a dropped PDF and
 * the PDF section read as the same colour; nothing behavioural hangs off it.
 */
function kindOf(type: string): 'pdf' | 'image' | 'data' {
  if (type === 'application/pdf') return 'pdf';
  if (type.startsWith('image/')) return 'image';
  return 'data';
}

function isThumbnailable(type: string): boolean {
  // Formats a browser can paint in an <img> without help. AVIF/WebP decode
  // support is near-universal now; a failed decode just leaves the badge.
  return (
    type === 'image/png' ||
    type === 'image/jpeg' ||
    type === 'image/webp' ||
    type === 'image/gif' ||
    type === 'image/avif' ||
    type === 'image/svg+xml' ||
    type === 'image/bmp'
  );
}

export function createFileTray(init: FileTrayInit): FileTrayHandle {
  // No `aria-labelledby` here: zone--files (ui/zones/files.ts) is the ONE
  // landmark for this whole area and already carries
  // `aria-labelledby="tray-heading"`, pointing at the `<h2>` below. A
  // `<section>` only becomes a `region` landmark once it has an accessible
  // name (an `aria-labelledby` of its own would give it one), so naming this
  // section the same way would nest a second "Files" landmark inside the
  // first — landmark navigation would announce two "Files" where one does
  // the job. The heading itself stays right here: the aside references it by
  // id, and it is still this tray's own visible caption either way.
  const root = el('section', 'tray');

  const head = el('div', 'tray__head');
  const heading = el('h2', 'panel__title', 'Files');
  heading.id = 'tray-heading';
  const count = el('span', 'tray__count');
  head.append(heading, count);

  // Swapped for `HINT_FROZEN` while a job runs (see `setRunning` below) —
  // every control this describes is frozen then too (`opacity: 0.3`,
  // `cursor: not-allowed`), so advertising them as available would be a false
  // sentence sitting right next to controls that visibly say otherwise.
  const HINT_IDLE =
    'Order matters for merging. Drag a file, use the arrow buttons, or focus a file and press the arrow keys.';
  const HINT_FROZEN = 'Reordering is paused while this tool runs.';

  const hint = el('p', 'tray__hint', HINT_IDLE);
  hint.id = 'tray-hint';

  const list = el('ul', 'tray__list');
  list.setAttribute('role', 'list');

  root.append(head, hint, list);

  type Item = { entry: TrayEntry; node: HTMLLIElement; url: string | null };
  let items: Item[] = [];
  let dragFrom = -1;
  /** See `FileTrayHandle.setRunning`'s own doc comment. */
  let frozen = false;

  function positions(): Map<HTMLElement, DOMRect> {
    const map = new Map<HTMLElement, DOMRect>();
    for (const item of items) map.set(item.node, item.node.getBoundingClientRect());
    return map;
  }

  function syncOrder(): void {
    for (const item of items) list.append(item.node);
    for (const [index, item] of items.entries()) {
      item.node.setAttribute('aria-label', describe(item.entry, index));
      // Native drag is opt-in per element; clearing it while frozen is what
      // stops `dragstart` from firing at all (see the listener below), not
      // just cosmetic.
      item.node.draggable = !frozen;
      const nudges = item.node.querySelectorAll<HTMLButtonElement>('.tray__nudge');
      // A control that cannot do anything says so, rather than silently no-op'ing.
      if (nudges[0]) nudges[0].disabled = frozen || index === 0;
      if (nudges[1]) nudges[1].disabled = frozen || index === items.length - 1;
      const remove = item.node.querySelector<HTMLButtonElement>('.tray__remove');
      if (remove) remove.disabled = frozen;
    }
    count.textContent = items.length === 1 ? '1 file' : `${items.length} files`;
  }

  function describe(entry: TrayEntry, index: number): string {
    return `${entry.file.name}, ${label(entry.type)}, ${formatBytes(entry.file.size)}. Position ${index + 1} of ${items.length}.`;
  }

  /** Re-lay out after a mutation, FLIP the movers, and tell the shell. */
  function commit(before: Map<HTMLElement, DOMRect>, refocus: HTMLElement | null): void {
    syncOrder();
    const moves: Displacement[] = [];
    for (const [node, rect] of before) {
      if (!node.isConnected) continue;
      const now = node.getBoundingClientRect();
      moves.push({ el: node, dx: rect.left - now.left, dy: rect.top - now.top });
    }
    void settleReorder(moves);
    refocus?.focus();
    init.onChange(items.map((item) => item.entry));
  }

  function move(from: number, to: number): void {
    const target = Math.min(items.length - 1, Math.max(0, to));
    const source = items[from];
    if (!source || target === from) return;

    const before = positions();
    const next = [...items];
    next.splice(from, 1);
    next.splice(target, 0, source);
    items = next;
    commit(before, source.node);
    init.announce(`${source.entry.file.name} moved to position ${target + 1} of ${items.length}.`);
  }

  function remove(index: number): void {
    const gone = items[index];
    if (!gone) return;

    const before = positions();
    before.delete(gone.node);
    if (gone.url) URL.revokeObjectURL(gone.url);
    gone.node.remove();
    items = items.filter((item) => item !== gone);

    const focusTarget = items[Math.min(index, items.length - 1)]?.node ?? null;
    commit(before, focusTarget);
    init.announce(
      items.length === 0
        ? `${gone.entry.file.name} removed. No files left.`
        : `${gone.entry.file.name} removed. ${items.length} left.`,
    );
  }

  function indexOfNode(node: HTMLElement): number {
    return items.findIndex((item) => item.node === node);
  }

  function build(entry: TrayEntry): Item {
    const node = el('li', 'tray__item');
    node.tabIndex = 0;
    node.draggable = true;
    node.dataset.kind = kindOf(entry.type);
    node.setAttribute('aria-describedby', 'tray-hint');

    const thumb = el('span', 'tray__thumb');
    let url: string | null = null;
    if (isThumbnailable(entry.type)) {
      url = URL.createObjectURL(entry.file);
      const img = el('img', 'tray__img');
      img.src = url;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      thumb.append(img);
    } else {
      thumb.append(el('span', 'tray__badge', badgeFor(entry)));
    }

    const body = el('div', 'tray__body');
    const name = el('span', 'tray__name', entry.file.name);
    name.title = entry.file.name;
    body.append(
      name,
      el('span', 'tray__meta', `${label(entry.type)} · ${formatBytes(entry.file.size)}`),
    );

    const grip = el('span', 'tray__grip');
    grip.setAttribute('aria-hidden', 'true');
    grip.append(icon('grip'));

    // Explicit move buttons. Drag needs a mouse and the arrow keys need a
    // keyboard; on a phone neither is available, and reorder is not optional
    // for a merge. They are also a plainer affordance for anyone driving the
    // page with switch control or voice.
    const up = iconButton('up', `Move ${entry.file.name} earlier`, 'tray__nudge');
    up.addEventListener('click', (event) => {
      event.stopPropagation();
      const index = indexOfNode(node);
      move(index, index - 1);
    });

    const down = iconButton('down', `Move ${entry.file.name} later`, 'tray__nudge');
    down.addEventListener('click', (event) => {
      event.stopPropagation();
      const index = indexOfNode(node);
      move(index, index + 1);
    });

    const kill = iconButton('close', `Remove ${entry.file.name}`, 'tray__remove');
    kill.addEventListener('click', (event) => {
      event.stopPropagation();
      remove(indexOfNode(node));
    });

    const controls = el('div', 'tray__controls');
    controls.append(up, down, kill);

    node.append(grip, thumb, body, controls);

    node.addEventListener('keydown', (event) => {
      const index = indexOfNode(node);
      if (index < 0 || frozen) return;
      switch (event.key) {
        case 'ArrowUp':
        case 'ArrowLeft':
          event.preventDefault();
          move(index, index - 1);
          return;
        case 'ArrowDown':
        case 'ArrowRight':
          event.preventDefault();
          move(index, index + 1);
          return;
        case 'Home':
          event.preventDefault();
          move(index, 0);
          return;
        case 'End':
          event.preventDefault();
          move(index, items.length - 1);
          return;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          remove(index);
          return;
        default:
          return;
      }
    });

    node.addEventListener('dragstart', (event) => {
      dragFrom = indexOfNode(node);
      node.classList.add('is-dragging');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        // A private type so the window-wide file-intake handler ignores this drag.
        event.dataTransfer.setData(REORDER_MIME, String(dragFrom));
        event.dataTransfer.setData('text/plain', entry.file.name);
      }
    });

    node.addEventListener('dragend', () => {
      dragFrom = -1;
      node.classList.remove('is-dragging');
      for (const item of items) item.node.classList.remove('is-over-before', 'is-over-after');
    });

    node.addEventListener('dragover', (event) => {
      if (dragFrom < 0) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      const rect = node.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      node.classList.toggle('is-over-before', !after);
      node.classList.toggle('is-over-after', after);
    });

    node.addEventListener('dragleave', () => {
      node.classList.remove('is-over-before', 'is-over-after');
    });

    node.addEventListener('drop', (event) => {
      if (dragFrom < 0) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = node.getBoundingClientRect();
      const after = event.clientY > rect.top + rect.height / 2;
      const over = indexOfNode(node);
      node.classList.remove('is-over-before', 'is-over-after');
      let to = after ? over + 1 : over;
      if (dragFrom < to) to -= 1;
      move(dragFrom, to);
      dragFrom = -1;
    });

    return { entry, node, url };
  }

  function clear(): void {
    for (const item of items) {
      if (item.url) URL.revokeObjectURL(item.url);
    }
    items = [];
    list.replaceChildren();
  }

  return {
    el: root,
    setEntries(entries: TrayEntry[]): void {
      clear();
      items = entries.map(build);
      syncOrder();
    },
    entries(): TrayEntry[] {
      return items.map((item) => item.entry);
    },
    setRunning(on: boolean): void {
      if (frozen === on) return;
      frozen = on;
      hint.textContent = frozen ? HINT_FROZEN : HINT_IDLE;
      syncOrder();
    },
    destroy(): void {
      clear();
    },
  };
}
