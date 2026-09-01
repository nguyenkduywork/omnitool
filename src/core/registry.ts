// src/core/registry.ts — the tool manifest. METADATA ONLY.
//
// No format knowledge, no logic beyond array lookups. Each group owns its own
// manifest module (registry.pdf.ts / registry.image.ts / registry.data.ts) so
// that adding a tool touches one file and never collides with another group.

import type { ToolDef } from '../types';
import { accepts } from './format';
import { DATA_TOOLS } from './registry.data';
import { IMAGE_TOOLS } from './registry.image';
import { PDF_TOOLS } from './registry.pdf';

export const TOOLS: ToolDef[] = [...PDF_TOOLS, ...IMAGE_TOOLS, ...DATA_TOOLS];

export function getTool(id: string): ToolDef | undefined {
  return TOOLS.find((tool) => tool.id === id);
}

/** The tools that can run against exactly this selection of mime types. */
export function toolsFor(mimes: string[]): ToolDef[] {
  return TOOLS.filter((tool) => accepts(tool, mimes));
}
