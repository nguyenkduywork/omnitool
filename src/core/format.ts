// src/core/format.ts — file-type detection and tool applicability.
//
// Sniffing is MAGIC-BYTE FIRST, never extension-first: a PDF someone renamed
// `photo.png` is a PDF, and treating it as an image would hand a tool bytes it
// cannot read. The extension is consulted only for formats that have no
// signature at all (csv, json, txt, svg, ...).

import type { ToolDef } from '../types';

const OCTET_STREAM = 'application/octet-stream';

/** ASCII string -> byte codes, for readable signature declarations. */
function ascii(text: string): number[] {
  return [...text].map((c) => c.charCodeAt(0));
}

function matchesAt(bytes: Uint8Array, offset: number, pattern: number[]): boolean {
  if (bytes.length < offset + pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (bytes[offset + i] !== pattern[i]) return false;
  }
  return true;
}

type Signature = { mime: string; test: (bytes: Uint8Array) => boolean };

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
// 'PK' followed by: a local file header, an empty archive, or a spanned archive.
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04];
const ZIP_EMPTY = [0x50, 0x4b, 0x05, 0x06];
const ZIP_SPANNED = [0x50, 0x4b, 0x07, 0x08];
const GZIP = [0x1f, 0x8b];

/**
 * How many leading bytes sniffing reads. Every signature above lives inside
 * this window; TAR's, at offset 257, is what makes it wider than the handful
 * of bytes the rest need. Sniffing never reads the whole file.
 */
const SNIFF_BYTES = 265;

// Order matters only where signatures could overlap; these do not.
const SIGNATURES: Signature[] = [
  { mime: 'application/pdf', test: (b) => matchesAt(b, 0, ascii('%PDF-')) },
  { mime: 'image/png', test: (b) => matchesAt(b, 0, PNG) },
  { mime: 'image/jpeg', test: (b) => matchesAt(b, 0, JPEG) },
  { mime: 'image/gif', test: (b) => matchesAt(b, 0, ascii('GIF8')) },
  {
    mime: 'image/webp',
    test: (b) => matchesAt(b, 0, ascii('RIFF')) && matchesAt(b, 8, ascii('WEBP')),
  },
  {
    // ISO-BMFF: a 4-byte box size, then 'ftyp', then the brand.
    mime: 'image/avif',
    test: (b) =>
      matchesAt(b, 4, ascii('ftyp')) &&
      (matchesAt(b, 8, ascii('avif')) || matchesAt(b, 8, ascii('avis'))),
  },
  {
    mime: 'application/zip',
    test: (b) =>
      matchesAt(b, 0, ZIP_LOCAL) || matchesAt(b, 0, ZIP_EMPTY) || matchesAt(b, 0, ZIP_SPANNED),
  },
  { mime: 'application/gzip', test: (b) => matchesAt(b, 0, GZIP) },
  {
    // TAR has no header at all: its signature is the ustar magic 257 bytes
    // into the first entry's header block. Older v7 tars carry no magic and
    // are recognised by their .tar extension alone.
    mime: 'application/x-tar',
    test: (b) => matchesAt(b, 257, ascii('ustar')),
  },
];

const BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
};

const LABELS: Record<string, string> = {
  'application/pdf': 'PDF document',
  'application/zip': 'ZIP archive',
  'application/gzip': 'Gzip file',
  'application/x-tar': 'TAR archive',
  'application/json': 'JSON data',
  'application/xml': 'XML document',
  'application/octet-stream': 'Unknown file',
  'image/png': 'PNG image',
  'image/jpeg': 'JPEG image',
  'image/webp': 'WebP image',
  'image/avif': 'AVIF image',
  'image/gif': 'GIF image',
  'image/bmp': 'Bitmap image',
  'image/tiff': 'TIFF image',
  'image/svg+xml': 'SVG image',
  'image/x-icon': 'Icon',
  'text/csv': 'CSV data',
  'text/tab-separated-values': 'TSV data',
  'text/plain': 'Plain text',
  'text/markdown': 'Markdown text',
  'text/html': 'HTML document',
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return '';
  return filename.slice(dot + 1).toLowerCase();
}

/**
 * The mime type of `buffer`, decided by its leading bytes. Falls back to the
 * filename extension for signature-less formats, then to
 * 'application/octet-stream'.
 */
export function sniffType(buffer: ArrayBuffer, filename: string): string {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, SNIFF_BYTES));
  for (const signature of SIGNATURES) {
    if (signature.test(head)) return signature.mime;
  }
  return BY_EXTENSION[extensionOf(filename)] ?? OCTET_STREAM;
}

/** A short human label for a mime type, e.g. 'PDF document'. */
export function label(mime: string): string {
  const known = LABELS[mime];
  if (known) return known;

  const slash = mime.indexOf('/');
  const type = slash < 0 ? '' : mime.slice(0, slash);
  const subtype = (slash < 0 ? mime : mime.slice(slash + 1)).replace(/^x-/, '').toUpperCase();
  if (!subtype) return 'Unknown file';
  return type === 'image' ? `${subtype} image` : `${subtype} file`;
}

function patternMatches(pattern: string, mime: string): boolean {
  if (pattern === '*' || pattern === '*/*') return true;
  if (pattern === mime) return true;
  if (pattern.endsWith('/*')) return mime.startsWith(pattern.slice(0, -1));
  return false;
}

/**
 * True when `tool` can run against exactly this selection: the count is within
 * [minInputs, maxInputs] and EVERY mime matches one of `tool.accepts`
 * (supporting the 'image/*' and '*' wildcards).
 */
export function accepts(tool: ToolDef, mimes: string[]): boolean {
  if (mimes.length < tool.minInputs) return false;
  if (tool.maxInputs !== null && mimes.length > tool.maxInputs) return false;
  return mimes.every((mime) => tool.accepts.some((pattern) => patternMatches(pattern, mime)));
}
