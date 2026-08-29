// tests/unit/motion.browser.test.ts
//
// motion.ts is DOM + rAF code, so it is tested in the real headless-Chromium
// vitest project (the `node` project has no DOM, and no jsdom/happy-dom is
// installed — see the report note). Real browser => real matchMedia, real
// requestAnimationFrame, real anime.js engine.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DURATION,
  EASE,
  STAGGER_MS,
  flyToResults,
  morphToTray,
  openPalette,
  prefersReducedMotion,
  refreshMotionPreference,
  revealTools,
  settleReorder,
} from '../../src/ui/motion';

let host: HTMLElement;

function box(): HTMLElement {
  const el = document.createElement('div');
  el.style.width = '80px';
  el.style.height = '40px';
  host.appendChild(el);
  return el;
}

/** Replace matchMedia so the reduced-motion branch can be exercised for real. */
function forceReducedMotion(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  refreshMotionPreference();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  vi.unstubAllGlobals();
  refreshMotionPreference();
  host.remove();
});

describe('motion tokens', () => {
  it('exports shared duration and easing tokens', () => {
    expect(DURATION.fast).toBeGreaterThan(0);
    expect(DURATION.base).toBeGreaterThan(0);
    expect(DURATION.morph).toBeGreaterThan(0);
    expect(DURATION.settle).toBeGreaterThan(0);
    expect(typeof EASE.out).toBe('string');
    expect(STAGGER_MS).toBeGreaterThan(0);
  });
});

describe('with motion enabled', () => {
  beforeEach(() => {
    forceReducedMotion(false);
  });

  it('reports that motion is allowed', () => {
    expect(prefersReducedMotion()).toBe(false);
  });

  it('revealTools animates rather than jumping, and lands at the end state', async () => {
    const cards = [box(), box(), box()];
    const running = revealTools(cards);

    // Synchronously after the call the cards are at the START state: proof this
    // is a real animation and not an instant write.
    expect(cards[0]?.style.opacity).toBe('0');
    expect(cards[0]?.style.transform).not.toBe('');

    await running;

    for (const card of cards) {
      // End state = the stylesheet's own values, i.e. no inline overrides left.
      expect(card.style.transform).toBe('');
      expect(card.style.opacity).toBe('');
      // will-change is applied on start and removed on completion (§6.1/7).
      expect(card.style.willChange).toBe('');
    }
  });

  it('touches only transform and opacity while running', async () => {
    const card = box();
    const running = revealTools([card]);

    const touched = new Set<string>();
    for (let i = 0; i < card.style.length; i++) {
      const name = card.style.item(i);
      if (name) touched.add(name);
    }
    // width/height were set by box() itself; everything motion added must be
    // transform, opacity or will-change. No layout properties.
    touched.delete('width');
    touched.delete('height');
    expect([...touched].sort()).toEqual(['opacity', 'transform', 'will-change']);

    await running;
  });

  it('settleReorder springs a displaced item back to its resting transform', async () => {
    const item = box();
    const running = settleReorder([{ el: item, dx: 0, dy: 48 }]);
    expect(item.style.transform).toContain('48');
    await running;
    expect(item.style.transform).toBe('');
    expect(item.style.willChange).toBe('');
  });

  it('flyToResults and openPalette resolve at their end state', async () => {
    const cards = [box(), box()];
    await flyToResults(cards);
    for (const card of cards) expect(card.style.transform).toBe('');

    const panel = box();
    await openPalette(panel);
    expect(panel.style.transform).toBe('');
    expect(panel.style.opacity).toBe('');
  });

  it('morphToTray fades the source out and lands the target at rest', async () => {
    const from = box();
    const to = box();
    await morphToTray(from, to);
    expect(from.style.opacity).toBe('0');
    expect(to.style.transform).toBe('');
    expect(to.style.opacity).toBe('');
  });
});

describe('with prefers-reduced-motion: reduce', () => {
  beforeEach(() => {
    forceReducedMotion(true);
  });

  it('reports the preference', () => {
    expect(prefersReducedMotion()).toBe(true);
  });

  it('revealTools applies the end state synchronously, with no animation', () => {
    const cards = [box(), box()];
    for (const card of cards) {
      card.style.opacity = '0';
      card.style.transform = 'translateY(40px)';
    }

    const running = revealTools(cards);

    // No await: the end state is already in place.
    for (const card of cards) {
      expect(card.style.transform).toBe('');
      expect(card.style.opacity).toBe('');
      expect(card.style.willChange).toBe('');
    }
    return running;
  });

  it('flyToResults, openPalette and settleReorder are instant no-ops', () => {
    const a = box();
    const b = box();
    const c = box();
    a.style.transform = 'translateY(30px)';
    b.style.transform = 'scale(.5)';
    c.style.transform = 'translateY(90px)';

    const jobs = [flyToResults([a]), openPalette(b), settleReorder([{ el: c, dx: 0, dy: 90 }])];

    expect(a.style.transform).toBe('');
    expect(b.style.transform).toBe('');
    expect(c.style.transform).toBe('');
    return Promise.all(jobs);
  });

  it('morphToTray applies its end state instantly', () => {
    const from = box();
    const to = box();
    to.style.opacity = '0';
    to.style.transform = 'translateY(60px)';

    const running = morphToTray(from, to);

    expect(to.style.transform).toBe('');
    expect(to.style.opacity).toBe('');
    expect(from.style.opacity).toBe('0');
    return running;
  });

  it('every motion export still resolves, so nothing can depend on a tick', async () => {
    const el = box();
    await Promise.all([
      revealTools([el]),
      morphToTray(box(), box()),
      flyToResults([el]),
      settleReorder([{ el, dx: 4, dy: 4 }]),
      openPalette(el),
    ]);
    expect(el.style.willChange).toBe('');
  });
});
