// src/ui/shell.ts — one screen, driven by the state machine in ./state.
//
// The shell knows nothing about PDFs, images or archives. It knows how to:
//   sniff what arrived -> ask the registry what applies -> render that tool's
//   options -> run it -> show what came back.
//
// WHAT the screen should show is not decided here. `state.ts` holds the files,
// the selection, the three applicability tiers and the reason Run is blocked,
// and it is unit-testable under plain Node because it never touches the DOM.
// This file subscribes once and does nothing but paint the snapshot it is
// handed: every reader below goes through `snap`, and every mutation goes
// through `state.*` and comes back as a notification.
//
// The product decision this file exists to serve is DROP FIRST, CHOOSE SECOND
// (§7.1): tools are never offered before the files are in, and once they are in,
// the grid ranks them in the three tiers `applicabilityFor` returns. A tool that
// does not fit the TYPES on the tray is absent, never greyed, so the grid stays
// scannable. The two exceptions earn their place:
//
//   blocked — the type fits and only the COUNT is wrong. Rendering it disabled
//             with the count it wants answers "can this app do that at all?",
//             which an empty space answers wrongly.
//   utility — runs on any bytes, so it always fits and never distinguishes one
//             drop from another. A quiet pill row, below the grid it would
//             otherwise flood.
//
// There is NO NAVIGATION (§7.2). The hero dropzone dissolves into the workbench,
// choosing a tool expands its options inline, and results appear beneath.
//
// Everything heavy is behind a dynamic import: `core/pipeline` (and through it
// `core/fs` + fflate + the worker pool) is fetched when the first run starts and
// prefetched on the first intake, so it is warm before the click. That is what
// keeps the entry chunk inside the §1 budget.

import { label, sniffType, type Applicability } from '../core/format';
import { TOOLS, getTool, toolsFor } from '../core/registry';
import type { Job, JobResult, OpErrorCode, ToolDef } from '../types';
import { el, icon } from './dom';
import { createDropzone } from './dropzone';
import { disabledFormatChoices } from './encoder';
import { createFileTray, type FileTrayHandle, type TrayEntry } from './filetray';
import { morphToTray, revealTools } from './motion';
import { defaultOptions, renderOptions, type OptionsHandle } from './optionspanel';
import { createPalette } from './palette';
import { prefetchModule, prefetchTool } from './prefetch';
import { createProgressRing } from './progress';
import { createResults } from './results';
import { createState } from './state';
import { createThemeControl } from './theme';
import { GROUP_ICON, GROUP_ORDER, GROUP_TITLE, toolIcon } from './toolicons';

export type ShellHandle = { destroy(): void };

/** Magic-byte sniffing only needs the head of the file, not all of it. */
const SNIFF_BYTES = 32;

/** Which modifier this platform actually shows for a shortcut (⌘ vs Ctrl). */
const MOD = typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent) ? '⌘' : 'Ctrl';

/** Narrow an unknown rejection to something the results tray can render. */
function asFailure(error: unknown): { code: OpErrorCode; message: string; file?: string } {
  if (typeof error === 'object' && error !== null) {
    const shape = error as { code?: unknown; message?: unknown; file?: unknown };
    if (typeof shape.code === 'string') {
      return {
        code: shape.code as OpErrorCode,
        message: typeof shape.message === 'string' ? shape.message : 'The run failed.',
        file: typeof shape.file === 'string' ? shape.file : undefined,
      };
    }
  }
  return {
    code: 'OutOfMemory',
    message: error instanceof Error ? error.message : String(error),
  };
}

