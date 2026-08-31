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
// `refreshTools()` (which calls `syncEditor()`) and only then `syncWork()` —
// is what keeps it holding the PREVIOUS snapshot's selection while the grid
// and the work zone (ui/zones/work.ts, Stage 3) are rebuilt.
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
// while a tool is selected. This is the guard rail Stage 3's split into
// ui/zones/work.ts leans on — `syncWork()` is the function that replaced
// the old `syncRunPanel()`, and it must still run last.
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
  // Task 13: `mountShell` reads `location.hash` on mount (`router.start()`),
  // so a hash a PRIOR test left behind would pre-select a tool before this
  // test's own setup ever runs — reset before mounting, not only after, in
  // case a test elsewhere in the suite (or a failed one that skipped its own
  // cleanup) left one behind.
  location.hash = '';
  root = document.createElement('div');
  document.body.append(root);
  observers = [];
  shell = mountShell(root);
});

afterEach(() => {
  for (const observer of observers) observer.disconnect();
  shell.destroy();
  root.remove();
  location.hash = '';
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
    // Task 10: the cold catalogue already shows every tool, `pdf-split`
    // included, before any file lands — so waiting on the CARD proves
    // nothing about intake having finished. The tray is what `intake()`
    // populates last, after `state.addFiles()` has already re-rendered the
    // grid warm, so waiting on it is the one signal that cannot fire early.
    await until('the file to land', () => count('.tray__item') === 1);

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
    // Task 10: `pdf-to-images` is already on screen cold (every tool is), so
    // waiting on the card would let the click race `intake()` — clicking
    // before `state.addFiles()` lands would select the tool with zero files,
    // and the file arriving a moment later would look exactly like an
    // editor's file set changing under it, mounting its options a genuine
    // SECOND time. Waiting on the tray closes that race.
    await until('the file to land', () => count('.tray__item') === 1);

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

// Task 13: the router wired into `select()`. THE CRITICAL PREREQUISITE
// carried over from Task 12's review — `createRouter`'s own doc comment on
// `lastWrittenHash` explains that a same-tick multi-write pattern (two
// EXTERNAL hash writes landing back on the id already on screen, neither of
// them this shell's own `router.navigate()` echo) makes `onRoute` fire
// TWICE for the identical id. Never a wrong id, never a dropped one — just a
// duplicate. `select(id, { fromRouter: true })`'s guard exists so that
// second call is a total no-op: without it, the duplicate falls through to
// `mountOptions()` a second time and rebuilds the options panel from its
// schema defaults, silently discarding whatever the user had already typed.
describe('a duplicate route for the tool already on screen', () => {
  it('does not remount the options panel or discard what the user typed', async () => {
    // Selected the way a real deep link (or Back/Forward) delivers it — an
    // EXTERNAL hash write, not a click — so this exercises `router.start()`
    // / the `hashchange` listener, not `select()`'s click path.
    location.hash = '#/qr-generate';
    await until('Run to take focus', () => document.activeElement === one('.run .btn--primary'));

    const mounts = watchOptionMounts();
    const input = one<HTMLInputElement>('.run__options input.field--text');
    input.value = 'https://example.com/typed-by-the-user';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Two more EXTERNAL writes, landing back on 'qr-generate', in the same
    // synchronous turn. Both resulting `hashchange` events are handled only
    // once `location.hash` has already settled at its FINAL value (all
    // three assignments run synchronously before either event is
    // dispatched), and the router reads the CURRENT hash, not a value
    // carried on the event — so neither event ever reports 'pdf-merge': both
    // report 'qr-generate', the same id twice, exactly the case above.
    location.hash = '#/pdf-merge';
    location.hash = '#/qr-generate';
    await settle();

    expect(mounts()).toBe(0);
    expect(one<HTMLInputElement>('.run__options input.field--text').value).toBe(
      'https://example.com/typed-by-the-user',
    );
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
    // Task 10: the cold catalogue already carries a `pdf-split` card before
    // any file lands, so waiting on the card would let the click race
    // `intake()` — landing while still cold, with the warm rebuild (a real,
    // deliberate content change, not the pure-selection case this test is
    // about) arriving a moment later instead of before. Waiting on the tray
    // guarantees the grid is already in its stable warm shape.
    await until('the file to land', () => count('.tray__item') === 1);

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

// Regression guard for the flicker a code review caught by instrumenting the
// running app, not from reading the diff: `.workbench` is mounted and
// painted at rest from the very first frame (Task 10 — it never leaves, only
// the hero does), but `paint()`'s hero-exit call used to be `morphToTray`,
// which treated its SECOND argument as an entrance and snapped it to
// `opacity: 0; transform: translateY(...) scale(...)` synchronously, on
// every single browsing -> !browsing transition. The fix (`fadeHero` in
// motion.ts) takes no second element at all, which makes the bug's shape
// structurally unreachable through it — the assertions below are what would
// have caught the old shape regardless, by watching the one element that
// must never move for either headline path: dropping a file cold, and
// picking a tool (Generate QR code, reachable with zero files) cold.
describe('the always-visible workbench never gets treated as an entrance', () => {
  function expectWorkbenchAtRest(): void {
    const workbench = one<HTMLElement>('.workbench');
    expect(workbench.style.opacity).toBe('');
    expect(workbench.style.transform).toBe('');
  }

  it('stays untouched when a file lands cold', async () => {
    expectWorkbenchAtRest();

    deliver([await fixture('small.pdf')]);
    // The tray is the signal that `state.addFiles()` — and with it `paint()`,
    // which is what fires the hero's exit — has already run synchronously;
    // see the comment on the same wait elsewhere in this file.
    await until('the file to land', () => count('.tray__item') === 1);

    expectWorkbenchAtRest();
    await settle();
    expectWorkbenchAtRest();
  });

  it('stays untouched when a generator is picked cold, with no files at all', async () => {
    expectWorkbenchAtRest();

    one<HTMLButtonElement>('.toolcard[data-tool="qr-generate"]').click();
    await until('Run to take focus', () => document.activeElement === one('.run .btn--primary'));

    expectWorkbenchAtRest();
    await settle();
    expectWorkbenchAtRest();
  });
});
