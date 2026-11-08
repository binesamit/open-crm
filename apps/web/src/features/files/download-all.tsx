// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '@bines/shared';
import { cn } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { reasonMessage } from '../account/CopyLink';
import { useAccountDetail } from '../admin/account-settings';

/** Where a cell's / an update's files download as one ZIP. */
export const cellZipPath = (itemId: string, columnId: string) =>
  `/items/${encodeURIComponent(itemId)}/cells/${encodeURIComponent(columnId)}/files.zip`;
export const updateZipPath = (updateId: string) => `/updates/${encodeURIComponent(updateId)}/files.zip`;

/**
 * "Download all": the server's checks first (`check=1`: access, the account's on / off and limits) so a refusal is
 * a message here, not an error page instead of a download; then the browser downloads the streamed ZIP itself (no
 * copy in this page's memory). Files the person may not read are left out — the toast says how many.
 */
export const downloadAll = async (accountId: string, path: string) => {
  try {
    const { skipped } = await api(accountId).get<{ files: number; skipped: number }>(`${path}?check=1`);
    const link = document.createElement('a');
    link.href = `/api/v1${path}?account_id=${encodeURIComponent(accountId)}`;
    link.download = '';
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
    showToast({
      message: skipped ? t('files.downloadAll.skipped', { count: skipped }) : t('files.downloadAll.starting'),
    });
  } catch (err) {
    showToast({ message: reasonMessage(err), tone: 'error' });
  }
};

/** Whether the account offers "download all" (Administration → General; on by default, also while loading). */
export const useZipDownloads = (accountId: string) =>
  useAccountDetail({ id: accountId }).data?.settings?.downloads?.zip_enabled !== false;

/**
 * "Download all (ZIP)" — shown only while the account offers it. Rendered where the files already show (an open
 * cell, an update), so the account's setting is read only then.
 */
export const DownloadAllButton = ({
  accountId,
  path,
  testId,
  compact,
}: {
  accountId: string;
  path: string;
  testId: string;
  /** Under an update: a small link-like button; in a cell's list: a full-width row. */
  compact?: boolean;
}) => {
  if (!useZipDownloads(accountId)) return null;
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        void downloadAll(accountId, path);
      }}
      className={cn(
        'flex items-center gap-1.5 text-start text-primary hover:bg-surface-2',
        compact ? 'w-fit rounded-[8px] px-1.5 py-0.5 text-xs' : 'w-full rounded px-2 py-1 text-sm',
      )}
    >
      <Icon name="download" size={14} />
      {t('files.downloadAll')}
    </button>
  );
};
