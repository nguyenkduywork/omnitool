// src/sw.ts — the service worker: offline support, nothing else.
//
// SCOPE (§1: zero network calls to anything but same-origin, ever):
//   * PRECACHE the app shell (the HTML entry + whatever it statically pulls
//     in — the exact set scripts/size-budget.mjs calls "initial") on install,
//     so a repeat visit boots instantly and offline reload works at all.
//   * RUNTIME-CACHE every other same-origin build asset (the lazily-imported
//     *.op.ts chunks, pdf-lib/pdfjs/fflate/qrcode, editors, the runner
//     worker) with STALE-WHILE-REVALIDATE the first time it is actually
//     fetched. Precaching those up front would mean downloading pdf.js on
//     every fresh visit even for someone who only ever hashes a file — the
//     opposite of the lazy-loading architecture the rest of the app is built
//     around.
//   * Everything else (a non-GET request, a cross-origin request) is left
//     alone — untouched, not even inspected beyond its URL, so this file can
//     never become the third-party leak §1 forbids.
//
// WHERE __PRECACHE__ COMES FROM
// ------------------------------
// This file has no imports (a service worker's own module graph is a
// separate build problem, and Vite's main build only code-splits what
// index.html's graph reaches). Bundling it would either (a) require adding
// sw.ts as a second Rollup entry — which taints scripts/size-budget.mjs's
// "every isEntry chunk" walk with an unrelated file — or (b) a bundler
// plugin dependency this project does not have. So vite.config.ts transforms
// this file directly (TS -> JS only, via Vite's own `transformWithEsbuild` —
// no new dependency) and PREPENDS a literal
// `const __PRECACHE__ = [...]` built from the real manifest, after the main
// build has run. `declare const` below exists purely so `tsc` can typecheck
// this file on its own; it produces no runtime code.
declare const __PRECACHE__: readonly string[];

// UPDATE STRATEGY: skipWaiting() + clients.claim(), not an "update available"
// banner. omnitool has no in-page state worth protecting across an update —
// no draft, no open connection, no unsaved form; a run in progress lives
// entirely in a Web Worker the SW never touches. Given that, activating a new
// version immediately (rather than waiting for every tab to close) means a
// user who reloads gets the current app rather than being stuck on a stale
// one behind a prompt they have to notice and act on. The one thing that
// must NOT happen is serving a shell that outlives the assets it references
// (GitHub Pages keeps only the latest deploy) — `networkFirst` below is what
// prevents that: an online visit always tries the network for the page
// itself first, so a fresh index.html (and the fresh hashed filenames inside
// it) wins whenever the network is actually reachable. The cache is only
// ever the offline fallback.

type SwEvent = { waitUntil(promise: Promise<unknown>): void };
type SwFetchEvent = SwEvent & { request: Request; respondWith(response: Promise<Response> | Response): void };

/** The handful of ServiceWorkerGlobalScope members this file touches. Kept
 *  local (rather than adding the "webworker" lib to tsconfig, which would
 *  collide with the "DOM" lib every other file in `src/` relies on) — the
 *  same "cast the bit you need" approach `core/workers/runner.worker.ts`
 *  already uses for its own worker scope. */
type ServiceWorkerScope = {
  addEventListener(type: 'install' | 'activate', listener: (event: SwEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: SwFetchEvent) => void): void;
  skipWaiting(): Promise<void>;
  clients: { claim(): Promise<void> };
  registration: { scope: string };
  location: { origin: string };
};

const APP_CACHE = 'omnitool-shell';
const RUNTIME_CACHE = 'omnitool-runtime';

function scopeUrl(scope: ServiceWorkerScope, pathname: string): string {
  return new URL(pathname, scope.registration.scope).href;
}

