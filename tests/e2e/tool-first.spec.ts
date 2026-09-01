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

// Task 13: the router (ui/router.ts) wired into the shell — every tool gets
// its own bookmarkable URL, and Back/Forward move between a tool and the
// catalogue instead of leaving the app. FILES ARE NEVER IN THE URL (see
// router.ts's own header comment), which the second test below is what
// actually proves, not just asserts in a comment.

test('gives a tool its own URL, and keeps back inside the app', async ({ page }) => {
  await page.locator('.toolcard[data-tool="qr-generate"]').click();
  await expect(page).toHaveURL(/#\/qr-generate$/);

  await page.goBack();
  await expect(page).toHaveURL(/#\/$|\/$/);
  await expect(page.locator('.toolcard')).toHaveCount(29);

  await page.goForward();
  await expect(page.locator('.toolcard[data-tool="qr-generate"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

// Privacy test gap flagged by the final whole-branch review: both URL
// assertions above run COLD (qr-generate never has a file loaded at all), so
// they would still pass even if `router.navigate` started appending file
// names to the hash — the exact thing router.ts's own header comment
// promises never happens ("FILES ARE NEVER IN THE URL. They stay in
// memory."). This is the one assertion that actually reads the URL with
// files loaded.
test('never puts a filename in the URL, even with files loaded', async ({ page }) => {
  await page
    .locator('input[type=file]')
    .setInputFiles([fixturePath('small.pdf'), fixturePath('small.pdf')]);

  await page.locator('.toolcard[data-tool="pdf-merge"]').click();
  await expect(page).toHaveURL(/#\/pdf-merge$/);

  const url = page.url();
  expect(url).not.toContain('small.pdf');
  expect(url).not.toContain('small');
  expect(url).not.toContain('.pdf');
});

test('opens a deep link straight into the tool, with no files attached', async ({ page }) => {
  // The registry's own id is `pdf-merge` (see src/core/registry.pdf.ts) —
  // NOT `merge-pdfs`, which is only ever used as a placeholder in
  // router.test.ts's format-agnostic parse/serialise checks.
  //
  // `beforeEach` above has already loaded `/` before this test body runs, so
  // a bare `page.goto('/#/pdf-merge')` here is a HASH-ONLY, same-document
  // navigation — a browser never re-requests the document for a URL that
  // differs only in its hash. That would exercise `router`'s `hashchange`
  // LISTENER, which stays live regardless of `.start()`, not the thing this
  // test exists to cover: `.start()` itself, reading the hash a real,
  // freshly opened tab already carries on its very first paint. The
  // `page.reload()` forces that genuine fresh load (a reload is a real
  // network re-request; the hash survives it, same as in a real browser).
  // Without it this test passed even with `router.start()` never called at
  // all — checked by hand while writing it, not left on faith.
  await page.goto('/#/pdf-merge');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Merge PDFs' })).toBeVisible();
  await expect(page.locator('.tray__item')).toHaveCount(0);
});

test('falls back to the catalogue for an unknown tool id', async ({ page }) => {
  // Same reasoning as the deep-link test above: force a genuine fresh load
  // (router.start(), not the hashchange listener) so this actually covers
  // the id-validation `router.start()` runs on boot, not just the listener
  // that stays live either way.
  await page.goto('/#/not-a-real-tool');
  await page.reload();
  await expect(page.locator('.toolcard')).toHaveCount(29);
});
