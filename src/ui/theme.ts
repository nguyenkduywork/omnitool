// src/ui/theme.ts — the theme preference and the one control that changes it.
//
// Lifted out of shell.ts unchanged: it shares no state with anything else
// there, and a composition root should not also be a preference store.

import { el, icon } from './dom';

const THEME_KEY = 'omnitool:theme';
type ThemePref = 'system' | 'light' | 'dark';
const THEME_CYCLE: ThemePref[] = ['system', 'dark', 'light'];
const THEME_NAME: Record<ThemePref, string> = {
  system: 'Theme: match the system',
  dark: 'Theme: dark',
  light: 'Theme: light',
};

function readThemePref(): ThemePref {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Storage can be blocked; the system default is a fine answer.
  }
  return 'system';
}

function applyThemePref(pref: ThemePref): void {
  const root = document.documentElement;
  if (pref === 'system') delete root.dataset.theme;
  else root.dataset.theme = pref;
}

export type ThemeHandle = { readonly el: HTMLButtonElement; destroy(): void };

export function createThemeControl(announce: (message: string) => void): ThemeHandle {
  let theme = readThemePref();
  applyThemePref(theme);

  const button = el('button', 'btn btn--icon');
  button.type = 'button';
  button.append(icon('theme'));

  function paint(): void {
    button.title = THEME_NAME[theme];
    button.setAttribute('aria-label', `${THEME_NAME[theme]}. Change.`);
    button.dataset.theme = theme;
  }
  paint();

  const onClick = (): void => {
    const at = THEME_CYCLE.indexOf(theme);
    theme = THEME_CYCLE[(at + 1) % THEME_CYCLE.length] ?? 'system';
    applyThemePref(theme);
    paint();
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      // A blocked storage is not an error worth showing anyone.
    }
    announce(THEME_NAME[theme]);
  };
  button.addEventListener('click', onClick);

  return { el: button, destroy: () => button.removeEventListener('click', onClick) };
}
