import type { Op } from '../../types.js';

/**
 * Static id -> dynamic-import map for the 'data' group.
 * Entries MUST use literal import() calls so Vite can code-split them.
 */
export const DATA_LOADERS: Record<string, () => Promise<{ default: Op }>> = {
  'zip-create': () => import('../../tools/data/zip-create.op.js'),
  'zip-extract': () => import('../../tools/data/zip-extract.op.js'),
  hash: () => import('../../tools/data/hash.op.js'),
  base64: () => import('../../tools/data/base64.op.js'),
  'csv-json': () => import('../../tools/data/csv-json.op.js'),
  'json-format': () => import('../../tools/data/json-format.op.js'),
  'qr-generate': () => import('../../tools/data/qr.op.js'),
};
