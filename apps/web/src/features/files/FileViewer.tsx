// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { exactTime, mediaKindOf, relativeTime, t, type MessageKey, type UpdateDto } from '@bines/shared';
import { Button, cn, Notice, Skeleton } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage, fetchMe, queryKeys } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { downloadFile, formatSize } from '../../lib/upload';
import { useBoard } from '../board/board-api';
import { dragHasFiles, transferFiles } from '../board/cells/file-paste';
import { invalidateUpdateCounts } from '../board/update-counts';
import { AI_EDIT_MIMES, AiEditBox, useAiEditStatus } from './ai-edit';
import { OldVersionBar, useFileVersions, useVersionActions, VersionsPanel } from './versions';
import { MediaPlayer } from './MediaPlayer';
import { TranscriptPanel } from './Transcript';

/** `exact`: an older version by its own id — a file's id alone serves its current version. */
export type ViewerFile = { id: string; name: string; size: number; mime: string; exact?: boolean };

/**
 * Where the files come from — decides how "remove" works and where comments go:
 * - `update`: files attached to an update or reply; a comment is a reply to that update.
 * - `cell`: files in a file column; a comment is a new update on the item that names the file.
 */
export type FileSource =
  | { kind: 'update'; itemId: string; updateId: string; boardId?: string; canRemove: boolean }
  | { kind: 'cell'; itemId: string; columnId: string; boardId: string; canRemove: boolean };

type Kind = 'image' | 'pdf' | 'video' | 'audio' | 'html' | 'text' | 'office' | 'other';

const ext = (name: string) => /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
const HTML_EXT = ['html', 'htm', 'xhtml'];
const TEXT_EXT = ['txt', 'csv', 'md', 'json', 'log', 'xml', 'yaml', 'yml', 'tsv'];
const OFFICE_EXT = ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf'];
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico'];
/** Text files larger than this are offered for download instead of shown. */
const MAX_TEXT_BYTES = 1024 * 1024;
/** HTML pages often carry their images inline, so they may be larger. */
const MAX_HTML_BYTES = 10 * 1024 * 1024;

export const fileKind = (f: { name: string; mime: string }): Kind => {
  const m = f.mime.toLowerCase();
  const e = ext(f.name);
  if (m.startsWith('image/') || IMAGE_EXT.includes(e)) return 'image';
  if (m === 'application/pdf' || e === 'pdf') return 'pdf';
  // By type, else by extension (a recording uploaded without a type).
  const media = mediaKindOf(f);
  if (media) return media;
  if (
    OFFICE_EXT.includes(e) ||
    m.includes('officedocument') ||
    m.includes('msword') ||
    m.includes('ms-excel') ||
    m.includes('ms-powerpoint') ||
    m.includes('opendocument')
  )
    return 'office';
  if (m === 'text/html' || m === 'application/xhtml+xml' || HTML_EXT.includes(e)) return 'html';
  if (m.startsWith('text/') || m === 'application/json' || TEXT_EXT.includes(e)) return 'text';
  return 'other';
};

/** The comments on a file carry its id on the document (`doc.attrs.file_id`) — the viewer lists them by it. */
const fileIdOf = (u: { body_json: Record<string, unknown> | null }) =>
  ((u.body_json?.attrs as { file_id?: unknown } | undefined)?.file_id as string | undefined) ?? null;

const commentDoc = (file: ViewerFile, text: string) => {
  const lines = text.split('\n');
  return {
    type: 'doc',
    attrs: { file_id: file.id },
    content: lines.map((line, i) => ({
      type: 'paragraph',
      content: [
        ...(i === 0
          ? [
              {
                type: 'text',
                text: t('files.viewer.commentOn', { name: file.name }),
                marks: [{ type: 'bold' }],
              },
              { type: 'text', text: ' ' },
            ]
          : []),
        ...(line ? [{ type: 'text', text: line }] : []),
      ],
    })),
  };
};

/** A short-lived link that opens the file in the browser (`?inline=1`), refreshed before it expires. */
export const useInlineUrl = (accountId: string, fileId: string, exact = false) =>
  useQuery({
    queryKey: ['account', accountId, 'file-url', fileId, 'inline', ...(exact ? ['exact'] : [])],
    queryFn: () => api(accountId).get<{ download_url: string }>(`/files/${fileId}?inline=1${exact ? '&exact=1' : ''}`),
    enabled: !!fileId,
    staleTime: 4 * 60_000,
  });

