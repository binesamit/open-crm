// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { exactTime, relativeTime, t } from '@bines/shared';
import { Button, cn, Menu, MenuTrigger, Notice, Skeleton, useActionMenu, type MenuEntry } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { downloadFile, formatSize, uploadFile } from '../../lib/upload';

/**
 * File versions, files columns only: the viewer's "Versions" tab lists a file's versions newest
 * first — upload a new one, view an older one, make it current again (copied as a new version), delete one that is
 * not current. The cell keeps one file at its current version; the server decides every right, the app only hides
 * what it surely may not offer.
 */
export type FileVersion = {
  id: string;
  version: number;
  name: string;
  size: number;
  mime: string;
  created_by: { id: string; name: string } | null;
  created_at: string;
  current: boolean;
};

/** Larger images keep the file icon: a thumbnail downloads the whole version (as the cell's previews). */
const THUMB_MAX_BYTES = 10 * 1024 * 1024;

export const versionsKey = (accountId: string, rootId: string) =>
  ['account', accountId, 'file-versions', rootId] as const;

export const useFileVersions = (accountId: string, rootId: string, enabled: boolean) =>
  useQuery({
    queryKey: versionsKey(accountId, rootId),
    queryFn: () => api(accountId).get<{ data: FileVersion[] }>(`/files/${rootId}/versions`),
    enabled: enabled && !!rootId,
  });

/**
 * What a version's ⋯ menu offers: download always; make current — not the current one; delete — not the current
 * one, never version 1 (it anchors the file in its cell while newer versions exist), only by its uploader or a
 * board admin. Changing anything takes the right to change the cell.
 */
export const versionActions = (
  v: Pick<FileVersion, 'version' | 'current' | 'created_by'>,
  o: { canEdit: boolean; meId: string | null; boardAdmin: boolean },
) => ({
  download: true,
  makeCurrent: o.canEdit && !v.current,
  remove: o.canEdit && !v.current && v.version !== 1 && (o.boardAdmin || (!!o.meId && v.created_by?.id === o.meId)),
});

/**
 * The version calls of one file; after each, the file's versions, its links (the root id serves the current bytes)
 * and the cell (the board's rows, an open item card) are fetched again. Errors show as a toast (the server's
 * reason, e.g. "only its uploader or a board admin").
 */
export const useVersionActions = (accountId: string, rootId: string, where: { itemId: string; boardId: string }) => {
  const qc = useQueryClient();
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: versionsKey(accountId, rootId) }),
      qc.invalidateQueries({ queryKey: ['account', accountId, 'file-url', rootId] }),
      qc.invalidateQueries({ queryKey: ['account', accountId, 'file-link', rootId] }),
      qc.invalidateQueries({ queryKey: ['account', accountId, 'board', where.boardId, 'items'] }),
      qc.invalidateQueries({ queryKey: ['account', accountId, 'item', where.itemId] }),
    ]);
  const onError = (err: unknown) => showToast({ message: errorMessage(err), tone: 'error' });
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const up = await uploadFile(accountId, file);
      return api(accountId).post<FileVersion>(`/files/${rootId}/versions`, { file_id: up.id });
    },
    onSuccess: refresh,
    onError,
  });
  const makeCurrent = useMutation({
    mutationFn: (v: FileVersion) => api(accountId).post<FileVersion>(`/files/${rootId}/versions/${v.id}/make-current`),
    onSuccess: refresh,
    onError,
  });
  const remove = useMutation({
    mutationFn: (v: FileVersion) => api(accountId).delete(`/files/${rootId}/versions/${v.id}`),
    onSuccess: refresh,
    onError,
  });
  const askRemove = (v: FileVersion) =>
    void confirmDialog({
      title: t('files.versions.deleteTitle', { n: v.version }),
      message: t('files.versions.deleteMessage'),
      confirmLabel: t('files.versions.deleteConfirm'),
      danger: true,
    }).then((ok) => ok && remove.mutate(v));
  // "Ask the AI for a change": the picture shown (an older version, else the current one) → a new
  // current version. Its error shows in the box (a Notice), not as a toast.
  const aiEdit = useMutation({
    mutationFn: (o: { instruction: string; versionId: string | null }) =>
      api(accountId).post<FileVersion>(`/files/${rootId}/ai-edit`, {
        instruction: o.instruction,
        ...(o.versionId ? { version_id: o.versionId } : {}),
      }),
    onSuccess: refresh,
  });
  return { upload, makeCurrent, remove, askRemove, aiEdit };
};

