import { expect, test } from '@playwright/test';

test('responsive review has one document flow and no page overflow from 320 to 2560 px', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('[data-tool="text-diff"]').click();
  await page.locator('.tdw__textarea').nth(0).fill('Project launch\nOld timing\nKeep this line\n');
  await page.locator('.tdw__textarea').nth(1).fill('Project launch\nNew timing\nKeep this line\n');
  await expect(page.locator('.tdw__stats')).toContainText('1 modified');
  await page.getByRole('button', { name: 'Review changes' }).click();

  for (const width of [320, 375, 390, 768, 1024, 1440, 2560]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(page.locator('.tdw')).toHaveAttribute('data-auto-split', String(width >= 1024));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `page overflow at ${width}`).toBeLessThanOrEqual(0);
    if (width === 320) {
      const gutter = page.locator('.tdw__gutter').first();
      await gutter.evaluate((node) => { node.textContent = '−100000 · 100000'; });
      const metrics = await gutter.evaluate((node) => ({
        text: node.scrollWidth, width: node.clientWidth,
        code: node.nextElementSibling?.getBoundingClientRect().width ?? 0,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      expect(metrics.text).toBeLessThanOrEqual(metrics.width);
      expect(metrics.code).toBeGreaterThan(0);
      expect(metrics.overflow).toBeLessThanOrEqual(0);
    }
    const equal = page.locator('.tdw__row--equal').first();
    if (width < 832) {
      await expect(equal.locator('.tdw__half--b')).toBeHidden();
      await expect(equal.locator('.tdw__half--a')).toBeVisible();
    }
  }
});

test('mobile source tabs and explicitly stacked split keep controls readable', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.locator('[data-tool="text-diff"]').click();
  await expect(page.locator('.tdw__tab')).toHaveCount(2);
  await page.locator('.tdw__textarea').nth(0).fill('old\n');
  await page.getByRole('tab', { name: 'Revised' }).click();
  await page.locator('.tdw__textarea').nth(1).fill('new\n');
  await expect(page.locator('.tdw__stats')).toContainText('1 modified');
  await page.getByRole('button', { name: 'Review changes' }).click();
  await page.locator('.tdw__select').first().selectOption('split');
  const paired = page.locator('.tdw__row--replace').first();
  const positions = await paired.evaluate((node) => {
    const halves = node.querySelectorAll<HTMLElement>('.tdw__half');
    return [halves[0]?.getBoundingClientRect().top, halves[1]?.getBoundingClientRect().top];
  });
  expect(positions[1]).toBeGreaterThan(positions[0]!);
  const controlMetrics = await page.locator('.tdw__textarea, .tdw__select').evaluateAll((nodes) =>
    nodes.filter((node) => node.getClientRects().length > 0).map((node) => ({ font: Number.parseFloat(getComputedStyle(node).fontSize), height: node.getBoundingClientRect().height })));
  expect(controlMetrics.every((metric) => metric.font >= 16)).toBe(true);
  expect(controlMetrics.every((metric) => metric.height >= 44)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test('phone tabs reach Revised with the keyboard and disclose Find and Export state', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 700 });
  await page.goto('/');
  await page.locator('[data-tool="text-diff"]').click();
  const original = page.getByRole('tab', { name: 'Original' });
  const revised = page.getByRole('tab', { name: 'Revised' });
  await original.focus();
  await page.keyboard.press('ArrowRight');
  await expect(revised).toBeFocused();
  await expect(revised).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.tdw__source').nth(1)).toBeVisible();
  await page.locator('.tdw__textarea').nth(1).fill('new\n');
  await revised.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(original).toBeFocused();
  await page.locator('.tdw__textarea').nth(0).fill('old\n');
  await expect(page.locator('.tdw__stats')).toContainText('1 modified');
  await page.getByRole('button', { name: 'Review changes' }).click();
  const find = page.getByRole('button', { name: 'Find', exact: true });
  const exportButton = page.getByRole('button', { name: 'Export', exact: true });
  await find.click();
  await expect(find).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(find).toHaveAttribute('aria-expanded', 'false');
  await exportButton.click();
  await expect(exportButton).toHaveAttribute('aria-expanded', 'true');
});

test('emulated 200% text zoom reflows inputs and split review without document overflow', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 800 });
  await page.goto('/');
  await page.locator('[data-tool="text-diff"]').click();
  await page.locator('.tdw__textarea').nth(0).fill('before\n');
  await page.locator('.tdw__textarea').nth(1).fill('after\n');
  await expect(page.locator('.tdw__stats')).toContainText('1 modified');
  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  await expect(page.locator('.tdw')).toHaveAttribute('data-compact', 'true');
  await expect(page.getByRole('tab', { name: 'Original' })).toBeVisible();
  await page.getByRole('button', { name: 'Review changes' }).click();
  await page.locator('.tdw__select').first().selectOption('split');
  const halves = await page.locator('.tdw__row--replace').first().locator('.tdw__half').evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().top));
  expect(halves[1]).toBeGreaterThan(halves[0]!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test.describe('coarse pointer targets', () => {
  test.use({ viewport: { width: 375, height: 700 }, hasTouch: true, isMobile: true });
  test('Options checkbox labels provide 44px touch targets', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-tool="text-diff"]').click();
    await page.locator('.tdw__textarea').nth(0).fill('old\n');
    await page.getByRole('tab', { name: 'Revised' }).click();
    await page.locator('.tdw__textarea').nth(1).fill('new\n');
    await expect(page.locator('.tdw__stats')).toContainText('1 modified');
    await page.getByRole('button', { name: 'Review changes' }).click();
    await page.locator('.tdw__options summary').click();
    const heights = await page.locator('.tdw__options .tdw__check').evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(0);
    expect(heights.every((height) => height >= 44)).toBe(true);
  });
});
