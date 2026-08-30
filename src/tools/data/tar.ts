// src/tools/data/tar.ts — a minimal, dependency-free USTAR reader and writer.
//
// TAR is 512-byte blocks: a header block per entry, then the entry's bytes
// padded up to the next block boundary, then two zero blocks to end the
// archive. That is the whole format, which is why this file exists instead of
// a dependency.
//
// READING covers what real archivers actually emit:
//   * ustar name + prefix (GNU tar, bsdtar, most everything)
//   * GNU long names ('L' entries), which hold a name too long for the
//     100-byte field in the entry's own data block
//   * pax extended headers ('x' entries), whose "path=" record is the real
//     name — parsed rather than skipped, because the ustar name beside a pax
//     header is a TRUNCATED fallback and using it would silently rename files
//   * base-256 numeric fields, GNU's escape hatch for sizes that do not fit
//     in 11 octal digits
// Every header's checksum is verified. Directories, symlinks and hard links
// carry no content and are skipped; a GNU sparse entry ('S') is refused
// outright rather than extracted as the dense garbage its raw blocks contain.
//
// WRITING emits plain ustar. Entries are written with mtime 0, not "now": an
// OpInput carries a name, a type and bytes — the file's real modification
// time is not among them, and inventing one would be a fact the tool made up.

import { OpError } from '../../types';

export type TarEntry = { name: string; bytes: Uint8Array };

const BLOCK = 512;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();

// --- reading ---------------------------------------------------------------

function isZeroBlock(bytes: Uint8Array, at: number): boolean {
  for (let i = at; i < at + BLOCK; i++) {
    if (bytes[i] !== 0) return false;
  }
  return true;
}

function readString(bytes: Uint8Array, at: number, length: number): string {
  const field = bytes.subarray(at, at + length);
  const end = field.indexOf(0);
  return decoder.decode(end < 0 ? field : field.subarray(0, end));
}

/** Octal by default; GNU's base-256 form when the top bit of byte 0 is set. */
function readNumber(bytes: Uint8Array, at: number, length: number, sourceName: string): number {
  const first = bytes[at] ?? 0;
  if ((first & 0x80) !== 0) {
    let value = first & 0x7f;
    for (let i = at + 1; i < at + length; i++) {
      value = value * 256 + (bytes[i] ?? 0);
      if (!Number.isSafeInteger(value)) {
        throw new OpError('TooLarge', `${sourceName} declares an entry larger than this tool can address.`, sourceName);
      }
    }
    return value;
  }
  const text = readString(bytes, at, length).trim().replace(/\0+$/, '');
  if (text === '') return 0;
  const value = parseInt(text, 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new OpError('CorruptFile', `${sourceName} has an unreadable numeric field in a tar header.`, sourceName);
  }
  return value;
}

/** Sum of the header's bytes with the checksum field read as eight spaces. */
function computeChecksum(bytes: Uint8Array, at: number): number {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : (bytes[at + i] ?? 0);
  }
  return sum;
}

/** Parse a pax extended header's records, returning its "path" if it has one. */
function paxPath(data: Uint8Array): string | null {
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) return null;
    const length = parseInt(decoder.decode(data.subarray(at, space)), 10);
    if (!Number.isFinite(length) || length <= 0 || at + length > data.length) return null;
    // The record ends with a newline, which is not part of the value.
    const record = decoder.decode(data.subarray(space + 1, at + length - 1));
    const equals = record.indexOf('=');
    if (equals > 0 && record.slice(0, equals) === 'path') return record.slice(equals + 1);
    at += length;
  }
  return null;
}

/**
 * Every regular file in `bytes`, in archive order. `sourceName` only names the
 * archive in error messages.
 */
