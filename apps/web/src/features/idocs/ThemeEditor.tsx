// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { IDOC_MIN_CONTRAST, idocInkOn, idocThemeWarnings, type IdocTheme } from '@bines/shared';
import { Input, Notice, Segmented } from '@bines/ui';
import { keysOf } from './idocs-api';

/**
 * Edits an interactive document look: the frame, the page, the text, secondary text, the accent and
 * the title band, plus the font family — each a #RRGGBB or empty (= the layer below). Pairs that read below WCAG AA
 * are named right away; the theme is still saved (a warning, never a block). No native colour picker (M1.1 #9): a hex
 * field with its swatch, and a few ready swatches per colour.
 */
const T = keysOf('idoc.theme.');
const COLORS = ['background', 'paper', 'text', 'muted', 'accent', 'header'] as const;
const SWATCHES: Record<(typeof COLORS)[number], string[]> = {
  background: ['#0d3b35', '#f4f6f8', '#1d2433', '#ffffff'],
  paper: ['#ffffff', '#fbfaf7', '#f4f6f8', '#162026'],
  text: ['#13221f', '#1d2433', '#2b2b2b', '#f2f5f4'],
  muted: ['#5d756f', '#5b6472', '#6b6b6b', '#b8c4c1'],
  accent: ['#0d3b35', '#1d4ea8', '#7a2e8a', '#a8450c'],
  header: ['#0d3b35', '#1d2433', '#1d4ea8', '#3a1f5d'],
};

const ColorField = ({
  label,
  value,
  swatches,
  onChange,
  testId,
}: {
  label: string;
  value: string;
  swatches: string[];
  onChange: (v: string) => void;
  testId: string;
}) => {
  const [draft, setDraft] = useState(value);
  const commit = (v: string) => {
    const x = v.trim();
    const hex = x && !x.startsWith('#') ? `#${x}` : x;
    if (hex === '' || /^#[0-9a-fA-F]{6}$/.test(hex)) onChange(hex.toLowerCase());
    else setDraft(value);
  };
  return (
    <div className="grid gap-1" data-testid={testId}>
      <span className="text-xs text-fg-2">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          aria-hidden
          className="size-7 shrink-0 rounded-[8px] border border-line-strong"
          style={{
            background: value || 'transparent',
            backgroundImage: value
              ? undefined
              : 'linear-gradient(135deg, transparent 45%, var(--line-strong) 45% 55%, transparent 55%)',
          }}
        />
        <Input
          value={draft}
          dir="ltr"
          aria-label={label}
          placeholder={T('default')}
          className="w-28 font-mono text-xs"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => e.key === 'Enter' && commit(draft)}
        />
        {swatches.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`${label} ${c}`}
            aria-pressed={value === c}
            onClick={() => {
              setDraft(c);
              onChange(c);
            }}
            className="size-6 rounded-full border-2"
            style={{ background: c, borderColor: value === c ? 'var(--accent)' : 'var(--line-strong)' }}
          />
        ))}
        {value ? (
          <button
            type="button"
            className="text-xs text-info-fg hover:underline"
            onClick={() => {
              setDraft('');
              onChange('');
            }}
          >
            {T('clear')}
          </button>
        ) : null}
      </div>
    </div>
  );
};

export const ThemeEditor = ({
  theme,
  onChange,
  testId = 'idoc-theme',
}: {
  theme: IdocTheme;
  onChange: (t: IdocTheme) => void;
  testId?: string;
}) => {
  const warnings = idocThemeWarnings(theme);
  return (
    <div className="grid gap-3" data-testid={testId}>
      {COLORS.map((k) => (
        <ColorField
          key={k}
          label={T(`color.${k}`)}
          value={theme[k]}
          swatches={SWATCHES[k]}
          onChange={(v) => onChange({ ...theme, [k]: v })}
          testId={`${testId}-${k}`}
        />
      ))}
      <div className="grid gap-1">
        <span className="text-xs text-fg-2">{T('font')}</span>
        <Segmented
          label={T('font')}
          value={theme.font}
          onChange={(font) => onChange({ ...theme, font })}
          options={(['default', 'display', 'serif'] as const).map((f) => ({ value: f, label: T(`fonts.${f}`) }))}
        />
      </div>
      {warnings.length ? (
        <Notice tone="warn">
          <span data-testid={`${testId}-warning`}>
            {T('contrastWarning', { min: IDOC_MIN_CONTRAST })}{' '}
            {warnings.map((w) => `${T(`pair.${w.pair}`)} ${w.ratio}:1`).join(' · ')}
          </span>
        </Notice>
      ) : null}
      <div
        className="grid gap-1 rounded-[var(--radius)] border border-line p-3 text-sm"
        style={{ background: theme.paper || undefined, color: theme.text || undefined }}
        aria-hidden
      >
        <span>{T('sample')}</span>
        <span style={{ color: theme.muted || undefined }} className="text-xs">
          {T('sampleMuted')}
        </span>
        <span
          className="justify-self-start rounded-full px-2.5 py-0.5 text-xs"
          style={{
            background: theme.accent || 'var(--accent)',
            color: theme.accent ? idocInkOn(theme.accent) : 'var(--on-accent)',
          }}
        >
          {T('sampleButton')}
        </span>
      </div>
    </div>
  );
};
