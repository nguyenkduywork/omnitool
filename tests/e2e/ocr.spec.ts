// tests/e2e/ocr.spec.ts — end-to-end proof that OCR works through the real
// UI, against the production build (see playwright.config.ts's webServer).
//
// This is not "some string came back": it asserts the RECOGNISED TEXT
// actually matches what tests/fixtures/make-fixtures.mjs rendered into
// tests/fixtures/ocr-text.png ("OMNITOOL OCR TEST"), read straight out of
// the results tray's inline text preview (src/ui/results.ts's `.card__text`
// — the same element extract-text/hash/json-format render into, since OCR's
// output is `text/plain` too).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

/** Pick a tool and wait for the app's own "ready to run" signal — see
 *  golden.spec.ts's header for why this, not an arbitrary wait, is correct. */
async function selectTool(page: Page, toolId: string): Promise<void> {
  const card = page.locator(`[data-tool="${toolId}"]`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(page.getByRole('button', { name: 'Run' })).toBeFocused({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
});

test.describe('OCR — production build', () => {
  test('drop a generated image with known rendered text, run Scan to text, and the recognised text matches', async ({
    page,
  }) => {
    await page.locator('input[type="file"]').setInputFiles([fixturePath('ocr-text.png')]);

    await selectTool(page, 'ocr');
    await page.getByRole('button', { name: 'Run' }).click();

    // First use downloads the OCR engine and the English language pack from
    // this same server — genuinely slower than every other golden flow, so
    // this gets the longest timeout in the suite rather than a shared one.
    const downloadButton = page.getByRole('button', { name: 'Download' });
    await expect(downloadButton).toBeVisible({ timeout: 60_000 });

    const recognised = (await page.locator('.card__text').textContent()) ?? '';
    // The exact string rendered into the fixture (tests/fixtures/make-fixtures.mjs).
    expect(recognised).toContain('OMNITOOL OCR TEST');
    // The op's own page-header format (matches extract-text.op.ts's convention).
    expect(recognised).toContain('--- Page 1 of 1 ---');
    // A clean, large, high-contrast render must not trip the low-confidence
    // warning — this is as much a test of honesty as of recognition.
    expect(recognised).not.toContain('WARNING');
  });
});
