// src/ui/shell.ts — one screen, and the state machine behind it.
//
// The shell knows nothing about PDFs, images or archives. It knows how to:
//   sniff what arrived -> ask the registry what applies -> render that tool's
//   options -> run it -> show what came back.
//
// The product decision this file exists to serve is DROP FIRST, CHOOSE SECOND
// (§7.1): tools are never offered before the files are in, and once they are in,
// only the APPLICABLE tools are rendered. Inapplicable tools are absent, not
// greyed, so the grid stays scannable.
//
// There is NO NAVIGATION (§7.2). The hero dropzone dissolves into the workbench,
// choosing a tool expands its options inline, and results appear beneath.
//
// Everything heavy is behind a dynamic import: `core/pipeline` (and through it
// `core/fs` + fflate + the worker pool) is fetched when the first run starts and
// prefetched on the first intake, so it is warm before the click. That is what
// keeps the entry chunk inside the §1 budget.

import { label, sniffType } from '../core/format';
import { getTool, toolsFor } from '../core/registry';
import type { Job, JobResult, OpErrorCode, ToolDef, ToolGroup } from '../types';
import { el, icon } from './dom';
import { createDropzone } from './dropzone';
import { disabledFormatChoices } from './encoder';
import { createFileTray, type FileTrayHandle, type TrayEntry } from './filetray';
import { morphToTray, revealTools } from './motion';
import { defaultOptions, renderOptions, type OptionsHandle } from './optionspanel';
import { prefetchModule, prefetchTool } from './prefetch';
import { createProgressRing } from './progress';
import { createResults } from './results';

export type ShellHandle = { destroy(): void };

const GROUP_TITLE: Record<ToolGroup, string> = {
  pdf: 'PDF',
  image: 'Images',
  data: 'Data & text',
};

const GROUP_ORDER: ToolGroup[] = ['pdf', 'image', 'data'];

const THEME_KEY = 'omnitool:theme';
type ThemePref = 'system' | 'light' | 'dark';
const THEME_CYCLE: ThemePref[] = ['system', 'dark', 'light'];
const THEME_NAME: Record<ThemePref, string> = {
  system: 'Theme: match the system',
  dark: 'Theme: dark',
  light: 'Theme: light',
};

/** Magic-byte sniffing only needs the head of the file, not all of it. */
const SNIFF_BYTES = 32;

function readThemePref(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage can be blocked; the system default is a fine answer.
  }
  return 'system';
}

