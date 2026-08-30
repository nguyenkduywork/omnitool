// tests/e2e/to-images.spec.ts — the pdf-to-images editor and its results.
//
// In e2e rather than the vitest browser project because the editor reads the
// real PDF with pdfjs to derive its page count and pixel dimensions, and the
// results assertions depend on the shell, the worker pipeline and the results
// tray all being wired together. Only the full app can show that.
//
// The results assertions here guard a specific past defect: the tray computed
// a size delta for EVERY output by comparing it against its source input. For
// a one-to-many tool that is meaningless — a 357 kB PDF becoming 40 PNGs made
// every card read "603% LARGER · 357 kB -> 2.5 MB", which is both alarming and
// arithmetically nonsense, since the 357 kB was never that page's "before".
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

/** The editor's live readout — the thing that answers "what will I get?". */
function summary(page: Page) {
  return page.locator('.tiu__summary');
}

function seg(page: Page, label: string) {
  return page.getByRole('group', { name: label });
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles([fixturePath('small.pdf')]);
  await page.locator('[data-tool="pdf-to-images"]').click();
  // small.pdf has 3 pages; wait for the PDF to have actually been read.
  await expect(summary(page)).toContainText('3 images', { timeout: 30_000 });
});

test.describe('pdf-to-images editor', () => {
  test('reports the real page count and output pixel size', async ({ page }) => {
    // Both numbers come from the document, not from the DPI value alone.
    await expect(summary(page)).toContainText('px each');
    await expect(summary(page)).toContainText('roughly');

    // Exact figures are exact; only the byte total is hedged.
    const text = (await summary(page).textContent()) ?? '';
    expect(text).toMatch(/\b3 images\b/);
    expect(text).toMatch(/\d+x\d+ px/);
  });

  test('shows JPEG quality only for JPEG, because PNG is lossless', async ({ page }) => {
    const quality = page.getByLabel('JPEG quality');
    await expect(quality).toBeHidden();

    await seg(page, 'Output format').getByRole('button', { name: 'JPEG' }).click();
    await expect(quality).toBeVisible();
    // A JPEG estimate must be smaller than the PNG one for the same pixels.
    await expect(summary(page)).toContainText('roughly');

    await seg(page, 'Output format').getByRole('button', { name: 'PNG' }).click();
    await expect(quality).toBeHidden();
  });

  test('resolution presets change the pixel readout and sync the DPI field', async ({ page }) => {
    const dpi = page.getByLabel('Resolution in DPI');
    const readout = async (): Promise<string> => (await summary(page).textContent()) ?? '';

    await seg(page, 'Resolution preset').getByRole('button', { name: 'Screen' }).click();
    await expect(dpi).toHaveValue('72');
    const screen = await readout();

    await seg(page, 'Resolution preset').getByRole('button', { name: 'Print' }).click();
    await expect(dpi).toHaveValue('300');
    const print = await readout();

    // 300 DPI must report larger pixel dimensions than 72 DPI.
    const px = (text: string): number => {
      const match = /(\d+)x(\d+) px/.exec(text);
      return match ? Number(match[1]) * Number(match[2]) : 0;
    };
    expect(px(print)).toBeGreaterThan(px(screen));
  });

  test('narrows the count for a page range and flags a bad one', async ({ page }) => {
    const pages = page.getByLabel('Pages to convert');

    await pages.fill('1-2');
    await expect(summary(page)).toContainText('2 images');
    await expect(pages).toHaveAttribute('aria-invalid', 'false');

    // Out of range for a 3-page document.
    await pages.fill('9-');
    await expect(pages).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.tiu__hint--error')).toBeVisible();

    await pages.fill('');
    await expect(summary(page)).toContainText('3 images');
    await expect(pages).toHaveAttribute('aria-invalid', 'false');
  });

  test('produces previewable images and no misleading size delta', async ({ page }) => {
    await seg(page, 'Resolution preset').getByRole('button', { name: 'Screen' }).click();
    await page.getByLabel('Pages to convert').fill('1-2');
    await expect(summary(page)).toContainText('2 images');

    await page.getByRole('button', { name: 'Run' }).click();

    const cards = page.locator('.card--output');
    await expect(cards).toHaveCount(2, { timeout: 30_000 });

    // A tool whose output is images must SHOW them, or the only way to check a
    // render is to download it and open it elsewhere.
    await expect(page.locator('.card__thumb img')).toHaveCount(2);
    const firstThumb = page.locator('.card__thumb img').first();
    await expect(firstThumb).toBeVisible();
    // A broken object URL still yields an <img>; naturalWidth proves it decoded.
    expect(await firstThumb.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(
      0,
    );

    // THE REGRESSION: one PDF became two images, so no card may claim a
    // percentage change against the whole PDF.
    const chips = (await page.locator('.card__meta .chip').allTextContents()).join(' | ');
    expect(chips).not.toMatch(/larger/i);
    expect(chips).not.toMatch(/smaller/i);
    expect(chips).not.toMatch(/%/);

    // The Download button must not be clipped by a long filename: it and the
    // name are flex siblings, and the button previously shrank to "Down…".
    const button = cards.first().getByRole('button', { name: 'Download' });
    const clipped = await button.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);
  });
});
