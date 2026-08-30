// src/tools/image/mime.ts — canvas-encodable mime types shared by the ops that
// re-encode an image in its own format (rotate, watermark) and by
// rotate.editor.ts, so an op and its preview cannot silently drift apart on
// what counts as "known" or "lossless". A dependency-free leaf module: either
// the worker-side op or the main-thread editor can import it without pulling
// the other's chunk along.

/** Formats we hand straight back to the canvas encoder. */
export const KNOWN_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif'];

/** The subset that ignores `quality`, because it is lossless. */
export const LOSSLESS_MIMES = ['image/png'];

/** The output mime rotate.op.ts — and its editor's preview — will choose for a file. */
export function outputMimeFor(file: { type: string }): string {
  return file.type && KNOWN_MIMES.includes(file.type) ? file.type : 'image/png';
}

const EXTENSION_OF: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

/**
 * `name` with the extension that matches `mime`. Used when `outputMimeFor`
 * falls back to PNG for a format the canvas cannot encode: the bytes changed
 * format, so the filename has to say so rather than label a PNG `.gif`.
 * An unknown mime leaves the name alone — a wrong extension is worse than none.
 */
export function renameForMime(name: string, mime: string): string {
  const ext = EXTENSION_OF[mime];
  if (ext === undefined) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem}.${ext}`;
}
