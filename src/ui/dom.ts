// src/ui/dom.ts — the three DOM chores every UI module repeats.
//
// Deliberately tiny: element creation, byte formatting, and a hand-drawn icon
// set. No templating, no virtual DOM, nothing that competes with anime.js for
// ownership of a node (§6.1 mechanism 1).
//
// Note on innerHTML: it is used ONLY for the literal icon paths below, which are
// authored in this file. Every piece of user-supplied text (file names, error
// messages, decoded file contents) goes through textContent, always.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Decimal units, matching what the OS file browser shows. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1000) return `${bytes} B`;
  const units = ['kB', 'MB', 'GB', 'TB'];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? 'TB'}`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const STROKE = 'fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

const ICONS = {
  // -- chrome and controls ------------------------------------------------
  grip: '<path d="M7.5 5.5h.01M12.5 5.5h.01M7.5 10h.01M12.5 10h.01M7.5 14.5h.01M12.5 14.5h.01" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>',
  close: `<path d="M5.5 5.5l9 9M14.5 5.5l-9 9" ${STROKE}/>`,
  download: `<path d="M10 3v10m0 0l-3.5-3.5M10 13l3.5-3.5M4 16h12" ${STROKE}/>`,
  copy: `<path d="M7.5 7.5h7a1 1 0 011 1v7a1 1 0 01-1 1h-7a1 1 0 01-1-1v-7a1 1 0 011-1z" ${STROKE}/><path d="M4.5 12.5a1 1 0 01-1-1v-7a1 1 0 011-1h7a1 1 0 011 1" ${STROKE}/>`,
  check: `<path d="M4.5 10.5l3.5 3.5 7.5-8" ${STROKE}/>`,
  up: `<path d="M5.5 12L10 7.5l4.5 4.5" ${STROKE}/>`,
  down: `<path d="M5.5 8l4.5 4.5L14.5 8" ${STROKE}/>`,
  plus: `<path d="M10 4.5v11M4.5 10h11" ${STROKE}/>`,
  play: '<path d="M6.5 4.2l9 5.8-9 5.8z" fill="currentColor"/>',
  alert: `<path d="M10 3.5l7 12.5H3z" ${STROKE}/><path d="M10 8.5v3.2M10 13.8h.01" ${STROKE}/>`,
  theme: `<circle cx="10" cy="10" r="5.5" ${STROKE}/><path d="M10 4.5v11" ${STROKE}/><path d="M10 4.6a5.4 5.4 0 000 10.8z" fill="currentColor" stroke="none"/>`,
  spark: `<path d="M10 2.5l1.9 5.1 5.1 1.9-5.1 1.9L10 16.5l-1.9-5.1L3 9.5l5.1-1.9z" ${STROKE}/>`,
  search: `<circle cx="9" cy="9" r="5.2" ${STROKE}/><path d="M12.8 12.8L17 17" ${STROKE}/>`,

  // -- the three families -------------------------------------------------
  file: `<path d="M11 2.8H6.6a1.6 1.6 0 00-1.6 1.6v11.2a1.6 1.6 0 001.6 1.6h6.8a1.6 1.6 0 001.6-1.6V6.6z" ${STROKE}/><path d="M11 2.8v3.8h4" ${STROKE}/>`,
  image: `<rect x="3.2" y="4.4" width="13.6" height="11.2" rx="2" ${STROKE}/><circle cx="7.6" cy="8.4" r="1.3" ${STROKE}/><path d="M3.6 14.2l3.6-3.5a1.4 1.4 0 011.9 0l3.4 3.3" ${STROKE}/><path d="M12.4 11.8l1.2-1.1a1.4 1.4 0 011.9 0l1.1 1" ${STROKE}/>`,
  braces: `<path d="M8.6 3.6c-1.5 0-2.1.8-2.1 2v2.2c0 1.2-.6 2.2-1.8 2.2 1.2 0 1.8 1 1.8 2.2v2.2c0 1.2.6 2 2.1 2" ${STROKE}/><path d="M11.4 3.6c1.5 0 2.1.8 2.1 2v2.2c0 1.2.6 2.2 1.8 2.2-1.2 0-1.8 1-1.8 2.2v2.2c0 1.2-.6 2-2.1 2" ${STROKE}/>`,

  // -- per-tool glyphs ----------------------------------------------------
  merge: `<path d="M3 5.5h2.6c1.1 0 2.2.5 2.9 1.4l1.1 1.4c.7.9 1.8 1.4 2.9 1.4H16" ${STROKE}/><path d="M3 14.5h2.6c1.1 0 2.2-.5 2.9-1.4l.8-1" ${STROKE}/><path d="M13.8 7.4L16 9.7l-2.2 2.3" ${STROKE}/>`,
  split: `<path d="M3 10h2.6c1.1 0 2.2-.5 2.9-1.4l1.1-1.4c.7-.9 1.8-1.4 2.9-1.4H16" ${STROKE}/><path d="M3 10h2.6c1.1 0 2.2.5 2.9 1.4l1.1 1.4c.7.9 1.8 1.4 2.9 1.4H16" ${STROKE}/><path d="M13.9 3.6L16.2 5.8l-2.3 2.2M13.9 11.9l2.3 2.3-2.3 2.2" ${STROKE}/>`,
  grid: `<rect x="3.2" y="3.2" width="5.9" height="5.9" rx="1.4" ${STROKE}/><rect x="10.9" y="3.2" width="5.9" height="5.9" rx="1.4" ${STROKE}/><rect x="3.2" y="10.9" width="5.9" height="5.9" rx="1.4" ${STROKE}/><rect x="10.9" y="10.9" width="5.9" height="5.9" rx="1.4" ${STROKE}/>`,
  shrink: `<path d="M7.6 2.8v3.2a1.6 1.6 0 01-1.6 1.6H2.8M12.4 2.8v3.2a1.6 1.6 0 001.6 1.6h3.2M7.6 17.2V14a1.6 1.6 0 00-1.6-1.6H2.8M12.4 17.2V14a1.6 1.6 0 011.6-1.6h3.2" ${STROKE}/>`,
  expand: `<path d="M2.8 7.6V4.4a1.6 1.6 0 011.6-1.6h3.2M12.4 2.8h3.2a1.6 1.6 0 011.6 1.6v3.2M17.2 12.4v3.2a1.6 1.6 0 01-1.6 1.6h-3.2M7.6 17.2H4.4a1.6 1.6 0 01-1.6-1.6v-3.2" ${STROKE}/>`,
  swap: `<path d="M3.4 7.4h11.2M12.1 4.9l2.5 2.5-2.5 2.5" ${STROKE}/><path d="M16.6 12.6H5.4M7.9 10.1l-2.5 2.5 2.5 2.5" ${STROKE}/>`,
  crop: `<path d="M6 2.8v11.6h11.2" ${STROKE}/><path d="M2.8 5.6H14v11.6" ${STROKE}/>`,
  rotate: `<path d="M16.2 10a6.2 6.2 0 11-1.9-4.5" ${STROKE}/><path d="M14.3 2.1v3.4h-3.4" ${STROKE}/>`,
  layers: `<path d="M10 2.8l6.6 3.3L10 9.4 3.4 6.1z" ${STROKE}/><path d="M3.4 10l6.6 3.3L16.6 10" ${STROKE}/><path d="M3.4 13.7L10 17l6.6-3.3" ${STROKE}/>`,
  archive: `<rect x="2.8" y="3.6" width="14.4" height="12.8" rx="2" ${STROKE}/><path d="M2.8 7.8h14.4" ${STROKE}/><path d="M8.4 11.4h3.2" ${STROKE}/>`,
  unarchive: `<path d="M17 10.6v4.6a1.8 1.8 0 01-1.8 1.8H4.8A1.8 1.8 0 013 15.2v-4.6" ${STROKE}/><path d="M10 12.6V3.2m0 0L6.9 6.3M10 3.2l3.1 3.1" ${STROKE}/>`,
  hash: `<path d="M7.6 3.2L5.9 16.8M14.1 3.2l-1.7 13.6M3.4 7.6h13.2M2.8 12.4h13.2" ${STROKE}/>`,
  code: `<path d="M7 6.2L3.4 10 7 13.8M13 6.2L16.6 10 13 13.8M11.4 3.8l-2.8 12.4" ${STROKE}/>`,
  table: `<rect x="2.8" y="3.8" width="14.4" height="12.4" rx="1.8" ${STROKE}/><path d="M2.8 8h14.4M8 8v8.2" ${STROKE}/>`,
  qr: `<rect x="3" y="3" width="5.4" height="5.4" rx="1.2" ${STROKE}/><rect x="11.6" y="3" width="5.4" height="5.4" rx="1.2" ${STROKE}/><rect x="3" y="11.6" width="5.4" height="5.4" rx="1.2" ${STROKE}/><path d="M11.6 11.6h2.2M17 11.6v2.4M11.6 15.2v1.8M15.4 17H17" ${STROKE}/>`,

  // -- the promise, drawn -------------------------------------------------
  shield: `<path d="M10 2.8l5.6 2.2v4.6c0 3.5-2.3 6.5-5.6 7.6-3.3-1.1-5.6-4.1-5.6-7.6V5z" ${STROKE}/><path d="M7.6 10.1l1.8 1.8 3.2-3.6" ${STROKE}/>`,
  bolt: `<path d="M11 2.6L4.6 11h4.3l-.6 6.4L15.4 9h-4.3z" ${STROKE}/>`,
  offline: `<path d="M3 3l14 14" ${STROKE}/><path d="M6.6 14.6h7a3.2 3.2 0 002.1-5.6" ${STROKE}/><path d="M13 6.9A4.7 4.7 0 005.5 9.7a3.2 3.2 0 00.6 4.9" ${STROKE}/>`,
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', 'icon');
  svg.innerHTML = ICONS[name];
  return svg;
}

/** A button with an icon and a real accessible name. */
export function iconButton(name: IconName, accessibleName: string, className: string): HTMLButtonElement {
  const button = el('button', className);
  button.type = 'button';
  button.title = accessibleName;
  button.setAttribute('aria-label', accessibleName);
  button.append(icon(name));
  return button;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
