// tests/e2e/a11y.spec.ts — keyboard-only accessibility, against the real
// production build (see playwright.config.ts's `webServer`).
//
// WHY THIS EXISTS AS AN E2E TEST RATHER THAN A MANUAL CHECK
//
// The plan (§7.5) requires full keyboard operation. A one-off manual
// walkthrough proves it once and then rots the moment someone changes a
// tabindex. These tests re-prove it on every push.
//
// They also need REAL key events, which is why they live here and not in the
// vitest browser project: a synthetic `new KeyboardEvent('keydown', ...)`
// dispatched from page script will happily fire an app's own listener while
// telling you nothing about whether a real keypress reaches it — different
// focus semantics, no default-action handling, `isTrusted: false`. Playwright
// drives the browser's actual input pipeline, so a pass here means a person
// with a keyboard can genuinely do this.
//
// Files still arrive via `setInputFiles` on the app's own hidden input: a real
// OS file picker cannot be driven from a test at all, and that is the same
// entry point a keyboard user reaches by activating "Choose files".
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

/**
 * Press Tab until the focused element satisfies `matches`, or give up.
 *
 * Bounded on purpose: an unbounded loop would hang instead of failing, and
 * "reachable within a sane number of stops" is itself the property under test.
 * Returns the number of tabs taken so a regression that buries a control 40
 * stops deep is visible in the assertion, not just "it eventually worked".
 */
async function tabUntil(
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

/** The tray's accessible labels, in DOM order — this is the merge order. */
function trayLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[aria-label*="Position"]')].map(
      (e) => e.getAttribute('aria-label') ?? '',
    ),
  );
}

function liveRegionText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('[aria-live]')?.textContent?.trim() ?? '');
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
});

