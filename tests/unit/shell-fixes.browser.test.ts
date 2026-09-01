// tests/unit/shell-fixes.browser.test.ts — regression coverage for the
// final whole-branch review's F2, F3, F4, F5 and F6, plus NB2 from the
// re-review of that fix wave (see
// .superpowers/sdd/2026-08-30-ui-overhaul/progress.md,
// .superpowers/sdd/2026-08-30-ui-overhaul/final-fix-report.md and
// .superpowers/sdd/2026-08-30-ui-overhaul/nb-fix-report.md).
//
// Real headless Chromium, the real registry, real fixture bytes through the
// app's own hidden <input> — same technique as shell.browser.test.ts, which
// this file deliberately does NOT touch (it is pinned; see its own header
// comment and the final-fix report for why these live here instead).
//
// F1 is covered separately at the deterministic state.ts level
// (tests/unit/state.test.ts) rather than here: reproducing it against a REAL
// running job would mean racing real Worker timing, which is exactly the
// kind of flakiness this suite avoids elsewhere by waiting on signals the
// app itself produces. state.ts's `pruneSelection` gate is the actual
// mechanism the fix lives in, and it is fully exercised without a worker.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mountShell, type ShellHandle } from '../../src/ui/shell';
// NB2's assertions read real computed styles (opacity/cursor) off
// `.tray__remove`/`.tray__nudge`, which only exist once app.css itself is
// loaded — `shell.ts` never imports its own stylesheet (main.ts does that
// for the real app), so this file pulls it in explicitly, scoped to this
// test file alone.
import '../../src/styles/app.css';

