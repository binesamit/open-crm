// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { exactTime, type Inbox, type InboxEntry, relativeTime, t, updateLinkSearch } from '@bines/shared';
import { Avatar, Button, cn, Input, Notice, Segmented, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage, type MyAccount } from '../../lib/api';
import { useMembers } from '../board/board-api';
import { emailImageSrc } from '../item/EmailUpdateParts';
import { UpdateBody } from '../item/UpdateBody';
import { SeenBy, useMarkSeen } from '../item/seen-by';
import { useInboxSeenLive } from '../item/seen-live';
import { inboxKeys } from './InboxButton';

const inboxKey = (accountId: string, mentions: boolean, showRead: boolean) =>
  ['account', accountId, 'inbox', mentions, showRead] as const;

/**
 * Inbox (07 §9.3): updates and replies on items I follow, and mentions of me, from the last 6 months —
 * newest first, with a reply box under each. "V" marks one read (it leaves the list), "mark all read" empties
 * it; read ones can be shown again. Live through the top bar's Inbox button (it refreshes these queries).
 */
export const InboxPage = ({ account }: { account: MyAccount }) => {
  const qc = useQueryClient();
  const [mentions, setMentions] = useState(false);
  const [showRead, setShowRead] = useState(false);
  // "20 min ago" is computed against the time the page opened (render stays pure).
  const [now] = useState(() => Date.now());
  const members = useMembers(account.id).data?.data ?? [];
  // r16seen: "seen by" on the entries, live (/me/events carries `update.seen` of updates in my Inbox).
  useInboxSeenLive(account.id);
  const inbox = useInfiniteQuery({
    queryKey: inboxKey(account.id, mentions, showRead),
    queryFn: ({ pageParam }) =>
      api(account.id).get<Inbox>(
        `/me/inbox?${new URLSearchParams({
          ...(mentions ? { mentions: '1' } : {}),
          ...(showRead ? { read: '1' } : {}),
          ...(pageParam ? { before: pageParam } : {}),
        })}`,
      ),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const read = useMutation({
    mutationFn: (ids: string[] | null) => api(account.id).post('/me/inbox/read', ids ? { ids } : { all: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: inboxKeys.all(account.id) }),
  });
  const entries = inbox.data?.pages.flatMap((p) => p.data) ?? [];
  const unread = entries.filter((e) => !e.read).length;
  // The same count as the sidebar's Inbox badge (shared query).
  const unreadCount =
    useQuery({
      queryKey: inboxKeys.count(account.id),
      queryFn: () => api(account.id).get<{ unread: number }>('/me/inbox/count'),
    }).data?.unread ?? 0;

  return (
    <main className="w-full space-y-4 px-4 py-5 md:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 max-md:flex-col max-md:items-start">
        <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-sm:text-2xl">
          {t('nav.inbox')}
        </h1>
        <Button
          variant="secondary"
          size="sm"
          data-testid="inbox-read-all"
          disabled={!unread}
          busy={read.isPending && read.variables === null}
          onClick={() => read.mutate(null)}
        >
          {t('inbox.readAll')}
        </Button>
      </header>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label={t('nav.inbox')}
          value={mentions ? 'mentions' : 'all'}
          onChange={(v) => setMentions(v === 'mentions')}
          options={[
            {
              value: 'all',
              testId: 'inbox-all',
              label: (
                <>
                  {t('inbox.all')}
                  {unreadCount ? (
                    <span className="grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-accent px-[0.3125rem] text-[0.6875rem] font-bold text-on-accent">
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  ) : null}
                </>
              ),
            },
            { value: 'mentions', testId: 'inbox-mentions', label: t('inbox.mentions') },
          ]}
        />
        <label className="flex items-center gap-2 text-[0.8125rem] text-fg-2">
          <Switch checked={showRead} onChange={setShowRead} testId="inbox-show-read" />
          {t('inbox.showRead')}
        </label>
      </div>
      {inbox.isError ? <Notice tone="error">{errorMessage(inbox.error)}</Notice> : null}
      {inbox.isPending ? (
        <SkeletonRows rows={4} label={t('app.loading')} className="max-w-[760px]" />
      ) : !entries.length ? (
        <p
          className="max-w-[760px] rounded-[var(--radius)] border border-line px-4 py-10 text-center text-sm text-muted"
          data-testid="inbox-empty"
        >
          {mentions ? t('inbox.emptyMentions') : t('inbox.empty')}
        </p>
      ) : (
        <ul className="flex max-w-[760px] flex-col gap-3" data-tour="inbox.list">
          {entries.map((e) => (
            <Entry
              key={e.id}
              account={account}
              entry={e}
              now={now}
              onRead={() => read.mutate([e.id])}
              member={members.find((m) => m.user_id === e.author?.id)}
              photoOf={(id) => members.find((m) => m.user_id === id)?.avatar_url}
            />
          ))}
        </ul>
      )}
      {inbox.hasNextPage ? (
        <div className="flex max-w-[760px] justify-center">
          <Button variant="secondary" busy={inbox.isFetchingNextPage} onClick={() => void inbox.fetchNextPage()}>
            {t('inbox.more')}
          </Button>
        </div>
      ) : null}
    </main>
  );
};

const Entry = ({
  account,
  entry: e,
  now,
  member,
  onRead,
  photoOf,
}: {
  account: MyAccount;
  entry: InboxEntry;
  now: number;
  member: { email: string; avatar_url: string | null } | undefined;
  onRead: () => void;
  /** A member's photo for the "seen by" avatars (the people list holds signed links). */
  photoOf: (userId: string) => string | null | undefined;
}) => {
  const [reply, setReply] = useState('');
  const [sent, setSent] = useState(false);
  // Read here counts as "seen" on the update (the server skips my own).
  const rootRef = useRef<HTMLLIElement>(null);
  useMarkSeen(rootRef, account.id, e.id);
  const send = useMutation({
    // Replies hang off the top-level update.
    mutationFn: () => api(account.id).post(`/updates/${e.id}/replies`, { body: reply.trim() }),
    onSuccess: () => {
      setReply('');
      setSent(true);
    },
  });
  const author = e.author?.name || member?.email || t('inbox.someone');
  const photo = member?.avatar_url ?? null;
  return (
    <li
      ref={rootRef}
      className={cn(
        'flex flex-col gap-2.5 rounded-[var(--radius-lg)] border p-4',
        e.read ? 'border-line bg-surface' : 'border-line-soft bg-surface-3',
      )}
      data-testid="inbox-entry"
      data-mention={e.mention ? 'true' : 'false'}
      data-read={e.read ? 'true' : 'false'}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {e.read ? null : <span aria-hidden className="mt-2.5 size-2 shrink-0 rounded-full bg-accent" />}
          <Avatar name={author} url={photo} size={28} />
          <div className="min-w-0">
            <p className="text-[0.8125rem]">
              <span className="font-semibold">{author}</span>{' '}
              <span>
                {e.mention ? t('inbox.mentionedIn') : e.parent_update_id ? t('inbox.replied') : t('inbox.wrote')}
              </span>
              <Link
                to="/a/$accountSlug/b/$boardId/i/$itemId"
                params={{ accountSlug: account.slug, boardId: e.board.id, itemId: e.item.id }}
                search={updateLinkSearch(e.id) as never}
                data-testid="inbox-open"
                className="font-semibold text-heading underline decoration-line-strong underline-offset-2 hover:decoration-current"
              >
                {e.item.name}
              </Link>
            </p>
            {/* s37reply2: the time opens this update alone too. */}
            <p className="text-[0.6875rem] text-muted">
              {e.board.name} ·{' '}
              <Link
                to="/a/$accountSlug/b/$boardId/i/$itemId"
                params={{ accountSlug: account.slug, boardId: e.board.id, itemId: e.item.id }}
                search={updateLinkSearch(e.id) as never}
                data-testid="inbox-time"
                data-tip={exactTime(e.created_at)}
                className="rounded-[4px] underline-offset-2 hover:text-fg hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
              >
                <time dateTime={e.created_at}>{relativeTime(e.created_at, now)}</time>
              </Link>
            </p>
          </div>
        </div>
        {e.read ? null : (
          <Button
            variant="ghost"
            size="sm"
            data-testid="inbox-done"
            aria-label={t('inbox.markRead')}
            onClick={onRead}
            className="max-md:hidden"
          >
            {t('inbox.markRead')}
          </Button>
        )}
      </div>
      {/* body_html is produced by the server from an allowlist (rich.ts / renderUpdateBody); never raw user HTML. */}
      <UpdateBody
        html={e.body_html}
        className="text-[0.875rem] leading-[1.6]"
        // an incoming email's images load through the app.
        imageSrc={emailImageSrc(account.id, e.id)}
      />
      {e.file_names.length > 0 && (
        <div data-testid="inbox-files" className="truncate text-[0.8125rem] text-muted">
          📎 {e.file_names.join(', ')}
        </div>
      )}
      {e.seen?.count ? (
        <div className="flex justify-end" data-testid="inbox-seen">
          <SeenBy accountId={account.id} updateId={e.id} seen={e.seen} now={now} photoOf={photoOf} />
        </div>
      ) : null}
      {/* The reply box: on entries that mention me (they ask something of me). */}
      {e.mention ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            if (reply.trim()) send.mutate();
          }}
        >
          <Input
            value={reply}
            onChange={(ev) => {
              setReply(ev.target.value);
              setSent(false);
            }}
            placeholder={t('inbox.replyPlaceholder')}
            aria-label={t('inbox.replyPlaceholder')}
            data-testid="inbox-reply"
            className="min-w-0 flex-1"
          />
          <Button
            type="submit"
            // Readable while empty in both themes: bordered until there is something to send.
            variant={reply.trim() || send.isPending ? 'primary' : 'secondary'}
            busy={send.isPending}
            disabled={!reply.trim()}
            data-testid="inbox-reply-send"
            className="disabled:opacity-60"
          >
            {t('inbox.reply')}
          </Button>
        </form>
      ) : null}
      {sent ? (
        <p className="text-xs text-muted" data-testid="inbox-reply-sent">
          {t('inbox.replySent')}
        </p>
      ) : null}
      {send.isError ? <Notice tone="error">{errorMessage(send.error)}</Notice> : null}
    </li>
  );
};
