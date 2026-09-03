// tests/unit/text-diff.browser.test.ts — the comparison view.
//
// Real headless Chromium, because the editor is real DOM: real `File`s, a real
// `TextDecoder` refusing real invalid UTF-8, real click handlers. The op is
// covered in tests/unit/diff.test.ts under Node; what is checked here is the
// half a person actually uses — that the differences are VISIBLE, that the
// options the editor emits are the ones the op validates, and that nothing
// here depends on being able to tell green from red.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import editor from '../../src/tools/data/text-diff.editor';

const OLD = ['function total(items) {', '  return items.length;', '}', ''].join('\n');
const NEW = ['function total(items) {', '  return items.length * 2;', '}', ''].join('\n');

function file(name: string, text: string): File {
  return new File([text], name, { type: 'text/plain' });
}

let host: HTMLElement;
let teardown: (() => void) | null = null;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  teardown?.();
  teardown = null;
  host.remove();
});

/** Mount, and wait for the files to be read and the first render to land. */
async function mount(
  files: File[],
  onChange: (values: Record<string, unknown>) => void = () => {},
): Promise<void> {
  teardown = editor(host, files, onChange);
  await vi.waitFor(() => {
    expect(host.querySelector('.tdiff__grid, .tdiff__notice--warn')).not.toBeNull();
  });
}

const rows = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>('.tdiff__row')];
const text = (selector: string): string => host.querySelector(selector)?.textContent ?? '';

