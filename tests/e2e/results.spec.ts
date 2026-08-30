// tests/e2e/results.spec.ts — behaviour of the shared results tray.
//
// These guard rules that belong to the tray rather than to any one tool, and
// that are easy to reintroduce by accident because a wrong size chip still
// looks like a working feature.
//
// The rule under test: a size delta is only shown when the output is the same
// KIND of thing as the input. Extracting a PDF's text layer produced
// "100% smaller · 1.3 MB -> 49 B" in green — reading a category error as a
// compression win. pdf-extract-text is not a compressor; it produces a
// different kind of artefact, so there is nothing to compare.
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
    await page.locator('input[type="file"]').setInputFiles([fixturePath('small.pdf')]);
    await page.locator('[data-tool="pdf-extract-text"]').click();
    await page.getByRole('button', { name: 'Run' }).click();

    // small.pdf DOES have a text layer, so this succeeds and produces a card.
    const card = page.locator('.card--output');
    await expect(card).toHaveCount(1, { timeout: 30_000 });

    const chips = (await page.locator('.card__meta .chip').allTextContents()).join(' | ');
    // PDF -> text is not a size story. No percentage, in either direction.
    expect(chips).not.toMatch(/%/);
    expect(chips).not.toMatch(/smaller|larger/i);
    // A plain byte count is still shown — suppressing the delta must not
    // suppress the size entirely.
    expect(chips).toMatch(/\d/);

    // The run total belongs on the summary line, so the number is not lost.
    await expect(page.locator('.results__summary')).toContainText(/ready ·/);
  });

  test('a scan-only PDF fails loudly rather than yielding an empty "success"', async ({ page }) => {
    // Generated in Node and handed to the file input, rather than committed as
    // a fixture: a page carrying an image and no text is exactly what a scanner
    // or a phone camera produces, and it is the input that made "Extract text"
    // look broken.
    const { PDFDocument } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const png = await doc.embedPng(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z/CfgQmEGGEEAwMDAA5+Av7x6vGxAAAAAElFTkSuQmCC',
        'base64',
      ),
    );
    doc.addPage([200, 200]).drawImage(png, { x: 0, y: 0, width: 200, height: 200 });
    const bytes = await doc.save();

    await page.locator('input[type="file"]').setInputFiles({
      name: 'scan.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(bytes),
    });
    await page.locator('[data-tool="pdf-extract-text"]').click();
    await page.getByRole('button', { name: 'Run' }).click();

    // No output card at all — the old behaviour wrote a 49-byte file and
    // reported success, which is the bug.
    await expect(page.locator('.card__why')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('.card--output')).toHaveCount(0);
    await expect(page.locator('.results__summary')).toContainText('could not finish');

    // The message must be actionable, and must not contradict the generic
    // next-step line beneath it (that line used to tell people to re-export a
    // file that was never malformed).
    const why = (await page.locator('.card__why').textContent()) ?? '';
    expect(why).toMatch(/no text layer/i);
    expect(why).toMatch(/OCR/);
    const hint = (await page.locator('.card__hint').textContent()) ?? '';
    expect(hint).not.toMatch(/not the format its contents claim\. Re-export/);
  });
});