/** A committed fixture, as a File the sniffer will recognise by its bytes. */
async function fixture(name: string): Promise<File> {
  const url = new URL(`../fixtures/${name}`, import.meta.url).href;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load fixture ${name}: ${response.status}`);
  return new File([new Uint8Array(await response.arrayBuffer())], name);
}

let root: HTMLElement;
let shell: ShellHandle;

beforeEach(() => {
  location.hash = '';
  root = document.createElement('div');
  document.body.append(root);
  shell = mountShell(root);
});

afterEach(() => {
  shell.destroy();
  root.remove();
  location.hash = '';
});

/** Same technique shell.browser.test.ts uses: the app's own intake path. */
function deliver(files: File[]): void {
  const picker = root.querySelector<HTMLInputElement>('input[type="file"]');
  if (!picker) throw new Error('the dropzone rendered no file input');
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  picker.files = transfer.files;
  picker.dispatchEvent(new Event('change'));
}

async function until(what: string, ready: () => boolean, limit = 10_000): Promise<void> {
  const started = performance.now();
  while (!ready()) {
    if (performance.now() - started > limit) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

function settle(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const count = (selector: string): number => root.querySelectorAll(selector).length;

function one<T extends Element>(selector: string): T {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`nothing matched ${selector}`);
  return found;
}

// ---------------------------------------------------------------------------
// F2 — the palette invites rather than refuses.
// ---------------------------------------------------------------------------
describe('F2 — the palette invites rather than refuses', () => {
  it('cold, with no files, Ctrl+K -> "Merge PDFs" -> Enter selects it and closes, instead of refusing', async () => {
    // The exact repro from the review: cold, no files, open the palette,
    // type the tool's name, press Enter.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    const backdrop = document.querySelector<HTMLElement>('.palette-backdrop');
    if (!backdrop) throw new Error('the palette did not open on Ctrl+K');
    expect(backdrop.hidden).toBe(false);

    const input = backdrop.querySelector<HTMLInputElement>('.palette__input');
    if (!input) throw new Error('the palette rendered no search input');
    input.value = 'Merge PDFs';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    // Before the fix: `commit()`'s `if (reason) return` kept this open and
    // refusing, since "needs at least 2 files" IS a non-null
    // unavailableReason. The fix: only a hard TYPE mismatch refuses; a mere
    // count shortfall (including zero files loaded) selects and closes.
    expect(backdrop.hidden).toBe(true);

    await until('pdf-merge to become the route', () => location.hash === '#/pdf-merge');
    // Zone 3 reports what it needs, exactly like picking the card cold does
    // (spec §4.5) — never a silent, still-disabled button with no reason.
    await until('Run to report what it needs', () =>
      /needs at least 2 files/i.test(one<HTMLButtonElement>('.run .btn--primary').textContent ?? ''),
    );
    expect(one<HTMLButtonElement>('.run .btn--primary').disabled).toBe(true);
  });

  it('still refuses a genuine TYPE mismatch, and stays open to explain it', async () => {
    deliver([await fixture('small.pdf')]);
    await until('the file to land', () => count('.tray__item') === 1);

    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }),
    );
    const backdrop = document.querySelector<HTMLElement>('.palette-backdrop');
    if (!backdrop) throw new Error('the palette did not open on Ctrl+K');

    const input = backdrop.querySelector<HTMLInputElement>('.palette__input');
    if (!input) throw new Error('the palette rendered no search input');
    // image-convert only accepts image/*; a PDF is loaded, so this is a hard
    // type mismatch — bringing more files of the same (PDF) kind can never
    // fix it. This must still refuse.
    input.value = 'Convert image';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );

    expect(backdrop.hidden).toBe(false);
    expect(backdrop.textContent).toMatch(/doesn.t work with these files/i);
    // Never silently selected in the background either.
    expect(location.hash).not.toMatch(/image-convert/);
  });
});

// ---------------------------------------------------------------------------
// F3 — the hero never gets stuck permanently hidden while browsing.
// ---------------------------------------------------------------------------
describe('F3 — the hero survives a rapid select/deselect', () => {
  it('two selections of the same cold generator, back to back with no await between them, leave the hero visible', async () => {
    // `.click()` (not userEvent) is deliberate here: it dispatches
    // synchronously, in the SAME script turn, so there is zero real time
    // between the two clicks — the exact race the review's "~60ms apart"
    // repro needs, guaranteed rather than timed. The first click SELECTS
    // (browsing -> ready) and fires `fadeHero`; the second is the card's own
    // click-to-deselect toggle, which lands before that promise's `.then`
    // has run (a resolved promise's continuation is always at least one
    // microtask away, never synchronous — true whether or not this
    // environment prefers reduced motion).
    const card = one<HTMLButtonElement>('.toolcard[data-tool="qr-generate"]');
    card.click();
    card.click();

    // Long enough for fadeHero's real 120ms timer (motion.ts's
    // HERO_EXIT_DURATION_MS) to have landed, whether or not this environment
    // prefers reduced motion.
    await settle(300);

    expect(one<HTMLElement>('.hero').hidden).toBe(false);
    expect(count('h1')).toBeGreaterThan(0);
    // filesZone.onClear's own `dropzone.focus()` targets a button inside the
    // hero — stranded if the hero above is wrongly hidden. Not exercised by
    // this particular flow, but the button must at least be reachable.
    expect(one<HTMLButtonElement>('.hero .btn--primary').isConnected).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F4 — the URL never desyncs from the selection.
// ---------------------------------------------------------------------------
describe('F4 — Remove all files does not leave a stale URL behind', () => {
  it('resets the hash to the catalogue, and a later re-selection of the same tool is not swallowed', async () => {
    deliver([await fixture('small.pdf'), await fixture('small.pdf')]);
    await until('the files to land', () => count('.tray__item') === 2);

    one<HTMLButtonElement>('.toolcard[data-tool="pdf-merge"]').click();
    await until('the route to update', () => location.hash === '#/pdf-merge');

    one<HTMLButtonElement>('.clearbtn').click();
    await until('the tray to empty', () => count('.tray__item') === 0);

    // Before the fix: `clearFiles()` never called `router.navigate(null)`,
    // reached via `refreshTools`'s own prune-teardown — so the hash stayed
    // `#/pdf-merge` after every file (and the selection) was gone.
    expect(location.hash === '' || location.hash === '#/').toBe(true);

    // The downstream consequence the review named: a stale hash makes
    // `navigate()`'s own echo-guard (`location.hash === next`) swallow the
    // NEXT genuine selection of that same tool. Bring files back and pick it
    // again — the route must actually reach it, not silently no-op.
    deliver([await fixture('small.pdf'), await fixture('small.pdf')]);
    await until('the files to land again', () => count('.tray__item') === 2);
    one<HTMLButtonElement>('.toolcard[data-tool="pdf-merge"]').click();

    await until('the route to reach pdf-merge again', () => location.hash === '#/pdf-merge');
    expect(location.hash).toBe('#/pdf-merge');
  });

  // Regression guard for a bug an earlier version of THIS fix introduced
  // (caught live by tests/e2e/tool-first.spec.ts's "gives a tool its own
  // URL" test going red, not by anything in this file): centralising
  // `router.navigate(null)` inside `clearSelection()` made it fire
  // unconditionally, including when `clearSelection` is reached via
  // `select(null, { fromRouter: true })` — i.e. Back/Forward. A fresh page's
  // `location.hash` is the EMPTY STRING, not `'#/'`, so `navigate()`'s own
  // `location.hash === next` echo-guard did not recognise a Back navigation
  // to that state as "already there" and wrote `'#/'` over it anyway —
  // silently pushing an extra history entry that broke the browser's own
  // Forward stack. The fix keeps `router.navigate(null)` at each ORIGINAL
  // call site instead, each already gated on whether IT is a route.
  it('a router-driven clear (simulating Back to a hash-less entry) does not overwrite the hash a route already set', async () => {
    one<HTMLButtonElement>('.toolcard[data-tool="qr-generate"]').click();
    await until('the route to update', () => location.hash === '#/qr-generate');

    // A real Back navigation's own hashchange, landing on the EMPTY STRING —
    // not '#/' — exactly what a browser reports for the original,
    // hash-less entry `beforeEach` starts every test from.
    location.hash = '';
    await until(
      'the selection to clear in response',
      () => count('.toolcard.is-selected[data-tool="qr-generate"]') === 0,
    );

    expect(location.hash).toBe('');
  });
});

