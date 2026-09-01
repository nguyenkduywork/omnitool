// tests/unit/shell-fixes.browser.test.ts — regression coverage for the UI
// overhaul's final whole-branch review (F2, F3, F4, F5, F6) and its
// re-review (NB2), plus the fourth, independent review pass that came after
// the overhaul had already merged (I1, I3, and the NB1-NB3 follow-ups on
// I1/I2's own fixes). Each describe block below cites its own finding by
// name; none of this depends on the reviews' own working notes, which lived
// under the gitignored `.superpowers/` and are not a durable citation for
// anyone who clones this repo.
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

/**
 * A few real megabytes, compressed at the hardest level `gzip`'s own options
 * offer, so the worker genuinely takes long enough for a `hashchange`
 * (queued as its own browser task, same as any other) to be PROCESSED while
 * `dataset.phase` is still `'running'` — a handful of fixture bytes finishes
 * in well under one event-loop turn on real hardware and cannot be trusted
 * to outlast anything, which is exactly the kind of race this suite avoids
 * elsewhere by waiting on signals the app itself produces (see this file's
 * own header comment). PDF-shaped so a `.toolcard` (not just a
 * `.utilitypill`) is on screen to assert against too —
 * `application/octet-stream` bytes leave every format-aware tool absent
 * from the grid entirely (checked live: no `.toolcard` renders at all for a
 * generic blob, only the utility pills). Shared across the I1 and its
 * follow-up describe blocks below, which all need a run that genuinely
 * outlasts a synchronous assertion.
 */
function slowFile(): File {
  const size = 8 * 1024 * 1024;
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('%PDF-1.4\n'), 0);
  let seed = 7;
  for (let i = 16; i < size; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = seed & 0xff;
    bytes[i + 1] = (seed >> 8) & 0xff;
    bytes[i + 2] = (seed >> 16) & 0xff;
    bytes[i + 3] = (seed >> 24) & 0xff;
  }
  return new File([bytes], 'slow.pdf', { type: 'application/pdf' });
}

