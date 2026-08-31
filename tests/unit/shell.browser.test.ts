// tests/unit/shell.browser.test.ts — the shell's seam onto ui/state.ts.
//
// Real headless Chromium, the real registry, real fixture bytes through the
// app's own hidden <input>. Nothing here is stubbed: `mountShell` is mounted as
// main.ts mounts it, and every assertion reads the DOM a person would see.
//
// WHY THIS FILE EXISTS
//
// `state.ts` prunes a selection whose TYPE no longer matches the files, all on
// its own, and it does so BEFORE the shell hears about the new files. So the
// shell cannot ask the snapshot "was something selected?" — by then the answer
// is no, while that tool's options panel is still mounted on screen. `shell.ts`
// keeps `shownTool` for exactly that, and the subscriber's order —
// `refreshTools()` and only then `syncRunPanel()` — is what keeps it holding
// the PREVIOUS snapshot's selection while the grid is rebuilt.
//
// That is an invariant spread across three functions and two adjacent lines,
// with nothing about it visible at the point a future editor is most likely to
// touch it. Swapping those two lines, or "simplifying" `shownTool` away as a
// duplicate of `snap.selected`, breaks two user-visible behaviours silently:
//
//   1. a tool whose type stops fitting keeps its options panel and its run
//      surface, and nothing is announced (test one), and
//   2. selecting a tool with a bespoke `editor` builds its board TWICE, from
//      the same files, leaking the first one's handle (test two).
//
// Neither is reachable from the e2e specs, which never change the file set
// while a tool is selected. Stage 3 moves `syncEditor` into the subscriber and
// the run panel into `work.ts`, so this is the guard rail that refactor needs.
//
// The announcement in (1) cannot be read off the settled DOM: it is overwritten
// by intake's own "1 file added…" inside the same synchronous block. It is
// captured here from the live region's childList mutations instead — see
// `watchAnnouncements`.

import { userEvent } from '@vitest/browser/context';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountShell, type ShellHandle } from '../../src/ui/shell';

