// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useEditorState, type JSONContent } from '@tiptap/react';
import { MAX_UPDATE_FILES, t } from '@bines/shared';
import { Avatar, Button, cn } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage } from '../../lib/api';
import { uploadFile, type UploadedFile } from '../../lib/upload';
import type { Member } from '../board/board-api';
import { isEditorEmpty, RichEditorView, useRichEditor } from './RichEditor';
import { clearDraft, readDraft, writeDraft } from './drafts';
import { sendBlockReason } from './composer-send';
import { showToast } from '../../lib/toast';
import { useDesktop } from '../../lib/use-desktop';
import { transcribe, useVoice } from '../files/voice-api';
import { VoiceRecorder } from '../files/VoiceRecorder';
import { imageFileIdsInText, insertUpdateImage, removeUpdateImage, UpdateImage } from './update-image';

/**
 * The update composer: rich editor (M1.1 #7) + attachments; sends the editor's JSON, the server renders it.
 * Its own module, loaded on first use (`React.lazy` in ItemCard): TipTap + ProseMirror are ~390 KB of the bundle,
 * which a board view never needs (perf review).
 */
const isImage = (f: { mime: string }) => f.mime.startsWith('image/');

/** A file in the composer: just uploaded (a pasted / dropped image keeps a local preview) or already on the update. */
/** `inline`: its image went into the text — it stays on the update only while it is still there. */
type ComposerFile = UploadedFile & { preview?: string; existing?: boolean; inline?: boolean };

/** An image already attached to the update being edited: its signed URL (the same cache as the thread's thumbs). */
const ExistingImage = ({ accountId, file }: { accountId: string; file: UploadedFile }) => {
  const url = useQuery({
    queryKey: ['account', accountId, 'file-url', file.id],
    queryFn: () => api(accountId).get<{ download_url: string }>(`/files/${file.id}`),
    staleTime: 4 * 60_000,
  }).data?.download_url;
  return url ? (
    <img
      src={url}
      alt={file.name}
      data-testid="composer-image"
      className="max-h-24 rounded-[var(--radius-sm)] border border-line"
    />
  ) : (
    <span className="block size-24 rounded-[var(--radius-sm)] border border-line bg-surface-2" />
  );
};

export type ComposerProps = {
  accountId: string;
  members: Member[];
  placeholder: string;
  submitLabel: string;
  busy: boolean;
  autoFocus?: boolean;
  initial?: JSONContent | null;
  allowFiles?: boolean;
  /**
   * f9-updedit: editing an update — the files already on it. They show like new attachments and can be taken off
   * (sent as `removedFileIds` on save; nothing changes until then).
   */
  initialFiles?: UploadedFile[];
  /** Editing an update: where the images already in its text load from. */
  imageSrc?: (ref: string) => string;
  /** Keep the unsent text in this browser under this key (12 hours, `drafts.ts`) and restore it on open. */
  draftKey?: string;
  onCancel?: () => void;
  /**
   * The item's update box: while idle and empty it is a closed one-line box (`avatar` before the
   * text); focusing it opens the full composer, and it stays open while it holds text or files.
   */
  collapsible?: boolean;
  avatar?: { name: string; url?: string | null };
  /**
   * Secret updates: `optional` shows the lock toggle (the board allows them); `forced` = a reply in a
   * secret thread (always secret, no toggle); `off` (default) = none. A secret text is never kept as a draft and
   * takes no files.
   */
  secret?: 'off' | 'optional' | 'forced';
  /**
   * `fileIds`: newly attached files; `removedFileIds`: files of `initialFiles` taken off; `secret`: send it as a secret
   * update. Resolving to `false` keeps the text (nothing was sent, e.g. a verification was cancelled).
   */
  onSubmit: (doc: JSONContent, fileIds: string[], removedFileIds: string[], secret: boolean) => Promise<unknown>;
};

