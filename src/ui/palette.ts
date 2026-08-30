// src/ui/palette.ts — the command palette (Cmd/Ctrl-K).
//
// Two halves, deliberately separated so the ranking logic can be tested
// without a DOM:
//
//   1. THE FUZZY MATCHER (`fuzzyScore`, `searchTools`) — pure functions, no
//      DOM, no imports beyond `../types`. Tested under Node in
//      tests/unit/palette.test.ts.
//   2. THE DIALOG (`createPalette`) — real DOM: a modal combobox+listbox
//      (WAI-ARIA 1.2 "combobox with list popup"). Tested against a real
//      browser in tests/unit/palette.browser.test.ts.
//
// The dialog never decides whether a tool CAN run — that is business logic
// the shell owns (it alone knows the loaded files). The shell hands the
// palette two callbacks: `unavailableReason` (why not, or null) and `onRun`
// (what to do once the answer is "yes"). This keeps the palette reusable and
// unit-testable on its own, the same separation `filetray.ts`/`dropzone.ts`
// already use for the rest of the shell's chrome.

import type { ToolDef } from '../types';
import { el, icon, iconButton } from './dom';
import { openPalette } from './motion';
import { GROUP_TITLE, toolIcon } from './toolicons';

// ---------------------------------------------------------------------------
// 1. The fuzzy matcher — pure, DOM-free.
// ---------------------------------------------------------------------------

// Three disjoint score bands, wide enough apart that no amount of secondary
// adjustment (position, spread) can push a lower tier above a higher one:
// exact prefix always outranks substring, which always outranks a scattered
// subsequence match.
const TIER_PREFIX = 3_000_000;
const TIER_SUBSTRING = 2_000_000;
const TIER_SUBSEQUENCE = 1_000_000;

/**
 * Score how well `query` matches `text`, case-insensitively. Higher is
 * better; `null` means "does not match at all" (not even a scattered
 * subsequence).
 *
 * Ranking, in order: an exact PREFIX match beats a plain SUBSTRING match
 * anywhere else, which beats a SCATTERED-CHARACTER (subsequence) match. An
 * empty query matches everything, trivially (score 0) — the palette's
 * "browse everything" state before the user types.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  if (q.length === 0) return 0;
  if (t.length === 0) return null;

  const at = t.indexOf(q);
  if (at === 0) {
    // Prefix. Among prefix matches, the tighter (shorter) target wins.
    return TIER_PREFIX - t.length;
  }
  if (at > 0) {
    // Substring elsewhere. Among these, an earlier occurrence wins.
    return TIER_SUBSTRING - at;
  }

  // Neither a prefix nor a contiguous substring: fall back to a subsequence
  // match — every character of `q`, in order, somewhere in `t`, not
  // necessarily adjacent. Score by how TIGHT the spread is: fewer
  // interleaved characters between the first and last match wins.
  let from = 0;
  let first = -1;
  let last = -1;
  for (const ch of q) {
    const found = t.indexOf(ch, from);
    if (found < 0) return null; // not even a subsequence: no match.
    if (first < 0) first = found;
    last = found;
    from = found + 1;
  }
  const spread = last - first + 1;
  return TIER_SUBSEQUENCE - spread;
}

/** The three fields `searchTools` reads. A `ToolDef` satisfies this. */
export type SearchableTool = { readonly name: string; readonly blurb: string };

// A name match outranks a blurb-only match by more than any two blurb-tier
// gaps could close, so "PDF" typed against a tool named "Merge PDFs" always
// beats a tool that merely mentions "pdf" once in its blurb.
const NAME_BONUS = 10_000_000;

/**
 * Rank `tools` against `query` over each tool's NAME and BLURB (§7.3 of the
 * spec: "fuzzy tool search"). A tool matches if either field matches; its
 * rank is the better of the two scores, with name matches weighted above
 * blurb-only ones.
 *
 * An empty query returns every tool, unranked, in its original order — the
 * palette's initial "browse everything" list.
 */
export function searchTools<T extends SearchableTool>(tools: readonly T[], query: string): T[] {
  const q = query.trim();
  if (q.length === 0) return [...tools];

  const scored: { tool: T; score: number }[] = [];
  for (const tool of tools) {
    const nameScore = fuzzyScore(q, tool.name);
    const blurbScore = fuzzyScore(q, tool.blurb);
    if (nameScore === null && blurbScore === null) continue;
    const best = Math.max(
      nameScore === null ? -Infinity : nameScore + NAME_BONUS,
      blurbScore === null ? -Infinity : blurbScore,
    );
    scored.push({ tool, score: best });
  }
  // Stable sort: vitest/Node's Array#sort is stable (ES2019+), so tools tied
  // on score keep their registry order.
  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.tool);
}

// ---------------------------------------------------------------------------
// 2. The dialog.
// ---------------------------------------------------------------------------

export type PaletteInit = {
  /** Every tool the palette can search — the full registry, not just the
   *  ones applicable to what's loaded right now. Searching everything and
   *  saying WHY a hit doesn't fit is more useful than hiding it. */
  tools: readonly ToolDef[];
  /** `null` when `tool` can run against what's currently loaded; otherwise
   *  the reason to show — e.g. "Drop files first" or "doesn't work with
   *  these files". */
  unavailableReason(tool: ToolDef): string | null;
  /** Mirrors a message into the shell's shared aria-live region, so a
   *  screen-reader user hears the same thing a sighted user reads inline. */
  announce(message: string): void;
  /** Called once, for a tool that IS available, right after the palette has
   *  closed and focus has been restored. */
  onRun(tool: ToolDef): void;
};

export type PaletteHandle = {
  /** The backdrop + dialog, appended once to `document.body`. */
  readonly el: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
};

