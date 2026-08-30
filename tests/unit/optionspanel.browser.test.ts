// tests/unit/optionspanel.browser.test.ts — the rendering half of the panel.
//
// Real headless Chromium: real <input>/<select> elements, real `input`/`change`
// events, real lazily-imported editor module. Nothing about the emitted values
// is stubbed — the assertions read what a browser actually hands back.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderOptions } from '../../src/ui/optionspanel';
import type { OptionSchema, ToolDef, ToolEditor } from '../../src/types';

const SCHEMA: OptionSchema = {
  format: {
    kind: 'select',
    label: 'Format',
    choices: [
      { value: 'png', label: 'PNG' },
      { value: 'jpeg', label: 'JPEG' },
      { value: 'webp', label: 'WebP' },
    ],
    default: 'png',
  },
  dpi: { kind: 'number', label: 'Resolution (DPI)', min: 72, max: 300, step: 1, default: 150 },
  quality: { kind: 'range', label: 'Quality', min: 10, max: 100, step: 5, default: 70 },
  header: { kind: 'toggle', label: 'First row is header', default: true },
  ranges: { kind: 'text', label: 'Ranges', placeholder: '1-3,7,9-', default: '' },
};

function tool(over: Partial<ToolDef> = {}): ToolDef {
  return {
    id: 'test-tool',
    name: 'Test tool',
    blurb: 'A tool used by the panel test.',
    group: 'data',
    kind: 'utility',
    accepts: ['*'],
    minInputs: 1,
    maxInputs: null,
    options: SCHEMA,
    load: () => Promise.reject(new Error('the panel must never load the op')),
    ...over,
  };
}

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
});

function mount(over: Partial<ToolDef> = {}, extra: Record<string, unknown> = {}) {
  const onChange = vi.fn<(values: Record<string, unknown>) => void>();
  const handle = renderOptions({ tool: tool(over), files: [], onChange, ...extra });
  host.appendChild(handle.el);
  return { handle, onChange };
}

function field<T extends Element>(root: ParentNode, key: string, selector: string): T {
  const el = root.querySelector<T>(`[data-key="${key}"] ${selector}`);
  if (!el) throw new Error(`no ${selector} rendered for option "${key}"`);
  return el;
}

describe('generic schema rendering', () => {
  it('renders exactly one labelled control per schema entry', () => {
    const { handle } = mount();
    const rows = handle.el.querySelectorAll('[data-key]');
    expect(rows.length).toBe(Object.keys(SCHEMA).length);

    for (const key of Object.keys(SCHEMA)) {
      const row = handle.el.querySelector(`[data-key="${key}"]`);
      expect(row, `missing row for ${key}`).not.toBeNull();
      const controls = row!.querySelectorAll('input, select, textarea');
      expect(controls.length, `expected one control for ${key}`).toBe(1);
      const label = row!.querySelector('label');
      expect(label?.textContent).toBe(SCHEMA[key]!.label);
      expect(label?.getAttribute('for')).toBe(controls[0]!.id);
      expect(controls[0]!.id).not.toBe('');
    }
  });

  it('seeds every control from the schema default', () => {
    const { handle } = mount();
    expect(field<HTMLSelectElement>(handle.el, 'format', 'select').value).toBe('png');
    expect(field<HTMLInputElement>(handle.el, 'dpi', 'input').value).toBe('150');
    expect(field<HTMLInputElement>(handle.el, 'quality', 'input').value).toBe('70');
    expect(field<HTMLInputElement>(handle.el, 'header', 'input').checked).toBe(true);
    expect(field<HTMLInputElement>(handle.el, 'ranges', 'input').placeholder).toBe('1-3,7,9-');
    expect(handle.values()).toEqual({
      format: 'png',
      dpi: 150,
      quality: 70,
      header: true,
      ranges: '',
    });
  });

  it('emits a NUMBER, not a string, from the number input', () => {
    const { handle, onChange } = mount();
    const input = field<HTMLInputElement>(handle.el, 'dpi', 'input');
    expect(input.type).toBe('number');

    input.value = '240';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onChange).toHaveBeenCalled();
    const emitted = onChange.mock.calls.at(-1)![0];
    expect(emitted.dpi).toBe(240);
    expect(typeof emitted.dpi).toBe('number');
    expect(handle.values().dpi).toBe(240);
  });

  it('emits a NUMBER, not a string, from the range input', () => {
    const { handle, onChange } = mount();
    const input = field<HTMLInputElement>(handle.el, 'quality', 'input');
    expect(input.type).toBe('range');

    input.value = '45';
    input.dispatchEvent(new Event('input', { bubbles: true }));

    const emitted = onChange.mock.calls.at(-1)![0];
    expect(emitted.quality).toBe(45);
    expect(typeof emitted.quality).toBe('number');
    // The live readout reflects the real value, not a stale default.
    expect(field(handle.el, 'quality', 'output').textContent).toBe('45');
  });

  it('emits a BOOLEAN from the toggle and a string from select and text', () => {
    const { handle, onChange } = mount();

    const toggle = field<HTMLInputElement>(handle.el, 'header', 'input');
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange.mock.calls.at(-1)![0].header).toBe(false);

    const select = field<HTMLSelectElement>(handle.el, 'format', 'select');
    select.value = 'webp';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(onChange.mock.calls.at(-1)![0].format).toBe('webp');

    const text = field<HTMLInputElement>(handle.el, 'ranges', 'input');
    text.value = '1-3,7';
    text.dispatchEvent(new Event('input', { bubbles: true }));
    const last = onChange.mock.calls.at(-1)![0];
    expect(last.ranges).toBe('1-3,7');
    expect(typeof last.ranges).toBe('string');
  });

  it('clamps an out-of-range number instead of forwarding it', () => {
    const { handle, onChange } = mount();
    const input = field<HTMLInputElement>(handle.el, 'dpi', 'input');
    input.value = '9000';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(onChange.mock.calls.at(-1)![0].dpi).toBe(300);
  });

  it('renders nothing but a note for a tool with no options at all', () => {
    const { handle } = mount({ options: undefined });
    expect(handle.el.querySelectorAll('[data-key]').length).toBe(0);
    expect(handle.el.textContent).toMatch(/no options/i);
    expect(handle.values()).toEqual({});
  });
});

