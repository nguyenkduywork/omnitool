// tests/helpers/network-capture.commands.ts
//
// Server-side (Node) Vitest browser "commands" — see vitest.workspace.ts's
// `browser.commands` wiring. These run with direct access to the real
// Playwright BrowserContext, which is the only thing that can observe a
// network request issued from INSIDE a nested Worker's own global scope.
//
// Why this exists (see tests/unit/ocr.browser.test.ts's network-trap test
// for the full story): tesseract.js spawns its own Worker from inside our
// op's Worker, and does its one real network fetch (the language traineddata
// download) in THAT nested worker's own realm. A `globalThis.fetch` monkey-
// patch installed in the test's own realm — the technique
// tests/unit/pdf-render.browser.test.ts uses — provably does NOT observe
// that fetch (a separate Worker has a completely separate global object, per
// the Worker spec). Verified directly: patching `window.fetch` and then
// fetching from inside a plain nested `Worker` left the outer patch's call
// counter at zero even though the nested fetch itself succeeded.
//
// Playwright's `BrowserContext` request tracking, by contrast, operates at
// the browser/network level rather than inside any one JS realm, and DOES
// observe requests issued by nested Workers — verified directly the same
// way: the same nested-worker fetch DID show up in `context.on('request')`.
// That is what these two commands expose to the browser-side test.
/// <reference types="@vitest/browser/providers/playwright" />
import type { BrowserCommandContext } from 'vitest/node';

let capturedUrls: string[] = [];
let attachedContext: unknown;

export async function startCapture(ctx: BrowserCommandContext): Promise<void> {
  capturedUrls = [];
  // One listener per BrowserContext (Vitest reuses the same context across
  // tests in a file) — guard so re-running the command mid-suite doesn't
  // stack duplicate listeners.
  if (attachedContext !== ctx.context) {
    attachedContext = ctx.context;
    ctx.context.on('request', (request) => {
      capturedUrls.push(request.url());
    });
  }
}

export async function getCapturedUrls(): Promise<string[]> {
  return [...capturedUrls];
}

// Type the two commands onto the browser-side `commands` object
// (`@vitest/browser/context`), so ocr.browser.test.ts gets real signatures
// instead of casting through `any`.
declare module '@vitest/browser/context' {
  interface BrowserCommands {
    startCapture: () => Promise<void>;
    getCapturedUrls: () => Promise<string[]>;
  }
}