const useFileText = (url: string) =>
  useQuery({
    queryKey: ['file-text', url],
    queryFn: async () => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(String(res.status));
      return res.text();
    },
    staleTime: Infinity,
  });

const SourceText = ({ text }: { text: string }) => (
  <pre
    className="h-full w-full overflow-auto rounded-[10px] border border-line bg-surface p-4 text-start font-mono text-xs whitespace-pre-wrap text-fg"
    data-testid="file-viewer-text"
  >
    {text}
  </pre>
);

const TextPreview = ({ url }: { url: string }) => {
  const text = useFileText(url);
  if (text.isPending) return <Skeleton className="h-40 w-full" />;
  if (text.isError) return null;
  return <SourceText text={text.data} />;
};

/**
 * An HTML file: the page itself, in a sandboxed frame — no scripts, no forms, no access to the app
 * a link meant for a new tab opens one. "Source" shows its code as text.
 */
const HtmlPreview = ({ url, name }: { url: string; name: string }) => {
  const text = useFileText(url);
  const [source, setSource] = useState(false);
  if (text.isPending) return <Skeleton className="h-40 w-full" />;
  if (text.isError) return null;
  return (
    <div className="flex h-full min-h-[60dvh] w-full flex-col gap-2">
      <div role="tablist" className="flex gap-1 self-start" data-testid="file-viewer-html-mode">
        {([false, true] as const).map((on) => (
          <button
            key={String(on)}
            type="button"
            role="tab"
            aria-selected={source === on}
            onClick={() => setSource(on)}
            className={cn(
              'rounded-full px-2.5 py-1 text-[0.8125rem]',
              source === on ? 'bg-primary-soft text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
            )}
          >
            {t(on ? 'files.viewer.htmlSource' : 'files.viewer.htmlPage')}
          </button>
        ))}
      </div>
      {source ? (
        <SourceText text={text.data} />
      ) : (
        <iframe
          srcDoc={text.data}
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          title={name}
          data-testid="file-viewer-html"
          className="w-full flex-1 rounded-[10px] border border-line bg-white"
        />
      )}
    </div>
  );
};

/** A file that is not shown inline: its type, size and a download button. */
const Tile = ({ file, children, onDownload }: { file: ViewerFile; children?: ReactNode; onDownload: () => void }) => (
  <div
    className="flex max-w-sm flex-col items-center gap-3 rounded-[14px] border border-line bg-surface p-6 text-center"
    data-testid="file-viewer-tile"
  >
    <span className="grid size-14 place-items-center rounded-[12px] bg-info-soft text-info-fg">
      <Icon name="file" size={26} />
    </span>
    <span className="flex flex-col">
      <span className="font-semibold break-all text-fg">{file.name}</span>
      <span className="text-xs text-muted" dir="ltr">
        {ext(file.name).toUpperCase() || file.mime} • {formatSize(file.size)}
      </span>
    </span>
    <p className="text-sm text-muted">{t('files.viewer.noPreview')}</p>
    <div className="flex flex-wrap justify-center gap-2">
      <Button size="sm" onClick={onDownload}>
        <Icon name="download" size={15} />
        {t('files.viewer.download')}
      </Button>
      {children}
    </div>
  </div>
);

