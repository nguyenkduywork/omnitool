import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import workspace from '../../src/tools/data/text-diff.workspace';
import { TextDiffLive } from '../../src/tools/data/text-diff.live';
import type { ToolWorkspaceHandle } from '../../src/types';

const OLD = 'function total(items) {\n  return items.length;\n}\n';
const NEW = 'function total(items) {\n  return items.length * 2;\n}\n';
const file = (name: string, text: string) => new File([text], name, { type: 'text/plain' });
let mount: HTMLElement;
let handle: ToolWorkspaceHandle;
let onRun: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mount = document.createElement('div');
  document.body.append(mount);
  onRun = vi.fn();
  handle = workspace(mount, { announce: () => undefined, onRun });
});
afterEach(() => { handle.destroy(); mount.remove(); });

const control = (name: string) => [...mount.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name)!;
const boxes = () => mount.querySelectorAll<HTMLTextAreaElement>('.tdw__textarea');
async function ready(): Promise<void> {
  await vi.waitFor(() => expect(mount.querySelector('.tdw__stats')?.textContent).toMatch(/change groups?/), { timeout: 10_000 });
}
function type(side: 0 | 1, value: string): void {
  const box = boxes()[side]!;
  box.value = value;
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('source-owning Text Diff workspace', () => {
  it('mounts with a readiness marker and retains raw CRLF files for export', async () => {
    handle.activate([file('old.txt', OLD.replace(/\n/g, '\r\n')), file('new.txt', NEW)]);
    expect(mount.querySelector('.tdw')?.getAttribute('data-ready')).toBe('true');
    await ready();
    control('Review changes').click();
    await vi.waitFor(() => expect(mount.querySelector('.tdw__mark')?.textContent).toBe(' * 2'));
    expect(mount.querySelector('.tdw__identities')?.textContent).toContain('CRLF');
    const run = handle.prepareRun('html');
    expect(run.files).toEqual([]);
    expect((run.options.comparisonSnapshot as { sources: { text: string }[] }).sources[0]?.text).toContain('\r\n');
    expect(run.inputs[0]?.name).toBe('old.txt');
  });

  it('warns before a native edit normalizes a CRLF file and retains raw source until then', async () => {
    const original = 'alpha\r\nold\r\n';
    handle.activate([file('old.txt', original), file('new.txt', 'alpha\nnew\n')]);
    await ready();
    const warning = mount.querySelectorAll<HTMLElement>('.tdw__source > .tdw__source-warning')[0]!;
    expect(warning.hidden).toBe(false);
    expect(warning.textContent).toMatch(/converts.*CRLF.*LF/);
    expect(boxes()[0]!.value).toBe('alpha\nold\n');
    expect((handle.prepareRun('html').options.comparisonSnapshot as { sources: { text: string }[] }).sources[0]!.text).toBe(original);
    type(0, 'alpha\nedit\n');
    await vi.waitFor(() => expect((handle.prepareRun('html').options.comparisonSnapshot as { sources: { text: string }[] }).sources[0]!.text).toBe('alpha\nedit\n'));
    expect(warning.hidden).toBe(true);
  });

  it('accepts one file before the second source and supports explicit empty', async () => {
    handle.activate([file('old.txt', OLD)]);
    await vi.waitFor(() => expect(boxes()[0]?.value).toContain('function total'));
    expect(() => handle.prepareRun('html')).toThrow();
    [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Use empty text')[1]!.click();
    await ready();
    expect(handle.prepareRun('html').revision).toBeGreaterThan(0);
  });

  it('validates rapid independent text edits without losing either side', async () => {
    handle.activate([]);
    type(0, OLD);
    type(1, NEW);
    await ready();
    const sources = (handle.prepareRun('html').options.comparisonSnapshot as { sources: { text: string }[] }).sources;
    expect(sources.map((source) => source.text)).toEqual([OLD, NEW]);
  });

  it('disables export immediately on edit, then permits the accepted revision', async () => {
    handle.activate([file('old.txt', OLD), file('new.txt', NEW)]);
    await ready();
    type(1, NEW + 'extra\n');
    expect(() => handle.prepareRun('html')).toThrow();
    expect([...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Copy source')[1]?.disabled).toBe(true);
    await vi.waitFor(() => expect(handle.prepareRun('html').revision).toBeGreaterThan(0), { timeout: 10_000 });
  });

  it('preserves accepted source after a failed replacement and undoes clear', async () => {
    handle.activate([file('old.txt', OLD), file('new.txt', NEW)]);
    await ready();
    const picker = mount.querySelectorAll<HTMLInputElement>('input[type=file]')[0]!;
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File([new Uint8Array([0xff])], 'broken.txt', { type: 'text/plain' })] });
    picker.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(mount.querySelector('.tdw__source-status--error')?.textContent).toContain('broken.txt'));
    expect(boxes()[0]?.value).toBe(OLD);
    [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Clear')[0]!.click();
    expect(boxes()[0]?.value).toBe('');
    [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Undo')[0]!.click();
    expect(boxes()[0]?.value).toBe(OLD);
  });

  it('swaps sources and retains them through deactivate and return', async () => {
    handle.activate([file('old.txt', OLD), file('new.txt', NEW)]);
    await ready();
    control('Swap Original and Revised').click();
    await vi.waitFor(() => expect(handle.prepareRun('html').inputs[0]?.name).toBe('new.txt'));
    handle.deactivate();
    handle.activate([]);
    await vi.waitFor(() => expect(handle.prepareRun('html').inputs[0]?.name).toBe('new.txt'));
    expect(boxes()[0]?.value).toBe(NEW);
  });

  it('restores pending visible text when Clear is undone before validation', async () => {
    handle.activate([]);
    type(0, 'draft before validation');
    [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Clear')[0]!.click();
    expect(boxes()[0]?.value).toBe('');
    [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Undo')[0]!.click();
    expect(boxes()[0]?.value).toBe('draft before validation');
    await vi.waitFor(() => expect(mount.querySelector('.tdw__source-status')?.textContent).toContain('Text'));
  });

  it('keeps invalid text visible but blocked from comparison and export', async () => {
    handle.activate([file('old.txt', OLD), file('new.txt', NEW)]);
    await ready();
    type(0, '\ud800');
    await vi.waitFor(() => expect(mount.querySelector('.tdw__source-status--error')?.textContent).toMatch(/could not be read/i));
    expect(boxes()[0]?.value).toBe('\ud800');
    expect([...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Copy source')[0]?.disabled).toBe(true);
    expect(control('Compare now').disabled).toBe(true);
    expect(() => handle.prepareRun('html')).toThrow();
    type(0, OLD);
    await vi.waitFor(() => expect(handle.prepareRun('html').revision).toBeGreaterThan(0));
  });

  it('can clear an invalid first paste without resetting the other side', async () => {
    handle.activate([]);
    type(0, '\ud800');
    await vi.waitFor(() => expect(mount.querySelector('.tdw__source-status--error')).not.toBeNull());
    const clear = [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Clear')[0]!;
    expect(clear.disabled).toBe(false);
    clear.click();
    expect(boxes()[0]?.value).toBe('');
    expect(mount.querySelectorAll('.tdw__source-status--error')).toHaveLength(0);
  });

  it('retains expanded review context through a route-style deactivation', async () => {
    const lines = Array.from({ length: 140 }, (_, row) => `line-${row}`);
    handle.activate([file('a.txt', lines.join('\n')), file('b.txt', [...lines.slice(0, -1), 'changed'].join('\n'))]);
    await ready();
    control('Review changes').click();
    await vi.waitFor(() => expect(mount.querySelector('.tdw__gap button')).not.toBeNull());
    (mount.querySelector('.tdw__gap button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(mount.querySelectorAll('.tdw__row').length).toBeGreaterThan(50));
    const before = mount.querySelectorAll('.tdw__row').length;
    handle.deactivate();
    handle.activate([]);
    await vi.waitFor(() => expect(handle.prepareRun('html').revision).toBeGreaterThan(0));
    await vi.waitFor(() => expect(mount.querySelectorAll('.tdw__row').length).toBe(before));
  });

  it('can return to row zero after a late hunk jump and Whole file context', async () => {
    const lines = Array.from({ length: 4_300 }, (_, row) => `line-${row}`);
    handle.activate([file('a.txt', lines.join('\n')), file('b.txt', lines.map((line, row) => row === 4_100 ? 'changed' : line).join('\n'))]);
    await ready();
    control('Review changes').click();
    control('Next change').click();
    await vi.waitFor(() => expect(mount.querySelector('[data-row="4100"]')).not.toBeNull());
    const context = mount.querySelectorAll<HTMLSelectElement>('.tdw__options select')[1]!;
    context.value = 'whole';
    context.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(control('First page').disabled).toBe(false));
    control('First page').click();
    await vi.waitFor(() => expect(mount.querySelector('[data-row="0"]')).not.toBeNull());
  });

  it('shows both raw variants of a normalized-equal line in Unified view', async () => {
    handle.activate([file('a.txt', ' value\n'), file('b.txt', 'value\n')]);
    await ready();
    control('Review changes').click();
    const whitespace = [...mount.querySelectorAll<HTMLLabelElement>('.tdw__check')].find((item) => item.textContent?.includes('Ignore whitespace'))!;
    whitespace.querySelector('input')!.click();
    await vi.waitFor(() => expect(mount.querySelector('.tdw__row--normalized')).not.toBeNull());
    const layout = mount.querySelector<HTMLSelectElement>('.tdw__toolbar select')!;
    layout.value = 'unified';
    layout.dispatchEvent(new Event('change', { bubbles: true }));
    const revised = mount.querySelector<HTMLElement>('.tdw__row--normalized .tdw__half--b')!;
    expect(getComputedStyle(revised).display).not.toBe('none');
    expect(revised.textContent).toContain('value');
  });

  it('routes export controls through the host', async () => {
    handle.activate([file('old.txt', OLD), file('new.txt', NEW)]);
    await ready();
    control('Review changes').click();
    control('Export').click();
    control('Download report').click();
    control('Download patch').click();
    expect(onRun.mock.calls.map((call) => call[0])).toEqual(['html', 'unified']);
  });

  it('copies the exact accepted source and exposes a reachable fallback when clipboard access is blocked', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn<Navigator['clipboard']['writeText']>().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      handle.activate([file('old.txt', OLD), file('new.txt', NEW)]);
      await ready();
      [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Copy source')[0]!.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(OLD));

      writeText.mockRejectedValueOnce(new Error('blocked'));
      [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Copy source')[1]!.click();
      await vi.waitFor(() => expect(mount.querySelector<HTMLElement>('.tdw__copy-fallback')?.hidden).toBe(false));
      expect(mount.querySelector('.tdw__copy-fallback')?.textContent).toBe(NEW);
      expect(mount.querySelector<HTMLElement>('.tdw__review')?.hidden).not.toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('invalidates immediately during IME composition and compares only the committed text', async () => {
    handle.activate([file('old.txt', OLD), file('new.txt', NEW)]);
    await ready();
    const box = boxes()[1]!;
    box.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    box.value = 'interim IME text';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    expect(() => handle.prepareRun('html')).toThrow();
    expect(control('Compare now').disabled).toBe(true);
    box.value = NEW + 'committed\n';
    box.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await vi.waitFor(() => expect(handle.prepareRun('html').revision).toBeGreaterThan(0));
    expect(handle.prepareRun('html').options.comparisonSnapshot).toMatchObject({
      sources: [{ text: OLD }, { text: NEW + 'committed\n' }],
    });
  });

  it('defers a file over the line threshold while preserving exact CRLF copy and export', async () => {
    const raw = Array.from({ length: 6_001 }, (_, row) => `line-${row}\r\n`).join('');
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn<Navigator['clipboard']['writeText']>().mockResolvedValue();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      handle.activate([file('many.txt', raw)]);
      await vi.waitFor(() => expect(mount.querySelector('.tdw__source-status')?.textContent).toContain('bounded preview'));
      expect(boxes()[0]?.hidden).toBe(true);
      expect(boxes()[0]?.value).toBe('');
      expect(mount.querySelector('.tdw__source-preview')?.textContent?.length).toBeLessThan(1_200);
      expect(mount.querySelector('.tdw__source-preview')?.textContent).toContain('line-0');
      const warning = mount.querySelectorAll<HTMLElement>('.tdw__source > .tdw__source-warning')[0]!;
      expect(warning.hidden).toBe(false);
      expect(warning.textContent).toMatch(/converts.*CRLF.*LF/);
      [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Copy source')[0]!.click();
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(raw));
      [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Use empty text')[1]!.click();
      await ready();
      const before = handle.prepareRun('html');
      expect((before.options.comparisonSnapshot as { sources: { text: string }[] }).sources[0]?.text).toBe(raw);
      [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Load full text for editing')[0]!.click();
      expect(boxes()[0]?.hidden).toBe(false);
      expect(boxes()[0]?.value).toContain('line-0\nline-1');
      expect(warning.hidden).toBe(false);
      expect(handle.prepareRun('html').revision).toBe(before.revision);
      expect((handle.prepareRun('html').options.comparisonSnapshot as { sources: { text: string }[] }).sources[0]?.text).toBe(raw);
      type(0, 'edited\n');
      expect(() => handle.prepareRun('html')).toThrow();
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('preserves deferred presentation through swap, failed replacement, clear, undo, and route return', async () => {
    const raw = 'one\n'.repeat(6_001);
    handle.activate([file('many.txt', raw), file('small.txt', NEW)]);
    await ready();
    expect(boxes()[0]?.hidden).toBe(true);
    control('Swap Original and Revised').click();
    expect(boxes()[1]?.hidden).toBe(true);
    const picker = mount.querySelectorAll<HTMLInputElement>('input[type=file]')[1]!;
    Object.defineProperty(picker, 'files', { configurable: true, value: [new File([new Uint8Array([0xff])], 'bad.txt', { type: 'text/plain' })] });
    picker.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(mount.querySelector('.tdw__source-status--error')?.textContent).toContain('bad.txt'));
    expect(boxes()[1]?.hidden).toBe(true);
    [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Clear')[1]!.click();
    expect(boxes()[1]?.hidden).toBe(false);
    [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Undo')[1]!.click();
    expect(boxes()[1]?.hidden).toBe(true);
    handle.deactivate();
    handle.activate([]);
    expect(boxes()[1]?.hidden).toBe(true);
    expect(mount.querySelectorAll('.tdw__source-preview')[1]?.textContent).toContain('one');
  });

  it('defers a long single-line file and a denied large manual copy until explicit load', async () => {
    const raw = '😀' + 'x'.repeat(300_001);
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    const writeText = vi.fn<Navigator['clipboard']['writeText']>().mockRejectedValue(new Error('blocked'));
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      handle.activate([file('long.txt', raw)]);
      await vi.waitFor(() => expect(boxes()[0]?.hidden).toBe(true));
      expect(mount.querySelector('.tdw__source-preview')?.textContent?.length).toBeLessThan(1_200);
      [...mount.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Copy source')[0]!.click();
      await vi.waitFor(() => expect(mount.querySelector('.tdw__copy-fallback button')).not.toBeNull());
      expect(mount.querySelector('.tdw__copy-fallback')?.textContent?.length).toBeLessThan(300);
      expect(writeText).toHaveBeenCalledWith(raw);
      (mount.querySelector('.tdw__copy-fallback button') as HTMLButtonElement).click();
      expect(mount.querySelector('.tdw__copy-fallback')?.textContent).toBe(raw);
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('clears Find marks and ignores a response that arrives after the query was cleared', async () => {
    handle.activate([file('a.txt', 'old\n'), file('b.txt', 'new\n')]);
    await ready();
    control('Review changes').click();
    control('Find').click();
    const input = mount.querySelector<HTMLInputElement>('.tdw__find-input')!;
    input.value = 'old';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(mount.querySelector('.tdw__match')).not.toBeNull());
    input.value = 'absent';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await vi.waitFor(() => expect(mount.querySelector('.tdw__find .tdw__position')?.textContent).toBe('No matches'));
    expect(mount.querySelector('.tdw__match')).toBeNull();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(mount.querySelector('.tdw__match')).toBeNull();

    let reply: ((value: Awaited<ReturnType<TextDiffLive['find']>>) => void) | undefined;
    const spy = vi.spyOn(TextDiffLive.prototype, 'find').mockImplementation(() => new Promise((resolve) => { reply = resolve; }));
    try {
      input.value = 'old';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await vi.waitFor(() => expect(reply).toBeTypeOf('function'));
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      reply!({ kind: 'find', revision: 1, requestId: 1, matchCount: 1, ordinal: 0,
        range: { side: 'a', start: 0, end: 3 }, row: 0, cursor: { row: 0, aOffset: 0, bOffset: 0 } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(mount.querySelector('.tdw__match')).toBeNull();
      expect(mount.querySelector('.tdw__find .tdw__position')?.textContent).toBe('');
    } finally { spy.mockRestore(); }
  });
});
