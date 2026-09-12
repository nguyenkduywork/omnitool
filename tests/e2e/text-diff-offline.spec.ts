import { expect, test } from '@playwright/test';

const OLD = 'offline original\n';
const NEW = 'offline revised\n';

async function compare(page: import('@playwright/test').Page): Promise<void> {
  if (await page.locator('.tdw').count() === 0) await page.locator('[data-tool="text-diff"]').click({ timeout: 8_000 });
  await page.locator('.tdw__textarea').nth(0).fill(OLD);
  await page.locator('.tdw__textarea').nth(1).fill(NEW);
  await expect(page.locator('.tdw__stats')).toContainText('1 modified');
  await page.getByRole('button', { name: 'Review changes' }).click();
}

async function waitForServiceWorkerControl(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await Promise.race([
        new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('service worker did not control the warm page')), 10_000)),
      ]);
    }
  });
}

async function waitForWarmAssets(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    const assets = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => new URL(url).pathname.includes('/assets/'));
    for (const url of assets) {
      for (let attempt = 0; attempt < 80 && !(await caches.match(url, { ignoreVary: true })); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!await caches.match(url, { ignoreVary: true })) throw new Error(`asset was not cached: ${url}`);
    }
  });
}

test('warms Text Diff assets then reloads, compares, finds, details, and exports offline', async ({ page, context }) => {
  const requests: string[] = [];
  context.on('request', (request) => requests.push(`${request.url()} ${request.postData() ?? ''}`));
  await page.goto('/');
  await waitForServiceWorkerControl(page);
  await compare(page);
  await page.getByRole('button', { name: 'Find', exact: true }).click();
  await page.getByRole('searchbox', { name: /find/i }).fill('revised');
  await page.locator('.tdw__options summary').click();
  await page.locator('.tdw__options select').first().selectOption('character');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await page.getByRole('button', { name: 'Download report' }).click();
  await expect(page.locator('.card--output')).toContainText('.html');
  await waitForWarmAssets(page);
  await context.setOffline(true);
  try {
    await page.reload();
    await compare(page);
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await page.getByRole('searchbox', { name: /find/i }).fill('revised');
    await expect(page.locator('.tdw__match')).toContainText('revised');
    await page.locator('.tdw__options summary').click();
    await page.locator('.tdw__options select').first().selectOption('character');
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'Download report' }).click();
    await expect(page.locator('.card--output')).toContainText('.html');
    await page.getByRole('button', { name: 'Download patch' }).click();
    await expect(page.locator('.card--output')).toContainText('.diff');
    const stored = await page.evaluate(() => [localStorage, sessionStorage].flatMap((storage) =>
      Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index)!) ?? ''),
    ));
    for (const marker of ['offline original', 'offline revised']) {
      expect(stored.join('\n')).not.toContain(marker);
      expect(requests.join('\n')).not.toContain(marker);
      expect(requests.join('\n')).not.toContain(encodeURIComponent(marker));
    }
  } finally {
    await context.setOffline(false);
  }
});
