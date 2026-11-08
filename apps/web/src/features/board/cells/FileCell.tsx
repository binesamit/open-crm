// SPDX-License-Identifier: AGPL-3.0-only
import { lazy, Suspense, useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fileLinkLabel, t } from '@bines/shared';
import { cn, Skeleton } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { formatSize, uploadFile } from '../../../lib/upload';
import { openCellDoc } from '../../docs/doc-api';
import { cellZipPath, DownloadAllButton } from '../../files/download-all';
import { fileKind, FileViewer } from '../../files/FileViewer';
import { showToast } from '../../../lib/toast';
import { useDesktop } from '../../../lib/use-desktop';
import { useGrid } from '../table/grid';
import { type CellLink, LinkForm, LinkGlyph, LinkRow } from './file-links';
import { dragHasFiles, FILE_PASTE_ATTR, FILE_PASTE_EVENT, namePastedFiles, transferFiles } from './file-paste';
import type { CellProps } from './index';
import { Popover } from './Popover';

type CellFile = { asset_id: string; name: string; size: number; mime?: string };
type CellDoc = { doc_id: string; name: string };

/** Larger images keep the plain count: a preview downloads the whole file (there are no server-side thumbnails). */
const PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
/** How many previews the closed cell shows before "+N". */
const PREVIEWS_SHOWN = 3;
const previewable = (f: CellFile) =>
  f.size <= PREVIEW_MAX_BYTES && fileKind({ name: f.name, mime: f.mime ?? '' }) === 'image';

/**
 * A small preview of an image file — the viewer's short-lived inline link (shared cache, refreshed
 * before it expires), loaded lazily; until it arrives, or if it fails, an image icon.
 */
const ImagePreview = ({ accountId, file, className }: { accountId: string; file: CellFile; className: string }) => {
  const url = useQuery({
    queryKey: ['account', accountId, 'file-url', file.asset_id, 'inline'],
    queryFn: () => api(accountId).get<{ download_url: string }>(`/files/${file.asset_id}?inline=1`),
    staleTime: 4 * 60_000,
  }).data?.download_url;
  const [failed, setFailed] = useState(false);
  return (
    <span className={cn('grid shrink-0 place-items-center overflow-hidden rounded-[4px] bg-surface-2', className)}>
      {url && !failed ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon name="image" size={12} className="text-muted" />
      )}
    </span>
  );
};

/** The doc side panel (and Tiptap with it) loads on first open. */
const DocPanel = lazy(() => import('../../docs/DocPanel'));

/** The localized "Screenshot" for a pasted image's name (the key itself until the strings are merged). */
const screenshotLabel = () => {
  const label = t('files.paste.screenshot');
  return label === 'files.paste.screenshot' ? 'צילום מסך' : label;
};

/**
 * file (03 §2.15): files are uploaded and attached through the files API, never written as a cell value. A file's
 * name opens the file viewer (owner fix 3) — preview, prev / next among the cell's files, download, remove, comments.
 */
