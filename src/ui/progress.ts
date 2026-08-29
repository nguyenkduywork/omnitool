// src/ui/progress.ts — the progress ring.
//
// The ring is DRIVEN BY REAL `Job.onProgress` VALUES. There is deliberately no
// animation here, no easing toward an imagined finish, no indeterminate spinner
// pretending to be progress: `set(fraction)` writes exactly the fraction the
// worker reported. A ring that lies is worse than no ring.
//
// The only smoothing is a short CSS transition on `stroke-dashoffset` (a paint
// property, not a layout one) so the 50 ms-throttled ticks do not staircase, and
// tokens.css switches that off under prefers-reduced-motion.

import { el, svgEl } from './dom';

export type ProgressHandle = {
  readonly el: HTMLElement;
  /** Show `fraction` (0..1) exactly as reported. */
  set(fraction: number): void;
  /** The task line beside the ring, e.g. "Merging PDFs". */
  setLabel(text: string): void;
  reset(): void;
};

const R = 19;
const CIRCUMFERENCE = 2 * Math.PI * R;

export function createProgressRing(): ProgressHandle {
  const root = el('div', 'progress');

  const ring = el('div', 'ring');
  const svg = svgEl('svg', { viewBox: '0 0 44 44', 'aria-hidden': 'true', focusable: 'false' });
  const track = svgEl('circle', {
    class: 'ring__track',
    cx: '22',
    cy: '22',
    r: String(R),
  });
  const value = svgEl('circle', {
    class: 'ring__value',
    cx: '22',
    cy: '22',
    r: String(R),
    'stroke-dasharray': CIRCUMFERENCE.toFixed(2),
    'stroke-dashoffset': CIRCUMFERENCE.toFixed(2),
  });
  svg.append(track, value);

  const percent = el('span', 'ring__pct', '0%');
  ring.append(svg, percent);

  const text = el('p', 'progress__label', 'Working…');

  // One live region for the numeric state; the shell owns the wordier one.
  const status = el('span', 'sr-only');
  status.setAttribute('role', 'progressbar');
  status.setAttribute('aria-valuemin', '0');
  status.setAttribute('aria-valuemax', '100');
  status.setAttribute('aria-valuenow', '0');

  root.append(ring, text, status);

  function set(fraction: number): void {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
    const whole = Math.round(clamped * 100);
    value.setAttribute('stroke-dashoffset', (CIRCUMFERENCE * (1 - clamped)).toFixed(2));
    percent.textContent = `${whole}%`;
    status.setAttribute('aria-valuenow', String(whole));
    status.textContent = `${whole}% complete`;
  }

  return {
    el: root,
    set,
    setLabel(next: string): void {
      text.textContent = next;
    },
    reset(): void {
      set(0);
    },
  };
}
