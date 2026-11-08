// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  type AccessRequest,
  formatDateTime,
  type MyAccount,
  type TicketDetail,
  type TicketMessage,
  t as tr,
} from '@bines/shared';
import { Badge, Button, Card, cn, Notice, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { formatSize } from '../../lib/upload';
import { showToast } from '../../lib/toast';
import { durationLabel } from '../admin/SupportAccessPanel';
import { TEXTAREA } from './NewTicketDialog';
import { TicketArticleCards } from './TicketArticles';
import { priorityLabel, statusLabel, statusTone, systemText, ticketKeys, useTicket } from './support-api';

/**
 * One ticket, the customer's view (/a/:slug/support/:id): the public thread (never internal notes)
 * reply, close / reopen, rate when done, and — for admins — support's access requests with "approve" (one click
 * creates the support grant, linked to this ticket) and "decline". `approve` (from the email's link) marks the request.
 */
export const TicketPage = ({
  account,
  ticketId,
  approve,
}: {
  account: MyAccount;
  ticketId: string;
  approve?: string;
}) => {
  const qc = useQueryClient();
  const q = useTicket(account.id, ticketId);
  const set = (t: TicketDetail) => {
    qc.setQueryData(ticketKeys.one(account.id, ticketId), t);
    void qc.invalidateQueries({ queryKey: ticketKeys.all(account.id), exact: false, refetchType: 'none' });
  };
  const call = (path: string, body?: unknown) => api(account.id).post<TicketDetail>(path, body ?? {});
  const onError = (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' });
  const [reply, setReply] = useState('');
  const send = useMutation({
    mutationFn: () => call(`/support/tickets/${ticketId}/messages`, { body: reply }),
    onSuccess: (t) => {
      set(t);
      setReply('');
    },
    onError,
  });
  const close = useMutation({ mutationFn: () => call(`/support/tickets/${ticketId}/close`), onSuccess: set, onError });
  const reopen = useMutation({
    mutationFn: () => call(`/support/tickets/${ticketId}/reopen`),
    onSuccess: set,
    onError,
  });
  const decide = useMutation({
    mutationFn: (v: { id: string; ok: boolean }) =>
      call(`/support/access-requests/${v.id}/${v.ok ? 'approve' : 'decline'}`),
    onSuccess: (t, v) => {
      set(t);
      showToast({ message: tr(v.ok ? 'tickets.access.approvedToast' : 'tickets.access.declinedToast') });
    },
    onError,
  });

  if (q.isPending) return <SkeletonRows rows={6} label={tr('app.loading')} />;
  if (q.isError)
    return (
      <main className="mx-auto max-w-3xl px-4 py-6">
        <Notice tone="error">{errorMessage(q.error)}</Notice>
      </main>
    );
  const t = q.data;
  return (
    <main className="w-full px-4 py-5 md:px-6" data-testid="ticket-page" data-status={t.status}>
      <div className="mx-auto max-w-3xl space-y-4">
        <Link
          to={'/a/$accountSlug/support' as never}
          params={{ accountSlug: account.slug } as never}
          className="inline-flex items-center gap-1 text-sm text-link hover:underline"
        >
          <Icon name="back" size={14} />
          {tr('tickets.mine.title')}
        </Link>
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-muted" dir="ltr" data-testid="ticket-number">
              #{t.number}
            </span>
            <Badge tone={statusTone(t.status)}>{statusLabel(t.status)}</Badge>
            <span className="text-xs text-muted">{priorityLabel(t.priority)}</span>
            {t.category ? <span className="text-xs text-muted">· {t.category.name}</span> : null}
          </div>
          <h1 className="font-display text-[1.5rem] leading-tight font-extrabold text-heading" dir="auto">
            {t.subject}
          </h1>
        </header>

        {t.access_requests.length ? (
          <AccessRequests
            requests={t.access_requests}
            canApprove={t.can.approve_access}
            highlight={approve}
            busy={decide.isPending}
            onDecide={(id, ok) => decide.mutate({ id, ok })}
          />
        ) : null}

        <ol className="space-y-3" data-testid="ticket-thread">
          {t.messages.map((m) => (
            <Message key={m.id} m={m} account={account} ticketId={t.id} />
          ))}
        </ol>

        {t.can.reply ? (
          <Card className="space-y-2">
            <textarea
              className={TEXTAREA}
              value={reply}
              placeholder={tr('tickets.reply.placeholder')}
              data-testid="ticket-reply"
              onChange={(e) => setReply(e.target.value)}
            />
            <div className="flex flex-wrap justify-end gap-2">
              {t.can.close ? (
                <Button
                  variant="ghost"
                  busy={close.isPending}
                  onClick={() => close.mutate()}
                  data-testid="ticket-close"
                >
                  {tr(t.status === 'solved' ? 'tickets.confirmSolved' : 'tickets.close')}
                </Button>
              ) : null}
              <Button
                variant="accent"
                busy={send.isPending}
                disabled={!reply.trim()}
                onClick={() => send.mutate()}
                data-testid="ticket-reply-send"
              >
                <Icon name="send" size={14} />
                {tr('tickets.reply.send')}
              </Button>
            </div>
          </Card>
        ) : null}
        {t.can.reopen ? (
          <div className="flex justify-end">
            <Button
              variant="secondary"
              busy={reopen.isPending}
              onClick={() => reopen.mutate()}
              data-testid="ticket-reopen"
            >
              {tr('tickets.reopen')}
            </Button>
          </div>
        ) : null}
        {t.can.rate ? <Rating account={account} t={t} onDone={set} /> : null}
      </div>
    </main>
  );
};

const Message = ({ m, account, ticketId }: { m: TicketMessage; account: MyAccount; ticketId: string }) => {
  const navigate = useNavigate();
  const accountId = account.id;
  if (m.kind === 'system')
    return (
      <li className="text-center text-xs text-muted" data-testid="ticket-message" data-kind="system">
        {systemText(m.body)} · {formatDateTime(m.created_at)}
      </li>
    );
  const staff = m.kind === 'staff';
  const download = async (id: string) => {
    try {
      const f = await api(accountId).get<{ download_url: string }>(`/support/tickets/${ticketId}/attachments/${id}`);
      window.open(f.download_url, '_blank', 'noopener');
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    }
  };
  return (
    <li
      data-testid="ticket-message"
      data-kind={m.kind}
      className={cn('rounded-[14px] border px-4 py-3', staff ? 'border-info bg-info-soft' : 'border-line bg-surface')}
    >
      <div className="mb-1 flex items-center gap-2 text-xs text-muted">
        <span className="font-semibold text-fg-2">{m.author?.name}</span>
        {staff ? <Badge tone="info">{tr('tickets.message.support')}</Badge> : null}
        <span>{formatDateTime(m.created_at)}</span>
      </div>
      {m.body ? (
        <p className="text-sm whitespace-pre-wrap text-fg" dir="auto">
          {m.body}
        </p>
      ) : null}
      {m.attachments.length ? (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {m.attachments.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => void download(a.id)}
                className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs text-fg-2 hover:text-fg"
              >
                <Icon name="clip" size={12} />
                {a.name} <span className="text-muted">{formatSize(a.size)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <TicketArticleCards
        articles={m.articles ?? []}
        onOpen={(a) =>
          void navigate({
            to: '/a/$accountSlug/help',
            params: { accountSlug: account.slug },
            search: { article: a.id },
          } as never)
        }
      />
    </li>
  );
};

const AccessRequests = ({
  requests,
  canApprove,
  highlight,
  busy,
  onDecide,
}: {
  requests: AccessRequest[];
  canApprove: boolean;
  highlight?: string;
  busy: boolean;
  onDecide: (id: string, ok: boolean) => void;
}) => (
  <ul className="space-y-2" data-testid="ticket-access-requests">
    {requests.map((r) => {
      const pending = r.status === 'pending';
      return (
        <li
          key={r.id}
          data-testid="ticket-access-request"
          data-status={r.status}
          className={cn(
            'space-y-2 rounded-[14px] border px-4 py-3',
            pending ? 'border-warn bg-warn-soft' : 'border-line bg-surface',
            highlight === r.id && pending && 'ring-2 ring-[var(--focus-ring)]',
          )}
        >
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Icon name="lock" size={15} />
            <span className="font-semibold text-fg">
              {tr('tickets.access.asks', {
                who: r.requested_by.name,
                mode: tr(`support.mode.${r.mode}`),
                duration: durationLabel(r.duration_hours),
              })}
            </span>
            <Badge tone={pending ? 'warn' : r.status === 'approved' ? 'ok' : 'neutral'}>
              {tr(`tickets.access.status.${r.grant_status === 'revoked' ? 'revoked' : r.status}`)}
            </Badge>
          </div>
          <p className="text-sm text-fg-2" dir="auto">
            {r.reason}
          </p>
          {pending && canApprove ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="accent"
                size="sm"
                busy={busy}
                onClick={() => onDecide(r.id, true)}
                data-testid="ticket-access-approve"
              >
                {tr('tickets.access.approve')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onDecide(r.id, false)}
                data-testid="ticket-access-decline"
              >
                {tr('tickets.access.decline')}
              </Button>
              <span className="text-xs text-muted">{tr('tickets.access.hint')}</span>
            </div>
          ) : pending ? (
            <p className="text-xs text-muted">{tr('tickets.access.adminsDecide')}</p>
          ) : null}
        </li>
      );
    })}
  </ul>
);

const Rating = ({ account, t, onDone }: { account: MyAccount; t: TicketDetail; onDone: (t: TicketDetail) => void }) => {
  const [rating, setRating] = useState(t.csat_rating ?? 0);
  const [comment, setComment] = useState(t.csat_comment ?? '');
  const save = useMutation({
    mutationFn: () =>
      api(account.id).post<TicketDetail>(`/support/tickets/${t.id}/rating`, {
        rating,
        ...(comment.trim() ? { comment } : {}),
      }),
    onSuccess: (res) => {
      onDone(res);
      showToast({ message: tr('tickets.rate.thanks') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  return (
    <Card className="space-y-2">
      <h2 className="text-sm font-semibold text-fg">{tr('tickets.rate.title')}</h2>
      <div className="flex gap-1" role="radiogroup" aria-label={tr('tickets.rate.title')} data-testid="ticket-rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={tr('tickets.rate.star', { n })}
            data-testid={`ticket-rate-${n}`}
            onClick={() => setRating(n)}
            className={cn('text-2xl leading-none', n <= rating ? 'text-warn' : 'text-line-strong hover:text-muted')}
          >
            ★
          </button>
        ))}
      </div>
      <textarea
        className={cn(TEXTAREA, 'min-h-16')}
        value={comment}
        placeholder={tr('tickets.rate.comment')}
        onChange={(e) => setComment(e.target.value)}
      />
      <div className="flex justify-end">
        <Button disabled={!rating} busy={save.isPending} onClick={() => save.mutate()} data-testid="ticket-rate-save">
          {tr('tickets.rate.send')}
        </Button>
      </div>
    </Card>
  );
};
