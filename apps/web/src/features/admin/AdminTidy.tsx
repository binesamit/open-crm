// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { type AdminBoard, type MyAccount, t } from '@bines/shared';
import {
  Badge,
  Button,
  cn,
  Dialog,
  EmptyState,
  Field,
  Menu,
  MenuTrigger,
  Notice,
  Picker,
  Segmented,
  SkeletonRows,
  Switch,
  useActionMenu,
  type MenuEntry,
} from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDialog, confirmDelete } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { Ago, SearchBox, TD, TH, TR, useNarrow } from '../trash/TrashPage';
import { useAdminMembers } from './users/users-api';
import { useAdminBoards, useTidyMutations } from './admin-a45-api';
import { SectionHeader } from './admin-parts';
import { TidyRulesPanel } from './TidyRulesPanel';

type Show = 'all' | 'empty' | 'stale' | 'no_owner' | 'archived';
const SHOWS: Show[] = ['all', 'empty', 'stale', 'no_owner', 'archived'];
const STALE_DAYS = ['30', '90', '180', '365'] as const;
const DAY = 86_400_000;

type Mutations = ReturnType<typeof useTidyMutations>;
const fail = (err: unknown) => showToast({ message: errorMessage(err), tone: 'error' });

const kindTone = (k: AdminBoard['kind']) => (k === 'private' ? 'warn' : k === 'shareable' ? 'violet' : 'neutral');

/**
 * Administration → סדר וניקיון (08 §9, account admin A5): every board of the account in one table — workspace, kind,
 * owners, last change, items — with filters (empty, not updated in N days, no active owner, archived) and actions:
 * open, archive, delete (to the trash) and transfer ownership. Private / shareable boards the admin is not on show
 * as metadata only (05 §10).
 */
