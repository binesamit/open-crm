// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@bines/sdk';
import {
  exactTime,
  relativeTime,
  t,
  TRASH_OBJECT_TYPES,
  type MessageKey,
  type MyAccount,
  type TrashEntry,
  type TrashObjectType,
} from '@bines/shared';
import { Avatar, Badge, Button, cn, EmptyState, Notice, SkeletonRows } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { PickerButton } from '../board/toolbar/parts';
import { useMembers } from '../board/board-api';

/** Below 768px (the phone layout): lists become cards. */
export const useNarrow = () => {
  const query = '(max-width: 767px)';
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setNarrow(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return narrow;
};

/** The canvas table (`.tblbox` / `.tbl`). */
export const TH =
  'h-9 border-b border-line bg-surface-3 px-3 text-start text-xs font-semibold whitespace-nowrap text-muted';
export const TD = 'h-11 border-b border-line-soft px-3 whitespace-nowrap';
export const TR = '[&:last-child>td]:border-b-0';

/** A search box with a leading magnifier (`.input` 260px). */
export const SearchBox = ({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) => (
  <label className="flex h-9 w-[260px] max-w-full items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-2.5 text-muted focus-within:border-primary focus-within:ring-3 focus-within:ring-[var(--accent-soft)] max-md:w-full">
    <Icon name="search" size={15} />
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={label}
      aria-label={label}
      className="h-full min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
    />
  </label>
);

/**
 * How to show who did it: the name, else the member's email, else a generic label
 * (the entry only carries a name, which is empty for users who never set one).
 */
export const useActorLabel = (accountId: string) => {
  const members = useMembers(accountId);
  return (who: { id: string; name: string } | null): string | null => {
    if (!who) return null;
    const name = who.name.trim();
    if (name) return name;
    const email = members.data?.data.find((m) => m.user_id === who.id)?.email;
    return email || t('trash.actor.unnamed');
  };
};

/** Who did it: a 24px avatar and the name (or its fallback label). */
export const Actor = ({ label }: { label: string | null }) =>
  label ? (
    <span className="flex min-w-0 items-center gap-2">
      <Avatar name={label} size={24} />
      <bdi className="truncate">{label}</bdi>
    </span>
  ) : (
    <>—</>
  );

/** The phone list (`.list` / `.li`): a chip and a bold name, a muted meta line, the actions. */
export const MobileRow = ({
  type,
  name,
  suffix,
  meta,
  actions,
  testId,
  onOpen,
  openTestId,
}: {
  type: string;
  name: string;
  /** Muted after the name (a file's "· 3 versions"). */
  suffix?: string | null;
  /** The meta parts; empty ones are dropped, each is bidi-isolated so mixed Hebrew/LTR keeps its order. */
  meta: (string | null | undefined)[];
  actions: ReactNode;
  testId: string;
  /** When set, tapping the text opens the entry (the archive's "פתיחה" on phones). */
  onOpen?: () => void;
  openTestId?: string;
}) => {
  const text = (
    <>
      <span className="flex min-w-0 items-center gap-2">
        <Badge>{type}</Badge>
        <span className="truncate font-normal text-fg">
          {name}
          {suffix ? <span className="text-muted"> · {suffix}</span> : null}
        </span>
      </span>
      <span className="truncate text-[0.6875rem] text-muted">
        {meta
          .filter((part): part is string => !!part?.trim())
          .map((part, i) => (
            <span key={i}>
              {i ? ' · ' : null}
              <bdi>{part}</bdi>
            </span>
          ))}
      </span>
    </>
  );
  return (
    <li
      className="flex items-center gap-3 border-b border-line-soft bg-surface px-3.5 py-3 last:border-b-0"
      data-testid={testId}
      data-name={name}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          data-testid={openTestId}
          aria-label={`${t('archive.open')}: ${name}`}
          className="flex min-w-0 flex-1 flex-col gap-1 text-start"
        >
          {text}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 flex-col gap-1">{text}</span>
      )}
      {actions}
    </li>
  );
};

const trashKey = (accountId: string) => ['account', accountId, 'trash'] as const;

