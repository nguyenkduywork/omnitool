import type { ToolDef } from '../types.js';

/**
 * Tool manifest for the 'image' group. Metadata, plus pure predicates over file METADATA (name, size, sniffed
 * type) — never over file contents. That rule is what keeps this module
 * synchronous, allocation-free, and testable under plain Node.
 */
export const IMAGE_TOOLS: ToolDef[] = [
  {
    id: 'image-convert',
    name: 'Convert image',
    blurb: 'Convert images to PNG, JPEG, WebP or AVIF.',
    group: 'image',
    kind: 'transform',
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
    kind: 'transform',
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
    kind: 'transform',
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
    kind: 'transform',
    accepts: ['image/*'],
    minInputs: 1,
    maxInputs: 1,
    editor: () => import('../tools/image/crop.editor'),
    load: () => import('../tools/image/crop.op'),
  },
  {
    id: 'image-rotate',
    name: 'Rotate image',
    blurb: 'Turn images in 90° steps, or mirror them left-to-right or top-to-bottom.',
    group: 'image',
    kind: 'transform',
    accepts: ['image/*'],
    minInputs: 1,
    maxInputs: null,
    // `options` is kept as the declarative fallback and as the source of the
    // op's defaults. The `editor` below supersedes it in the UI because a
    // rotation is a spatial claim a dropdown cannot make: clockwise versus
    // anticlockwise is a coin flip in words, and rotate composes with mirror
    // in a fixed order (mirror first) that only a picture can show.
    options: {
      angle: {
        kind: 'select',
        label: 'Rotate',
        choices: [
          { value: '90', label: '90° clockwise' },
          { value: '180', label: '180°' },
          { value: '270', label: '90° anticlockwise' },
          { value: '0', label: 'No rotation' },
        ],
        default: '90',
      },
      flip: {
        kind: 'select',
        label: 'Mirror',
        choices: [
          { value: 'none', label: 'No mirror' },
          { value: 'horizontal', label: 'Left to right' },
          { value: 'vertical', label: 'Top to bottom' },
        ],
        default: 'none',
      },
      quality: { kind: 'range', label: 'Re-encode quality', min: 10, max: 100, step: 5, default: 92 },
    },
    editor: () => import('../tools/image/rotate.editor'),
    load: () => import('../tools/image/rotate.op'),
  },
  {
    id: 'image-strip-metadata',
    name: 'Strip metadata',
    blurb: 'Remove EXIF, GPS, XMP and comments without re-encoding the picture.',
    group: 'image',
    kind: 'transform',
    accepts: ['image/jpeg', 'image/png', 'image/webp'],
    minInputs: 1,
    maxInputs: null,
    options: {
      keepColorProfile: { kind: 'toggle', label: 'Keep colour profile', default: true },
    },
    load: () => import('../tools/image/strip-metadata.op'),
  },
  {
    id: 'image-merge-sheet',
    name: 'Merge into a sheet',
    blurb: 'Arrange several images into one contact sheet, in tray order.',
    group: 'image',
    kind: 'transform',
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
  {
    id: 'image-watermark',
    name: 'Watermark image',
    blurb: 'Stamp a line of text over an image.',
    group: 'image',
    kind: 'transform',
    accepts: ['image/*'],
    minInputs: 1,
    maxInputs: null,
    options: {
      text: { kind: 'text', label: 'Text', placeholder: 'CONFIDENTIAL', default: 'CONFIDENTIAL' },
      position: {
        kind: 'select',
        label: 'Position',
        choices: [
          { value: 'bottom-right', label: 'Bottom right' },
          { value: 'bottom-left', label: 'Bottom left' },
          { value: 'top-right', label: 'Top right' },
          { value: 'top-left', label: 'Top left' },
          { value: 'center', label: 'Centre' },
          { value: 'tile', label: 'Tiled diagonally' },
        ],
        default: 'bottom-right',
      },
      // A percentage of the image's shorter side, not pixels — see the note at
      // the top of watermark.op.ts.
      size: { kind: 'range', label: 'Text size (%)', min: 1, max: 25, step: 1, default: 6 },
      opacity: { kind: 'range', label: 'Opacity (%)', min: 5, max: 100, step: 5, default: 35 },
      colour: {
        kind: 'select',
        label: 'Colour',
        choices: [
          { value: 'white', label: 'White' },
          { value: 'black', label: 'Black' },
        ],
        default: 'white',
      },
      quality: { kind: 'range', label: 'Re-encode quality', min: 10, max: 100, step: 5, default: 92 },
    },
    load: () => import('../tools/image/watermark.op'),
  },
];
