// SPDX-License-Identifier: AGPL-3.0-only
import { type KeyboardEvent, type ReactNode } from 'react';
import {
  DEFAULT_STATUS_LABELS,
  DENSITIES,
  MOTION_PREFS,
  t,
  TEXT_SCALE,
  TEXT_SIZES,
  type Density,
  type MotionPref,
  type TextSize,
} from '@bines/shared';
import { cn, Switch } from '@bines/ui';
import { useAppearance } from '../../lib/appearance';
import { LabelTag } from '../../lib/label-color';
import { EmailOpenPicker } from './EmailOpenPicker';
import { IconStylePicker } from './IconStylePicker';

/** ←/→ move the choice inside a radio group of cards (like the palette picker). */
const arrows =
  <T extends string>(list: readonly T[], current: T, choose: (v: T) => void, attr: string) =>
  (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const rtl = document.documentElement.dir === 'rtl';
    const forward = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
    const i = list.indexOf(current);
    const next = list[(i + (forward ? 1 : list.length - 1)) % list.length]!;
    choose(next);
    e.currentTarget.querySelector<HTMLElement>(`[${attr}="${next}"]`)?.focus();
  };

const Card = ({
  on,
  onClick,
  testId,
  data,
  children,
}: {
  on: boolean;
  onClick: () => void;
  testId: string;
  data: Record<string, string>;
  children: ReactNode;
}) => (
  <button
    type="button"
    role="radio"
    aria-checked={on}
    tabIndex={on ? 0 : -1}
    data-testid={testId}
    {...data}
    onClick={onClick}
    className={cn(
      'flex min-w-0 flex-col items-center justify-center gap-1 rounded-[var(--radius)] border px-2 py-2.5 text-center text-sm',
      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
      on ? 'border-primary bg-primary-soft font-semibold text-primary' : 'border-line hover:bg-surface-2',
    )}
  >
    {children}
  </button>
);

/** Three sample rows at the chosen density (the board table's rows follow the same numbers). */
const Preview = () => {
  const { rowPx } = useAppearance();
  const rows = [
    { name: t('r13.look.sample1'), status: t('r13.look.statusDone'), color: DEFAULT_STATUS_LABELS[1]!.color },
    { name: t('r13.look.sample2'), status: t('r13.look.statusWorking'), color: DEFAULT_STATUS_LABELS[0]!.color },
    { name: t('r13.look.sample3'), status: t('r13.look.statusStuck'), color: DEFAULT_STATUS_LABELS[2]!.color },
  ];
  return (
    <div
      className="overflow-hidden rounded-[var(--radius)] border border-line bg-surface"
      data-testid="appearance-preview"
      aria-hidden
    >
      {rows.map((r) => (
        <div
          key={r.name}
          className="flex items-center gap-3 border-b border-line-soft px-3 last:border-b-0"
          style={{ height: rowPx(38) }}
          data-testid="appearance-preview-row"
        >
          <span className="min-w-0 flex-1 truncate text-sm text-fg">{r.name}</span>
          <LabelTag color={r.color} className="shrink-0">
            {r.status}
          </LabelTag>
        </div>
      ))}
    </div>
  );
};

/**
 * Round 13 (product owner: "font size per user"): text size (small / normal / large / extra large) and table density
 * (compact / normal / comfortable) — applied live to the whole app, saved for the user (every device), with an
 * optional "only on this device". The account admin's default (when built) fills what the user never chose.
 */