/** A relative time ("לפני 5 ימים") with the exact one in its title (N17). */
export const Ago = ({ iso, now }: { iso: string; now: number }) => (
  <time dateTime={iso} title={exactTime(iso)}>
    {relativeTime(iso, now)}
  </time>
);

/** "בעוד 29 ימים": whole days until a future time (at least 1), the exact date in its title. */
const daysUntil = (iso: string, now: number) => Math.max(1, Math.ceil((new Date(iso).getTime() - now) / 86_400_000));
const PurgeIn = ({ iso, now }: { iso: string; now: number }) => (
  <time dateTime={iso} title={exactTime(iso)}>
    {t('trash.purgeIn', { n: daysUntil(iso, now) })}
  </time>
);
const typeLabel = (type: TrashObjectType) => t(`trash.type.${type}` as MessageKey);
/** Where it was: the board — and for a file removed from a cell, the item before it. */
/** A file with more than one version: "3 גרסאות" after its name. */
const versionsOf = (e: TrashEntry) =>
  e.object_type === 'file' && (e.version_count ?? 0) > 1 ? t('trash.fileVersions', { n: e.version_count! }) : null;
const originOf = (e: TrashEntry) => [e.item_name, e.board_name].filter((part): part is string => !!part?.trim());

/**
 * Trash (07 §5.2): what I deleted (admins: everything), restore in place or delete permanently.
 * When the parent is in trash too, restoring offers to bring the parent back first.
 */
