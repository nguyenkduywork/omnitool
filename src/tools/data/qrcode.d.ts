// src/tools/data/qrcode.d.ts
//
// `qrcode` ships no type declarations and no @types package is installed
// (per Task 5 instructions, package.json is not ours to touch). This is a
// minimal ambient shim so qr.op.ts can import it under strict mode.
//
// TypeScript will not let a *module* file (one with its own top-level
// import/export statements) declare an ambient module for a specifier that
// already resolves to a real, if untyped, file on disk — it treats that as
// an "augmentation" of existing types (TS2665) rather than a fresh shim.
// A separate, otherwise-empty .d.ts file sidesteps that restriction, which
// is why this lives here instead of inline in qr.op.ts.
declare module 'qrcode';
