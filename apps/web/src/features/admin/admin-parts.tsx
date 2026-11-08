// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { Card, cn } from '@bines/ui';

/** Small building blocks of the A4 / A5 sections (security, audit, usage, tidy up). */

export const h1 =
  'font-display text-[1.625rem] leading-tight font-extrabold tracking-[-0.5px] text-heading max-md:text-2xl';
export const h2 = 'font-display text-[1rem] leading-snug font-extrabold text-heading';

/** The section's title, its line and its actions at the end. */
export const SectionHeader = ({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) => (
  <header className="flex flex-wrap items-end justify-between gap-3">
    <div className="space-y-1">
      <h1 className={h1}>{title}</h1>
      {subtitle ? <p className="max-w-[680px] text-sm text-muted">{subtitle}</p> : null}
    </div>
    {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
  </header>
);

/** A card with a titled head (like Administration → כללי). */
export const Panel = ({
  title,
  hint,
  actions,
  children,
  testId,
}: {
  title: string;
  hint?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  testId: string;
}) => (
  <Card className="p-0">
    <div className="flex flex-wrap items-start gap-3 border-b border-line-soft px-3.5 pt-3.5 pb-3" data-testid={testId}>
      <div className="min-w-0 flex-1 basis-60 space-y-0.5">
        <h2 className={h2}>{title}</h2>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
    <div>{children}</div>
  </Card>
);

/** A settings row: label and hint at the inline start, the control at the end; stacked on a phone. */
export const Row = ({
  label,
  hint,
  below,
  children,
  testId,
  className,
}: {
  label: string;
  hint?: ReactNode;
  /** Under the hint: e.g. a custom sender's approval state (messaging). */
  below?: ReactNode;
  children?: ReactNode;
  testId?: string;
  className?: string;
}) => (
  <div
    className={cn(
      'flex items-center gap-3 border-b border-line-soft px-3.5 py-3 last:border-b-0 max-sm:flex-col max-sm:items-stretch max-sm:gap-2',
      className,
    )}
    data-testid={testId}
  >
    <div className="min-w-0 flex-1 space-y-0.5">
      <div className="text-sm font-semibold text-fg">{label}</div>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      {below}
    </div>
    {children ? <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:shrink">{children}</div> : null}
  </div>
);

/** A number card (usage): the value large, the label above, an optional line under it. */
export const StatCard = ({
  label,
  value,
  sub,
  tone,
  testId,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'danger';
  testId: string;
}) => (
  <div className="rounded-[var(--radius-lg)] border border-line bg-surface p-4" data-testid={testId}>
    <div className="text-xs font-semibold text-muted">{label}</div>
    <div
      className={cn(
        'mt-1 font-display text-[1.625rem] leading-tight font-extrabold text-heading tabular-nums',
        tone === 'danger' && 'text-danger-fg',
      )}
      data-testid={`${testId}-value`}
    >
      {value}
    </div>
    {sub ? <div className="mt-0.5 text-xs text-muted">{sub}</div> : null}
  </div>
);

/** "Chrome · Windows" from a user agent (a short, readable guess; the full string is in the title). */
export const deviceOf = (ua: string | null): string => {
  if (!ua) return '—';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\//.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : null;
  const os = /iPhone|iPad/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  const parts = [browser, os].filter(Boolean);
  return parts.length ? parts.join(' · ') : ua.slice(0, 40);
};

/** Bytes as "1.2 MB". */
export const formatBytes = (n: number) => {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
};
