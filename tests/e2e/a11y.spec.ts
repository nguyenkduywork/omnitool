// tests/e2e/a11y.spec.ts — accessibility that only a real browser can prove,
// against the real production build (see playwright.config.ts's `webServer`).
//
// Three things live here. Most of the file is keyboard-only operation, proven
// against the shipped three-zone workbench (files / catalogue / work —
// ui/zones/*.ts), which is always mounted and never a separate screen from
// the landing hero (see shell.ts's `paint`). A short describe after it checks
// that each zone forms its own labelled landmark, one region per zone rather
// than the nested duplicate Task 9 originally shipped (see filetray.ts). The
// last describe is about LEGIBILITY, and it is here for the same reason:
// `npm run contrast` reads token pairs straight out of tokens.css, so it can
// prove `--ink-2` on `--bg` and cannot see an `opacity` on an ancestor
// compositing that same pair down to 3:1. Only a rendered page knows the
// difference.
//
// WHY THIS EXISTS AS AN E2E TEST RATHER THAN A MANUAL CHECK
//
// The plan (§7.5) requires full keyboard operation. A one-off manual
// walkthrough proves it once and then rots the moment someone changes a
// tabindex. These tests re-prove it on every push.
//
// They also need REAL key events, which is why they live here and not in the
// vitest browser project: a synthetic `new KeyboardEvent('keydown', ...)`
// dispatched from page script will happily fire an app's own listener while
// telling you nothing about whether a real keypress reaches it — different
// focus semantics, no default-action handling, `isTrusted: false`. Playwright
// drives the browser's actual input pipeline, so a pass here means a person
// with a keyboard can genuinely do this.
//
// Files still arrive via `setInputFiles` on the app's own hidden input: a real
// OS file picker cannot be driven from a test at all, and that is the same
// entry point a keyboard user reaches by activating "Choose files".
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test, type Page } from '@playwright/test';

import { tabUntil } from './keyboard';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function fixturePath(name: string): string {
  return path.join(FIXTURES, name);
}

/**
 * Press Tab until the focused element satisfies `matches`, or give up.
 *
 * Bounded on purpose: an unbounded loop would hang instead of failing, and
 * "reachable within a sane number of stops" is itself the property under test.
 * Returns the number of tabs taken so a regression that buries a control 40
 * stops deep is visible in the assertion, not just "it eventually worked".
 */
/** The tray's accessible labels, in DOM order — this is the merge order. */
function trayLabels(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('[aria-label*="Position"]')].map(
      (e) => e.getAttribute('aria-label') ?? '',
    ),
  );
}

function liveRegionText(page: Page): Promise<string> {
  return page.evaluate(() => document.querySelector('[aria-live]')?.textContent?.trim() ?? '');
}

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
});

