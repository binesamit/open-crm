// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { INBOUND_SKIP_REASONS, t, tDynamic, type UpdateEmailMeta } from '@bines/shared';

/**
 * Prod — an update that came in by email: its images load through the app (a body image is a file of the
 * update; an image from the web goes through the server, so the sender never sees the reader), a long message folds
 * under "show all", and a small line says what became of its files.
 */

/** Where an email image (`asset:<id>` / `remote:<n>`) of an update loads from — the app's own address, with the account. */
export const emailImageSrc = (accountId: string, updateId: string) => (ref: string) =>
  `/api/v1/updates/${encodeURIComponent(updateId)}/email-images/${encodeURIComponent(ref)}?account_id=${encodeURIComponent(accountId)}`;

/** The update's files shown inside its text (its body images) — not listed again under it. */
export const inlineImageIds = (html: string) =>
  new Set([...html.matchAll(/data-image-ref="asset:([0-9A-HJKMNP-TV-Z]{26})"/g)].map((m) => m[1]!));

/** Folded past this height (px): the start shows, "show all" opens the rest. */
const FOLD_PX = 480;

/** `enabled` (an email's update): fold a long one; otherwise the children as they are. */
export const EmailFold = ({ children, watch, enabled }: { children: ReactNode; watch: string; enabled: boolean }) =>
  enabled ? <Fold watch={watch}>{children}</Fold> : <>{children}</>;

const Fold = ({ children, watch }: { children: ReactNode; watch: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setTall(el.scrollHeight > FOLD_PX + 40);
    measure();
    // Images arrive after the text: measure again as they load.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el.firstElementChild ?? el);
    return () => observer?.disconnect();
  }, [watch]);
  const folded = tall && !open;
  return (
    <div data-testid="email-fold" data-folded={folded || undefined}>
      <div
        ref={ref}
        className="relative overflow-hidden"
        style={folded ? { maxHeight: `${FOLD_PX / 16}rem` } : undefined}
      >
        {children}
        {folded ? (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--surface)] to-transparent"
          />
        ) : null}
      </div>
      {tall ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-testid="email-show-all"
          className="mt-1 text-xs text-heading underline underline-offset-2 hover:no-underline"
        >
          {open ? t('inboundEmail.update.showLess') : t('inboundEmail.update.showAll')}
        </button>
      ) : null}
    </div>
  );
};

/** "2 files attached · 1 not attached: too small (a signature image)" — the names on hover. */
export const EmailFilesLine = ({ files }: { files: NonNullable<UpdateEmailMeta['files']> }) => {
  if (!files.attached && !files.skipped.length) return null;
  const reasons = INBOUND_SKIP_REASONS.filter((r) => files.skipped.some((s) => s.reason === r));
  return (
    <p className="text-xs text-muted" data-testid="update-email-files">
      {t('inboundEmail.update.filesAttached', { count: files.attached })}
      {files.skipped.length ? (
        <span data-tip={files.skipped.map((s) => s.name).join(', ')}>
          {' · '}
          {t('inboundEmail.update.filesSkipped', {
            count: files.skipped.length,
            reasons: reasons.map((r) => tDynamic(`inboundEmail.skip.${r}`)).join(', '),
          })}
        </span>
      ) : null}
    </p>
  );
};