export function mountShell(root: HTMLElement): ShellHandle {
  // ---------------------------------------------------------------- state
  // The machine owns the files, the selection and everything derived from
  // them; `snap` is the last thing it said. Nothing below writes to it.
  const state = createState(TOOLS);
  let snap = state.snapshot();

  // What the shell owns is the DOM: the mounted options panel, the running
  // job, and the "what is already painted" guards that keep this file from
  // rebuilding surfaces that have not changed.
  let options: Record<string, unknown> = {};
  let panel: OptionsHandle | null = null;
  let job: Job | null = null;
  let gridRevealed = false;
  let lastGridSignature = '';
  let lastFilesSignature = '';
  /**
   * The tool the run panel currently DESCRIBES — not a second copy of the
   * selection. The machine drops a selection whose TYPE no longer fits all on
   * its own (state.ts's `pruneSelection`), so by the time `refreshTools` sees
   * the new snapshot the selection is already gone while its options panel is
   * still mounted. This is what remembers it long enough to tear that down.
   *
   * It is written by `syncRunPanel`, which the subscriber calls AFTER
   * `refreshTools` — see the ordering note there before touching either.
   */
  let shownTool: ToolDef | null = null;

  // ------------------------------------------------------------- chrome
  const live = el('div', 'sr-only');
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');

  function announce(message: string): void {
    // Re-setting identical text does not re-announce; the clear forces it.
    live.textContent = '';
    live.textContent = message;
  }

  const topbar = el('header', 'topbar');
  const brand = el('div', 'brand');
  const brandMark = el('span', 'brand__mark');
  brandMark.append(icon('spark'));
  brand.append(brandMark, el('span', 'brand__name', 'omnitool'));
  const claim = el('p', 'brand__claim', 'Your files never leave this tab.');

  const themeControl = createThemeControl(announce);

  const paletteButton = el('button', 'btn btn--ghost btn--sm searchbtn');
  paletteButton.type = 'button';
  paletteButton.append(
    icon('search'),
    el('span', 'searchbtn__label', 'Search tools'),
    el('kbd', undefined, `${MOD} K`),
  );
  paletteButton.setAttribute('aria-label', `Search tools (${MOD} K)`);
  paletteButton.addEventListener('click', () => palette.open());

  const topbarInner = el('div', 'topbar__inner');
  topbarInner.append(brand, claim, paletteButton, themeControl.el);
  topbar.append(topbarInner);

  // --------------------------------------------------------------- stage
  const stage = el('main', 'stage');
  stage.id = 'stage';

  const results = createResults();
  const progress = createProgressRing();

  const dropzone = createDropzone({
    onFiles: (files) => void intake(files),
    // `palette` is created further down; this only runs on a click, long after.
    onBrowse: () => palette.open(),
    toolCount: TOOLS.length,
  });

  const tray: FileTrayHandle = createFileTray({
    onChange: (next) => {
      // The tray has already mutated its own DOM; mirror, never re-seed. The
      // machine's notification is what repaints everything else.
      state.setFiles(next);
    },
    announce,
  });

  const filesPanel = el('div', 'panel panel--files');
  const clearButton = el('button', 'btn btn--quiet btn--sm clearbtn', 'Remove all files');
  clearButton.type = 'button';
  clearButton.addEventListener('click', () => {
    // Before the machine emits: the next intake is a first paint again, and
    // `refreshTools` runs inside `clearFiles` rather than after it.
    gridRevealed = false;
    state.clearFiles();
    tray.setEntries([]);
    results.clear();
    announce('All files removed.');
    showHero();
    // Never strand the keyboard on a button that just disappeared.
    dropzone.focus();
  });
  filesPanel.append(dropzone.addbar, tray.el, clearButton);

  // tool grid
  const toolsPanel = el('section', 'tools');
  toolsPanel.setAttribute('aria-labelledby', 'tools-heading');
  const toolsHead = el('div', 'tools__head');
  const toolsHeading = el('h2', 'panel__title', 'Tools for these files');
  toolsHeading.id = 'tools-heading';
  const toolsCount = el('p', 'tools__count');
  toolsHead.append(toolsHeading, toolsCount);
  const toolsGrid = el('div', 'tools__groups');

  // A tool whose TYPE fits but whose COUNT does not is shown, disabled, with the
  // count it wants — silently omitting it reads as "this app cannot do that".
  const blockedGrid = el('div', 'toolgroup__grid');
  blockedGrid.hidden = true;

  // The any-bytes tier. Always applicable, never the reason anyone came, so it
  // is a quiet row under the grid rather than another eighteen cards.
  const utilityWrap = el('section', 'utility');
  utilityWrap.hidden = true;
  utilityWrap.append(el('h3', 'utility__title', 'Works on any file'));
  const utilityBar = el('div', 'utilitybar');
  utilityWrap.append(utilityBar);

  const toolsEmpty = el('p', 'tools__empty');
  toolsEmpty.hidden = true;
  toolsPanel.append(toolsHead, toolsGrid, blockedGrid, utilityWrap, toolsEmpty);

  // run panel
  const runPanel = el('section', 'run');
  runPanel.hidden = true;
  runPanel.setAttribute('aria-labelledby', 'run-heading');
  const runHead = el('div', 'run__head');
  const runGlyph = el('span', 'run__glyph');
  const runTitles = el('div', 'run__titles');
  const runHeading = el('h2', 'panel__title', '');
  runHeading.id = 'run-heading';
  const runBlurb = el('p', 'run__blurb');
  runTitles.append(runHeading, runBlurb);
  runHead.append(runGlyph, runTitles);
  const runOptions = el('div', 'run__options');
  const runBar = el('div', 'run__bar');

  const runButton = el('button', 'btn btn--primary');
  runButton.type = 'button';
  // Addressable, because when the run is blocked the REASON becomes the label:
  // a disabled button with no explanation is the thing this overhaul removes.
  const runLabel = el('span', undefined, 'Run');
  runButton.append(icon('play'), runLabel);

  const cancelButton = el('button', 'btn btn--ghost', 'Cancel');
  cancelButton.type = 'button';
  cancelButton.hidden = true;

  const progressWrap = el('div', 'run__progress');
  progressWrap.hidden = true;
  progressWrap.append(progress.el);

  runBar.append(runButton, cancelButton, progressWrap);
  runPanel.append(runHead, runOptions, runBar);

  const workPanel = el('div', 'panel panel--work');
  workPanel.append(toolsPanel, runPanel);

  const workbench = el('div', 'workbench');
  workbench.hidden = true;
  workbench.append(filesPanel, workPanel);

  const switcher = el('div', 'stageswitch');
  switcher.append(dropzone.hero, workbench);

  stage.append(switcher, results.el);

  const footer = el('footer', 'footer');
  const footerMark = el('span', 'footer__mark');
  footerMark.append(icon('spark'));
  const footerBrand = el('p', 'footer__brand');
  footerBrand.append(footerMark, el('span', undefined, 'omnitool'));
  footer.append(
    footerBrand,
    el(
      'p',
      'footer__text',
      'Open source, MIT licensed. No uploads, no accounts, no telemetry — every byte is processed by this browser.',
    ),
  );

  root.replaceChildren(topbar, stage, footer, live);

  // ------------------------------------------------------- the one wiring
  /**
   * Armed once the DOM these two paint exists, and before anything can emit.
   *
   * THE ORDER OF THESE TWO CALLS IS LOAD-BEARING. `syncRunPanel` is what
   * records `shownTool`, so while `refreshTools` runs, `shownTool` still holds
   * the PREVIOUS snapshot's selection — which is the only reason it can notice
   * a selection the machine pruned, and the only reason `syncEditor` can tell a
   * tool it has already painted from one selected a moment ago. Paint the panel
   * first and both of those silently stop working: a pruned tool's options are
   * left mounted with nothing announced, and selecting an editor tool builds
   * its board twice. `shell.browser.test.ts` fails on both counts if they swap.
   */
  const unsubscribe = state.subscribe((next) => {
    snap = next;
    refreshTools();
    syncRunPanel();
  });

  // ------------------------------------------------------------- intake
  async function intake(files: File[]): Promise<void> {
    const added: TrayEntry[] = [];
    for (const file of files) {
      const head = await file.slice(0, SNIFF_BYTES).arrayBuffer();
      added.push({ file, type: sniffType(head, file.name) });
    }
    if (added.length === 0) return;

    const wasEmpty = snap.entries.length === 0;
    // Emits, which is what refreshes the grid; the tray is the one surface the
    // machine does not drive, so it is mirrored from the new snapshot.
    state.addFiles(added);
    tray.setEntries([...snap.entries]);

    // The first run is the only one that pays for the pipeline chunk; warm it
    // while the user is still reading the tool grid.
    prefetchModule('core:pipeline', () => import('../core/pipeline'));

    if (wasEmpty) await showWorkbench();

    const types = [...new Set(added.map((entry) => label(entry.type)))].join(', ');
    announce(
      `${added.length} ${added.length === 1 ? 'file' : 'files'} added (${types}). ${toolsFor(mimes()).length} tools available.`,
    );
  }

  function mimes(): string[] {
    return snap.entries.map((entry) => entry.type);
  }

  async function showWorkbench(): Promise<void> {
    workbench.hidden = false;
    dropzone.hero.classList.add('is-exiting');
    await morphToTray(dropzone.hero, workbench);
    dropzone.hero.hidden = true;
  }

  function showHero(): void {
    workbench.hidden = true;
    dropzone.hero.hidden = false;
    dropzone.hero.classList.remove('is-exiting');
    dropzone.hero.style.opacity = '';
    dropzone.hero.style.transform = '';
  }

  // -------------------------------------------------------------- tools
  /**
   * Identity of the tool grid's CONTENT, so a reorder does not rebuild it.
   * All THREE buckets go in: a change confined to the blocked or utility tier
   * is still a change, and hashing only `primary` would leave it unpainted.
   */
  function gridSignature(app: Applicability): string {
    return [
      snap.entries.length,
      app.primary.map((tool) => tool.id).join(','),
      app.blocked.map((blocked) => blocked.tool.id).join(','),
      app.utility.map((tool) => tool.id).join(','),
    ].join('|');
  }

  /** Identity of the FILES, so an editor built from them can be kept in sync. */
  function filesSignature(): string {
    return snap.entries.map((entry) => `${entry.file.name}:${entry.file.size}`).join('|');
  }

  function refreshTools(): void {
    // The machine has already bucketed the tools for this file set; asking the
    // registry again here would be a second, divergeable answer.
    const app: Applicability = snap.applicability;

    const signature = gridSignature(app);
    if (signature === lastGridSignature) {
      // A pure reorder. The grid is unchanged, but an editor whose input IS the
      // file list (crop, organize) has to be rebuilt from the new order.
      syncEditor();
      return;
    }
    lastGridSignature = signature;

    toolsGrid.replaceChildren();
    blockedGrid.replaceChildren();

    const cards: HTMLElement[] = [];
    for (const group of GROUP_ORDER) {
      const inGroup = app.primary.filter((tool) => tool.group === group);
      if (inGroup.length === 0) continue;

      const section = el('div', 'toolgroup');
      section.dataset.kind = group;
      const head = el('div', 'toolgroup__head');
      const glyph = el('span', 'toolgroup__icon');
      glyph.append(icon(GROUP_ICON[group]));
      head.append(
        glyph,
        el('h3', 'toolgroup__title', GROUP_TITLE[group]),
        el('span', 'toolgroup__count', String(inGroup.length)),
      );
      section.append(head);
      const grid = el('div', 'toolgroup__grid');
      for (const tool of inGroup) grid.append(toolCard(tool, cards));
      section.append(grid);
      toolsGrid.append(section);
    }

    for (const { tool, reason } of app.blocked) {
      const card = toolCard(tool, cards);
      card.classList.add('toolcard--blocked');
      card.disabled = true;
      card.append(el('span', 'toolcard__reason', reason));
      blockedGrid.append(card);
    }
    blockedGrid.hidden = app.blocked.length === 0;

    utilityBar.replaceChildren();
    for (const tool of app.utility) {
      const pill = el('button', 'utilitypill');
      pill.type = 'button';
      pill.dataset.tool = tool.id;
      pill.setAttribute('aria-pressed', 'false');
      pill.append(icon(toolIcon(tool)), el('span', undefined, tool.name));
      pill.addEventListener('click', () => void select(tool.id));
      utilityBar.append(pill);
    }
    utilityWrap.hidden = app.utility.length === 0;

    const count = snap.entries.length;
    const subject = count === 1 ? 'this file' : `these ${count} files`;
    const runnable = app.primary.length + app.utility.length;
    toolsCount.textContent =
      runnable === 0 ? '' : `${runnable === 1 ? '1 tool' : `${runnable} tools`} can run on ${subject}.`;

    toolsEmpty.hidden = runnable > 0;
    if (runnable === 0 && count > 0) {
      toolsEmpty.textContent =
        'No tool works with this exact mix of files. Remove the odd one out — most tools want every file to be the same kind.';
    }

    // Keep the selection only while it is still valid for what is in the tray.
    // A blocked card is not selectable, so it is not in this list.
    //
    // The question is asked of `shownTool` as well as of the snapshot: a tool
    // the machine has already pruned needs exactly the same teardown, and only
    // the shell knows it was on screen a moment ago.
    const selectable = [...app.primary, ...app.utility];
    const current = snap.selected ?? shownTool;
    if (current && !selectable.some((tool) => tool.id === current.id)) {
      clearSelection();
      announce('The selected tool no longer fits these files, so it was cleared.');
    } else if (snap.selected) {
      markSelected(snap.selected.id);
      syncEditor();
    }

    // §8: the stagger is the grid's FIRST paint only. Re-filtering is not an
    // entrance, and animating it every time would be decoration.
    if (!gridRevealed && cards.length > 0) {
      gridRevealed = true;
      void revealTools(cards);
    }
  }

  function toolCard(tool: ToolDef, sink: HTMLElement[]): HTMLButtonElement {
    const card = el('button', 'toolcard');
    card.type = 'button';
    card.dataset.tool = tool.id;
    card.dataset.kind = tool.group;
    card.setAttribute('aria-pressed', 'false');

    // Selection is marked by a tick as well as by colour — colour alone would
    // fail WCAG 1.4.1 for anyone who cannot distinguish the accent.
    const top = el('span', 'toolcard__top');
    const glyph = el('span', 'toolcard__icon');
    glyph.append(icon(toolIcon(tool)));
    const check = el('span', 'toolcard__check');
    check.append(icon('check'));
    top.append(glyph, el('span', 'toolcard__name', tool.name), check);
    card.append(top, el('span', 'toolcard__blurb', tool.blurb));

    // Intent prefetch (§6.1 mechanism 5) on BOTH pointer and keyboard intent.
    const warm = (): void => prefetchTool(tool);
    card.addEventListener('pointerenter', warm);
    card.addEventListener('focus', warm);

    card.addEventListener('click', () => void select(tool.id));
    sink.push(card);
    return card;
  }

  /** Both tiers: a utility pill is as selectable as a card, so it marks the same. */
  function markSelected(id: string | null): void {
    for (const node of toolsPanel.querySelectorAll<HTMLElement>('.toolcard, .utilitypill')) {
      const on = node.dataset.tool === id;
      node.classList.toggle('is-selected', on);
      node.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function clearSelection(): void {
    panel?.destroy();
    panel = null;
    options = {};
    lastFilesSignature = '';
    progressWrap.hidden = true;
    // Forgotten BEFORE the machine is told, or the notification below would
    // find a painted tool that is no longer selectable and clear it again.
    shownTool = null;
    markSelected(null);
    // Emits: `syncRunPanel` is what hides the panel.
    state.selectTool(null);
  }

  /**
   * The run panel is a pure function of the snapshot — and the one place that
   * records WHICH tool it painted, in `shownTool`.
   */
  function syncRunPanel(): void {
    const tool = snap.selected;
    shownTool = tool;
    runPanel.hidden = tool === null;

    // Run's state is settled BEFORE the early return. With no tool the panel is
    // hidden and the snapshot's reason is 'Pick a tool first.', which must not
    // latch the button: clearing the selection mid-run would then leave it
    // disabled behind the hidden panel, where the unconditional
    // `runButton.disabled = on` this replaced left it live.
    const blocked = tool === null ? null : snap.runBlockedReason;
    runButton.disabled = snap.phase === 'running' || blocked !== null;
    if (!tool) return;

    runHeading.textContent = tool.name;
    runBlurb.textContent = tool.blurb;
    runGlyph.replaceChildren(icon(toolIcon(tool)));
    runPanel.dataset.kind = tool.group;

    // The reason IS the label. Cancel and the progress ring stay with
    // `setRunning`, which also has to decide where stranded focus goes.
    runLabel.textContent = blocked ?? 'Run';
  }

  /** Build (or rebuild) the options surface for `tool`. */
  async function mountOptions(tool: ToolDef): Promise<void> {
    lastFilesSignature = filesSignature();
    // A preset reads the files' METADATA only — the sniffed type, not contents.
    const sniffed = snap.entries.map((entry) => ({
      name: entry.file.name,
      size: entry.file.size,
      type: entry.type,
    }));
    const preset = tool.preset?.(sniffed);
    options = defaultOptions(tool.options, preset?.values);

    panel?.destroy();
    panel = null;

    // Probe the encoders BEFORE offering a format, so an unsupported choice is
    // disabled with the reason visible rather than offered and then failed (§5.2).
    const disabled = await disabledFormatChoices(tool.options);
    if (snap.selected?.id !== tool.id) return;

    const mounted = renderOptions({
      tool,
      files: snap.entries.map((entry) => entry.file),
      onChange: (next) => {
        options = next;
      },
      disabled,
      presetValues: preset?.values,
      presetBecause: preset?.because,
    });
    panel = mounted;
    options = { ...options, ...mounted.values() };
    runOptions.replaceChildren(mounted.el);
  }

  /**
   * An `editor` derives its options FROM the files (crop rectangle, page board),
   * so when the file list changes underneath it, keeping the old one would hand
   * the op options describing files that are no longer there.
   */
  function syncEditor(): void {
    const tool = snap.selected;
    // Only a tool the run panel is ALREADY showing can be out of sync. A
    // selection made this instant has not been painted yet, and mounting it
    // here would race `select()`'s own mount and build the board twice.
    if (!tool?.editor || shownTool?.id !== tool.id || snap.phase === 'running') return;
    const signature = filesSignature();
    if (signature === lastFilesSignature) return;
    void mountOptions(tool);
  }

  async function select(id: string): Promise<void> {
    if (snap.phase === 'running') return;
    const tool = getTool(id);
    if (!tool) return;
    if (snap.selected?.id === id) {
      clearSelection();
      announce('Tool deselected.');
      return;
    }

    // Emits: `syncRunPanel` fills the head in and reveals the panel. The grid
    // is not rebuilt by that (its content is unchanged), so the tick still has
    // to be moved here.
    state.selectTool(id);
    markSelected(id);
    progressWrap.hidden = true;
    announce(`${tool.name} selected. ${tool.blurb}`);

    await mountOptions(tool);
    if (snap.selected?.id !== id) return;
    // The e2e suite waits on this: Run taking focus is the app's own race-free
    // "ready" signal, and it lands only once the options have mounted.
    runButton.focus();
  }

  // ---------------------------------------------------------------- run
  function setRunning(on: boolean): void {
    // Disabling the focused element blurs it (moves focus to <body>) in every
    // browser — a keyboard user who just activated Run or Remove-all must not
    // be dropped onto nothing. Cancel is about to become the one live,
    // meaningful control, so focus follows there instead. Read BEFORE the
    // machine emits, because that emit is what disables Run.
    const stranded =
      on && (document.activeElement === runButton || document.activeElement === clearButton);
    state.setRunning(on);
    cancelButton.hidden = !on;
    progressWrap.hidden = !on;
    clearButton.disabled = on;
    if (stranded) cancelButton.focus();
  }

  async function start(): Promise<void> {
    const tool = snap.selected;
    if (!tool || snap.phase === 'running') return;

    const files = snap.entries.map((entry) => entry.file);
    // The sniffed type comes along so the results tray can tell whether an
    // input and an output are even the same kind of thing before it offers a
    // size comparison. entry.type is the magic-byte result, not the browser's
    // guess from the extension.
    const inputs = snap.entries.map((entry) => ({
      name: entry.file.name,
      size: entry.file.size,
      type: entry.type,
    }));

    setRunning(true);
    progress.reset();
    progress.setLabel(`${tool.name}…`);
    results.clear();
    announce(`${tool.name} started on ${files.length} ${files.length === 1 ? 'file' : 'files'}.`);

    let result: JobResult | undefined;
    let failure: { code: OpErrorCode; message: string; file?: string } | undefined;

    try {
      const { run } = await import('../core/pipeline');
      const active = run(tool.id, files, options);
      job = active;

      let quarter = 0;
      active.onProgress((fraction) => {
        progress.set(fraction);
        const step = Math.floor(fraction * 4);
        if (step > quarter && step < 4) {
          quarter = step;
          announce(`${tool.name}, ${step * 25} percent.`);
        }
      });

      result = await active.done;
      progress.set(1);
    } catch (error) {
      failure = asFailure(error);
    } finally {
      job = null;
      setRunning(false);
    }

    await results.show({ toolName: tool.name, inputs, result, error: failure });

    if (failure) {
      announce(
        failure.code === 'Cancelled'
          ? `${tool.name} cancelled. Nothing was written.`
          : `${tool.name} failed: ${failure.message}`,
      );
    } else if (result?.partial) {
      const failed = result.results.filter((entry) => entry.status === 'failed').length;
      announce(
        `Partial result. ${result.results.length - failed} of ${result.results.length} files processed, ${failed} failed. Details are in the results.`,
      );
    } else {
      const made = result?.outputs.length ?? 0;
      announce(`${tool.name} finished. ${made} ${made === 1 ? 'file' : 'files'} ready.`);
    }

    results.el.scrollIntoView({ block: 'nearest' });
  }

  runButton.addEventListener('click', () => void start());
  cancelButton.addEventListener('click', () => {
    job?.cancel();
    announce('Cancelling…');
  });

  // -------------------------------------------------------------- palette
  /** Why `tool` can't run right now, or `null` when it can (Task 7). */
  function unavailableReason(tool: ToolDef): string | null {
    if (snap.entries.length === 0) return 'Drop files first — nothing is loaded yet.';
    if (!toolsFor(mimes()).some((candidate) => candidate.id === tool.id)) {
      return `${tool.name} doesn’t work with these files.`;
    }
    return null;
  }

  /**
   * The palette has already confirmed `tool` fits (via `unavailableReason`)
   * and has closed itself. Select it exactly like clicking its card would —
   * unless it already IS the selection, in which case calling `select` again
   * would TOGGLE it off (that codepath exists for the card's click-to-
   * deselect behaviour, which the palette must not trigger).
   *
   * A tool with a bespoke `editor` (crop, organize) cannot be run blind: its
   * options only mean something once the user has interacted with the board.
   * For those, the palette selects and stops — the same state a card click
   * leaves it in.
   */
  async function runFromPalette(tool: ToolDef): Promise<void> {
    if (snap.phase === 'running') return;
    if (snap.selected?.id !== tool.id) {
      await select(tool.id);
    } else {
      runPanel.hidden = false;
    }
    if (snap.selected?.id === tool.id && !tool.editor) {
      await start();
    }
  }

  const palette = createPalette({
    tools: TOOLS,
    unavailableReason,
    announce,
    onRun: (tool) => void runFromPalette(tool),
  });
  document.body.append(palette.el);

  function onGlobalKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      palette.open();
    }
  }
  document.addEventListener('keydown', onGlobalKeydown);

  return {
    destroy(): void {
      unsubscribe();
      job?.cancel();
      panel?.destroy();
      tray.destroy();
      dropzone.destroy();
      document.removeEventListener('keydown', onGlobalKeydown);
      palette.destroy();
      themeControl.destroy();
      root.replaceChildren();
    },
  };
}
