// tests/e2e/golden.spec.ts — Task 8's three golden flows, against the real
// production build (see playwright.config.ts's `webServer`).
//
// Every flow inspects the REAL downloaded bytes or the REAL rendered DOM —
// never just "a button was clicked". A merge that silently produced the
// wrong page count, or a zip bundle missing an entry, would still leave every
// button in its "success" state; only decoding what actually came out proves
// the pipeline did its job.
//
// FILE INJECTION: files are set directly on the app's own hidden
// `<input type="file" multiple>` (src/ui/dropzone.ts) via Playwright's
// `setInputFiles`, rather than simulating a drag-and-drop `DataTransfer`.
// This is the technique Playwright's own docs recommend for file-upload
// tests: it is far less brittle across engines than synthesizing drag
// events, and it still exercises the exact same `change` -> `deliver()` ->
// `onFiles()` code path the drop handler calls into — the intake logic in
// dropzone.ts does not care which of its three entry points delivered the
// files.
//
// SYNCHRONISATION: instead of arbitrary waits, tests wait on a signal the app
// already produces for its own reasons. `select()` in src/ui/shell.ts moves
// keyboard focus onto the Run button only once the tool's option panel —
// including, for image tools, the async canvas-encoder probe from
// src/ui/encoder.ts — has finished mounting. Waiting for Run to be focused is
// therefore a real, race-free "the app is ready" signal, not a guess.
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';
import { unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

function tempDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/**
 * Five DISTINCTLY NAMED inputs, each copied from a real, committed PNG
 * fixture (tests/fixtures/{a,b,c}.png — see make-fixtures.mjs). Two names
 * are reused with different bytes-on-disk copies purely to reach five
 * without inventing new fixture-generation machinery; content is irrelevant
 * to this flow, only "five real PNGs go in, five real .webp entries come
 * out" is.
 */
function fiveDistinctPngPaths(dir: string): string[] {
  const sources = ['a.png', 'b.png', 'c.png', 'a.png', 'b.png'];
  return sources.map((source, index) => {
    const dest = path.join(dir, `in-${index + 1}-${source}`);
    copyFileSync(fixturePath(source), dest);
    return dest;
  });
}

/** Pick a tool and wait for the app's own "ready to run" signal. */
async function selectTool(page: Page, toolId: string): Promise<void> {
  const card = page.locator(`[data-tool="${toolId}"]`);
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.click();
  await expect(page.getByRole('button', { name: 'Run' })).toBeFocused({ timeout: 15_000 });
}

test.beforeEach(async ({ page }) => {
  // Motion is decorative (§1/§8 of the plan): the app itself turns every
  // motion.ts export into an instant no-op under reduced motion, so this
  // removes animation-timing flakiness without changing what is exercised.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
});

test.describe('golden flows — production build', () => {
  test('drop two PDFs, merge, and the downloaded file has the combined page count', async ({
    page,
  }) => {
    await page
      .locator('input[type="file"]')
      .setInputFiles([fixturePath('small.pdf'), fixturePath('small.pdf')]);

    await selectTool(page, 'pdf-merge');
    await page.getByRole('button', { name: 'Run' }).click();

    // A single output -> one per-card "Download" button (no "Download all").
    const downloadButton = page.getByRole('button', { name: 'Download' });
    await expect(downloadButton).toBeVisible({ timeout: 30_000 });

    const [download] = await Promise.all([page.waitForEvent('download'), downloadButton.click()]);

    const savePath = path.join(tempDir('omnitool-merge-'), 'merged.pdf');
    await download.saveAs(savePath);
    const bytes = readFileSync(savePath);
    const doc = await PDFDocument.load(bytes);

    // small.pdf has 3 pages (tests/fixtures/make-fixtures.mjs); merged with
    // itself, the real downloaded file must have exactly 6.
    expect(doc.getPageCount()).toBe(6);
  });

  test('drop five PNGs, convert to WebP, download all, and the zip holds five .webp entries', async ({
    page,
  }) => {
    const dir = tempDir('omnitool-convert-');
    await page.locator('input[type="file"]').setInputFiles(fiveDistinctPngPaths(dir));

    await selectTool(page, 'image-convert');
    // 'webp' is the schema default (src/core/registry.image.ts) and Chrome's
    // canvas WebP encoder is genuinely supported (unlike AVIF — see the
    // encoder-probe note in src/tools/image/convert.op.ts), so the default
    // is never disabled and Run can proceed without touching any option.
    await page.getByRole('button', { name: 'Run' }).click();

    // Five outputs -> the bundle button, not five separate per-card ones.
    const downloadAllButton = page.getByRole('button', { name: /Download all/ });
    await expect(downloadAllButton).toBeVisible({ timeout: 30_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadAllButton.click(),
    ]);

    const savePath = path.join(dir, 'bundle.zip');
    await download.saveAs(savePath);
    const bytes = readFileSync(savePath);
    const entries = Object.keys(unzipSync(new Uint8Array(bytes)));

    expect(entries).toHaveLength(5);
    expect(entries.every((name) => name.endsWith('.webp'))).toBe(true);
  });

  test('drop sample.zip, extract, and the expected entries appear in the results tray', async ({
    page,
  }) => {
    await page.locator('input[type="file"]').setInputFiles([fixturePath('sample.zip')]);

    await selectTool(page, 'zip-extract');
    await page.getByRole('button', { name: 'Run' }).click();

    // tests/fixtures/make-fixtures.mjs's sample.zip contains exactly these
    // two entries (see makeSampleZip()). zip-extract.op.ts only prefixes
    // entry names with the archive's stem when MULTIPLE archives were
    // dropped at once; here there is one, so names come through unprefixed.
    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('dir/nested.txt', { exact: true })).toBeVisible();

    const names = await page.locator('.results .card__name').allTextContents();
    expect(names.sort()).toEqual(['dir/nested.txt', 'hello.txt']);
  });

  test('drop sample.tar, and the TAR tool is offered and unpacks every entry', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles([fixturePath('sample.tar')]);

    // Getting this far proves the sniffer found the ustar magic 257 bytes
    // into the file and the registry filtered down to the tools that accept
    // application/x-tar — selectTool fails if the card never appears.
    await selectTool(page, 'tar-extract');
    await page.getByRole('button', { name: 'Run' }).click();

    await expect(page.getByText('hello.txt', { exact: true })).toBeVisible({ timeout: 30_000 });
    const names = await page.locator('.results .card__name').allTextContents();
    expect(names).toContain('dir/nested.txt');
    // Written by GNU tar as a long-name entry, not in the 100-byte field.
    expect(names.some((name) => name.startsWith('long-long-'))).toBe(true);
  });

  test('offers PDF tools prominently and byte utilities quietly', async ({ page }) => {
    await page.goto('/');
    await page
      .locator('input[type=file]')
      .setInputFiles([fixturePath('small.pdf'), fixturePath('small.pdf')]);

    // Format-aware tools are cards.
    await expect(page.locator('.toolcard[data-tool="pdf-merge"]')).toBeVisible();
    // Any-bytes tools are demoted, not removed.
    await expect(page.locator('.toolcard[data-tool="hash"]')).toHaveCount(0);
    await expect(page.locator('.utilitybar [data-tool="hash"]')).toBeVisible();
    // The generator is nowhere in a file-driven grid.
    await expect(page.locator('[data-tool="qr-generate"]')).toHaveCount(0);
    // A tool blocked only on count is explained, not vanished.
    const blocked = page.locator('.toolcard--blocked[data-tool="pdf-organize"]');
    await expect(blocked).toContainText('Needs exactly 1 file');

    // Adding files REBUILDS the blocked tier, it does not append to it. The
    // grid holding these cards is a separate node from the main one, so it
    // needs its own clear — miss that and pdf-organize is rendered twice here,
    // three times after the next drop, and nothing else in the app notices.
    await page
      .locator('input[type=file]')
      .setInputFiles([fixturePath('small.pdf'), fixturePath('small.pdf')]);
    // Wait for the rebuild to land before counting: otherwise the count is read
    // off the first render and passes without ever exercising the second.
    await expect(blocked.first()).toContainText('you have 4');
    await expect(blocked).toHaveCount(1);
  });

  test('drop a photo with GPS in it, strip the metadata, and the downloaded bytes have none', async ({
    page,
  }) => {
    await page.locator('input[type="file"]').setInputFiles([fixturePath('exif.jpg')]);

    await selectTool(page, 'image-strip-metadata');
    await page.getByRole('button', { name: 'Run' }).click();

    // Two outputs — the stripped image and metadata-report.txt — so the tray
    // offers the bundle button rather than a per-card download.
    const downloadAllButton = page.getByRole('button', { name: /Download all/ });
    await expect(downloadAllButton).toBeVisible({ timeout: 30_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      downloadAllButton.click(),
    ]);

    const savePath = path.join(tempDir('omnitool-strip-'), 'bundle.zip');
    await download.saveAs(savePath);
    const entries = unzipSync(new Uint8Array(readFileSync(savePath)));

    const stripped = Buffer.from(entries['exif.jpg'] as Uint8Array);
    expect(stripped.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // still a JPEG
    expect(stripped.includes(Buffer.from('Exif\0\0', 'latin1'))).toBe(false);
    expect(stripped.includes(Buffer.from('Fixture Camera', 'latin1'))).toBe(false);
    expect(stripped.length).toBeLessThan(readFileSync(fixturePath('exif.jpg')).length);

    const report = Buffer.from(entries['metadata-report.txt'] as Uint8Array).toString('utf8');
    expect(report).toContain('EXIF (APP1)');
  });
});