let uid = 0;

export function createPalette(init: PaletteInit): PaletteHandle {
  const { tools, unavailableReason, announce, onRun } = init;

  uid += 1;
  const inputId = `palette-input-${uid}`;
  const listId = `palette-list-${uid}`;

  const backdrop = el('div', 'palette-backdrop');
  backdrop.hidden = true;

  const dialog = el('div', 'palette');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Command palette');

  const head = el('div', 'palette__head');
  const srLabel = el('label', 'sr-only', 'Search tools by name or description');
  srLabel.htmlFor = inputId;

  const input = el('input', 'palette__input');
  input.type = 'text';
  input.id = inputId;
  input.placeholder = 'Search tools…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-controls', listId);
  input.setAttribute('aria-autocomplete', 'list');

  const closeButton = iconButton('close', 'Close command palette', 'palette__close');

  head.append(srLabel, input, closeButton);

  const list = el('ul', 'palette__list');
  list.id = listId;
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Matching tools');

  const empty = el('p', 'palette__empty', 'No tools match.');
  empty.hidden = true;

  const note = el('p', 'palette__note');
  note.hidden = true;

  dialog.append(head, list, empty, note);
  backdrop.append(dialog);

  let isOpen = false;
  let returnFocus: HTMLElement | null = null;
  let filtered: ToolDef[] = [];
  let activeIndex = -1;

  function rowId(index: number): string {
    return `${listId}-opt-${index}`;
  }

  function setActive(index: number): void {
    const rows = [...list.children] as HTMLElement[];
    for (const [i, row] of rows.entries()) {
      row.classList.toggle('is-active', i === index);
      row.setAttribute('aria-selected', i === index ? 'true' : 'false');
    }
    activeIndex = index;
    if (index >= 0 && rows[index]) {
      input.setAttribute('aria-activedescendant', rowId(index));
      rows[index].scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function render(): void {
    filtered = searchTools(tools, input.value);
    list.replaceChildren();
    note.hidden = true;

    if (filtered.length === 0) {
      empty.hidden = false;
      input.removeAttribute('aria-activedescendant');
      activeIndex = -1;
      return;
    }
    empty.hidden = true;

    filtered.forEach((tool, index) => {
      const reason = unavailableReason(tool);

      const row = el('li', 'palette__row');
      row.id = rowId(index);
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      if (reason) {
        row.classList.add('is-unavailable');
        row.setAttribute('aria-description', reason);
      }

      // The same glyph and family tint the tool wears in the grid, so a
      // search result and a card are recognisably the same object.
      row.dataset.kind = tool.group;
      const glyph = el('span', 'palette__icon');
      glyph.append(icon(toolIcon(tool)));

      const top = el('div', 'palette__rowtop');
      top.append(el('span', 'palette__name', tool.name));
      if (reason) top.append(el('span', 'palette__tag', 'Not for these files'));

      const body = el('div', 'palette__rowbody');
      body.append(
        top,
        el('span', 'palette__blurb', `${GROUP_TITLE[tool.group]} · ${tool.blurb}`),
      );
      row.append(glyph, body);

      row.addEventListener('pointerenter', () => setActive(index));
      // mousedown (not click), and prevented: a click would first blur the
      // input, which we never want while the dialog is driving focus.
      row.addEventListener('mousedown', (event) => {
        event.preventDefault();
        setActive(index);
        commit();
      });

      list.append(row);
    });

    setActive(Math.min(activeIndex < 0 ? 0 : activeIndex, filtered.length - 1));
  }

  function commit(): void {
    const tool = filtered[activeIndex];
    if (!tool) return;

    const reason = unavailableReason(tool);
    if (reason) {
      // §requirement: a tool that doesn't fit must be VISIBLE, never a silent
      // no-op. Say why, out loud (announce) and on screen (note); keep the
      // palette open so the user can pick something else.
      note.hidden = false;
      note.textContent = reason;
      announce(reason);
      return;
    }

    close();
    onRun(tool);
  }

  function onKeydown(event: KeyboardEvent): void {
    switch (event.key) {
      case 'Escape':
        event.preventDefault();
        close();
        return;
      case 'ArrowDown':
        event.preventDefault();
        if (filtered.length > 0) setActive(Math.min(activeIndex + 1, filtered.length - 1));
        return;
      case 'ArrowUp':
        event.preventDefault();
        if (filtered.length > 0) setActive(Math.max(activeIndex - 1, 0));
        return;
      case 'Enter':
        event.preventDefault();
        commit();
        return;
      case 'Tab': {
        // The dialog has exactly two focusable controls, so forward and
        // backward Tab both do the same thing: toggle to the other one,
        // rather than letting focus escape to the page underneath.
        event.preventDefault();
        (document.activeElement === closeButton ? input : closeButton).focus();
        return;
      }
      default:
        return;
    }
  }

  input.addEventListener('input', render);
  dialog.addEventListener('keydown', onKeydown);
  closeButton.addEventListener('click', () => close());
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close();
  });

  function open(): void {
    if (isOpen) return;
    isOpen = true;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    input.value = '';
    activeIndex = -1;
    backdrop.hidden = false;
    render();
    input.focus();
    void openPalette(dialog);
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    backdrop.hidden = true;
    const target = returnFocus;
    returnFocus = null;
    // The pre-open element might be gone by now (a tool card the grid
    // re-rendered while the palette was up, say). Falling through to the
    // browser's own default (leave focus on <body>) is fine — it is never
    // worse than the alternative of focusing something arbitrary.
    if (target?.isConnected) target.focus();
  }

  return {
    el: backdrop,
    open,
    close,
    isOpen: () => isOpen,
    destroy(): void {
      backdrop.remove();
    },
  };
}
