// SPDX-License-Identifier: AGPL-3.0-only
import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { t } from '@bines/shared';
import { Button, Notice } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import type { FileVersion, VersionActions } from './versions';

/**
 * "Ask the AI for a change", in the viewer's "Versions" tab under the upload zone: an instruction
 * for the image shown (an older version being viewed, else the current one); the account's image model changes it
 * and the result is the file's next, current version — "make current" on the one before undoes it. Shown only for
 * PNG / JPEG / WebP when the server says the person may (`GET /files/{id}/ai-edit`: edit rights, AI on and within
 * budget, an image model chosen). Each change is a charged AI image (the hint says so).
 */
export const AI_EDIT_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const MAX = 2000;

export const aiEditStatusKey = (accountId: string, rootId: string) =>
  ['account', accountId, 'file-ai-edit', rootId] as const;

export const useAiEditStatus = (accountId: string, rootId: string, enabled: boolean) =>
  useQuery({
    queryKey: aiEditStatusKey(accountId, rootId),
    queryFn: () => api(accountId).get<{ available: boolean; reason: string | null }>(`/files/${rootId}/ai-edit`),
    enabled: enabled && !!rootId,
    staleTime: 60_000,
  });

export const AiEditBox = ({
  actions,
  source,
  viewingOld,
  onDone,
}: {
  actions: VersionActions;
  /** The version the change starts from (the one shown). */
  source: Pick<FileVersion, 'id' | 'version'>;
  /** `source` is an older version being viewed (sent as `version_id`). */
  viewingOld: boolean;
  /** The new version is current: show it. */
  onDone: (v: FileVersion) => void;
}) => {
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const edit = actions.aiEdit;
  const busy = edit.isPending;
  const send = () => {
    const instruction = text.trim();
    if (!instruction || busy) return;
    // The button turns busy (disabled): the focus stays in the box, never dropped to <body> (the board grid).
    box.current?.focus({ preventScroll: true });
    edit.mutate(
      { instruction, versionId: viewingOld ? source.id : null },
      {
        onSuccess: (v) => {
          setText('');
          showToast({ message: t('files.aiEdit.done', { n: v.version }) });
          onDone(v);
        },
      },
    );
  };
  return (
    <section
      className="flex shrink-0 flex-col gap-2 rounded-[var(--radius)] border border-line bg-surface-3 p-2.5"
      aria-label={t('files.aiEdit.title')}
      aria-busy={busy || undefined}
      data-testid="ai-edit"
    >
      <span className="flex items-center gap-1.5 text-[0.8125rem] text-fg">
        <Icon name="sparkle" size={15} />
        {t('files.aiEdit.title')}
      </span>
      <textarea
        ref={box}
        value={text}
        readOnly={busy}
        maxLength={MAX}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          }
        }}
        rows={2}
        placeholder={t('files.aiEdit.placeholder')}
        aria-label={t('files.aiEdit.label')}
        aria-describedby={hintId}
        data-testid="ai-edit-input"
        className="w-full resize-none rounded-[10px] border border-line bg-surface px-3 py-2 text-sm text-fg outline-none placeholder:text-muted focus:border-primary"
      />
      <p id={hintId} className="text-xs text-muted" data-testid="ai-edit-hint">
        {busy
          ? t('files.aiEdit.busy')
          : `${t(viewingOld ? 'files.aiEdit.fromOld' : 'files.aiEdit.fromCurrent', { n: source.version })} ${t('files.aiEdit.cost')}`}
      </p>
      {edit.isError && !busy ? (
        <div data-testid="ai-edit-error">
          <Notice tone="error">{errorMessage(edit.error)}</Notice>
        </div>
      ) : null}
      <Button
        size="sm"
        className="self-end"
        busy={busy}
        disabled={!text.trim()}
        onClick={send}
        data-testid="ai-edit-submit"
      >
        <Icon name="sparkle" size={14} />
        {t('files.aiEdit.submit')}
      </Button>
    </section>
  );
};
