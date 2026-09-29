// Loaded only when a result is used in another tool. Owns one reversible handoff.
import { accepts, sniffType } from '../core/format';
import type { OpOutput, ToolDef } from '../types';
import { el, icon, iconButton } from './dom';
import { createPalette, type PaletteHandle } from './palette';
import type { FileEntry } from './state';

type Inputs = { entries: FileEntry[]; toolId: string | null };

export type ResultReuseHandle = {
  choose(outputs: readonly OpOutput[]): void;
  close(): void;
  forget(): void;
  setRunning(running: boolean): void;
  destroy(): void;
};

export function createResultReuse(init: {
  mount: HTMLElement;
  tools: readonly ToolDef[];
  capture(): Inputs;
  apply(inputs: Inputs): Promise<void>;
  isRunning(): boolean;
  announce(message: string): void;
  focusInput(): void;
}): ResultReuseHandle {
  const { mount, announce } = init;
  let picker: PaletteHandle | null = null;
  let previous: Inputs | null = null;
  let destroyed = false;
  mount.className = 'reuse-notice';
  mount.hidden = true;
  mount.replaceChildren();
  const message = el('p', 'reuse-notice__message');
  const undo = el('button', 'btn btn--ghost btn--sm', 'Undo');
  undo.type = 'button';
  undo.setAttribute('aria-label', 'Undo result reuse');
  const dismiss = iconButton('close', 'Dismiss result reuse notice', 'btn btn--quiet btn--sm');
  mount.append(icon('check'), message, undo, dismiss);

  function close(): void {
    picker?.close();
  }

  function forget(): void {
    previous = null;
    mount.hidden = true;
    close();
  }

  dismiss.addEventListener('click', () => {
    forget();
    init.focusInput();
  });
  undo.addEventListener('click', () => {
    if (!previous || init.isRunning()) return;
    const restore = previous;
    forget();
    void init.apply(restore).then(() => {
      if (!destroyed) announce('Previous files restored, in their original order.');
    });
  });

  async function use(outputs: readonly OpOutput[], types: string[], tool: ToolDef): Promise<void> {
    if (destroyed || init.isRunning()) return;
    let entries: FileEntry[];
    try {
      // File owns a snapshot. Allocate before mutating any current inputs.
      entries = outputs.map((output, index) => ({
        file: new File([output.buffer], output.name, { type: types[index] }),
        type: types[index]!,
      }));
    } catch {
      announce('These results could not be opened as inputs. Download them and try adding fewer files.');
      return;
    }
    const original = init.capture();
    previous = original;
    message.textContent = `${entries.length === 1 ? 'Result loaded' : `${entries.length} results loaded`}. Your previous files are available with Undo.`;
    mount.hidden = false;
    await init.apply({ entries, toolId: tool.id });
    if (!destroyed && previous === original && init.capture().toolId === tool.id) {
      announce(`${tool.name} is ready with ${entries.length} result ${entries.length === 1 ? 'file' : 'files'}. Review the settings, then run. Undo restores the previous files.`);
    }
  }

  return {
    close,
    forget,
    setRunning: (running) => { undo.disabled = running; },
    choose(outputs) {
      if (destroyed || init.isRunning() || outputs.length === 0) return;
      close();
      const types = outputs.map((output) => sniffType(output.buffer, output.name));
      // Workspaces own sources and need side-specific import, not tray replacement.
      const compatible = init.tools.filter((tool) =>
        !tool.workspace && tool.kind !== 'generate' && accepts(tool, types),
      );
      const count = outputs.length;
      const current = createPalette({
        title: count === 1 ? 'Use this result' : `Use ${count} results`,
        description: `${count === 1 ? outputs[0]!.name : `${count} files, in result order`}. Choose the next tool. This replaces the files in your tray; Undo restores them.`,
        tools: compatible,
        unavailableReason: () => null,
        refuses: () => false,
        announce,
        onClose: () => {
          current.destroy();
          if (picker === current) picker = null;
        },
        onRun: (tool) => void use(outputs, types, tool),
      });
      picker = current;
      document.body.append(current.el);
      current.open();
    },
    destroy() {
      destroyed = true;
      close();
      previous = null;
      mount.replaceChildren();
      mount.hidden = true;
    },
  };
}