export const TrashPage = ({ account }: { account: MyAccount }) => {
  const qc = useQueryClient();
  const client = api(account.id);
  const [q, setQ] = useState('');
  const [type, setType] = useState<TrashObjectType | null>(null);
  const [now] = useState(() => Date.now());
  const list = useQuery({
    queryKey: trashKey(account.id),
    queryFn: () => client.get<{ data: TrashEntry[] }>('/trash'),
  });
  const refresh = () => qc.invalidateQueries();

  const restore = useMutation({
    mutationFn: async (entry: TrashEntry) => {
      try {
        await client.post(`/trash/${entry.id}/restore`, {});
      } catch (err) {
        const details = err instanceof ApiError && err.body.code === 'parent_in_trash' ? err.body.details : null;
        const parentId = details?.parent_entry_id as string | null | undefined;
        if (!parentId) throw err;
        const ok = await confirmDialog({
          title: t('trash.parentInTrash.title'),
          message: t('trash.parentInTrash.message', { what: typeLabel(details!.parent_type as TrashObjectType) }),
          confirmLabel: t('trash.restoreBoth'),
        });
        if (!ok) return false;
        await client.post(`/trash/${parentId}/restore`, {});
        await client.post(`/trash/${entry.id}/restore`, {});
      }
      return true;
    },
    onSuccess: async (done, entry) => {
      if (done) showToast({ message: t('trash.restored', { what: entry.name }) });
      await refresh();
    },
    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
  });
  const purge = useMutation({
    mutationFn: (entry: TrashEntry) => client.delete(`/trash/${entry.id}`),
    onSuccess: refresh,
    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
  });
  const empty = useMutation({
    mutationFn: () => client.delete('/trash'),
    onSuccess: refresh,
    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
  });

  const entries = (list.data?.data ?? []).filter(
    (e) => (!type || e.object_type === type) && (!q.trim() || e.name.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const present = new Set((list.data?.data ?? []).map((e) => e.object_type));

  const narrow = useNarrow();
  const actorLabel = useActorLabel(account.id);
  const askPurge = (e: TrashEntry) =>
    void confirmDialog({
      title: t('trash.purge.title', { what: e.name }),
      message: t('trash.purge.message'),
      confirmLabel: t('trash.purge'),
      danger: true,
    }).then((ok) => ok && purge.mutate(e));
  const restoreButton = (e: TrashEntry) => (
    <Button
      variant="secondary"
      size="sm"
      data-testid="trash-restore"
      disabled={restore.isPending}
      onClick={() => restore.mutate(e)}
    >
      <Icon name="restore" size={15} />
      {t('trash.restore')}
    </Button>
  );

  return (
    <main className="w-full space-y-4 px-4 py-5 md:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3 max-md:flex-col max-md:items-stretch">
        <div className="space-y-1">
          <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-md:text-2xl">
            {t('trash.title')}
          </h1>
          <p className="max-w-[640px] text-sm text-muted">
            {account.role === 'admin' ? t('trash.subtitle.admin') : t('trash.subtitle.mine')}
          </p>
        </div>
        {account.role === 'admin' && list.data?.data.length ? (
          <div className="flex">
            <Button
              variant="danger-outline"
              size="sm"
              data-testid="trash-empty"
              busy={empty.isPending}
              onClick={() =>
                void confirmDialog({
                  title: t('trash.empty.title'),
                  message: t('trash.empty.message'),
                  confirmLabel: t('trash.empty'),
                  danger: true,
                }).then((ok) => ok && empty.mutate())
              }
            >
              <Icon name="trash" size={15} />
              {t('trash.empty')}
            </Button>
          </div>
        ) : null}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} label={t('trash.search')} />
        <PickerButton
          testId="trash-type"
          menuLabel={t('trash.col.type')}
          placeholder={t('trash.allTypes')}
          label={type ? typeLabel(type) : undefined}
          className="h-9 w-[150px]"
          items={[
            { label: t('trash.allTypes'), checked: !type, onSelect: () => setType(null) },
            ...TRASH_OBJECT_TYPES.filter((x) => present.has(x)).map((x) => ({
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
        list.data.data.length ? (
          <EmptyState icon={<Icon name="search" size={28} />} title={t('trash.noMatch')} />
        ) : (
          <EmptyState icon={<Icon name="trash" size={28} />} title={t('trash.emptyState')} />
        )
      ) : null}

      {entries.length && narrow ? (
        <ul className="overflow-hidden rounded-[14px] border border-line">
          {entries.map((e) => (
            <MobileRow
              key={e.id}
              testId="trash-row"
              type={typeLabel(e.object_type)}
              name={e.name}
              suffix={versionsOf(e)}
              meta={[...originOf(e), actorLabel(e.deleted_by), relativeTime(e.deleted_at, now)]}
              actions={
                <span className="flex shrink-0 items-center gap-1">
                  {restoreButton(e)}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-8 px-0 text-danger-fg hover:text-danger-fg"
                    aria-label={t('trash.purge')}
                    title={t('trash.purge')}
                    data-testid="trash-delete"
                    disabled={purge.isPending}
                    onClick={() => askPurge(e)}
                  >
                    <Icon name="trash" size={15} />
                  </Button>
                </span>
              }
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
                <th className={TH}>{t('trash.col.deletedBy')}</th>
                <th className={TH}>{t('trash.col.deletedAt')}</th>
                <th className={TH}>{t('trash.col.purgeAt')}</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className={TR} data-testid="trash-row" data-name={e.name}>
                  <td className={TD}>
                    <Badge>{typeLabel(e.object_type)}</Badge>
                  </td>
                  <td className={cn(TD, 'max-w-64 truncate font-normal text-fg')}>
                    {e.name}
                    {versionsOf(e) ? (
                      <span className="text-muted" data-testid="trash-file-versions">
                        {' · '}
                        {versionsOf(e)}
                      </span>
                    ) : null}
                  </td>
                  <td className={cn(TD, 'max-w-48 truncate text-fg-2')}>
                    {originOf(e).length
                      ? originOf(e).map((part, i) => (
                          <span key={i}>
                            {i ? ' · ' : null}
                            <bdi>{part}</bdi>
                          </span>
                        ))
                      : '—'}
                  </td>
                  <td className={cn(TD, 'text-fg')}>
                    <Actor label={actorLabel(e.deleted_by)} />
                  </td>
                  <td className={cn(TD, 'text-muted')}>
                    <Ago iso={e.deleted_at} now={now} />
                  </td>
                  <td className={cn(TD, 'text-muted')}>
                    <PurgeIn iso={e.purge_after} now={now} />
                  </td>
                  <td className={TD}>
                    <span className="flex items-center justify-end gap-2">
                      {restoreButton(e)}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-danger-fg hover:text-danger-fg"
                        data-testid="trash-delete"
                        disabled={purge.isPending}
                        onClick={() => askPurge(e)}
                      >
                        {t('trash.purge')}
                      </Button>
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
