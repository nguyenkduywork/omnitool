// tests/e2e/text-diff.spec.ts — comparing two source files, in the real app.
//
// The unit tests cover the engine and the view in isolation. What only an
// end-to-end run can show is the seam between them: that dropping two .ts files
// OFFERS this tool at all (which depends on format.ts recognising source code,
// not just on the registry), that the editor mounts inside the work zone for a
// two-file tool, and that Run turns what is on screen into a downloadable
// report.
//
// The files are built in memory rather than checked in: their content is the
// point of the test, and a fixture would put it a file away from the assertions.

import { expect, test } from '@playwright/test';

const OLD = ['export function total(items) {', '  return items.length;', '}', ''].join('\n');
const NEW = ['export function total(items) {', '  return items.length * 2;', '}', ''].join('\n');

function source(name: string, text: string): { name: string; mimeType: string; buffer: Buffer } {
  // No mime type from the OS: a .ts file has no signature, so this is exactly
  // the case where the app has to work the type out from the name.
  return { name, mimeType: '', buffer: Buffer.from(text, 'utf8') };
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
});

test('offers Compare text for two source files, and shows what changed', async ({ page }) => {
  await page
    .locator('input[type="file"]')
    .setInputFiles([source('old.ts', OLD), source('new.ts', NEW)]);

  // Recognised as source code rather than "Unknown file" — the thing that
  // makes the tool applicable in the first place.
  await expect(page.locator('.tray')).toContainText('Source code');

  const card = page.locator('[data-tool="text-diff"]');
  await expect(card).toBeVisible();
  await expect(card).not.toHaveClass(/toolcard--blocked/);
  await card.click();

  // The comparison appears without anyone pressing Run.
  const marks = page.locator('.tdiff__mark');
  await expect(marks).toHaveCount(1, { timeout: 15_000 });
  await expect(marks.first()).toHaveText('* 2');
  await expect(page.locator('.tdiff__stats')).toContainText('1 changed');
  await expect(page.locator('.tdiff__files')).toHaveText('old.ts → new.ts');
});

test('Run turns the comparison on screen into a report you can keep', async ({ page }) => {
  await page
    .locator('input[type="file"]')
    .setInputFiles([source('old.ts', OLD), source('new.ts', NEW)]);
  await page.locator('[data-tool="text-diff"]').click();
  await expect(page.locator('.tdiff__grid')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Run' }).click();

  const output = page.locator('.card--output');
  await expect(output).toHaveCount(1, { timeout: 30_000 });
  await expect(output).toContainText('old-vs-new.html');
  // The report carries the change, not just a filename — and carries it the
  // way the view showed it, with the changed run marked inside the line.
  await expect(output.locator('.card__text')).toContainText('return items.length');
  await expect(output.locator('.card__text')).toContainText(/<mark>[^<]*\* 2<\/mark>/);
});

test('exports a patch file when the export control asks for one', async ({ page }) => {
  await page
    .locator('input[type="file"]')
    .setInputFiles([source('old.ts', OLD), source('new.ts', NEW)]);
  await page.locator('[data-tool="text-diff"]').click();
  await expect(page.locator('.tdiff__grid')).toBeVisible({ timeout: 15_000 });

  await page.locator('.tdiff__select').selectOption('unified');
  await page.getByRole('button', { name: 'Run' }).click();

  const output = page.locator('.card--output');
  await expect(output).toHaveCount(1, { timeout: 30_000 });
  await expect(output).toContainText('old-vs-new.diff');
  await expect(output.locator('.card__text')).toContainText('--- a/old.ts');
  await expect(output.locator('.card__text')).toContainText('+  return items.length * 2;');
});

test('a third file takes the tool away, and says why', async ({ page }) => {
  await page
    .locator('input[type="file"]')
    .setInputFiles([source('old.ts', OLD), source('new.ts', NEW), source('third.ts', OLD)]);

  const card = page.locator('[data-tool="text-diff"]');
  await expect(card).toHaveClass(/toolcard--blocked/);
  await expect(card).toContainText('exactly 2 files');
});

test('side by side stays inside its column, and shows both sides at once', async ({ page }) => {
  // The failure this guards against is not subtle once seen and invisible
  // until then: the comparison grid's own width used to propagate up through
  // the work zone and give the whole PAGE a horizontal scrollbar, leaving the
  // added side parked off-screen. See `contain: inline-size` in the editor's
  // stylesheet.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .locator('input[type="file"]')
    .setInputFiles([source('old.ts', OLD), source('new.ts', NEW)]);
  await page.locator('[data-tool="text-diff"]').click();
  await expect(page.locator('.tdiff__grid')).toBeVisible({ timeout: 15_000 });

  await page.locator('.tdiff__segbtn', { hasText: 'Side by side' }).click();
  await expect(page.locator('.tdiff__grid--split')).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  // Both halves of the rewritten line are on screen, not one behind a scroll.
  const row = page.locator('.tdiff__row--replace').first();
  await expect(row.locator('.tdiff__code--a')).toBeInViewport();
  await expect(row.locator('.tdiff__code--b')).toBeInViewport();
});
