// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  ARCHIVE_TYPES,
  relativeTime,
  t,
  type ArchiveEntry,
  type ArchiveType,
  type MessageKey,
  type MyAccount,
} from '@bines/shared';
import { Badge, Button, cn, EmptyState, Notice, SkeletonRows } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { Actor, Ago, MobileRow, SearchBox, TD, TH, TR, useActorLabel, useNarrow } from './TrashPage';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { PickerButton } from '../board/toolbar/parts';

const typeLabel = (type: ArchiveType) => t(`archive.type.${type}` as MessageKey);

/** Archive (07 §5.1): archived items, groups and boards on boards I can read; restore puts them back. */
export const ArchivePage = ({ account }: { account: MyAccount }) => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const client = api(account.id);
  const [q, setQ] = useState('');
  const [type, setType] = useState<ArchiveType | null>(null);
  const [now] = useState(() => Date.now());
  const list = useQuery({
    queryKey: ['account', account.id, 'archive'],
    queryFn: () => client.get<{ data: ArchiveEntry[] }>('/archive'),
  });
  const open = (boardId: string) =>
    void navigate({ to: '/a/$accountSlug/b/$boardId', params: { accountSlug: account.slug, boardId } });
  // "פתיחה" (N14): an item opens its card over its board, a group or board opens the board (an archived board
  // shows its restore banner there).
  const openEntry = (e: ArchiveEntry) =>
    e.type === 'item'
      ? void navigate({
          to: '/a/$accountSlug/b/$boardId/i/$itemId',
          params: { accountSlug: account.slug, boardId: e.board_id, itemId: e.id },
        })
      : open(e.board_id);
  const restore = useMutation({
    mutationFn: (e: ArchiveEntry) =>
      client.post<{ ok: true; board_id: string }>(`/archive/${e.type}/${e.id}/restore`, {}),
    onSuccess: async (res, e) => {
      showToast({
        message: t('archive.restored', { what: e.name }),
        action: { label: t('archive.open'), run: () => open(res.board_id) },
      });
      await qc.invalidateQueries();
    },
    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
  });

  const all = list.data?.data ?? [];
  const entries = all.filter(
    (e) => (!type || e.type === type) && (!q.trim() || e.name.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const present = new Set(all.map((e) => e.type));

  const narrow = useNarrow();
  const actorLabel = useActorLabel(account.id);
  const restoreButton = (e: ArchiveEntry) => (
    <Button
      variant="secondary"
      size="sm"
      data-testid="archive-restore"
      disabled={restore.isPending}
      onClick={() => restore.mutate(e)}
    >
      <Icon name="restore" size={15} />
      {t('archive.restore')}
    </Button>
  );

  const openButton = (e: ArchiveEntry) => (
    <Button variant="ghost" size="sm" data-testid="archive-open" onClick={() => openEntry(e)}>
      {t('archive.open')}
    </Button>
  );

  return (
    <main className="w-full space-y-4 px-4 py-5 md:px-6">
      <header className="space-y-1">
        <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-md:text-2xl">
          {t('archive.title')}
        </h1>
        <p className="max-w-[640px] text-sm text-muted">{t('archive.subtitle')}</p>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} label={t('archive.search')} />
        <PickerButton
          testId="archive-type"
          menuLabel={t('trash.col.type')}
          placeholder={t('trash.allTypes')}
          label={type ? typeLabel(type) : undefined}
          className="h-9 w-[150px]"
          items={[
            { label: t('trash.allTypes'), checked: !type, onSelect: () => setType(null) },
            ...ARCHIVE_TYPES.filter((x) => present.has(x)).map((x) => ({
              label: typeLabel(x),
              checked: type === x,
              onSelect: () => setType(x),
            })),
          ]}
        />
      </div>

      {list.isPending ? <SkeletonRows rows={4} label={t('app.loading')} /> : null}
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      {list.data && !entries.length ? (
        all.length ? (
          <EmptyState icon={<Icon name="search" size={28} />} title={t('archive.noMatch')} />
        ) : (
          <EmptyState icon={<Icon name="archive" size={28} />} title={t('archive.empty')} />
        )
      ) : null}

      {entries.length && narrow ? (
        <ul className="overflow-hidden rounded-[14px] border border-line">
          {entries.map((e) => (
            <MobileRow
              key={`${e.type}:${e.id}`}
              testId="archive-row"
              type={typeLabel(e.type)}
              name={e.name}
              meta={[e.board_name, actorLabel(e.archived_by), relativeTime(e.archived_at, now)]}
              onOpen={() => openEntry(e)}
              openTestId="archive-open"
              actions={<span className="shrink-0">{restoreButton(e)}</span>}
            />
          ))}
        </ul>
      ) : entries.length ? (
        <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>{t('trash.col.type')}</th>
                <th className={TH}>{t('trash.col.name')}</th>
                <th className={TH}>{t('trash.col.origin')}</th>
                <th className={TH}>{t('archive.col.archivedBy')}</th>
                <th className={TH}>{t('archive.col.archivedAt')}</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={`${e.type}:${e.id}`} className={TR} data-testid="archive-row" data-name={e.name}>
                  <td className={TD}>
                    <Badge>{typeLabel(e.type)}</Badge>
                  </td>
                  <td className={cn(TD, 'max-w-64 truncate font-semibold text-fg')}>{e.name}</td>
                  <td className={cn(TD, 'max-w-48 truncate text-fg-2')}>{e.board_name ?? '—'}</td>
                  <td className={cn(TD, 'text-fg')}>
                    <Actor label={actorLabel(e.archived_by)} />
                  </td>
                  <td className={cn(TD, 'text-muted')}>
                    <Ago iso={e.archived_at} now={now} />
                  </td>
                  <td className={TD}>
                    <span className="flex items-center justify-end gap-2">
                      {openButton(e)}
                      {restoreButton(e)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </main>
  );
};
