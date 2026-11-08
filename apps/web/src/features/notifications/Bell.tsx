// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  addDays,
  exactTime,
  localDateOf,
  localizeToolPreview,
  notificationSentence,
  relativeTime,
  t,
  type MessageKey,
  type Notification,
  type NotificationList,
  updateLinkSearch,
} from '@bines/shared';
import { Avatar, Button, cn, Segmented, SkeletonRows, useLayer } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage, type MyAccount } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { useEventStream } from '../../lib/realtime';
import { useMembers } from '../board/board-api';
import { useAppBadge } from '../../pwa/PwaHosts';

export const notificationKeys = {
  list: (accountId: string, unread: boolean) => ['account', accountId, 'notifications', unread] as const,
  all: (accountId: string) => ['account', accountId, 'notifications'] as const,
};

/** היום / אתמול / קודם by calendar day in the region's timezone (A3). */
const bucketOf = (iso: string, now: Date) => {
  const today = localDateOf(now);
  const day = localDateOf(iso);
  if (day >= today) return 'today';
  if (day === addDays(today, -1)) return 'yesterday';
  return 'earlier';
};

/** What a notification is about: a doc, a dashboard, an item — or a support ticket ("#1042 subject").
 * An automation's message about no item (a flow trigger's run) names its board. */
const subjectOf = (n: Notification) =>
  n.ticket
    ? `#${n.ticket.number} ${n.ticket.subject}`
    : (n.doc?.name ??
      n.dashboard?.name ??
      n.item?.name ??
      n.relation_view?.view_name ??
      (n.flow ? n.board?.name : undefined));

const sentence = (n: Notification, actor: string | undefined) =>
  notificationSentence({
    type: n.type,
    actor,
    item: subjectOf(n),
    column: n.column_title,
  });

/** The actor's and the item's names in bold, wherever they appear in the sentence. */
const boldNames = (text: string, names: (string | null | undefined)[]): ReactNode => {
  const parts = names.filter((x): x is string => !!x && text.includes(x));
  if (!parts.length) return text;
  const re = new RegExp(`(${parts.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`);
  return text.split(re).map((piece, i) =>
    parts.includes(piece) ? (
      <b key={i} className="font-semibold">
        {piece}
      </b>
    ) : (
      piece
    ),
  );
};

/**
 * Approve / reject an agent's request right from the bell (מ7); the run page shows the details. A decision marks
 * the request's notifications read for everyone, so the buttons disappear.
 */
const ApprovalButtons = ({
  accountId,
  approvalId,
  onDone,
}: {
  accountId: string;
  approvalId: string;
  onDone: () => void;
}) => {
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await api(accountId).post(`/agents/approvals/${approvalId}`, { decision });
      showToast({
        message: t((decision === 'approve' ? 'agents.approval.approved' : 'agents.approval.rejected') as MessageKey),
      });
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(false);
      onDone();
    }
  };
  return (
    <div className="flex gap-2 px-3.5 pb-2.5 ps-[2.875rem]" data-testid="bell-approval">
      <Button size="sm" busy={busy} onClick={() => void decide('approve')} data-testid="bell-approve">
        {t('agents.approval.approve')}
      </Button>
      <Button
        size="sm"
        variant="danger-outline"
        disabled={busy}
        onClick={() => void decide('reject')}
        data-testid="bell-reject"
      >
        {t('agents.approval.reject')}
      </Button>
    </div>
  );
};

/** A system notification (no actor): a tinted round icon instead of an avatar. */
const SystemIcon = ({ type }: { type: string }) => {
  const timer = type === 'time.forgotten';
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full',
        timer ? 'bg-danger-soft text-danger-fg' : 'bg-accent-soft text-accent-fg',
      )}
    >
      <Icon
        name={
          timer
            ? 'clock'
            : type === 'idoc_activity'
              ? 'doc'
              : type === 'automation' ||
                  type === 'ai_budget' ||
                  type === 'extension_update' ||
                  type === 'plan_limit' ||
                  type === 'flow_failed' ||
                  type === 'sender_request' ||
                  type === 'secret_reveals' ||
                  type === 'error_alert'
                ? 'bolt'
                : type.startsWith('ticket_')
                  ? 'chat'
                  : 'person'
        }
        size={13}
      />
    </span>
  );
};

