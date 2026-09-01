// tests/e2e/keyboard.ts — shared keyboard-walking helper.
//
// Extracted from a11y.spec.ts so tool-first.spec.ts can use the same one
// rather than keeping a second copy: a duplicated tab-walker is a duplicated
// bug the day one of them is fixed.
import type { Page } from '@playwright/test';

/**
 * Press Tab until the focused element satisfies `matches`, or give up.
 *
 * Bounded on purpose: an unbounded loop would hang instead of failing, and
 * "reachable within a sane number of stops" is itself the property under
 * test. Returns the number of tabs taken, so a regression that buries a
 * control 40 stops deep is visible in the assertion rather than just
 * "it eventually worked".
 */
export async function tabUntil(
  page: Page,
  matches: (info: { role: string | null; label: string | null; tag: string }) => boolean,
  limit = 40,
): Promise<number> {
  for (let i = 1; i <= limit; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return {
        role: el?.getAttribute('role') ?? null,
        label: el?.getAttribute('aria-label') ?? el?.textContent?.trim().slice(0, 60) ?? null,
        tag: el?.tagName ?? 'NONE',
      };
    });
    if (matches(info)) return i;
  }
  throw new Error(`no element matched within ${limit} Tab presses`);
}
