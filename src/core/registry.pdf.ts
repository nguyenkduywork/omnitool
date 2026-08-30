import type { ToolDef } from '../types.js';

/**
 * Tool manifest for the 'pdf' group. METADATA ONLY - no logic.
 * Owned by the pdf tools task; appended to by that task alone.
 */
export const PDF_TOOLS: ToolDef[] = [
  {
    id: 'pdf-merge',
    name: 'Merge PDFs',
    blurb: 'Combine several PDFs into one, in tray order.',
    group: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 2,
    maxInputs: null,
    load: () => import('../tools/pdf/merge.op'),
  },
  {
    id: 'pdf-split',
    name: 'Split PDF',
    blurb: 'One file per page, or one file per page range.',
    group: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 1,
    maxInputs: null,
    options: {
      mode: {
        kind: 'select',
        label: 'Split by',
        choices: [
          { value: 'pages', label: 'Every page' },
          { value: 'ranges', label: 'Page ranges' },
        ],
        default: 'pages',
      },
      ranges: { kind: 'text', label: 'Ranges', placeholder: '1-3,7,9-', default: '' },
    },
    load: () => import('../tools/pdf/split.op'),
  },
  {
    id: 'pdf-organize',
    name: 'Organize pages',
    blurb: 'Reorder, rotate and delete pages on a visual page board.',
    group: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 1,
    maxInputs: 1,
    editor: () => import('../tools/pdf/organize.editor'),
    load: () => import('../tools/pdf/organize.op'),
  },
  {
    id: 'pdf-shrink',
    name: 'Shrink PDF',
    blurb: 'Re-encodes images inside the PDF. Reports real before/after bytes.',
    group: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 1,
    maxInputs: null,
    options: {
      quality: { kind: 'range', label: 'Image quality', min: 10, max: 100, step: 5, default: 70 },
    },
    load: () => import('../tools/pdf/shrink.op'),
  },
  {
    id: 'pdf-to-images',
    name: 'PDF to images',
    blurb: 'Turn pages into PNG or JPEG images.',
    group: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 1,
    maxInputs: null,
    // `options` is kept as the declarative fallback and as the source of the
    // op's defaults. The `editor` below supersedes it in the UI because three
    // things here cannot be expressed as a flat schema: the pixel-size and
    // output-count readout has to be computed from the actual document, the
    // JPEG quality control must appear only for JPEG, and a page range needs
    // validating against the real page count.
    options: {
      format: {
        kind: 'select',
        label: 'Format',
        choices: [
          { value: 'png', label: 'PNG' },
          { value: 'jpeg', label: 'JPEG' },
        ],
        default: 'png',
      },
      dpi: { kind: 'number', label: 'Resolution (DPI)', min: 72, max: 600, step: 1, default: 150 },
      quality: { kind: 'range', label: 'JPEG quality', min: 10, max: 100, step: 5, default: 85 },
      pages: { kind: 'text', label: 'Pages', placeholder: 'all pages', default: '' },
    },
    editor: () => import('../tools/pdf/to-images.editor'),
    load: () => import('../tools/pdf/to-images.op'),
  },
  {
    id: 'pdf-from-images',
    name: 'Images to PDF',
    blurb: 'One image per page, in tray order. PNG and JPEG.',
    group: 'pdf',
    accepts: ['image/png', 'image/jpeg'],
    minInputs: 1,
    maxInputs: null,
    options: {
      pageSize: {
        kind: 'select',
        label: 'Page size',
        choices: [
          { value: 'fit', label: 'Fit the image' },
          { value: 'a4', label: 'A4' },
          { value: 'letter', label: 'US Letter' },
        ],
        default: 'fit',
      },
      margin: { kind: 'number', label: 'Margin (points)', min: 0, max: 72, step: 1, default: 0 },
    },
    load: () => import('../tools/pdf/from-images.op'),
  },
  {
    id: 'pdf-metadata',
    name: 'Clean PDF metadata',
    blurb: 'Remove the author, dates and XMP data a PDF carries.',
    group: 'pdf',
    accepts: ['application/pdf'],
    minInputs: 1,
    maxInputs: null,
    options: {
      keepTitle: { kind: 'toggle', label: 'Keep the document title', default: false },
      removeXmp: { kind: 'toggle', label: 'Remove XMP and application data', default: true },
    },
    load: () => import('../tools/pdf/metadata.op'),
  },
];
