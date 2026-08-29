import type { ToolDef } from '../types.js';

/**
 * Tool manifest for the 'image' group. METADATA ONLY - no logic.
 * Owned by the image tools task; appended to by that task alone.
 */
export const IMAGE_TOOLS: ToolDef[] = [
  {
    id: 'image-convert',
    name: 'Convert image',
    blurb: 'Convert images to PNG, JPEG, WebP or AVIF.',
    group: 'image',
    accepts: ['image/*'],
    minInputs: 1,
    maxInputs: null,
    options: {
      format: {
        kind: 'select',
        label: 'Format',
        choices: [
          { value: 'png', label: 'PNG' },
          { value: 'jpeg', label: 'JPEG' },
          { value: 'webp', label: 'WebP' },
          { value: 'avif', label: 'AVIF' },
        ],
        default: 'webp',
      },
      quality: { kind: 'range', label: 'Quality', min: 10, max: 100, step: 5, default: 85 },
    },
    load: () => import('../tools/image/convert.op'),
  },
  {
    id: 'image-resize',
    name: 'Resize image',
    blurb: 'Resize by exact dimensions or by percentage, with an optional aspect-ratio lock.',
    group: 'image',
    accepts: ['image/*'],
    minInputs: 1,
    maxInputs: null,
    options: {
      mode: {
        kind: 'select',
        label: 'Resize by',
        choices: [
          { value: 'dimensions', label: 'Dimensions' },
          { value: 'percent', label: 'Percent' },
        ],
        default: 'dimensions',
      },
      width: { kind: 'number', label: 'Width (px)', min: 1, max: 20000, step: 1, default: 1920 },
      height: { kind: 'number', label: 'Height (px)', min: 1, max: 20000, step: 1, default: 1080 },
      percent: { kind: 'range', label: 'Percent', min: 5, max: 200, step: 5, default: 50 },
      lockAspect: { kind: 'toggle', label: 'Lock aspect ratio', default: true },
    },
    load: () => import('../tools/image/resize.op'),
  },
  {
    id: 'image-compress',
    name: 'Compress image',
    blurb: 'Re-encode at a lower quality to shrink file size, keeping the same format.',
    group: 'image',
    accepts: ['image/*'],
    minInputs: 1,
    maxInputs: null,
    options: {
      quality: { kind: 'range', label: 'Quality', min: 10, max: 100, step: 5, default: 75 },
    },
    load: () => import('../tools/image/compress.op'),
  },
  {
    id: 'image-crop',
    name: 'Crop image',
    blurb: 'Draw a crop box on a visual editor, in the image’s own pixels.',
    group: 'image',
    accepts: ['image/*'],
    minInputs: 1,
    maxInputs: 1,
    editor: () => import('../tools/image/crop.editor'),
    load: () => import('../tools/image/crop.op'),
  },
  {
    id: 'image-merge-sheet',
    name: 'Merge into a sheet',
    blurb: 'Arrange several images into one contact sheet, in tray order.',
    group: 'image',
    accepts: ['image/*'],
    minInputs: 2,
    maxInputs: null,
    options: {
      layout: {
        kind: 'select',
        label: 'Layout',
        choices: [
          { value: 'grid', label: 'Grid' },
          { value: 'row', label: 'Single row' },
          { value: 'column', label: 'Single column' },
        ],
        default: 'grid',
      },
      columns: { kind: 'number', label: 'Columns', min: 1, max: 12, step: 1, default: 3 },
      gap: { kind: 'number', label: 'Gap (px)', min: 0, max: 64, step: 1, default: 8 },
      background: {
        kind: 'select',
        label: 'Background',
        choices: [
          { value: 'white', label: 'White' },
          { value: 'black', label: 'Black' },
          { value: 'transparent', label: 'Transparent' },
        ],
        default: 'white',
      },
    },
    load: () => import('../tools/image/merge-sheet.op'),
  },
];
