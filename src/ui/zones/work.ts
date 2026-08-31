// src/ui/zones/work.ts — zone 3. Everything about the CHOSEN tool.
//
// Options, Run, progress and results live here together and never move, which
// is the point of the three-zone layout: picking a tool low in the catalogue
// used to push its own options off-screen.
//
// This zone owns painting the run card (`.run`) from a snapshot, and owns
// creating the progress ring and results tray — but NOT the options panel: an
// option panel's lifecycle (presets, a lazily-loaded editor, re-mounting when
// the files underneath it change) is `shell.ts`'s business, so this only
// exposes `options`, the element it mounts into. `render` is a pure function
// of the snapshot; nothing here reads `shownTool` or any other shell-owned
// bookkeeping — see shell.ts's subscriber for why that split matters.
//
// The ZONE ROOT is the landmark (`aria-labelledby="run-heading"`), not the
// inner `.run` card — one heading, `#run-heading`, labels both the card
// visually and the zone's region role, so there is exactly one landmark here
// rather than two nested ones sharing a name. The card itself carries no
// `aria-labelledby` of its own for that reason.

import { el, icon } from '../dom';
import { createProgressRing, type ProgressHandle } from '../progress';
import { createResults, type ResultsHandle } from '../results';
import { toolIcon } from '../toolicons';
import type { ZoneHandle } from './files';

export type WorkZoneHandle = ZoneHandle & {
  /** Where the option panel mounts. Built and torn down by the shell, which
   *  owns the tool's option lifecycle — this zone only owns where it sits. */
  readonly options: HTMLElement;
  readonly results: ResultsHandle;
  readonly progress: ProgressHandle;
  /** The e2e suite's race-free "app is ready" signal — see `select()` in
   *  shell.ts, which calls this once its own options mount has landed. */
  focusRun(): void;
  /** Where stranded keyboard focus goes when a run starts — see
   *  `setRunning` in shell.ts. */
  focusCancel(): void;
  /** Whether Run currently holds keyboard focus. `setRunning` reads this
   *  BEFORE telling the machine a run started, for the same reason as
   *  `FilesZoneHandle.hasClearFocus` (see zones/files.ts): asked after the
   *  emit, the button has already lost focus to disabling itself. */
  hasRunFocus(): boolean;
};

export function createWorkZone(init: { onRun: () => void; onCancel: () => void }): WorkZoneHandle {
  const root = el('section', 'zone zone--work');
  root.setAttribute('aria-labelledby', 'run-heading');

  // The one thing this zone shows or hides. Like the `<section class="run">`
  // it replaces, there is no separate empty state: with no tool picked, this
  // zone paints nothing, exactly as before the three-zone split.
  const panel = el('section', 'run');
  panel.hidden = true;

  const glyph = el('span', 'run__glyph');
  const heading = el('h2', 'panel__title', '');
  heading.id = 'run-heading';
  const blurb = el('p', 'run__blurb');
  const titles = el('div', 'run__titles');
  titles.append(heading, blurb);
  const head = el('div', 'run__head');
  head.append(glyph, titles);

  const options = el('div', 'run__options');

  const runButton = el('button', 'btn btn--primary');
  runButton.type = 'button';
  // Addressable, because when the run is blocked the REASON becomes the
  // label: a disabled button with no explanation is the thing this overhaul
  // exists to remove.
  const runLabel = el('span', undefined, 'Run');
  runButton.append(icon('play'), runLabel);
  runButton.addEventListener('click', init.onRun);

  const cancel = el('button', 'btn btn--ghost', 'Cancel');
  cancel.type = 'button';
  cancel.hidden = true;
  cancel.addEventListener('click', init.onCancel);

  const progress = createProgressRing();
  const progressWrap = el('div', 'run__progress');
  progressWrap.hidden = true;
  progressWrap.append(progress.el);

  const bar = el('div', 'run__bar');
  bar.append(runButton, cancel, progressWrap);

  const results = createResults();

  panel.append(head, options, bar);
  root.append(panel);

  return {
    el: root,
    options,
    results,
    progress,
    focusRun: () => runButton.focus(),
    focusCancel: () => cancel.focus(),
    hasRunFocus: () => document.activeElement === runButton,
    render(snapshot) {
      const tool = snapshot.selected;
      panel.hidden = tool === null;

      // Run's disabled state (and Cancel's / the ring's visibility) is
      // settled BEFORE the early return below. With no tool the panel is
      // hidden and the snapshot's `runBlockedReason` is 'Pick a tool
      // first.', which must not latch the button: forcing `blocked` to
      // `null` here means Run's disabled state tracks ONLY `running` once
      // the selection is gone, so clearing it mid-run does not leave Run
      // stuck disabled behind the hidden panel once the run ends.
      const running = snapshot.phase === 'running';
      const blocked = tool === null ? null : snapshot.runBlockedReason;
      runButton.disabled = running || blocked !== null;
      cancel.hidden = !running;
      progressWrap.hidden = !running;
      if (!tool) return;

      heading.textContent = tool.name;
      blurb.textContent = tool.blurb;
      glyph.replaceChildren(icon(toolIcon(tool)));
      panel.dataset.kind = tool.group;
      runLabel.textContent = blocked ?? 'Run';
    },
    destroy() {
      runButton.removeEventListener('click', init.onRun);
      cancel.removeEventListener('click', init.onCancel);
    },
  };
}