describe('unsupported choices', () => {
  it('disables a choice AND shows the reason, rather than offering it', () => {
    const reason = 'Not available — this browser cannot encode WebP';
    const { handle } = mount({}, { disabled: { format: { webp: reason } } });

    const select = field<HTMLSelectElement>(handle.el, 'format', 'select');
    const webp = [...select.options].find((o) => o.value === 'webp');
    expect(webp?.disabled).toBe(true);

    const row = handle.el.querySelector('[data-key="format"]');
    expect(row?.textContent).toContain(reason);
  });

  it('moves off a default that has been disabled', () => {
    const { handle } = mount(
      {},
      { disabled: { format: { png: 'Not available — no PNG encoder' } } },
    );
    expect(handle.values().format).toBe('jpeg');
    expect(field<HTMLSelectElement>(handle.el, 'format', 'select').value).toBe('jpeg');
  });
});

describe('presets', () => {
  it('starts each control at the preset value, not the schema default', () => {
    const { handle } = mount(
      {},
      {
        presetValues: { format: 'jpeg', dpi: 300, header: false, ranges: '1-3' },
      },
    );

    expect(field<HTMLSelectElement>(handle.el, 'format', 'select').value).toBe('jpeg');
    expect(field<HTMLInputElement>(handle.el, 'dpi', 'input').value).toBe('300');
    expect(field<HTMLInputElement>(handle.el, 'header', 'input').checked).toBe(false);
    expect(field<HTMLInputElement>(handle.el, 'ranges', 'input').value).toBe('1-3');

    // What the panel reports must agree with what it is showing.
    expect(handle.values()).toMatchObject({
      format: 'jpeg',
      dpi: 300,
      header: false,
      ranges: '1-3',
    });
  });

  it('coerces a preset like any other input rather than trusting it', () => {
    const { handle } = mount({}, { presetValues: { dpi: '9000', quality: '35' } });
    // Clamped into the schema's bounds, and a number, not the string it arrived as.
    expect(handle.values().dpi).toBe(300);
    expect(handle.values().quality).toBe(35);
    expect(typeof handle.values().quality).toBe('number');
    expect(field<HTMLOutputElement>(handle.el, 'quality', 'output').textContent).toBe('35');
  });

  it('ignores a preset naming a choice this browser cannot honour', () => {
    const { handle } = mount(
      {},
      {
        presetValues: { format: 'webp' },
        disabled: { format: { webp: 'Not available — no WebP encoder' } },
      },
    );
    expect(handle.values().format).toBe('png');
    expect(field<HTMLSelectElement>(handle.el, 'format', 'select').value).toBe('png');
  });

  it('renders the reason under the control it explains, as .opt__because', () => {
    const { handle } = mount({}, { presetBecause: { format: 'from the file extension' } });

    const note = handle.el.querySelector('[data-key="format"] .opt__because');
    expect(note?.textContent).toBe('from the file extension');
    // "chosen for you" is not "unavailable" — the two must not share a class.
    expect(handle.el.querySelectorAll('.opt__reason').length).toBe(0);
    expect(handle.el.querySelectorAll('.opt__because').length).toBe(1);
  });
});

describe('the editor escape hatch', () => {
  it('lazily imports and mounts the editor instead of the generic controls', async () => {
    const mounted: HTMLElement[] = [];
    const teardown = vi.fn();
    const editor: ToolEditor = (node, _inputs, onChange) => {
      mounted.push(node);
      node.textContent = 'bespoke editor';
      onChange({ pages: [{ index: 0, rotate: 90, keep: true }] });
      return teardown;
    };

    let imported = 0;
    const { handle, onChange } = mount({
      options: undefined,
      editor: () => {
        imported += 1;
        return Promise.resolve({ default: editor });
      },
    });

    // The import is lazy: not resolved yet at the synchronous return.
    expect(handle.el.textContent).not.toContain('bespoke editor');
    await handle.ready;

    expect(imported).toBe(1);
    expect(mounted.length).toBe(1);
    expect(handle.el.textContent).toContain('bespoke editor');
    expect(handle.el.querySelectorAll('[data-key]').length).toBe(0);

    // The editor's options reach the caller and the handle.
    expect(onChange).toHaveBeenCalled();
    expect(handle.values()).toEqual({ pages: [{ index: 0, rotate: 90, keep: true }] });

    handle.destroy();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  it('surfaces an editor that fails to load as visible text, not a throw', async () => {
    const { handle } = mount({
      options: undefined,
      editor: () => Promise.reject(new Error('chunk 404')),
    });
    await expect(handle.ready).resolves.toBeUndefined();
    expect(handle.el.textContent).toMatch(/could not be loaded/i);
  });

  it('prefers the editor over a schema when a tool declares both', async () => {
    const teardown = vi.fn();
    const { handle } = mount({
      editor: () => Promise.resolve({ default: () => teardown }),
    });
    await handle.ready;
    expect(handle.el.querySelectorAll('[data-key]').length).toBe(0);
  });
});
