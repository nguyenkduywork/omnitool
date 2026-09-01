// src/ui/motion.ts — the single animation source of truth.
//
// THE ONLY MODULE IN THE REPO PERMITTED TO IMPORT animejs (§1, ESLint-enforced).
//
// ---------------------------------------------------------------------------
// anime.js v4 API, verified against the installed package (animejs@4.5.0,
// node_modules/animejs/dist/modules/index.js) rather than assumed:
//
//   * There is NO default export and NO `anime` namespace object. v4 ships FLAT
//     NAMED EXPORTS: animate, createTimeline, createTimer, createSpring,
//     createDraggable, createDrawable, createScope, createAnimatable, stagger,
//     svg, utils, eases, easings, engine, spring, onScroll, remove, set, get,
//     lerp, clamp, snap, morphTo, waapi, text, splitText.
//   * Tween options were renamed in v4: it is `ease`, not v3's `easing`.
//     Easing strings are camelCase ('outQuart', 'inOutQuad', ...), and a Spring
//     instance is itself a valid `ease` value.
//   * MEASURED, not assumed: `createSpring()` still exists in 4.5.0 but logs
//     "createSpring() is deprecated use spring() instead" at runtime, so this
//     module uses `spring()`.
//   * `stagger(ms)` returns a function you pass as `delay`.
//   * A JSAnimation is thenable, but this module drives completion through the
//     explicit `onComplete` callback instead: the same hook has to strip
//     `will-change`, so one path covers both.
//
// Only THREE of those exports are used here — animate, stagger, spring — so
// tree-shaking keeps the initial bundle inside the §1 size budget.
// ---------------------------------------------------------------------------
//
// Two rules this module never breaks:
//
//   1. COMPOSITED PROPERTIES ONLY. Every tween touches `transform` and/or
//      `opacity`. Nothing here animates or reads layout. `will-change` is set
//      when a tween starts and removed when it ends, so no node is left
//      permanently promoted to its own layer.
//   2. NOTHING DEPENDS ON AN ANIMATION FINISHING. Under
//      `prefers-reduced-motion: reduce` every export below becomes a no-op that
//      applies the END STATE INSTANTLY and returns an already-resolved promise.
//      Callers may await these functions, but they must never need to.

import { animate, spring, stagger } from 'animejs';

/** Read first, so the rest of the module is written against a known answer. */
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function readMotionPreference(): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

let reduced = readMotionPreference();

/**
 * Re-read the OS preference. Wired to the media query's `change` event so
 * flipping the setting takes effect without a reload; exported so a test can
 * exercise the reduced-motion branch through the real code path.
 */
export function refreshMotionPreference(): void {
  reduced = readMotionPreference();
}

export function prefersReducedMotion(): boolean {
  return reduced;
}

if (typeof matchMedia === 'function') {
  try {
    matchMedia(REDUCED_MOTION_QUERY).addEventListener('change', refreshMotionPreference);
  } catch {
    // Ancient MediaQueryList without addEventListener: the initial read stands.
  }
}

/** Shared duration tokens, in ms. §8 of the spec fixes the headline numbers. */
export const DURATION = {
  /** Palette open, small state flips. */
  fast: 180,
  /** The default: cards in, results in. */
  base: 240,
  /** Spring settle after a reorder. */
  settle: 420,
} as const;

/** Shared easing tokens. camelCase names are v4's own vocabulary. */
export const EASE = {
  out: 'outQuart',
  inOut: 'inOutQuart',
  emphasis: 'outExpo',
} as const;

/** Per-card offset for a staggered entrance (§8: ~24 ms). */
export const STAGGER_MS = 24;

/** One displaced element in a FLIP reorder, in pixels. */
export type Displacement = { el: HTMLElement; dx: number; dy: number };

type AnimateParams = Parameters<typeof animate>[1];

let settleSpring: ReturnType<typeof spring> | null = null;

function settleEase(): ReturnType<typeof spring> {
  // Built on first use so a reduced-motion visitor never pays for it.
  settleSpring ??= spring({ stiffness: 180, damping: 18, mass: 1 });
  return settleSpring;
}

/** Drop the inline transform/opacity overrides, returning nodes to stylesheet rest. */
function rest(els: readonly HTMLElement[]): void {
  for (const el of els) {
    el.style.transform = '';
    el.style.opacity = '';
    el.style.willChange = '';
  }
}

/**
 * Run one tween over `els` and resolve when it is done.
 *
 * `will-change` goes on before the first frame and comes off in `onComplete`.
 * The `guardMs` timer is the safety net for a node detached mid-flight: anime
 * would never call `onComplete`, and the promise (plus the will-change hint)
 * would leak.
 */
function play(
  els: readonly HTMLElement[],
  params: AnimateParams,
  hint: string,
  guardMs: number,
): Promise<void> {
  if (els.length === 0) return Promise.resolve();
  for (const el of els) el.style.willChange = hint;

  return new Promise<void>((resolve) => {
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      for (const el of els) el.style.willChange = '';
      resolve();
    };

    // Declared after `finish` on purpose: `finish` only reads it from inside a
    // closure, and it must exist before `animate` can possibly complete.
    const guard = setTimeout(finish, guardMs);
    animate(els as HTMLElement[], { ...params, onComplete: finish });
  });
}