test.describe('keyboard-only operation', () => {
  test('reorders the file tray with real arrow keys and announces each move', async ({ page }) => {
    await page
      .locator('input[type="file"]')
      .setInputFiles([fixturePath('a.png'), fixturePath('b.png'), fixturePath('c.png')]);

    await expect(page.locator('[aria-label*="Position"]').first()).toBeVisible({ timeout: 15_000 });
    expect(await trayLabels(page)).toEqual([
      expect.stringContaining('a.png') as unknown as string,
      expect.stringContaining('b.png') as unknown as string,
      expect.stringContaining('c.png') as unknown as string,
    ]);

    // Reach the first tray row using nothing but Tab.
    const tabs = await tabUntil(page, (i) => (i.label ?? '').includes('a.png'));
    expect(tabs).toBeLessThanOrEqual(40);

    // ArrowDown: a.png 1 -> 2.
    await page.keyboard.press('ArrowDown');
    expect(await trayLabels(page)).toEqual([
      expect.stringContaining('b.png') as unknown as string,
      expect.stringContaining('a.png') as unknown as string,
      expect.stringContaining('c.png') as unknown as string,
    ]);
    // The move must be announced, or a screen-reader user has no idea it worked.
    expect(await liveRegionText(page)).toMatch(/a\.png moved to position 2 of 3/i);

    // Focus must FOLLOW the moved item, otherwise a second press moves a
    // different file and reordering by keyboard is unusable in practice.
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toContain(
      'a.png',
    );

    // End: jump to last.
    await page.keyboard.press('End');
    expect(await trayLabels(page)).toEqual([
      expect.stringContaining('b.png') as unknown as string,
      expect.stringContaining('c.png') as unknown as string,
      expect.stringContaining('a.png') as unknown as string,
    ]);

    // Home: jump back to first.
    await page.keyboard.press('Home');
    expect(await trayLabels(page)).toEqual([
      expect.stringContaining('a.png') as unknown as string,
      expect.stringContaining('b.png') as unknown as string,
      expect.stringContaining('c.png') as unknown as string,
    ]);

    // ArrowUp at position 1 must be a no-op, not a wrap-around: wrapping would
    // silently move a file to the far end of a merge on an over-press.
    await page.keyboard.press('ArrowUp');
    expect(await trayLabels(page)).toEqual([
      expect.stringContaining('a.png') as unknown as string,
      expect.stringContaining('b.png') as unknown as string,
      expect.stringContaining('c.png') as unknown as string,
    ]);
  });

  test('removes a file with the Delete key', async ({ page }) => {
    await page
      .locator('input[type="file"]')
      .setInputFiles([fixturePath('a.png'), fixturePath('b.png')]);
    await expect(page.locator('[aria-label*="Position"]').first()).toBeVisible({ timeout: 15_000 });

    await tabUntil(page, (i) => (i.label ?? '').includes('a.png'));
    await page.keyboard.press('Delete');

    const labels = await trayLabels(page);
    expect(labels).toHaveLength(1);
    expect(labels[0]).toContain('b.png');
  });

  test('opens the palette with Ctrl+K, runs a tool, and restores focus on Escape', async ({
    page,
  }) => {
    await page.locator('input[type="file"]').setInputFiles([fixturePath('a.png')]);
    await expect(page.locator('[aria-label*="Position"]').first()).toBeVisible({ timeout: 15_000 });

    // Park focus somewhere identifiable so focus-restore is actually testable.
    await tabUntil(page, (i) => (i.label ?? '').includes('a.png'));
    const before = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    expect(before).toContain('a.png');

    await page.keyboard.press('Control+k');

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Escape must close it AND put focus back where it was — a dialog that
    // dumps focus to <body> strands a keyboard user at the top of the page.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden({ timeout: 10_000 });
    expect(await page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(
      before,
    );

    // Reopen and drive it entirely by keyboard: type to filter, Enter to pick.
    await page.keyboard.press('Control+k');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.keyboard.type('convert');
    await page.keyboard.press('Enter');

    await expect(dialog).toBeHidden({ timeout: 10_000 });
    // Enter in the palette RUNS the tool, it does not merely select it (see
    // `runFromPalette` in src/ui/shell.ts) — that is what a command palette
    // is for. So the thing to wait for is a finished job, not a focused Run
    // button: `start()` disables Run and hands focus to Cancel while the job
    // is in flight, so Run is never focused on this path.
    await expect(page.getByRole('button', { name: 'Download' }).first()).toBeVisible({
      timeout: 30_000,
    });
  });

  test('runs a whole conversion without a single mouse interaction', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles([fixturePath('a.png')]);
    await expect(page.locator('[aria-label*="Position"]').first()).toBeVisible({ timeout: 15_000 });

    // One Ctrl+K, a few letters, one Enter — the palette selects AND runs.
    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.type('hash');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 10_000 });

    // `hash` emits text, which the results tray must render INLINE (§7.3) —
    // making someone download a file to read a checksum would be absurd. A
    // SHA-256 is 64 hex characters, so assert the real digest is on screen
    // rather than merely that some success state was reached.
    await expect(page.getByRole('button', { name: /copy/i }).first()).toBeVisible({
      timeout: 30_000,
    });
    const shown = await page.evaluate(() => document.body.innerText);
    expect(shown).toMatch(/\b[0-9a-f]{64}\b/);
  });

  test('every interactive control shows a visible focus indicator', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles([fixturePath('a.png')]);
    await expect(page.locator('[aria-label*="Position"]').first()).toBeVisible({ timeout: 15_000 });

    // Walk the first 20 tab stops and confirm each one paints something a
    // sighted keyboard user can actually see. `outline: none` with no
    // replacement is the single most common keyboard-accessibility failure.
    const invisible: string[] = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      const bad = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
        const hasShadow = cs.boxShadow !== 'none' && cs.boxShadow.trim() !== '';
        const hasBorderCue = parseFloat(cs.borderWidth || '0') > 0;
        if (hasOutline || hasShadow || hasBorderCue) return null;
        return el.getAttribute('aria-label') ?? el.tagName + ':' + el.textContent?.trim().slice(0, 30);
      });
      if (bad) invisible.push(bad);
    }
    expect(invisible).toEqual([]);
  });

  test('reaches a tool card, then its Run button, by keyboard alone', async ({ page }) => {
    // Two PDFs, dropped before tabbing: `pdf-merge`'s Run is already enabled
    // once selected, which is what proves the FOCUS MECHANIC itself — Tab to
    // a card, Enter selects it, focus lands on Run — independent of whatever
    // Run's own label happens to say. The BLOCKED case (the reason IS the
    // label) has its own test right below, now that Run can actually be
    // reached by focus while blocked — see that test's comment.
    await page
      .locator('input[type="file"]')
      .setInputFiles([fixturePath('small.pdf'), fixturePath('small.pdf')]);
    await expect(page.locator('[aria-label*="Position"]').first()).toBeVisible({ timeout: 15_000 });

    const toCard = await tabUntil(page, (info) => info.label?.startsWith('Merge PDFs') === true);
    expect(toCard).toBeLessThan(40);

    await page.keyboard.press('Enter');
    // select() moves focus onto Run once the option panel has mounted.
    await expect(page.getByRole('button', { name: 'Run' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Run' })).toBeEnabled();
  });

  test('reaches a BLOCKED Run by keyboard alone, with the reason as what focus reads', async ({
    page,
  }) => {
    // Cold, no files at all: "Merge PDFs" is a plain, enabled toolcard (the
    // blocked TIER in the test above only exists once files are loaded and a
    // type fits but a count doesn't — zones/catalogue.ts). Picking it here
    // leaves Run itself blocked, on a file count of zero.
    const toCard = await tabUntil(page, (info) => info.label?.startsWith('Merge PDFs') === true);
    expect(toCard).toBeLessThan(40);

    await page.keyboard.press('Enter');

    // Before the followups doc's `disabled` -> `aria-disabled` fix, a
    // blocked Run was natively `disabled` — unfocusable, native HTML
    // behaviour — so `select()`'s own `runButton.focus()` (shell.ts) was a
    // silent no-op and focus stayed on the card that was just activated. Run
    // is `aria-disabled` now, so it stays in the tab order: this actually
    // lands, and its accessible name is the REASON, not "Run" — exactly what
    // a keyboard user, or anyone else who reads by following focus (a screen
    // magnifier, say), needs.
    const run = page.getByRole('button', { name: /needs at least 2 files/i });
    await expect(run).toBeFocused();
    await expect(run).toBeDisabled();

    // Still explicitly refuses to act: aria-disabled trades away the
    // browser's free enforcement of that, so the click handler has to refuse
    // by hand (zones/work.ts's `handleRunClick`) — Enter must not start a run.
    await page.keyboard.press('Enter');
    await expect(page.locator('#stage')).toHaveAttribute('data-phase', 'tool-picked');
  });
});

test.describe('landmarks', () => {
  test('gives zones 1 and 2 a labelled landmark, with no duplicate "Files" region', async ({
    page,
  }) => {
    // Ids as SHIPPED: zone 1 (`ui/zones/files.ts`) reuses filetray.ts's own
    // `<h2 id="tray-heading">Files</h2>` rather than inventing a duplicate
    // heading.
    await expect(page.locator('aside[aria-labelledby="tray-heading"]')).toBeVisible();
    await expect(page.locator('section[aria-labelledby="catalogue-heading"]')).toBeVisible();

    // filetray.ts's own `<section class="tray">` used to carry this SAME
    // `aria-labelledby`, which nested a `region` (the tray's own heading
    // makes ANY named `<section>` one) inside the `complementary` landmark
    // zone--files already is — landmark navigation announced "Files" twice
    // for one visual area. This task's fix drops the attribute from the
    // tray, so exactly one element in the whole page — the zone's own
    // `<aside>` — carries it now, and the heading itself still exists,
    // referenced by id, for both to point at.
    await expect(page.locator('[aria-labelledby="tray-heading"]')).toHaveCount(1);
  });

  // Zone 3 gets its own test: unlike zones 1 and 2, its landmark name and its
  // visible content are BOTH state-dependent in ways worth proving
  // separately — the cold, tool-first state is the app's own default, and a
  // test that only ever checks the warm state (as an earlier version of this
  // test did, by picking a tool before asserting anything) cannot catch a
  // regression that is specific to cold.
  test('names and paints zone 3 even before a tool is picked, then takes on the tool\'s own name', async ({
    page,
  }) => {
    // COLD: `ui/zones/work.ts`'s `<h2>` inside `.run` is empty here (it only
    // gets `tool.name` once something is selected — see `render`), so the
    // zone root is named with `aria-label` instead of `aria-labelledby`
    // pointing at that heading. `getByRole('region', { name })` is the
    // accessible-name-based way to prove that: it fails outright if the name
    // resolves empty, which `toBeVisible()` on a raw `[aria-labelledby]`
    // selector would not have caught (the ATTRIBUTE was always present — the
    // TEXT it pointed at was the empty part).
    const cold = page.getByRole('region', { name: 'Selected tool' });
    await expect(cold).toBeVisible();

    // The restored placeholder copy — cut in Task 9 on the assumption a later
    // task's layout might need it, never revisited once Task 10's permanent
    // three-column sticky layout made that layout the shipped one. Without
    // this, `.zone--work` painted nothing at all with no tool picked: its
    // only child was `hidden` and the grid item collapsed to zero height, so
    // the column beside the catalogue was bare page background for as long
    // as the app sat in its own default state.
    await expect(cold.getByText('Pick a tool to get started.')).toBeVisible();
    await expect(
      cold.getByText('Some tools need files; the QR code generator does not.'),
    ).toBeVisible();

    // WARM: picking the cold-reachable QR generator (Task 10's second
    // door — no file needed) proves the SAME element carries real tool
    // content once something is selected. Unlike the earlier, static
    // `aria-label`, the followups doc's dynamic-label fix means the NAME
    // changes too, from the generic "Selected tool" to the tool's own name —
    // so `getByRole` has to look for a different name now, not the same
    // locator as the cold assertion above.
    await page.locator('.toolcard[data-tool="qr-generate"]').click();
    const warm = page.getByRole('region', { name: 'Generate QR code' });
    await expect(warm).toBeVisible();
    await expect(warm.getByRole('heading', { name: 'Generate QR code' })).toBeVisible();
    // The generic name is GONE, not merely joined by a second, more specific
    // one — every tool must get its own name during landmark navigation,
    // never the same "Selected tool, region" for all of them.
    await expect(page.getByRole('region', { name: 'Selected tool' })).toHaveCount(0);
  });
});

/**
 * The WCAG contrast of one element's text against what is ACTUALLY behind it on
 * screen. Returns the ratio, so a failure reports the number rather than just
 * "not readable".
 *
 * The surface is the nearest ancestor that paints a background, over the page's
 * own ground. `opacity` is composited the way the engine does it, which is not
 * a single product: an element with `opacity` renders its whole subtree into a
 * group and composites THAT over what is behind it, so the same opacity dims
 * the surface and the ink on it together, and the ink is laid over its own
 * undimmed surface first. Both sides therefore carry the painting element's
 * opacity, and only opacity BELOW it (between the surface and the text) dims
 * the ink alone. Getting this symmetric is the difference between reporting a
 * dimmed card honestly and reporting ink dimmed over a surface that was not.
 */
function textContrast(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!(node instanceof HTMLElement)) throw new Error(`nothing matched ${sel}`);

    type Rgba = [number, number, number, number];
    const parse = (value: string): Rgba => {
      const parts = (value.match(/[\d.]+/g) ?? []).map(Number);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    };
    /** Opacity accumulated from `from` up to the root — what dims a subtree. */
    const stackAlpha = (from: HTMLElement | null): number => {
      let alpha = 1;
      for (let el = from; el; el = el.parentElement) alpha *= Number(getComputedStyle(el).opacity);
      return alpha;
    };
    const over = (fg: number[], bg: number[], alpha: number): number[] =>
      [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha));
    const luminance = (rgb: number[]): number => {
      const [r, g, b] = rgb.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    // The page's own ground is the only surface guaranteed to be opaque.
    const ground = parse(getComputedStyle(document.body).backgroundColor);
    const groundRgb = [ground[0], ground[1], ground[2]];

    // The nearest ancestor that paints, and the opacity its group carries.
    let paint: Rgba = [0, 0, 0, 0];
    let groupAlpha = 1;
    for (let el: HTMLElement | null = node; el; el = el.parentElement) {
      const background = parse(getComputedStyle(el).backgroundColor);
      if (background[3] > 0) {
        paint = background;
        groupAlpha = stackAlpha(el);
        break;
      }
    }

    // Inside the group the ink lies over its own undimmed surface, carrying
    // only the opacity between the two; the group is then composited once.
    const inside = paint[3] > 0 ? over(paint, groundRgb, paint[3]) : groundRgb;
    const ink = parse(getComputedStyle(node).color);
    const inkAlpha = groupAlpha === 0 ? 0 : stackAlpha(node) / groupAlpha;

    const surface = over(paint, groundRgb, paint[3] * groupAlpha);
    const text = over(over(ink, inside, ink[3] * inkAlpha), groundRgb, groupAlpha);

    const [a, b] = [luminance(text), luminance(surface)];
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  }, selector);
}

