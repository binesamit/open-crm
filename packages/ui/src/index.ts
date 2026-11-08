// SPDX-License-Identifier: AGPL-3.0-only
export type Theme = 'system' | 'light' | 'dark';

/** Applies a theme to <html data-theme>; 'system' defers to prefers-color-scheme (tokens.css). */
export const applyTheme = (theme: Theme, root: HTMLElement = document.documentElement): void => {
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
};

export * from './components';
export * from './controls';
export * from './calendar';
export * from './menu';
export * from './avatar';
export * from './time-field';
export * from './layers';
export * from './tooltip';
export * from './position';
export * from './palettes';
export * from './text-dir';
export * from './motion';
export * from './touch';
export * from './day-state';
