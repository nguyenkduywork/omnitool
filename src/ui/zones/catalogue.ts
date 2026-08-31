// src/ui/zones/catalogue.ts — zone 2, in both of its densities.
//
// Cold, this renders all 29 tools grouped by family: the tool-first door.
// With files loaded, the SAME component renders the three applicability tiers.
// One component, because two would drift — and because the whole reason the
// second entry door is cheap is that there is no second landing page.

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

  root.append(head, groups, blockedWrap, utilityWrap);

  let selectedId: string | null = null;
  // Every `.toolcard` built during the CURRENT render() call — primary and
  // blocked alike (not the utility pills, which never carried the stagger
  // before either). Reset at the top of render() and read once at the end.
  let painted: HTMLElement[] = [];

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
    node.addEventListener('click', () => init.onPick(tool.id));

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

  return {
    el: root,
    render(snapshot) {
      selectedId = snapshot.selected?.id ?? null;
      painted = [];

      // COLD: the tool-first door. Every tool, generators included.
      if (snapshot.entries.length === 0) {
        heading.textContent = 'All tools';
        count.textContent = `${init.tools.length} tools, in three families. Pick one, or drop files to narrow the list.`;
        renderGroups(init.tools);
        blockedWrap.hidden = true;
        utilityWrap.hidden = true;
        reveal();
        return;
      }

      // WARM: the three tiers.
      const { primary, blocked, utility } = snapshot.applicability;
      const subject = snapshot.entries.length === 1 ? 'this file' : `these ${snapshot.entries.length} files`;
      const runnable = primary.length + utility.length;

      heading.textContent = 'Tools for these files';
      count.textContent =
        runnable === 0 ? '' : `${runnable === 1 ? '1 tool' : `${runnable} tools`} can run on ${subject}.`;

      renderGroups(primary);

      blockedGrid.replaceChildren();
      for (const { tool, reason } of blocked) {
        const node = card(tool);
        node.classList.add('toolcard--blocked');
        node.disabled = true;
        node.append(el('span', 'toolcard__reason', reason));
        blockedGrid.append(node);
      }
      blockedWrap.hidden = blocked.length === 0;

      utilityBar.replaceChildren();
      for (const tool of utility) {
        const pill = el('button', 'utilitypill');
        pill.type = 'button';
        pill.dataset.tool = tool.id;
        pill.classList.toggle('is-selected', tool.id === selectedId);
        pill.setAttribute('aria-pressed', String(tool.id === selectedId));
        pill.append(icon(toolIcon(tool)), el('span', undefined, tool.name));
        pill.addEventListener('click', () => init.onPick(tool.id));
        utilityBar.append(pill);
      }
      utilityWrap.hidden = utility.length === 0;

      reveal();
    },
    destroy() {
      root.replaceChildren();
    },
  };
}