describe('the comparison view', () => {
  it('shows the changed line, and marks only the tokens inside it', async () => {
    await mount([file('old.js', OLD), file('new.js', NEW)]);

    const marks = [...host.querySelectorAll('.tdiff__mark')].map((node) => node.textContent);
    // Not "line 2 changed" — only what actually moved. Neighbouring changed
    // tokens come back as one mark, so this is the whole inserted run.
    expect(marks).toEqual([' * 2']);
    expect(host.textContent).toContain('return items.length');
  });

  it('counts what changed, in the summary', async () => {
    await mount([file('old.js', OLD), file('new.js', NEW)]);

    expect(text('.tdiff__stats')).toContain('1 changed');
    expect(text('.tdiff__stats')).toContain('0 added');
  });

  it('marks every changed row with a sign, not only a colour', async () => {
    // WCAG 1.4.1: colour can never be the only carrier. Someone who cannot
    // separate the green from the red still has +, - and ~.
    await mount([file('a.txt', 'keep\ngone\n'), file('b.txt', 'keep\nnew line\nextra\n')]);

    const changed = rows().filter(
      (row) =>
        !row.classList.contains('tdiff__row--equal') && !row.classList.contains('tdiff__row--gap'),
    );
    expect(changed.length).toBeGreaterThan(0);
    for (const row of changed) {
      const signs = [...row.querySelectorAll('.tdiff__sign')].map((node) =>
        node.textContent?.trim(),
      );
      expect(signs.filter((sign) => sign === '+' || sign === '−' || sign === '~')).toHaveLength(1);
    }
  });

  it('says a line-ending-only difference is exactly that', async () => {
    await mount([file('unix.txt', 'a\nb\n'), file('dos.txt', 'a\r\nb\r\n')]);
    expect(text('.tdiff__notices')).toContain('line endings');
  });

  it('says when two files are identical rather than showing a blank view', async () => {
    await mount([file('a.txt', OLD), file('b.txt', OLD)]);
    expect(text('.tdiff__notices')).toContain('identical');
    expect(text('.tdiff__nav')).toContain('No changes');
  });

  it('refuses a file that is not text, in the view rather than on the console', async () => {
    const binary = new File([new Uint8Array([0xff, 0xfe, 0x00, 0x01])], 'photo.png');
    await mount([file('a.txt', OLD), binary]);
    expect(text('.tdiff__notices')).toContain('not valid UTF-8');
  });

  it('folds a long unchanged run away, and opens it again on request', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const a = `${lines.join('\n')}\n`;
    const b = `${lines.map((line, i) => (i === 40 ? 'CHANGED' : line)).join('\n')}\n`;
    await mount([file('a.txt', a), file('b.txt', b)]);

    const before = rows().length;
    const expander = host.querySelector<HTMLButtonElement>('.tdiff__expand');
    expect(expander).not.toBeNull();
    expect(expander?.textContent).toMatch(/Show \d+ unchanged lines/);

    expander?.click();
    expect(rows().length).toBeGreaterThan(before);
  });

  it('steps through the changes, and says which one it is on', async () => {
    const a = `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const b = a.replace('line 5', 'FIVE').replace('line 30', 'THIRTY');
    await mount([file('a.txt', a), file('b.txt', b)]);

    expect(text('.tdiff__pos')).toBe('2 changes');
    const [, next] = host.querySelectorAll<HTMLButtonElement>('.tdiff__btn--icon');
    next?.click();
    expect(text('.tdiff__pos')).toBe('Change 1 of 2');
    next?.click();
    expect(text('.tdiff__pos')).toBe('Change 2 of 2');
    expect(host.querySelectorAll('.is-current')).toHaveLength(1);
  });

  it('keeps your place through the changes when the rows are rebuilt', async () => {
    const a = `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const b = a.replace('line 5', 'FIVE').replace('line 30', 'THIRTY');
    await mount([file('a.txt', a), file('b.txt', b)]);

    const [, next] = host.querySelectorAll<HTMLButtonElement>('.tdiff__btn--icon');
    next?.click();
    next?.click();
    expect(text('.tdiff__pos')).toBe('Change 2 of 2');

    // Opening a folded region rebuilds every row, but it cannot change how
    // many changes there are — so the position, and its highlight, stay.
    host.querySelector<HTMLButtonElement>('.tdiff__expand')?.click();
    expect(text('.tdiff__pos')).toBe('Change 2 of 2');
    expect(host.querySelectorAll('.is-current')).toHaveLength(1);
  });

  it('switches to side by side without losing the comparison', async () => {
    await mount([file('old.js', OLD), file('new.js', NEW)]);
    expect(host.querySelector('.tdiff__grid--unified')).not.toBeNull();

    const split = [...host.querySelectorAll<HTMLButtonElement>('.tdiff__segbtn')].find(
      (button) => button.textContent === 'Side by side',
    );
    split?.click();

    expect(host.querySelector('.tdiff__grid--split')).not.toBeNull();
    expect(split?.getAttribute('aria-pressed')).toBe('true');
    // Both sides of the rewritten line are now on one row.
    const replaced = host.querySelector('.tdiff__row--replace');
    expect(replaced?.querySelector('.tdiff__code--a')?.textContent).toContain('items.length;');
    expect(replaced?.querySelector('.tdiff__code--b')?.textContent).toContain('items.length * 2;');
  });

  it('re-compares when whitespace is told not to count', async () => {
    const onChange = vi.fn();
    await mount([file('a.js', OLD), file('b.js', OLD.replace('  return', '\t\treturn'))], onChange);
    expect(text('.tdiff__stats')).toContain('1 changed');

    const box = [...host.querySelectorAll<HTMLElement>('.tdiff__check')].find((label) =>
      label.textContent?.includes('Ignore whitespace'),
    );
    box?.querySelector('input')?.click();

    await vi.waitFor(() => expect(text('.tdiff__notices')).toContain('identical'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ ignoreWhitespace: true }));
  });

  it('emits exactly the options the op validates, from the first render', async () => {
    const onChange = vi.fn();
    await mount([file('a.txt', OLD), file('b.txt', NEW)], onChange);

    expect(onChange).toHaveBeenCalled();
    expect(Object.keys(onChange.mock.calls[0]?.[0] ?? {}).sort()).toEqual([
      'context',
      'format',
      'ignoreCase',
      'ignoreWhitespace',
      'scope',
      'swap',
    ]);
  });

  it('keeps the export in step with the view: swapping sides swaps the option', async () => {
    const onChange = vi.fn();
    await mount([file('old.js', OLD), file('new.js', NEW)], onChange);
    expect(text('.tdiff__files')).toBe('old.js → new.js');

    const swap = [...host.querySelectorAll<HTMLButtonElement>('.tdiff__btn')].find(
      (button) => button.textContent === 'Swap sides',
    );
    swap?.click();

    await vi.waitFor(() => expect(text('.tdiff__files')).toBe('new.js → old.js'));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ swap: true }));
  });

  it('asks for a patch file when the export select says so', async () => {
    const onChange = vi.fn();
    await mount([file('a.txt', OLD), file('b.txt', NEW)], onChange);

    const select = host.querySelector<HTMLSelectElement>('.tdiff__select');
    expect(select).not.toBeNull();
    (select as HTMLSelectElement).value = 'unified';
    select?.dispatchEvent(new Event('change', { bubbles: true }));

    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ format: 'unified' }));
  });

  it('sends the whole file to the report when the scope says whole file', async () => {
    const onChange = vi.fn();
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    await mount(
      [
        file('a.txt', `${lines.join('\n')}\n`),
        file('b.txt', `${lines.map((l, i) => (i === 20 ? 'X' : l)).join('\n')}\n`),
      ],
      onChange,
    );
    expect(host.querySelector('.tdiff__expand')).not.toBeNull();

    const whole = [...host.querySelectorAll<HTMLButtonElement>('.tdiff__segbtn')].find(
      (button) => button.textContent === 'Whole file',
    );
    whole?.click();

    expect(host.querySelector('.tdiff__expand')).toBeNull();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'whole' }));
  });

  it('leaves nothing behind when it is torn down', async () => {
    await mount([file('a.txt', OLD), file('b.txt', NEW)]);
    teardown?.();
    teardown = null;
    expect(host.childElementCount).toBe(0);
  });
});