export const FileCell = ({ column, value, editable, accountId, itemId, boardId }: CellProps) => {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The file shown in the viewer (an index into the cell's files). */
  const [viewing, setViewing] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  /** Phones: photos and videos straight from the gallery, beside "upload" (camera / files). */
  const gallery = useRef<HTMLInputElement>(null);
  const desktop = useDesktop();
  const qc = useQueryClient();
  const files = ((value as { files?: CellFile[] } | null)?.files ?? []) as CellFile[];
  // Fix: (product owner: "add docs in the files column too"): docs made in the cell, with the item's
  // permissions - a chip that opens the doc in the side panel.
  const docs = ((value as { docs?: CellDoc[] } | null)?.docs ?? []) as CellDoc[];
  // Web links beside the files - open in a new tab.
  const links = ((value as { links?: CellLink[] } | null)?.links ?? []) as CellLink[];
  /** The link form: a new link, or the id of the one being edited. */
  const [linkForm, setLinkForm] = useState<'new' | string | null>(null);
  // images as small previews (a column setting, on unless turned off).
  const previewsOn = (column.settings as { image_previews?: boolean }).image_previews !== false;
  const images = previewsOn ? files.filter(previewable) : [];
  const others = files.length - images.length;
  const [docId, setDocId] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  // The board's rows and an open item card (its "fields" tab) show the same cell.
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ['account', accountId, 'board', boardId, 'items'] }),
      qc.invalidateQueries({ queryKey: ['account', accountId, 'item', itemId] }),
    ]);

  const openRef = useRef(open);
  const onPick = async (list: FileList | File[] | null) => {
    if (!list?.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded = [];
      for (const f of Array.from(list)) uploaded.push(await uploadFile(accountId, f));
      await api(accountId).post(`/items/${itemId}/cells/${column.id}/files`, { file_ids: uploaded.map((u) => u.id) });
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
      // Pasted / dropped on the closed cell: the error has no panel to show in.
      if (!openRef.current) showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  // r19small: files pasted (Ctrl/⌘+V) or dropped on the cell upload like picked ones — the same
  // presign flow, limits and progress; a screenshot gets a dated name. Read-only: a toast, nothing uploads.
  const root = useRef<HTMLDivElement>(null);
  const take = (raw: File[]) => {
    if (!raw.length) return false;
    if (!editable) showToast({ message: t('files.paste.readOnly') });
    else void onPick(namePastedFiles(raw, screenshotLabel()));
    return true;
  };
  const takeRef = useRef(take);
  useEffect(() => {
    openRef.current = open;
    takeRef.current = take;
  });
  // The table's grid hands a paste on the active cell over as a DOM event (the focus is on the cell's wrapper).
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const on = (e: Event) => void takeRef.current(((e as CustomEvent<File[]>).detail ?? []) as File[]);
    el.addEventListener(FILE_PASTE_EVENT, on);
    return () => el.removeEventListener(FILE_PASTE_EVENT, on);
  }, []);
  // A paste with the focus in the cell (the item card) or in its open panel (React bubbles through the portal).
  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    if (take(transferFiles(e.clipboardData))) e.preventDefault();
  };
  const [dragOver, setDragOver] = useState(false);
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = editable ? 'copy' : 'none';
    if (editable && !dragOver) setDragOver(true);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragOver(false);
    if (!dragHasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    take(transferFiles(e.dataTransfer));
  };
  // In the table the cell's wrapper takes the focus (the grid); elsewhere (the item card) the cell itself does.
  const inGrid = !!useGrid();
  const remove = async (id: string) => {
    await api(accountId).delete(`/items/${itemId}/cells/${column.id}/files/${id}`);
    await refresh();
  };
  const newDoc = async () => {
    if (making) return;
    setMaking(true);
    setError(null);
    try {
      const res = await openCellDoc(accountId, itemId, column.id);
      setOpen(false);
      setDocId(res.doc.id);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setMaking(false);
    }
  };
  /** A doc leaves the cell to the trash (restorable there), like a file. */
  const removeDoc = async (id: string) => {
    try {
      await api(accountId).delete(`/docs/${id}`);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const saveLink = async (v: { url: string; name: string }) => {
    setError(null);
    try {
      const base = `/items/${itemId}/cells/${column.id}/links`;
      if (linkForm === 'new') await api(accountId).post(base, v);
      else await api(accountId).patch(`${base}/${linkForm}`, v);
      setLinkForm(null);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const removeLink = async (id: string) => {
    setError(null);
    try {
      await api(accountId).delete(`/items/${itemId}/cells/${column.id}/links/${id}`);
      await refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  const openDoc = (id: string) => {
    setOpen(false);
    setDocId(id);
  };

  return (
    <>
      <div
        ref={root}
        className={cn(
          'relative flex h-full w-full min-w-0 items-center justify-center gap-1 px-2 text-sm',
          'cursor-pointer hover:bg-surface-2',
          dragOver && 'bg-primary-soft outline-2 -outline-offset-2 outline-dashed outline-primary',
        )}
        onClick={() => {
          setLinkForm(null);
          setOpen(true);
        }}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        tabIndex={inGrid ? undefined : 0}
        {...{ [FILE_PASTE_ATTR]: '' }}
        data-busy={busy || undefined}
        data-testid="file-cell"
        data-tour="board.file-cell"
      >
        {busy && !open ? (
          <span data-testid="file-cell-busy" className="flex shrink-0 items-center">
            <Skeleton className="w-8" />
            <span className="sr-only">{t('app.loading')}</span>
          </span>
        ) : null}
        {docs.length ? (
          <button
            type="button"
            className="flex min-w-0 items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-xs hover:bg-surface-3"
            title={t('docs2.cell.open', { name: docs[0]!.name })}
            data-testid="file-cell-doc"
            onClick={(e) => {
              e.stopPropagation();
              openDoc(docs[0]!.doc_id);
            }}
          >
            <Icon name="file" size={13} className="shrink-0 text-info-fg" />
            <span className="truncate font-normal">{docs[0]!.name || t('docs.untitled')}</span>
            {docs.length > 1 ? <span className="shrink-0 text-muted">+{docs.length - 1}</span> : null}
          </button>
        ) : null}
        {links.length ? (
          <a
            href={links[0]!.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex min-w-0 max-w-[75%] items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-xs hover:bg-surface-3"
            title={links[0]!.url}
            data-testid="file-cell-link"
            onClick={(e) => e.stopPropagation()}
          >
            <LinkGlyph size={13} />
            <span className="truncate font-normal" dir="auto">
              {fileLinkLabel(links[0]!)}
            </span>
          </a>
        ) : null}
        {/* Outside the link: "+N" (and the rest of the cell) opens the popover with every link. */}
        {links.length > 1 ? (
          <span className="shrink-0 text-xs text-muted" data-testid="file-cell-links-more">
            +{links.length - 1}
          </span>
        ) : null}
        {images.slice(0, PREVIEWS_SHOWN).map((f) => (
          <button
            key={f.asset_id}
            type="button"
            title={f.name}
            aria-label={f.name}
            className="shrink-0 rounded-[4px] hover:ring-2 hover:ring-primary"
            data-testid="file-cell-preview"
            onClick={(e) => {
              e.stopPropagation();
              setViewing(files.indexOf(f));
            }}
          >
            <ImagePreview accountId={accountId} file={f} className="size-6" />
          </button>
        ))}
        {images.length > PREVIEWS_SHOWN ? (
          <span className="shrink-0 text-xs text-muted" data-testid="file-cell-more">
            +{images.length - PREVIEWS_SHOWN}
          </span>
        ) : null}
        {others ? (
          <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-xs">📎 {others}</span>
        ) : !files.length && editable && !docs.length && !links.length ? (
          <span className="text-muted">+</span>
        ) : null}
        <Popover open={open} onClose={() => setOpen(false)} className={cn('space-y-1', desktop ? 'w-80' : 'w-72')}>
          {docs.map((d) => (
            <div
              key={d.doc_id}
              className="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2"
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5 text-start font-normal text-primary"
                data-testid="file-cell-doc-open"
                onClick={(e) => {
                  e.stopPropagation();
                  openDoc(d.doc_id);
                }}
              >
                <Icon name="file" size={14} className="shrink-0 text-info-fg" />
                <span className="truncate">{d.name || t('docs.untitled')}</span>
              </button>
              {editable ? (
                <button
                  type="button"
                  aria-label={t('files.cell.removeDoc', { name: d.name })}
                  title={t('files.cell.removeDoc', { name: d.name })}
                  data-testid="file-cell-doc-remove"
                  className="text-muted hover:text-danger-fg"
                  onClick={(e) => {
                    e.stopPropagation();
                    void removeDoc(d.doc_id);
                  }}
                >
                  ✕
                </button>
              ) : null}
            </div>
          ))}
          {files.map((f) => (
            <div
              key={f.asset_id}
              className="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2"
            >
              {images.includes(f) ? <ImagePreview accountId={accountId} file={f} className="size-8" /> : null}
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-start text-primary underline"
                data-testid="file-cell-open"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen(false);
                  setViewing(files.indexOf(f));
                }}
              >
                {f.name}
              </button>
              <span className="shrink-0 text-xs text-muted" dir="ltr">
                {formatSize(f.size)}
              </span>
              {editable ? (
                // the file goes to the trash with its versions (restorable there), like a doc.
                <button
                  type="button"
                  aria-label={t('files.cell.removeFile', { name: f.name })}
                  title={t('files.cell.removeFile', { name: f.name })}
                  data-testid="file-cell-remove"
                  className="text-muted hover:text-danger-fg"
                  onClick={() => void remove(f.asset_id)}
                >
                  ✕
                </button>
              ) : null}
            </div>
          ))}
          {links.map((l) =>
            linkForm === l.id ? (
              <LinkForm key={l.id} initial={l} onSave={saveLink} onCancel={() => setLinkForm(null)} />
            ) : (
              <LinkRow
                key={l.id}
                link={l}
                editable={editable}
                onEdit={() => setLinkForm(l.id)}
                onRemove={() => void removeLink(l.id)}
              />
            ),
          )}
          {linkForm === 'new' ? <LinkForm onSave={saveLink} onCancel={() => setLinkForm(null)} /> : null}
          {/* two or more files download together as one ZIP. */}
          {files.length > 1 ? (
            <DownloadAllButton
              accountId={accountId}
              path={cellZipPath(itemId, column.id)}
              testId="file-cell-download-all"
            />
          ) : null}
          {editable ? (
            <>
              <input ref={input} type="file" multiple hidden onChange={(e) => void onPick(e.target.files)} />
              <input
                ref={gallery}
                type="file"
                accept="image/*,video/*"
                multiple
                hidden
                data-testid="file-cell-gallery-input"
                onChange={(e) => void onPick(e.target.files)}
              />
              {/* Fix: "+" offers upload a file or start a new doc in the cell;: or a link. */}
              <div className={cn('grid gap-1.5 pt-0.5', desktop ? 'grid-cols-3' : 'grid-cols-2')}>
                <button
                  type="button"
                  disabled={busy}
                  aria-busy={busy}
                  data-testid="file-cell-upload"
                  data-tour="board.file-upload"
                  onClick={() => input.current?.click()}
                  className="flex flex-col items-center justify-center gap-0.5 rounded-[var(--radius-sm)] border border-dashed border-line px-1.5 py-1.5 text-xs whitespace-nowrap text-muted hover:border-primary hover:text-primary"
                >
                  {busy ? (
                    <>
                      <Skeleton className="mx-auto my-1 w-16" />
                      <span className="sr-only">{t('app.loading')}</span>
                    </>
                  ) : (
                    <>
                      <Icon name="upload" size={14} />
                      {t('files.cell.upload')}
                    </>
                  )}
                </button>
                <button
                  type="button"
                  disabled={making}
                  aria-busy={making}
                  data-testid="file-cell-new-doc"
                  onClick={() => void newDoc()}
                  className="flex flex-col items-center justify-center gap-0.5 rounded-[var(--radius-sm)] border border-dashed border-line px-1.5 py-1.5 text-xs whitespace-nowrap text-muted hover:border-primary hover:text-primary disabled:opacity-60"
                >
                  <Icon name="file" size={14} />
                  {t('docs2.cell.new')}
                </button>
                <button
                  type="button"
                  disabled={linkForm === 'new'}
                  data-testid="file-cell-add-link"
                  onClick={(e) => {
                    e.stopPropagation();
                    setLinkForm('new');
                  }}
                  className="flex flex-col items-center justify-center gap-0.5 rounded-[var(--radius-sm)] border border-dashed border-line px-1.5 py-1.5 text-xs whitespace-nowrap text-muted hover:border-primary hover:text-primary disabled:opacity-60"
                >
                  <Icon name="link" size={14} />
                  {t('files.cell.addLink')}
                </button>
                {desktop ? null : (
                  <button
                    type="button"
                    disabled={busy}
                    data-testid="file-cell-gallery"
                    onClick={() => gallery.current?.click()}
                    className="flex flex-col items-center justify-center gap-0.5 rounded-[var(--radius-sm)] border border-dashed border-line px-1.5 py-1.5 text-xs whitespace-nowrap text-muted hover:border-primary hover:text-primary disabled:opacity-60"
                  >
                    <Icon name="image" size={14} />
                    {t('files.gallery')}
                  </button>
                )}
              </div>
            </>
          ) : null}
          {error ? <p className="text-xs text-danger-fg">{error}</p> : null}
        </Popover>
        {viewing !== null && files.length ? (
          <FileViewer
            accountId={accountId}
            files={files.map((f) => ({
              id: f.asset_id,
              name: f.name,
              size: f.size,
              mime: f.mime ?? 'application/octet-stream',
            }))}
            startIndex={viewing}
            source={{ kind: 'cell', itemId, columnId: column.id, boardId, canRemove: editable }}
            onClose={() => setViewing(null)}
          />
        ) : null}
      </div>
      {/* Outside the cell's clickable box: a click in the panel must not reopen the cell's popover. */}
      {docId ? (
        <Suspense fallback={null}>
          <DocPanel accountId={accountId} docId={docId} onClose={() => setDocId(null)} />
        </Suspense>
      ) : null}
    </>
  );
};
