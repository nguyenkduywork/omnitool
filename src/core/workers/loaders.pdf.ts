import type { Op } from '../../types.js';

/**
 * Static id -> dynamic-import map for the 'pdf' group.
 * Entries MUST use literal import() calls so Vite can code-split them.
 */
export const PDF_LOADERS: Record<string, () => Promise<{ default: Op }>> = {
  'pdf-merge': () => import('../../tools/pdf/merge.op'),
};
