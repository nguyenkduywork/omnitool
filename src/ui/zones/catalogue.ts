// src/ui/zones/catalogue.ts — zone 2, in both of its densities.
//
// Cold, this renders all 29 tools grouped by family: the tool-first door.
// With files loaded, the SAME component renders the three applicability tiers,
// PLUS — see `persistedGenerator` in `render` — whichever generator is still
// the selection, since applicability's own bucketing structurally excludes
// every generator and state.ts's pruneSelection just as deliberately never
// drops one. One component, because two would drift — and because the whole
// reason the second entry door is cheap is that there is no second landing
// page.

import type { ToolDef } from '../../types';
import { el, icon } from '../dom';
import { revealTools } from '../motion';
import type { Snapshot } from '../state';
import { GROUP_ICON, GROUP_ORDER, GROUP_TITLE, toolIcon } from '../toolicons';

export type CatalogueHandle = {
  readonly el: HTMLElement;
  render(snapshot: Snapshot): void;
  destroy(): void;
};

// §8: the stagger is the grid's FIRST paint only, across the app's whole
// lifetime — there is exactly one catalogue per page load, so a module-level
// guard and a per-instance one are the same thing in production. Re-filtering
// (a different file set, a different selection) is not an entrance, and
// animating it every time would be decoration.
let revealed = false;

