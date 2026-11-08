// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import { type SecretUpdateReveal, t } from '@bines/shared';
import { Button, cn } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { UpdateBody } from '../item/UpdateBody';

type Shown = SecretUpdateReveal & { left: number };

/**
 * A secret update or reply in the thread: a locked card ("Secret update" + Show) until someone
 * reveals it — then its text for the board's seconds with a countdown, copy (when allowed, audited; the clipboard is
 * emptied after the same time where the browser allows) and, for its author, edit. The text lives only in this
 * component's state while shown; nothing is cached. `run` is the card's two-factor step-up (useSecretStepUp).
 */
export const SecretUpdateBody = ({
  accountId,
  updateId,
  className,
  run,
  onEdit,
}: {
  accountId: string;
  updateId: string;
  className?: string;
  run: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  /** The author edits it: gets the revealed document to open in the editor. */
  onEdit?: (shown: SecretUpdateReveal) => void;
}) => {
  const [shown, setShown] = useState<Shown | null>(null);
  const [busy, setBusy] = useState(false);
  const clearTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!shown) return;
    const id = window.setTimeout(() => setShown((s) => (s && s.left > 1 ? { ...s, left: s.left - 1 } : null)), 1000);
    return () => window.clearTimeout(id);
  }, [shown]);
  useEffect(
    () => () => {
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
    },
    [],
  );

  const reveal = async () => {
    setBusy(true);
    try {
      const r = await run(() => api(accountId).post<SecretUpdateReveal>(`/updates/${updateId}/reveal`));
      if (r) setShown({ ...r, left: r.reveal_seconds });
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!shown) return;
    try {
      await api(accountId).post(`/updates/${updateId}/secret-copy`);
      await navigator.clipboard.writeText(shown.body_text);
      showToast({ message: t('secretUpdates.copied', { n: shown.left }), seconds: 3 });
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
      clearTimer.current = window.setTimeout(
        () => void navigator.clipboard?.writeText('').catch(() => {}),
        shown.left * 1000,
      );
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };

  if (!shown)
    return (
      <div
        className="flex flex-wrap items-center gap-2 rounded-[10px] border border-dashed border-line-strong bg-surface-2 px-3 py-2"
        data-testid="secret-update"
        data-state="locked"
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-accent-fg">
          <Icon name="lock" size={14} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm text-fg">{t('secretUpdates.locked')}</span>
          <span className="text-xs text-muted">{t('secretUpdates.lockedHint')}</span>
        </span>
        <Button
          variant="secondary"
          size="sm"
          busy={busy}
          onClick={() => void reveal()}
          data-testid="secret-update-reveal"
        >
          <Icon name="eye" size={14} />
          {t('secretUpdates.reveal')}
        </Button>
      </div>
    );

  return (
    <div
      className="flex flex-col gap-2 rounded-[10px] border border-line bg-surface-2 p-2.5"
      data-testid="secret-update"
      data-state="revealed"
    >
      <UpdateBody html={shown.body_html} className={cn(className)} testId="secret-update-text" />
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
        <Icon name="lock" size={12} />
        <span className="tabular-nums" data-testid="secret-update-countdown">
          {t('secretUpdates.hidesIn', { n: shown.left })}
        </span>
        <span className="ms-auto flex items-center gap-1">
          {shown.copy_allowed ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-[1.625rem] px-2 text-xs"
              onClick={() => void copy()}
              data-testid="secret-update-copy"
            >
              <Icon name="copy" size={13} />
              {t('secretUpdates.copy')}
            </Button>
          ) : null}
          {onEdit ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-[1.625rem] px-2 text-xs"
              onClick={() => {
                onEdit(shown);
                setShown(null);
              }}
              data-testid="secret-update-edit"
            >
              <Icon name="edit" size={13} />
              {t('secretUpdates.edit')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-[1.625rem] px-2 text-xs"
            onClick={() => setShown(null)}
            data-testid="secret-update-hide"
          >
            <Icon name="x" size={13} />
            {t('secretUpdates.hide')}
          </Button>
        </span>
      </div>
    </div>
  );
};
