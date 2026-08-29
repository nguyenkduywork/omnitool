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
