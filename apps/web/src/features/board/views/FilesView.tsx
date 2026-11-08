// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  FILE_KINDS,
  fileKindOf,
  formatDate,
  localDateOf,
  t,
  type BoardFile,
  type FileKind,
  type ViewSettings,
  msgKey,
} from '@bines/shared';
import { Avatar, cn, EmptyState, SkeletonRows } from '@bines/ui';
import { api } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { downloadFile, formatSize } from '../../../lib/upload';
import { FileViewer, type FileSource } from '../../files/FileViewer';
import type { BoardDetail, Item, Member } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { useOpenItem } from '../open-item';
import { CheckRow, PickerButton } from '../toolbar/parts';

/**
 * The Files view (M8 ד9): every file of the board — file columns and update attachments, of items and subitems —
 * as a gallery with filters by column, kind and uploader (saved with the view) and the board's search / filters
 * (only files of matching items). A tile opens the file viewer (preview, prev / next, comments, download).
 */
type Update = (fn: (s: ViewSettings) => ViewSettings) => void;
const PAGE = 120;

const KIND_ICON: Record<FileKind, string> = {
  image: 'IMG',
  pdf: 'PDF',
  video: '▶',
  audio: '♪',
  document: 'DOC',
  spreadsheet: 'XLS',
  presentation: 'PPT',
  other: 'FILE',
};

const Thumb = ({ accountId, file }: { accountId: string; file: BoardFile }) => {
  const kind = fileKindOf(file);
  const link = useQuery({
    queryKey: ['account', accountId, 'file-link', file.id],
    queryFn: () => api(accountId).get<{ download_url: string }>(`/files/${file.id}?inline=1`),
    enabled: kind === 'image',
    staleTime: 10 * 60_000,
  });
  return kind === 'image' && link.data ? (
    <img src={link.data.download_url} alt="" className="h-full w-full object-cover" loading="lazy" />
  ) : (
    <span className="font-display text-lg font-bold text-muted" aria-hidden>
      {KIND_ICON[kind]}
    </span>
  );
};

