// Keep result rendering off the first-paint path, with one stable landmark.
import { el } from './dom';
import type { ResultsHandle, ResultsInit, ResultsView } from './results';

export function createResultsHost(init: ResultsInit): ResultsHandle {
  const root = el('section', 'results');
  root.hidden = true;
  root.setAttribute('aria-label', 'Results');
  let renderer: ResultsHandle | null = null;
  let generation = 0;

  async function show(view: ResultsView): Promise<void> {
    const current = ++generation;
    try {
      const { createResults } = await import('./results');
      if (current !== generation) return;
      renderer ??= createResults({ ...init, mount: root });
      await renderer.show(view);
    } catch {
      if (current !== generation) return;
      renderer?.clear();
      renderer = null;
      root.removeAttribute('aria-labelledby');
      root.hidden = false;
      const retry = el('button', 'btn btn--ghost btn--sm', 'Retry results');
      retry.type = 'button';
      retry.addEventListener('click', () => {
        if (current === generation) void show(view);
      });
      root.replaceChildren(el('p', 'results__note', 'The results view could not be displayed. Your result is still in this tab.'), retry);
    }
  }

  return {
    el: root,
    show,
    clear() {
      generation += 1;
      renderer?.clear();
      root.hidden = true;
      if (!renderer) root.replaceChildren();
    },
    revealOutput: (name) => renderer?.revealOutput(name),
  };
}