test.describe('legibility the token check cannot see', () => {
  test('states why a blocked tool cannot run at readable contrast', async ({ page }) => {
    // Two PDFs: pdf-organize accepts the type but wants exactly one file.
    await page
      .locator('input[type="file"]')
      .setInputFiles([fixturePath('small.pdf'), fixturePath('small.pdf')]);

    const card = '.toolcard--blocked[data-tool="pdf-organize"]';
    await expect(page.locator(`${card} .toolcard__reason`)).toBeVisible({ timeout: 15_000 });

    // Switching the theme starts a `background-color` transition on the card,
    // and a style sampled before it settles reports the OLD surface under the
    // NEW ink. Killing transitions outright makes every reading below a settled
    // one; polling would only assert that SOME sample cleared the bar.
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });

    // BOTH themes: Playwright renders light by default, and the blocked card
    // swaps surface as well as ink, so one theme proves nothing about the other.
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });

      // The reason IS the card — a card carrying an explanation nobody can read
      // has failed at the only job it has. Dimming the card is fine; dimming the
      // sentence is not, which is why this is a composited measurement.
      const explanation = await textContrast(page, `${card} .toolcard__reason`);
      expect(explanation, `reason text in the ${colorScheme} theme`).toBeGreaterThanOrEqual(4.5);

      // Its name is de-emphasised too, but by ink, not by an `opacity` trick.
      const name = await textContrast(page, `${card} .toolcard__name`);
      expect(name, `tool name in the ${colorScheme} theme`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('seeds the control from the preset and explains it under the control', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles([fixturePath('small.pdf')]);

    // Create ZIP presets its archive name from the first file's basename.
    const pill = page.locator('.utilitypill[data-tool="zip-create"]');
    await expect(pill).toBeVisible({ timeout: 15_000 });
    await pill.click();
    await expect(page.getByRole('button', { name: 'Run' })).toBeFocused({ timeout: 15_000 });

    const row = '.opt[data-key="name"]';
    const field = page.locator(`${row} input`);
    const note = page.locator(`${row} .opt__because`);

    // THE VALUE, not just the caption. A note reading "from the first file" over
    // a field still showing the schema's "archive" is the exact failure this
    // whole preset path exists to prevent, and only the rendered value proves
    // the preset reached the control the op will read.
    await expect(field).toHaveValue('small');
    await expect(note).toHaveText('from the first file');

    // And it has to be ANNOUNCED, or the explanation is sighted-only: without a
    // description a screen reader says "Archive name, edit text, small" and
    // never says where "small" came from.
    await expect(field).toHaveAccessibleDescription('from the first file');

    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const ratio = await textContrast(page, `${row} .opt__because`);
      expect(ratio, `preset note in the ${colorScheme} theme`).toBeGreaterThanOrEqual(4.5);
    }

    // It has to span BOTH grid columns. Left in the 11rem label column it would
    // annotate the label instead of the control, and wrap three times doing it.
    const [box, label, control] = await Promise.all([
      note.boundingBox(),
      page.locator(`${row} .opt__label`).boundingBox(),
      page.locator(`${row} .opt__control`).boundingBox(),
    ]);
    expect(box && label && control).toBeTruthy();
    expect(box!.x).toBeLessThanOrEqual(label!.x + 1);
    expect(box!.x + box!.width).toBeGreaterThanOrEqual(control!.x + control!.width - 1);
  });
});
