// tests/unit/router.browser.test.ts — createRouter against a real location.
//
// Real headless Chromium: real `location.hash`, real asynchronous `hashchange`
// dispatch. `toolIdFromHash`/`hashForTool` are covered under Node in
// router.test.ts; what only a real browser can verify is the guard in
// `createRouter` — that a `navigate()` call does not re-enter `onRoute` for
// the `hashchange` it causes, while a `hashchange` NOT caused by this router
// (Back/Forward, an edited address bar, or another script) still does.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRouter } from '../../src/ui/router';
import type { RouterHandle } from '../../src/ui/router';

let router: RouterHandle | null = null;

/** Real hashchange dispatch is async; give it every chance to arrive. */
function settle(ms = 150): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function recorder(): { calls: Array<string | null>; onRoute: (id: string | null) => void } {
  const calls: Array<string | null> = [];
  return { calls, onRoute: (id) => calls.push(id) };
}

beforeEach(() => {
  location.hash = '';
});

afterEach(() => {
  router?.destroy();
  router = null;
  location.hash = '';
});

describe('createRouter', () => {
  it('start() reads the current URL and fires onRoute once', () => {
    location.hash = '#/merge-pdfs';
    const { calls, onRoute } = recorder();
    router = createRouter({ isKnownTool: () => true, onRoute });

    router.start();

    expect(calls).toEqual(['merge-pdfs']);
  });

  it('falls back to the catalogue for an unknown tool id, not a blank screen', () => {
    location.hash = '#/not-a-real-tool';
    const { calls, onRoute } = recorder();
    router = createRouter({ isKnownTool: (id) => id === 'merge-pdfs', onRoute });

    router.start();

    expect(calls).toEqual([null]);
  });

  // M2 (independent review pass #4): the test above proves the SCREEN falls
  // back correctly; it says nothing about the ADDRESS BAR. Before the fix,
  // `read()` folded an unknown id to `null` for `onRoute` alone and left
  // `location.hash` exactly as it found it — reproduced live, a reload at
  // `/#/not-a-real-tool` kept 29 cards on screen (right) with the URL still
  // reading `#/not-a-real-tool` (wrong). Spec §4.4 promises the catalogue,
  // and a stale hash left behind is not that.
  it('corrects an unknown tool id in the hash back to the catalogue', () => {
    location.hash = '#/not-a-real-tool';
    const { calls, onRoute } = recorder();
    router = createRouter({ isKnownTool: (id) => id === 'merge-pdfs', onRoute });

    router.start();

    expect(location.hash).toBe('#/');
    expect(calls).toEqual([null]);
  });

  it('does not re-enter onRoute for the echo of its own unknown-id correction', async () => {
    location.hash = '#/not-a-real-tool';
    // Let THIS assignment's own hashchange dispatch (to no listeners — the
    // router does not exist yet) before `createRouter` attaches one, so the
    // assertion below is only ever about the CORRECTION's echo, not a second,
    // unrelated hashchange this test's own setup happens to have queued.
    await settle();

    const { calls, onRoute } = recorder();
    router = createRouter({ isKnownTool: (id) => id === 'merge-pdfs', onRoute });

    router.start();
    expect(calls).toEqual([null]);

    await settle();

    // The correction's own hashchange, swallowed the same way navigate()'s
    // own writes always are — not a second, spurious `onRoute(null)` call.
    expect(calls).toEqual([null]);
  });

  it('navigate() writes the hash without re-entering onRoute for its own echo', async () => {
    const { calls, onRoute } = recorder();
    router = createRouter({ isKnownTool: () => true, onRoute });

    router.navigate('merge-pdfs');
    expect(location.hash).toBe('#/merge-pdfs');

    await settle();

    expect(calls).toEqual([]);
  });

  it('a hashchange this router did not cause still reaches onRoute', async () => {
    const { calls, onRoute } = recorder();
    router = createRouter({ isKnownTool: () => true, onRoute });

    // Not through navigate(): simulates Back/Forward or the address bar.
    location.hash = '#/qr-generate';
    await settle();

    expect(calls).toEqual(['qr-generate']);
  });

  it('does not swallow a real hashchange that follows one of its own writes', async () => {
    const { calls, onRoute } = recorder();
    router = createRouter({ isKnownTool: () => true, onRoute });

    router.navigate('merge-pdfs');
    await settle();
    expect(calls).toEqual([]); // the echo of our own write, correctly swallowed

    location.hash = '#/qr-generate'; // a change we did not make
    await settle();

    expect(calls).toEqual(['qr-generate']);
  });

  it('two navigate() calls in the same tick settle on exactly one onRoute call, for the final route', async () => {
    const { calls, onRoute } = recorder();
    router = createRouter({ isKnownTool: () => true, onRoute });

    // Chrome fires a separate hashchange for each distinct write, even two
    // queued back-to-back in the same synchronous turn — it does not
    // coalesce them into one event. A boolean-plus-setTimeout guard has no
    // memory of which hash is in flight, so it cannot tell those two events
    // apart from a real one, and depending on exactly when its timer fires
    // relative to the two hashchange dispatches it can end up re-entering
    // onRoute 0, 1, or 2 times. Comparing against the last hash THIS router
    // wrote settles it deterministically: the first event's hash still
    // matches (it hasn't been consumed yet) so it is swallowed, and the
    // second is let through exactly once, reporting the true final route.
    router.navigate('merge-pdfs');
    router.navigate('qr-generate');
    expect(location.hash).toBe('#/qr-generate');

    await settle();

    expect(calls).toEqual(['qr-generate']);
  });

  it('consumes its own echo only once, so a later real change back to the same hash still fires', async () => {
    const { calls, onRoute } = recorder();
    router = createRouter({ isKnownTool: () => true, onRoute });

    router.navigate('merge-pdfs');
    await settle();
    expect(calls).toEqual([]); // the echo, swallowed

    // A real change away, then a real change BACK to the exact value this
    // router itself last wrote (e.g. Forward returning to a URL it had
    // already visited). If the guard is never released after consuming its
    // one echo, this looks identical to that echo and gets swallowed too —
    // silently dropping a real navigation.
    location.hash = '#/qr-generate';
    await settle();
    expect(calls).toEqual(['qr-generate']);

    location.hash = '#/merge-pdfs';
    await settle();
    expect(calls).toEqual(['qr-generate', 'merge-pdfs']);
  });

  it('destroy() stops listening', async () => {
    const { calls, onRoute } = recorder();
    router = createRouter({ isKnownTool: () => true, onRoute });
    router.destroy();

    location.hash = '#/merge-pdfs';
    await settle();

    expect(calls).toEqual([]);
  });
});
