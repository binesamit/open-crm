// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDateTime,
  type SupportConsoleConfig,
  type SupportMode,
  TICKET_PRIORITIES,
  TICKET_REPLY_MAX_ARTICLES,
  TICKET_STATUSES,
  type TicketArticle,
  type TicketArticleList,
  type TicketDetail,
  type TicketStatus,
  t as tr,
  tDynamic,
  paint,
} from '@bines/shared';
import {
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  EmptyState,
  Field,
  Input,
  Menu,
  Notice,
  Picker,
  SearchField,
  Segmented,
  SkeletonRows,
  useActionMenu,
} from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { formatSize } from '../../../lib/upload';
import { showToast } from '../../../lib/toast';
import { durationLabel } from '../../admin/SupportAccessPanel';
import { useDebounced } from '../../../lib/use-debounced';
import { HitList } from '../../support/HelpPieces';
import { TEXTAREA } from '../../support/NewTicketDialog';
import { TicketArticleCards } from '../../support/TicketArticles';
import { priorityLabel, statusLabel, statusTone, systemText } from '../../support/support-api';
import { SupportAgentPanel } from '../errors/SupportAgent';
import { consoleKeys, useConsoleTicket } from './console-api';

/**
 * One ticket in the console: the whole thread (internal notes marked), reply or note (with a canned
 * reply and the status after it), status / priority / category / queue / assignee / tags, the SLA timers, what the
 * customer attached (page, browser, errors), access requests ("request access": view by default) and the history.
 * Nothing of the account's data is here — that needs an approved access request.
 */
