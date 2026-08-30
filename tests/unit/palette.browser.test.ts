// tests/unit/palette.browser.test.ts — the dialog half of the command palette.
//
// Real headless Chromium: real focus, real keydown events, real
// document.activeElement. Nothing here is stubbed — the DOM-free ranking
// logic is covered separately in palette.test.ts under Node.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPalette, type PaletteHandle } from '../../src/ui/palette';
import type { ToolDef } from '../../src/types';

function tool(over: Partial<ToolDef> = {}): ToolDef {
  return {
    id: 'merge',
    name: 'Merge PDFs',
    blurb: 'Combine several PDFs into one, in tray order.',
    group: 'pdf',
    kind: 'transform',
    accepts: ['application/pdf'],
    minInputs: 2,
    maxInputs: null,
    load: () => Promise.reject(new Error('the palette must never load the op itself')),
    ...over,
  };
}

const TOOLS: ToolDef[] = [
  tool({ id: 'merge', name: 'Merge PDFs', blurb: 'Combine several PDFs into one.' }),
  tool({ id: 'split', name: 'Split PDF', blurb: 'One file per page.' }),
  tool({ id: 'hash', name: 'Hash', blurb: 'SHA-256, SHA-1 or MD5 of a file.', group: 'data' }),
];

let outsideButton: HTMLButtonElement;
let handle: PaletteHandle;
let announced: string[];
let unavailable: Set<string>;
let ran: ToolDef[];

function setup(): void {
  announced = [];
  unavailable = new Set();
  ran = [];
  handle = createPalette({
    tools: TOOLS,
    unavailableReason: (t) => (unavailable.has(t.id) ? `${t.name} does not fit.` : null),
    announce: (message) => announced.push(message),
    onRun: (t) => ran.push(t),
  });
  document.body.append(handle.el);
}

beforeEach(() => {
  outsideButton = document.createElement('button');
  outsideButton.textContent = 'outside trigger';
  document.body.append(outsideButton);
  setup();
});

afterEach(() => {
  handle.destroy();
  outsideButton.remove();
  vi.restoreAllMocks();
});

function input(): HTMLInputElement {
  const el = handle.el.querySelector('input');
  if (!el) throw new Error('palette input not rendered');
  return el;
}

function rows(): HTMLElement[] {
  return [...handle.el.querySelectorAll<HTMLElement>('[role="option"]')];
}

function fire(el: Element, key: string, extra: Partial<KeyboardEventInit> = {}): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
}

describe('opening and closing', () => {
  it('is closed and hidden until open() is called', () => {
    expect(handle.isOpen()).toBe(false);
    expect(handle.el.hidden).toBe(true);
  });

  it('open() shows the dialog, lists every tool, and focuses the search input', () => {
    outsideButton.focus();
    handle.open();
    expect(handle.isOpen()).toBe(true);
    expect(handle.el.hidden).toBe(false);
    expect(document.activeElement).toBe(input());
    expect(rows().length).toBe(TOOLS.length);
  });

  it('has the required dialog semantics and a labelled input', () => {
    handle.open();
    const dialog = handle.el.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.getAttribute('aria-modal')).toBe('true');

    const field = input();
    const label = handle.el.querySelector('label');
    expect(label).not.toBeNull();
    expect(label?.getAttribute('for')).toBe(field.id);
  });

  it('Escape closes the dialog', () => {
    handle.open();
    fire(input(), 'Escape');
    expect(handle.isOpen()).toBe(false);
    expect(handle.el.hidden).toBe(true);
  });

  it('restores focus to wherever it was before opening, on Escape', () => {
    outsideButton.focus();
    expect(document.activeElement).toBe(outsideButton);

    handle.open();
    expect(document.activeElement).not.toBe(outsideButton);

    fire(input(), 'Escape');
    expect(document.activeElement).toBe(outsideButton);
  });

  it('restores focus even when the search text changed before Escape', () => {
    outsideButton.focus();
    handle.open();
    input().value = 'hash';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    fire(input(), 'Escape');
    expect(document.activeElement).toBe(outsideButton);
  });

  it('falls back gracefully if the pre-open element is gone by close time', () => {
    const ephemeral = document.createElement('button');
    document.body.append(ephemeral);
    ephemeral.focus();

    handle.open();
    ephemeral.remove();
    expect(() => fire(input(), 'Escape')).not.toThrow();
    expect(handle.isOpen()).toBe(false);
  });

  it('the close button also closes and restores focus', () => {
    outsideButton.focus();
    handle.open();
    const close = handle.el.querySelector<HTMLButtonElement>('.palette__close');
    close?.click();
    expect(handle.isOpen()).toBe(false);
    expect(document.activeElement).toBe(outsideButton);
  });

  it('clicking the backdrop (outside the dialog) closes it', () => {
    outsideButton.focus();
    handle.open();
    handle.el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(handle.isOpen()).toBe(false);
  });
});

