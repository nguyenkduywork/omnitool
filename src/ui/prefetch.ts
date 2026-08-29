// src/ui/prefetch.ts — intent prefetch (§6.1 mechanism 5).
//
// On pointerenter and on keyboard focus of a tool card, warm that tool's chunk
// so the engine is already in the HTTP cache before the click lands. This is the
// single largest perceived-speed win in the design, and it matters even though
// the op runs in a Web Worker: the worker shares this tab's HTTP cache, so a
// warm cache turns the worker's own `import()` into a memory hit.
//
// HOW THE <link rel="modulepreload"> GETS INJECTED
// -----------------------------------------------
// Vite deliberately does not expose a source-module -> emitted-chunk URL map at
// runtime, so `<link rel="modulepreload" href="...">` cannot be hand-built from
// a ToolDef's `load` thunk: the chunk name carries a content hash only known at
// build time. Invoking the thunk is what makes Vite's own preload helper inject
// `<link rel="modulepreload">` for the tool's chunk AND every static dependency
// of that chunk (pdf-lib, pdfjs, fflate, ...), which is precisely the tag we
// want and the only way to learn the right hrefs. So that is what we do, exactly
// once per tool id.
//
// `preloadedChunks()` reports the modulepreload hrefs currently in the document
// so this is verifiable rather than a claim.

import type { ToolDef } from '../types';

const warmed = new Set<string>();

/** Every modulepreload href currently in the document. */
export function preloadedChunks(): string[] {
  return [...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]')].map(
    (link) => link.href,
  );
}

/** Warm `loader`'s chunk once per `key`. Never throws, never blocks. */
export function prefetchModule(key: string, loader: () => Promise<unknown>): void {
  if (warmed.has(key)) return;
  warmed.add(key);
  const start = (): void => {
    // A prefetch that fails is a non-event: the real import will report it.
    void loader().catch(() => undefined);
  };
  // Never compete with the interaction that triggered it.
  if ('requestIdleCallback' in globalThis) {
    (globalThis as { requestIdleCallback: (cb: () => void, o?: { timeout: number }) => void })
      .requestIdleCallback(start, { timeout: 500 });
  } else {
    setTimeout(start, 0);
  }
}

/** Warm one tool's op chunk. Deduplicated: at most once per tool id, per page. */
export function prefetchTool(tool: ToolDef): void {
  prefetchModule(`tool:${tool.id}`, tool.load);
  if (tool.editor) prefetchModule(`editor:${tool.id}`, tool.editor);
}

/** For tests and diagnostics: which keys have been warmed. */
export function warmedKeys(): string[] {
  return [...warmed];
}
