// src/ui/router.ts — hash <-> tool id, and nothing else.
//
// The original design spec called for hash routing in §1 and it was never
// built. A hash is the right mechanism here for a reason worth stating: it
// never reaches the network, so a deep link needs no service-worker rule and
// no server rewrite — `#/merge-pdfs` is the same document request as `/`.
//
// FILES ARE NEVER IN THE URL. They stay in memory. A shared link opens the
// tool empty, so it can never carry anyone's data anywhere.

/** The tool id in `hash`, or null for the catalogue. */
export function toolIdFromHash(hash: string): string | null {
  const path = hash.replace(/^#/, '').replace(/\/$/, '');
  if (path === '' || path === '/') return null;
  const id = path.startsWith('/') ? path.slice(1) : path;
  // One segment only — a nested path is a typo, not a route to guess at.
  if (id === '' || id.includes('/')) return null;
  try {
    return decodeURIComponent(id);
  } catch {
    // decodeURIComponent throws URIError on a malformed escape (e.g. a
    // truncated multi-byte sequence like `%E0%A4%A`). Treat it the same as
    // any other unparseable route: fall back to the catalogue, not a crash.
    return null;
  }
}

export function hashForTool(id: string | null): string {
  return id === null ? '#/' : `#/${encodeURIComponent(id)}`;
}

export type RouterHandle = {
  /** Push a route without re-entering `onRoute`. */
  navigate(id: string | null): void;
  /** Read the current URL and fire `onRoute` once. */
  start(): void;
  destroy(): void;
};

export function createRouter(init: {
  isKnownTool: (id: string) => boolean;
  onRoute: (id: string | null) => void;
}): RouterHandle {
  // The hash this router itself last wrote, or null once that write's own
  // echo has been accounted for.
  //
  // `navigate()` sets `location.hash`, which fires `hashchange`
  // asynchronously — without a guard the router would re-enter `onRoute` for
  // a route it just wrote itself. A first-draft guard for this is a boolean
  // flag set before the write and cleared by `setTimeout(…, 0)` after it.
  // That is unsound in two directions:
  //
  //   - Too weak: a boolean has no memory of WHICH hash is in flight, so it
  //     blindly swallows the next `hashchange` no matter what caused it. A
  //     real user hashchange (back/forward, an edited address bar) that
  //     lands inside that timing window — between the synchronous write and
  //     whenever the 0ms timeout happens to fire — is dropped on the floor.
  //     `setTimeout(…, 0)` gives no ordering guarantee relative to the
  //     browser's own `hashchange` dispatch; it is a race, not a guarantee.
  //   - Too eager to reset: if a second `navigate()` lands in the same tick
  //     (e.g. deselect-then-reselect, or two rapid tool switches), the first
  //     call's timeout clears the flag while the second call's own
  //     `hashchange` is still pending, so that second echo leaks through and
  //     re-enters `onRoute`.
  //
  // Comparing against the LAST HASH THIS ROUTER WROTE fixes both: a
  // `hashchange` is swallowed only when the URL it produced is exactly what
  // we last asked for, and only once (it is reset to null the instant it is
  // used, so it can never mask a later, unrelated change that happens to
  // coincide with the same value). No timer, no timing assumption — a
  // `hashchange` is compared against a value, not raced against a clock.
  let lastWrittenHash: string | null = null;

  function read(): string | null {
    const id = toolIdFromHash(location.hash);
    // An unknown id falls back to the catalogue rather than a blank screen.
    return id !== null && init.isKnownTool(id) ? id : null;
  }

  const onHashChange = (): void => {
    if (location.hash === lastWrittenHash) {
      // The echo of our own navigate() — consume it once and stop.
      lastWrittenHash = null;
      return;
    }
    init.onRoute(read());
  };

  window.addEventListener('hashchange', onHashChange);

  return {
    navigate(id) {
      const next = hashForTool(id);
      if (location.hash === next) return;
      lastWrittenHash = next;
      location.hash = next;
    },
    start() {
      init.onRoute(read());
    },
    destroy() {
      window.removeEventListener('hashchange', onHashChange);
    },
  };
}
