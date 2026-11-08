// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { formatDayMonth, formatNumber, t, type AccountAutomation, type AutomationUsage } from '@bines/shared';
import { Badge, Button, cn, Menu, Notice, Skeleton, SkeletonRows, useActionMenu, type MenuEntry } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage, type MyAccount } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { BoardAccountContext } from '../board/board-context';
import { DotsIcon, PowerIcon } from './AutomationsDialog';
import { RunsDialog } from './RunsDialog';
import { AutomationTemplatesLibrary, SaveTemplateDialog } from './AutomationTemplatesLibrary';
import { useAutomationTemplates } from './templates-api';

/**
 * "אוטומציות" for the whole account (04 §8.2–8.3): what ran in the last 30 days, and every automation of the
 * boards I can see — by board, with its switch and its last 7 days. Editing happens in each board's center.
 */
const Tile = ({ label, value, tone }: { label: string; value: number | string; tone?: 'warn' }) => (
  <div
    className="flex flex-col gap-1 rounded-[var(--radius-lg)] border border-line bg-surface p-3.5"
    data-testid="usage-tile"
  >
    <p className="text-xs text-muted">{label}</p>
    <p
      className={cn(
        'font-display text-[1.625rem] leading-[1.15] font-extrabold tracking-[-0.4px] text-heading tabular-nums',
        tone === 'warn' && value ? 'text-danger-fg' : '',
      )}
    >
      {typeof value === 'number' ? formatNumber(value) : value}
    </p>
  </div>
);

/** "3 ספט׳" (the region's language; never the year — the chart covers the last weeks). */
const shortDate = (day: string) => formatDayMonth(day, { year: false });