export const ConsoleTicket = ({
  id,
  config,
  onClose,
}: {
  id: string;
  config: SupportConsoleConfig;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const q = useConsoleTicket(id);
  const set = (t: TicketDetail) => {
    qc.setQueryData(consoleKeys.ticket(id), t);
    void qc.invalidateQueries({ queryKey: consoleKeys.allTickets });
  };
  const onError = (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' });
  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api().patch<TicketDetail>(`/platform/support/tickets/${id}`, body),
    onSuccess: set,
    onError,
  });
  const [body, setBody] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'internal'>('public');
  const [after, setAfter] = useState<TicketStatus | ''>('');
  // Knowledge-center articles for the reply: picked in the app's own dialog, sent as ids.
  const [articles, setArticles] = useState<TicketArticle[]>([]);
  const [picking, setPicking] = useState(false);
  const send = useMutation({
    mutationFn: () =>
      api().post<TicketDetail>(`/platform/support/tickets/${id}/messages`, {
        body,
        visibility,
        ...(after ? { status: after } : {}),
        ...(articles.length ? { article_ids: articles.map((a) => a.id) } : {}),
      }),
    onSuccess: (t) => {
      set(t);
      setBody('');
      setAfter('');
      setArticles([]);
    },
    onError,
  });
  const cancel = useMutation({
    mutationFn: (requestId: string) =>
      api().post<TicketDetail>(`/platform/support/access-requests/${requestId}/cancel`),
    onSuccess: set,
    onError,
  });
  const [asking, setAsking] = useState(false);
  // The knowledge center (stage 6): a solved ticket → an article draft (personal details removed).
  const toArticle = useMutation({
    mutationFn: () => api().post<{ id: string; title: string }>(`/platform/support/tickets/${id}/article`),
    onSuccess: (a) => {
      void qc.invalidateQueries({ queryKey: ['platform', 'help'] });
      showToast({ message: tr('help.fromTicketDone', { title: a.title }) });
    },
    onError,
  });
  const cannedMenu = useActionMenu();
  const tagMenu = useActionMenu();

  if (q.isPending) return <SkeletonRows rows={6} label={tr('app.loading')} />;
  if (q.isError) return <Notice tone="error">{errorMessage(q.error)}</Notice>;
  const t = q.data;
  const done = t.status === 'solved' || t.status === 'closed';
  const sla = t.sla;
  const tagIds = (t.tags ?? []).map((x) => x.id);
  const canned = config.canned.filter((c) => !c.archived && (!c.queue_id || c.queue_id === t.queue?.id));

  return (
    <div className="space-y-3" data-testid="console-ticket" data-status={t.status}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="font-mono" dir="ltr" data-testid="console-ticket-number">
              #{t.number}
            </span>
            <Badge tone={statusTone(t.status)}>{statusLabel(t.status)}</Badge>
            <span>
              {t.account?.name} · {t.requester.name} ({t.requester.email})
            </span>
          </div>
          <h2 className="font-display text-lg leading-tight font-bold text-heading" dir="auto">
            {t.subject}
          </h2>
        </div>
        {done ? (
          <Button
            variant="secondary"
            size="sm"
            busy={toArticle.isPending}
            onClick={() => toArticle.mutate()}
            title={tr('help.fromTicketHint')}
            data-testid="console-ticket-to-article"
          >
            <Icon name="file" size={14} />
            {tr('help.fromTicket')}
          </Button>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onClose} aria-label={tr('common.close')}>
          <Icon name="x" size={14} />
        </Button>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <Field label={tr('tickets.field.status')}>
          <Picker
            label={tr('tickets.field.status')}
            value={t.status}
            testId="console-status"
            options={TICKET_STATUSES.map((s) => ({ value: s, label: statusLabel(s), testId: `console-status-${s}` }))}
            onChange={(s) => patch.mutate({ status: s })}
          />
        </Field>
        <Field label={tr('tickets.field.priority')}>
          <Picker
            label={tr('tickets.field.priority')}
            value={t.priority}
            testId="console-priority"
            options={TICKET_PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))}
            onChange={(p) => patch.mutate({ priority: p })}
          />
        </Field>
        <Field label={tr('tickets.field.assignee')}>
          <Picker
            label={tr('tickets.field.assignee')}
            value={t.assignee?.id ?? ''}
            testId="console-assignee"
            options={[
              { value: '', label: tr('tickets.assignee.none') },
              ...config.agents.map((a) => ({ value: a.id, label: a.name, testId: `console-assignee-${a.id}` })),
            ]}
            onChange={(v) => patch.mutate({ assignee_id: v || null })}
          />
        </Field>
        <Field label={tr('tickets.field.category')}>
          <Picker
            label={tr('tickets.field.category')}
            value={t.category?.id ?? ''}
            options={[
              { value: '', label: tr('tickets.category.none') },
              ...config.categories.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.name })),
            ]}
            onChange={(v) => patch.mutate({ category_id: v || null })}
          />
        </Field>
        <Field label={tr('tickets.field.queue')}>
          <Picker
            label={tr('tickets.field.queue')}
            value={t.queue?.id ?? ''}
            options={[
              { value: '', label: tr('tickets.queue.none') },
              ...config.queues.filter((x) => !x.archived).map((x) => ({ value: x.id, label: x.name })),
            ]}
            onChange={(v) => patch.mutate({ queue_id: v || null })}
          />
        </Field>
        <Field label={tr('tickets.field.tags')}>
          <button
            type="button"
            onClick={tagMenu.fromTrigger}
            data-testid="console-tags"
            className="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-[10px] border border-line-strong bg-surface px-2 py-1 text-start text-xs"
          >
            {(t.tags ?? []).length ? (
              (t.tags ?? []).map((x) => (
                <span
                  key={x.id}
                  className="rounded-full px-2 py-0.5 font-semibold text-white"
                  style={{ background: paint(x.color) ?? 'var(--muted)' }}
                >
                  {x.name}
                </span>
              ))
            ) : (
              <span className="text-muted">{tr('tickets.tags.none')}</span>
            )}
          </button>
          <Menu
            at={tagMenu.at}
            onClose={tagMenu.close}
            label={tr('tickets.field.tags')}
            items={config.tags.map((x) => ({
              label: x.name,
              checked: tagIds.includes(x.id),
              onSelect: () =>
                patch.mutate({
                  tag_ids: tagIds.includes(x.id) ? tagIds.filter((y) => y !== x.id) : [...tagIds, x.id],
                }),
            }))}
          />
        </Field>
      </div>

      {sla ? (
        <div className="flex flex-wrap gap-3 text-xs" data-testid="console-sla">
          <SlaChip
            label={tr('tickets.sla.first')}
            due={sla.first_response_due_at}
            done={sla.first_responded_at}
            breached={sla.first_response_breached}
          />
          <SlaChip
            label={tr('tickets.sla.resolution')}
            due={sla.resolution_due_at}
            done={t.solved_at}
            breached={sla.resolution_breached}
            paused={sla.paused}
          />
        </div>
      ) : null}

      {t.context && Object.keys(t.context).length ? (
        <details className="rounded-[10px] bg-surface-2 px-3 py-2 text-xs" data-testid="console-context">
          <summary className="cursor-pointer font-semibold text-fg-2">{tr('tickets.context.title')}</summary>
          <dl className="mt-1.5 space-y-1">
            {t.context.page_url ? (
              <div className="flex gap-2">
                <dt className="text-muted">{tr('tickets.context.page')}</dt>
                <dd className="break-all" dir="ltr">
                  {t.context.page_url}
                </dd>
              </div>
            ) : null}
            {t.context.browser || t.context.os ? (
              <div className="flex gap-2">
                <dt className="text-muted">{tr('tickets.context.browser')}</dt>
                <dd dir="ltr">{[t.context.browser, t.context.os, t.context.screen].filter(Boolean).join(' · ')}</dd>
              </div>
            ) : null}
            {(t.context.errors ?? []).map((e, i) => (
              <div key={i} className="flex gap-2">
                <dt className="text-muted">{tr('tickets.context.error')}</dt>
                <dd className="break-all text-danger-fg" dir="ltr">
                  {e.message} <span className="text-muted">{formatDateTime(e.at)}</span>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : null}

      <SupportAgentPanel ticketId={id} />

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="flex-1 text-sm font-semibold text-fg">{tr('tickets.access.title')}</h3>
          {!done ? (
            <Button variant="secondary" size="sm" onClick={() => setAsking(true)} data-testid="console-request-access">
              <Icon name="lock" size={14} />
              {tr('tickets.access.request')}
            </Button>
          ) : null}
        </div>
        {t.access_requests.map((r) => (
          <div
            key={r.id}
            data-testid="console-access-request"
            data-status={r.status}
            className="flex flex-wrap items-center gap-2 rounded-[10px] border border-line px-3 py-2 text-xs"
          >
            <Badge tone={r.status === 'pending' ? 'warn' : r.status === 'approved' ? 'ok' : 'neutral'}>
              {tr(`tickets.access.status.${r.grant_status === 'revoked' ? 'revoked' : r.status}`)}
            </Badge>
            <span>
              {tr(`support.mode.${r.mode}`)} · {durationLabel(r.duration_hours)} · {r.requested_by.name}
            </span>
            <span className="min-w-0 flex-1 truncate text-muted" dir="auto">
              {r.reason}
            </span>
            {r.grant_status === 'active' && r.grant_expires_at ? (
              <span className="text-ok-fg">
                {tr('tickets.access.until', { date: formatDateTime(r.grant_expires_at) })}
              </span>
            ) : null}
            {r.status === 'pending' ? (
              <Button variant="ghost" size="sm" busy={cancel.isPending} onClick={() => cancel.mutate(r.id)}>
                {tr('tickets.access.cancel')}
              </Button>
            ) : null}
          </div>
        ))}
        {asking && t.access_options ? (
          <RequestAccessDialog t={t} onClose={() => setAsking(false)} onDone={set} />
        ) : null}
      </section>

      <ol className="space-y-2" data-testid="console-thread">
        {t.messages.map((m) =>
          m.kind === 'system' ? (
            <li key={m.id} className="text-center text-xs text-muted">
              {systemText(m.body)} · {formatDateTime(m.created_at)}
            </li>
          ) : (
            <li
              key={m.id}
              data-testid="console-message"
              data-visibility={m.visibility}
              className={cn(
                'rounded-[12px] border px-3 py-2',
                m.visibility === 'internal'
                  ? 'border-warn bg-warn-soft'
                  : m.kind === 'staff'
                    ? 'border-info bg-info-soft'
                    : 'border-line bg-surface',
              )}
            >
              <div className="mb-0.5 flex items-center gap-2 text-xs text-muted">
                <span className="font-semibold text-fg-2">{m.author?.name}</span>
                {m.visibility === 'internal' ? <Badge tone="warn">{tr('tickets.note.internal')}</Badge> : null}
                <span>{formatDateTime(m.created_at)}</span>
              </div>
              {m.body ? (
                <p className="text-sm whitespace-pre-wrap" dir="auto">
                  {m.body}
                </p>
              ) : null}
              {m.attachments.length ? (
                <ul className="mt-1.5 flex flex-wrap gap-1.5">
                  {m.attachments.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs"
                        onClick={() =>
                          void api()
                            .get<{ download_url: string }>(`/platform/support/tickets/${t.id}/attachments/${a.id}`)
                            .then((f) => window.open(f.download_url, '_blank', 'noopener'))
                            .catch(onError)
                        }
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
                testId="console-message-article"
                onOpen={(a) => window.open(a.url, '_blank', 'noopener')}
              />
            </li>
          ),
        )}
      </ol>

      <Card className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label={tr('tickets.reply.kind')}
            value={visibility}
            onChange={setVisibility}
            testId="console-visibility"
            options={[
              { value: 'public' as const, label: tr('tickets.reply.public'), testId: 'console-visibility-public' },
              { value: 'internal' as const, label: tr('tickets.note.internal'), testId: 'console-visibility-internal' },
            ]}
          />
          {canned.length ? (
            <>
              <Button variant="ghost" size="sm" onClick={cannedMenu.fromTrigger} data-testid="console-canned">
                {tr('tickets.canned.insert')}
              </Button>
              <Menu
                at={cannedMenu.at}
                onClose={cannedMenu.close}
                label={tr('tickets.canned.insert')}
                items={canned.map((c) => ({
                  label: c.title,
                  onSelect: () => setBody((b) => (b.trim() ? `${b}\n\n${c.body}` : c.body)),
                }))}
              />
            </>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPicking(true)}
            disabled={articles.length >= TICKET_REPLY_MAX_ARTICLES}
            title={
              articles.length >= TICKET_REPLY_MAX_ARTICLES
                ? tr('tickets.article.max', { n: TICKET_REPLY_MAX_ARTICLES })
                : undefined
            }
            data-testid="console-attach-article"
          >
            <Icon name="book" size={14} />
            {tr('tickets.article.attach')}
          </Button>
        </div>
        {articles.length ? (
          <ul className="flex flex-wrap gap-1.5" data-testid="console-reply-articles">
            {articles.map((a) => (
              <li
                key={a.id}
                data-testid="console-reply-article"
                data-id={a.id}
                className="inline-flex h-7 max-w-full items-center gap-1 rounded-full bg-surface-2 ps-2.5 pe-1 text-xs"
              >
                <Icon name="book" size={12} />
                <span className="truncate" dir="auto">
                  {a.title}
                </span>
                <button
                  type="button"
                  className="grid size-5 place-items-center rounded-full text-muted hover:bg-surface hover:text-fg"
                  aria-label={tr('tickets.article.remove', { title: a.title })}
                  onClick={() => setArticles((list) => list.filter((x) => x.id !== a.id))}
                >
                  <Icon name="x" size={12} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {picking ? (
          <ArticlePickerDialog
            ticket={t}
            chosen={articles}
            onClose={() => setPicking(false)}
            onPick={(a) => {
              setArticles((list) => (list.some((x) => x.id === a.id) ? list : [...list, a]));
              setPicking(false);
            }}
          />
        ) : null}
        <textarea
          className={cn(TEXTAREA, visibility === 'internal' && 'bg-warn-soft')}
          value={body}
          data-testid="console-reply"
          placeholder={tr(visibility === 'internal' ? 'tickets.note.placeholder' : 'tickets.reply.placeholderStaff')}
          onChange={(e) => setBody(e.target.value)}
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="text-xs text-muted">{tr('tickets.reply.statusAfter')}</span>
          <Picker
            label={tr('tickets.reply.statusAfter')}
            className="w-44"
            value={after}
            onChange={setAfter}
            testId="console-status-after"
            options={[
              { value: '' as const, label: tr('tickets.reply.keepStatus') },
              ...TICKET_STATUSES.map((s) => ({ value: s, label: statusLabel(s) })),
            ]}
          />
          <Button
            variant="accent"
            busy={send.isPending}
            disabled={!body.trim() && !articles.length}
            onClick={() => send.mutate()}
            data-testid="console-send"
          >
            <Icon name="send" size={14} />
            {tr(visibility === 'internal' ? 'tickets.note.save' : 'tickets.reply.send')}
          </Button>
        </div>
      </Card>

      {t.events?.length ? (
        <details className="text-xs" data-testid="console-history">
          <summary className="cursor-pointer font-semibold text-fg-2">{tr('tickets.history')}</summary>
          <ol className="mt-1.5 space-y-0.5 text-muted">
            {t.events.map((e) => (
              <li key={e.id}>
                {formatDateTime(e.created_at)} · {e.actor?.name ?? tr('tickets.history.system')} ·{' '}
                {tDynamic(`tickets.event.${e.type.replace('.', '_')}`)}
                {e.type === 'status' ? ` (${statusLabel(e.data.to as TicketStatus)})` : ''}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
};

const SlaChip = ({
  label,
  due,
  done,
  breached,
  paused,
}: {
  label: string;
  due: string | null;
  done: string | null;
  breached: boolean;
  paused?: boolean;
}) => {
  if (!due) return null;
  return (
    <span
      data-testid="console-sla-chip"
      data-breached={breached ? 'true' : 'false'}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-semibold',
        breached ? 'bg-danger-soft text-danger-fg' : done ? 'bg-ok-soft text-ok-fg' : 'bg-surface-2 text-fg-2',
      )}
      title={formatDateTime(due)}
    >
      <Icon name="clock" size={12} />
      {label}: {done ? tr('tickets.sla.met') : paused ? tr('tickets.sla.paused') : formatDateTime(due)}
      {breached ? ` · ${tr('tickets.sla.breached')}` : ''}
    </span>
  );
};

const RequestAccessDialog = ({
  t,
  onClose,
  onDone,
}: {
  t: TicketDetail;
  onClose: () => void;
  onDone: (t: TicketDetail) => void;
}) => {
  const o = t.access_options!;
  const [mode, setMode] = useState<SupportMode>(o.default_mode);
  const [hours, setHours] = useState(o.default_duration_hours);
  const [reason, setReason] = useState('');
  const ask = useMutation({
    mutationFn: () =>
      api().post<TicketDetail>(`/platform/support/tickets/${t.id}/access-requests`, {
        mode,
        duration_hours: hours,
        reason,
      }),
    onSuccess: (res) => {
      onDone(res);
      showToast({ message: tr('tickets.access.requested') });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={tr('tickets.access.request')}
      subtitle={`#${t.number} · ${t.account?.name ?? ''}`}
    >
      <div className="space-y-3" data-testid="console-access-dialog">
        <p className="text-xs text-muted">{tr('tickets.access.requestHint')}</p>
        <Field label={tr('support.access')}>
          <Segmented
            label={tr('support.access')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'view' as const, label: tr('support.mode.view') },
              ...(o.allow_edit ? [{ value: 'edit' as const, label: tr('support.mode.edit') }] : []),
            ]}
          />
        </Field>
        <Field label={tr('support.duration')}>
          <Segmented
            label={tr('support.duration')}
            value={String(hours)}
            onChange={(v) => setHours(Number(v))}
            options={o.durations_hours.map((h) => ({ value: String(h), label: durationLabel(h) }))}
          />
        </Field>
        <Field label={tr('support.reason')}>
          <Input
            value={reason}
            maxLength={500}
            onChange={(e) => setReason(e.target.value)}
            data-testid="console-access-reason"
          />
        </Field>
        {ask.isError ? <Notice tone="error">{errorMessage(ask.error)}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {tr('common.cancel')}
          </Button>
          <Button
            variant="accent"
            disabled={!reason.trim()}
            busy={ask.isPending}
            onClick={() => ask.mutate()}
            data-testid="console-access-send"
          >
            {tr('tickets.access.send')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
};

/**
 * "Attach an article": the app's own search dialog over the published articles the ticket's customer
 * may read (the server decides), the help panel's list look; picking one adds it to the reply.
 */
const ArticlePickerDialog = ({
  ticket,
  chosen,
  onClose,
  onPick,
}: {
  ticket: TicketDetail;
  chosen: TicketArticle[];
  onClose: () => void;
  onPick: (a: TicketArticle) => void;
}) => {
  const [query, setQuery] = useState('');
  const q = useDebounced(query.trim(), 300);
  const list = useQuery({
    queryKey: ['platform', 'support', 'ticket-articles', ticket.id, q],
    queryFn: () =>
      api().get<TicketArticleList>(
        `/platform/support/tickets/${ticket.id}/articles${q ? `?q=${encodeURIComponent(q)}` : ''}`,
      ),
  });
  const hits = (list.data?.data ?? []).filter((a) => !chosen.some((c) => c.id === a.id));
  return (
    <Dialog
      open
      onClose={onClose}
      title={tr('tickets.article.pickerTitle')}
      subtitle={`#${ticket.number} · ${ticket.subject}`}
      className="max-w-xl!"
    >
      <div className="space-y-3" data-testid="console-article-picker">
        <p className="text-xs text-muted">{tr('tickets.article.pickerHint')}</p>
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={tr('tickets.article.search')}
          testId="console-article-search"
          autoFocus
        />
        {list.isPending ? (
          <SkeletonRows rows={4} label={tr('app.loading')} />
        ) : list.isError ? (
          <Notice tone="error">{errorMessage(list.error)}</Notice>
        ) : !list.data.enabled ? (
          <Notice tone="info">{tr('tickets.article.off')}</Notice>
        ) : hits.length ? (
          <HitList hits={hits} onOpen={onPick} testId="console-article-option" />
        ) : (
          <EmptyState className="py-6" testId="console-article-empty" title={tr('tickets.article.none')} />
        )}
      </div>
    </Dialog>
  );
};
