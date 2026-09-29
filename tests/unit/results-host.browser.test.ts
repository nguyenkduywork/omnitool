import { afterEach, describe, expect, it, vi } from 'vitest';
import { createResultsHost } from '../../src/ui/results-host';
import type { ResultsView } from '../../src/ui/results';

const view = (name = 'result.txt', type = 'text/plain'): ResultsView => ({
  toolName: 'Test output',
  inputs: [],
  result: {
    outputs: [{ name, type, buffer: new TextEncoder().encode('test bytes').buffer }],
    results: [],
    partial: false,
  },
});

afterEach(() => vi.restoreAllMocks());

describe('lazy results lifecycle', () => {
  it('does not resurrect results after clear while the module is loading', async () => {
    const host = createResultsHost({});
    const pending = host.show(view());
    host.clear();
    await pending;
    expect(host.el.hidden).toBe(true);
    expect(host.el.childElementCount).toBe(0);
  });

  it('only paints the latest view when show calls overlap', async () => {
    const host = createResultsHost({});
    await Promise.all([host.show(view('old.txt')), host.show(view('new.txt'))]);
    expect(host.el.querySelector('.card__name')?.textContent).toBe('new.txt');
    expect(host.el.querySelectorAll('.card--output')).toHaveLength(1);
    host.clear();
  });

  it('rebuilds the renderer after preview creation fails and preserves the result for retry', async () => {
    const host = createResultsHost({});
    document.body.append(host.el);
    const fail = vi.spyOn(URL, 'createObjectURL').mockImplementationOnce(() => {
      throw new Error('preview allocation failed');
    });
    try {
      await host.show(view('picture.png', 'image/png'));
      expect(host.el.textContent).toContain('Your result is still in this tab');
      fail.mockRestore();
      host.el.querySelector<HTMLButtonElement>('button')!.click();
      await expect.poll(() => host.el.querySelector('.card__name')?.textContent).toBe('picture.png');
      expect(host.el.querySelector('.card__head button')?.textContent).toContain('Download');
      expect(host.el.querySelectorAll('.card--output')).toHaveLength(1);
      host.el.querySelector<HTMLButtonElement>('.card__preview')!.click();
      expect(document.querySelector('dialog[open]')).not.toBeNull();
      await expect.poll(() => document.querySelector('dialog')?.textContent).toContain('could not be previewed');
      host.clear();
      expect(document.querySelector('dialog')).toBeNull();
    } finally {
      host.clear();
      host.el.remove();
    }
  });
});