/**
 * The filtered tool grid appearing for the first time: a short staggered rise.
 * Shown once per grid paint — re-filtering does not re-run it (that would be
 * decorative), the shell decides.
 */
export function revealTools(cards: readonly HTMLElement[]): Promise<void> {
  if (reduced) {
    rest(cards);
    return Promise.resolve();
  }
  for (const card of cards) {
    card.style.opacity = '0';
    card.style.transform = 'translateY(10px) scale(0.985)';
  }
  return play(
    cards,
    {
      opacity: [0, 1],
      translateY: [10, 0],
      scale: [0.985, 1],
      duration: DURATION.base,
      delay: stagger(STAGGER_MS),
      ease: EASE.out,
    },
    'transform, opacity',
    DURATION.base + STAGGER_MS * cards.length + 400,
  ).then(() => rest(cards));
}

/**
 * `.hero`'s own exit transition duration, in ms — app.css's `--dur-fast`,
 * kept here as a plain number because this file has no resolved CSS custom
 * property to read before the transition starts. Deliberately NOT
 * `DURATION.fast` above: that token is animejs's own vocabulary, used only by
 * tweens `animate()` drives, and the two happen to differ (180ms vs 120ms).
 */
export const HERO_EXIT_DURATION_MS = 120;

/**
 * The hero dissolving away as the `browsing` phase ends. Before Task 10 this
 * was a FLIP-flavoured morph into the file tray + tool grid, because that
 * workbench did not exist on screen yet (`hidden` until the first file). It
 * is now always mounted and already fully visible, so there is nothing left
 * to animate an entrance for — treating it as one (as the old `morphToTray`
 * did, blind to whether its `to` target had ever been painted) snapped the
 * already-visible workbench to `opacity: 0` and flew it back in, a flicker
 * over content the user was already looking at.
 *
 * So this only ever touches the ONE element that actually leaves. A single
 * element losing opacity has no FLIP measurement to do, so the visual side
 * is a plain CSS transition (`.hero.is-exiting` in app.css) rather than an
 * `animate()` tween — the weight of measuring rects and coordinating two
 * tweens bought nothing once only one element was moving. This keeps the one
 * contract every other export here keeps: fire, never block a render, and
 * resolve once it is safe to act on the end state — nothing functional may
 * depend on the visual transition itself finishing (§7.5).
 */
export function fadeHero(el: HTMLElement): Promise<void> {
  el.classList.add('is-exiting');
  if (reduced) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, HERO_EXIT_DURATION_MS));
}

/**
 * Outputs arriving in the results tray. They enter from above — the direction
 * the run button they came from sits in — so the motion says where they are from.
 */
export function flyToResults(cards: readonly HTMLElement[]): Promise<void> {
  if (reduced) {
    rest(cards);
    return Promise.resolve();
  }
  for (const card of cards) {
    card.style.opacity = '0';
    card.style.transform = 'translateY(-14px)';
  }
  return play(
    cards,
    {
      opacity: [0, 1],
      translateY: [-14, 0],
      duration: DURATION.base,
      delay: stagger(STAGGER_MS),
      ease: EASE.out,
    },
    'transform, opacity',
    DURATION.base + STAGGER_MS * cards.length + 400,
  ).then(() => rest(cards));
}

/**
 * Spring settle after a drag- or keyboard-reorder. The caller has already moved
 * the nodes; `moves` carries how far each one *appears* to have jumped, and the
 * spring walks that displacement back to zero.
 */
export function settleReorder(moves: readonly Displacement[]): Promise<void> {
  const all = moves.map((move) => move.el);
  if (reduced) {
    rest(all);
    return Promise.resolve();
  }

  const moved = moves.filter((move) => move.dx !== 0 || move.dy !== 0);
  if (moved.length === 0) {
    rest(all);
    return Promise.resolve();
  }

  for (const move of moved) {
    // Separate transform functions: v4 parses these individually.
    move.el.style.transform = `translateX(${move.dx}px) translateY(${move.dy}px)`;
  }

  return play(
    moved.map((move) => move.el),
    {
      translateX: 0,
      translateY: 0,
      ease: settleEase(),
    },
    'transform',
    1600,
  ).then(() => rest(all));
}

/** Command palette opening (Task 7 owns the palette itself). */
export function openPalette(panel: HTMLElement): Promise<void> {
  if (reduced) {
    rest([panel]);
    return Promise.resolve();
  }
  panel.style.opacity = '0';
  panel.style.transform = 'translateY(-6px) scale(0.96)';
  return play(
    [panel],
    {
      opacity: [0, 1],
      translateY: [-6, 0],
      scale: [0.96, 1],
      duration: DURATION.fast,
      ease: EASE.out,
    },
    'transform, opacity',
    DURATION.fast + 400,
  ).then(() => rest([panel]));
}