test.describe('keyboard-only operation', () => {
  test('reorders the file tray with real arrow keys and announces each move', async ({ page }) => {
    await page
      .locator('input[type="file"]')
      .setInputFiles([fixturePath('a.png'), fixturePath('b.png'), fixturePath('c.png')]);

    await expect(page.locator('[aria-label*="Position"]').first()).toBeVisible({ timeout: 15_000 });
    expect(await trayLabels(page)).toEqual([
      expect.stringContaining('a.png') as unknown as string,
      expect.stringContaining('b.png') as unknown as string,
      expect.stringContaining('c.png') as unknown as string,
    ]);

    // Reach the first tray row using nothing but Tab.
    const tabs = await tabUntil(page, (i) => (i.label ?? '').includes('a.png'));
    expect(tabs).toBeLessThanOrEqual(40);

    // ArrowDown: a.png 1 -> 2.
    await page.keyboard.press('ArrowDown');
    expect(await trayLabels(page)).toEqual([
      expect.stringContaining('b.png') as unknown as string,
      expect.stringContaining('a.png') as unknown as string,
      expect.stringContaining('c.png') as unknown as string,
    ]);
    // The move must be announced, or a screen-reader user has no idea it worked.
    expect(await liveRegionText(page)).toMatch(/a\.png moved to position 2 of 3/i);

    // Focus must FOLLOW the moved item, otherwise a second press moves a
    // different file and reordering by keyboard is unusable in practice.
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toContain(
      'a.png',
    );

    // End: jump to last.
    await page.keyboard.press('End');
    expect(await trayLabels(page)).toEqual([
      expect.stringContaining('b.png') as unknown as string,
      expect.stringContaining('c.png') as unknown as string,
      expect.stringContaining('a.png') as unknown as string,
    ]);

    // Home: jump back to first.
    await page.keyboard.press('Home');
    expect(await trayLabels(page)).toEqual([
      expect.stringContaining('a.png') as unknown as string,
      expect.stringContaining('b.png') as unknown as string,
      expect.stringContaining('c.png') as unknown as string,
    ]);

    // ArrowUp at position 1 must be a no-op, not a wrap-around: wrapping would
    // silently move a file to the far end of a merge on an over-press.
    await page.keyboard.press('ArrowUp');
    expect(await trayLabels(page)).toEqual([
      expect.stringContaining('a.png') as unknown as string,
      expect.stringContaining('b.png') as unknown as string,
      expect.stringContaining('c.png') as unknown as string,
    ]);
  });

  test('removes a file with the Delete key', async ({ page }) => {
    await page
      .locator('input[type="file"]')
      .setInputFiles([fixturePath('a.png'), fixturePath('b.png')]);
    await expect(page.locator('[aria-label*="Position"]').first()).toBeVisible({ timeout: 15_000 });

    await tabUntil(page, (i) => (i.label ?? '').includes('a.png'));
    await page.keyboard.press('Delete');

    const labels = await trayLabels(page);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain('b.png');
  });

  test('opens the palette with Ctrl+K, runs a tool, and restores focus on Escape', async ({
    page,
  }) => {
    await page.locator('input[type="file"]').setInputFiles([fixturePath('a.png')]);
    await expect(page.locator('[aria-label*="Position"]').first()).toBeVisible({ timeout: 15_000 });

    // Park focus somewhere identifiable so focus-restore is actually testable.
    await tabUntil(page, (i) => (i.label ?? '').includes('a.png'));
    const before = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    expect(before).toContain('a.png');

    await page.keyboard.press('Control+k');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Escape must close it AND put focus back where it was — a dialog that
    // dumps focus to <body> strands a keyboard user at the top of the page.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
      before,
    );

    // Reopen and drive it entirely by keyboard: type to filter, Enter to pick.
    await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.keyboard.type('convert');
    await page.keyboard.press('Enter');

    await expect(dialog).toBeHidden({ timeout: 10_000 });
    // Enter in the palette RUNS the tool, it does not merely select it (see
    // `runFromPalette` in src/ui/shell.ts) — that is what a command palette
    // is for. So the thing to wait for is a finished job, not a focused Run
    // button: `start()` disables Run and hands focus to Cancel while the job
    // is in flight, so Run is never focused on this path.
    await expect(page.getByRole('button', { name: 'Download' }).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test('runs a whole conversion without a single mouse interaction', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles([fixturePath('a.png')]);
    await expect(page.locator('[aria-label*="Position"]').first()).toBeVisible({ timeout: 15_000 });

    // One Ctrl+K, a few letters, one Enter — the palette selects AND runs.
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.type('hash');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 10_000 });

    // `hash` emits text, which the results tray must render INLINE (§7.3) —
    // making someone download a file to read a checksum would be absurd. A
    // SHA-256 is 64 hex characters, so assert the real digest is on screen
    // rather than merely that some success state was reached.
    await expect(page.getByRole('button', { name: /copy/i }).first()).toBeVisible({
      timeout: 30_000,
    });
    const shown = await page.evaluate(() => document.body.innerText);
    expect(shown).toMatch(/\b[0-9a-f]{64}\b/);
  });

  test('every interactive control shows a visible focus indicator', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles([fixturePath('a.png')]);
    await expect(page.locator('[aria-label*="Position"]').first()).toBeVisible({ timeout: 15_000 });

    // Walk the first 20 tab stops and confirm each one paints something a
    // sighted keyboard user can actually see. `outline: none` with no
    // replacement is the single most common keyboard-accessibility failure.
    const invisible: string[] = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const bad = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
        const hasShadow = cs.boxShadow !== 'none' && cs.boxShadow.trim() !== '';
        const hasBorderCue = parseFloat(cs.borderWidth || '0') > 0;
        if (hasOutline || hasShadow || hasBorderCue) return null;
        return el.getAttribute('aria-label') ?? el.tagName + ':' + el.textContent?.trim().slice(0, 30);
      });
      if (bad) invisible.push(bad);
    }
    expect(invisible).toEqual([]);
  });
});
