// src/ui/optionspanel.ts — renders ANY OptionSchema to controls, generically.
//
// Nothing in here knows what a tool does. A schema entry becomes one labelled
// control; the control's value is coerced back to the schema's declared TYPE
// before it reaches the caller. That coercion is the whole point of this module:
// `<input type="number">.value` is a STRING, and an op that receives "150"
// where it expected 150 fails in ways that are miserable to trace. Numbers
// leave here as numbers, toggles as booleans, and nothing else.
//
// A tool that cannot express itself declaratively supplies `editor` instead
// (§4.1). That module is imported LAZILY — it never sits in the initial bundle —
// mounted into the same panel, and its teardown is called on destroy.

import type { OptionDef, OptionSchema, ToolDef } from '../types';
import { el } from './dom';

/** key -> choice value -> the reason it cannot be used. Shown, not hidden. */
export type DisabledChoices = Record<string, Record<string, string>>;

export type OptionsHandle = {
  readonly el: HTMLElement;
  /** Resolves once a lazily-imported editor has mounted (immediately if none). */
  readonly ready: Promise<void>;
  /** The current, correctly typed option values. */
  values(): Record<string, unknown>;
  /** Unmount: calls a mounted editor's teardown. */
  destroy(): void;
};

export type RenderOptionsInit = {
  tool: ToolDef;
  /** Passed straight through to a bespoke editor. */
  files: File[];
  onChange: (values: Record<string, unknown>) => void;
  /** Choices this browser cannot honour, with a reason to show the user. */
  disabled?: DisabledChoices;
  /** option key -> a value derived from the files, to start the control at. */
  presetValues?: Record<string, unknown>;
  /** option key -> why it was preset. Rendered under the control. */
  presetBecause?: Record<string, string>;
};

let uid = 0;

function nextId(key: string): string {
  uid += 1;
  return `opt-${uid}-${key.replace(/[^a-z0-9-]/gi, '')}`;
}

/** Trim float noise a step-based control can introduce (0.30000000000000004). */
function tidy(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Turn a raw control value into the type the schema declares.
 *
 * `raw` is whatever the DOM handed over: a string from every `<input>` and
 * `<select>`, a boolean from a checkbox's `.checked`.
 */
export function coerceOptionValue(def: OptionDef, raw: string | number | boolean): unknown {
  switch (def.kind) {
    case 'toggle':
      if (typeof raw === 'boolean') return raw;
      return raw === 'true' || raw === 'on' || raw === 1;

    case 'number':
    case 'range': {
      const parsed = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
      // A blank or half-typed field must not send NaN into an op.
      if (!Number.isFinite(parsed)) return def.default;
      return tidy(Math.min(def.max, Math.max(def.min, parsed)));
    }

    case 'select': {
      const value = String(raw);
      return def.choices.some((choice) => choice.value === value) ? value : def.default;
    }

    case 'text':
      return String(raw);
  }
}

/** Schema defaults, with any preset values layered over them. */
export function defaultOptions(
  schema: OptionSchema | undefined,
  presetValues?: Record<string, unknown>,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(schema ?? {})) values[key] = def.default;
  for (const [key, value] of Object.entries(presetValues ?? {})) {
    // A preset for an option this tool does not have is a registry bug, not
    // something to pass silently through to the op.
    if (key in values) values[key] = value;
  }
  return values;
}

/** The first choice this browser can actually honour, or the declared default. */
function usableDefault(def: OptionDef, blocked: Record<string, string> | undefined): unknown {
  if (def.kind !== 'select' || !blocked) return def.default;
  if (!blocked[def.default]) return def.default;
  const open = def.choices.find((choice) => !blocked[choice.value]);
  return open ? open.value : def.default;
}

/**
 * The value a control STARTS at.
 *
 * A preset only means anything if the control shows it — a note saying "from
 * the file's gzip signature" above a picker still reading "Compress" is worse
 * than no preset at all. It is coerced like any other input, and it loses to
 * the usable default when it names a choice this browser cannot honour.
 */
function initialValue(
  def: OptionDef,
  blocked: Record<string, string> | undefined,
  preset: unknown,
): unknown {
  const fallback = usableDefault(def, blocked);
  if (typeof preset !== 'string' && typeof preset !== 'number' && typeof preset !== 'boolean') {
    return fallback;
  }
  const value = coerceOptionValue(def, preset);
  return def.kind === 'select' && blocked?.[String(value)] ? fallback : value;
}

