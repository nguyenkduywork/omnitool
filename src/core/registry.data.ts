import type { Preset, SniffedFile, ToolDef } from '../types.js';

/** `holiday.tar.gz` -> `holiday.tar`. One extension, so `.tar.gz` keeps `.tar`. */
function basename(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? name : name.slice(0, dot);
}

/** Both archive tools name their output after the first file dropped. */
function archiveNamePreset(files: readonly SniffedFile[]): Preset {
  const first = files[0];
  if (!first) return { values: { name: 'archive' }, because: {} };
  return { values: { name: basename(first.name) }, because: { name: 'from the first file' } };
}

/**
 * Tool manifest for the 'data' group. Metadata, plus pure predicates over file METADATA (name, size, sniffed
 * type) — never over file contents. That rule is what keeps this module
 * synchronous, allocation-free, and testable under plain Node.
 */
export const DATA_TOOLS: ToolDef[] = [
  {
    id: 'zip-create',
    name: 'Create ZIP',
    blurb: 'Bundle the dropped files into one ZIP archive',
    group: 'data',
    kind: 'utility',
    accepts: ['*'],
    minInputs: 1,
    maxInputs: null,
    options: {
      name: { kind: 'text', label: 'Archive name', default: 'archive' },
      level: { kind: 'range', label: 'Compression level', min: 0, max: 9, step: 1, default: 6 },
    },
    preset: archiveNamePreset,
    load: () => import('../tools/data/zip-create.op.js'),
  },
  {
    id: 'zip-extract',
    name: 'Extract ZIP',
    blurb: 'Unpack every file from a ZIP archive',
    group: 'data',
    kind: 'transform',
    accepts: ['application/zip'],
    minInputs: 1,
    maxInputs: null,
    load: () => import('../tools/data/zip-extract.op.js'),
  },
  {
    id: 'gzip',
    name: 'Gzip',
    blurb: 'Compress files to .gz, or decompress a .gz back to its bytes',
    group: 'data',
    kind: 'utility',
    accepts: ['*'],
    minInputs: 1,
    maxInputs: null,
    options: {
      direction: {
        kind: 'select',
        label: 'Direction',
        choices: [
          { value: 'encode', label: 'Compress' },
          { value: 'decode', label: 'Decompress' },
        ],
        default: 'encode',
      },
      level: { kind: 'range', label: 'Compression level', min: 0, max: 9, step: 1, default: 6 },
    },
    preset: (files): Preset =>
      files.some((f) => f.type === 'application/gzip')
        ? { values: { direction: 'decode' }, because: { direction: "from the file's gzip signature" } }
        : { values: { direction: 'encode' }, because: {} },
    load: () => import('../tools/data/gzip.op.js'),
  },
  {
    id: 'tar-create',
    name: 'Create TAR',
    blurb: 'Bundle the dropped files into one .tar, or a gzipped .tar.gz',
    group: 'data',
    kind: 'utility',
    accepts: ['*'],
    minInputs: 1,
    maxInputs: null,
    options: {
      name: { kind: 'text', label: 'Archive name', default: 'archive' },
      gzip: { kind: 'toggle', label: 'Compress with gzip (.tar.gz)', default: false },
      level: { kind: 'range', label: 'Compression level', min: 0, max: 9, step: 1, default: 6 },
    },
    preset: archiveNamePreset,
    load: () => import('../tools/data/tar-create.op.js'),
  },
  {
    id: 'tar-extract',
    name: 'Extract TAR',
    blurb: 'Unpack every file from a .tar or .tar.gz archive',
    group: 'data',
    kind: 'transform',
    accepts: ['application/x-tar', 'application/gzip'],
    minInputs: 1,
    maxInputs: null,
    load: () => import('../tools/data/tar-extract.op.js'),
  },
  {
    id: 'file-split',
    name: 'Split file',
    blurb: 'Cut a file into fixed-size parts that Join file parts puts back together',
    group: 'data',
    kind: 'utility',
    accepts: ['*'],
    minInputs: 1,
    maxInputs: null,
    options: {
      size: { kind: 'number', label: 'Part size', min: 1, max: 4096, step: 1, default: 10 },
      unit: {
        kind: 'select',
        label: 'Unit',
        choices: [
          { value: 'MB', label: 'MB' },
          { value: 'KB', label: 'KB' },
        ],
        default: 'MB',
      },
    },
    load: () => import('../tools/data/file-split.op.js'),
  },
  {
    id: 'file-join',
    name: 'Join file parts',
    blurb: 'Concatenate split parts back into one file, in file-tray order',
    group: 'data',
    kind: 'utility',
    accepts: ['*'],
    minInputs: 2,
    maxInputs: null,
    load: () => import('../tools/data/file-join.op.js'),
  },
  {
    id: 'hash',
    name: 'Hash files',
    blurb: 'Compute a SHA-1, SHA-256, SHA-512, or MD5 checksum',
    group: 'data',
    kind: 'utility',
    accepts: ['*'],
    minInputs: 1,
    maxInputs: null,
    options: {
      algorithm: {
        kind: 'select',
        label: 'Algorithm',
        choices: [
          { value: 'sha-256', label: 'SHA-256' },
          { value: 'sha-1', label: 'SHA-1' },
          { value: 'sha-512', label: 'SHA-512' },
          { value: 'md5', label: 'MD5' },
        ],
        default: 'sha-256',
      },
    },
    load: () => import('../tools/data/hash.op.js'),
  },
  {
    id: 'base64',
    name: 'Base64',
    blurb: 'Encode files to Base64 text, or decode Base64 text back to bytes',
    group: 'data',
    kind: 'utility',
    accepts: ['*'],
    minInputs: 1,
    maxInputs: null,
    options: {
      direction: {
        kind: 'select',
        label: 'Direction',
        choices: [
          { value: 'encode', label: 'Encode' },
          { value: 'decode', label: 'Decode' },
        ],
        default: 'encode',
      },
    },
    preset: (files): Preset =>
      files.some((f) => /\.(b64|base64)$/i.test(f.name))
        ? { values: { direction: 'decode' }, because: { direction: 'from the file extension' } }
        : { values: { direction: 'encode' }, because: {} },
    load: () => import('../tools/data/base64.op.js'),
  },
  {
    id: 'csv-json',
    name: 'CSV ⇄ JSON',
    blurb: 'Convert between CSV and JSON',
    group: 'data',
    kind: 'transform',
    accepts: ['text/csv', 'application/json', 'text/plain'],
    minInputs: 1,
    maxInputs: null,
    options: {
      direction: {
        kind: 'select',
        label: 'Direction',
        choices: [
          { value: 'csv-to-json', label: 'CSV to JSON' },
          { value: 'json-to-csv', label: 'JSON to CSV' },
        ],
        default: 'csv-to-json',
      },
      delimiter: {
        kind: 'select',
        label: 'Delimiter',
        choices: [
          { value: ',', label: 'Comma' },
          { value: ';', label: 'Semicolon' },
          { value: '\t', label: 'Tab' },
          { value: 'auto', label: 'Auto-detect' },
        ],
        default: 'auto',
      },
      header: { kind: 'toggle', label: 'First row is header', default: true },
    },
    preset: (files) => {
      if (files.some((f) => f.type === 'text/csv')) {
        return { values: { direction: 'csv-to-json' }, because: { direction: 'from the .csv file' } };
      }
      if (files.some((f) => f.type === 'application/json')) {
        return { values: { direction: 'json-to-csv' }, because: { direction: 'from the .json file' } };
      }
      // text/plain carries no signal. Saying so beats guessing wrong.
      return { values: {}, because: { direction: "couldn't tell from the file — pick a direction" } };
    },
    load: () => import('../tools/data/csv-json.op.js'),
  },
  {
    id: 'json-format',
    name: 'Format JSON',
    blurb: 'Pretty-print or minify JSON',
    group: 'data',
    kind: 'transform',
    accepts: ['application/json', 'text/plain'],
    minInputs: 1,
    maxInputs: null,
    options: {
      mode: {
        kind: 'select',
        label: 'Mode',
        choices: [
          { value: 'pretty', label: 'Pretty-print' },
          { value: 'minify', label: 'Minify' },
        ],
        default: 'pretty',
      },
      indent: { kind: 'number', label: 'Indent size', min: 1, max: 8, step: 1, default: 2 },
    },
    load: () => import('../tools/data/json-format.op.js'),
  },
  {
    id: 'qr-generate',
    name: 'Generate QR code',
    blurb: 'Turn text or a URL into a QR code',
    group: 'data',
    kind: 'generate',
    accepts: [],
    minInputs: 0,
    maxInputs: 0,
    options: {
      text: { kind: 'text', label: 'Text or URL', placeholder: 'https://example.com', default: '' },
      format: {
        kind: 'select',
        label: 'Format',
        choices: [
          { value: 'png', label: 'PNG' },
          { value: 'svg', label: 'SVG' },
        ],
        default: 'png',
      },
      size: { kind: 'number', label: 'Size (px)', min: 128, max: 1024, step: 32, default: 512 },
    },
    load: () => import('../tools/data/qr.op.js'),
  },
  {
    id: 'text-clean',
    name: 'Clean up text',
    blurb: 'Sort, deduplicate and tidy the lines of a text file',
    group: 'data',
    kind: 'transform',
    accepts: ['text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values'],
    minInputs: 1,
    maxInputs: null,
    options: {
      sort: {
        kind: 'select',
        label: 'Sort lines',
        choices: [
          { value: 'none', label: 'Keep the original order' },
          { value: 'asc', label: 'A to Z' },
          { value: 'desc', label: 'Z to A' },
        ],
        default: 'none',
      },
      dedupe: { kind: 'toggle', label: 'Remove duplicate lines', default: false },
      trim: { kind: 'toggle', label: 'Trim trailing whitespace', default: true },
      dropBlank: { kind: 'toggle', label: 'Drop blank lines', default: false },
      endings: {
        kind: 'select',
        label: 'Line endings',
        choices: [
          { value: 'keep', label: "Keep the file's own" },
          { value: 'lf', label: 'LF (Unix)' },
          { value: 'crlf', label: 'CRLF (Windows)' },
        ],
        default: 'keep',
      },
    },
    load: () => import('../tools/data/text-clean.op.js'),
  },
  {
    id: 'text-diff',
    name: 'Compare text',
    blurb: 'See exactly what changed between two versions of a text or code file',
    group: 'data',
    kind: 'transform',
    // `text/*` covers plain text, Markdown, CSV/TSV, HTML and the
    // `text/x-source` that format.ts assigns to source files — the two things
    // people actually compare. JSON and XML are named because they sit under
    // `application/`.
    accepts: ['text/*', 'application/json', 'application/xml'],
    // Exactly two: a comparison of three files is three comparisons, and the
    // file tray's order is what decides which one is the OLD side.
    minInputs: 2,
    maxInputs: 2,
    // The declarative fallback, and the source of the op's defaults. The
    // `editor` below supersedes it in the UI because the whole value of this
    // tool is SEEING the differences before deciding whether to export them,
    // and a flat schema has nowhere to put a diff.
    options: {
      format: {
        kind: 'select',
        label: 'Export as',
        choices: [
          { value: 'html', label: 'Side-by-side report (HTML)' },
          { value: 'unified', label: 'Patch file (.diff)' },
        ],
        default: 'html',
      },
      scope: {
        kind: 'select',
        label: 'Include',
        choices: [
          { value: 'changes', label: 'Changes and their context' },
          { value: 'whole', label: 'The whole file' },
        ],
        default: 'changes',
      },
      context: { kind: 'number', label: 'Context lines', min: 0, max: 100, step: 1, default: 3 },
      ignoreWhitespace: { kind: 'toggle', label: 'Ignore whitespace changes', default: false },
      ignoreCase: { kind: 'toggle', label: 'Ignore case', default: false },
      swap: { kind: 'toggle', label: 'Compare the second file against the first', default: false },
    },
    editor: () => import('../tools/data/text-diff.editor'),
    load: () => import('../tools/data/text-diff.op.js'),
  },
  ];