export function createCatalogue(init: {
  tools: readonly ToolDef[];
  onPick: (id: string) => void;
  onWarm: (tool: ToolDef) => void;
}): CatalogueHandle {
  const root = el('section', 'catalogue');
  root.setAttribute('aria-labelledby', 'catalogue-heading');

  const heading = el('h2', 'panel__title', '');
  heading.id = 'catalogue-heading';
  const count = el('p', 'catalogue__count');
  const head = el('div', 'catalogue__head');
  head.append(heading, count);

  // The narrow layout's way back: below 768px, picking a tool folds the grid
  // away so the work zone is on screen without a second scroll (see
  // `.catalogue__body`'s `[data-phase]` rule in app.css). Folding the grid
  // must not fold this too, or there would be no way to reach it again —
  // `onPick` with the id ALREADY selected is the existing toggle-off behaviour
  // (see `select()` in shell.ts), so this is not a new code path, just a new
  // way to reach it.
  const backBar = el('div', 'catalogue__back');
  const back = el('button', 'btn btn--quiet btn--sm', 'Change tool');
  back.type = 'button';
  back.addEventListener('click', () => {
    if (selectedId) init.onPick(selectedId);
  });
  backBar.append(back);
  backBar.hidden = true;

  // Everything below is what the narrow layout folds away — grouped under one
  // element (`display: contents`, so it costs nothing in the wider layouts'
  // grid) purely so app.css has one selector to hide instead of four.
  const body = el('div', 'catalogue__body');
  const groups = el('div', 'catalogue__groups');
  const blockedWrap = el('section', 'blocked');
  blockedWrap.hidden = true;
  blockedWrap.append(el('h3', 'blocked__title', 'Not for this selection'));
  const blockedGrid = el('div', 'blocked__grid');
  blockedWrap.append(blockedGrid);

  const utilityWrap = el('section', 'utility');
  utilityWrap.hidden = true;
  utilityWrap.append(el('h3', 'utility__title', 'Works on any file'));
  const utilityBar = el('div', 'utilitybar');
  utilityWrap.append(utilityBar);

  // All three tiers empty, files loaded: every bucket coming up blank is not
  // the same as "nothing to say" — silence here is exactly the failure mode
  // this overhaul exists to remove. Only shown when there is not even a
  // blocked card to explain itself (a blocked card already IS the reason).
  const empty = el('p', 'catalogue__empty');
  empty.hidden = true;

  body.append(groups, blockedWrap, utilityWrap, empty);
  root.append(head, backBar, body);

  let selectedId: string | null = null;
  // Every `.toolcard` built during the CURRENT render() call — primary and
  // blocked alike (not the utility pills, which never carried the stagger
  // before either). Reset at the top of render() and read once at the end.
  let painted: HTMLElement[] = [];
  // Identity of the grid's CONTENT (which tools are in which tier — cold vs
  // warm counts as content too), so a render caused by nothing but a NEW
  // SELECTION does not rebuild it. A pure selection change never changes
  // which tools are in which tier, so tearing down and rebuilding every card
  // for it is needless churn that discards node identity — and with it
  // anything attached to those nodes, e.g. whichever one the click that
  // caused this render just landed on — when moving the tick across the
  // EXISTING nodes is both correct and cheaper. (It is not, as first
  // suspected, a fix for keyboard focus landing on <body>: that turns out to
  // be normal browser behaviour for any `.focus()` transfer between two
  // elements, reproducible with neither element ever touched — see the
  // covering test in shell.browser.test.ts for the full story.) All three
  // buckets go into the signature for the warm case: a change confined to
  // the blocked or utility tier is still a change, and hashing only
  // `primary` would leave it unpainted.
  let lastSignature = '';

  function card(tool: ToolDef): HTMLButtonElement {
    const node = el('button', 'toolcard');
    node.type = 'button';
    node.dataset.tool = tool.id;
    node.dataset.kind = tool.group;
    node.setAttribute('aria-pressed', String(tool.id === selectedId));
    node.classList.toggle('is-selected', tool.id === selectedId);

    const top = el('span', 'toolcard__top');
    const glyph = el('span', 'toolcard__icon');
    glyph.append(icon(toolIcon(tool)));
    const check = el('span', 'toolcard__check');
    check.append(icon('check'));
    top.append(glyph, el('span', 'toolcard__name', tool.name), check);
    node.append(top, el('span', 'toolcard__blurb', tool.blurb));

    const warm = (): void => init.onWarm(tool);
    node.addEventListener('pointerenter', warm);
    node.addEventListener('focus', warm);
    // `aria-disabled`, checked fresh at click time rather than at listener
    // registration: a blocked card's `aria-disabled="true"` is set by the
    // caller AFTER this returns (see the blocked-tier loop below), and this
    // same builder is shared with primary cards, which never set it at all.
    // See the followups doc's "disabled -> aria-disabled" entry — a blocked
    // card stays FOCUSABLE so its reason is reachable, but must still refuse
    // to act, which a real `disabled` attribute used to do for free.
    node.addEventListener('click', () => {
      if (node.getAttribute('aria-disabled') === 'true') return;
      init.onPick(tool.id);
    });

    painted.push(node);
    return node;
  }

  function renderGroups(list: readonly ToolDef[]): void {
    groups.replaceChildren();
    for (const group of GROUP_ORDER) {
      const inGroup = list.filter((tool) => tool.group === group);
      if (inGroup.length === 0) continue;

      const section = el('div', 'toolgroup');
      section.dataset.kind = group;
      const glyph = el('span', 'toolgroup__icon');
      glyph.append(icon(GROUP_ICON[group]));
      const groupHead = el('div', 'toolgroup__head');
      groupHead.append(
        glyph,
        el('h3', 'toolgroup__title', GROUP_TITLE[group]),
        el('span', 'toolgroup__count', String(inGroup.length)),
      );
      const grid = el('div', 'toolgroup__grid');
      for (const tool of inGroup) grid.append(card(tool));
      section.append(groupHead, grid);
      groups.append(section);
    }
  }

  function reveal(): void {
    if (!revealed && painted.length > 0) {
      revealed = true;
      void revealTools(painted);
    }
  }

  /** Both tiers: a utility pill is as selectable as a card, so it marks the same. */
  function markSelected(id: string | null): void {
    for (const node of root.querySelectorAll<HTMLElement>('.toolcard, .utilitypill')) {
      const on = node.dataset.tool === id;
      node.classList.toggle('is-selected', on);
      node.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /**
   * I1: a click on another tool mid-run used to reach `shell.ts`'s `select()`,
   * which silently no-op'd on its `snap.phase === 'running'` guard — every
   * OTHER control that a run makes meaningless (Run itself, Remove all files,
   * the whole tray — see `zones/files.ts` and `filetray.ts`) already says so
   * by going `disabled`; the grid alone stayed `disabled: false, tabIndex: 0`
   * for the run's whole duration, silently swallowing the click instead.
   * `.toolcard--blocked` cards are excluded deliberately: they are already
   * `aria-disabled` for an unrelated, PERMANENT reason (the wrong file count
   * for THIS selection), and must not be quietly re-enabled the moment a run
   * ends just because this loop stops touching them.
   *
   * `back` (the narrow layout's "Change tool" button, `.catalogue__back`) is
   * included explicitly, not by the selector above: it is a fixed element
   * created once, never rebuilt by `render()`, so a query for it would work
   * too, but naming it directly is cheaper and cannot silently stop matching
   * if its markup changes. Missing it here was itself a review finding: its
   * own click handler reaches `init.onPick` -> `shell.ts`'s `select()` the
   * same as any card, and below 768px `[data-phase='running']` hides
   * `.catalogue__body` entirely (app.css) — so on a phone, mid-run, this was
   * the ONLY zone-2 control left on screen, and it was live.
   */
  function syncRunning(running: boolean): void {
    back.disabled = running;
    for (const node of root.querySelectorAll<HTMLButtonElement>(
      '.toolcard:not(.toolcard--blocked), .utilitypill',
    )) {
      node.disabled = running;
    }
  }

  function gridSignature(snapshot: Snapshot): string {
    if (snapshot.entries.length === 0) return 'cold';
    const { primary, blocked, utility } = snapshot.applicability;
    return [
      snapshot.entries.length,
      primary.map((tool) => tool.id).join(','),
      blocked.map((b) => b.tool.id).join(','),
      utility.map((tool) => tool.id).join(','),
      // A selected GENERATOR: see `persistedGenerator` in `render` below for
      // why one can reach here at all, and why it needs a slot in the
      // signature even though it is never one of the three tiers above.
      snapshot.selected?.kind === 'generate' ? snapshot.selected.id : '',
    ].join('|');
  }

  /** A single quiet pill in the utility row — a utility tool that fits, or
   *  (see `persistedGenerator` in `render`) a generator whose SELECTION
   *  survived into a warm grid that structurally has no bucket for it. */
  function pill(tool: ToolDef): HTMLButtonElement {
    const node = el('button', 'utilitypill');
    node.type = 'button';
    node.dataset.tool = tool.id;
    node.classList.toggle('is-selected', tool.id === selectedId);
    node.setAttribute('aria-pressed', String(tool.id === selectedId));
    node.append(icon(toolIcon(tool)), el('span', undefined, tool.name));
    node.addEventListener('click', () => init.onPick(tool.id));
    return node;
  }

  return {
    el: root,
    render(snapshot) {
      selectedId = snapshot.selected?.id ?? null;
      // I1: computed once and applied on every exit path below (the
      // early-return for an unchanged signature included) — see
      // `syncRunning`'s own comment for why this cannot be folded into
      // `gridSignature` (running/not-running never changes which tools are in
      // which tier, so it must not force a full rebuild) or skipped on the
      // fast path (a run can start or end without the grid's CONTENT changing
      // at all, which is exactly when the early return below fires).
      const running = snapshot.phase === 'running';
      // Independent of cold/warm and of the short-circuit below: a generator
      // (the QR code) is reachable — and selectable — straight from the cold
      // grid, with no files at all, so this cannot wait for the warm branch
      // the way the plan first sketched it.
      backBar.hidden = selectedId === null;

      const signature = gridSignature(snapshot);
      if (signature === lastSignature) {
        // A pure selection change (or a no-op emit): the CONTENT of every
        // tier is unchanged, so the tick moves on the EXISTING nodes rather
        // than the whole grid being torn down and rebuilt under whichever
        // card the click that caused this render just landed on.
        markSelected(selectedId);
        syncRunning(running);
        return;
      }
      lastSignature = signature;
      painted = [];

      // COLD: the tool-first door. Every tool, generators included.
      if (snapshot.entries.length === 0) {
        heading.textContent = 'All tools';
        count.textContent = `${init.tools.length} tools, in three families. Pick one, or drop files to narrow the list.`;
        renderGroups(init.tools);
        blockedWrap.hidden = true;
        utilityWrap.hidden = true;
        empty.hidden = true;
        reveal();
        syncRunning(running);
        return;
      }

      // WARM: the three tiers.
      const { primary, blocked, utility } = snapshot.applicability;
      const subject = snapshot.entries.length === 1 ? 'this file' : `these ${snapshot.entries.length} files`;
      const runnable = primary.length + utility.length;

      heading.textContent = 'Tools for these files';
      // M1: `runnable === 0` (the blank-header branch) is DEFENSIVE ONLY
      // against the current 29-tool registry — six tools declare
      // `accepts: ['*']`, `minInputs: 1`, `maxInputs: null`, so with at least
      // one file loaded the utility bucket alone already guarantees
      // `runnable > 0` (`utility.length >= 1` whenever `primary.length ===
      // 0`, since a `'*'` tool can never be TYPE-blocked and a single file
      // always satisfies `minInputs: 1`/`maxInputs: null`). Left in, not
      // deleted: a future tool with a bounded range (`maxInputs` some finite
      // N greater than 1) could make `runnable === 0` reachable again — see
      // the followups doc's "countReason's... unreachable" entry for the
      // same shape of gap one layer down.
      count.textContent =
        runnable === 0 ? '' : `${runnable === 1 ? '1 tool' : `${runnable} tools`} can run on ${subject}.`;

      renderGroups(primary);

      blockedGrid.replaceChildren();
      for (const { tool, reason } of blocked) {
        const node = card(tool);
        node.classList.add('toolcard--blocked');
        node.setAttribute('aria-disabled', 'true');
        node.append(el('span', 'toolcard__reason', reason));
        blockedGrid.append(node);
      }
      blockedWrap.hidden = blocked.length === 0;

      utilityBar.replaceChildren();
      for (const tool of utility) utilityBar.append(pill(tool));

      // `applicabilityFor` structurally excludes EVERY generator from all
      // three tiers above, unconditionally — it describes what fits these
      // files, and a generator reads none (see core/format.ts's own comment
      // on `applicabilityFor`, pinned by a test: "never lets a generator
      // into any bucket, whatever is loaded"). But `state.ts`'s
      // `pruneSelection` deliberately keeps a generator SELECTED straight
      // through a file change, for the opposite reason — it never depended
      // on the files either, so there is nothing about them that should make
      // it lose its place (also pinned: "keeps a generator selected when the
      // files change under it"). Both rules are correct on their own terms;
      // reachable one after the other — select a generator cold, then drop a
      // file, or pick one from the now bucket-aware palette while already
      // warm — they used to leave the grid showing no selection at all while
      // the work zone kept running it. `persistedGenerator` is that
      // reconciliation: not a fourth bucket `applicabilityFor` computes, just
      // this component adding back, from the snapshot's own `selected`, the
      // one card its own bucketing rule can never contain. It rides in the
      // quiet utility row rather than a new bucket of its own, because
      // "ignores every file" and "runs on any file" read the same way to
      // someone scanning the grid for what they can still do.
      const persistedGenerator = snapshot.selected?.kind === 'generate' ? snapshot.selected : null;
      if (persistedGenerator) utilityBar.append(pill(persistedGenerator));
      utilityWrap.hidden = utility.length === 0 && !persistedGenerator;

      // Nothing to run AND nothing to explain: every bucket came up empty,
      // so there is no blocked card telling the story on its own. Silence
      // here reads as "this app cannot do that" — say so instead. Not true
      // when a persisted generator is sitting right there in the utility
      // row, still perfectly runnable.
      //
      // M1: DEFENSIVE ONLY against today's registry, for the same reason as
      // `runnable === 0` above — `utility` cannot come up empty with at least
      // one file loaded (six `'*'`-accepting tools, none of them ever
      // TYPE-blocked or COUNT-blocked by a single file), so `allEmpty` can
      // never actually be true right now. `tests/unit/catalogue.browser.test.ts`
      // still exercises this branch directly, against a hand-built snapshot
      // the real registry cannot produce — see that test file's own comment.
      // Kept, not deleted: a registry with a bounded-range or narrower-than-
      // '*' utility tool would make this reachable again.
      const allEmpty =
        primary.length === 0 && blocked.length === 0 && utility.length === 0 && !persistedGenerator;
      empty.hidden = !allEmpty;
      if (allEmpty) {
        empty.textContent =
          'No tool works with this exact mix of files. Remove the odd one out — most tools want every file to be the same kind.';
      }

      reveal();
      syncRunning(running);
    },
    destroy() {
      root.replaceChildren();
    },
  };
}
