import { afterEach, expect, it } from 'vitest';
import workspace from '../../src/tools/data/text-diff.workspace';
import { createDropzone } from '../../src/ui/dropzone';
import type { ToolWorkspaceHandle } from '../../src/types';

let mount: HTMLElement | null = null;
let handle: ToolWorkspaceHandle | null = null;
let dropzone: ReturnType<typeof createDropzone> | null = null;
afterEach(() => {
  handle?.destroy();
  dropzone?.destroy();
  mount?.remove();
  mount = null; handle = null; dropzone = null;
});

it('clears global drag depth after an inner source drop without adding it to the tray', () => {
  const delivered: File[][] = [];
  dropzone = createDropzone({ onFiles: (files) => delivered.push(files) });
  mount = document.createElement('div');
  document.body.append(mount);
  handle = workspace(mount, { announce: () => undefined, onRun: () => undefined });
  handle.activate([]);
  const file = new File(['source'], 'source.txt', { type: 'text/plain' });
  const transfer = new DataTransfer();
  transfer.items.add(file);
  const fire = (target: EventTarget, type: string) =>
    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
  const side = mount.querySelector('.tdw__source')!;
  fire(side, 'dragenter');
  fire(side, 'dragenter');
  expect(document.documentElement.classList.contains('is-dragging')).toBe(true);
  fire(side, 'drop');
  expect(delivered).toHaveLength(0);
  expect(document.documentElement.classList.contains('is-dragging')).toBe(false);
  fire(side, 'dragleave');
  expect(document.documentElement.classList.contains('is-dragging')).toBe(false);
  fire(document.body, 'dragenter');
  expect(document.documentElement.classList.contains('is-dragging')).toBe(true);
  fire(document.body, 'drop');
  expect(delivered).toHaveLength(1);
  expect(delivered[0]?.[0]?.name).toBe('source.txt');
  expect(document.documentElement.classList.contains('is-dragging')).toBe(false);
});