/** Every same-origin build output Vite puts under its asset directory —
 *  every lazily-imported chunk, precached or not. Path-based on purpose:
 *  content-hashed filenames make a wrong hit impossible either way.
 *
 *  Also covers `/ocr/` — the OCR engine's worker script, WASM core builds,
 *  and per-language `.traineddata.gz` files (src/tools/data/ocr.op.ts,
 *  scripts/vendor-ocr.mjs). Those are NOT part of the Vite module graph (a
 *  static import would defeat the entire point of fetching them lazily, on
 *  first actual use), so they never appear in `__PRECACHE__` — this is the
 *  ONLY thing that lets a language work offline after that first use, and
 *  the reason README.md's "no network calls" claim is qualified for OCR:
 *  the first use of a language is a real, same-origin, one-time fetch. */
function isBuildAsset(pathname: string): boolean {
  return pathname.includes('/assets/') || pathname.includes('/ocr/');
}

async function networkFirst(scope: ServiceWorkerScope, request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(APP_CACHE);
      void cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    // Deep/hash-routed URL, offline, first ever visit to THIS path: the app
    // shell itself is still the honest answer — better than the browser's
    // own offline interstitial for a single-page app.
    const shell = await caches.match(scopeUrl(scope, 'index.html'));
    if (shell) return shell;
    throw new Error('omnitool: offline, and nothing cached for this page yet');
  }
}

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  const revalidate = fetch(request)
    .then((response) => {
      if (response.ok) void cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);

  if (cached) {
    // Serve the cache hit now; let the network round-trip update the cache
    // in the background for NEXT time. The op chunks these requests are for
    // are themselves content-hashed and immutable, so revalidation rarely
    // changes anything — it is cheap insurance, not a correctness need.
    void revalidate;
    return cached;
  }

  const fresh = await revalidate;
  if (fresh) return fresh;
  throw new Error('omnitool: this asset is not cached and the network is unavailable');
}

/** Wires up the three listeners. Guarded so this module is inert (no thrown
 *  errors, no listeners attached) outside a real ServiceWorkerGlobalScope —
 *  the same defensive shape `runner.worker.ts` uses for its own scope check. */
function install(scope: ServiceWorkerScope): void {
  const PRECACHE_URLS = __PRECACHE__.map((path) => scopeUrl(scope, path));

  scope.addEventListener('install', (event) => {
    event.waitUntil(
      (async () => {
        // Each new version starts the shell cache clean, so the fixed-name
        // entries (index.html, the manifest, the icons) are never left
        // pointing at what an OLDER version put there, and nothing from a
        // previous deploy's now-orphaned hashed filenames lingers forever.
        await caches.delete(APP_CACHE);
        const cache = await caches.open(APP_CACHE);
        await cache.addAll(PRECACHE_URLS);
      })(),
    );
    void scope.skipWaiting();
  });

  scope.addEventListener('activate', (event) => {
    event.waitUntil(
      (async () => {
        const keep = new Set([APP_CACHE, RUNTIME_CACHE]);
        for (const name of await caches.keys()) {
          if (!keep.has(name)) await caches.delete(name);
        }
        await scope.clients.claim();
      })(),
    );
  });

  scope.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return; // never intercept a mutating request

    const url = new URL(request.url);
    if (url.origin !== scope.location.origin) return; // §1: same-origin, always

    if (request.mode === 'navigate') {
      event.respondWith(networkFirst(scope, request));
      return;
    }

    if (isBuildAsset(url.pathname)) {
      event.respondWith(staleWhileRevalidate(request));
    }
    // Everything else (the manifest, an icon, a favicon fetched directly):
    // left to the browser's own HTTP cache. They are tiny and change rarely
    // enough that a bespoke strategy would be complexity without a payoff.
  });
}

const globalScope = globalThis as {
  window?: unknown;
  document?: unknown;
  caches?: unknown;
  registration?: unknown;
};
// A window/document means this loaded on the main thread, not in a service
// worker — nothing here should run. `registration` is the one member every
// real ServiceWorkerGlobalScope has that no other worker type does.
if (globalScope.window === undefined && globalScope.document === undefined && globalScope.registration) {
  install(globalThis as unknown as ServiceWorkerScope);
}
