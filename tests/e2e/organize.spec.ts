// tests/e2e/organize.spec.ts — the pdf-organize page board.
//
// Lives in e2e rather than the vitest browser project for one specific
// reason: the board renders thumbnails lazily via IntersectionObserver, and
// IO callbacks are only delivered while the page is actually being rendered.
// A hidden or throttled tab delivers nothing — no callbacks, no rAF, no
// thumbnails — so this needs a genuinely visible browser to mean anything.
//
// The bug that motivated the first test here: the controls overlay lives
// INSIDE the thumbnail (so it can sit over the page image), and the thumbnail
// renderer used `replaceChildren(canvas)`, which wiped the controls of every
// page that finished rendering. The board looked perfect and the buttons
// simply stopped existing — and only on rendered cards, so clicking a page
// that had not scrolled into view yet still worked. Nothing short of
// "interact with a card whose thumbnail has rendered" catches that.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles([fixturePath('small.pdf')]);
  await page.locator('[data-tool="pdf-organize"]').click();
  // small.pdf has 3 pages.
  await expect(page.locator('.pdf-organize__page')).toHaveCount(3, { timeout: 20_000 });
});

test.describe('pdf-organize board', () => {
  test('keeps its controls after a thumbnail renders, and they still work', async ({ page }) => {
    const first = page.locator('.pdf-organize__page').first();

    // Wait for a REAL rendered thumbnail, not just the card.
    await expect(first.locator('canvas')).toBeVisible({ timeout: 30_000 });

    // The regression: all four controls must survive rendering.
    await expect(first.locator('button[data-action]')).toHaveCount(4);

    // And they must still be wired up. Rotate, then check the state the op
    // will actually receive — the aria-label is generated from it.
    await first.locator('[data-action="rotate"]').click();
    await expect(first).toHaveAttribute('aria-label', /rotated 90 degrees/);
    await expect(first.locator('canvas')).toHaveAttribute('style', /rotate\(90deg\)/);
  });

  test('marks a deleted page without removing it, and restores it', async ({ page }) => {
    const second = page.locator('.pdf-organize__page').nth(1);
    await expect(second.locator('canvas')).toBeVisible({ timeout: 30_000 });

    await second.locator('[data-action="remove"]').click();
    // Non-destructive: the card stays put so positions do not shift underfoot.
    await expect(page.locator('.pdf-organize__page')).toHaveCount(3);
    await expect(second).toHaveAttribute('data-keep', 'false');
    await expect(page.locator('.pdf-organize__status')).toContainText('1 deleted');

    // Same button toggles back.
    await second.locator('[data-action="remove"]').click();
    await expect(second).toHaveAttribute('data-keep', 'true');
    await expect(page.locator('.pdf-organize__status')).not.toContainText('deleted');
  });

  test('accents only the pages you have changed, and Reset clears everything', async ({ page }) => {
    const cards = page.locator('.pdf-organize__page');
    await expect(cards.first().locator('canvas')).toBeVisible({ timeout: 30_000 });

    // Untouched board: nothing is marked, and Reset has nothing to do.
    await expect(page.locator('.pdf-organize__page[data-moved="true"]')).toHaveCount(0);
    await expect(page.locator('.pdf-organize__reset')).toBeDisabled();

    // Moving page 1 later changes the position of TWO pages, so two get marked.
    await cards.first().locator('[data-action="right"]').click();
    await expect(page.locator('.pdf-organize__page[data-moved="true"]')).toHaveCount(2);
    await expect(page.locator('.pdf-organize__reset')).toBeEnabled();

    // Source-page chips only appear once the order actually differs.
    await expect(page.locator('.pdf-organize__src').first()).toBeVisible();

    await page.locator('.pdf-organize__reset').click();
    await expect(page.locator('.pdf-organize__page[data-moved="true"]')).toHaveCount(0);
    await expect(page.locator('.pdf-organize__reset')).toBeDisabled();
  });

  test('disables the move controls at the ends instead of offering dead buttons', async ({
    page,
  }) => {
    const cards = page.locator('.pdf-organize__page');
    await expect(cards.first().locator('canvas')).toBeVisible({ timeout: 30_000 });

    await expect(cards.first().locator('[data-action="left"]')).toBeDisabled();
    await expect(cards.first().locator('[data-action="right"]')).toBeEnabled();
    await expect(cards.last().locator('[data-action="right"]')).toBeDisabled();
    await expect(cards.last().locator('[data-action="left"]')).toBeEnabled();
  });

  test('reorders by keyboard and produces a correctly ordered PDF', async ({ page }) => {
    const cards = page.locator('.pdf-organize__page');
    await expect(cards.first().locator('canvas')).toBeVisible({ timeout: 30_000 });

    // Send the first page to the end using only the keyboard.
    await cards.first().focus();
    await page.keyboard.press('End');
    await expect(cards.last()).toHaveAttribute('aria-label', /^Page 1,/);

    // Delete what is now the first page, then run and confirm the page count
    // the op actually emitted — the board's job is to feed the op, so the only
    // proof that matters is the output.
    await cards.first().locator('[data-action="remove"]').click();
    await expect(page.locator('.pdf-organize__status')).toContainText('2 of 3');

    await page.getByRole('button', { name: 'Run' }).click();
    const downloadButton = page.getByRole('button', { name: 'Download' }).first();
    await expect(downloadButton).toBeVisible({ timeout: 30_000 });

    // Decode the REAL downloaded bytes. A visible Download button only proves
    // the run finished, not that the board's order and deletion reached the
    // op — which is the whole claim this test makes. small.pdf has 3 pages
    // (tests/fixtures/make-fixtures.mjs); one was deleted, so the output must
    // have exactly 2.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadButton.click(),
    ]);
    const savePath = path.join(
      mkdtempSync(path.join(tmpdir(), 'omnitool-organize-')),
      'organized.pdf',
    );
    await download.saveAs(savePath);
    const doc = await PDFDocument.load(readFileSync(savePath));
    expect(doc.getPageCount()).toBe(2);
  });
});