function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
}

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
  let entries: TrayEntry[] = [];
  let selected: ToolDef | null = null;
  let options: Record<string, unknown> = {};
  let panel: OptionsHandle | null = null;
  let job: Job | null = null;
  let running = false;
  let gridRevealed = false;
  let lastGridSignature = '';
  let lastFilesSignature = '';
  let theme = readThemePref();

  applyThemePref(theme);

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

  const themeButton = el('button', 'btn btn--icon');
  themeButton.type = 'button';
  themeButton.append(icon('theme'));
  function paintThemeButton(): void {
    themeButton.title = THEME_NAME[theme];
    themeButton.setAttribute('aria-label', `${THEME_NAME[theme]}. Change.`);
    themeButton.dataset.theme = theme;
  }
  paintThemeButton();
  themeButton.addEventListener('click', () => {
    const at = THEME_CYCLE.indexOf(theme);
    theme = THEME_CYCLE[(at + 1) % THEME_CYCLE.length] ?? 'system';
    applyThemePref(theme);
    paintThemeButton();
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // A blocked storage is not an error worth showing anyone.
    }
    announce(THEME_NAME[theme]);
  });

  topbar.append(brand, claim, themeButton);

  // --------------------------------------------------------------- stage
  const stage = el('main', 'stage');
  stage.id = 'stage';

  const results = createResults();
  const progress = createProgressRing();

  const dropzone = createDropzone({ onFiles: (files) => void intake(files) });

  const tray: FileTrayHandle = createFileTray({
    onChange: (next) => {
      // The tray has already mutated its own DOM; mirror, never re-seed.
      entries = next;
      refreshTools();
    },
    announce,
  });

  const filesPanel = el('div', 'panel panel--files');
  const clearButton = el('button', 'btn btn--quiet btn--sm', 'Remove all files');
  clearButton.type = 'button';
  clearButton.addEventListener('click', () => {
    entries = [];
    tray.setEntries([]);
    results.clear();
    gridRevealed = false;
    refreshTools();
    announce('All files removed.');
    showHero();
    // Never strand the keyboard on a button that just disappeared.
    dropzone.focus();
  });
  filesPanel.append(dropzone.addbar, tray.el, clearButton);

  // tool grid
  const toolsPanel = el('section', 'tools');
  toolsPanel.setAttribute('aria-labelledby', 'tools-heading');
  const toolsHeading = el('h2', 'panel__title', 'Tools for these files');
  toolsHeading.id = 'tools-heading';
  const toolsCount = el('p', 'tools__count');
  const toolsGrid = el('div', 'tools__groups');
  const toolsEmpty = el('p', 'tools__empty');
  toolsEmpty.hidden = true;
  toolsPanel.append(toolsHeading, toolsCount, toolsGrid, toolsEmpty);

  // run panel
  const runPanel = el('section', 'run');
  runPanel.hidden = true;
  runPanel.setAttribute('aria-labelledby', 'run-heading');
  const runHeading = el('h2', 'panel__title');
  runHeading.id = 'run-heading';
  const runBlurb = el('p', 'run__blurb');
  const runOptions = el('div', 'run__options');
  const runBar = el('div', 'run__bar');

  const runButton = el('button', 'btn btn--primary');
  runButton.type = 'button';
  runButton.append(icon('play'), el('span', undefined, 'Run'));

  const cancelButton = el('button', 'btn btn--ghost', 'Cancel');
  cancelButton.type = 'button';
  cancelButton.hidden = true;

  const progressWrap = el('div', 'run__progress');
  progressWrap.hidden = true;
  progressWrap.append(progress.el);

  runBar.append(runButton, cancelButton, progressWrap);
  runPanel.append(runHeading, runBlurb, runOptions, runBar);

  const workPanel = el('div', 'panel panel--work');
  workPanel.append(toolsPanel, runPanel);

  const workbench = el('div', 'workbench');
  workbench.hidden = true;
  workbench.append(filesPanel, workPanel);

  const switcher = el('div', 'stageswitch');
  switcher.append(dropzone.hero, workbench);

  stage.append(switcher, results.el);

  const footer = el('footer', 'footer');
  footer.append(
    el(
      'p',
      undefined,
      'Open source, MIT licensed. No uploads, no accounts, no telemetry — every byte is processed by this browser.',
    ),
  );

  root.replaceChildren(topbar, stage, footer, live);

  // ------------------------------------------------------------- intake
  async function intake(files: File[]): Promise<void> {
    const added: TrayEntry[] = [];
    for (const file of files) {
      const head = await file.slice(0, SNIFF_BYTES).arrayBuffer();
      added.push({ file, type: sniffType(head, file.name) });
    }
    if (added.length === 0) return;

    const wasEmpty = entries.length === 0;
    entries = [...entries, ...added];
    tray.setEntries(entries);
    refreshTools();

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
    return entries.map((entry) => entry.type);
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
  /** Identity of the tool grid's CONTENT, so a reorder does not rebuild it. */
  function gridSignature(applicable: ToolDef[]): string {
    return `${entries.length}|${applicable.map((tool) => tool.id).join(',')}`;
  }

  /** Identity of the FILES, so an editor built from them can be kept in sync. */
  function filesSignature(): string {
    return entries.map((entry) => `${entry.file.name}:${entry.file.size}`).join('|');
  }

  function refreshTools(): void {
    const applicable = entries.length === 0 ? [] : toolsFor(mimes());

    const signature = gridSignature(applicable);
    if (signature === lastGridSignature) {
      // A pure reorder. The grid is unchanged, but an editor whose input IS the
      // file list (crop, organize) has to be rebuilt from the new order.
      syncEditor();
      return;
    }
    lastGridSignature = signature;

    toolsGrid.replaceChildren();

    const cards: HTMLElement[] = [];
    for (const group of GROUP_ORDER) {
      const inGroup = applicable.filter((tool) => tool.group === group);
      if (inGroup.length === 0) continue;

      const section = el('div', 'toolgroup');
      section.append(el('h3', 'toolgroup__title', GROUP_TITLE[group]));
      const grid = el('div', 'toolgroup__grid');
      for (const tool of inGroup) grid.append(toolCard(tool, cards));
      section.append(grid);
      toolsGrid.append(section);
    }

    const subject = entries.length === 1 ? 'this file' : `these ${entries.length} files`;
    toolsCount.textContent =
      applicable.length === 0
        ? ''
        : `${applicable.length === 1 ? '1 tool' : `${applicable.length} tools`} can run on ${subject}.`;

    toolsEmpty.hidden = applicable.length > 0;
    if (applicable.length === 0 && entries.length > 0) {
      toolsEmpty.textContent =
        'No tool works with this exact mix of files. Remove the odd one out — most tools want every file to be the same kind.';
    }

    // Keep the selection only while it is still valid for what is in the tray.
    if (selected && !applicable.some((tool) => tool.id === selected?.id)) {
      clearSelection();
      announce('The selected tool no longer fits these files, so it was cleared.');
    } else if (selected) {
      markSelected(selected.id);
      syncEditor();
    }

    // §8: the stagger is the grid's FIRST paint only. Re-filtering is not an
    // entrance, and animating it every time would be decoration.
    if (!gridRevealed && cards.length > 0) {
      gridRevealed = true;
      void revealTools(cards);
    }
  }

  function toolCard(tool: ToolDef, sink: HTMLElement[]): HTMLElement {
    const card = el('button', 'toolcard');
    card.type = 'button';
    card.dataset.tool = tool.id;
    card.setAttribute('aria-pressed', 'false');

    // Selection is marked by a tick as well as by colour — colour alone would
    // fail WCAG 1.4.1 for anyone who cannot distinguish the accent.
    const top = el('span', 'toolcard__top');
    const check = el('span', 'toolcard__check');
    check.append(icon('check'));
    top.append(el('span', 'toolcard__name', tool.name), check);
    card.append(top, el('span', 'toolcard__blurb', tool.blurb));

    // Intent prefetch (§6.1 mechanism 5) on BOTH pointer and keyboard intent.
    const warm = (): void => prefetchTool(tool);
    card.addEventListener('pointerenter', warm);
    card.addEventListener('focus', warm);

    card.addEventListener('click', () => void select(tool.id));
    sink.push(card);
    return card;
  }

  function markSelected(id: string | null): void {
    for (const card of toolsGrid.querySelectorAll<HTMLElement>('.toolcard')) {
      const on = card.dataset.tool === id;
      card.classList.toggle('is-selected', on);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  function clearSelection(): void {
    selected = null;
    panel?.destroy();
    panel = null;
    options = {};
    lastFilesSignature = '';
    runPanel.hidden = true;
    progressWrap.hidden = true;
    markSelected(null);
  }

  /** Build (or rebuild) the options surface for `tool`. */
  async function mountOptions(tool: ToolDef): Promise<void> {
    lastFilesSignature = filesSignature();
    options = defaultOptions(tool.options);

    panel?.destroy();
    panel = null;

    // Probe the encoders BEFORE offering a format, so an unsupported choice is
    // disabled with the reason visible rather than offered and then failed (§5.2).
    const disabled = await disabledFormatChoices(tool.options);
    if (selected?.id !== tool.id) return;

    const mounted = renderOptions({
      tool,
      files: entries.map((entry) => entry.file),
      onChange: (next) => {
        options = next;
      },
      disabled,
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
    if (!selected?.editor || running) return;
    const signature = filesSignature();
    if (signature === lastFilesSignature) return;
    void mountOptions(selected);
  }

  async function select(id: string): Promise<void> {
    if (running) return;
    const tool = getTool(id);
    if (!tool) return;
    if (selected?.id === id) {
      clearSelection();
      announce('Tool deselected.');
      return;
    }

    selected = tool;
    markSelected(id);
    runHeading.textContent = tool.name;
    runBlurb.textContent = tool.blurb;
    runPanel.hidden = false;
    progressWrap.hidden = true;
    announce(`${tool.name} selected. ${tool.blurb}`);

    await mountOptions(tool);
    if (selected?.id !== id) return;
    runButton.focus();
  }

  // ---------------------------------------------------------------- run
  function setRunning(on: boolean): void {
    running = on;
    runButton.disabled = on;
    cancelButton.hidden = !on;
    progressWrap.hidden = !on;
    clearButton.disabled = on;
  }

  async function start(): Promise<void> {
    const tool = selected;
    if (!tool || running) return;

    const files = entries.map((entry) => entry.file);
    const inputs = files.map((file) => ({ name: file.name, size: file.size }));

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

  return {
    destroy(): void {
      job?.cancel();
      panel?.destroy();
      tray.destroy();
      dropzone.destroy();
      root.replaceChildren();
    },
  };
}
