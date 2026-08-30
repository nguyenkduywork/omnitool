// src/core/fs.ts — intake (File -> OpInput) and egress (download, zip bundle).
//
// Nothing here talks to the network. A "download" is a Blob URL for bytes that
// never left the tab.

import { zip } from 'fflate';

import { OpError, type OpInput, type OpOutput } from '../types';
import { sniffType } from './format';

/**
 * Revoking a Blob URL the instant after click() can cancel the download in
 * some browsers, so the URL is released on the next task instead.
 */
const REVOKE_DELAY_MS = 1000;

/**
 * Read picked/dropped files into op inputs. The declared type comes from
 * `sniffType` (magic bytes), never from `File.type` — browsers derive that from
 * the extension, which is exactly what we refuse to trust.
 */
export function readFiles(files: File[]): Promise<OpInput[]> {
  return Promise.all(
    files.map(async (file) => {
      const buffer = await file.arrayBuffer();
      return { name: file.name, type: sniffType(buffer, file.name), buffer };
    }),
  );
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS);
}

/** Save one output to the user's disk. */
export function download(output: OpOutput): void {
  saveBlob(new Blob([output.buffer], { type: output.type }), output.name);
}

/** `report.txt` -> `report (2).txt`, so a collision never silently drops data. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const candidate = `${stem} (${n})${ext}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

/**
 * Output types whose bytes are ALREADY compressed, and are therefore stored
 * in the bundle rather than deflated a second time.
 *
 * This is a measured decision, not a guess (40 files, Node 24): deflating 20 MB
 * of image output at level 6 took 414 ms and produced an archive marginally
 * LARGER than storing it, because deflate still writes its framing when it
 * cannot compress; storing took 52 ms. Everything not on this list still
 * deflates, which is where compression earns its keep many times over — the
 * same test on CSV output was 11.45 MB stored against 0.05 MB deflated. PDF is
 * deliberately NOT on this list: its streams are usually compressed already,
 * but a PDF also carries uncompressed structure that deflate does shrink, so
 * it keeps the default rather than trading a real saving for a little time.
 */
const ALREADY_COMPRESSED = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
  'application/zip',
  'application/gzip',
]);

/**
 * The deflate level an output of this type goes into the bundle with: 0 stores
 * it, 6 compresses it. Exported so `scripts/bench/bundle.mjs` measures the real
 * policy rather than a restatement of it.
 */
export function zipLevelFor(type: string): 0 | 6 {
  return ALREADY_COMPRESSED.has(type) ? 0 : 6;
}

/** Zip every output and save the archive as `zipName`. */
export async function downloadBundle(outputs: OpOutput[], zipName: string): Promise<void> {
  if (outputs.length === 0) {
    throw new OpError('InvalidOptions', 'There is nothing to bundle.');
  }

  const taken = new Set<string>();
  const entries: Record<string, [Uint8Array, { level: 0 | 6 }]> = {};
  for (const output of outputs) {
    const level = zipLevelFor(output.type);
    entries[uniqueName(output.name, taken)] = [new Uint8Array(output.buffer), { level }];
  }

  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    // Async fflate: zipping never blocks the thread that called us.
    zip(entries, {}, (error, data) => {
      if (error) reject(new OpError('OutOfMemory', `Could not build the zip: ${error.message}`));
      else resolve(data);
    });
  });

  const name = zipName.toLowerCase().endsWith('.zip') ? zipName : `${zipName}.zip`;
  // fflate hands back a plain-ArrayBuffer-backed view; the ArrayBufferLike in
  // its types only exists to admit SharedArrayBuffer, which it never returns.
  // Re-viewing it (rather than copying) keeps a large zip out of memory twice.
  const part = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  saveBlob(new Blob([part], { type: 'application/zip' }), name);
}
