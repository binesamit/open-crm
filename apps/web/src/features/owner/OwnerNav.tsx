// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { t, type MessageKey } from '@bines/shared';
import { cn, Input } from '@bines/ui';
import { Icon, type IconName } from '../../lib/icons';
import { legalHref, useLegalDocs } from '../legal/legal-links';
import type { Me } from '../../lib/api';
import { ErrorCount, useUnreadErrorAlerts } from './errors/ErrorCount';
import { isOpenEmergency, useEmergencyRequests } from './EmergencyRequests';
import { usePendingDeletions } from './PendingDeletions';
import { usePendingSenders } from './SenderRequests';
import { usePendingSignupRequests } from './SignupRequests';
import { type OwnerSection, SUPPORT_SECTIONS } from './console-sections';
import { useCostSources } from './costs/costs-api';

const ICONS: Record<OwnerSection, IconName> = {
  overview: 'home',
  accounts: 'building',
  'signup-requests': 'inbox',
  emergency: 'lock',
  deletions: 'trash',
  plans: 'cards',
  signup: 'person',
  licensing: 'key',
  'ai-prices': 'sparkle',
  costs: 'chart',
  kits: 'template',
  extensions: 'ext',
  guides: 'book',
  legal: 'file',
  general: 'gear',
  security: 'shield',
  email: 'mail',
  connections: 'link',
  support: 'chat',
  errors: 'warn',
  incidents: 'shield',
};

/** The nav, in groups (the canvas approved); the overview stands alone at the top. */
const GROUPS: { label?: MessageKey; sections: OwnerSection[] }[] = [
  { sections: ['overview'] },
  { label: 'owner.group.customers', sections: ['accounts', 'signup-requests', 'emergency', 'deletions'] },
  { label: 'owner.group.commerce', sections: ['plans', 'signup', 'licensing', 'ai-prices', 'costs'] },
  { label: 'owner.group.content', sections: ['kits', 'extensions', 'guides', 'legal'] },
  { label: 'owner.group.platform', sections: ['general', 'security', 'email', 'connections'] },
  { label: 'owner.group.operations', sections: ['support', 'errors', 'incidents'] },
];

export const ownerSectionLabel = (s: OwnerSection) => t(`owner.section.${s}` as MessageKey);

/** The sections this person may open: everything for the platform owner, support and errors for support staff. */
export const sectionsFor = (owner: boolean) =>
  GROUPS.map((g) => ({ ...g, sections: g.sections.filter((s) => owner || SUPPORT_SECTIONS.includes(s)) })).filter(
    (g) => g.sections.length,
  );

/**
 * What waits for the owner, per section (the nav's red counts and the overview's list). Support staff ask only for
 * their unread error alerts.
 */
export const useConsoleCounts = (me: Me): Partial<Record<OwnerSection, number>> => {
  const owner = me.user.is_platform_owner;
  const signups = usePendingSignupRequests(owner).data?.data.length ?? 0;
  const deletions = usePendingDeletions(owner).data?.data.length ?? 0;
  const emergency = useEmergencyRequests(owner).data?.data.filter(isOpenEmergency).length ?? 0;
  const senders = usePendingSenders(owner).data?.data.length ?? 0;
  const errors = useUnreadErrorAlerts(me);
  // Costs: sources whose last sync failed.
  const costs = useCostSources(owner).data?.filter((s) => s.enabled && s.last_sync_ok === false).length ?? 0;
  return { 'signup-requests': signups, deletions, emergency, email: senders, errors, costs };
};

/** The words a section answers to in the nav's search: its name and what it holds. */
const matches = (s: OwnerSection, q: string) =>
  `${ownerSectionLabel(s)} ${t(`owner.keywords.${s}` as MessageKey)} ${s}`.toLowerCase().includes(q);

/**
 * The console's section nav (like Administration's): a card at the inline start with a search box
 * a scrolling row of chips on a phone.
 */
