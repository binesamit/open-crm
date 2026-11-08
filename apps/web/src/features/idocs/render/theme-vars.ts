// SPDX-License-Identifier: AGPL-3.0-only
import type { CSSProperties } from 'react';
import { idocInkOn, type IdocTheme } from '@bines/shared';

/**
 * A document's look as CSS variables on its root: the app's design tokens are redefined inside the
 * document only, so every section, button and chip follows the theme without a style of its own. Empty values keep
 * the app's tokens (light / dark as the viewer chose).
 */
const mix = (a: string, b: string, pct: number) => `color-mix(in srgb, ${a} ${pct}%, ${b})`;

export const themeVars = (t: IdocTheme): CSSProperties => {
  const v: Record<string, string> = {};
  const paper = t.paper || 'var(--surface)';
  const text = t.text || 'var(--fg)';
  if (t.paper) {
    v['--surface'] = t.paper;
    v['--surface-2'] = mix(t.paper, text, 93);
    v['--surface-3'] = mix(t.paper, text, 96);
    v['--line'] = mix(t.paper, text, 86);
    v['--line-strong'] = mix(t.paper, text, 76);
    v['--control-line'] = mix(t.paper, text, 60);
    v['background'] = t.paper;
  }
  if (t.text) {
    v['--fg'] = t.text;
    v['--heading'] = t.text;
    v['--fg-2'] = mix(t.text, paper, 86);
  }
  if (t.muted) v['--muted'] = t.muted;
  else if (t.text) v['--muted'] = mix(t.text, paper, 74);
  if (t.accent) {
    const on = idocInkOn(t.accent);
    v['--primary'] = t.accent;
    v['--on-primary'] = on;
    v['--accent'] = t.accent;
    v['--on-accent'] = on;
    v['--primary-soft'] = mix(t.accent, paper, 14);
    v['--accent-soft'] = mix(t.accent, paper, 16);
    v['--info-soft'] = mix(t.accent, paper, 12);
    v['--info-fg'] = t.text ? mix(t.accent, t.text, 60) : t.accent;
  }
  if (t.font === 'display') v['--font-body'] = 'var(--font-display)';
  if (t.font === 'serif') {
    v['--font-body'] = "Georgia, 'Times New Roman', 'David', serif";
    v['--font-display'] = "Georgia, 'Times New Roman', 'David', serif";
    v['fontFamily'] = "Georgia, 'Times New Roman', 'David', serif";
  }
  return v as CSSProperties;
};

/** The title band: the theme's header, else the legacy brand colour, else the shell. */
export const headerOf = (t: IdocTheme, legacy: string) => t.header || legacy || '';