export type VersionActions = ReturnType<typeof useVersionActions>;

const isImage = (v: Pick<FileVersion, 'mime' | 'name'>) =>
  v.mime.toLowerCase().startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(v.name);

/** A 44×34 thumbnail: an image version's own small preview, else the file icon. */
const Thumb = ({ accountId, v }: { accountId: string; v: FileVersion }) => {
  const image = isImage(v) && v.size <= THUMB_MAX_BYTES;
  // The viewer's inline-link cache; `exact`: the version's own bytes (version 1's id is the file's), never changed.
  const url = useQuery({
    queryKey: ['account', accountId, 'file-url', v.id, 'inline', 'exact'],
    queryFn: () => api(accountId).get<{ download_url: string }>(`/files/${v.id}?inline=1&exact=1`),
    enabled: image,
    staleTime: 4 * 60_000,
  }).data?.download_url;
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn(
        'grid h-[34px] w-11 shrink-0 place-items-center overflow-hidden rounded-[5px]',
        image ? 'bg-surface-2 text-muted' : 'bg-info-soft text-info-fg',
      )}
    >
      {image && url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon name={image ? 'image' : 'file'} size={16} />
      )}
    </span>
  );
};

const VersionRow = ({
  accountId,
  v,
  selected,
  now,
  allowed,
  onView,
  actions,
  onMadeCurrent,
}: {
  accountId: string;
  v: FileVersion;
  selected: boolean;
  now: number;
  allowed: ReturnType<typeof versionActions>;
  onView: () => void;
  actions: VersionActions;
  onMadeCurrent: () => void;
}) => {
  const menu = useActionMenu();
  const label = t('files.versions.actions', { n: v.version });
  const items: MenuEntry[] = [
    {
      label: t('files.versions.download', { n: v.version }),
      icon: <Icon name="download" size={16} />,
      testId: 'version-download',
      onSelect: () =>
        void downloadFile(accountId, v.id, { exact: true }).catch((e: unknown) =>
          showToast({ message: errorMessage(e), tone: 'error' }),
        ),
    },
    ...(allowed.makeCurrent
      ? [
          {
            label: t('files.versions.makeCurrent'),
            icon: <Icon name="restore" size={16} />,
            testId: 'version-make-current',
            onSelect: () => actions.makeCurrent.mutate(v, { onSuccess: onMadeCurrent }),
          },
        ]
      : []),
    ...(allowed.remove
      ? [
          {
            label: t('files.versions.delete'),
            icon: <Icon name="trash" size={16} />,
            danger: true,
            testId: 'version-delete',
            onSelect: () => actions.askRemove(v),
          },
        ]
      : []),
  ];
  return (
    <li
      className={cn(
        'grid grid-cols-[1fr_auto] items-center gap-2.5 rounded-[var(--radius)] border p-2',
        selected ? 'border-line-strong bg-surface-3' : 'border-transparent hover:bg-surface-3',
      )}
      data-testid={`version-row-${v.version}`}
      data-current={v.current || undefined}
      data-selected={selected || undefined}
      onContextMenu={menu.onContextMenu}
    >
      <button
        type="button"
        onClick={onView}
        aria-current={selected || undefined}
        onKeyDown={menu.onKeyDown}
        className="grid min-w-0 grid-cols-[44px_1fr] items-center gap-2.5 text-start"
      >
        <Thumb accountId={accountId} v={v} />
        <span className="flex min-w-0 flex-col text-[0.8125rem] text-fg">
          <span className="flex flex-wrap items-center gap-1.5">
            {t('files.versions.version', { n: v.version })}
            {v.current ? (
              <span
                className="rounded-full bg-primary-soft px-2 py-px text-[0.6875rem] text-fg"
                data-testid="version-current"
              >
                {t('files.versions.current')}
              </span>
            ) : null}
          </span>
          <small className="truncate text-xs text-muted tabular-nums">
            {v.created_by ? <bdi>{v.created_by.name || t('trash.actor.unnamed')}</bdi> : null}
            {v.created_by ? ' · ' : null}
            <time dateTime={v.created_at} title={exactTime(v.created_at)}>
              {relativeTime(v.created_at, now)}
            </time>
            {' · '}
            <span dir="ltr">{formatSize(v.size)}</span>
          </small>
        </span>
      </button>
      <MenuTrigger
        label={label}
        onClick={menu.fromTrigger}
        testId="version-menu"
        className="size-8 text-base opacity-100"
      />
      <Menu at={menu.at} onClose={menu.close} label={label} items={items} />
    </li>
  );
};