/** A committed fixture, as a File the sniffer will recognise by its bytes. */
async function fixture(name: string): Promise<File> {
  const url = new URL(`../fixtures/${name}`, import.meta.url).href;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load fixture ${name}: ${response.status}`);
  return new File([new Uint8Array(await response.arrayBuffer())], name);
}

let root: HTMLElement;
let shell: ShellHandle;
let observers: MutationObserver[];

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
  observers = [];
  shell = mountShell(root);
});

afterEach(() => {
  for (const observer of observers) observer.disconnect();
  shell.destroy();
  root.remove();
});

/**
 * Deliver files the way a real pick does: set them on the app's own hidden
 * input and fire `change`. That is the same `deliver()` -> `onFiles()` path the
 * drop and paste handlers call into (see src/ui/dropzone.ts), and the technique
 * the e2e specs use for the same reason.
 */
function deliver(files: File[]): void {
  const picker = root.querySelector<HTMLInputElement>('input[type="file"]');
  if (!picker) throw new Error('the dropzone rendered no file input');
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  picker.files = transfer.files;
  picker.dispatchEvent(new Event('change'));
}

/** Intake sniffs bytes off the file, so it settles a few microtasks later. */
async function until(what: string, ready: () => boolean, limit = 10_000): Promise<void> {
  const started = performance.now();
  while (!ready()) {
    if (performance.now() - started > limit) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

/** Long enough for a racing async mount to land, if one were started. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 60));
}

const count = (selector: string): number => root.querySelectorAll(selector).length;

function one<T extends Element>(selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`nothing matched ${selector}`);
  return found;
}

/**
 * Every message the live region is HANDED, including one overwritten in the
 * same turn. `announce()` assigns `textContent`, which replaces the region's
 * text node, so each message arrives as an added node — and a detached text
 * node keeps its data. A MutationObserver reading `live.textContent` in its
 * callback would see only the last one; reading the records sees them all.
 */
function watchAnnouncements(): () => string[] {
  const live = one('[aria-live]');
  const seen: string[] = [];
  const drain = (records: MutationRecord[]): void => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        const text = node.textContent?.trim();
        if (text) seen.push(text);
      }
    }
  };
  const observer = new MutationObserver(drain);
  observer.observe(live, { childList: true });
  observers.push(observer);
  return () => {
    drain(observer.takeRecords());
    return [...seen];
  };
}

/** How many times an options surface has been mounted into the run panel. */
function watchOptionMounts(): () => number {
  const host = one('.run__options');
  let mounts = 0;
  const drain = (records: MutationRecord[]): void => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.classList.contains('options')) mounts += 1;
      }
    }
  };
  const observer = new MutationObserver(drain);
  observer.observe(host, { childList: true });
  observers.push(observer);
  return () => {
    drain(observer.takeRecords());
    return mounts;
  };
}

describe('the shell against the state machine', () => {
  it('tears down a selection the machine pruned, and announces it', async () => {
    deliver([await fixture('small.pdf')]);
    await until('the tool grid', () => count('.toolcard[data-tool="pdf-split"]') === 1);

    // pdf-split takes any number of PDFs and has a plain schema panel, so the
    // only thing that can remove its options is the teardown under test.
    one<HTMLButtonElement>('.toolcard[data-tool="pdf-split"]').click();
    await until('the options panel', () => count('.run__options .opt') > 0);

    expect(one('.run').hasAttribute('hidden')).toBe(false);
    expect(count('.toolcard.is-selected[data-tool="pdf-split"]')).toBe(1);

    const announced = watchAnnouncements();

    // A PNG next to a PDF: pdf-split's TYPE no longer fits, which is the case
    // state.ts prunes for. The shell has to notice a selection it can no longer
    // see in the snapshot.
    deliver([await fixture('a.png')]);
    await until('the second file', () => count('.tray__item') === 2);
    await until('the run panel to come down', () => one('.run').hasAttribute('hidden'));
    await settle();

    // Its options are gone, not merely hidden behind the panel.
    expect(count('.run__options .opt')).toBe(0);
    expect(count('.toolcard.is-selected')).toBe(0);
    expect(count('[aria-pressed="true"]')).toBe(0);

    // And it was said, before intake's own message overwrote it. Silence here
    // would leave a screen-reader user with a vanished panel and no reason.
    const messages = announced();
    expect(messages[0]).toBe('The selected tool no longer fits these files, so it was cleared.');
    expect(messages[1]).toMatch(/^1 file added \(PNG image\)\./);
    expect(messages).toHaveLength(2);
  });

  it('mounts an editor tool’s options exactly once when it is selected', async () => {
    deliver([await fixture('small.pdf')]);
    await until('the tool grid', () => count('.toolcard[data-tool="pdf-to-images"]') === 1);

    const mounts = watchOptionMounts();

    // pdf-to-images has a bespoke `editor`, so it is `syncEditor`'s business —
    // and `select()`'s. Exactly one of them may mount it.
    one<HTMLButtonElement>('.toolcard[data-tool="pdf-to-images"]').click();

    // select() hands focus to Run only after its OWN mount has landed, and a
    // racing mount would have started earlier and landed first, so by here both
    // would have been counted.
    await until('Run to take focus', () => document.activeElement === one('.run .btn--primary'));
    await settle();

    expect(mounts()).toBe(1);
    expect(count('.run__options .options')).toBe(1);
  });
});

// Task 8 moved the tool grid into ui/zones/catalogue.ts, whose render()
// rebuilds every card from scratch on every call — EXCEPT when the grid
// SIGNATURE (which tools are in which tier) is unchanged from last time, in
// which case it updates `.is-selected` on the existing nodes instead (see
// `lastSignature` there for why). That short-circuit exists because
// selecting a tool never changes which tools are in which tier, so without
// it, every selection tears down and rebuilds the whole grid for no reason —
// discarding the DOM identity of every card in it, including whichever one a
// click just landed on.
//
// CORRECTION, kept here so nobody re-derives the wrong conclusion: an
// earlier version of this test asserted that `document.activeElement` never
// read `document.body` mid-click, on the theory that destroying the focused
// card would bounce focus through <body>. That theory is WRONG. An isolated
// probe — two buttons, NEITHER ever removed from the document, one calling
// `.focus()` on the other — reproduces the exact same
// focusin(A)/focusout(<body>)/focusin(B) sequence. Reading
// `document.activeElement` as `document.body` during a `focusout` event is
// normal Chromium behaviour for ANY `.focus()`-driven transfer between two
// elements, not evidence a node was destroyed: `select()`'s own, deliberate
// `runButton.focus()` produces it on every selection regardless of whether
// the grid rebuilds. So the assertion below tests the thing that is
// actually only true when the rebuild is avoided: the clicked card's own
// node identity survives the render, unchanged, with the tick applied to
// it in place. (Also invisible to a regression here: `.click()`, the DOM
// method, does not reliably reproduce a real pointer interaction's focus
// behaviour, so this needs a real, Playwright-driven click.)
describe('the catalogue does not rebuild under a real click', () => {
  it('updates the tick on the SAME card node instead of replacing it with a rebuilt look-alike', async () => {
    deliver([await fixture('small.pdf')]);
    await until('the tool grid', () => count('.toolcard[data-tool="pdf-split"]') === 1);

    const card = one<HTMLButtonElement>('.toolcard[data-tool="pdf-split"]');

    // A REAL click via Playwright, driving actual mouse events (this file
    // runs in real headless Chromium — see vitest.workspace.ts's `browser`
    // project). `.click()` (the DOM method) does not reliably reproduce a
    // real pointer interaction's own focus behaviour, which is why an
    // earlier, mistaken version of this test — see the comment above —
    // needed a real click to observe anything at all.
    await userEvent.click(card);
    await until('Run to take focus', () => document.activeElement === one('.run .btn--primary'));

    // The SAME node, not a rebuilt look-alike. Before the fix, selecting a
    // tool fully rebuilt the grid on every call (there was no signature
    // check to skip it), so `card` would now be a detached element and
    // `querySelector` would find a freshly-built replacement instead.
    expect(root.querySelector('.toolcard[data-tool="pdf-split"]')).toBe(card);
    expect(card.isConnected).toBe(true);
    expect(card.classList.contains('is-selected')).toBe(true);
    expect(card.getAttribute('aria-pressed')).toBe('true');
  });
});