/**
 * The bell (07 §9.3): unread count, the list grouped today / yesterday / earlier, "mark all read". New ones
 * arrive live on `/me/events`. A click marks it read and opens the item (on its updates tab for a mention or
 * reply, its time log for a forgotten timer).
 */
/** `align`: the edge the panel opens from — "start" in the sidebar (it opens over the content), "end" elsewhere. */
export const Bell = ({
  account,
  align = 'end',
  rail = false,
  compact = false,
  className,
}: {
  account: MyAccount;
  align?: 'start' | 'end';
  /** In the collapsed sidebar: a larger target and icon. */
  rail?: boolean;
  /** In the full sidebar header: a 28px button with a 16px icon. */
  compact?: boolean;
  /** Overrides the button's size (the top bar's 36px buttons). */
  className?: string;
}) => {
  const [open, setOpen] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const client = api(account.id);
  const members = useMembers(account.id).data?.data ?? [];
  const [now, setNow] = useState(() => new Date());

  const list = useQuery({
    queryKey: notificationKeys.list(account.id, unreadOnly),
    queryFn: () => client.get<NotificationList>(`/me/notifications${unreadOnly ? '?unread=1' : ''}`),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: notificationKeys.all(account.id) });
  useEventStream('/me/events', account.id, (e) => {
    if (e.type.startsWith('notification.') || e.type === 'resync') void refresh();
  });
  const read = useMutation({
    mutationFn: (ids: string[] | null) => client.post('/me/notifications/read', ids ? { ids } : { all: true }),
    onSuccess: refresh,
  });
  useLayer(
    panel,
    open,
    () => setOpen(false),
    undefined,
    () => button.current,
  );

  const unread = list.data?.unread_count ?? 0;
  // PWA (פ5): the app icon shows the same number.
  useAppBadge(account, list.data ? unread : null);
  const rows = list.data?.data ?? [];
  const groups = (['today', 'yesterday', 'earlier'] as const)
    .map((b) => ({ bucket: b, rows: rows.filter((n) => bucketOf(n.created_at, now) === b) }))
    .filter((g) => g.rows.length);

  const go = (n: Notification) => {
    setOpen(false);
    if (!n.read_at) read.mutate([n.id]);
    // A support ticket: the ticket opens (an access request: with "approve" marked).
    if (n.ticket) {
      void navigate({
        to: '/a/$accountSlug/support/$ticketId',
        params: { accountSlug: account.slug, ticketId: n.ticket.id },
      } as never);
      return;
    }
    // An agent's approval request opens its run (approve / reject there); the budget alert opens AI settings.
    if (n.agent) {
      void navigate({
        to: '/a/$accountSlug/agents/$agentId',
        params: { accountSlug: account.slug, agentId: n.agent.agent_id },
        search: { run: n.agent.run_id },
      } as never);
      return;
    }
    if (n.type === 'ai_budget' && account.role === 'admin') {
      void navigate({
        to: '/a/$accountSlug/admin/$section',
        params: { accountSlug: account.slug, section: 'ai' },
      });
      return;
    }
    // A plan limit near / reached: Administration → My plan.
    if (n.type === 'plan_limit' && account.role === 'admin') {
      void navigate({
        to: '/a/$accountSlug/admin/$section',
        params: { accountSlug: account.slug, section: 'plan' },
      });
      return;
    }
    // An external flow: a failure alert — or an automation's message about a flow
    // opens that flow's runs (the run marked) on the flows screen, to decide what to do.
    if (n.type === 'flow_failed' || n.flow) {
      void navigate({
        to: '/a/$accountSlug/flows',
        params: { accountSlug: account.slug },
        search: n.flow
          ? {
              connection: n.flow.connection_id,
              ...(n.flow.flow_id ? { flow: n.flow.flow_id } : {}),
              ...(n.flow.run_id ? { run: n.flow.run_id } : {}),
            }
          : {},
      } as never);
      return;
    }
    // The owner decided on a custom sender (S-46): Administration → General (Emails & SMS).
    if (n.type === 'sender_request' && account.role === 'admin') {
      void navigate({
        to: '/a/$accountSlug/admin/$section',
        params: { accountSlug: account.slug, section: 'general' },
      });
      return;
    }
    // An error of the account passed the threshold: Administration → Health.
    if (n.type === 'error_alert' && account.role === 'admin') {
      void navigate({
        to: '/a/$accountSlug/admin/$section',
        params: { accountSlug: account.slug, section: 'health' },
      });
      return;
    }
    // Many secret reveals in an hour: Administration → Security, where the secrets log is.
    if (n.type === 'secret_reveals' && account.role === 'admin') {
      void navigate({
        to: '/a/$accountSlug/admin/$section',
        params: { accountSlug: account.slug, section: 'security' },
      });
      return;
    }
    // Someone I invited joined: admins land in Administration → Users.
    if (n.type === 'invitation_accepted') {
      if (account.role === 'admin')
        void navigate({
          to: '/a/$accountSlug/admin/$section',
          params: { accountSlug: account.slug, section: 'users' },
        });
      return;
    }
    // An extension version waits for an admin's consent (ת6): Administration → תוספות.
    if (n.type === 'extension_update' && account.role === 'admin') {
      void navigate({
        to: '/a/$accountSlug/admin/$section',
        params: { accountSlug: account.slug, section: 'extensions' },
      });
      return;
    }
    // A doc notification opens the doc (at the comment thread, for a comment) — M8.
    if (n.doc) {
      void navigate({
        to: '/a/$accountSlug/d/$docId',
        params: { accountSlug: account.slug, docId: n.doc.id },
        search: n.doc.thread_id ? { thread: n.doc.thread_id } : {},
      } as never);
      return;
    }
    // Shared with me: the dashboard opens.
    if (n.dashboard) {
      void navigate({
        to: '/a/$accountSlug/dash/$dashboardId',
        params: { accountSlug: account.slug, dashboardId: n.dashboard.id },
      } as never);
      return;
    }
    // A relation column's view is gone (r19relfilter): the board opens with that column's settings.
    if (n.relation_view && n.board) {
      void navigate({
        to: '/a/$accountSlug/b/$boardId',
        params: { accountSlug: account.slug, boardId: n.board.id },
        search: n.relation_view.column_key ? { column_settings: n.relation_view.column_key } : {},
      } as never);
      return;
    }
    if (!n.board || !n.item) return;
    // s37reply: an update / reply opens on its own thread (a reply: scrolled to it).
    void navigate({
      to: '/a/$accountSlug/b/$boardId/i/$itemId',
      params: { accountSlug: account.slug, boardId: n.board.id, itemId: n.item.id },
      search: n.type === 'time.forgotten' ? { tab: 'time' } : n.update_id ? updateLinkSearch(n.update_id) : {},
    } as never);
  };

  const iconSize = rail ? 24 : compact ? 16 : 19;
  return (
    <div className="relative">
      <button
        ref={button}
        type="button"
        data-testid="bell"
        data-tour="nav.notifications"
        aria-expanded={open}
        aria-label={unread ? t('notifications.openUnread', { n: unread }) : t('notifications.title')}
        onClick={() => {
          setNow(new Date());
          setOpen((v) => !v);
        }}
        className={cn(
          'relative grid place-items-center text-shell-fg hover:bg-[var(--shell-hover)] hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
          rail ? 'size-12 rounded-[14px]' : compact ? 'size-7 rounded-[8px]' : 'size-10 rounded-[10px]',
          className,
        )}
      >
        <Icon name="bell" size={iconSize} />
        {unread ? (
          <>
            {/* The count is in the label; visually just a dot (F4 `.s-dot`). */}
            <span data-testid="bell-count" className="sr-only">
              {unread > 99 ? '99+' : unread}
            </span>
            <span
              aria-hidden
              className={cn(
                'absolute size-2 rounded-full border-2 border-shell bg-accent',
                rail ? 'top-2.5 end-2.5' : compact ? 'top-0.5 end-0.5' : 'top-2 end-2',
              )}
            />
          </>
        ) : null}
      </button>
      {open ? (
        <div
          ref={panel}
          role="dialog"
          aria-label={t('notifications.title')}
          data-testid="bell-panel"
          className={cn(
            'anim-pop absolute top-full z-popover mt-1.5 flex max-h-[min(560px,calc(100dvh-5rem))] w-[380px] max-w-[calc(100vw-2rem)] flex-col rounded-[14px] border border-line bg-surface text-fg shadow-[var(--shadow-pop)]',
            align === 'end' ? 'end-0' : 'start-0',
          )}
        >
          <div className="flex items-center justify-between gap-2 px-3.5 pt-3 pb-2">
            <h2 className="font-display text-[0.9375rem] leading-snug font-bold text-heading">
              {t('notifications.title')}
            </h2>
            <div className="flex items-center gap-0.5">
              <Button
                variant="ghost"
                size="sm"
                disabled={!unread || read.isPending}
                data-testid="bell-read-all"
                onClick={() => read.mutate(null)}
              >
                {t('notifications.readAll')}
              </Button>
              <Link
                to="/a/$accountSlug/settings/notifications"
                params={{ accountSlug: account.slug }}
                data-testid="bell-settings"
                aria-label={t('notifications.settings')}
                title={t('notifications.settings')}
                onClick={() => setOpen(false)}
                className="grid size-8 place-items-center rounded-[10px] text-fg-2 hover:bg-surface-2 hover:text-fg"
              >
                <Icon name="gear" size={16} />
              </Link>
            </div>
          </div>
          <div className="px-3.5 pb-2">
            <Segmented
              label={t('notifications.title')}
              value={unreadOnly ? 'unread' : 'all'}
              onChange={(f) => setUnreadOnly(f === 'unread')}
              options={(['all', 'unread'] as const).map((f) => ({
                value: f,
                label: t(`notifications.filter.${f}`),
                testId: `bell-filter-${f}`,
              }))}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto pb-3">
            {!rows.length && list.isPending ? (
              <SkeletonRows rows={4} label={t('app.loading')} className="px-3.5" />
            ) : !rows.length ? (
              <p className="px-3.5 py-8 text-center text-sm text-muted">{t('notifications.empty')}</p>
            ) : (
              groups.map((g) => (
                <section key={g.bucket}>
                  <h3 className="sticky top-0 z-[1] bg-surface px-3.5 pt-2 pb-1 text-[0.6875rem] font-semibold text-muted">
                    {t(`notifications.${g.bucket}`)}
                  </h3>
                  {g.rows.map((n) => {
                    const member = members.find((m) => m.user_id === n.actor?.id);
                    const photo = member?.avatar_url ?? null;
                    // A member without a display name shows by email (never an empty "?" avatar).
                    const actor = n.actor ? n.actor.name || member?.email || '' : undefined;
                    return (
                      <div key={n.id} className="relative">
                        <button
                          type="button"
                          data-testid="notification"
                          data-type={n.type}
                          data-read={n.read_at ? 'true' : 'false'}
                          onClick={() => go(n)}
                          className={cn(
                            'flex w-full items-start gap-2.5 px-3.5 py-2.5 text-start text-[0.8125rem] hover:bg-surface-2',
                            !n.read_at && 'bg-surface-3',
                          )}
                        >
                          {n.actor ? <Avatar name={actor ?? ''} url={photo} size={24} /> : <SystemIcon type={n.type} />}
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span>{boldNames(sentence(n, actor), [actor, subjectOf(n)])}</span>
                            {n.excerpt ? (
                              <span className="line-clamp-1 text-xs text-muted" data-testid="notification-excerpt">
                                {/* r27: an agent's approval request names its tool in the reader's language. */}
                                {n.agent ? localizeToolPreview(n.excerpt) : n.excerpt}
                              </span>
                            ) : null}
                            <time
                              dateTime={n.created_at}
                              title={exactTime(n.created_at)}
                              className="text-[0.6875rem] text-muted"
                            >
                              {relativeTime(n.created_at, now.getTime())}
                            </time>
                          </span>
                          {!n.read_at ? (
                            <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-accent" />
                          ) : null}
                        </button>
                        {n.type === 'agent_approval' && n.agent?.approval_id && !n.read_at ? (
                          <ApprovalButtons
                            accountId={account.id}
                            approvalId={n.agent.approval_id}
                            onDone={() => void refresh()}
                          />
                        ) : null}
                      </div>
                    );
                  })}
                </section>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};