const Preview = ({ accountId, file, onDownload }: { accountId: string; file: ViewerFile; onDownload: () => void }) => {
  const kind = fileKind(file);
  const [zoom, setZoom] = useState(false);
  /** Office files go to Microsoft's viewer only when the user asks (it sends them the file's link). */
  const [office, setOffice] = useState(false);
  /** A media file this browser cannot play: the download tile instead. */
  const [failed, setFailed] = useState(false);
  const needsUrl =
    kind !== 'other' &&
    (kind !== 'office' || office) &&
    (kind !== 'text' || file.size <= MAX_TEXT_BYTES) &&
    (kind !== 'html' || file.size <= MAX_HTML_BYTES);
  const url = useInlineUrl(accountId, needsUrl ? file.id : '', file.exact);
  if (needsUrl && url.isError) return <Notice tone="error">{errorMessage(url.error)}</Notice>;
  if (needsUrl && !url.data) return <Skeleton className="h-64 w-full max-w-xl" />;
  const src = url.data?.download_url ?? '';
  switch (kind) {
    case 'image':
      return (
        <button
          type="button"
          onClick={() => setZoom((z) => !z)}
          title={t(zoom ? ('files.viewer.fit' as MessageKey) : ('files.viewer.zoom' as MessageKey))}
          className={cn('block max-h-full max-w-full', zoom ? 'cursor-zoom-out overflow-auto' : 'cursor-zoom-in')}
        >
          <img
            src={src}
            alt={file.name}
            data-testid="file-viewer-image"
            className={cn(zoom ? 'max-w-none' : 'max-h-[calc(100dvh-14rem)] max-w-full object-contain')}
          />
        </button>
      );
    case 'pdf':
      return (
        <iframe
          src={src}
          title={file.name}
          data-testid="file-viewer-pdf"
          className="h-full min-h-[60dvh] w-full rounded-[10px] border border-line bg-surface"
        />
      );
    case 'video':
    case 'audio':
      return failed ? (
        <Tile file={file} onDownload={onDownload} />
      ) : (
        <MediaPlayer
          key={src}
          src={src}
          kind={kind}
          name={file.name}
          onError={() => setFailed(true)}
          className={kind === 'video' ? 'max-h-full max-w-full' : 'max-w-md'}
        />
      );
    case 'html':
      return file.size <= MAX_HTML_BYTES ? (
        <HtmlPreview url={src} name={file.name} />
      ) : (
        <Tile file={file} onDownload={onDownload} />
      );
    case 'text':
      return file.size <= MAX_TEXT_BYTES ? <TextPreview url={src} /> : <Tile file={file} onDownload={onDownload} />;
    case 'office':
      return office ? (
        <iframe
          src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(src)}`}
          title={file.name}
          data-testid="file-viewer-office-frame"
          className="h-full min-h-[60dvh] w-full rounded-[10px] border border-line bg-surface"
        />
      ) : (
        <Tile file={file} onDownload={onDownload}>
          <Button
            variant="secondary"
            size="sm"
            data-testid="file-viewer-office"
            title={t('files.viewer.officeHint')}
            onClick={() => setOffice(true)}
          >
            <Icon name="ext" size={15} />
            {t('files.viewer.office')}
          </Button>
        </Tile>
      );
    default:
      return <Tile file={file} onDownload={onDownload} />;
  }
};

type Entry = UpdateDto | UpdateDto['replies'][number];

/** The comments on a file: the item's updates and replies that carry its id (the item card's query and cache). */
const useFileComments = (accountId: string, itemId: string, fileId: string) => {
  const key = ['account', accountId, 'item', itemId, 'updates'];
  const updates = useQuery({
    queryKey: key,
    queryFn: () => api(accountId).get<{ data: UpdateDto[] }>(`/items/${itemId}/updates`),
  });
  const comments = (updates.data?.data ?? [])
    .flatMap((u): Entry[] => [u, ...u.replies])
    .filter((u) => fileIdOf(u) === fileId)
    .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return { key, updates, comments };
};

/** A pill tab of the viewer's side panel ("Comments 2", "Versions 3"). */
const PanelTab = ({
  on,
  count,
  onClick,
  testId,
  children,
}: {
  on: boolean;
  count: number | null;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) => (
  <button
    type="button"
    role="tab"
    aria-selected={on}
    onClick={onClick}
    data-testid={testId}
    className={cn(
      'rounded-full px-2.5 py-1.5 text-[0.8125rem]',
      on ? 'bg-primary-soft text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg',
    )}
  >
    {children}
    {count !== null ? <span className="ms-1 text-muted tabular-nums">{count}</span> : null}
  </button>
);

/** The comments on the shown file + a box to add one. */
const Comments = ({
  accountId,
  file,
  source,
  canComment,
}: {
  accountId: string;
  file: ViewerFile;
  source: FileSource;
  canComment: boolean;
}) => {
  const qc = useQueryClient();
  const [now] = useState(() => Date.now());
  const [text, setText] = useState('');
  // The same query (and cache) as the item card's updates tab.
  const { key, updates, comments } = useFileComments(accountId, source.itemId, file.id);
  const post = useMutation({
    mutationFn: (body: string) =>
      source.kind === 'update'
        ? api(accountId).post(`/updates/${source.updateId}/replies`, { doc: commentDoc(file, body) })
        : api(accountId).post(`/items/${source.itemId}/updates`, { doc: commentDoc(file, body) }),
    onSuccess: async () => {
      setText('');
      await qc.invalidateQueries({ queryKey: key });
      if (source.boardId) await invalidateUpdateCounts(qc, accountId, source.boardId);
    },
  });
  const send = () => {
    if (text.trim() && !post.isPending) post.mutate(text.trim());
  };
  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2.5 p-3" aria-label={t('files.viewer.comments')}>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto">
        {updates.isPending ? <Skeleton className="h-10 w-full" /> : null}
        {updates.isError ? <Notice tone="error">{errorMessage(updates.error)}</Notice> : null}
        {updates.data && !comments.length ? <p className="text-sm text-muted">{t('files.viewer.noComments')}</p> : null}
        {comments.map((c) => (
          <div
            key={c.id}
            className="flex flex-col gap-1 rounded-[12px] bg-surface-3 p-2.5"
            data-testid="file-viewer-comment-entry"
          >
            <span className="text-xs">
              <b className="font-bold text-fg">{c.author?.name ?? t('activity.system')}</b>{' '}
              <time className="text-muted" dateTime={c.created_at} title={exactTime(c.created_at)}>
                {relativeTime(c.created_at, now)}
              </time>
            </span>
            {/* body_html comes from the server's allowlist renderer (rich.ts), never raw user HTML. */}
            <div className="rich-content text-sm leading-6" dangerouslySetInnerHTML={{ __html: c.body_html }} />
          </div>
        ))}
      </div>
      {canComment ? (
        <div className="flex flex-col gap-2">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
            rows={3}
            placeholder={t('files.viewer.commentPlaceholder')}
            aria-label={t('files.viewer.commentPlaceholder')}
            data-testid="file-viewer-comment"
            className="w-full resize-none rounded-[10px] border border-line bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-primary"
          />
          <Button
            size="sm"
            className="self-end"
            busy={post.isPending}
            disabled={!text.trim()}
            onClick={send}
            data-testid="file-viewer-comment-send"
          >
            <Icon name="send" size={14} />
            {t('files.viewer.commentSend')}
          </Button>
          {post.isError ? <Notice tone="error">{errorMessage(post.error)}</Notice> : null}
        </div>
      ) : null}
    </section>
  );
};

/**
 * File viewer (owner fix 3): a lightbox over everything for the files of one cell or one update — images (fit,
 * click to zoom), PDF, video, audio, HTML pages and text in place; Office files as a tile with download, and a preview through
 * Office Online only on request (it sends the file's link to Microsoft). Prev / next (←/→ and the arrows), download,
 * remove (when allowed, after a confirm) and comments on the file. Esc closes.
 * A file in a files cell has versions: the side panel's "Versions" tab (or the header's button)
 * lists them — upload a new one, view an older one (a bar on the preview says so; download takes the one shown),
 * make it current again, delete one. An update's files have no versions. Under the upload zone, for an image the
 * person may change, "Ask the AI for a change" makes the AI's result the next version.
 */
export const FileViewer = ({
  accountId,
  files,
  startIndex = 0,
  source,
  canComment = true,
  onRemoved,
  onClose,
}: {
  accountId: string;
  files: ViewerFile[];
  startIndex?: number;
  source: FileSource;
  /** May write comments (account viewers may not, unless the account allows it — the server decides too). */
  canComment?: boolean;
  /** A file was removed (the caller refreshes its data). */
  onRemoved?: (file: ViewerFile) => void;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const list = files.filter((f) => !removed.has(f.id));
  const [index, setIndex] = useState(startIndex);
  const at = Math.min(index, list.length - 1);
  const file = list[at];
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  // Focus inside (keys work at once); back to the opener on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    root.current?.focus();
    return () => opener?.focus?.();
  }, []);
  useEffect(() => {
    if (!list.length) closeRef.current();
  }, [list.length]);

  const isCell = source.kind === 'cell';
  const canEdit = isCell && source.canRemove;
  const [tab, setTab] = useState<'comments' | 'versions'>('comments');
  /** An older version shown in the preview (of this file — moving to another file shows its current one). */
  const [viewing, setViewing] = useState<{ fileId: string; versionId: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const rootId = file?.id ?? '';
  const versions = useFileVersions(accountId, rootId, isCell);
  const versionCalls = useVersionActions(accountId, rootId, { itemId: source.itemId, boardId: source.boardId ?? '' });
  const meId = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe, staleTime: 60_000, enabled: isCell }).data?.user.id;
  const boardAdmin = !!useBoard(accountId, isCell ? source.boardId : '').data?.capabilities['board.update'];
  const commentCount = useFileComments(accountId, source.itemId, rootId).comments.length;
  // "Ask the AI for a change": only when the server says this person may, now.
  const aiEditStatus = useAiEditStatus(accountId, rootId, canEdit);
  /**
   * Back to the current version. The focus moves to the dialog first: a focused button that goes away (the older
   * version's bar) drops it to <body>, where the board grid takes it back and Esc no longer reaches the viewer.
   */
  const showCurrent = () => {
    root.current?.focus({ preventScroll: true });
    setViewing(null);
  };
  const uploadVersion = (f: File) => versionCalls.upload.mutate(f, { onSuccess: showCurrent });
  // Same after a row of the list goes away (a deleted version, its menu or confirm closing on it).
  const versionCount = versions.data?.data.length ?? 0;
  useEffect(() => {
    const at = document.activeElement;
    if (!at || at === document.body) root.current?.focus({ preventScroll: true });
  }, [versionCount]);

  const remove = useMutation({
    mutationFn: (f: ViewerFile) =>
      source.kind === 'cell'
        ? api(accountId).delete(`/items/${source.itemId}/cells/${source.columnId}/files/${f.id}`)
        : api(accountId).delete(`/updates/${source.updateId}/files/${f.id}`),
    onSuccess: async (_, f) => {
      setRemoved((s) => new Set(s).add(f.id));
      await qc.invalidateQueries({ queryKey: ['account', accountId, 'item', source.itemId] });
      if (source.kind === 'cell')
        await qc.invalidateQueries({ queryKey: ['account', accountId, 'board', source.boardId, 'items'] });
      onRemoved?.(f);
    },
  });

  // Round and round: past the last file comes the first (the arrows never turn disabled and drop the focus).
  const go = (step: number) => {
    if (list.length) setIndex((at + step + list.length) % list.length);
  };
  const rtl = document.documentElement.dir === 'rtl';
  /** Esc closes; ← / → move between the files (not while typing; in RTL "next" is to the left). */
  const onKey = (key: string, typing: boolean) => {
    if (key === 'Escape') {
      onClose();
      return true;
    }
    if (!typing && (key === 'ArrowLeft' || key === 'ArrowRight')) {
      go((key === 'ArrowLeft') === rtl ? 1 : -1);
      return true;
    }
    return false;
  };
  const keyRef = useRef(onKey);
  useLayoutEffect(() => {
    keyRef.current = onKey;
  });
  // When the focus drops to <body> (a button that went away), the keys still work.
  useEffect(() => {
    const onDocKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.activeElement !== document.body) return;
      if (keyRef.current(e.key, false)) e.preventDefault();
    };
    document.addEventListener('keydown', onDocKey);
    return () => document.removeEventListener('keydown', onDocKey);
  }, []);

  if (!file) return null;
  const versionList = versions.data?.data ?? [];
  const current = versionList.find((v) => v.current);
  const viewed =
    viewing?.fileId === file.id ? versionList.find((v) => v.id === viewing.versionId && !v.current) : undefined;
  // The file as the preview shows it: an older version by its own id, else the cell's file at its current version.
  const shown: ViewerFile = viewed
    ? { id: viewed.id, name: viewed.name, size: viewed.size, mime: viewed.mime, exact: true }
    : current
      ? { id: file.id, name: current.name, size: current.size, mime: current.mime }
      : file;
  const versionLabel =
    isCell && current
      ? viewed
        ? t('files.versions.versionOf', { n: viewed.version, total: versionList.length })
        : t('files.versions.version', { n: current.version })
      : null;
  const versionsOpen = isCell && tab === 'versions';
  // The AI changes the picture shown: an older version being viewed, else the current one (PNG / JPEG / WebP).
  const aiSource = viewed ?? current;
  const aiEditable =
    canEdit && !!aiSource && AI_EDIT_MIMES.includes(aiSource.mime.toLowerCase()) && !!aiEditStatus.data?.available;
  const download = () => void downloadFile(accountId, shown.id, { exact: shown.exact });
  const askRemove = () =>
    void confirmDialog({
      title: t('files.viewer.removeTitle', { name: file.name }),
      // A file in a cell goes to the trash with its versions.
      message: isCell ? t('files.viewer.removeToTrash') : undefined,
      confirmLabel: t('files.viewer.remove'),
      danger: true,
    }).then((ok) => ok && remove.mutate(file));
  // While the "Versions" tab is open, a file dropped anywhere on the viewer is uploaded as the next version.
  const takesDrop = versionsOpen && canEdit;

  return createPortal(
    <div
      className="anim-scrim fixed inset-0 z-modal flex items-stretch justify-center bg-[var(--scrim)] md:p-6"
      // Events from here must not reach what opened the viewer (the cell reopening its list, the card closing).
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={file.name}
        tabIndex={-1}
        data-testid="file-viewer"
        data-file-id={file.id}
        onDragOver={(e) => {
          if (!takesDrop || !dragHasFiles(e.dataTransfer)) return;
          // Not on to the cell that opened the viewer (React bubbles through the portal): it would attach a file.
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          if (!dragOver) setDragOver(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
        }}
        onDrop={(e) => {
          setDragOver(false);
          if (!takesDrop || !dragHasFiles(e.dataTransfer)) return;
          e.preventDefault();
          e.stopPropagation();
          const f = transferFiles(e.dataTransfer)[0];
          if (f && !versionCalls.upload.isPending) uploadVersion(f);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.defaultPrevented) return;
          const typing = (e.target as HTMLElement).matches('input, textarea, [contenteditable="true"]');
          if (onKey(e.key, typing)) e.preventDefault();
        }}
        className="anim-dialog flex h-full w-full max-w-[1200px] flex-col overflow-hidden bg-surface shadow-[var(--shadow-pop)] outline-none md:rounded-[var(--radius-panel)] md:border md:border-[var(--panel-border)]"
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-info-soft text-info-fg">
            <Icon name="file" size={16} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col">
            <h2 className="font-semibold break-words text-heading" data-testid="file-viewer-name">
              {shown.name}
            </h2>
            <span className="text-xs text-muted" data-testid="file-viewer-meta">
              {/* Phones show the version without the size (canvas). */}
              <span className={cn(versionLabel && 'max-sm:hidden')}>
                <span dir="ltr">{formatSize(shown.size)}</span>
                {versionLabel ? ' • ' : null}
              </span>
              {versionLabel ? <span data-testid="file-viewer-version">{versionLabel}</span> : null}
              {list.length > 1 ? ` • ${t('files.viewer.position', { n: at + 1, total: list.length })}` : ''}
            </span>
          </div>
          {isCell ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTab(versionsOpen ? 'comments' : 'versions')}
              aria-pressed={versionsOpen}
              data-testid="file-viewer-versions"
              aria-label={t('files.versions')}
              title={t('files.versions')}
              className={cn(versionsOpen && 'bg-primary-soft text-fg hover:bg-primary-soft')}
            >
              <Icon name="history" size={16} />
              <span className="max-sm:hidden">{t('files.versions')}</span>
              {versionList.length ? <span className="text-muted tabular-nums">{versionList.length}</span> : null}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={download}
            data-testid="file-viewer-download"
            aria-label={t('files.viewer.download')}
            title={t('files.viewer.download')}
          >
            <Icon name="download" size={16} />
            <span className="max-sm:hidden">{t('files.viewer.download')}</span>
          </Button>
          {source.canRemove ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={askRemove}
              busy={remove.isPending}
              data-testid="file-viewer-remove"
              aria-label={t('files.viewer.remove')}
              title={t('files.viewer.remove')}
              className="text-muted hover:text-danger-fg"
            >
              <Icon name="trash" size={16} />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            data-testid="file-viewer-close"
            aria-label={t('common.close')}
            title={t('common.close')}
            className="w-8 px-0 text-muted"
          >
            <Icon name="x" size={18} />
          </Button>
        </header>
        {remove.isError ? (
          <div className="px-4 pt-2">
            <Notice tone="error">{errorMessage(remove.error)}</Notice>
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 max-md:flex-col">
          <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center bg-surface-2 p-4 max-md:min-h-[45dvh]">
            {viewed && current ? (
              <OldVersionBar
                v={viewed}
                total={versionList.length}
                canEdit={canEdit}
                busy={versionCalls.makeCurrent.isPending}
                onBack={showCurrent}
                onMakeCurrent={() => versionCalls.makeCurrent.mutate(viewed, { onSuccess: showCurrent })}
              />
            ) : null}
            {/*: an audio / video file's text, on request, under the player (this version's own). */}
            {mediaKindOf(shown) ? (
              <div
                className={`flex w-full flex-col items-stretch gap-3 ${mediaKindOf(shown) === 'video' ? 'max-w-3xl' : 'max-w-md'}`}
              >
                <Preview
                  key={`${shown.id}${shown.exact ? ':exact' : ''}`}
                  accountId={accountId}
                  file={shown}
                  onDownload={download}
                />
                <TranscriptPanel key={`t-${shown.id}`} accountId={accountId} fileId={shown.id} />
              </div>
            ) : (
              <Preview
                key={`${shown.id}${shown.exact ? ':exact' : ''}`}
                accountId={accountId}
                file={shown}
                onDownload={download}
              />
            )}
            {list.length > 1 ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => go(-1)}
                  aria-label={t('files.viewer.prev')}
                  title={t('files.viewer.prev')}
                  data-testid="file-viewer-prev"
                  className="absolute start-3 top-1/2 h-10 w-10 -translate-y-1/2 rounded-full px-0 shadow-[var(--shadow-pop)]"
                >
                  <Icon name="chevronStart" size={18} />
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => go(1)}
                  aria-label={t('files.viewer.next')}
                  title={t('files.viewer.next')}
                  data-testid="file-viewer-next"
                  className="absolute end-3 top-1/2 h-10 w-10 -translate-y-1/2 rounded-full px-0 shadow-[var(--shadow-pop)]"
                >
                  <Icon name="chevronEnd" size={18} />
                </Button>
              </>
            ) : null}
          </div>
          <aside className="flex min-h-0 flex-col border-line md:w-[320px] md:border-s max-md:max-h-[45dvh] max-md:border-t">
            <div role="tablist" className="flex shrink-0 gap-1 px-3 pt-2.5">
              <PanelTab
                on={!versionsOpen}
                count={commentCount || null}
                onClick={() => setTab('comments')}
                testId="file-viewer-tab-comments"
              >
                {t('files.viewer.commentsTab')}
              </PanelTab>
              {isCell ? (
                <PanelTab
                  on={versionsOpen}
                  count={versionList.length || null}
                  onClick={() => setTab('versions')}
                  testId="versions-tab"
                >
                  {t('files.versions')}
                </PanelTab>
              ) : null}
            </div>
            {versionsOpen ? (
              <VersionsPanel
                accountId={accountId}
                versions={versions}
                viewedId={viewed?.id ?? null}
                onView={(versionId) => setViewing(versionId ? { fileId: file.id, versionId } : null)}
                canEdit={canEdit}
                meId={meId ?? null}
                boardAdmin={boardAdmin}
                actions={versionCalls}
                onUpload={uploadVersion}
                dragOver={dragOver}
                aiEdit={
                  aiEditable && aiSource ? (
                    <AiEditBox
                      key={file.id}
                      actions={versionCalls}
                      source={aiSource}
                      viewingOld={!!viewed}
                      onDone={() => showCurrent()}
                    />
                  ) : undefined
                }
              />
            ) : (
              <Comments key={file.id} accountId={accountId} file={file} source={source} canComment={canComment} />
            )}
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
};
