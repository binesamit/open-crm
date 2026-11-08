// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { Link, Outlet, useParams } from '@tanstack/react-router';
import { t, type MessageKey, type MyAccount } from '@bines/shared';
import { cn, EmptyState } from '@bines/ui';
import { Glyph, Icon, type IconName, type IconPart } from '../../lib/icons';
import { ErrorCount } from '../owner/errors/ErrorCount';
import { useOpenHealthCount } from './AdminHealth';

/**
 * Administration (08 §13, account admin plan A1): a secondary nav of sections at the
 * inline start, the section at the other side (a scrolling row of chips on a phone). Account admins only; the
 * route sends everyone else home.
 */
export const ADMIN_SECTIONS = [
  'general',
  'notifications',
  'appearance',
  'users',
  'teams',
  'templates',
  'security',
  'connections',
  'flows',
  'extensions',
  'ai',
  'usage',
  'plan',
  'tidy',
  'audit',
  'health',
] as const;
export type AdminSection = (typeof ADMIN_SECTIONS)[number];
export const isAdminSection = (s: string): s is AdminSection => (ADMIN_SECTIONS as readonly string[]).includes(s);

const glyph = (parts: readonly IconPart[]) => <Glyph parts={parts} size={16} />;

const icon = (name: IconName) => <Icon name={name} size={16} className="shrink-0" />;

/** Each section's icon; usage and tidy have none in the set, so they are drawn here. */
const ICONS: Record<AdminSection, ReactNode> = {
  general: icon('gear'),
  // Errors & health: the account's own errors.
  health: icon('warn'),
  notifications: icon('bell'),
  // the sidebar and the top bar.
  appearance: glyph([
    ['b', <rect x="3" y="4" width="18" height="16" rx="3" />],
    ['k', <path d="M3 9h18" />],
    ['k*', <path d="M9 9v11" />],
  ]),
  users: icon('person'),
  teams: icon('people'),
  templates: icon('template'),
  security: icon('shield'),
  connections: icon('key'),
  flows: icon('flow'),
  extensions: icon('ext'),
  ai: icon('bolt'),
  usage: glyph([
    ['o', <path d="M5 20V11M19 20v-6" />],
    ['o*', <path d="M12 20V5" />],
  ]),
  plan: glyph([
    ['b', <rect x="3" y="6" width="18" height="13" rx="2" />],
    ['k', <path d="M3 10h18" />],
    ['k*', <path d="M7 15h4" />],
  ]),
  tidy: glyph([
    ['o', <path d="M14 4l6 6M4 20l7.5-7.5" />],
    ['b*', <path d="M9.5 10.5l4 4-3 5.5-6.5-6.5z" />],
  ]),
  audit: icon('history'),
};

/** The nav, in groups: the directory (users, teams, templates) gets its own small label. */
const GROUPS: { label?: MessageKey; sections: AdminSection[] }[] = [
  { sections: ['general', 'notifications', 'appearance'] },
  { label: 'admin.group.directory' as MessageKey, sections: ['users', 'teams', 'templates'] },
  { sections: ['security', 'connections', 'flows', 'extensions', 'ai', 'usage', 'plan', 'health', 'tidy', 'audit'] },
];

export const sectionLabel = (s: AdminSection) => t(`admin.section.${s}` as MessageKey);

export const AdminHub = ({ account }: { account: MyAccount }) => {
  const params = useParams({ strict: false }) as { section?: string; doc?: string };
  // s37market: the developer guide (/admin/extensions/docs/…) belongs to Extensions.
  const current = params.doc
    ? 'extensions'
    : params.section && isAdminSection(params.section)
      ? params.section
      : 'general';
  // Errors & health: the account's open errors as a count on "Health" (no icon in the top bar).
  const openErrors = useOpenHealthCount(account);
  const navItem = (s: AdminSection) => (
    <Link
      key={s}
      to="/a/$accountSlug/admin/$section"
      params={{ accountSlug: account.slug, section: s }}
      aria-current={s === current ? 'page' : undefined}
      data-testid={`admin-nav-${s}`}
      data-tour={s === 'users' ? 'admin.users' : s === 'ai' ? 'admin.ai' : undefined}
      className={cn(
        'flex shrink-0 items-center gap-2.5 rounded-[10px] px-2.5 text-sm font-semibold whitespace-nowrap',
        'h-9 text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
        'max-md:h-8 max-md:rounded-full max-md:border max-md:border-line max-md:bg-surface max-md:px-3',
        s === current &&
          'bg-primary-soft text-heading hover:bg-primary-soft max-md:border-primary max-md:bg-primary-soft',
      )}
    >
      <span className={cn('max-md:hidden', s === current ? 'text-primary' : 'text-muted')}>{ICONS[s]}</span>
      {sectionLabel(s)}
      {s === 'health' ? (
        <ErrorCount n={openErrors} testId="admin-nav-health-count" className="ms-auto max-md:ms-0" />
      ) : null}
    </Link>
  );

  return (
    <main className="w-full px-4 py-5 md:px-6" data-testid="admin-hub">
      <header className="mb-4 space-y-1">
        <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-md:text-2xl">
          {t('admin.title')}
        </h1>
        <p className="text-sm text-muted">{t('admin.subtitle', { account: account.name })}</p>
      </header>
      <div className="flex gap-6 max-md:flex-col max-md:gap-4">
        <nav
          aria-label={t('admin.nav')}
          data-testid="admin-nav"
          data-tour="admin.nav"
          className={cn(
            'shrink-0 md:sticky md:top-4 md:w-[220px] md:self-start',
            'md:rounded-[var(--radius-lg)] md:border md:border-line md:bg-surface md:p-2',
            // A phone: one scrolling row of chips (no page-wide horizontal scroll).
            'max-md:-mx-4 max-md:flex max-md:gap-1.5 max-md:overflow-x-auto max-md:px-4 max-md:pb-1',
          )}
        >
          {GROUPS.map((g, i) => (
            <div
              key={i}
              className={cn(
                'md:space-y-0.5',
                i > 0 && 'md:mt-2 md:border-t md:border-line-soft md:pt-2',
                'max-md:contents',
              )}
            >
              {g.label ? (
                <div className="px-2.5 pt-1 pb-1 text-[0.6875rem] font-semibold text-muted max-md:hidden">
                  {t(g.label)}
                </div>
              ) : null}
              {g.sections.map(navItem)}
            </div>
          ))}
        </nav>
        <section className="min-w-0 flex-1" data-testid={`admin-section-${current}`} data-section={current}>
          <Outlet />
        </section>
      </div>
    </main>
  );
};

/** A section that comes in a later stage (A3–A5): what it will hold, as an empty state. */
export const AdminNextStage = ({ section }: { section: AdminSection }) => (
  <div className="rounded-[var(--radius-lg)] border border-line bg-surface">
    <EmptyState
      testId="admin-next-stage"
      icon={<span className="scale-150">{ICONS[section]}</span>}
      title={`${sectionLabel(section)} — ${t('admin.next.title')}`}
    >
      {t(`admin.next.${section}` as MessageKey)}
    </EmptyState>
  </div>
);
