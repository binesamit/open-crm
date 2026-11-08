// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError } from '@bines/sdk';
import { he, t, type MessageKey } from '@bines/shared';
import { Button, cn, Input } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { copyText } from '../../lib/entity-menu';
import { Icon } from '../../lib/icons';

/**
 * A link to hand over another way than email (fix8, product owner: "מה הגיבוי שלי אם המיילים לא עובדים?") — an invitation
 * or a one-time sign-in link: the link (read-only, selectable), "העתקה" and "וואטסאפ" (opens a chat with the
 * link as the message, on the phone or WhatsApp Web).
 */
export const CopyLinkField = ({
  url,
  testId,
  message,
  className,
}: {
  url: string;
  testId?: string;
  /** The WhatsApp message before the link. */
  message?: string;
  className?: string;
}) => (
  <div className={cn('flex flex-wrap items-center gap-2', className)} data-testid={testId} data-url={url}>
    <Input
      readOnly
      dir="ltr"
      value={url}
      aria-label={t('link.label')}
      onFocus={(e) => e.currentTarget.select()}
      className="h-9 min-w-0 flex-1 text-xs text-fg-2"
      data-testid={testId ? `${testId}-input` : undefined}
    />
    <Button
      size="sm"
      variant="secondary"
      onClick={() => copyText(url)}
      data-testid={testId ? `${testId}-copy` : undefined}
    >
      <Icon name="copy" size={14} />
      {t('link.copy')}
    </Button>
    <a
      href={`https://wa.me/?text=${encodeURIComponent(message ? `${message}\n${url}` : url)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-8 items-center gap-1.5 rounded-[8px] px-2.5 text-xs font-semibold text-fg-2 hover:bg-surface-2"
      data-testid={testId ? `${testId}-whatsapp` : undefined}
    >
      <Icon name="chat" size={14} />
      {t('link.whatsapp')}
    </a>
  </div>
);

/**
 * The reason a request was refused, in words: `error.<reason>` when the server named one (a 403 carries it in its
 * message), else the code's message.
 */
export const reasonMessage = (err: unknown): string => {
  if (err instanceof ApiError) {
    const key = `error.${err.body.message}` as MessageKey;
    if (key in he) return t(key);
  }
  return errorMessage(err);
};
