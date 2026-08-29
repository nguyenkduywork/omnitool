// tests/unit/optionspanel.test.ts — the DOM-free half of the options panel.
//
// The value-coercion layer is where the classic bug lives: an <input> hands back
// a string for `kind: 'number'` and `kind: 'range'`, and an op that receives
// "150" instead of 150 misbehaves in ways that are hard to trace. These are pure
// functions, so they are tested here under Node; the rendering half is tested
// against a real DOM in optionspanel.browser.test.ts.

import { describe, expect, it } from 'vitest';

import { coerceOptionValue, defaultOptions } from '../../src/ui/optionspanel';
import type { OptionSchema } from '../../src/types';

const SCHEMA: OptionSchema = {
  format: {
    kind: 'select',
    label: 'Format',
    choices: [
      { value: 'png', label: 'PNG' },
      { value: 'jpeg', label: 'JPEG' },
    ],
    default: 'png',
  },
  dpi: { kind: 'number', label: 'Resolution (DPI)', min: 72, max: 300, step: 1, default: 150 },
  quality: { kind: 'range', label: 'Quality', min: 10, max: 100, step: 5, default: 70 },
  header: { kind: 'toggle', label: 'First row is header', default: true },
  ranges: { kind: 'text', label: 'Ranges', placeholder: '1-3,7,9-', default: '' },
};

describe('defaultOptions', () => {
  it('produces one correctly typed entry per schema key', () => {
    const values = defaultOptions(SCHEMA);
    expect(Object.keys(values).sort()).toEqual(['dpi', 'format', 'header', 'quality', 'ranges']);
    expect(values).toEqual({
      format: 'png',
      dpi: 150,
      quality: 70,
      header: true,
      ranges: '',
    });
    expect(typeof values.dpi).toBe('number');
    expect(typeof values.quality).toBe('number');
    expect(typeof values.header).toBe('boolean');
  });

  it('is an empty object for a tool with no schema', () => {
    expect(defaultOptions(undefined)).toEqual({});
  });
});

describe('coerceOptionValue', () => {
  it('emits a NUMBER for kind: number, never the input element string', () => {
    const value = coerceOptionValue(SCHEMA.dpi!, '220');
    expect(value).toBe(220);
    expect(typeof value).toBe('number');
    expect(value).not.toBe('220');
  });

  it('emits a NUMBER for kind: range, never the input element string', () => {
    const value = coerceOptionValue(SCHEMA.quality!, '35');
    expect(value).toBe(35);
    expect(typeof value).toBe('number');
  });

  it('clamps numbers into the schema bounds instead of passing them through', () => {
    expect(coerceOptionValue(SCHEMA.dpi!, '5000')).toBe(300);
    expect(coerceOptionValue(SCHEMA.dpi!, '1')).toBe(72);
    expect(coerceOptionValue(SCHEMA.quality!, '-40')).toBe(10);
  });

  it('falls back to the default when a number field is blank or unparseable', () => {
    expect(coerceOptionValue(SCHEMA.dpi!, '')).toBe(150);
    expect(coerceOptionValue(SCHEMA.dpi!, 'abc')).toBe(150);
    expect(typeof coerceOptionValue(SCHEMA.dpi!, '')).toBe('number');
  });

  it('emits a BOOLEAN for kind: toggle', () => {
    expect(coerceOptionValue(SCHEMA.header!, false)).toBe(false);
    expect(coerceOptionValue(SCHEMA.header!, true)).toBe(true);
    expect(coerceOptionValue(SCHEMA.header!, 'true')).toBe(true);
    expect(typeof coerceOptionValue(SCHEMA.header!, 'on')).toBe('boolean');
  });

  it('emits a string for kind: text, verbatim', () => {
    expect(coerceOptionValue(SCHEMA.ranges!, '1-3,7,9-')).toBe('1-3,7,9-');
  });

  it('rejects a select value that is not one of the declared choices', () => {
    expect(coerceOptionValue(SCHEMA.format!, 'jpeg')).toBe('jpeg');
    expect(coerceOptionValue(SCHEMA.format!, 'tiff')).toBe('png');
  });

  it('does not leave floating-point noise in a stepped value', () => {
    const stepped: OptionSchema = {
      scale: { kind: 'range', label: 'Scale', min: 0, max: 1, step: 0.1, default: 0.5 },
    };
    expect(coerceOptionValue(stepped.scale!, '0.30000000000000004')).toBe(0.3);
  });
});