export const AppearanceSettings = ({ accountId }: { accountId: string }) => {
  const { value, choose } = useAppearance();
  const size = (v: TextSize) => void choose({ text_size: v }, accountId);
  const density = (v: Density) => void choose({ density: v }, accountId);
  const motion = (v: MotionPref) => void choose({ motion: v }, accountId);
  return (
    <div
      className="space-y-4"
      data-testid="appearance-settings"
      data-text-size={value.text_size}
      data-motion-pref={value.motion}
      data-icon-style={value.icon_style}
    >
      <div
        role="radiogroup"
        aria-label={t('r13.look.textSize')}
        data-testid="text-size-picker"
        onKeyDown={arrows(TEXT_SIZES, value.text_size, size, 'data-size')}
        className="grid grid-cols-2 gap-2 sm:grid-cols-4"
      >
        {TEXT_SIZES.map((k) => (
          <Card
            key={k}
            on={value.text_size === k}
            onClick={() => size(k)}
            testId={`text-size-${k}`}
            data={{ 'data-size': k }}
          >
            {/* The sample letters at that size relative to the current one, so each card shows its own size. */}
            <span
              aria-hidden
              className="font-display leading-none font-extrabold"
              style={{ fontSize: `${(1.15 * TEXT_SCALE[k]) / TEXT_SCALE[value.text_size]}rem` }}
            >
              {t('r13.look.size.sample')}
            </span>
            <span className="max-w-full text-xs [overflow-wrap:anywhere]">{t(`r13.look.size.${k}`)}</span>
          </Card>
        ))}
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-heading">{t('r13.look.density')}</h3>
        <div
          role="radiogroup"
          aria-label={t('r13.look.density')}
          data-testid="density-picker"
          onKeyDown={arrows(DENSITIES, value.density, density, 'data-density-id')}
          className="grid grid-cols-3 gap-2"
        >
          {DENSITIES.map((k) => (
            <Card
              key={k}
              on={value.density === k}
              onClick={() => density(k)}
              testId={`density-${k}`}
              data={{ 'data-density-id': k }}
            >
              <span
                aria-hidden
                className="flex w-8 flex-col"
                style={{ gap: k === 'compact' ? 2 : k === 'normal' ? 4 : 6 }}
              >
                <span className="h-0.5 rounded bg-current opacity-60" />
                <span className="h-0.5 rounded bg-current opacity-60" />
                <span className="h-0.5 rounded bg-current opacity-60" />
              </span>
              <span className="max-w-full text-xs [overflow-wrap:anywhere]">{t(`r13.look.density.${k}`)}</span>
            </Card>
          ))}
        </div>
      </div>
      <Preview />
      {/* r16motion: animations — by device (default) / full / reduced / off; applied live as <html data-motion>. */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-heading">{t('r16motion.look.motion')}</h3>
        <div
          role="radiogroup"
          aria-label={t('r16motion.look.motion')}
          data-testid="motion-picker"
          onKeyDown={arrows(MOTION_PREFS, value.motion, motion, 'data-motion-id')}
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
        >
          {MOTION_PREFS.map((k) => (
            <Card
              key={k}
              on={value.motion === k}
              onClick={() => motion(k)}
              testId={`motion-${k}`}
              data={{ 'data-motion-id': k }}
            >
              <span className="max-w-full text-xs [overflow-wrap:anywhere]">{t(`r16motion.look.motion.${k}`)}</span>
            </Card>
          ))}
        </div>
        <p className="text-xs text-muted">{t('r16motion.look.motionHint')}</p>
      </div>
      {/*: the icon style — applied live; null on the server is the account's default. */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-heading">{t('iconStyle.title')}</h3>
        <IconStylePicker
          value={value.icon_style}
          onChange={(icon_style) => void choose({ icon_style }, accountId)}
          label={t('iconStyle.title')}
        />
        <p className="text-xs text-muted">{t('iconStyle.hint')}</p>
      </div>
      {/*: a click on an email address — the menu, or straight to Gmail / Outlook / the mail app. */}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-heading">{t('emailOpen.title')}</h3>
        <EmailOpenPicker
          value={value.email_open}
          onChange={(email_open) => void choose({ email_open }, accountId)}
          label={t('emailOpen.title')}
        />
        <p className="text-xs text-muted">{t('emailOpen.hint')}</p>
      </div>
      <label className="flex items-start gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm text-fg">{t('r13.look.device')}</span>
          <span className="block text-xs text-muted">{t('r13.look.deviceHint')}</span>
        </span>
        <Switch
          checked={value.device}
          onChange={(on) => void choose({ device: on }, accountId)}
          testId="appearance-device"
        />
      </label>
    </div>
  );
};
