// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { helpRouteOf, type MyAccount, t } from '@bines/shared';
import { cn, Menu, useActionMenu } from '@bines/ui';
import { fetchMe, queryKeys } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { HelpPanel } from './HelpPanel';
import { useHelpAccess } from './kb-page';
import { NewTicketDialog } from './NewTicketDialog';
import { openFirstSteps } from '../checklist/FirstStepsPanel';
import { useChecklist, useChecklistActions } from '../checklist/checklist-api';
import { legalHref, useLegalDocs } from '../legal/legal-links';
import { AboutDialog } from '../legal/source-link';
import { useLaunchTour } from '../tours/TourHost';
import { useMyTours } from '../tours/tours-api';

/**
 * The "?" help entry point of the top bar: the knowledge center's page, the quick
 * help panel (articles for this page, search, the help assistant), "Open a ticket" (when the account
 * and the platform allow this person) and "My tickets", the installation and licensing guide — and
 * for the platform owner, their own guides in the owner console. Not shown to guests or inside an account opened by a
 * support grant. Without the knowledge center and tickets, the menu keeps the guides and the legal pages.
 *
 * Mount (features/shell/TopBar.tsx, inside an account, next to the bell):
 *   `{current ? <HelpMenu account={current} /> : null}`
 */
export const HelpMenu = ({ account, className }: { account: MyAccount; className?: string }) => {
  const menu = useActionMenu();
  const navigate = useNavigate();
  const { hidden, none, helpOn, mayOpen } = useHelpAccess(account);
  const [open, setOpen] = useState<false | { subject: string; description: string }>(false);
  const [panel, setPanel] = useState(false);
  const [about, setAbout] = useState(false);
  const me = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe, staleTime: 60_000 }).data;
  const statement = !!useLegalDocs().data?.some((d) => d.slug === 'accessibility');
  const owner = !!me?.user.is_platform_owner;
  // Guided tours: this screen's tour, and the list of all of them (each can run again).
  const tours = useMyTours(account.id, !hidden).data;
  const launch = useLaunchTour(account);
  // "First steps": offered again from here once closed.
  const checklist = useChecklist(account.id, account.role !== 'guest' && !account.support);
  const checklistActions = useChecklistActions(account.id);
  const route = helpRouteOf(useRouterState({ select: (s) => s.location.pathname }));
  const here = tours?.enabled
    ? tours.tours.filter((x) => x.route === route).sort((a, b) => a.position - b.position)[0]
    : undefined;
  // The guides and the legal pages are always there; the knowledge center and tickets only when offered.
  if (hidden) return null;
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-label={t('tickets.help')}
        title={t('tickets.help')}
        data-testid="help-menu"
        data-tour="nav.help"
        onClick={menu.fromTrigger}
        className={cn(
          // The shell's ink, like the bell next to it (sidebar, rail and phone header are all on the dark shell).
          'grid size-8 place-items-center rounded-full text-[0.9375rem] font-bold text-shell-fg hover:bg-[var(--shell-hover)] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
          className,
        )}
      >
        ?
      </button>
      <Menu
        at={menu.at}
        onClose={menu.close}
        label={t('tickets.help')}
        items={[
          ...(tours?.enabled && tours.tours.length
            ? [
                {
                  label: t('tour.menu.here'),
                  icon: <Icon name="play" size={15} />,
                  testId: 'help-tour-here',
                  disabled: !here,
                  // Not taken yet: the menu says so.
                  ...(here && !here.state ? { shortcut: t('tour.menu.new') } : {}),
                  onSelect: () => (here ? launch(here) : undefined),
                },
                {
                  label: t('tour.menu.all'),
                  icon: <Icon name="place" size={15} />,
                  testId: 'help-tours',
                  onSelect: () =>
                    void navigate({ to: '/a/$accountSlug/tours', params: { accountSlug: account.slug } } as never),
                },
                { kind: 'separator' as const },
              ]
            : []),
          ...(none
            ? []
            : [
                {
                  // The knowledge center's own page: categories, articles, search.
                  label: t('kb.menu.page'),
                  icon: <Icon name="book" size={15} />,
                  testId: 'help-kb-page',
                  disabled: !helpOn,
                  onSelect: () =>
                    void navigate({ to: '/a/$accountSlug/help', params: { accountSlug: account.slug } } as never),
                },
                {
                  // The quick panel over the current screen: its articles, a search, the assistant.
                  label: t('kb.menu.quick'),
                  icon: <Icon name="search" size={15} />,
                  testId: 'help-center',
                  // Shown while the options load (disabled), so the menu never shifts under the pointer.
                  disabled: !helpOn,
                  onSelect: () => setPanel(true),
                },
                {
                  label: t('tickets.menu.open'),
                  icon: <Icon name="chat" size={15} />,
                  testId: 'help-open-ticket',
                  // Shown while the options load (disabled), so the menu never shifts under the pointer.
                  disabled: !mayOpen,
                  onSelect: () => setOpen({ subject: '', description: '' }),
                },
                {
                  label: t('tickets.menu.mine'),
                  icon: <Icon name="inbox" size={15} />,
                  testId: 'help-my-tickets',
                  onSelect: () =>
                    void navigate({ to: '/a/$accountSlug/support', params: { accountSlug: account.slug } } as never),
                },
              ]),
          {
            // installing, licensing and the usual questions — in the app, in the person's language.
            label: t('guides.menu'),
            icon: <Icon name="book" size={15} />,
            testId: 'help-guide',
            onSelect: () =>
              void navigate({ to: '/a/$accountSlug/guide', params: { accountSlug: account.slug } } as never),
          },
          ...(owner
            ? [
                {
                  // The platform owner's private guides (owner console → Guides).
                  label: t('guides.menu.owner'),
                  icon: <Icon name="lock" size={15} />,
                  testId: 'help-owner-guides',
                  onSelect: () => void navigate({ to: '/owner', search: { section: 'guides' } } as never),
                },
              ]
            : []),
          ...(checklist.data?.available
            ? [
                {
                  // "First steps": the checklist again, after closing it.
                  label: t('checklist.menu'),
                  icon: <Icon name="check" size={15} />,
                  testId: 'help-first-steps',
                  onSelect: () => {
                    openFirstSteps();
                    void checklistActions.dismiss(false).catch(() => undefined);
                  },
                },
              ]
            : []),
          {
            // terms, privacy and the rest — the public pages, in a new tab.
            label: t('legal.menu'),
            icon: <Icon name="shield" size={15} />,
            testId: 'help-legal',
            onSelect: () => void window.open('/legal', '_blank', 'noopener'),
          },
          {
            // the product, its version, its licence and where its source is (AGPL section 13).
            label: t('about.menu'),
            icon: <Icon name="info" size={15} />,
            testId: 'help-about',
            onSelect: () => setAbout(true),
          },
          // the accessibility statement, one tap from every screen (while it is published).
          ...(statement
            ? [
                {
                  label: t('legal.menu.accessibility'),
                  icon: <Icon name="person" size={15} />,
                  testId: 'help-accessibility',
                  onSelect: () => void window.open(legalHref('accessibility'), '_blank', 'noopener'),
                },
              ]
            : []),
        ]}
      />
      <AboutDialog open={about} onClose={() => setAbout(false)} />
      {panel ? (
        <HelpPanel
          account={account}
          mayOpenTicket={mayOpen}
          onClose={() => setPanel(false)}
          onTicket={(subject, description) => {
            setPanel(false);
            setOpen({ subject, description });
          }}
        />
      ) : null}
      {open ? (
        <NewTicketDialog
          account={account}
          initialSubject={open.subject}
          initialDescription={open.description}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
};
