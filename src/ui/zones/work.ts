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
// The ZONE ROOT is the landmark, not the inner `.run` card, so there is
// exactly one landmark here rather than two nested ones. Its accessible name
// is a dynamic `aria-label` — 'Selected tool' cold, the tool's own name once
// one is picked (see `render`) — deliberately NOT `aria-labelledby` pointing
// at the `<h2>` in `.run__head`, because that heading only gets text once a
// tool is picked: with nothing selected `.run` is `hidden` and the heading is
// empty, which would leave the region with an EMPTY accessible name at the
// app's own default, cold state — exactly the state a screen-reader user
// meets first through the second entry door. `aria-label` covers that cold
// state the same way a static string would, but also carries the tool's name
// through landmark navigation once one is picked, rather than every tool
// announcing as the same generic "Selected tool, region". The card itself
// carries no `aria-labelledby` of its own, so this is the only "Selected
// tool"/tool-name naming in play — no second heading duplicating the
// landmark's own name (contrast `zones/files.ts`, where reusing
// `filetray.ts`'s own heading was the carry-forward fix, not a pattern to
// repeat here).

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
  root.setAttribute('aria-label', 'Selected tool');

  // The prompt this whole task exists to restore: cut in Task 9 ("Task 10 can
  // add it if the new grid layout turns out to need a placeholder box"),
  // never revisited once Task 10 shipped the permanent three-column sticky
  // layout — the condition was met and nobody came back for it. Without this,
  // the column beside the catalogue is bare page background until a tool is
  // picked, and the second sentence is the discoverability hook for the
  // headline feature: a first-time visitor has no other way to learn the QR
  // generator needs no file before trying it.
  const empty = el('div', 'zone__empty');
  empty.append(
    el('p', undefined, 'Pick a tool to get started.'),
    el('p', 'zone__hint', 'Some tools need files; the QR code generator does not.'),
  );

  // The one thing this zone shows or hides besides `empty` above.
  const panel = el('section', 'run');
  panel.hidden = true;

  const glyph = el('span', 'run__glyph');
  const heading = el('h2', 'panel__title', '');
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
  // exists to remove. `aria-disabled`, not the native `disabled` attribute —
  // see the followups doc's "disabled -> aria-disabled" entry — so the
  // button STAYS focusable and the reason is reachable by anyone who relies
  // on focus to read it (a screen-magnifier user, for instance), rather than
  // only by a screen reader's virtual cursor. That trades away the free
  // browser behaviour a real `disabled` button gets, so the click handler
  // below has to re-implement it explicitly.
  const runLabel = el('span', undefined, 'Run');
  runButton.append(icon('play'), runLabel);
  function handleRunClick(): void {
    if (runButton.getAttribute('aria-disabled') === 'true') return;
    init.onRun();
  }
  runButton.addEventListener('click', handleRunClick);

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
  root.append(empty, panel);

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
      empty.hidden = tool !== null;
      panel.hidden = tool === null;
      // Unconditional, unlike `heading.textContent` below: the landmark needs
      // a name in BOTH branches, not only once a tool is picked, so it cannot
      // wait behind the early return this function takes when `tool` is null.
      root.setAttribute('aria-label', tool ? tool.name : 'Selected tool');

      // Run's disabled state (and Cancel's / the ring's visibility) is
      // settled BEFORE the early return below. With no tool the panel is
      // hidden and the snapshot's `runBlockedReason` is 'Pick a tool
      // first.', which must not latch the button: forcing `blocked` to
      // `null` here means Run's disabled state tracks ONLY `running` once
      // the selection is gone, so clearing it mid-run does not leave Run
      // stuck disabled behind the hidden panel once the run ends.
      //
      // Forced to `null` while RUNNING too, for a related reason: F1's fix
      // (state.ts's `pruneSelection`) deliberately lets the file set change
      // underneath a live selection while a job runs, rather than tearing
      // the card down — which means `runBlockedReason` can start describing
      // a mismatch mid-run purely because a file was added or removed. Run
      // is already disabled by `running` alone at that point (see the very
      // next line), so nothing is lost by not also swapping its LABEL to a
      // reason that has nothing to do with the job actually in flight —
      // showing it would be a false sentence next to a spinning Cancel.
      const running = snapshot.phase === 'running';
      const blocked = tool === null || running ? null : snapshot.runBlockedReason;
      runButton.setAttribute('aria-disabled', String(running || blocked !== null));
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
      runButton.removeEventListener('click', handleRunClick);
      cancel.removeEventListener('click', init.onCancel);
    },
  };
}