describe('keyboard navigation', () => {
  it('ArrowDown/ArrowUp move the active row and update aria-activedescendant', () => {
    handle.open();
    expect(input().getAttribute('aria-activedescendant')).toBe(rows()[0]?.id);

    fire(input(), 'ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe(rows()[1]?.id);
    expect(rows()[1]?.classList.contains('is-active')).toBe(true);
    expect(rows()[1]?.getAttribute('aria-selected')).toBe('true');

    fire(input(), 'ArrowUp');
    expect(input().getAttribute('aria-activedescendant')).toBe(rows()[0]?.id);
  });

  it('ArrowDown/ArrowUp do not run past the ends of the list', () => {
    handle.open();
    for (let i = 0; i < TOOLS.length + 3; i++) fire(input(), 'ArrowDown');
    expect(input().getAttribute('aria-activedescendant')).toBe(rows().at(-1)?.id);

    for (let i = 0; i < TOOLS.length + 3; i++) fire(input(), 'ArrowUp');
    expect(input().getAttribute('aria-activedescendant')).toBe(rows()[0]?.id);
  });

  it('typing filters the list live', () => {
    handle.open();
    input().value = 'hash';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    expect(rows().map((row) => row.textContent)).toEqual([
      expect.stringContaining('Hash'),
    ]);
  });

  it('Tab traps focus between the input and the close button', () => {
    handle.open();
    expect(document.activeElement).toBe(input());

    fire(input(), 'Tab');
    const close = handle.el.querySelector('.palette__close');
    expect(document.activeElement).toBe(close);

    fire(close!, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(input());
  });
});

describe('running a tool', () => {
  it('Enter on an available tool closes the palette and calls onRun', () => {
    handle.open();
    fire(input(), 'Enter');
    expect(handle.isOpen()).toBe(false);
    expect(ran).toEqual([TOOLS[0]]);
  });

  it('clicking a row runs that tool, not just the active one', () => {
    handle.open();
    rows()[2]?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(ran).toEqual([TOOLS[2]]);
  });

  it('Enter on an unavailable tool stays open, announces, and shows the reason visibly — never a silent failure', () => {
    unavailable.add('merge');
    handle.open();
    fire(input(), 'Enter');

    expect(handle.isOpen()).toBe(true);
    expect(ran).toEqual([]);
    expect(announced.length).toBeGreaterThan(0);
    expect(announced.at(-1)).toContain('does not fit');
    expect(handle.el.textContent).toContain('does not fit');
  });

  it('marks an unavailable row visibly in the list itself', () => {
    unavailable.add('hash');
    handle.open();
    const hashRow = rows().find((row) => row.textContent?.includes('Hash'));
    expect(hashRow?.classList.contains('is-unavailable')).toBe(true);
    expect(hashRow?.textContent).toMatch(/not for these files/i);
  });

  it('Enter with no matches at all does nothing (nothing to commit)', () => {
    handle.open();
    input().value = 'nonexistentquery';
    input().dispatchEvent(new Event('input', { bubbles: true }));
    expect(() => fire(input(), 'Enter')).not.toThrow();
    expect(handle.isOpen()).toBe(true);
    expect(ran).toEqual([]);
  });
});
