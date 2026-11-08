// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { announcementActive, t, todayIn } from '@bines/shared';
import { Icon } from '../../lib/icons';
import type { MyAccount } from '../../lib/api';
import { useAccountDetail } from './account-settings';

const storageKey = (accountId: string, userId: string) => `bos.announcement.${accountId}.${userId}`;

const readDismissed = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

/**
 * The system announcement (08 §2, A3): set by an admin in Administration → כללי, shown to every member at the top
 * of the app until they close it (remembered per person on this device, by the announcement's id — a new
 * announcement shows again) or until its end date passes.
 */
export const AnnouncementBanner = ({ account, userId }: { account: MyAccount; userId: string }) => {
  const detail = useAccountDetail(account);
  const key = storageKey(account.id, userId);
  const [dismissed, setDismissed] = useState(() => readDismissed(key));
  const [today] = useState(() => todayIn());
  const a = detail.data?.settings.announcement;
  if (!announcementActive(a, today) || dismissed === a.id) return null;
  const close = () => {
    try {
      localStorage.setItem(key, a.id);
    } catch {
      // Private mode: closed for this visit only.
    }
    setDismissed(a.id);
  };
  return (
    <div
      role="status"
      data-testid="announcement-banner"
      data-id={a.id}
      className="flex shrink-0 items-center gap-2.5 border-b border-line bg-info-soft px-4 py-2 text-sm text-fg max-md:px-3"
    >
      <Icon name="info" size={16} className="shrink-0 text-info" />
      <p className="min-w-0 flex-1 break-words">
        <span data-testid="announcement-text">{a.text}</span>
        {a.url ? (
          <>
            {' '}
            <a
              href={a.url}
              target="_blank"
              rel="noreferrer noopener"
              data-testid="announcement-link"
              className="inline-flex items-center gap-1 font-semibold text-heading underline underline-offset-2 hover:no-underline"
            >
              {t('announcement.more')}
              <Icon name="ext" size={12} />
            </a>
          </>
        ) : null}
      </p>
      <button
        type="button"
        onClick={close}
        aria-label={t('announcement.dismiss')}
        title={t('announcement.dismiss')}
        data-testid="announcement-dismiss"
        className="grid size-7 shrink-0 place-items-center rounded-[8px] text-muted hover:bg-surface hover:text-fg"
      >
        <Icon name="x" size={14} />
      </button>
    </div>
  );
};
