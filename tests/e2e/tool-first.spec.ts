// tests/e2e/tool-first.spec.ts — the SECOND entry door.
//
// Everything here starts from a cold landing screen with no file ever
// dropped, which the old app could not express at all: it filtered the tool
// list to nothing until a file arrived, so the one tool that needs no file
// was reachable only by supplying one it then ignored.
//
// Runs against the production build, same as golden.spec.ts and a11y.spec.ts
// (see playwright.config.ts's `webServer`) — a cold-start bug in the built,
// code-split bundle is exactly what the old hero-only landing could hide.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixturePath = (name: string): string => path.join(FIXTURES, name);

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
});

test('shows every tool before any file is dropped', async ({ page }) => {
  await expect(page.locator('.toolcard')).toHaveCount(29);
  await expect(page.locator('.toolcard[data-tool="qr-generate"]')).toBeVisible();
});

test('generates a QR code without a file ever being dropped', async ({ page }) => {
  await page.locator('.toolcard[data-tool="qr-generate"]').click();

  // select() only hands focus to Run once the option panel — including the
  // async encoder probe for the format select — has actually mounted; the
  // same race-free "ready" signal the golden flows wait on.
  const run = page.getByRole('button', { name: 'Run' });
  await expect(run).toBeFocused({ timeout: 15_000 });
  await expect(run).toBeEnabled();

  await page.getByLabel('Text or URL').fill('https://example.com');
  await run.click();

  // A single output -> one per-card "Download" button (same pattern as the
  // golden PDF-merge flow) — Run itself only starts the job; the actual
  // browser download happens on THIS click, in `core/fs.ts`'s single-file
  // path (src/ui/results.ts's `save` handler).
  const downloadButton = page.getByRole('button', { name: 'Download' });
  await expect(downloadButton).toBeVisible({ timeout: 30_000 });

  const [file] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);
  expect(file.suggestedFilename()).toMatch(/\.png$/);
});

test('asks for what a file tool needs instead of failing', async ({ page }) => {
  await page.locator('.toolcard[data-tool="pdf-merge"]').click();

  // The reason IS the button label — never a dead disabled control.
  const run = page.getByRole('button', { name: /Needs at least 2 files/ });
  await expect(run).toBeDisabled({ timeout: 15_000 });

  await page
    .locator('input[type=file]')
    .setInputFiles([fixturePath('small.pdf'), fixturePath('small.pdf')]);

  await expect(page.getByRole('button', { name: 'Run' })).toBeEnabled({ timeout: 15_000 });
});

test('explains a tool blocked only on count, rather than hiding it', async ({ page }) => {
  await page
    .locator('input[type=file]')
    .setInputFiles([fixturePath('small.pdf'), fixturePath('small.pdf')]);

  const organize = page.locator('[data-tool="pdf-organize"]');
  await expect(organize).toBeVisible({ timeout: 15_000 });
  await expect(organize).toContainText('Needs exactly 1 file');
  await expect(organize).toBeDisabled();
});
