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
  await expect(card).toContainText('at most 2 files');
});

// Two snippets on a clipboard is the commonest comparison there is, and the
// tool used to demand you save them as files first.
test('opens from cold with two boxes, and compares what you paste', async ({ page }) => {
  // No files at all: straight to the tool from the catalogue.
  await page.locator('[data-tool="text-diff"]').click();
  await expect(page.locator('.tdiff__box')).toHaveCount(2, { timeout: 15_000 });
  await expect(page.locator('.tdiff__notices')).toContainText('Paste text into both boxes');

  await page.locator('.tdiff__box').nth(0).fill(OLD);
  await page.locator('.tdiff__box').nth(1).fill(NEW);

  await expect(page.locator('.tdiff__grid')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.tdiff__mark').first()).toHaveText('* 2');
  await expect(page.locator('.tdiff__stats')).toContainText('1 changed');

  await page.getByRole('button', { name: 'Run' }).click();
  const output = page.locator('.card--output');
  await expect(output).toHaveCount(1, { timeout: 30_000 });
  // Nothing was named, so neither is the report.
  await expect(output).toContainText('comparison.html');
});

test('pairs one loaded file with one box', async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles([source('old.ts', OLD)]);
  await page.locator('[data-tool="text-diff"]').click();

  await expect(page.locator('.tdiff__box')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('.tdiff__from')).toContainText('old.ts');

  await page.locator('.tdiff__box').fill(NEW);
  await expect(page.locator('.tdiff__grid')).toBeVisible({ timeout: 10_000 });

  await page.getByRole('button', { name: 'Run' }).click();
  await expect(page.locator('.card--output')).toContainText('old-vs-pasted.html', {
    timeout: 30_000,
  });
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

// A phone is where this tool is least comfortable and most likely to be
// reached for anyway — someone checking a diff away from their desk. These
// pin the two things that break there and cannot be seen from a desktop run:
// controls too small to hit, and a control small enough that iOS Safari zooms
// the page out from under the reader when they touch it.
test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });

  test('every control is big enough to hit with a thumb', async ({ page }) => {
    await page
      .locator('input[type="file"]')
      .setInputFiles([source('old.ts', OLD), source('new.ts', NEW)]);
    await page.locator('[data-tool="text-diff"]').click();
    await expect(page.locator('.tdiff__grid')).toBeVisible({ timeout: 15_000 });

    const report = await page.evaluate(() => {
      const nodes = document.querySelectorAll(
        '.tdiff__segbtn, .tdiff__btn, .tdiff__check, .tdiff__select',
      );
      return {
        coarse: matchMedia('(pointer: coarse)').matches,
        boxes: [...nodes].map((node) => {
          const box = node.getBoundingClientRect();
          return { w: Math.round(box.width), h: Math.round(box.height) };
        }),
        // Below 16px, iOS Safari zooms the viewport on focus.
        selectFont: Number.parseFloat(
          getComputedStyle(document.querySelector('.tdiff__select') as Element).fontSize,
        ),
      };
    });

    expect(report.coarse).toBe(true);
    expect(report.boxes.length).toBeGreaterThan(5);
    for (const box of report.boxes) {
      // WCAG 2.2 SC 2.5.8 asks for 24; the app's own `.btn` is 39, and a
      // control this one sits beside should not be the small one.
      expect(box.h, JSON.stringify(box)).toBeGreaterThanOrEqual(39);
      expect(box.w, JSON.stringify(box)).toBeGreaterThanOrEqual(24);
    }
    expect(report.selectFont).toBeGreaterThanOrEqual(16);
  });

  test('reads without sideways scrolling, in either layout', async ({ page }) => {
    await page
      .locator('input[type="file"]')
      .setInputFiles([source('old.ts', OLD), source('new.ts', NEW)]);
    await page.locator('[data-tool="text-diff"]').click();
    await expect(page.locator('.tdiff__grid')).toBeVisible({ timeout: 15_000 });

    const overflow = async (): Promise<number> =>
      page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

    expect(await overflow()).toBeLessThanOrEqual(0);
    // The word-level marks are the whole point, and they survive the width.
    await expect(page.locator('.tdiff__mark').first()).toHaveText('* 2');

    await page.locator('.tdiff__segbtn', { hasText: 'Side by side' }).click();
    expect(await overflow()).toBeLessThanOrEqual(0);
    // Both sides fit on the screen rather than one hiding behind a scroll.
    const row = page.locator('.tdiff__row--replace').first();
    await expect(row.locator('.tdiff__code--a')).toBeInViewport();
    await expect(row.locator('.tdiff__code--b')).toBeInViewport();
  });

  test('pasting works, and the boxes do not trigger an iOS zoom', async ({ page }) => {
    await page.locator('[data-tool="text-diff"]').click();
    await expect(page.locator('.tdiff__box')).toHaveCount(2, { timeout: 15_000 });

    // Below 16px, focusing a textarea zooms the viewport out from under you —
    // mid-paste, on the one control you are actually typing into.
    const fontSize = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.querySelector('.tdiff__box') as Element).fontSize),
    );
    expect(fontSize).toBeGreaterThanOrEqual(16);

    await page.locator('.tdiff__box').nth(0).fill(OLD);
    await page.locator('.tdiff__box').nth(1).fill(NEW);
    await expect(page.locator('.tdiff__grid')).toBeVisible({ timeout: 10_000 });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('the whole comparison is reachable by touch, including the run', async ({ page }) => {
    await page
      .locator('input[type="file"]')
      .setInputFiles([source('old.ts', OLD), source('new.ts', NEW)]);
    await page.locator('[data-tool="text-diff"]').click();
    await expect(page.locator('.tdiff__grid')).toBeVisible({ timeout: 15_000 });

    // Tap, not click: the controls have to work through a touch event.
    await page.locator('.tdiff__btn', { hasText: 'Swap sides' }).tap();
    await expect(page.locator('.tdiff__files')).toHaveText('new.ts → old.ts');

    await page.getByRole('button', { name: 'Run' }).tap();
    await expect(page.locator('.card--output')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.locator('.card--output')).toContainText('new-vs-old.html');
  });
});