export const FilesView = ({
  board,
  items,
  filtered,
  settings,
  update,
  members,
}: {
  board: BoardDetail;
  /** The view's matching items (their files show); all items when nothing filters. */
  items: Item[];
  filtered: boolean;
  settings: ViewSettings;
  update: Update;
  members: Member[];
}) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const open = useOpenItem(board.id);
  const [shown, setShown] = useState(PAGE);
  const [viewing, setViewing] = useState<{ list: BoardFile[]; index: number } | null>(null);
  const files = useQuery({
    queryKey: ['account', accountId, 'board', board.id, 'items', 'files-view'],
    queryFn: () => api(accountId).get<{ data: BoardFile[] }>(`/boards/${board.id}/files`),
  });
  const s = {
    columns: settings.files?.columns ?? [],
    kinds: settings.files?.kinds ?? [],
    uploaders: settings.files?.uploaders ?? [],
    include_updates: settings.files?.include_updates ?? true,
    sort: settings.files?.sort ?? 'newest',
  };
  const set = (patch: Partial<typeof s>) => update((x) => ({ ...x, files: { ...s, ...x.files, ...patch } }));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  const matching = useMemo(() => new Set(items.map((i) => i.id)), [items]);
  const all = files.data?.data ?? [];
  // The React Compiler memoizes this (filtering a board's files is cheap).
  const list = (() => {
    const out = all.filter(
      (f) =>
        (!filtered || matching.has(f.parent_item_id ?? f.item_id) || matching.has(f.item_id)) &&
        (s.include_updates || f.source === 'cell') &&
        (!s.columns.length || (f.column_id && s.columns.includes(f.column_id))) &&
        (!s.kinds.length || s.kinds.includes(fileKindOf(f))) &&
        (!s.uploaders.length || (f.uploaded_by && s.uploaders.includes(f.uploaded_by))),
    );
    const by = {
      newest: (a: BoardFile, b: BoardFile) => (a.created_at < b.created_at ? 1 : -1),
      oldest: (a: BoardFile, b: BoardFile) => (a.created_at < b.created_at ? -1 : 1),
      name: (a: BoardFile, b: BoardFile) => a.name.localeCompare(b.name),
      size: (a: BoardFile, b: BoardFile) => b.size - a.size,
    }[s.sort];
    return [...out].sort(by);
  })();

  const fileColumns = board.columns.filter((c) => c.type === 'file');
  const uploaders = [...new Set(all.map((f) => f.uploaded_by).filter((x): x is string => !!x))];
  const nameOf = (id: string | null) => members.find((m) => m.user_id === id)?.name ?? '';
  const sourceOf = (f: BoardFile): FileSource =>
    f.source === 'cell'
      ? { kind: 'cell', itemId: f.item_id, columnId: f.column_id!, boardId: board.id, canRemove: false }
      : { kind: 'update', itemId: f.item_id, updateId: f.update_id!, boardId: board.id, canRemove: false };
  const sameSource = (a: BoardFile, b: BoardFile) =>
    a.item_id === b.item_id && a.source === b.source && a.column_id === b.column_id && a.update_id === b.update_id;

  return (
    <div className="flex flex-col gap-3 pb-6" data-testid="files-view">
      <div className="flex flex-wrap items-center gap-2" data-testid="files-filters">
        <PickerButton
          testId="files-filter-column"
          menuLabel={t('filesView.column')}
          placeholder={t('filesView.allColumns')}
          label={
            s.columns.length
              ? fileColumns
                  .filter((c) => s.columns.includes(c.id))
                  .map((c) => c.title)
                  .join(', ')
              : undefined
          }
          items={[
            {
              label: t('filesView.allColumns'),
              checked: !s.columns.length,
              onSelect: () => set({ columns: [] }),
            },
            ...fileColumns.map((c) => ({
              label: c.title,
              checked: s.columns.includes(c.id),
              onSelect: () => set({ columns: toggle(s.columns, c.id) }),
            })),
          ]}
        />
        <PickerButton
          testId="files-filter-kind"
          menuLabel={t('filesView.kind')}
          placeholder={t('filesView.allKinds')}
          label={s.kinds.length ? s.kinds.map((x) => t(msgKey(`filesView.kind.${x}`))).join(', ') : undefined}
          items={[
            { label: t('filesView.allKinds'), checked: !s.kinds.length, onSelect: () => set({ kinds: [] }) },
            ...FILE_KINDS.map((x) => ({
              label: t(msgKey(`filesView.kind.${x}`)),
              checked: s.kinds.includes(x),
              onSelect: () => set({ kinds: toggle(s.kinds, x) }),
            })),
          ]}
        />
        <PickerButton
          testId="files-filter-uploader"
          menuLabel={t('filesView.uploader')}
          placeholder={t('filesView.allUploaders')}
          label={s.uploaders.length ? s.uploaders.map(nameOf).join(', ') : undefined}
          items={[
            {
              label: t('filesView.allUploaders'),
              checked: !s.uploaders.length,
              onSelect: () => set({ uploaders: [] }),
            },
            ...uploaders.map((u) => ({
              label: nameOf(u) || u,
              checked: s.uploaders.includes(u),
              onSelect: () => set({ uploaders: toggle(s.uploaders, u) }),
            })),
          ]}
        />
        <PickerButton
          testId="files-sort"
          menuLabel={t('filesView.sort')}
          placeholder={t('filesView.sort.newest')}
          label={t(msgKey(`filesView.sort.${s.sort}`))}
          items={(['newest', 'oldest', 'name', 'size'] as const).map((x) => ({
            label: t(msgKey(`filesView.sort.${x}`)),
            checked: s.sort === x,
            onSelect: () => set({ sort: x }),
          }))}
        />
        <CheckRow
          className="w-auto"
          checked={s.include_updates}
          onToggle={() => set({ include_updates: !s.include_updates })}
        >
          <span data-testid="files-include-updates">{t('filesView.includeUpdates')}</span>
        </CheckRow>
        <span className="ms-auto text-xs text-muted" data-testid="files-count">
          {t('filesView.count', { n: list.length })}
        </span>
      </div>
      {files.isLoading ? (
        <SkeletonRows rows={4} label={t('app.loading')} />
      ) : !list.length ? (
        <EmptyState title={t('filesView.empty')} testId="files-empty">
          {t('filesView.emptyHint')}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3" data-testid="files-grid">
          {list.slice(0, shown).map((f) => (
            <div
              key={`${f.id}:${f.update_id ?? f.column_id}`}
              className="group flex min-w-0 flex-col overflow-hidden rounded-[12px] border border-line bg-surface hover:border-line-strong"
              data-testid="file-tile"
              data-name={f.name}
              data-kind={fileKindOf(f)}
            >
              <button
                type="button"
                className="grid h-28 place-items-center bg-surface-2"
                aria-label={f.name}
                onClick={() => {
                  const group = list.filter((x) => sameSource(x, f));
                  setViewing({ list: group, index: group.indexOf(f) });
                }}
              >
                <Thumb accountId={accountId} file={f} />
              </button>
              <div className="flex min-w-0 flex-col gap-1 p-2.5">
                <div className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate text-sm font-normal text-fg" title={f.name} dir="auto">
                    {f.name}
                  </span>
                  <button
                    type="button"
                    aria-label={t('filesView.download')}
                    title={t('filesView.download')}
                    className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-fg"
                    onClick={() => void downloadFile(accountId, f.id)}
                  >
                    <Icon name="download" size={14} />
                  </button>
                </div>
                <button
                  type="button"
                  className="truncate text-start text-xs text-primary hover:underline"
                  onClick={() => open(f.parent_item_id ?? f.item_id)}
                  data-testid="file-item"
                >
                  {f.item_name}
                </button>
                <div className="flex items-center gap-1.5 text-[0.6875rem] text-muted">
                  {f.uploaded_by ? <Avatar name={nameOf(f.uploaded_by) || '?'} size={16} /> : null}
                  <span className="truncate">
                    {f.source === 'cell' ? f.column_title : t('filesView.inUpdate')} · {formatSize(f.size)} ·{' '}
                    {formatDate(localDateOf(f.created_at))}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {list.length > shown ? (
        <button
          type="button"
          data-testid="files-more"
          className={cn('h-10 w-full rounded-[10px] text-sm text-primary hover:bg-surface-2')}
          onClick={() => setShown((n) => n + PAGE)}
        >
          {t('windowed.showMore', { n: list.length - shown })}
        </button>
      ) : null}
      {viewing ? (
        <FileViewer
          accountId={accountId}
          files={viewing.list.map((f) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime }))}
          startIndex={viewing.index}
          source={sourceOf(viewing.list[0]!)}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </div>
  );
};