export function readTar(bytes: Uint8Array, sourceName: string): TarEntry[] {
  if (bytes.length < BLOCK) {
    throw new OpError('CorruptFile', `${sourceName} is too short to be a tar archive.`, sourceName);
  }

  const entries: TarEntry[] = [];
  let pendingName: string | null = null;
  let at = 0;

  while (at + BLOCK <= bytes.length) {
    if (isZeroBlock(bytes, at)) break; // end-of-archive marker

    const stored = readNumber(bytes, at + 148, 8, sourceName);
    if (stored !== computeChecksum(bytes, at)) {
      throw new OpError('CorruptFile', `${sourceName} has a tar header with a bad checksum at byte ${at}.`, sourceName);
    }

    const size = readNumber(bytes, at + 124, 12, sourceName);
    const typeFlag = String.fromCharCode(bytes[at + 156] || 0x30);
    const dataAt = at + BLOCK;
    const dataEnd = dataAt + size;
    if (dataEnd > bytes.length) {
      throw new OpError('CorruptFile', `${sourceName} declares a tar entry that runs past the end of the file.`, sourceName);
    }
    const next = dataAt + Math.ceil(size / BLOCK) * BLOCK;

    if (typeFlag === 'L') {
      // GNU long name: this entry's data IS the next entry's name.
      pendingName = readString(bytes, dataAt, size);
      at = next;
      continue;
    }
    if (typeFlag === 'x' || typeFlag === 'X') {
      const path = paxPath(bytes.subarray(dataAt, dataEnd));
      if (path !== null) pendingName = path;
      at = next;
      continue;
    }
    if (typeFlag === 'S') {
      throw new OpError(
        'UnsupportedFormat',
        `${sourceName} contains a GNU sparse entry, whose stored blocks are not the file's real contents. Re-create the archive without --sparse.`,
        sourceName,
      );
    }

    if (typeFlag === '0' || typeFlag === '\0') {
      let name = pendingName;
      if (name === null) {
        const base = readString(bytes, at, NAME_MAX);
        const prefix = readString(bytes, at + 345, PREFIX_MAX);
        name = prefix === '' ? base : `${prefix}/${base}`;
      }
      entries.push({ name, bytes: bytes.subarray(dataAt, dataEnd) });
    }
    // Directories ('5'), links ('1'/'2') and everything else carry no content.

    pendingName = null;
    at = next;
  }

  return entries;
}

// --- writing ---------------------------------------------------------------

function writeAscii(block: Uint8Array, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) block[at + i] = text.charCodeAt(i);
}

function writeOctal(block: Uint8Array, at: number, width: number, value: number, field: string, name: string): void {
  const digits = value.toString(8);
  if (digits.length > width - 1) {
    throw new OpError('TooLarge', `${name} needs a ${field} too large for a ustar header.`, name);
  }
  writeAscii(block, at, digits.padStart(width - 1, '0'));
  block[at + width - 1] = 0;
}

/** Split a >100-byte name into ustar's prefix/name pair, or null if it cannot be. */
function splitName(name: string): { prefix: string; base: string } | null {
  if (encoder.encode(name).length <= NAME_MAX) return { prefix: '', base: name };
  const parts = name.split('/');
  for (let cut = parts.length - 1; cut > 0; cut--) {
    const prefix = parts.slice(0, cut).join('/');
    const base = parts.slice(cut).join('/');
    if (encoder.encode(prefix).length <= PREFIX_MAX && encoder.encode(base).length <= NAME_MAX) {
      return { prefix, base };
    }
  }
  return null;
}

function header(entry: TarEntry): Uint8Array {
  const block = new Uint8Array(BLOCK);
  const split = splitName(entry.name);
  if (split === null) {
    throw new OpError(
      'InvalidOptions',
      `${entry.name} cannot be stored in a ustar header: no path split leaves 100 bytes or fewer for the file name.`,
      entry.name,
    );
  }

  block.set(encoder.encode(split.base), 0);
  writeOctal(block, 100, 8, 0o644, 'mode', entry.name);
  writeOctal(block, 108, 8, 0, 'uid', entry.name);
  writeOctal(block, 116, 8, 0, 'gid', entry.name);
  writeOctal(block, 124, 12, entry.bytes.length, 'size', entry.name);
  writeOctal(block, 136, 12, 0, 'mtime', entry.name); // see the note at the top
  block[156] = 0x30; // typeflag '0' — regular file
  writeAscii(block, 257, 'ustar');
  writeAscii(block, 263, '00');
  block.set(encoder.encode(split.prefix), 345);

  // The checksum is computed over the header with its own field left blank,
  // then written back as six octal digits, a NUL and a space.
  writeAscii(block, 148, '        ');
  const sum = computeChecksum(block, 0);
  writeAscii(block, 148, sum.toString(8).padStart(6, '0'));
  block[154] = 0;
  block[155] = 0x20;

  return block;
}

/**
 * A complete ustar archive of `entries`, including the two-block terminator.
 * `onEntry` is called as each entry's header is actually built, so a caller
 * can report progress it really made and stop between entries.
 */
export function writeTar(entries: TarEntry[], onEntry?: (index: number) => void): Uint8Array {
  const blocks: Uint8Array[] = [];
  let total = 0;

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index] as TarEntry;
    const head = header(entry);
    const padded = Math.ceil(entry.bytes.length / BLOCK) * BLOCK;
    blocks.push(head, entry.bytes, new Uint8Array(padded - entry.bytes.length));
    total += BLOCK + padded;
    onEntry?.(index);
  }
  const terminator = new Uint8Array(BLOCK * 2);
  blocks.push(terminator);
  total += terminator.length;

  const out = new Uint8Array(total);
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}