export const AdminTidy = ({ account }: { account: MyAccount }) => {
  const narrow = useNarrow();
  const [now] = useState(() => Date.now());
  const boards = useAdminBoards(account.id);
  const m = useTidyMutations(account.id);
  const [q, setQ] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [staleDays, setStaleDays] = useState<(typeof STALE_DAYS)[number]>('90');
  const [transfer, setTransfer] = useState<AdminBoard | null>(null);

  const all = useMemo(() => boards.data?.data ?? [], [boards.data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const cutoff = now - Number(staleDays) * DAY;
    return all.filter((b) => {
      if (needle && !`${b.name} ${b.workspace_name}`.toLowerCase().includes(needle)) return false;
      switch (show) {
        case 'all':
          return true;
        case 'archived':
          return !!b.archived_at;
        case 'empty':
          return !b.archived_at && b.items_count === 0;
        case 'stale':
          return !b.archived_at && new Date(b.updated_at).getTime() < cutoff;
        case 'no_owner':
          return !b.has_active_owner;
      }
    });
  }, [all, q, show, staleDays, now]);
  const counts = useMemo(
    () => ({
      empty: all.filter((b) => !b.archived_at && b.items_count === 0).length,
      no_owner: all.filter((b) => !b.has_active_owner).length,
      archived: all.filter((b) => b.archived_at).length,
    }),
    [all],
  );

  return (
    <div className="flex flex-col gap-4 pb-12" data-testid="admin-tidy">
      <SectionHeader title={t('admin.section.tidy')} subtitle={t('a45.tidy.subtitle')} />
      <TidyRulesPanel account={account} />
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} label={t('a45.tidy.search')} />
        <Segmented<Show>
          label={t('a45.tidy.show')}
          value={show}
          onChange={setShow}
          testId="tidy-show"
          className="max-md:w-full max-md:overflow-x-auto"
          options={SHOWS.map((s) => ({
            value: s,
            testId: `tidy-show-${s}`,
            label: s === 'all' || s === 'stale' ? t(`a45.tidy.show.${s}`) : `${t(`a45.tidy.show.${s}`)} (${counts[s]})`,
          }))}
        />
        {show === 'stale' ? (
          <Picker
            label={t('a45.tidy.staleDays')}
            testId="tidy-stale-days"
            value={staleDays}
            onChange={setStaleDays}
            className="h-9 w-[170px]"
            options={STALE_DAYS.map((d) => ({ value: d, label: t('a45.tidy.staleOption', { n: d }) }))}
          />
        ) : null}
        <span className="ms-auto text-xs text-muted" data-testid="tidy-count">
          {t('adminUsers.count', { n: rows.length, total: all.length })}
        </span>
      </div>

      {boards.isPending ? <SkeletonRows rows={6} label={t('app.loading')} /> : null}
      {boards.isError ? <Notice tone="error">{errorMessage(boards.error)}</Notice> : null}
      {boards.data && !rows.length ? (
        <EmptyState icon={<Icon name="board" size={28} />} title={t('a45.tidy.empty')} testId="tidy-empty" />
      ) : null}

      {rows.length && narrow ? (
        <ul className="overflow-hidden rounded-[14px] border border-line">
          {rows.map((b) => (
            <BoardRow key={b.id} board={b} account={account} m={m} now={now} onTransfer={setTransfer} narrow />
          ))}
        </ul>
      ) : rows.length ? (
        <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
          <table className="w-full min-w-[960px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>{t('a45.tidy.col.board')}</th>
                <th className={TH}>{t('a45.tidy.col.workspace')}</th>
                <th className={TH}>{t('a45.tidy.col.kind')}</th>
                <th className={TH}>{t('a45.tidy.col.owners')}</th>
                <th className={TH}>{t('a45.tidy.col.updated')}</th>
                <th className={TH}>{t('a45.tidy.col.items')}</th>
                <th className={TH}>{t('a45.tidy.col.status')}</th>
                <th className={cn(TH, 'w-10')} />
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <BoardRow key={b.id} board={b} account={account} m={m} now={now} onTransfer={setTransfer} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {transfer ? (
        <TransferBoardDialog
          account={account}
          board={transfer}
          m={m}
          onClose={() => {
            m.transfer.reset();
            setTransfer(null);
          }}
        />
      ) : null}
    </div>
  );
};

const Owners = ({ board }: { board: AdminBoard }) => {
  const names = [...board.owners.map((o) => (o.active ? o.name : `${o.name} (${t('a45.tidy.inactive')})`))];
  const teams = board.owner_teams.map((x) => x.name);
  const all = [...names, ...teams];
  if (!all.length || !board.has_active_owner)
    return (
      <span className="flex items-center gap-1.5">
        <Badge tone="danger">{t('a45.tidy.noOwner')}</Badge>
        {all.length ? <span className="truncate text-xs text-muted">{all.join(', ')}</span> : null}
      </span>
    );
  return <span className="truncate text-fg-2">{all.join(', ')}</span>;
};

const BoardRow = ({
  board: b,
  account,
  m,
  now,
  onTransfer,
  narrow,
}: {
  board: AdminBoard;
  account: MyAccount;
  m: Mutations;
  now: number;
  onTransfer: (b: AdminBoard) => void;
  narrow?: boolean;
}) => {
  const menu = useActionMenu();
  const navigate = useNavigate();
  const open = () =>
    void navigate({ to: '/a/$accountSlug/b/$boardId', params: { accountSlug: account.slug, boardId: b.id } });
  const archive = async () => {
    const ok = await confirmDialog({
      title: t('a45.tidy.confirmArchive', { name: b.name }),
      message: t('a45.tidy.confirmArchiveBody'),
      confirmLabel: t('a45.tidy.archive'),
    });
    if (ok) m.archive.mutate(b.id, { onSuccess: () => showToast({ message: t('a45.tidy.archived') }), onError: fail });
  };
  const remove = async () => {
    if (await confirmDelete(b.name))
      m.remove.mutate(b.id, { onSuccess: () => showToast({ message: t('a45.tidy.deleted') }), onError: fail });
  };
  const items: MenuEntry[] = [
    ...(b.content_access
      ? [{ label: t('archive.open'), icon: <Icon name="board" size={16} />, testId: 'tidy-menu-open', onSelect: open }]
      : []),
    {
      label: t('a45.tidy.transfer'),
      icon: <Icon name="move" size={16} />,
      testId: 'tidy-menu-transfer',
      onSelect: () => onTransfer(b),
    },
    ...(!b.archived_at
      ? [
          {
            label: t('a45.tidy.archive'),
            icon: <Icon name="archive" size={16} />,
            testId: 'tidy-menu-archive',
            onSelect: () => void archive(),
          },
        ]
      : []),
    { kind: 'separator' as const },
    {
      label: t('common.delete'),
      icon: <Icon name="trash" size={16} />,
      danger: true,
      testId: 'tidy-menu-delete',
      onSelect: () => void remove(),
    },
  ];
  const name = (
    <span className="flex min-w-0 items-center gap-2">
      {b.content_access ? (
        <Icon name="board" size={15} className="shrink-0 text-muted" />
      ) : (
        <span title={t('a45.tidy.metadataOnly')} className="shrink-0 text-muted" data-testid="tidy-metadata-only">
          <Icon name="lock" size={15} />
        </span>
      )}
      <span className="truncate font-semibold text-fg">{b.name}</span>
    </span>
  );
  const status = b.archived_at ? (
    <Badge>{t('a45.tidy.status.archived')}</Badge>
  ) : b.items_count === 0 ? (
    <Badge tone="warn">{t('a45.tidy.status.empty')}</Badge>
  ) : (
    <Badge tone="ok">{t('a45.tidy.status.active')}</Badge>
  );
  const actions = (
    <>
      <MenuTrigger
        label={t('a45.tidy.actionsFor', { name: b.name })}
        onClick={menu.fromTrigger}
        className={narrow ? 'opacity-100' : undefined}
      />
      <Menu at={menu.at} onClose={menu.close} items={items} label={b.name} />
    </>
  );
  const common = {
    'data-testid': 'tidy-row',
    'data-name': b.name,
    'data-archived': b.archived_at ? 'true' : 'false',
    onContextMenu: menu.onContextMenu,
    onKeyDown: menu.onKeyDown,
  };
  if (narrow)
    return (
      <li
        {...common}
        className="group flex items-center gap-3 border-b border-line-soft bg-surface px-3.5 py-3 last:border-b-0"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          {name}
          <span className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted">
            {status}
            <bdi>{b.workspace_name}</bdi> · {t('a45.tidy.itemsN', { n: b.items_count })} ·{' '}
            <Ago iso={b.updated_at} now={now} />
          </span>
        </span>
        {actions}
      </li>
    );
  return (
    <tr {...common} className={cn(TR, 'group hover:bg-row-alt')}>
      <td className={cn(TD, 'max-w-[260px]')}>{name}</td>
      <td className={cn(TD, 'max-w-[180px] truncate text-fg-2')}>{b.workspace_name}</td>
      <td className={TD}>
        <Badge tone={kindTone(b.kind)}>{t(`a45.tidy.kind.${b.kind}`)}</Badge>
      </td>
      <td className={cn(TD, 'max-w-[220px]')} data-testid="tidy-owners">
        <Owners board={b} />
      </td>
      <td className={cn(TD, 'text-fg-2')}>
        <Ago iso={b.updated_at} now={now} />
      </td>
      <td className={cn(TD, 'tabular-nums text-fg-2')} data-testid="tidy-items">
        {b.items_count}
      </td>
      <td className={TD}>{status}</td>
      <td className={cn(TD, 'text-end')}>{actions}</td>
    </tr>
  );
};

const TransferBoardDialog = ({
  account,
  board,
  m,
  onClose,
}: {
  account: MyAccount;
  board: AdminBoard;
  m: Mutations;
  onClose: () => void;
}) => {
  const members = useAdminMembers(account.id);
  const [to, setTo] = useState('');
  const [keep, setKeep] = useState(false);
  const options = (members.data?.data ?? [])
    .filter((x) => x.status === 'active' && (x.role === 'admin' || x.role === 'member'))
    .map((x) => ({ value: x.user_id, label: x.name || x.email }));
  const submit = () =>
    m.transfer.mutate(
      { id: board.id, body: { to_user_id: to, keep_current_owners: keep } },
      {
        onSuccess: () => {
          showToast({ message: t('a45.tidy.transferred', { name: board.name }) });
          onClose();
        },
        onError: fail,
      },
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('a45.tidy.transferTitle')}
      subtitle={board.name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={!to} busy={m.transfer.isPending} data-testid="tidy-transfer-confirm">
            {t('a45.tidy.transfer')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="tidy-transfer-dialog">
        <p className="text-sm text-fg-2">
          {t('a45.tidy.currentOwners')}{' '}
          <span className="font-semibold">
            {[...board.owners.map((o) => o.name), ...board.owner_teams.map((x) => x.name)].join(', ') || '—'}
          </span>
        </p>
        <Field label={t('a45.tidy.newOwner')}>
          <Picker
            label={t('a45.tidy.newOwner')}
            value={to}
            onChange={setTo}
            placeholder={t('a45.tidy.pickOwner')}
            testId="tidy-transfer-to"
            options={options}
          />
        </Field>
        <label className="flex items-center justify-between gap-3 text-sm text-fg">
          <span>{t('a45.tidy.keepOwners')}</span>
          <Switch checked={keep} onChange={setKeep} label={t('a45.tidy.keepOwners')} testId="tidy-transfer-keep" />
        </label>
      </div>
    </Dialog>
  );
};
