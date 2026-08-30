import type { Op } from '../../types.js';

/**
 * Static id -> dynamic-import map for the 'image' group.
 * Entries MUST use literal import() calls so Vite can code-split them.
 */
export const IMAGE_LOADERS: Record<string, () => Promise<{ default: Op }>> = {
  'image-convert': () => import('../../tools/image/convert.op'),
  'image-resize': () => import('../../tools/image/resize.op'),
  'image-compress': () => import('../../tools/image/compress.op'),
  'image-crop': () => import('../../tools/image/crop.op'),
  'image-merge-sheet': () => import('../../tools/image/merge-sheet.op'),
  'image-rotate': () => import('../../tools/image/rotate.op'),
  'image-strip-metadata': () => import('../../tools/image/strip-metadata.op'),
  'image-watermark': () => import('../../tools/image/watermark.op'),
};
