// src/ui/zones/files.ts — zone 1. Intake and order, nothing else.
//
// The add-bar and the tray already exist and already work (dropzone.ts,
// filetray.ts); this zone only owns where they sit and when the "remove all"
// control is live. It does NOT decide whether the workbench itself is on
// screen — that hero/workbench switch (the drop-dissolves-into-the-workbench
// morph) stays in shell.ts, so `render` below is defensive rather than load
// bearing: by the time this zone is visible at all, `snapshot.entries` is
// already non-empty in every reachable path.

import { el } from '../dom';
import type { FileTrayHandle } from '../filetray';
import type { Snapshot } from '../state';

export type ZoneHandle = {
  readonly el: HTMLElement;
  render(snapshot: Snapshot): void;
  destroy(): void;
};

export type FilesZoneHandle = ZoneHandle & {
  /**
   * Whether the "remove all" control currently holds keyboard focus.
   *
   * `shell.ts`'s `setRunning` reads this BEFORE it tells the state machine a
   * run has started, because that is what disables this button (see
   * `render`), and disabling the focused element blurs it to `<body>` in
   * every browser. Asked after the fact the answer is always "no" — the
   * button has already lost focus by then — which is why this is a query the
   * shell can make at the right moment, not a snapshot field.
   */
  hasClearFocus(): boolean;
};

export function createFilesZone(init: {
  addbar: HTMLElement;
  tray: FileTrayHandle;
  onClear: () => void;
}): FilesZoneHandle {
  const root = el('div', 'zone zone--files');

  const clear = el('button', 'btn btn--quiet btn--sm clearbtn', 'Remove all files');
  clear.type = 'button';
  clear.addEventListener('click', init.onClear);

  root.append(init.addbar, init.tray.el, clear);

  return {
    el: root,
    render(snapshot) {
      const has = snapshot.entries.length > 0;
      init.tray.el.hidden = !has;
      clear.hidden = !has;
      clear.disabled = snapshot.phase === 'running';
    },
    hasClearFocus: () => document.activeElement === clear,
    destroy() {
      clear.removeEventListener('click', init.onClear);
    },
  };
}
