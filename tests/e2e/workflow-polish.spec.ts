import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixture = (name: string): string => path.join(fixtures, name);

async function pick(page: Page, id: string): Promise<void> {
  // Real navigation supports the mobile catalogue's folded state too.
  await page.getByRole('link', { name: 'omnitool', exact: true }).click();
  await page.locator(`[data-tool="${id}"]`).click();
  await expect(page.locator('.run .btn--primary')).toBeFocused();
}

async function run(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(page.locator('#stage')).toHaveAttribute('data-phase', 'results');
}

async function downloadCard(page: Page, index = 0): Promise<Buffer> {
  const pending = page.waitForEvent('download');
  await page.locator('.card--output').nth(index).getByRole('button', { name: 'Download', exact: true }).click();
  const downloaded = await pending;
  return readFile((await downloaded.path())!);
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
});

test('a common search phrase opens the intended tool by keyboard', async ({ page }) => {
  await page.getByRole('button', { name: 'Search tools (Ctrl K)' }).click();
  const search = page.getByRole('combobox', { name: 'Search tools by name or description' });
  await search.fill('compress pdf');
  await expect(page.getByRole('option').first()).toContainText('Shrink PDF');
  await search.press('Enter');
  await expect(page.getByRole('region', { name: 'Shrink PDF', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('resize modes, independent settings, reset and session lifetime agree', async ({ page }) => {
  await pick(page, 'image-resize');
  await page.getByLabel('Width (px)', { exact: true }).fill('640');
  await page.getByLabel('Resize by', { exact: true }).selectOption('percent');
  await expect(page.getByLabel('Width (px)', { exact: true })).toBeHidden();
  await expect(page.getByLabel('Lock aspect ratio', { exact: true })).toBeHidden();
  await expect(page.getByLabel('Percent', { exact: true })).toBeVisible();
  await pick(page, 'image-convert');
  await page.getByLabel('Format', { exact: true }).selectOption('jpeg');
  await pick(page, 'image-resize');
  await expect(page.getByLabel('Resize by', { exact: true })).toHaveValue('percent');
  await page.getByLabel('Resize by', { exact: true }).selectOption('dimensions');
  await expect(page.getByLabel('Width (px)', { exact: true })).toHaveValue('640');
  const modeRow = page.locator('.opt[data-key="mode"]');
  const label = (await modeRow.locator('.opt__label').boundingBox())!;
  const control = (await modeRow.locator('.opt__control').boundingBox())!;
  expect(control.y).toBeGreaterThanOrEqual(label.y + label.height);
  await page.screenshot({ path: test.info().outputPath('resize-settings-desktop.png') });
  await page.getByRole('button', { name: 'Reset tool settings' }).click();
  await expect(page.getByLabel('Width (px)', { exact: true })).toHaveValue('1920');
  await expect(page.getByRole('button', { name: 'Reset tool settings' })).toBeFocused();
  await pick(page, 'image-convert');
  await expect(page.getByLabel('Format', { exact: true })).toHaveValue('jpeg');
  await page.reload();
  await expect(page.getByLabel('Format', { exact: true })).toHaveValue('webp');
});

test('resize readout matches mixed-batch output, preserves small files, and keeps presets between tools', async ({ page }) => {
  const landscape = await sharp({ create: { width: 2400, height: 1600, channels: 3, background: '#387e9c' } }).png().toBuffer();
  const portrait = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#d4a574' } })
    .jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const small = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#729979' } }).png().toBuffer();
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'landscape.png', mimeType: 'image/png', buffer: landscape },
    { name: 'portrait.jpg', mimeType: 'image/jpeg', buffer: portrait },
    { name: 'small.png', mimeType: 'image/png', buffer: small },
  ]);
  await pick(page, 'image-resize');
  const presets = page.getByRole('group', { name: 'Resize presets', exact: true });
  const sizes = page.locator('.resize-preview__value');
  const keepSmall = page.getByLabel('Don’t enlarge smaller images', { exact: true });
  await presets.getByRole('button', { name: '1920 px', exact: true }).click();
  await expect(sizes).toHaveText([
    '2,400 × 1,600 → 1,920 × 1,280 px', '1,200 × 2,400 → 960 × 1,920 px', '640 × 480 → 1,920 × 1,440 px',
  ]);
  await keepSmall.check();
  await expect(sizes.nth(2)).toHaveText('640 × 480 → 640 × 480 px');
  await expect(page.locator('.resize-preview__row').nth(2)).toContainText('Original file kept');
  await presets.getByRole('button', { name: '50%', exact: true }).click();
  await expect(page.getByLabel('Percent', { exact: true })).toHaveValue('50');
  await expect(sizes.first()).toHaveText('2,400 × 1,600 → 1,200 × 800 px');
  await presets.getByRole('button', { name: '1080 px', exact: true }).click();
  await pick(page, 'image-convert');
  await pick(page, 'image-resize');
  await expect(page.getByLabel('Width (px)', { exact: true })).toHaveValue('1080');
  await expect(page.getByLabel('Height (px)', { exact: true })).toHaveValue('1080');
  await expect(keepSmall).toBeChecked();
  await expect(presets.getByRole('button', { name: '1080 px', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Remove landscape.png', exact: true }).click();
  await expect(sizes).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo file removal', exact: true }).click();
  await expect(sizes).toHaveText([
    '2,400 × 1,600 → 1,080 × 720 px', '1,200 × 2,400 → 540 × 1,080 px', '640 × 480 → 640 × 480 px',
  ]);
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.getByRole('region', { name: 'Resize image', exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('resize-readout-desktop.png') });
  await page.setViewportSize({ width: 390, height: 1000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.getByRole('region', { name: 'Resize image', exact: true }).screenshot({ path: test.info().outputPath('resize-readout-mobile.png') });
  await run(page);
  const expected = [[1080, 720], [540, 1080], [640, 480]];
  for (let index = 0; index < expected.length; index += 1) {
    const bytes = await downloadCard(page, index);
    const metadata = await sharp(bytes).metadata();
    expect([metadata.width, metadata.height]).toEqual(expected[index]);
    if (index === 2) expect(bytes).toEqual(small);
  }
});

test('fresh file presets still apply and explicit edits override them until reset', async ({ page }) => {
  const picker = page.locator('input[type="file"]');
  await picker.setInputFiles(fixture('a.png'));
  await pick(page, 'zip-create');
  await expect(page.getByLabel('Archive name', { exact: true })).toHaveValue('a');
  await page.getByRole('button', { name: 'Remove all files' }).click();
  await picker.setInputFiles(fixture('b.png'));
  await pick(page, 'zip-create');
  await expect(page.getByLabel('Archive name', { exact: true })).toHaveValue('b');
  await page.getByLabel('Archive name', { exact: true }).fill('my-images');
  await pick(page, 'tar-create');
  await pick(page, 'zip-create');
  await expect(page.getByLabel('Archive name', { exact: true })).toHaveValue('my-images');
  await expect(page.locator('[data-key="name"] .opt__because')).toHaveCount(0);
  await page.getByRole('button', { name: 'Reset tool settings' }).click();
  await expect(page.getByLabel('Archive name', { exact: true })).toHaveValue('b');
});

test('reuses all resized bytes in order, waits for Run, and Undo restores the original bytes', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles([fixture('b.png'), fixture('a.png')]);
  await pick(page, 'image-resize');
  await page.getByLabel('Resize by', { exact: true }).selectOption('percent');
  await run(page);
  await expect(page.locator('.card--output')).toHaveCount(2);
  const resized = [await downloadCard(page, 0), await downloadCard(page, 1)];
  await page.getByRole('button', { name: 'Use all results (2)…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Use 2 results', exact: true });
  await expect(dialog).toContainText('Undo restores them');
  await expect(dialog.getByRole('option', { name: /^Crop image/ })).toHaveCount(0);
  await expect(dialog.getByRole('option', { name: /^Generate QR/ })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('result-chooser-desktop.png') });
  await dialog.getByRole('combobox').fill('create zip');
  await dialog.getByRole('combobox').press('Enter');
  await expect(page.getByRole('region', { name: 'Create ZIP', exact: true })).toBeVisible();
  await expect(page.locator('.results__summary')).toContainText('Resize image');
  await expect(page.locator('.tray__name')).toHaveText(['b.png', 'a.png']);
  await expect(page.locator('.reuse-notice')).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: test.info().outputPath('reuse-ready-desktop.png') });
  await run(page);
  const zipped = unzipSync(await downloadCard(page));
  expect(Object.keys(zipped)).toEqual(['b.png', 'a.png']);
  expect(Buffer.from(zipped['b.png']!)).toEqual(resized[0]);
  expect(Buffer.from(zipped['a.png']!)).toEqual(resized[1]);
  await page.getByRole('button', { name: 'Undo result reuse', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Resize image', exact: true })).toBeVisible();
  await expect(page.locator('.tray__name')).toHaveText(['b.png', 'a.png']);
  await expect(page.locator('.reuse-notice')).toBeHidden();
  await pick(page, 'zip-create');
  await run(page);
  const restored = unzipSync(await downloadCard(page));
  expect(Buffer.from(restored['b.png']!)).toEqual(await readFile(fixture('b.png')));
  expect(Buffer.from(restored['a.png']!)).toEqual(await readFile(fixture('a.png')));
});

test('partial results can be reused; cancelling is inert and new intake clears Undo', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'a.png', mimeType: 'image/png', buffer: await readFile(fixture('a.png')) },
    { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a real image') },
  ]);
  await pick(page, 'image-convert');
  await run(page);
  await expect(page.locator('.results')).toHaveAttribute('data-state', 'partial');
  await expect(page.locator('.card--output')).toHaveCount(1);
  const reuse = page.getByRole('button', { name: 'Use this result…', exact: true });
  await reuse.click();
  await page.getByRole('dialog').getByRole('combobox').press('Escape');
  await expect(reuse).toBeFocused();
  await expect(page.locator('.tray__name')).toHaveText(['a.png', 'broken.png']);
  await reuse.click();
  const search = page.getByRole('dialog').getByRole('combobox');
  await search.fill('create zip');
  await search.press('Enter');
  await expect(page.locator('.tray__name')).toHaveText(['a.webp']);
  await expect(page.locator('.reuse-notice')).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles(fixture('b.png'));
  await expect(page.locator('.tray__name')).toHaveText(['a.webp', 'b.png']);
  await expect(page.locator('.reuse-notice')).toBeHidden();
});

test('resize and the result chooser fit a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('input[type="file"]').setInputFiles(fixture('a.png'));
  await pick(page, 'image-resize');
  await page.getByLabel('Resize by', { exact: true }).selectOption('percent');
  await run(page);
  await page.getByRole('button', { name: 'Use this result…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Use this result', exact: true });
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const search = dialog.getByRole('combobox');
  await search.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Close command palette' })).toBeFocused();
  await dialog.getByRole('button', { name: 'Close command palette' }).press('Tab');
  await expect(search).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('result-chooser-mobile.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: test.info().outputPath('result-chooser-mobile-dark.png'), animations: 'disabled' });
});

test('arranges a batch naturally, keeps thumbnails, and undoes only the last order change', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles(await Promise.all([
    ['holiday-10.png', 'a.png'], ['holiday-2.png', 'b.png'], ['holiday-1.png', 'c.png'],
  ].map(async ([name, source]) => ({ name: name!, mimeType: 'image/png', buffer: await readFile(fixture(source!)) }))));
  const names = page.locator('.tray__name');
  const arrange = page.getByRole('combobox', { name: 'Arrange files', exact: true });
  const undo = page.getByRole('button', { name: 'Undo file ordering', exact: true });
  await expect(names).toHaveText(['holiday-10.png', 'holiday-2.png', 'holiday-1.png']);
  const thumbnails = await page.locator('.tray__img').evaluateAll((images) => images.map((img) => img.getAttribute('src')).sort());
  await expect(undo).toBeDisabled();
  await arrange.selectOption('name-asc');
  await expect(names).toHaveText(['holiday-1.png', 'holiday-2.png', 'holiday-10.png']);
  await arrange.selectOption('name-asc'); // A no-op must not replace the Undo snapshot.
  await undo.click();
  await expect(names).toHaveText(['holiday-10.png', 'holiday-2.png', 'holiday-1.png']);
  await expect(arrange).toBeFocused();
  await expect(undo).toBeDisabled();
  await arrange.selectOption('name-desc');
  await expect(undo).toBeDisabled();
  await arrange.selectOption('size-desc'); // The equally sized b/c fixtures keep their relative order.
  await expect(names).toHaveText(['holiday-2.png', 'holiday-1.png', 'holiday-10.png']);
  await arrange.selectOption('reverse');
  await expect(names).toHaveText(['holiday-10.png', 'holiday-1.png', 'holiday-2.png']);
  await undo.click();
  await expect(names).toHaveText(['holiday-2.png', 'holiday-1.png', 'holiday-10.png']);
  await arrange.selectOption('size-asc');
  await expect(names).toHaveText(['holiday-10.png', 'holiday-2.png', 'holiday-1.png']);
  expect(await page.locator('.tray__img').evaluateAll((images) => images.map((img) => img.getAttribute('src')).sort())).toEqual(thumbnails);
  await page.locator('.tray__item').first().press('ArrowDown');
  await undo.click();
  await expect(names).toHaveText(['holiday-10.png', 'holiday-2.png', 'holiday-1.png']);
  await arrange.selectOption('name-asc');
  await page.screenshot({ path: test.info().outputPath('batch-order-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await arrange.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: test.info().outputPath('batch-order-mobile.png') });
  await page.getByRole('button', { name: 'Remove holiday-1.png', exact: true }).click();
  await expect(undo).toBeDisabled();
  await arrange.selectOption('reverse');
  await page.locator('input[type="file"]').setInputFiles(fixture('a.png'));
  await expect(undo).toBeDisabled();
});

test('undo restores removed files and bytes, and expires when the tray changes', async ({ page }) => {
  const intake = page.locator('input[type="file"]');
  const names = page.locator('.tray__name');
  const undo = page.getByRole('button', { name: 'Undo file removal', exact: true });
  const notice = page.locator('.file-removal');
  await intake.setInputFiles([fixture('c.png'), fixture('a.png'), fixture('b.png')]);
  await pick(page, 'zip-create');
  await page.getByLabel('Archive name', { exact: true }).fill('recovered');

  await page.locator('.tray__item').nth(1).press('Delete');
  await expect(names).toHaveText(['c.png', 'b.png']);
  await expect(notice).toContainText('File removed');
  await undo.press('Enter');
  await expect(names).toHaveText(['c.png', 'a.png', 'b.png']);
  await expect(notice).toBeHidden();

  await page.getByRole('button', { name: 'Remove c.png', exact: true }).click();
  await page.getByRole('button', { name: 'Remove a.png', exact: true }).click();
  await undo.click();
  await expect(names).toHaveText(['a.png', 'b.png']); // Only the most recent removal.
  await page.getByRole('button', { name: 'Remove all files', exact: true }).click();
  await expect(names).toHaveCount(0);
  await expect(undo).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('file-removal-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await undo.click();
  await page.getByRole('button', { name: 'Remove all files', exact: true }).click();
  expect((await notice.boundingBox())!.y).toBeGreaterThanOrEqual(54);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  expect((await undo.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: test.info().outputPath('file-removal-mobile.png') });
  await undo.click();
  await expect(names).toHaveText(['a.png', 'b.png']);
  await expect(page.getByLabel('Archive name', { exact: true })).toHaveValue('recovered');
  await run(page);
  const recovered = unzipSync(await downloadCard(page));
  expect(Object.keys(recovered)).toEqual(['a.png', 'b.png']);
  for (const name of Object.keys(recovered)) expect(Buffer.from(recovered[name]!)).toEqual(await readFile(fixture(name)));

  await page.getByRole('button', { name: 'Remove a.png', exact: true }).click();
  await page.getByRole('button', { name: 'Use this result…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Use this result', exact: true }).getByRole('option', { name: /^Extract ZIP / }).click();
  await expect(names).toHaveText(['recovered.zip']);
  await expect(notice).toBeHidden();
  await page.getByRole('button', { name: 'Undo result reuse', exact: true }).click();
  await expect(names).toHaveText(['b.png']);
  await expect(notice).toBeHidden();
  await intake.setInputFiles(fixture('c.png'));
  await expect(names).toHaveText(['b.png', 'c.png']);
  await expect(notice).toBeHidden();
  await intake.setInputFiles(fixture('a.png'));
  await page.getByRole('button', { name: 'Remove a.png', exact: true }).click();
  await page.getByRole('combobox', { name: 'Arrange files', exact: true }).selectOption('reverse');
  await expect(notice).toBeHidden();
  await page.getByRole('button', { name: 'Remove c.png', exact: true }).click();
  await page.getByRole('button', { name: 'Dismiss file removal notice', exact: true }).click();
  await expect(notice).toBeHidden();
  await expect(page.getByRole('button', { name: 'Add files', exact: true })).toBeFocused();
  await page.locator('.tray__item').press('Backspace');
  await expect(names).toHaveCount(0);
  await expect(undo).toBeFocused();
  await undo.click();
  await expect(names).toHaveText(['b.png']);
});

test.describe('delayed chooser loading', () => {
  // Route the actual module request instead of the service worker's cache fetch.
  test.use({ serviceWorkers: 'block' });

  test('opening search cancels a chooser that is still loading', async ({ page }) => {
    let release!: () => void;
    let requested!: () => void;
    const delayed = new Promise<void>((resolve) => { release = resolve; });
    const requestSeen = new Promise<void>((resolve) => { requested = resolve; });
    await page.route('**/assets/result-reuse-*.js', async (route) => {
      requested();
      await delayed;
      await route.continue();
    });
    await page.locator('input[type="file"]').setInputFiles(fixture('a.png'));
    await pick(page, 'image-resize');
    await run(page);
    await page.getByRole('button', { name: 'Use this result…', exact: true }).click();
    await requestSeen;
    try {
      await page.getByRole('button', { name: 'Search tools (Ctrl K)' }).click();
      const response = page.waitForResponse(/\/assets\/result-reuse-.*\.js/);
      release();
      await (await response).finished();
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await expect(page.getByRole('dialog', { name: 'Command palette', exact: true })).toBeVisible();
    } finally {
      release();
    }
  });
});
