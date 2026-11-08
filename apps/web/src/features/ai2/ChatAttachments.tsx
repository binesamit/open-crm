// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { type AssistantFile, MAX_ASSISTANT_FILES, t } from '@bines/shared';
import { cn } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { downloadFile, uploadFile } from '../../lib/upload';

/**
 * Files in the AI chat ("paste images, files… like the updates composer and outside chat apps")
 * pasted, dropped or chosen files upload at once, the same way as the updates composer's (POST /files/presign);
 * each shows as a chip (an image as its thumbnail) that can be taken off before sending, and a sent message
 * shows its files.
 */
export type ChatFile = AssistantFile & { preview?: string };

const isImage = (f: { mime: string }) => f.mime.startsWith('image/');

export const useChatAttachments = (accountId: string) => {
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Every local preview made (sent ones live on in their bubble) is released when the panel goes.
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const made = previews.current;
    return () => {
      for (const url of made) URL.revokeObjectURL(url);
    };
  }, []);
  const add = async (list: FileList | File[] | null | undefined) => {
    const picked = Array.from(list ?? []);
    if (!picked.length) return;
    if (files.length + picked.length > MAX_ASSISTANT_FILES) {
      setError(t('ai2.assistant.tooManyFiles', { limit: MAX_ASSISTANT_FILES }));
      return;
    }
    setError(null);
    setUploading((n) => n + picked.length);
    for (const f of picked) {
      try {
        const up = await uploadFile(accountId, f);
        const preview = isImage(up) ? URL.createObjectURL(f) : undefined;
        if (preview) previews.current.add(preview);
        setFiles((x) => [...x, { ...up, ...(preview ? { preview } : {}) }]);
      } catch (e) {
        setError(errorMessage(e));
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  /** Takes a file off before sending: it leaves storage too (best effort — the sweep catches misses). */
  const remove = (id: string) => {
    const f = files.find((x) => x.id === id);
    if (f?.preview) {
      URL.revokeObjectURL(f.preview);
      previews.current.delete(f.preview);
    }
    setFiles((x) => x.filter((y) => y.id !== id));
    void api(accountId)
      .delete(`/files/${id}`)
      .catch(() => undefined);
  };
  /** After a send: the chips go (their previews stay with the sent bubble until the panel closes). */
  const take = () => {
    const out = files;
    setFiles([]);
    setError(null);
    return out;
  };
  /** A refused send: the files come back. */
  const restore = (back: ChatFile[]) => setFiles(back);
  return { files, uploading: uploading > 0, error, add, remove, take, restore };
};

/** The files waiting to be sent, above the message box. */
export const AttachmentChips = ({ files, onRemove }: { files: ChatFile[]; onRemove: (id: string) => void }) =>
  files.length ? (
    <div className="flex flex-wrap gap-1.5 pb-1.5" data-testid="assistant-attachments">
      {files.map((f) => (
        <span key={f.id} className="relative inline-flex" data-testid="assistant-attachment" data-name={f.name}>
          {f.preview ? (
            <img
              src={f.preview}
              alt={f.name}
              className="h-14 rounded-[var(--radius-sm)] border border-line object-cover"
            />
          ) : (
            <span className="inline-flex h-7 max-w-[200px] items-center gap-1 rounded-full bg-surface-2 ps-2.5 pe-7 text-xs text-fg-2">
              <Icon name="clip" size={12} />
              <span className="truncate" dir="auto">
                {f.name}
              </span>
            </span>
          )}
          <button
            type="button"
            aria-label={`${t('files.viewer.remove')}: ${f.name}`}
            title={t('files.viewer.remove')}
            data-testid="assistant-attachment-remove"
            onClick={() => onRemove(f.id)}
            className={cn(
              'grid size-5 place-items-center rounded-full text-muted hover:text-danger-fg',
              f.preview
                ? 'absolute -end-1.5 -top-1.5 border border-line bg-surface shadow-[var(--shadow-pop)]'
                : 'absolute end-1 top-1',
            )}
          >
            <Icon name="x" size={11} strokeWidth={2.4} />
          </button>
        </span>
      ))}
    </div>
  ) : null;

/** A sent image: its local preview while it is fresh, else its signed link (the same cache as the updates' thumbs). */
const SentImage = ({ accountId, file }: { accountId: string; file: ChatFile }) => {
  const url = useQuery({
    queryKey: ['account', accountId, 'file-url', file.id],
    queryFn: () => api(accountId).get<{ download_url: string }>(`/files/${file.id}`),
    staleTime: 4 * 60_000,
    enabled: !file.preview,
  }).data?.download_url;
  const src = file.preview ?? url;
  return src ? (
    <img
      src={src}
      alt={file.name}
      data-testid="assistant-message-image"
      className="max-h-40 max-w-full rounded-[10px] border border-line object-contain"
    />
  ) : (
    <span className="block h-20 w-28 animate-pulse rounded-[10px] bg-surface-2" />
  );
};

/** The files of a sent message, under its bubble. */
export const MessageFiles = ({ accountId, files }: { accountId: string; files: ChatFile[] }) =>
  files.length ? (
    <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5" data-testid="assistant-message-files">
      {files.map((f) =>
        isImage(f) ? (
          <SentImage key={f.id} accountId={accountId} file={f} />
        ) : (
          <button
            key={f.id}
            type="button"
            data-testid="assistant-message-file"
            onClick={() => void downloadFile(accountId, f.id).catch(() => undefined)}
            className="inline-flex h-7 max-w-[220px] items-center gap-1 rounded-full border border-line bg-surface px-2.5 text-xs text-fg-2 hover:border-primary"
          >
            <Icon name="clip" size={12} />
            <span className="truncate" dir="auto">
              {f.name}
            </span>
          </button>
        ),
      )}
    </div>
  ) : null;
