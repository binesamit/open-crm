// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  t,
  WEBHOOK_EVENTS,
  formatDateTime,
  type MessageKey,
  type StatusLabel,
  type Webhook,
  type WebhookDelivery,
  type WebhookEvent,
} from '@bines/shared';
import { Badge, Button, Field, Input, Notice, Picker, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { copyText } from '../../lib/entity-menu';
import { showToast } from '../../lib/toast';
import { BoardAccountContext } from '../board/board-context';
import type { BoardDetail } from '../board/board-api';

/**
 * Board webhooks (06 §2.17): subscribe a URL (Make / n8n "custom webhook") to an event of this board. The URL
 * must answer the challenge; deliveries are signed with the secret and retried; the log shows each attempt.
 */
const keyOf = (accountId: string, boardId: string) => ['account', accountId, 'board', boardId, 'webhooks'];

const needs = (e: WebhookEvent) => ({
  column: e === 'specific_column_changed' || e === 'status_changed' || e === 'file_added',
  /** The column may stay empty: any status column / any file column. */
  anyColumn: e === 'status_changed' || e === 'file_added',
  label: e === 'status_changed',
  group: e === 'item_moved_to_specific_group',
});

const AddForm = ({ board, onDone }: { board: BoardDetail; onDone: () => void }) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [event, setEvent] = useState<WebhookEvent>('item_created');
  const [column, setColumn] = useState('');
  const [label, setLabel] = useState('');
  const [group, setGroup] = useState('');
  const n = needs(event);
  const statusColumns = board.columns.filter((c) =>
    event === 'status_changed' ? c.type === 'status' : event === 'file_added' ? c.type === 'file' : c.type !== 'name',
  );
  const labels = (
    (board.columns.find((c) => c.id === column)?.settings as { labels?: StatusLabel[] } | undefined)?.labels ?? []
  ).filter((l) => !l.is_deactivated && l.label);
  const create = useMutation({
    mutationFn: () =>
      api(accountId).post<Webhook>(`/boards/${board.id}/webhooks`, {
        url: url.trim(),
        event,
        config: {
          ...(n.column && column ? { column_id: column } : {}),
          ...(n.label && label ? { label } : {}),
          ...(n.group && group ? { group_id: group } : {}),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keyOf(accountId, board.id) });
      onDone();
    },
  });
  const ready = /^https?:\/\//.test(url.trim()) && (!n.column || n.anyColumn || !!column) && (!n.group || !!group);
  return (
    <div className="space-y-3 rounded-[var(--radius)] border border-line p-3" data-testid="webhook-form">
      <Field label={t('webhook.url')} hint={t('webhook.url_hint')}>
        <Input
          dir="ltr"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://hook.eu1.make.com/…"
          data-testid="webhook-url"
        />
      </Field>
      <Field label={t('webhook.event')}>
        <Picker
          label={t('webhook.event')}
          value={event}
          onChange={(e) => {
            setEvent(e);
            setColumn('');
            setLabel('');
          }}
          testId="webhook-event"
          options={WEBHOOK_EVENTS.map((e) => ({ value: e, label: t(`webhook.ev.${e}` as MessageKey) }))}
        />
      </Field>
      {n.column ? (
        <Field label={t('webhook.column')}>
          <Picker
            label={t('webhook.column')}
            value={column}
            onChange={setColumn}
            placeholder={
              event === 'status_changed'
                ? t('webhook.any_status')
                : event === 'file_added'
                  ? t('auto.word.any_file_column')
                  : t('webhook.pick')
            }
            testId="webhook-column"
            options={statusColumns.map((c) => ({ value: c.id, label: c.title }))}
          />
        </Field>
      ) : null}
      {n.label && column ? (
        <Field label={t('webhook.label')}>
          <Picker
            label={t('webhook.label')}
            value={label}
            onChange={setLabel}
            placeholder={t('webhook.any_label')}
            testId="webhook-label"
            options={labels.map((l) => ({ value: l.label, label: l.label }))}
          />
        </Field>
      ) : null}
      {n.group ? (
        <Field label={t('webhook.group')}>
          <Picker
            label={t('webhook.group')}
            value={group}
            onChange={setGroup}
            placeholder={t('webhook.pick')}
            options={board.groups.map((g) => ({ value: g.id, label: g.title }))}
          />
        </Field>
      ) : null}
      {create.isError ? (
        <Notice tone="error">{t('webhook.error', { error: errorMessage(create.error) })}</Notice>
      ) : null}
      <div className="flex gap-2">
        <Button busy={create.isPending} disabled={!ready} onClick={() => create.mutate()} data-testid="webhook-save">
          {t('webhook.save')}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
      <p className="text-xs text-muted">{t('webhook.challenge_hint')}</p>
    </div>
  );
};

