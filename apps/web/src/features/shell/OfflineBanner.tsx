// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '@bines/shared';
import { Icon } from '../../lib/icons';
import { useOnline } from '../../lib/use-online';

/**
 * "אין חיבור" (11-UI §13; audit 2026-10-10 ux #13): while the browser is offline, a banner at the top of the
 * content says so before anything fails. Writes are not queued (`networkMode: 'always'`, main.tsx — never run later
 * over someone else's change), so the banner says changes are not saved until the connection is back.
 */
export const OfflineBanner = () => {
  const online = useOnline();
  if (online) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="offline-banner"
      className="sticky top-0 z-30 flex shrink-0 items-center gap-2 border-b border-warn bg-warn-soft px-4 py-2 text-sm text-fg max-md:px-3"
    >
      <Icon name="warn" size={15} className="shrink-0" />
      <span className="min-w-0">{t('offline.banner')}</span>
    </div>
  );
};