export function renderOptions(init: RenderOptionsInit): OptionsHandle {
  const { tool, files, onChange, disabled } = init;
  const root = el('div', 'options');
  let values: Record<string, unknown> = {};
  let teardown: (() => void) | null = null;
  let destroyed = false;

  function emit(): void {
    onChange({ ...values });
  }

  // ---- the escape hatch: a bespoke editor replaces the generic panel -------
  if (tool.editor) {
    const mount = el('div', 'options__editor');
    const loading = el('p', 'options__note', 'Loading the editor…');
    root.append(loading, mount);

    const load = tool.editor;
    const ready = load()
      .then((module) => {
        if (destroyed) return;
        loading.remove();
        teardown = module.default(mount, files, (next) => {
          values = { ...values, ...next };
          emit();
        });
      })
      .catch(() => {
        if (destroyed) return;
        // Never a console-only failure, never an alert (§9).
        loading.className = 'options__note options__note--error';
        loading.textContent =
          'This tool’s editor could not be loaded. Reload the page and try again.';
      });

    return {
      el: root,
      ready,
      values: () => ({ ...values }),
      destroy(): void {
        destroyed = true;
        teardown?.();
        teardown = null;
        root.replaceChildren();
      },
    };
  }

  // ---- the generic, schema-driven panel -----------------------------------
  const schema = tool.options;
  const entries = schema ? Object.entries(schema) : [];

  if (entries.length === 0) {
    root.append(el('p', 'options__note', 'This tool has no options — just run it.'));
    return {
      el: root,
      ready: Promise.resolve(),
      values: () => ({}),
      destroy(): void {
        destroyed = true;
        root.replaceChildren();
      },
    };
  }

  for (const [key, def] of entries) {
    const blocked = disabled?.[key];
    values[key] = initialValue(def, blocked, init.presetValues?.[key]);

    const row = el('div', 'opt');
    row.dataset.key = key;
    const id = nextId(key);

    const label = el('label', 'opt__label', def.label);
    label.htmlFor = id;

    const control = el('div', 'opt__control');
    row.append(label, control);

    const commit = (raw: string | boolean): void => {
      values[key] = coerceOptionValue(def, raw);
      emit();
    };

    switch (def.kind) {
      case 'select': {
        const select = el('select', 'field field--select');
        select.id = id;
        for (const choice of def.choices) {
          const option = el('option', undefined, choice.label);
          option.value = choice.value;
          const reason = blocked?.[choice.value];
          if (reason) {
            option.disabled = true;
            option.textContent = `${choice.label} — unavailable`;
          }
          select.append(option);
        }
        select.value = String(values[key]);
        select.addEventListener('change', () => commit(select.value));
        control.append(select);
        break;
      }

      case 'number': {
        const input = el('input', 'field field--number');
        input.type = 'number';
        input.id = id;
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.inputMode = 'numeric';
        input.value = String(values[key]);
        input.addEventListener('input', () => commit(input.value));
        // On blur, snap the visible field to the value actually in use, so the
        // control never disagrees with what will be sent.
        input.addEventListener('change', () => {
          commit(input.value);
          input.value = String(values[key]);
        });
        control.append(input);
        break;
      }

      case 'range': {
        const input = el('input', 'field field--range');
        input.type = 'range';
        input.id = id;
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.value = String(values[key]);
        const readout = el('output', 'opt__value', String(values[key]));
        // HTMLOutputElement.htmlFor is a read-only DOMTokenList — set the attribute.
        readout.setAttribute('for', id);
        input.addEventListener('input', () => {
          commit(input.value);
          readout.textContent = String(values[key]);
        });
        control.append(input, readout);
        break;
      }

      case 'toggle': {
        const wrap = el('span', 'switch');
        const input = el('input', 'switch__input');
        input.type = 'checkbox';
        input.id = id;
        input.checked = values[key] === true;
        input.addEventListener('change', () => commit(input.checked));
        wrap.append(input, el('span', 'switch__track'));
        control.append(wrap);
        break;
      }

      case 'text': {
        const input = el('input', 'field field--text');
        input.type = 'text';
        input.id = id;
        input.value = String(values[key]);
        if (def.placeholder) input.placeholder = def.placeholder;
        input.addEventListener('input', () => commit(input.value));
        control.append(input);
        break;
      }
    }

    // Why this value arrived already chosen. `.opt__reason` below says a choice
    // is UNAVAILABLE; this says a value was PICKED FOR YOU. Different things.
    const because = init.presetBecause?.[key];
    if (because) {
      const note = el('p', 'opt__because', because);
      note.id = `${id}-because`;
      row.append(note);
    }

    // Every blocked choice states WHY, in the panel, next to the control.
    const reasons = Object.values(blocked ?? {});
    if (reasons.length > 0) {
      for (const reason of [...new Set(reasons)]) {
        row.append(el('p', 'opt__reason', reason));
      }
    }

    root.append(row);
  }

  return {
    el: root,
    ready: Promise.resolve(),
    values: () => ({ ...values }),
    destroy(): void {
      destroyed = true;
      root.replaceChildren();
    },
  };
}
