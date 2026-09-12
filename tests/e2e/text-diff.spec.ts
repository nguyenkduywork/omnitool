import { expect, test } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OLD = 'export function total(items) {\n  return items.length;\n}\n';
const NEW = 'export function total(items) {\n  return items.length * 2;\n}\n';
const source = (name: string, text: string) => ({ name, mimeType: '', buffer: Buffer.from(text, 'utf8') });

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
});

test('offers Compare text for source files and previews before export', async ({ page }) => {
  await page.locator('input[type="file"]').first().setInputFiles([source('old.ts', OLD), source('new.ts', NEW)]);
  await expect(page.locator('.tray')).toContainText('Source code');
  await page.locator('[data-tool="text-diff"]').click();
  await expect(page.locator('.tdw[data-ready="true"]')).toBeVisible();
  await expect(page.locator('.tdw__stats')).toContainText('1 modified');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('.tdw__mark').first()).toHaveText(' * 2');
  await expect(page.locator('.tdw__identities')).toContainText('Original: old.ts');
  await expect(page.locator('.tdw__identities')).toContainText('Revised: new.ts');
});

test('exports a report and an exact patch from the accepted comparison', async ({ page, browser }, testInfo) => {
  await page.locator('input[type="file"]').first().setInputFiles([source('old.ts', OLD), source('new.ts', NEW)]);
  await page.locator('[data-tool="text-diff"]').click();
  await expect(page.locator('.tdw__stats')).toContainText('1 modified');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Download report' }).click();
  await expect(page.locator('.card--output')).toContainText('old-vs-new.html', { timeout: 30_000 });
  const outputCards = page.locator('.card--output');
  const root = await mkdtemp(join(tmpdir(), 'omnitool-text-diff-download-'));
  const resolvedRoot = resolve(root);
  try {
    const [reportDownload] = await Promise.all([
      page.waitForEvent('download'),
      outputCards.filter({ hasText: 'old-vs-new.html' }).getByRole('button', { name: 'Download' }).click(),
    ]);
    const reportPath = join(root, 'report.html');
    await reportDownload.saveAs(reportPath);
    const report = await readFile(reportPath, 'utf8');
    expect(report).toContain('<meta name="viewport"');
    expect(report).not.toContain('<script');
    expect(report).toContain('word detail');
    const reportContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 720 } });
    await reportContext.route(/^https?:\/\//, (route) => route.abort());
    try {
      const reportPage = await reportContext.newPage();
      await reportPage.goto(`file:///${reportPath.replace(/\\/g, '/')}`);
      await expect(reportPage.locator('script')).toHaveCount(0);
      await expect(reportPage.locator('body')).toContainText('return items.length');
      expect(await reportPage.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
      await reportPage.screenshot({ path: testInfo.outputPath('report-desktop.png'), fullPage: true });
      await reportPage.emulateMedia({ media: 'print' });
      await expect(reportPage.locator('body')).toContainText('return items.length');
      expect(await reportPage.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
      await reportPage.screenshot({ path: testInfo.outputPath('report-print.png'), fullPage: true });
      await reportPage.emulateMedia({ media: 'screen' });
      await reportPage.setViewportSize({ width: 320, height: 720 });
      expect(await reportPage.locator('body').evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
      await reportPage.screenshot({ path: testInfo.outputPath('report-320px.png'), fullPage: true });
    } finally {
      await reportContext.close();
    }
    await page.getByRole('button', { name: 'Download patch' }).click();
    await expect(outputCards).toContainText('old-vs-new.diff', { timeout: 30_000 });
    await expect(outputCards.locator('.card__text')).toContainText('--- a/old.ts');
    const [patchDownload] = await Promise.all([
      page.waitForEvent('download'),
      outputCards.filter({ hasText: 'old-vs-new.diff' }).getByRole('button', { name: 'Download' }).click(),
    ]);
    const patchPath = join(root, 'change.diff');
    await patchDownload.saveAs(patchPath);
    expect(await readFile(patchPath, 'utf8')).toContain('--- a/old.ts');
  } finally {
    if (resolve(root) === resolvedRoot) await rm(resolvedRoot, { recursive: true, force: true });
  }
});

test('opens from the catalog with two independent text inputs', async ({ page }) => {
  await page.locator('[data-tool="text-diff"]').click();
  await expect(page.locator('.tdw__textarea')).toHaveCount(2);
  await page.locator('.tdw__textarea').nth(0).fill(OLD);
  await page.locator('.tdw__textarea').nth(1).fill(NEW);
  await expect(page.locator('.tdw__stats')).toContainText('1 modified');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await expect(page.locator('.tdw__mark').first()).toHaveText(' * 2');
});

test('one tray file seeds editable Original without supplying Revised', async ({ page }) => {
  await page.locator('input[type="file"]').first().setInputFiles([source('old.ts', OLD)]);
  await page.locator('[data-tool="text-diff"]').click();
  await expect(page.locator('.tdw__textarea').nth(0)).toHaveValue(OLD);
  await expect(page.locator('.tdw__textarea').nth(1)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Review changes' })).toBeDisabled();
  await page.locator('.tdw__textarea').nth(1).fill(NEW);
  await expect(page.locator('.tdw__stats')).toContainText('1 modified');
});

test('tray remains independent, and stale editing immediately blocks export', async ({ page }) => {
  await page.locator('input[type="file"]').first().setInputFiles([source('old.ts', OLD), source('new.ts', NEW)]);
  await page.locator('[data-tool="text-diff"]').click();
  await expect(page.locator('.tdw__stats')).toContainText('1 modified');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Download report' })).toBeEnabled();
  await page.getByRole('button', { name: 'Inputs', exact: true }).click();
  await page.locator('.tdw__textarea').nth(1).fill(NEW + 'extra\n');
  await expect(page.locator('.tdw__export button').first()).toBeDisabled();
  await expect(page.locator('.tray')).toContainText('old.ts');
});
