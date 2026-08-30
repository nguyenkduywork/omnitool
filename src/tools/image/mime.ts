// src/tools/image/mime.ts — canvas-encodable mime types shared between
// rotate.op.ts and rotate.editor.ts, so the op and its preview cannot
// silently drift apart on what counts as "known" or "lossless". A dependency-
// free leaf module: either the worker-side op or the main-thread editor can
// import it without pulling the other's chunk along.

/** Formats we hand straight back to the canvas encoder. */
export const KNOWN_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'];

/** The subset that ignores `quality`, because it is lossless. */
export const LOSSLESS_MIMES = ['image/png'];

/** The output mime rotate.op.ts — and its editor's preview — will choose for a file. */
export function outputMimeFor(file: { type: string }): string {
  return file.type && KNOWN_MIMES.includes(file.type) ? file.type : 'image/png';
}
