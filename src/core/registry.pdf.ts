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
];
