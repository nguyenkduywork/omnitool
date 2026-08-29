import type { Op } from '../../types.js';

/**
 * Static id -> dynamic-import map for the 'image' group.
 * Entries MUST use literal import() calls so Vite can code-split them.
 */
export const IMAGE_LOADERS: Record<string, () => Promise<{ default: Op }>> = {};