// ---------------------------------------------------------------------------
// F5 — the 'results' phase is reachable.
// ---------------------------------------------------------------------------
describe('F5 — the results phase is genuinely reachable', () => {
  it('reaches [data-phase="results"] after a real run finishes successfully', async () => {
    deliver([await fixture('small.pdf')]);
    await until('the file to land', () => count('.tray__item') === 1);

    one<HTMLButtonElement>('[data-tool="hash"]').click();
    await until('Run to take focus', () => document.activeElement === one('.run .btn--primary'));
    one<HTMLButtonElement>('.run .btn--primary').click();

    // `results.show()` unhides the tray BEFORE its own `await flyToResults`
    // settles, and `state.setResults(true)` — the thing under test — only
    // runs once `show()` has fully resolved. Polling the phase attribute
    // itself, rather than the tray's visibility, is what actually waits for
    // that: otherwise this could observe the tray already visible while the
    // machine has not been told yet, which is exactly the gap F5 is about.
    await until(
      "the phase to reach 'results'",
      () => one<HTMLElement>('#stage').dataset.phase === 'results',
    );
    expect(one<HTMLElement>('#stage').dataset.phase).toBe('results');
  });

  it('reaches [data-phase="results"] on a job-level FAILURE too — a failure is still a result', async () => {
    deliver([await fixture('corrupt.pdf')]);
    await until('the file to land', () => count('.tray__item') === 1);

    one<HTMLButtonElement>('.toolcard[data-tool="pdf-split"]').click();
    await until('Run to take focus', () => document.activeElement === one('.run .btn--primary'));
    one<HTMLButtonElement>('.run .btn--primary').click();

    await until(
      "the phase to reach 'results'",
      () => one<HTMLElement>('#stage').dataset.phase === 'results',
    );
    expect(count('.card--failed')).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// F6 — a stale preset caption is retracted, never left asserting a lie.
// ---------------------------------------------------------------------------
describe('F6 — preset staleness retracts the caption, keeps the value', () => {
  it('retracts "from the first file" once that first file leaves the tray, without touching the typed-over value', async () => {
    // small.pdf -> basename 'small' is what zip-create's preset computes.
    deliver([await fixture('small.pdf')]);
    await until('the file to land', () => count('.tray__item') === 1);

    one<HTMLButtonElement>('[data-tool="zip-create"]').click();
    await until('Run to take focus', () => document.activeElement === one('.run .btn--primary'));

    const nameField = one<HTMLInputElement>('.run__options input.field--text');
    expect(nameField.value).toBe('small');
    expect(one<HTMLElement>('.run__options .opt__because').textContent).toMatch(
      /from the first file/i,
    );

    // Add an unrelated file, then remove the ORIGINAL one the preset was
    // computed from — the tray no longer contains anything resembling
    // "small", but the field must not be silently rebuilt out from under
    // whatever the user might already have typed into it.
    deliver([await fixture('a.png')]);
    await until('the second file to land', () => count('.tray__item') === 2);

    const smallItem = [...root.querySelectorAll<HTMLLIElement>('.tray__item')].find((item) =>
      item.textContent?.includes('small.pdf'),
    );
    if (!smallItem) throw new Error('small.pdf was not found in the tray');
    const removeButton = smallItem.querySelector<HTMLButtonElement>('.tray__remove');
    if (!removeButton) throw new Error('the tray item rendered no remove button');
    removeButton.click();

    await until('the tray to settle at one file', () => count('.tray__item') === 1);
    await settle();

    // The VALUE survives untouched...
    expect(one<HTMLInputElement>('.run__options input.field--text').value).toBe('small');
    // ...but the caption asserting where it came from does not: there is no
    // file even resembling "small" in the tray any more, so "from the first
    // file" would be a false sentence left on screen.
    expect(count('.run__options .opt__because')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NB2 — a frozen tray control looks frozen, matching its `.tray__nudge`
// sibling, instead of still lighting up as if live.
// ---------------------------------------------------------------------------
describe('NB2 — the frozen remove control reads as disabled, not merely inert', () => {
  it('while a run is in flight, .tray__remove matches .tray__nudge\'s disabled opacity/cursor, and the row drops its grab cursor', async () => {
    deliver([await fixture('small.pdf'), await fixture('small.pdf')]);
    await until('the files to land', () => count('.tray__item') === 2);

    one<HTMLButtonElement>('.toolcard[data-tool="pdf-merge"]').click();
    await until('Run to take focus', () => document.activeElement === one('.run .btn--primary'));

    const item = one<HTMLLIElement>('.tray__item');
    const remove = item.querySelector<HTMLButtonElement>('.tray__remove');
    if (!remove) throw new Error('the tray item rendered no remove button');
    // nudges[1] is the "move later" arrow — for the FIRST of two items it is
    // NOT disabled by position (only the "move earlier" arrow, nudges[0], is)
    // so it is a genuine live-vs-frozen control to compare against, not one
    // that was already disabled for an unrelated reason.
    const nudgeDown = item.querySelectorAll<HTMLButtonElement>('.tray__nudge')[1];
    if (!nudgeDown) throw new Error('the tray item rendered no second nudge button');

    // Baseline, before the run: both controls are genuinely live.
    expect(remove.disabled).toBe(false);
    expect(nudgeDown.disabled).toBe(false);
    expect(getComputedStyle(remove).cursor).toBe('pointer');
    expect(item.getAttribute('draggable')).toBe('true');
    expect(getComputedStyle(item).cursor).toBe('grab');

    // `start()` runs synchronously up to its first `await` (the dynamic
    // `import('../core/pipeline')`), and that synchronous prefix is what
    // calls `setRunning(true)` — so immediately after `.click()` returns,
    // the phase flip and the tray's freeze have both already happened, with
    // no polling/race needed to observe the frozen instant.
    one<HTMLButtonElement>('.run .btn--primary').click();
    expect(one<HTMLElement>('#stage').dataset.phase).toBe('running');

    // The bug: filetray.ts froze `remove.disabled` but app.css had no
    // `.tray__remove:disabled` rule at all, so the button stayed at full
    // opacity with a pointer cursor while `.tray__nudge:disabled` right next
    // to it correctly dimmed — a control that LOOKS live but silently
    // no-ops on click. Assert the two now genuinely match, not just that
    // each individually has "some" disabled style.
    expect(remove.disabled).toBe(true);
    expect(nudgeDown.disabled).toBe(true);
    const removeStyle = getComputedStyle(remove);
    const nudgeStyle = getComputedStyle(nudgeDown);
    expect(removeStyle.opacity).toBe(nudgeStyle.opacity);
    expect(removeStyle.cursor).toBe(nudgeStyle.cursor);
    expect(removeStyle.opacity).toBe('0.3');
    expect(removeStyle.cursor).toBe('not-allowed');

    // Drag is off too (`item.node.draggable = !frozen`) — the row must not
    // keep advertising `cursor: grab` for an affordance that no longer works.
    expect(item.getAttribute('draggable')).toBe('false');
    expect(getComputedStyle(item).cursor).toBe('default');

    // Let the run finish so `afterEach`'s `shell.destroy()` does not tear
    // down a shell with a job still in flight.
    await until(
      "the phase to reach 'results'",
      () => one<HTMLElement>('#stage').dataset.phase === 'results',
    );
  });
});
