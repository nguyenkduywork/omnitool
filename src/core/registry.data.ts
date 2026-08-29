import type { ToolDef } from '../types.js';

/**
 * Tool manifest for the 'data' group. METADATA ONLY - no logic.
 * Owned by the data tools task; appended to by that task alone.
 */
export const DATA_TOOLS: ToolDef[] = [
  {
    id: 'zip-create',
    name: 'Create ZIP',
    blurb: 'Bundle the dropped files into one ZIP archive',
    group: 'data',
    accepts: ['*'],
    minInputs: 1,
    maxInputs: null,
    options: {
      name: { kind: 'text', label: 'Archive name', default: 'archive' },
      level: { kind: 'range', label: 'Compression level', min: 0, max: 9, step: 1, default: 6 },
    },
    load: () => import('../tools/data/zip-create.op.js'),
  },
  {
    id: 'zip-extract',
    name: 'Extract ZIP',
    blurb: 'Unpack every file from a ZIP archive',
    group: 'data',
    accepts: ['application/zip'],
    minInputs: 1,
    maxInputs: null,
    load: () => import('../tools/data/zip-extract.op.js'),
  },
  {
    id: 'hash',
    name: 'Hash files',
    blurb: 'Compute a SHA-1, SHA-256, SHA-512, or MD5 checksum',
    group: 'data',
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
    load: () => import('../tools/data/base64.op.js'),
  },
  {
    id: 'csv-json',
    name: 'CSV ⇄ JSON',
    blurb: 'Convert between CSV and JSON',
    group: 'data',
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
    load: () => import('../tools/data/csv-json.op.js'),
  },
  {
    id: 'json-format',
    name: 'Format JSON',
    blurb: 'Pretty-print or minify JSON',
    group: 'data',
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
    accepts: ['*'],
    minInputs: 0,
    maxInputs: null,
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
];
