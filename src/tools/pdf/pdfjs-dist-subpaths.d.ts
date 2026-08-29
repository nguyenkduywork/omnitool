// src/tools/pdf/pdfjs-dist-subpaths.d.ts
//
// `pdfjs-dist` ships a declaration file for its bare package entry
// (`pdfjs-dist`), but not for the two low-level ESM entry points imported
// directly by tests/unit/pdf-render.browser.test.ts to prove the
// worker-less rendering path (see that file's header comment): the bundled
// worker `pdfjs-dist/build/pdf.worker.mjs` and the bundled core
// `pdfjs-dist/build/pdf.mjs`.
//
// TypeScript will not let a *module* file (one with its own top-level
// import/export statements) declare an ambient module for a specifier that
// already resolves to a real, if untyped, file on disk — it treats that as
// an "augmentation" of existing types (TS2665) rather than a fresh shim.
// A separate, otherwise-empty .d.ts file sidesteps that restriction, the
// same way src/tools/data/qrcode.d.ts does for `qrcode`.
//
// extract-text.op.ts, organize.editor.ts and to-images.op.ts each import the
// worker subpath too (their own copy of the same loadPdfjs() helper); this
// shim is what types that import for them now, in place of a per-file
// `@ts-expect-error` comment.
declare module 'pdfjs-dist/build/pdf.worker.mjs';
declare module 'pdfjs-dist/build/pdf.mjs';