function setCompressionLevel(value: string): void {
  const level = one<HTMLInputElement>('.run__options input[type="range"]');
  level.value = value;
  level.dispatchEvent(new Event('input', { bubbles: true }));
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
  // UPDATED for I2 (independent review pass #4): this test originally proved
  // that "Remove all files" reset the hash to the catalogue. That behaviour
  // is exactly what I2 found and fixed — `clearFiles()` used to null
  // `selected` unconditionally, discarding a picked tool that the tray's own
  // per-row `x` (ending at the same zero-files state via `setFiles([])`)
  // left alone, and the catalogue-reset hash was a symptom of that, not a
  // property worth keeping. `clearFiles()` now matches `setFiles([])`: an
  // empty tray is a count shortfall (TOOL PICKED, spec §4.2), not a reason to
  // drop the pick, so the hash has nothing to go stale ABOUT any more — it
  // simply never moves. The property F4 exists to protect — the URL always
  // matches what's actually selected, never left behind by this button — is
  // asserted the same way, just against the corrected behaviour.
  it('keeps the hash pointed at the still-selected tool, and a later file drop needs no re-selection', async () => {
    deliver([await fixture('small.pdf'), await fixture('small.pdf')]);
    await until('the files to land', () => count('.tray__item') === 2);

    one<HTMLButtonElement>('.toolcard[data-tool="pdf-merge"]').click();
    await until('the route to update', () => location.hash === '#/pdf-merge');

    one<HTMLButtonElement>('.clearbtn').click();
    await until('the tray to empty', () => count('.tray__item') === 0);

    // I2: the pick survives — TOOL PICKED, not a fall-back to the catalogue —
    // so the hash is still exactly right, not merely "not stale".
    expect(location.hash).toBe('#/pdf-merge');
    expect(one<HTMLElement>('#stage').dataset.phase).toBe('tool-picked');
    expect(document.querySelector('.toolcard.is-selected[data-tool="pdf-merge"]')).not.toBeNull();

    // Bringing files back needs no re-click — the selection never left, so
    // there is no `navigate()` call here for a stale echo-guard to swallow
    // (the original regression this test protects: a stale hash left behind
    // by this button used to make `navigate()`'s own `location.hash === next`
    // check swallow the NEXT genuine selection of that tool). Run simply
    // becomes enabled once the files satisfy it, hash untouched throughout.
    deliver([await fixture('small.pdf'), await fixture('small.pdf')]);
    await until('the files to land again', () => count('.tray__item') === 2);
    await until('Run to become enabled', () => !one<HTMLButtonElement>('.run .btn--primary').disabled);
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

// ---------------------------------------------------------------------------
// I1 — a run freezes the catalogue AND the URL, not just the tray and
// Run/Clear (independent review pass #4, both halves reproduced live against
// the running dev app before either fix landed).
// ---------------------------------------------------------------------------
describe('I1 — the catalogue and the URL both hold through a run', () => {
  it('disables every other card and pill while a run is in flight, and lifts it once the run ends', async () => {
    deliver([slowFile()]);
    await until('the file to land', () => count('.tray__item') === 1);

    one<HTMLButtonElement>('.utilitypill[data-tool="gzip"]').click();
    await until('Run to take focus', () => document.activeElement === one('.run .btn--primary'));
    setCompressionLevel('9');

    // A card AND a pill, both genuinely live before the run — pdf-split
    // never fits into gzip's own tier, and hash is a second, different
    // utility tool.
    const card = one<HTMLButtonElement>('.toolcard[data-tool="pdf-split"]');
    const pill = one<HTMLButtonElement>('.utilitypill[data-tool="hash"]');
    expect(card.disabled).toBe(false);
    expect(pill.disabled).toBe(false);

    one<HTMLButtonElement>('.run .btn--primary').click();
    // Synchronous prefix guarantee (see NB2 above): the phase flip has
    // already happened by the time `.click()` returns.
    expect(one<HTMLElement>('#stage').dataset.phase).toBe('running');

    // Before the fix: both stayed `disabled: false, tabIndex: 0` for the
    // run's whole duration — a click here was a silent no-op, not a control
    // that says it cannot act.
    expect(card.disabled).toBe(true);
    expect(pill.disabled).toBe(true);
    card.click();
    expect(one<HTMLElement>('.run__head h2').textContent).toBe('Gzip');
    expect(location.hash).toBe('#/gzip');

    await until(
      "the phase to reach 'results'",
      () => one<HTMLElement>('#stage').dataset.phase === 'results',
    );
    expect(card.disabled).toBe(false);
    expect(pill.disabled).toBe(false);
  });

  it('re-asserts the URL when a route arrives mid-run, so it never desyncs — even after the run ends', async () => {
    deliver([slowFile()]);
    await until('the file to land', () => count('.tray__item') === 1);

    one<HTMLButtonElement>('.utilitypill[data-tool="gzip"]').click();
    await until('the route to update', () => location.hash === '#/gzip');
    setCompressionLevel('9');

    one<HTMLButtonElement>('.run .btn--primary').click();
    expect(one<HTMLElement>('#stage').dataset.phase).toBe('running');

    // A real Back navigation's own hashchange — same technique F4's second
    // test above uses — landing on the catalogue while the job is still
    // running.
    location.hash = '';

    // Before the fix: `select()`'s `if (snap.phase === 'running') return`
    // dropped this route on the floor entirely, so the address bar stayed at
    // the catalogue's hash for the rest of the run — and, because nothing
    // ever ran afterwards to correct it, forever after too (reproduced live:
    // `hash: '#/'`, work heading still `Gzip`, `aria-pressed: 'true'`, phase
    // `results`). The fix re-asserts the moment the route arrives.
    await until('the hash to re-assert to the running tool', () => location.hash === '#/gzip');
    expect(one<HTMLElement>('#stage').dataset.phase).toBe('running');
    expect(one<HTMLElement>('.run__head h2').textContent).toBe('Gzip');

    await until(
      "the phase to reach 'results'",
      () => one<HTMLElement>('#stage').dataset.phase === 'results',
    );
    // The desync must not resurface once the run ends either.
    expect(location.hash).toBe('#/gzip');
    expect(one<HTMLElement>('.run__head h2').textContent).toBe('Gzip');
    expect(one<HTMLButtonElement>('.utilitypill[data-tool="gzip"]').getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

// ---------------------------------------------------------------------------
// I3 — a generator reads no file, whatever else is loaded (independent
// review pass #4, proved live by wrapping File.prototype.arrayBuffer against
// the running dev app: a PDF sitting in the tray got read in full and
// structure-cloned to the worker to run a tool declared `accepts: []`,
// `minInputs: 0`, `maxInputs: 0`, whose op reads only `options.text`).
// ---------------------------------------------------------------------------
describe('I3 — a generator never reads a file it declares it cannot take', () => {
  it('runs the QR generator with a PDF already loaded without ever reading that file', async () => {
    const reads: string[] = [];
    const original = File.prototype.arrayBuffer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only File.prototype patch
    (File.prototype as any).arrayBuffer = function (this: File) {
      reads.push(this.name);
      return original.call(this);
    };

    try {
      deliver([await fixture('small.pdf')]);
      await until('the file to land', () => count('.tray__item') === 1);

      // A ROUTE, not a click: `applicabilityFor` structurally excludes every
      // generator from all three warm-grid tiers (core/format.ts), so with a
      // file already loaded the only ways to reach `qr-generate` are the
      // bucket-aware palette or a direct route — this is the more dangerous
      // of the two, because it is the one where a file that was ALREADY in
      // the tray survives the switch, rather than a fresh deep link that
      // never carries one at all.
      location.hash = '#/qr-generate';
      await until('Run to take focus', () => document.activeElement === one('.run .btn--primary'));

      const input = one<HTMLInputElement>('.run__options input.field--text');
      input.value = 'https://example.com';
      input.dispatchEvent(new Event('input', { bubbles: true }));

      // Only reads from Run onward count — intake's own sniff reads a
      // `file.slice(...)` Blob, not the File itself, so it was never caught
      // by this wrap in the first place, but clearing here keeps the
      // assertion below about exactly one thing.
      reads.length = 0;
      one<HTMLButtonElement>('.run .btn--primary').click();

      await until(
        "the phase to reach 'results'",
        () => one<HTMLElement>('#stage').dataset.phase === 'results',
      );

      // The property that matters is not what the QR code produced (that is
      // qr-generate.op's own test's job) but that the file sitting in the
      // tray, unrelated to this tool, is never touched at all.
      expect(reads).toEqual([]);
      expect(count('.card--failed')).toBe(0);
    } finally {
      File.prototype.arrayBuffer = original;
    }
  });
});

// ---------------------------------------------------------------------------
// I1(a) follow-up — the narrow-layout "Change tool" button freezes too (a
// second, later pass over I1: `zones/catalogue.ts`'s `syncRunning` disabled
// every card and pill, but missed `.catalogue__back`'s own button, which
// reaches `shell.ts`'s `select()` through the exact same `init.onPick` path
// a card does — a silent no-op mid-run, on a control that is the ONLY
// zone-2 element left on screen below 768px once app.css hides
// `.catalogue__body` for `[data-phase='running']`).
// ---------------------------------------------------------------------------
describe('I1(a) follow-up — "Change tool" freezes with the rest of the catalogue', () => {
  it('disables .catalogue__back\'s button while a run is in flight, and lifts it once the run ends', async () => {
    deliver([slowFile()]);
    await until('the file to land', () => count('.tray__item') === 1);

    one<HTMLButtonElement>('.utilitypill[data-tool="gzip"]').click();
    await until('Run to take focus', () => document.activeElement === one('.run .btn--primary'));
    setCompressionLevel('9');

    const back = one<HTMLButtonElement>('.catalogue__back button');
    expect(back.disabled).toBe(false);

    one<HTMLButtonElement>('.run .btn--primary').click();
    expect(one<HTMLElement>('#stage').dataset.phase).toBe('running');

    expect(back.disabled).toBe(true);
    // Before the fix: still clickable here, and clicking it reached
    // select() via init.onPick, which silently no-op'd on its own running
    // guard — no visible change, nothing announced.
    const headingBefore = one<HTMLElement>('.run__head h2').textContent;
    back.click();
    expect(one<HTMLElement>('.run__head h2').textContent).toBe(headingBefore);

    await until(
      "the phase to reach 'results'",
      () => one<HTMLElement>('#stage').dataset.phase === 'results',
    );
    expect(back.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NB2 (independent review pass #4, a later look at I2's own fix) — Remove
// all files must focus something actually reachable, not the hero's own
// pick button when it stays hidden. Distinct from this file's EARLIER
// "NB2" block above (the re-review of the final whole-branch review, about
// the tray's frozen-control styling) — same label, two different review
// passes' own numbering; see this file's header comment.
// ---------------------------------------------------------------------------
describe('NB2 (pass #4) — Remove all files focuses a reachable control', () => {
  it('focuses the hero\'s pick button when the tray goes fully cold (no tool picked)', async () => {
    deliver([await fixture('small.pdf')]);
    await until('the file to land', () => count('.tray__item') === 1);

    one<HTMLButtonElement>('.clearbtn').click();
    await until('the tray to empty', () => count('.tray__item') === 0);

    expect(one<HTMLElement>('#stage').dataset.phase).toBe('browsing');
    expect(document.activeElement).toBe(one<HTMLButtonElement>('.hero .btn--primary'));
  });

  it('focuses the add-bar\'s "Add files" button when a tool is still picked (I2) — the hero stays hidden', async () => {
    deliver([await fixture('small.pdf')]);
    await until('the file to land', () => count('.tray__item') === 1);

    one<HTMLButtonElement>('.toolcard[data-tool="pdf-split"]').click();
    await until('Run to take focus', () => document.activeElement === one('.run .btn--primary'));

    one<HTMLButtonElement>('.clearbtn').click();
    await until('the tray to empty', () => count('.tray__item') === 0);

    expect(one<HTMLElement>('#stage').dataset.phase).toBe('tool-picked');
    // Before the fix: focus landed on the hero's own pick button, which
    // stays `display: none` here (paint()'s cold/browsing morph is the
    // ONLY thing that un-hides the hero, and TOOL PICKED never triggers
    // it) — measured live, a real Tab press from there fell all the way to
    // <body>, restarting the page's whole tab order.
    const addButton = one<HTMLButtonElement>('.addbar button');
    expect(document.activeElement).toBe(addButton);
    expect(addButton.offsetParent).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NB3 (independent review pass #4) — refreshTools's own prune-teardown must
// still reset the URL. This is the one remaining call site of shell.ts's
// `router.navigate(null)` (in the branch reacting to state.ts pruning a
// type-mismatched selection) after I2: the ORIGINAL F4 test asserted it via
// the "Remove all files" path, but that path no longer reaches this branch
// at all post-I2 (clearFiles no longer prunes — see the I2 commit), and
// F4's rewrite asserts the OPPOSITE-shaped property (the hash stays, rather
// than resets). Nothing else covers this call site.
// ---------------------------------------------------------------------------
describe('NB3 (pass #4) — a genuine type-mismatch prune still resets the URL', () => {
  it('resets the hash to the catalogue when the machine prunes a type-mismatched selection', async () => {
    deliver([await fixture('small.pdf')]);
    await until('the file to land', () => count('.tray__item') === 1);

    one<HTMLButtonElement>('.toolcard[data-tool="pdf-split"]').click();
    await until('the route to update', () => location.hash === '#/pdf-split');

    // A PNG next to the PDF: pdf-split's TYPE no longer fits — state.ts's
    // pruneSelection drops the selection on its own, and refreshTools's own
    // prune-teardown branch (shell.ts) is what calls router.navigate(null)
    // in response. Deleting that call today would leave the whole suite
    // green while resurrecting F4's original bug: reload resurrects a
    // pruned tool, and the stale hash makes the next genuine reselection of
    // that tool a no-op via navigate()'s own echo-guard.
    deliver([await fixture('a.png')]);
    await until('the selection to be pruned', () => count('.toolcard.is-selected') === 0);

    expect(location.hash === '' || location.hash === '#/').toBe(true);
  });
});
