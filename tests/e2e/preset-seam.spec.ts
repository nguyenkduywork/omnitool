// tests/e2e/preset-seam.spec.ts — the preset -> op seam (F7 of the final
// whole-branch review, .superpowers/sdd/2026-08-30-ui-overhaul/progress.md).
//
// Task 4 caught a real bug here: `shell.ts`'s `mountOptions` layers a
// preset's values UNDER the mounted panel's own (`options = { ...options,
// ...mounted.values() }` at shell.ts's `options = { ...options,
// ...mounted.values() };`), and `start()` hands the resulting `options`
// object straight to `run(tool.id, files, options)`. Nothing in the unit
// suite ever reads THAT object — every options-panel test stops at the
// panel's own `values()`, and every pipeline test constructs `options`
// itself rather than getting it from the shell. So a regression that drops
// the preset layer (e.g. reverting shell.ts's `options = { ...options,
// ...mounted.values() }` to just `options = mounted.values()`, or dropping
// `presetValues` on the way into `renderOptions`) would leave the whole
// suite green while silently shipping the SCHEMA default to the op instead
// of what the panel actually showed.
//
// This closes that gap the only way that actually proves the seam: run a
// tool with a preset for real, and inspect the real downloaded file's name.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const fixturePath = (name: string): string => path.join(FIXTURES, name);

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
});

test.describe('the preset -> op seam', () => {
  test('Create ZIP, unchanged, downloads a file named after the preset — not the schema default', async ({
    page,
  }) => {
    // registry.data.ts's `archiveNamePreset` computes the archive's `name`
    // option from the FIRST file's basename: small.pdf -> 'small'. The
    // schema's own declared default is 'archive' (see `zip-create`'s
    // `options.name.default`) — a real, DIFFERENT string, which is what
    // makes the downloaded filename an actual discriminator between "the
    // preset reached the op" and "the schema default did".
    await page.locator('input[type="file"]').setInputFiles([fixturePath('small.pdf')]);

    const card = page.locator('[data-tool="zip-create"]');
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();
    await expect(page.getByRole('button', { name: 'Run' })).toBeFocused({ timeout: 15_000 });

    // The preset is visible in the field before Run is ever touched — this
    // is the same assertion Task 4's own unit coverage makes, kept here only
    // as a sanity check that this test is exercising the preset path at all.
    await expect(page.getByLabel('Archive name')).toHaveValue('small');

    await page.getByRole('button', { name: 'Run' }).click();

    const downloadButton = page.getByRole('button', { name: 'Download' });
    await expect(downloadButton).toBeVisible({ timeout: 30_000 });

    const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);

    // The real, actually-downloaded filename — not a mock, not the panel's
    // own `values()` read back. `zip-create.op.ts` names its output
    // `${options.name}.zip`, so this is `small.zip` only if the preset value
    // genuinely reached the op through `start()`'s `options` object.
    expect(download.suggestedFilename()).toBe('small.zip');
  });
});
