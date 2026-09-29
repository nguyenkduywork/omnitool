import { OpError } from '../../types';

export type ImageSize = { width: number; height: number };
export type ResizeOptions = {
  mode: 'dimensions' | 'percent';
  width: number;
  height: number;
  percent: number;
  lockAspect: boolean;
  withoutEnlargement: boolean;
};

export function readResizeOptions(options: Readonly<Record<string, unknown>>): ResizeOptions {
  const mode = options.mode === undefined ? 'dimensions' : options.mode;
  if (mode !== 'dimensions' && mode !== 'percent') {
    throw new OpError('InvalidOptions', 'mode must be dimensions or percent.');
  }
  function range(key: string, fallback: number, min: number, max: number): number {
    const value = options[key] === undefined ? fallback : options[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
      throw new OpError('InvalidOptions', `${key} must be a number between ${min} and ${max}.`);
    }
    return value;
  }
  function toggle(key: string, fallback: boolean): boolean {
    const value = options[key] === undefined ? fallback : options[key];
    if (typeof value !== 'boolean') throw new OpError('InvalidOptions', `${key} must be a boolean.`);
    return value;
  }
  return {
    mode,
    width: range('width', 1920, 1, 20000),
    height: range('height', 1080, 1, 20000),
    percent: range('percent', 50, 5, 200),
    lockAspect: toggle('lockAspect', true),
    withoutEnlargement: toggle('withoutEnlargement', false),
  };
}

/** Shared by the worker and readout, including pixel rounding and per-axis caps. */
export function resizeDimensions(source: ImageSize, options: ResizeOptions): ImageSize {
  let width: number;
  let height: number;
  if (options.mode === 'percent' || options.lockAspect) {
    let scale = options.mode === 'percent'
      ? options.percent / 100
      : Math.min(options.width / source.width, options.height / source.height);
    if (options.withoutEnlargement) scale = Math.min(1, scale);
    width = Math.max(1, Math.round(source.width * scale));
    height = Math.max(1, Math.round(source.height * scale));
  } else {
    // Canvas dimensions are integers; normalize before drawing as well as reporting.
    width = Math.trunc(options.width);
    height = Math.trunc(options.height);
    if (options.withoutEnlargement) {
      width = Math.min(source.width, width);
      height = Math.min(source.height, height);
    }
  }
  return { width, height };
}