const Composer = ({
  accountId,
  members,
  placeholder,
  submitLabel,
  busy,
  autoFocus,
  initial,
  allowFiles = true,
  initialFiles,
  imageSrc,
  draftKey,
  onCancel,
  collapsible,
  avatar,
  secret = 'off',
  onSubmit,
}: ComposerProps) => {
  /** Sent as a secret update (the lock toggle, or always in a secret thread). */
  const [secretOn, setSecretOn] = useState(secret === 'forced');
  const isSecret = secret === 'forced' || (secret === 'optional' && secretOn);
  /** For the draft saver (an editor event): the current mode, kept after each render. */
  const secretRef = useRef(isSecret);
  useLayoutEffect(() => {
    secretRef.current = isSecret;
  });
  /** Focus is inside the composer (or was, and moved to one of its menus). */
  const [active, setActive] = useState(false);
  // Owner fix (fix4-board 1): an unsent draft comes back when the card / reply box opens again (never a secret one).
  const [draft] = useState(() => (draftKey && !initial && secret !== 'forced' ? readDraft(draftKey) : null));
  /** The text shown came from a saved draft (a subtle "טיוטה שמורה" mark with "ניקוי"). */
  const [restored, setRestored] = useState(!!draft);
  /** Attached so far; pasted / dropped images keep a local preview. */
  const [files, setFiles] = useState<ComposerFile[]>(() => {
    const text = JSON.stringify(initial ?? null);
    return (initialFiles ?? []).map((f) => ({ ...f, existing: true, inline: text.includes(`"asset:${f.id}"`) }));
  });
  /** The update's own files taken off while editing (detached on save). */
  const [removedIds, setRemovedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const voice = useVoice(accountId);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const galleryInput = useRef<HTMLInputElement>(null);
  const desktop = useDesktop();
  const submitRef = useRef<() => void>(() => undefined);
  /** what an image in the text shows — a new one's local preview (by its `asset:` ref), else `imageSrc`. */
  const previewsRef = useRef(new Map<string, string>());
  const imageSrcRef = useRef(imageSrc);
  useLayoutEffect(() => {
    imageSrcRef.current = imageSrc;
  });
  // Built once with the editor; the refs are read only when an image is drawn (never during this render) — the
  // compiler can't see through UpdateImage.configure, hence this exception (as for the mentions in RichEditor).
  // eslint-disable-next-line react-hooks/refs
  const [imageExtension] = useState(() =>
    UpdateImage.configure({ srcOf: (ref) => previewsRef.current.get(ref) ?? imageSrcRef.current?.(ref) ?? '' }),
  );
  const { editor, mention } = useRichEditor({
    members,
    placeholder,
    initial: initial ?? draft,
    autoFocus,
    onSubmit: () => submitRef.current(),
    // Pasted or dropped files (screenshots…) are attached like the 📎 button's — an image also where it was put.
    onFiles: allowFiles ? (list, pos) => void onFiles(list, pos) : undefined,
    extensions: allowFiles ? [imageExtension] : undefined,
  });
  const empty = useEditorState({ editor, selector: ({ editor: e }) => !e || e.isEmpty }) ?? true;
  /**
   * Prod round 2 (product owner: "removing it from the update must remove it completely"): an image deleted from the
   * text (Backspace, cut…) leaves the update — its file is no longer listed, and on send / save it is not attached
   * (a new upload) or is taken off (an edited update's own file), and leaves storage. Until then Ctrl+Z brings it back.
   */
  const inText = useEditorState({ editor, selector: ({ editor: e }) => (e ? imageFileIdsInText(e) : '') }) ?? '';
  const inTextIds = new Set(inText.split(',').filter(Boolean));
  const kept = files.filter((f) => !f.inline || inTextIds.has(f.id));
  const dropped = files.filter((f) => f.inline && !inTextIds.has(f.id));
  // Every change is saved as the draft (an empty editor removes it); closing the card never waits for anything.
  useEffect(() => {
    if (!editor || !draftKey) return;
    // A secret text never lands in the browser's storage: the draft is dropped instead.
    const save = () => writeDraft(draftKey, editor.isEmpty || secretRef.current ? null : editor.getJSON());
    editor.on('update', save);
    return () => {
      editor.off('update', save);
    };
  }, [editor, draftKey]);
  const discardDraft = () => {
    if (draftKey) clearDraft(draftKey);
    editor?.commands.clearContent();
    setRestored(false);
  };

  /**
   * Uploads and attaches the files. an image also goes into the text — at `pos` (where it was pasted
   * or dropped) or, from the 📎 / gallery buttons, at the caret; `null` = attach only (a voice message).
   */
  const onFiles = async (list: FileList | File[] | null, pos?: number | null): Promise<UploadedFile[]> => {
    if (!list?.length) return [];
    let at = pos === undefined ? (editor?.state.selection.to ?? null) : pos;
    // The same limit as the server's (MAX_UPDATE_FILES per update or reply), said before uploading anything.
    if (kept.length + list.length > MAX_UPDATE_FILES) {
      setUploadError(t('error.too_many_files', { limit: MAX_UPDATE_FILES }));
      if (fileInput.current) fileInput.current.value = '';
      if (galleryInput.current) galleryInput.current.value = '';
      return [];
    }
    setUploading(true);
    setUploadError(null);
    const done: UploadedFile[] = [];
    try {
      for (const f of Array.from(list)) {
        const up = await uploadFile(accountId, f);
        done.push(up);
        const preview = isImage(up) ? URL.createObjectURL(f) : undefined;
        const inline = !!preview && !!editor && at !== null;
        setFiles((x) => [...x, { ...up, ...(preview ? { preview } : {}), ...(inline ? { inline } : {}) }]);
        if (preview && editor && at !== null) {
          previewsRef.current.set(`asset:${up.id}`, preview);
          at = insertUpdateImage(editor, at, up);
        }
      }
    } catch (e) {
      setUploadError(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
      if (galleryInput.current) galleryInput.current.value = '';
    }
    return done;
  };
  /**
   * a voice message is attached like any file; with transcription on and "straight into the update", its
   * text is added to what is being written (to edit before sending).
   */
  const onRecorded = async (file: File) => {
    const [up] = await onFiles([file], null);
    if (!up || !voice?.transcription || !voice.auto || !editor) return;
    setTranscribing(true);
    try {
      const { text } = await transcribe(accountId, up.id);
      if (!text) return void showToast({ message: t('voice.empty') });
      if (editor.isDestroyed) return;
      editor
        .chain()
        .focus('end')
        .insertContent(editor.isEmpty ? text : [{ type: 'paragraph', content: [{ type: 'text', text }] }])
        .run();
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error', seconds: 10 });
    } finally {
      setTranscribing(false);
    }
  };
  /** Fix: an update may be only files — text or at least one attachment is enough to send. */
  const canSend = !empty || kept.length > 0;
  const submit = async () => {
    if (!editor || (isEditorEmpty(editor) && !kept.length) || busy || uploading) return;
    const doc = editor.getJSON();
    // r17reply: a refused send used to vanish (an unhandled promise) — now it says why, and the text
    // its draft and the attachments stay so nothing is lost.
    const blocked = sendBlockReason(doc);
    if (blocked) return void showToast({ message: blocked, tone: 'error', seconds: 10 });
    try {
      const sent = await onSubmit(
        doc,
        kept.filter((f) => !f.existing).map((f) => f.id),
        [...removedIds, ...dropped.filter((f) => f.existing).map((f) => f.id)],
        isSecret,
      );
      if (sent === false) return;
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error', seconds: 10 });
      return;
    }
    // New uploads whose image was deleted from the text leave storage (best effort — the hourly sweep catches misses).
    for (const f of dropped)
      if (!f.existing)
        void api(accountId)
          .delete(`/files/${f.id}`)
          .catch(() => undefined);
    editor.commands.clearContent();
    if (draftKey) clearDraft(draftKey);
    setRestored(false);
    for (const f of files) if (f.preview) URL.revokeObjectURL(f.preview);
    previewsRef.current.clear();
    setFiles([]);
    setRemovedIds([]);
  };
  /** Cancel (editing): the uploads made meanwhile leave storage (best effort), the update stays as it was. */
  const cancel = () => {
    for (const f of files) {
      if (f.existing) continue;
      if (f.preview) URL.revokeObjectURL(f.preview);
      void api(accountId)
        .delete(`/files/${f.id}`)
        .catch(() => undefined);
    }
    onCancel?.();
  };
  useLayoutEffect(() => {
    submitRef.current = () => void submit();
  });

  // F4: one card — toolbar, text, then the attach / send row inside it.
  const footer = (
    <>
      {kept.length ? (
        <div className="flex flex-wrap gap-1.5 px-3 pt-1">
          {kept.map((f) => (
            // fix5: a pasted / attached file can be taken off before sending (✕).
            <span
              key={f.id}
              className="group/att relative inline-flex"
              data-testid="composer-file"
              data-name={f.name}
              data-existing={f.existing ? 'true' : undefined}
            >
              {f.existing && isImage(f) ? (
                <ExistingImage accountId={accountId} file={f} />
              ) : f.preview ? (
                <img
                  src={f.preview}
                  alt={f.name}
                  data-testid="composer-image"
                  className="max-h-24 rounded-[var(--radius-sm)] border border-line"
                />
              ) : (
                <span className="inline-flex h-6 items-center gap-1 rounded-full bg-surface-2 ps-2.5 pe-7 text-xs font-semibold text-fg-2">
                  <Icon name="clip" size={12} />
                  {f.name}
                </span>
              )}
              <button
                type="button"
                aria-label={`${t('files.viewer.remove')}: ${f.name}`}
                title={t('files.viewer.remove')}
                data-testid="composer-file-remove"
                onClick={() => {
                  setFiles((x) => x.filter((y) => y.id !== f.id));
                  // its place in the text goes too.
                  if (editor) removeUpdateImage(editor, f.id);
                  // An edited update's own file comes off on save (and stays if the edit is cancelled).
                  if (f.existing) return void setRemovedIds((x) => [...x, f.id]);
                  if (f.preview) URL.revokeObjectURL(f.preview);
                  // fix6: the unsent upload leaves storage too (best effort — the hourly sweep catches misses).
                  void api(accountId)
                    .delete(`/files/${f.id}`)
                    .catch(() => undefined);
                }}
                className={cn(
                  'grid size-5 place-items-center rounded-full text-muted hover:text-danger-fg',
                  f.preview
                    ? 'absolute -end-1.5 -top-1.5 border border-line bg-surface shadow-[var(--shadow-pop)]'
                    : 'absolute end-1 top-0.5',
                )}
              >
                <Icon name="x" size={11} strokeWidth={2.4} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
      {uploadError ? <p className="px-3 pt-1 text-xs text-danger-fg">{uploadError}</p> : null}
      {isSecret ? (
        <p className="flex items-center gap-1.5 px-3 pt-1 text-xs text-muted" data-testid="composer-secret-note">
          <Icon name="lock" size={12} />
          {t('secretUpdates.composerNote')}
        </p>
      ) : null}
      {restored && !empty ? (
        <p className="flex items-center gap-1.5 px-3 pt-1 text-xs text-muted" data-testid="composer-draft">
          <Icon name="history" size={12} />
          {t('item.draft.saved')}
          <span aria-hidden>•</span>
          <button
            type="button"
            className="font-semibold text-fg-2 hover:text-fg hover:underline"
            data-testid="composer-draft-clear"
            onClick={discardDraft}
          >
            {t('item.draft.clear')}
          </button>
        </p>
      ) : null}
      {/* Prod (product owner: "on a phone the update's buttons move sideways"): the row follows the composer's own
          width (a container query — the item card, a reply, a secret update alike) — it wraps, and when narrow the
          secondary buttons show their icon only (the name stays for screen readers and in the tooltip). */}
      <div
        className="@container flex min-w-0 flex-wrap items-center justify-between gap-2 p-2"
        data-testid="composer-actions"
      >
        {allowFiles && !isSecret ? (
          <>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-testid="composer-file-input"
              onChange={(e) => void onFiles(e.target.files)}
            />
            <span className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                busy={uploading}
                onClick={() => fileInput.current?.click()}
                data-tip={t('files.attach')}
                data-testid="composer-attach"
              >
                {uploading ? null : <Icon name="clip" size={15} />}
                <span className={cn(!uploading && '@max-sm:sr-only')}>
                  {uploading ? t('files.uploading') : t('files.attach')}
                </span>
              </Button>
              {/* Phones: photos and videos straight from the gallery (an image-only picker). */}
              {desktop || uploading ? null : (
                <>
                  <input
                    ref={galleryInput}
                    type="file"
                    accept="image/*,video/*"
                    multiple
                    hidden
                    data-testid="composer-gallery-input"
                    onChange={(e) => void onFiles(e.target.files)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => galleryInput.current?.click()}
                    data-tip={t('files.gallery')}
                    data-testid="composer-gallery"
                  >
                    <Icon name="image" size={15} />
                    <span className="@max-sm:sr-only">{t('files.gallery')}</span>
                  </Button>
                </>
              )}
              {/*: a voice message (the account may turn it off). */}
              {voice?.recording ? (
                <VoiceRecorder maxSeconds={voice.max_seconds} disabled={uploading} onDone={(f) => void onRecorded(f)} />
              ) : null}
              {transcribing ? (
                <span className="text-xs text-muted" role="status" data-testid="composer-transcribing">
                  {t('voice.transcribing')}
                </span>
              ) : null}
            </span>
          </>
        ) : (
          <span />
        )}
        <div className="ms-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
          {secret === 'forced' ? (
            <span
              className="inline-flex h-6 items-center gap-1 rounded-full bg-accent-soft px-2 text-xs text-accent-fg"
              data-tip={t('secretUpdates.forced')}
              data-testid="composer-secret-forced"
            >
              <Icon name="lock" size={12} />
              {t('secretUpdates.toggle')}
            </span>
          ) : null}
          {secret === 'optional' ? (
            // send this update as a secret one (encrypted, shown only with a verification code).
            <Button
              variant="ghost"
              size="sm"
              aria-pressed={secretOn}
              disabled={!secretOn && kept.length > 0}
              data-tip={kept.length && !secretOn ? t('secretUpdates.toggleNoFiles') : t('secretUpdates.toggleHint')}
              data-testid="composer-secret"
              className={cn(secretOn && 'bg-accent-soft text-accent-fg hover:bg-accent-soft')}
              onClick={() => {
                const next = !secretOn;
                setSecretOn(next);
                if (next && draftKey) clearDraft(draftKey);
              }}
            >
              <Icon name="lock" size={14} />
              <span className="@max-sm:sr-only">{t('secretUpdates.toggle')}</span>
            </Button>
          ) : null}
          {/* Fix: Enter is a new line; sending is the button or Ctrl/⌘+Enter. */}
          <span data-testid="composer-send-hint" className="text-[0.6875rem] text-muted max-md:hidden">
            {t('item.composer.hint')}
          </span>
          {onCancel ? (
            <Button variant="ghost" size="sm" onClick={cancel} data-testid="composer-cancel">
              {t('common.cancel')}
            </Button>
          ) : null}
          <Button
            size="sm"
            busy={busy}
            onClick={() => void submit()}
            disabled={!canSend || uploading}
            data-testid="composer-send"
            data-tour="item.composer-send"
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </>
  );
  const collapsed = !!collapsible && !active && empty && !kept.length && !uploading && !uploadError;
  const view = (
    <RichEditorView
      editor={editor}
      mention={mention}
      members={members}
      footer={footer}
      collapsed={collapsed}
      lead={avatar ? <Avatar name={avatar.name} url={avatar.url} size={24} /> : undefined}
    />
  );
  if (!collapsible) return view;
  return (
    <div
      data-testid="composer"
      data-tour="item.composer"
      data-collapsed={collapsed ? 'true' : undefined}
      style={{ '--idle-placeholder': JSON.stringify(t('item.writeUpdateIdle')) } as CSSProperties}
      onFocus={() => setActive(true)}
      onBlur={(e) => {
        const root = e.currentTarget;
        // After the focus settles: leaving the window (a file dialog, another app) or opening one of the
        // composer's own menus keeps it open; focus anywhere else closes an empty box again.
        setTimeout(() => {
          if (!document.hasFocus()) return;
          const at = document.activeElement;
          if (at && (root.contains(at) || at.closest('[role="menu"],[role="listbox"],[data-testid="popover"]'))) return;
          setActive(false);
        }, 0);
      }}
    >
      {view}
    </div>
  );
};

export default Composer;