const Deliveries = ({ hook }: { hook: Webhook }) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const qc = useQueryClient();
  const key = ['account', accountId, 'webhook', hook.id, 'deliveries'];
  const log = useQuery({
    queryKey: key,
    queryFn: () => api(accountId).get<{ data: WebhookDelivery[] }>(`/webhooks/${hook.id}/deliveries`),
  });
  const again = useMutation({
    mutationFn: (id: string) => api(accountId).post<WebhookDelivery>(`/webhooks/deliveries/${id}/redeliver`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });
  if (log.isLoading) return <SkeletonRows rows={2} label={t('app.loading')} />;
  if (!log.data?.data.length) return <p className="text-xs text-muted">{t('webhook.no_deliveries')}</p>;
  return (
    <ul className="space-y-1 text-xs" data-testid="webhook-deliveries">
      {log.data.data.map((d) => (
        <li key={d.id} className="flex items-center gap-2" data-testid="webhook-delivery" data-status={d.status}>
          <Badge tone={d.status === 'delivered' ? 'ok' : d.status === 'pending' ? 'neutral' : 'warn'}>
            {t(`webhook.status.${d.status}` as MessageKey)}
          </Badge>
          <span className="text-muted">{formatDateTime(d.created_at)}</span>
          <span>{d.event_type}</span>
          {d.response_status ? <span dir="ltr">HTTP {d.response_status}</span> : null}
          {d.error ? <span className="text-danger-fg">{d.error}</span> : null}
          {d.status !== 'delivered' ? (
            <button type="button" className="underline" onClick={() => again.mutate(d.id)}>
              {t('webhook.redeliver')}
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
};

export const WebhooksPanel = ({ board }: { board: BoardDetail }) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const qc = useQueryClient();
  const key = keyOf(accountId, board.id);
  const list = useQuery({
    queryKey: key,
    queryFn: () => api(accountId).get<{ data: Webhook[] }>(`/boards/${board.id}/webhooks`),
  });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const toggle = useMutation({
    mutationFn: (h: Webhook) => api(accountId).patch<Webhook>(`/webhooks/${h.id}`, { active: !h.is_active }),
    onSuccess: refresh,
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const ping = useMutation({
    mutationFn: (h: Webhook) => api(accountId).post<WebhookDelivery>(`/webhooks/${h.id}/test`, {}),
    onSuccess: (d) => {
      showToast({
        message: d.status === 'delivered' ? t('webhook.ping_ok') : t('webhook.ping_failed', { error: d.error ?? '' }),
        tone: d.status === 'delivered' ? 'default' : 'error',
      });
      void qc.invalidateQueries({ queryKey: ['account', accountId, 'webhook'] });
    },
  });
  const rotate = useMutation({
    mutationFn: (h: Webhook) => api(accountId).post<Webhook>(`/webhooks/${h.id}/rotate-secret`, {}),
    onSuccess: refresh,
  });
  const remove = async (h: Webhook) => {
    if (
      await confirmDialog({
        title: t('webhook.delete_title'),
        message: h.url,
        danger: true,
        confirmLabel: t('common.delete'),
      })
    )
      await api(accountId)
        .delete(`/webhooks/${h.id}`)
        .then(refresh, (e) => showToast({ message: errorMessage(e), tone: 'error' }));
  };

  return (
    <div className="space-y-4" data-testid="webhooks-panel">
      <p className="text-sm text-muted">{t('webhook.intro')}</p>
      {adding ? (
        <AddForm board={board} onDone={() => setAdding(false)} />
      ) : (
        <Button onClick={() => setAdding(true)} data-testid="webhook-add">
          {t('webhook.add')}
        </Button>
      )}
      {list.isLoading ? (
        <SkeletonRows rows={3} label={t('app.loading')} />
      ) : list.isError ? (
        <Notice tone="error">{errorMessage(list.error)}</Notice>
      ) : !list.data?.data.length ? (
        <p className="text-sm text-muted">{t('webhook.empty')}</p>
      ) : (
        <ul className="divide-y divide-[var(--line)] rounded-[var(--radius)] border border-line">
          {list.data.data.map((h) => (
            <li key={h.id} className="space-y-2 p-3" data-testid="webhook-row" data-url={h.url}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <p className="font-medium">{t(`webhook.ev.${h.event}` as MessageKey)}</p>
                  <p className="truncate text-xs text-muted" dir="ltr">
                    {h.url}
                  </p>
                  <div className="flex flex-wrap gap-2 text-xs">
                    {!h.is_active ? (
                      <Badge tone="warn">{h.disabled_reason ? t('webhook.disabled_failures') : t('webhook.off')}</Badge>
                    ) : null}
                    {!h.verified ? <Badge tone="neutral">{t('webhook.unverified')}</Badge> : null}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1">
                  <Button variant="ghost" size="sm" onClick={() => toggle.mutate(h)} data-testid="webhook-toggle">
                    {h.is_active ? t('webhook.turn_off') : t('webhook.turn_on')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    busy={ping.isPending}
                    onClick={() => ping.mutate(h)}
                    data-testid="webhook-ping"
                  >
                    {t('webhook.ping')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setOpen(open === h.id ? null : h.id)}
                    data-testid="webhook-log"
                  >
                    {t('webhook.log')}
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-8 px-2 text-danger-fg"
                    onClick={() => void remove(h)}
                    data-testid="webhook-delete"
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted">{t('webhook.secret')}:</span>
                <code dir="ltr" data-testid="webhook-secret">
                  {shown === h.id ? h.secret : '••••••••'}
                </code>
                <button type="button" className="underline" onClick={() => setShown(shown === h.id ? null : h.id)}>
                  {shown === h.id ? t('webhook.hide') : t('webhook.show')}
                </button>
                <button type="button" className="underline" onClick={() => copyText(h.secret)}>
                  {t('tokens.copy')}
                </button>
                <button type="button" className="underline" onClick={() => rotate.mutate(h)}>
                  {t('webhook.rotate')}
                </button>
              </div>
              {open === h.id ? <Deliveries hook={h} /> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
