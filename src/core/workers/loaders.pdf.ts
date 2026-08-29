import type { Op } from '../../types.js';

/**
 * Static id -> dynamic-import map for the 'pdf' group.
 * Entries MUST use literal import() calls so Vite can code-split them.
 */
export const PDF_LOADERS: Record<string, () => Promise<{ default: Op }>> = {
  'pdf-merge': () => import('../../tools/pdf/merge.op'),
  'pdf-split': () => import('../../tools/pdf/split.op'),
  'pdf-organize': () => import('../../tools/pdf/organize.op'),
  'pdf-shrink': () => import('../../tools/pdf/shrink.op'),
  'pdf-to-images': () => import('../../tools/pdf/to-images.op'),
  'pdf-from-images': () => import('../../tools/pdf/from-images.op'),
  'pdf-extract-text': () => import('../../tools/pdf/extract-text.op'),
};
