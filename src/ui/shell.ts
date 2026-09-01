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
// The product decision this file exists to serve is TWO EQUAL ENTRY DOORS —
// drop files and the grid narrows to what can run on them, or pick a tool
// first, cold, straight off the always-visible catalogue (ui/zones/catalogue.ts)
// and bring files after. Once files ARE in, the grid ranks tools in the three
// tiers `applicabilityFor` returns. A tool that does not fit the TYPES on the
// tray is absent, never greyed, so the grid stays scannable. The two
// exceptions earn their place:
//
//   blocked — the type fits and only the COUNT is wrong. Rendering it disabled
//             with the count it wants answers "can this app do that at all?",
//             which an empty space answers wrongly.
//   utility — runs on any bytes, so it always fits and never distinguishes one
//             drop from another. A quiet pill row, below the grid it would
//             otherwise flood.
//
// This supersedes v1's §7.1 ("drop first, choose second") and §7.2 ("one
// screen, no navigation") — see the superseding note at the top of §7 in
// docs/superpowers/specs/2026-08-29-omnitool-design.md. Navigation is real
// now: every tool gets its own bookmarkable, shareable hash URL (./router.ts),
// and picking one cold from the catalogue is a route, exactly like a deep
// link. What survives from "one screen": the hero dropzone still dissolves
// into the always-mounted three-zone workbench on the first file or the first
// pick, choosing a tool still expands its options inline rather than
// navigating to a second page, and results still appear beneath.
//
// Everything heavy is behind a dynamic import: `core/pipeline` (and through it
// `core/fs` + fflate + the worker pool) is fetched when the first run starts and
// prefetched on the first intake, so it is warm before the click. That is what
// keeps the entry chunk inside the §1 budget.
//
// The screen is three zones (files, catalogue, work — ui/zones/*.ts), each a
// pure function of a `Snapshot`. This file is the composition root: it wires
// the zones to the state machine and owns the one piece of DOM none of them
// can own on their own, the mounted options panel — see `mountOptions` and the
// comment on `unsubscribe` below for why that split means one call order in
// the subscriber is load-bearing.