/**
 * The "Versions" tab: the upload zone (click, or drop a file — anywhere on the viewer while the tab is open), the
 * versions newest first, the storage note.
 */
export const VersionsPanel = ({
  accountId,
  versions,
  viewedId,
  onView,
  canEdit,
  meId,
  boardAdmin,
  actions,
  onUpload,
  dragOver,
  aiEdit,
}: {
  accountId: string;
  versions: ReturnType<typeof useFileVersions>;
  /** The version shown in the preview (null: the current one). */
  viewedId: string | null;
  /** null: back to the current version. */
  onView: (versionId: string | null) => void;
  canEdit: boolean;
  meId: string | null;
  boardAdmin: boolean;
  actions: VersionActions;
  /** Uploads a file as the next version. */
  onUpload: (file: File) => void;
  /** A file is dragged over the viewer. */
  dragOver: boolean;
  /** "Ask the AI for a change" (an image the person may change, AI available) — under the upload zone. */
  aiEdit?: ReactNode;
}) => {
  const [now] = useState(() => Date.now());
  const input = useRef<HTMLInputElement>(null);
  const busy = actions.upload.isPending;
  const list = versions.data?.data ?? [];
  return (
    <section
      className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto p-3"
      aria-label={t('files.versions')}
      data-testid="versions-panel"
    >
      {canEdit ? (
        <>
          <input
            ref={input}
            type="file"
            hidden
            data-testid="versions-upload-input"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={busy}
            aria-busy={busy}
            onClick={() => input.current?.click()}
            data-testid="versions-upload"
            className={cn(
              'flex h-[38px] shrink-0 items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed px-3 text-[0.8125rem] text-fg-2',
              dragOver ? 'border-primary bg-primary-soft' : 'border-line-strong bg-surface-3 hover:border-primary',
            )}
          >
            {busy ? (
              <>
                <span className="size-3 animate-spin rounded-full border-2 border-current border-e-transparent" />
                {t('files.uploading')}
              </>
            ) : (
              <>
                <Icon name="upload" size={15} />
                {t('files.versions.upload')}
                <span className="text-muted max-md:hidden">{t('files.versions.dropHint')}</span>
              </>
            )}
          </button>
        </>
      ) : null}
      {canEdit ? aiEdit : null}
      {versions.isPending ? <Skeleton className="h-12 w-full" /> : null}
      {versions.isError ? <Notice tone="error">{errorMessage(versions.error)}</Notice> : null}
      {list.length ? (
        <ul className="flex flex-col gap-1.5" data-testid="versions-list">
          {list.map((v) => (
            <VersionRow
              key={v.id}
              accountId={accountId}
              v={v}
              now={now}
              selected={viewedId ? viewedId === v.id : v.current}
              allowed={versionActions(v, { canEdit, meId, boardAdmin })}
              onView={() => onView(v.current ? null : v.id)}
              actions={actions}
              onMadeCurrent={() => onView(null)}
            />
          ))}
        </ul>
      ) : null}
      <p className="mt-auto border-t border-line pt-2.5 text-xs text-muted">{t('files.versions.quota')}</p>
    </section>
  );
};

/** On the preview while an older version shows: which one, back to the current one, make this one current. */
export const OldVersionBar = ({
  v,
  total,
  canEdit,
  busy,
  onBack,
  onMakeCurrent,
}: {
  v: FileVersion;
  /** How many versions the file has. */
  total: number;
  canEdit: boolean;
  busy: boolean;
  onBack: () => void;
  onMakeCurrent: () => void;
}) => (
  <div
    className="absolute inset-x-4 top-3 z-10 flex flex-wrap items-center gap-2.5 rounded-[var(--radius)] bg-accent-soft px-3 py-2 text-[0.8125rem] text-accent-fg"
    role="status"
    data-testid="old-version-bar"
  >
    <span className="min-w-0 flex-1">{t('files.versions.oldBar', { n: v.version, total })}</span>
    <Button
      variant="ghost"
      size="sm"
      onClick={onBack}
      data-testid="old-version-back"
      className="h-7 font-normal text-accent-fg hover:text-accent-fg"
    >
      {t('files.versions.backToCurrent')}
    </Button>
    {canEdit ? (
      <Button
        variant="accent"
        size="sm"
        busy={busy}
        onClick={onMakeCurrent}
        data-testid="old-version-make-current"
        className="h-7 text-[0.8125rem] font-normal"
      >
        {t('files.versions.makeCurrent')}
      </Button>
    ) : null}
  </div>
);