const Bars = ({ days }: { days: AutomationUsage['days'] }) => {
  const max = Math.max(1, ...days.map((d) => d.succeeded));
  const okTotal = days.reduce((n, d) => n + d.succeeded, 0);
  const badTotal = days.reduce((n, d) => n + d.partial + d.failed, 0);
  return (
    <section
      className="flex flex-col gap-3 rounded-[var(--radius-lg)] border border-line bg-surface p-4"
      data-testid="usage-chart"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-bold text-heading">{t('autoAll.chart')}</h2>
        <span className="flex items-center gap-3.5 text-xs text-fg-2">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px] bg-heading" />
            {t('autoAll.ok', { n: formatNumber(okTotal) })}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[3px] bg-danger" />
            {t('autoAll.errors', { n: formatNumber(badTotal) })}
          </span>
        </span>
      </div>
      <div
        className="flex h-[120px] items-end gap-1 border-b border-line pb-px"
        role="img"
        aria-label={t('autoAll.chart')}
      >
        {days.map((d, i) => {
          const ok = d.succeeded;
          const bad = d.partial + d.failed;
          return (
            <div
              key={d.day}
              className="flex h-full flex-1 flex-col justify-end gap-px"
              title={`${d.day} · ${t('autoAll.ok', { n: ok })} · ${t('autoAll.errors', { n: bad })} · ${t('autoAll.actions', { n: d.actions })}`}
            >
              {bad ? <div className="h-1 shrink-0 rounded-[2px] bg-danger" /> : null}
              <div
                className={cn('rounded-t-[3px] bg-heading', i === days.length - 1 ? 'opacity-100' : 'opacity-85')}
                style={{ height: `calc(${(ok / max) * 100}% - ${bad ? 5 : 0}px)`, minHeight: ok ? 2 : 0 }}
              />
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[0.6875rem] text-muted">
        <span>{days[0] ? shortDate(days[0].day) : ''}</span>
        <span>{t('autoAll.today')}</span>
      </div>
    </section>
  );
};

export const AccountAutomationsPage = ({ account }: { account: MyAccount }) => {
  const qc = useQueryClient();
  const client = api(account.id);
  const listKey = ['account', account.id, 'automations-all'];
  const list = useQuery({
    queryKey: listKey,
    queryFn: () => client.get<{ data: AccountAutomation[] }>('/automations'),
  });
  const usage = useQuery({
    queryKey: ['account', account.id, 'automations-usage'],
    queryFn: () => client.get<AutomationUsage>('/automations/usage'),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['account', account.id] });
  const toggle = useMutation({
    mutationFn: (a: AccountAutomation) =>
      client.post(`/automations/${a.id}/${a.is_active ? 'deactivate' : 'activate'}`, {}),
    onSuccess: refresh,
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  // A copy starts switched off (the same as in the board's center).
  const duplicate = useMutation({
    mutationFn: (a: AccountAutomation) =>
      client.post(`/boards/${a.board_id}/automations`, {
        title: t('auto.list.copy_title', { title: a.title }),
        recipe: a.recipe,
        is_active: false,
      }),
    onSuccess: (_, a) => {
      showToast({ message: t('auto.list.duplicated', { title: a.title }) });
      return refresh();
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const remove = useMutation({
    mutationFn: (a: AccountAutomation) => client.delete(`/automations/${a.id}`),
    onSuccess: refresh,
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const navigate = useNavigate();
  const openBoard = (boardId: string) =>
    void navigate({ to: '/a/$accountSlug/b/$boardId', params: { accountSlug: account.slug, boardId } });
  const rowMenu = useActionMenu();
  const [menuFor, setMenuFor] = useState<AccountAutomation | null>(null);
  const [history, setHistory] = useState<AccountAutomation | null>(null);
  // Account automation templates: "save as template" from a row, the library below.
  const [savingTemplate, setSavingTemplate] = useState<AccountAutomation | null>(null);
  const canSaveTemplates = !!useAutomationTemplates(account.id, account.role === 'admin' || account.role === 'member')
    .data?.can_manage;
  /** The row's ⋯ (N12): editing and testing happen in the board's center, so "open the board" leads there. */
  const menuItems = (a: AccountAutomation): MenuEntry[] => [
    {
      label: t('autoAll.open_board'),
      icon: <Icon name="board" />,
      onSelect: () => openBoard(a.board_id),
    },
    { label: t('auto.list.history'), icon: <Icon name="history" />, onSelect: () => setHistory(a) },
    ...(canSaveTemplates
      ? [
          {
            label: t('autoTpl.save_as'),
            icon: <Icon name="duplicate" />,
            testId: 'auto-save-template',
            onSelect: () => setSavingTemplate(a),
          },
        ]
      : []),
    ...(a.can_manage
      ? [
          { label: t('menu.duplicate'), icon: <Icon name="duplicate" />, onSelect: () => duplicate.mutate(a) },
          {
            label: a.is_active ? t('auto.list.disable') : t('auto.list.enable'),
            icon: <PowerIcon />,
            onSelect: () => toggle.mutate(a),
          },
          { kind: 'separator' as const },
          {
            label: t('common.delete'),
            icon: <Icon name="trash" />,
            danger: true,
            onSelect: () =>
              void confirmDialog({
                title: t('auto.list.delete_title'),
                message: a.title,
                danger: true,
                confirmLabel: t('common.delete'),
              }).then((ok) => ok && remove.mutate(a)),
          },
        ]
      : []),
  ];

  const rows = list.data?.data ?? [];
  const boards = [...new Map(rows.map((r) => [r.board_id, r.board_name])).entries()];
  const u = usage.data;
  const sum = (f: (d: AutomationUsage['days'][number]) => number) => (u?.days ?? []).reduce((n, d) => n + f(d), 0);
  const last7 = (u?.days ?? []).slice(-7);

  return (
    <main className="w-full space-y-4 px-4 py-5 md:px-6" data-testid="account-automations">
      <header className="space-y-1">
        <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-md:text-2xl">
          {t('autoAll.title')}
        </h1>
        <p className="max-w-[640px] text-sm text-muted">{t('autoAll.intro')}</p>
      </header>
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      {u ? (
        <section className="space-y-4">
          <div className="grid grid-cols-2 gap-3.5 md:grid-cols-5">
            <Tile label={t('autoAll.active')} value={`${u.active} / ${u.total}`} />
            <Tile label={t('autoAll.runs_30')} value={sum((d) => d.succeeded + d.partial + d.failed)} />
            <Tile label={t('autoAll.actions_30')} value={sum((d) => d.actions)} />
            <Tile
              label={t('autoAll.errors_7')}
              value={last7.reduce((n, d) => n + d.partial + d.failed, 0)}
              tone="warn"
            />
            <Tile label={t('autoAll.due_24')} value={u.scheduled_24h} />
          </div>
          <Bars days={u.days} />
        </section>
      ) : usage.isLoading ? (
        <div className="grid grid-cols-2 gap-3.5 md:grid-cols-5" role="status" aria-label={t('app.loading')}>
          {Array.from({ length: 5 }, (_, i) => (
            <div
              key={i}
              className="flex flex-col gap-2.5 rounded-[var(--radius-lg)] border border-line bg-surface p-3.5"
              data-testid="skeleton"
            >
              <Skeleton className="w-1/2" />
              <Skeleton className="h-6 w-1/3" />
            </div>
          ))}
        </div>
      ) : null}

      {list.isLoading ? (
        <SkeletonRows rows={4} label={t('app.loading')} />
      ) : !rows.length ? (
        <p className="text-sm text-muted">{t('autoAll.empty')}</p>
      ) : (
        boards.map(([boardId, name]) => (
          <section key={boardId} className="flex flex-col gap-2">
            <h2 className="flex h-[1.875rem] items-center gap-2">
              <Icon name="board" size={16} className="shrink-0 text-muted" />
              <Link
                to="/a/$accountSlug/b/$boardId"
                params={{ accountSlug: account.slug, boardId }}
                className="font-display text-base font-extrabold text-heading hover:underline"
                data-testid="autoall-board"
              >
                {name}
              </Link>
              <span className="rounded-full bg-surface-2 px-2 py-px text-xs font-semibold text-fg-2 tabular-nums">
                {rows.filter((r) => r.board_id === boardId).length}
              </span>
            </h2>
            <ul className="overflow-hidden rounded-[14px] border border-line" data-tour="automations.list">
              {rows
                .filter((r) => r.board_id === boardId)
                .map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-3 border-b border-line-soft bg-surface px-3.5 py-3 text-sm last:border-b-0"
                    data-testid="autoall-row"
                    data-title={r.title}
                  >
                    <button
                      type="button"
                      role="switch"
                      aria-checked={r.is_active}
                      aria-label={t('auto.list.toggle', { title: r.title })}
                      disabled={!r.can_manage || toggle.isPending}
                      onClick={() => toggle.mutate(r)}
                      data-testid="autoall-toggle"
                      className={cn(
                        'relative h-5 w-9 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50',
                        r.is_active ? 'bg-ok' : 'bg-line-strong',
                      )}
                    >
                      <span
                        className={cn(
                          'absolute top-0.5 size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-[inset-inline-start]',
                          r.is_active ? 'start-[18px]' : 'start-0.5',
                        )}
                      />
                    </button>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="font-semibold break-words text-fg">{r.title}</span>
                      <span className="text-[0.6875rem] text-muted">
                        {t('autoAll.runs_7', { n: r.runs_7d })}
                        {r.errors_7d ? (
                          <span className="text-danger-fg"> · {t('autoAll.errors', { n: r.errors_7d })}</span>
                        ) : null}
                      </span>
                    </span>
                    {r.deactivated_reason ? (
                      <Badge tone="danger">
                        {r.deactivated_reason === 'owner_review'
                          ? t('auto.list.owner_review')
                          : t('auto.list.needs_fixing')}
                      </Badge>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-haspopup="menu"
                      aria-label={t('menu.actions')}
                      title={t('menu.actions')}
                      className="w-8 shrink-0 px-0 text-muted"
                      data-testid="auto-row-menu"
                      onClick={(e) => {
                        setMenuFor(r);
                        rowMenu.fromTrigger(e);
                      }}
                    >
                      <DotsIcon />
                    </Button>
                  </li>
                ))}
            </ul>
          </section>
        ))
      )}
      {account.role === 'admin' || account.role === 'member' ? (
        <AutomationTemplatesLibrary accountId={account.id} isAdmin={account.role === 'admin'} />
      ) : null}
      {savingTemplate ? (
        <SaveTemplateDialog
          accountId={account.id}
          automation={savingTemplate}
          onClose={() => setSavingTemplate(null)}
        />
      ) : null}
      <Menu
        at={rowMenu.at}
        onClose={rowMenu.close}
        label={t('menu.actions')}
        items={menuFor ? menuItems(menuFor) : []}
      />
      {history ? (
        // The runs dialog reads the account from the board context (it is also opened inside a board).
        <BoardAccountContext.Provider value={{ id: account.id, slug: account.slug, meId: '' }}>
          <RunsDialog automation={history} onClose={() => setHistory(null)} />
        </BoardAccountContext.Provider>
      ) : null}
    </main>
  );
};