import { label, sniffType } from '../core/format';
import { TOOLS, getTool, toolsFor } from '../core/registry';
import type { Job, JobResult, OpErrorCode, ToolDef } from '../types';
import { el, icon } from './dom';
import { createDropzone } from './dropzone';
import { disabledFormatChoices } from './encoder';
import { createFileTray, type FileTrayHandle, type TrayEntry } from './filetray';
import { fadeHero } from './motion';
import { defaultOptions, renderOptions, type OptionsHandle } from './optionspanel';
import { createPalette } from './palette';
import { prefetchModule, prefetchTool } from './prefetch';
import { createRouter } from './router';
import { createState, runBlockedReason, typeMismatch, type Snapshot } from './state';
import { createThemeControl } from './theme';
import { createCatalogue } from './zones/catalogue';
import { createFilesZone } from './zones/files';
import { createWorkZone } from './zones/work';

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

  // What the shell owns is the DOM the zones don't: the mounted options
  // panel, the running job, and the "what is already painted" guards that
  // keep this file from rebuilding surfaces that have not changed.
  let options: Record<string, unknown> = {};
  let panel: OptionsHandle | null = null;
  let job: Job | null = null;
  let lastFilesSignature = '';
  /**
   * The tool the work zone currently DESCRIBES — not a second copy of the
   * selection. The machine drops a selection whose TYPE no longer fits all on
   * its own (state.ts's `pruneSelection`), so by the time `refreshTools` sees
   * the new snapshot the selection is already gone while its options panel is
   * still mounted. This is what remembers it long enough to tear that down.
   *
   * It is written by `syncWork`, which the subscriber calls AFTER
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

  // zone 3 — the chosen tool: options mount point, Run/Cancel/progress, and
  // the results tray. `onRun`/`onCancel` close over `start`/`job`, both
  // declared below as hoisted function/`let` bindings — safe to reference
  // here because these callbacks only fire from a later click, exactly like
  // `catalogue`'s `onPick: (id) => void select(id)` already does below.
  const workZone = createWorkZone({
    onRun: () => void start(),
    onCancel: () => {
      job?.cancel();
      announce('Cancelling…');
    },
  });

  const dropzone = createDropzone({
    onFiles: (files) => void intake(files),
  });

  const tray: FileTrayHandle = createFileTray({
    onChange: (next) => {
      // The tray has already mutated its own DOM; mirror, never re-seed. The
      // machine's notification is what repaints everything else.
      state.setFiles(next);
    },
    announce,
  });

  // zone 1 — files: the add-bar, the tray, and the "remove all" control.
  const filesZone = createFilesZone({
    addbar: dropzone.addbar,
    tray,
    onClear: () => {
      state.clearFiles();
      tray.setEntries([]);
      workZone.results.clear();
      announce('All files removed.');
      // The subscriber below un-hides the hero itself, synchronously, the
      // instant `clearFiles()` emits a cold snapshot (see `wasCold` there) —
      // this only has to move focus off a button that is about to vanish.
      dropzone.focus();
    },
  });

  // zone 2 — the tool grid, in both of its densities (cold: all tools; warm:
  // the three applicability tiers). See ui/zones/catalogue.ts. `shell.ts` is
  // this element's ONLY placer — it never passes through `dropzone.ts`, so
  // there is exactly one line in the whole app that decides where it lives
  // (the `stageEl.append` below).
  const catalogue = createCatalogue({
    tools: TOOLS,
    onPick: (id) => void select(id),
    onWarm: prefetchTool,
  });

  // One stage, three zones — always mounted, never torn down. `dropzone.hero`
  // is the `browsing` phase's presentation of the same workbench, not a
  // separate screen: it sits ABOVE these zones and hides itself once the
  // phase moves on (see the `paint` subscriber below), rather than the zones
  // waiting to be built until the first file arrives.
  const stageEl = el('div', 'workbench');
  stageEl.append(filesZone.el, catalogue.el, workZone.el);

  // Results sit below the whole workbench, not confined to the work zone's
  // own column — the tray is created by `workZone` (zone 3 owns the tool's
  // whole lifecycle, results included), but its element is placed here.
  stage.append(dropzone.hero, stageEl, workZone.results.el);

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
   * Armed once the DOM these three paint exists, and before anything can emit.
   *
   * THE ORDER OF THESE THREE CALLS IS LOAD-BEARING. `syncWork` is what
   * records `shownTool`, so while `refreshTools` runs, `shownTool` still holds
   * the PREVIOUS snapshot's selection — which is the only reason it can notice
   * a selection the machine pruned, and the only reason `syncEditor` (called
   * from inside `refreshTools`) can tell a tool it has already painted from
   * one selected a moment ago. Paint the work zone first and both of those
   * silently stop working: a pruned tool's options are left mounted with
   * nothing announced, and selecting an editor tool builds its board twice.
   * `shell.browser.test.ts` fails on both counts if `syncWork` moves ahead of
   * `refreshTools`. `filesZone.render` has no such dependency — it reads
   * nothing `shownTool`-shaped — so its position here is not load-bearing.
   *
   * `wasCold` is the one thing bolted on for Task 10: `browsing` (no files,
   * no tool — see `derivePhase` in state.ts) is the ONLY phase the hero
   * covers, so leaving it is the one transition worth animating, and
   * returning to it (Remove-all with nothing selected) is the one worth
   * reversing. The workbench underneath (`stageEl`) is always mounted and
   * already fully visible, so there is nothing to animate IN any more —
   * `fadeHero` only ever fades the hero itself OUT. It is fired and left to
   * run — never awaited here — so a render is never blocked on it and
   * nothing below depends on it finishing (§7.5's reduced-motion promise:
   * under reduced motion it has already applied the end state by the time
   * this function returns).
   */
  let wasCold = true;

  function paint(next: Snapshot): void {
    snap = next;
    // Narrow layouts key off this to fold the catalogue away once a tool is
    // picked (see `[data-phase]` in app.css) — set before the zones render so
    // nothing downstream needs to re-derive it.
    stage.dataset.phase = snap.phase;
    filesZone.render(snap);
    refreshTools();
    syncWork();

    const cold = snap.phase === 'browsing';
    if (wasCold && !cold) {
      void fadeHero(dropzone.hero).then(() => {
        // Guarded on the CURRENT `wasCold`, read at the time this resolves —
        // not assumed still `false` just because it was when the fade
        // started. Two picks ~60ms apart (select a tool, then immediately
        // deselect it) fire fadeHero here, then hit the `else if` below
        // synchronously, which un-hides the hero again because the phase is
        // back to `browsing`. Without this guard, THIS callback still lands
        // later and hides it a second time regardless — leaving the hero
        // (the `<h1>`, the drop panel, "Choose files", all three trust
        // claims) permanently hidden while the phase is `browsing`, with no
        // `<h1>` anywhere on the page. Checking `wasCold` here means "hide
        // it" only fires when we are actually STILL in the non-browsing
        // state this fade was for.
        if (!wasCold) dropzone.hero.hidden = true;
      });
    } else if (!wasCold && cold) {
      // `fadeHero` never writes an inline style — the whole visual side is
      // the `.is-exiting` CSS transition (app.css) — so undoing it is just
      // the class and `hidden`, nothing left to clear.
      dropzone.hero.classList.remove('is-exiting');
      dropzone.hero.hidden = false;
    }
    wasCold = cold;
  }

  const unsubscribe = state.subscribe(paint);
  // `subscribe` only calls back on the NEXT change — without one explicit
  // call up front the catalogue would sit empty (no heading, no cards) on
  // the very first paint, since nothing has ever rendered it yet. `wasCold`
  // is already `true`, matching a fresh machine's snapshot, so this cannot
  // itself trigger the morph.
  paint(snap);

  // -------------------------------------------------------------- router
  // Every tool gets its own bookmarkable, shareable URL — FILES NEVER RIDE
  // ALONG (see router.ts's own header comment): a deep link opens the tool
  // with nothing loaded, exactly like picking it cold. `select()` below
  // takes the `fromRouter` flag this hands it, so a route never toggles a
  // tool off and a route delivering the tool already on screen — which
  // `createRouter`'s own doc comment says CAN happen twice in the same tick,
  // same id both times — is a no-op rather than a second `mountOptions()`
  // rebuilding the panel out from under whatever the user had already typed.
  //
  // Started AFTER the first `paint(snap)` above: `start()` reads the URL and
  // fires `onRoute` synchronously, and `onRoute` calls `select()`, which
  // reads and writes through `state` — that only reaches the screen once
  // this shell is actually subscribed and has painted once, which the two
  // lines above already guarantee.
  const router = createRouter({
    isKnownTool: (id) => getTool(id) !== undefined,
    onRoute: (id) => void select(id, { fromRouter: true }),
  });
  router.start();

  // ------------------------------------------------------------- intake
  async function intake(files: File[]): Promise<void> {
    const added: TrayEntry[] = [];
    for (const file of files) {
      const head = await file.slice(0, SNIFF_BYTES).arrayBuffer();
      added.push({ file, type: sniffType(head, file.name) });
    }
    if (added.length === 0) return;

    // Emits, which is what refreshes the grid; the tray is the one surface the
    // machine does not drive, so it is mirrored from the new snapshot. Any
    // hero-to-workbench morph this triggers is `paint`'s business, fired off
    // to the side — it never delays the announcement below.
    state.addFiles(added);
    tray.setEntries([...snap.entries]);

    // The first run is the only one that pays for the pipeline chunk; warm it
    // while the user is still reading the tool grid.
    prefetchModule('core:pipeline', () => import('../core/pipeline'));

    const types = [...new Set(added.map((entry) => label(entry.type)))].join(', ');
    announce(
      `${added.length} ${added.length === 1 ? 'file' : 'files'} added (${types}). ${toolsFor(mimes()).length} tools available.`,
    );
  }

  function mimes(): string[] {
    return snap.entries.map((entry) => entry.type);
  }

  // -------------------------------------------------------------- tools
  /** Identity of the FILES, so an editor built from them can be kept in sync. */
  function filesSignature(): string {
    return snap.entries.map((entry) => `${entry.file.name}:${entry.file.size}`).join('|');
  }

  function refreshTools(): void {
    // The catalogue owns the grid entirely — building it, the three tiers,
    // the tick on the selected card. This only asks what THIS shell still
    // owns: whether the tool the work zone is currently showing survived the
    // new snapshot.
    catalogue.render(snap);

    // `state.ts` prunes a selection whose TYPE no longer fits, entirely on
    // its own, before this runs (see `pruneSelection`). `shownTool` still
    // holds what was painted last cycle — `syncWork` has not overwritten it
    // yet — so "something was shown, and the new snapshot has nothing
    // selected" IS that prune, and tearing down the options panel built for
    // it is the only thing left undone.
    //
    // A selection merely short on COUNT is deliberately NOT this:
    // `pruneSelection` leaves it selected on purpose ("you need one more
    // PDF" beats a cleared panel), so `snap.selected` stays non-null and this
    // guard leaves it alone — `syncWork` puts the reason on the button.
    if (shownTool && !snap.selected) {
      clearSelection();
      // F4 of the final-branch review: this is the one call site that used
      // to leave the URL stale. `state.ts` prunes the selection here on its
      // own — nothing routed through it — so this is NEVER a
      // router-originated call the way `select()`'s two sites below can be;
      // writing the URL back to the catalogue is always safe (and never a
      // redundant echo) from here. Without this, "Remove all files" (which
      // reaches this same branch — see `filesZone`'s `onClear`) left a stale
      // `#/pdf-merge` behind: reload then restored a selection the user had
      // just cleared, and the stale hash made `navigate()`'s own echo-guard
      // (`location.hash === next`) swallow the NEXT genuine selection of
      // that same tool.
      router.navigate(null);
      announce('The selected tool no longer fits these files, so it was cleared.');
    }

    syncEditor();
    retractStalePreset();
  }

  function clearSelection(): void {
    panel?.destroy();
    panel = null;
    options = {};
    lastFilesSignature = '';
    // Forgotten BEFORE the machine is told, or `refreshTools`'s own prune
    // check below would find a tool that was shown a moment ago and clear it
    // again.
    shownTool = null;
    // Emits: `refreshTools` repaints the catalogue with nothing selected, and
    // `syncWork` is what hides the work zone's panel.
    state.selectTool(null);
    // Deliberately does NOT touch the URL — unlike `refreshTools`'s own
    // prune-teardown above, both of `select()`'s callers below already know
    // whether writing `router.navigate(null)` is safe for THEIR context (a
    // click always is; a route already AT that hash must not write again —
    // see the `!opts.fromRouter` guards there). An earlier version of this
    // fix called `router.navigate(null)` unconditionally from inside this
    // function instead, on the theory that `navigate()`'s own
    // `location.hash === next` check would make a router-originated call a
    // safe no-op. It is not: a fresh page load's `location.hash` is the
    // EMPTY STRING, not `'#/'`, so a Back navigation to the catalogue (whose
    // hashchange already carries `fromRouter: true` into `select()`, which
    // reaches this function) made that comparison fail and WRITE anyway —
    // silently pushing a new history entry that broke the browser's own
    // Forward stack (caught live by tests/e2e/tool-first.spec.ts's "gives a
    // tool its own URL" test going red under this exact fix).
  }

  /**
   * Paint the work zone from the snapshot, and record WHICH tool it painted,
   * in `shownTool` — the one thing about zone 3 that stays shell-owned. Must
   * run LAST in the subscriber: see the comment on `unsubscribe`.
   */
  function syncWork(): void {
    workZone.render(snap);
    shownTool = snap.selected;
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
    workZone.options.replaceChildren(mounted.el);
  }

  /**
   * An `editor` derives its options FROM the files (crop rectangle, page board),
   * so when the file list changes underneath it, keeping the old one would hand
   * the op options describing files that are no longer there.
   */
  function syncEditor(): void {
    const tool = snap.selected;
    // Only a tool the work zone is ALREADY showing can be out of sync. A
    // selection made this instant has not been painted yet, and mounting it
    // here would race `select()`'s own mount and build the board twice.
    if (!tool?.editor || shownTool?.id !== tool.id || snap.phase === 'running') return;
    const signature = filesSignature();
    if (signature === lastFilesSignature) return;
    void mountOptions(tool);
  }

  /**
   * A mounted preset's "because" caption describes the files AT MOUNT TIME
   * (`lastFilesSignature`) — `mountOptions` computes it once and bakes it
   * into the panel. An `editor` tool never goes stale on its own: `syncEditor`
   * above remounts it wholesale, fresh preset included, the moment the files
   * move. A plain schema-driven panel is deliberately never remounted just
   * because the files changed (see `mountOptions`'s own comment — it would
   * clobber a value the user has since typed over the preset), so nothing
   * else ever corrects its caption. Left alone, that is how "Create ZIP"
   * keeps reading "report" captioned "from the first file" after report.gz
   * has been swapped for holiday-photos.pdf — a sentence the panel is still
   * asserting about a file that is no longer there (spec Decision 3: "infer
   * the obvious, show the reasoning" — the reasoning is the feature, so a
   * false one has to go). Retracting the caption, never the value, is what
   * keeps the panel honest without discarding what the user typed.
   *
   * Runs AFTER `syncEditor`: an editor tool that just remounted already has
   * `lastFilesSignature` caught up (`mountOptions` sets it synchronously,
   * before its own first `await`), so this sees no staleness left to act on
   * for that case — it only ever does something for the non-editor panel
   * `syncEditor` does not touch at all.
   */
  function retractStalePreset(): void {
    if (!panel || filesSignature() === lastFilesSignature) return;
    panel.retractPresetNotes();
  }

  /**
   * `opts.fromRouter` marks a call that came from `router`'s `onRoute` — `id`
   * came from reading (or being pushed to) the URL, not from a card click or
   * the palette. Two things follow:
   *
   *   - it must never TOGGLE OFF. A route repeating the tool already on
   *     screen is a page load, a Back/Forward, or the router's own harmless
   *     duplicate echo — never the "click the same card again" gesture the
   *     toggle-off branch exists for. Gating that branch on `!opts.fromRouter`
   *     is what keeps a route from ever deselecting.
   *
   *   - a route for the tool ALREADY selected must be a total no-op. Per
   *     `createRouter`'s own doc comment, a same-tick multi-write pattern can
   *     fire `onRoute` twice for the identical id — never a wrong id, never a
   *     dropped one, just a duplicate. Without the guard below, that second
   *     call would fall through to `mountOptions(tool)` a second time and
   *     rebuild the options panel from its defaults, discarding whatever the
   *     user had already typed into the first one.
   */
  async function select(id: string | null, opts: { fromRouter?: boolean } = {}): Promise<void> {
    if (snap.phase === 'running') {
      // I1: every CLICK path that could reach `select()` mid-run is already
      // disabled while running — the catalogue's cards and pills
      // (`zones/catalogue.ts`'s `syncRunning`), and the palette's own
      // `snap.phase === 'running'` guards in `runFromPalette`/`commit` — so
      // the only way this branch is still reached during a run is a ROUTE:
      // Back/Forward, an edited address bar, or an external link. Those
      // change `location.hash` in the browser itself, synchronously and
      // unconditionally, before `onRoute` ever fires — nothing this app does
      // can stop that. The old behaviour was to drop the route on the floor
      // here, which left the address bar lying about what was on screen for
      // as long as the run lasted, and — because nothing ever corrected it —
      // for good afterwards too: the run ending does not touch the URL,
      // so a hash a Back navigation left behind stayed wrong even once
      // `select()` was reachable again. Re-asserting is the fix chosen over
      // queuing the route for when the run ends: queuing would apply a
      // navigation the user fired mid-run at the moment they are looking at
      // the run's own results, which is a worse surprise than the address
      // bar simply agreeing with the screen for the run's duration. A click
      // path reaching here despite being disabled (there should be none) is
      // deliberately left alone — `opts.fromRouter` is what tells the two
      // apart, and only a route gets corrected.
      if (opts.fromRouter) router.navigate(snap.selected?.id ?? null);
      return;
    }
    if (opts.fromRouter && id !== null && snap.selected?.id === id) return;

    // A click on the CURRENT tool deselects; a route never does (see above).
    // This is a click, never a route (the guard above requires
    // `!opts.fromRouter`), so writing the URL back to the catalogue is
    // always safe here — never a redundant echo of a hash we are already at.
    if (!opts.fromRouter && id !== null && snap.selected?.id === id) {
      clearSelection();
      router.navigate(null);
      announce('Tool deselected.');
      return;
    }

    const tool = id === null ? null : getTool(id);
    if (!tool) {
      // A route to the catalogue itself — Back/Forward, an unknown id
      // (`router`'s own `read()` has already folded that into `null` before
      // this ever sees it), or the initial load with no hash at all.
      // `clearSelection()`, never a bare `state.selectTool(null)`: that
      // helper forgets `shownTool` BEFORE telling the machine, which is the
      // only reason `refreshTools`'s prune check does not mistake this for a
      // files-no-longer-fit prune and fire that message instead (see the
      // comment on `clearSelection`).
      //
      // `router.navigate(null)` is gated on `!opts.fromRouter` — NOT called
      // unconditionally the way F4's fix first tried it (see
      // `clearSelection`'s own comment for why that broke Back/Forward): a
      // route already delivered this exact "no tool" state, so writing the
      // URL again here would be a second, unwanted history entry, not a
      // no-op. Skipped entirely when nothing is selected either way, so a
      // page load with an empty hash — the common case — does not force a
      // needless extra render.
      if (!opts.fromRouter) router.navigate(null);
      if (snap.selected) clearSelection();
      return;
    }

    // Emits: `refreshTools` repaints the catalogue with the tick on this
    // card, and `syncWork` fills the work zone's head in and reveals it.
    state.selectTool(tool.id);
    if (!opts.fromRouter) router.navigate(tool.id);
    announce(`${tool.name} selected. ${tool.blurb}`);

    await mountOptions(tool);
    if (snap.selected?.id !== id) return;
    // The e2e suite waits on this: Run taking focus is the app's own race-free
    // "ready" signal, and it lands only once the options have mounted.
    workZone.focusRun();
  }

  // ---------------------------------------------------------------- run
  function setRunning(on: boolean): void {
    // Disabling the focused element blurs it (moves focus to <body>) in every
    // browser — a keyboard user who just activated Run or Remove-all must not
    // be dropped onto nothing. Cancel is about to become the one live,
    // meaningful control, so focus follows there instead. Read BEFORE the
    // machine emits, because that emit is what disables Run and Remove-all
    // (see zones/work.ts's and zones/files.ts's `render`).
    const stranded = on && (workZone.hasRunFocus() || filesZone.hasClearFocus());
    state.setRunning(on);
    if (stranded) workZone.focusCancel();
  }

  async function start(): Promise<void> {
    const tool = snap.selected;
    if (!tool || snap.phase === 'running') return;

    // I3: a generator reads NO file — that is what `kind: 'generate'` means,
    // and `runBlockedReason` (state.ts) already never blocks one on file
    // count for exactly this reason. Before this guard, `files` below was
    // built unconditionally from every entry in the tray, so running a
    // generator (the QR code, `accepts: []`, `minInputs: 0`, `maxInputs: 0`)
    // with something else loaded read that something else's FULL bytes —
    // proved live by wrapping `File.prototype.arrayBuffer`: a PDF sitting in
    // the tray got read and structure-cloned to the worker to draw a QR code
    // that only ever looks at `options.text`. Nothing between here and the
    // worker validates the count against `maxInputs`, so nothing else would
    // have caught it. `inputs` (below) gets the same guard: a generator's
    // results tray must not claim an input the run never touched.
    const files = tool.kind === 'generate' ? [] : snap.entries.map((entry) => entry.file);
    // The sniffed type comes along so the results tray can tell whether an
    // input and an output are even the same kind of thing before it offers a
    // size comparison. entry.type is the magic-byte result, not the browser's
    // guess from the extension.
    const inputs =
      tool.kind === 'generate'
        ? []
        : snap.entries.map((entry) => ({
            name: entry.file.name,
            size: entry.file.size,
            type: entry.type,
          }));

    setRunning(true);
    workZone.progress.reset();
    workZone.progress.setLabel(`${tool.name}…`);
    workZone.results.clear();
    announce(`${tool.name} started on ${files.length} ${files.length === 1 ? 'file' : 'files'}.`);

    let result: JobResult | undefined;
    let failure: { code: OpErrorCode; message: string; file?: string } | undefined;

    try {
      const { run } = await import('../core/pipeline');
      const active = run(tool.id, files, options);
      job = active;

      let quarter = 0;
      active.onProgress((fraction) => {
        workZone.progress.set(fraction);
        const step = Math.floor(fraction * 4);
        if (step > quarter && step < 4) {
          quarter = step;
          announce(`${tool.name}, ${step * 25} percent.`);
        }
      });

      result = await active.done;
      workZone.progress.set(1);
    } catch (error) {
      failure = asFailure(error);
    } finally {
      job = null;
      setRunning(false);
    }

    await workZone.results.show({ toolName: tool.name, inputs, result, error: failure });
    // Spec §4.2 diagrams RUNNING -> RESULTS, and `results.show` above has
    // just unhidden the tray unconditionally — on success, partial success,
    // AND failure alike (a failure card is still a result, never a silent
    // no-op — see results.ts's own header comment). `state.setResults` tells
    // the machine the same thing, which is what makes `derivePhase` actually
    // reach 'results' rather than leaving it a diagram nothing produces.
    state.setResults(true);

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

    workZone.results.el.scrollIntoView({ block: 'nearest' });
  }

  // -------------------------------------------------------------- palette
  /**
   * Why `tool` can't run right now, or `null` when it can (Task 7, made
   * bucket-aware in Task 13).
   *
   * Reuses `runBlockedReason` (state.ts) rather than a second implementation
   * of the same rule — the same one the work zone's Run button already
   * builds its own label from, so there is exactly one wording for "why not"
   * anywhere in the app, not two that could drift. That also settles the
   * apostrophe: this file used to spell "doesn’t" with a curly one, inline;
   * `runBlockedReason`'s copy uses a straight one. Reuse wins over keeping
   * the old glyph — writing a second copy of the sentence just to preserve a
   * curly quote would be the second implementation this exists to avoid.
   *
   * The old version refused everything until files were loaded
   * ("Drop files first"), which is what made the palette a wall instead of a
   * door: a tool that merely NEEDS files could not be picked ahead of them,
   * even though picking it first and dropping files after is a completely
   * ordinary flow (the grid's own "blocked" tier already treats a
   * count-only shortfall this way). `runBlockedReason` already reports WHAT
   * a tool needs — a count, a type — instead of refusing outright, and
   * already never blocks a generator at all (it reads no file, so no file
   * set is ever wrong for it). The check below is redundant with that one
   * inside `runBlockedReason` but is kept here too, so the invariant reads
   * at the call site and not only inside a function two files away.
   */
  function unavailableReason(tool: ToolDef): string | null {
    if (tool.kind === 'generate') return null;
    return runBlockedReason(tool, mimes());
  }

  /**
   * Whether the palette should actually REFUSE `tool` (stay open, explain,
   * never call `onRun`) rather than treat a non-null `unavailableReason` as
   * an invitation (select and close, same as a card click cold — see
   * `palette.ts`'s own doc comment on `refuses`).
   *
   * This is the fix for the bug this comment block used to describe as
   * already solved: commit()'s `if (reason) return` was unconditional on
   * this branch's whole history — the WORDING became bucket-aware (Task 13),
   * but nothing ever stopped it refusing a tool that merely needed more
   * files, which is exactly the "wall instead of a door" behaviour the old
   * version was already accused of. `typeMismatch` (state.ts) is the one
   * part of `runBlockedReason`'s logic that is genuinely unfixable by
   * bringing more files of the same kind; everything else — no files loaded
   * at all, or a count shortfall — is not.
   */
  function refuses(tool: ToolDef): boolean {
    return typeMismatch(tool, mimes());
  }

  /**
   * The palette has already confirmed `tool` is not `refuses` and has closed
   * itself. Select it exactly like clicking its card would — unless it
   * already IS the selection, in which case calling `select` again would
   * TOGGLE it off (that codepath exists for the card's click-to-deselect
   * behaviour, which the palette must not trigger).
   *
   * A tool with a bespoke `editor` (crop, organize) cannot be run blind: its
   * options only mean something once the user has interacted with the board.
   * For those, the palette selects and stops — the same state a card click
   * leaves it in. And now that `refuses` lets a genuinely BLOCKED tool (needs
   * files it does not have yet) through to `select()` too, `start()` must
   * not be called on one: `start()` itself trusts its caller to have already
   * checked `runBlockedReason` — the enabled/disabled Run button is what
   * enforces that everywhere else — so this is the one caller that has to
   * check it explicitly.
   */
  async function runFromPalette(tool: ToolDef): Promise<void> {
    if (snap.phase === 'running') return;
    if (snap.selected?.id !== tool.id) {
      await select(tool.id);
    }
    if (snap.selected?.id === tool.id && !tool.editor && snap.runBlockedReason === null) {
      await start();
    }
  }

  const palette = createPalette({
    tools: TOOLS,
    unavailableReason,
    refuses,
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
      router.destroy();
      job?.cancel();
      panel?.destroy();
      filesZone.destroy();
      catalogue.destroy();
      workZone.destroy();
      tray.destroy();
      dropzone.destroy();
      document.removeEventListener('keydown', onGlobalKeydown);
      palette.destroy();
      themeControl.destroy();
      root.replaceChildren();
    },
  };
}
