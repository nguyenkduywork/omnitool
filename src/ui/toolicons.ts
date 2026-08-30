// src/ui/toolicons.ts — which glyph stands for which tool.
//
// This lives in ui/ rather than on `ToolDef` because the registry is metadata
// only (§3.3): an icon name is a fact about how a tool is DRAWN, and the ops
// know nothing about being drawn. Keeping it here also means the tool grid and
// the command palette cannot drift apart — they read the same table.

import type { ToolDef, ToolGroup } from '../types';
import type { IconName } from './dom';

export const GROUP_TITLE: Record<ToolGroup, string> = {
  pdf: 'PDF',
  image: 'Images',
  data: 'Data & text',
};

export const GROUP_ICON: Record<ToolGroup, IconName> = {
  pdf: 'file',
  image: 'image',
  data: 'braces',
};

export const GROUP_ORDER: ToolGroup[] = ['pdf', 'image', 'data'];

const TOOL_ICON: Record<string, IconName> = {
  'pdf-merge': 'merge',
  'pdf-split': 'split',
  'pdf-organize': 'grid',
  'pdf-shrink': 'shrink',
  'pdf-to-images': 'image',
  'pdf-from-images': 'file',
  'pdf-metadata': 'shield',
  'image-convert': 'swap',
  'image-resize': 'expand',
  'image-compress': 'shrink',
  'image-crop': 'crop',
  'image-merge-sheet': 'layers',
  'image-rotate': 'rotate',
  'image-strip-metadata': 'shield',
  'image-watermark': 'stamp',
  'zip-create': 'archive',
  'zip-extract': 'unarchive',
  hash: 'hash',
  base64: 'code',
  'csv-json': 'table',
  'json-format': 'braces',
  'qr-generate': 'qr',
  gzip: 'shrink',
  'tar-create': 'archive',
  'tar-extract': 'unarchive',
  'file-split': 'split',
  'file-join': 'merge',
  'text-clean': 'spark',
};

/** A tool with no entry of its own falls back to its family's glyph, so adding
 *  a tool to the registry can never render a blank square. */
export function toolIcon(tool: ToolDef): IconName {
  return TOOL_ICON[tool.id] ?? GROUP_ICON[tool.group];
}