export const OwnerNav = ({
  current,
  owner,
  counts,
}: {
  current: OwnerSection;
  owner: boolean;
  counts: Partial<Record<OwnerSection, number>>;
}) => {
  const [find, setFind] = useState('');
  const statement = !!useLegalDocs().data?.some((d) => d.slug === 'accessibility');
  const q = find.trim().toLowerCase();
  const groups = sectionsFor(owner)
    .map((g) => ({ ...g, sections: q ? g.sections.filter((s) => matches(s, q)) : g.sections }))
    .filter((g) => g.sections.length);
  return (
    <nav
      aria-label={t('owner.nav')}
      data-testid="owner-nav"
      className={cn(
        'shrink-0 md:sticky md:top-4 md:w-[230px] md:self-start',
        'md:rounded-[var(--radius-lg)] md:border md:border-line md:bg-surface md:p-2',
        'max-md:-mx-4 max-md:flex max-md:gap-1.5 max-md:overflow-x-auto max-md:px-4 max-md:pb-1',
      )}
    >
      {owner ? (
        <div className="mb-1.5 max-md:hidden">
          <Input
            type="search"
            value={find}
            onChange={(e) => setFind(e.target.value)}
            placeholder={t('owner.nav.find')}
            aria-label={t('owner.nav.find')}
            data-testid="owner-nav-find"
            className="h-9 text-sm"
          />
        </div>
      ) : null}
      {!groups.length ? (
        <p className="px-2.5 py-2 text-xs text-muted" data-testid="owner-nav-none">
          {t('owner.nav.none')}
        </p>
      ) : null}
      {groups.map((g, i) => (
        <div
          key={g.label ?? i}
          className={cn(
            'md:space-y-0.5',
            i > 0 && 'md:mt-2 md:border-t md:border-line-soft md:pt-2',
            'max-md:contents',
          )}
        >
          {g.label ? (
            <div className="px-2.5 pt-1 pb-1 text-[0.6875rem] font-semibold text-muted max-md:hidden">{t(g.label)}</div>
          ) : null}
          {g.sections.map((s) => (
            <Link
              key={s}
              to="/owner"
              search={{ section: s }}
              aria-current={s === current ? 'page' : undefined}
              data-testid={`owner-section-${s}`}
              className={cn(
                'flex shrink-0 items-center gap-2.5 rounded-[10px] px-2.5 text-sm font-semibold whitespace-nowrap',
                'h-9 text-fg-2 hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
                'max-md:h-8 max-md:rounded-full max-md:border max-md:border-line max-md:bg-surface max-md:px-3',
                s === current &&
                  'bg-primary-soft text-heading hover:bg-primary-soft max-md:border-primary max-md:bg-primary-soft',
              )}
            >
              <span className={cn('max-md:hidden', s === current ? 'text-primary' : 'text-muted')}>
                <Icon name={ICONS[s]} size={16} className="shrink-0" />
              </span>
              {ownerSectionLabel(s)}
              <ErrorCount n={counts[s] ?? 0} testId={`owner-section-${s}-count`} className="ms-auto max-md:ms-0" />
            </Link>
          ))}
        </div>
      ))}
      {/* the console is outside the app's frame (no Help menu) — the accessibility statement here too. */}
      {statement ? (
        <a
          href={legalHref('accessibility')}
          target="_blank"
          rel="noopener"
          data-testid="owner-accessibility"
          className="mt-2 block border-t border-line-soft px-2.5 pt-2 text-xs text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] max-md:hidden"
        >
          {t('legal.menu.accessibility')}
        </a>
      ) : null}
    </nav>
  );
};

/** The overview's "waiting for you" list: one link per section with something open, or "nothing waits". */
export const WaitingList = ({ counts }: { counts: Partial<Record<OwnerSection, number>> }) => {
  const due = (Object.keys(counts) as OwnerSection[]).filter((s) => (counts[s] ?? 0) > 0);
  return (
    <section className="space-y-2.5" data-testid="owner-waiting">
      <h2 className="font-display text-base font-bold text-heading">{t('owner.overview.waiting')}</h2>
      {due.length ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2.5">
          {due.map((s) => (
            <Link
              key={s}
              to="/owner"
              search={{ section: s }}
              data-testid={`owner-waiting-${s}`}
              className="flex flex-col gap-0.5 rounded-[12px] border border-line bg-surface px-3.5 py-2.5 hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
            >
              <span className="font-display text-xl text-heading tabular-nums">{counts[s]}</span>
              <span className="text-xs text-muted">{ownerSectionLabel(s)}</span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted" data-testid="owner-waiting-none">
          {t('owner.overview.nothing')}
        </p>
      )}
    </section>
  );
};
