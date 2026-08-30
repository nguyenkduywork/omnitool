// tests/e2e/results.spec.ts — behaviour of the shared results tray.
//
// This guards a rule that belongs to the tray rather than to any one tool, and
// that is easy to reintroduce by accident because a wrong size chip still looks
// like a working feature.
//
// The rule: a size delta is only shown when the output is the same KIND of
// thing as the input. Hashing a PDF produces a checksum, not a smaller PDF, so
// "100% smaller · 1.3 MB -> 64 B" would invite reading a category error as a
// compression win. Shrinking a PDF or re-encoding an image IS a size story and
// keeps its delta.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
});

test.describe('results tray', () => {
  test('offers no size comparison when the output is a different kind of thing', async ({
    page,
  }) => {
    // One PDF in, one text file out: a 1:1 mapping, so the fan-out rule does
    // not apply and only the same-kind rule can suppress the delta. That is
    // exactly what this test needs to isolate.
    await page.locator('input[type="file"]').setInputFiles([fixturePath('small.pdf')]);
    await page.locator('[data-tool="hash"]').click();
    await page.getByRole('button', { name: 'Run' }).click();

    const card = page.locator('.card--output');
    await expect(card).toHaveCount(1, { timeout: 30_000 });

    const chips = (await page.locator('.card__meta .chip').allTextContents()).join(' | ');
    // PDF -> checksum is not a size story. No percentage, in either direction.
    expect(chips).not.toMatch(/%/);
    expect(chips).not.toMatch(/smaller|larger/i);
    // A plain byte count is still shown — suppressing the delta must not
    // suppress the size entirely.
    expect(chips).toMatch(/\d/);

    // The run total belongs on the summary line, so the number is not lost.
    await expect(page.locator('.results__summary')).toContainText(/ready ·/);
  });

  test('keeps the delta when the output IS the same kind of thing', async ({ page }) => {
    // The other half of the rule, so a future change cannot satisfy the test
    // above by simply deleting the delta feature outright. Image in, image
    // out, 1:1 — the comparison is the whole point of Compress image.
    await page.locator('input[type="file"]').setInputFiles([fixturePath('a.jpg')]);
    await page.locator('[data-tool="image-compress"]').click();
    await page.getByRole('button', { name: 'Run' }).click();

    await expect(page.locator('.card--output')).toHaveCount(1, { timeout: 30_000 });
    const chips = (await page.locator('.card__meta .chip').allTextContents()).join(' | ');
    // Either a percentage change or an explicit "same size" — but a real
    // comparison against the original, not just a byte count.
    expect(chips).toMatch(/%\s(smaller|larger)|same size/i);
  });
});
