// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import type { MyAccount } from '@bines/shared';
import { cn } from '@bines/ui';
import { accountLogoSrc } from './account-settings';

/**
 * The account's mark (A3): its uploaded logo, or the first letter of its name on the accent colour — for the
 * sidebar, the account switcher and Administration → כללי. A logo that fails to load falls back to the letter.
 */
export const AccountLogo = ({
  account,
  size = 30,
  src,
  className,
}: {
  account: Pick<MyAccount, 'id' | 'name' | 'logo_asset_id'>;
  size?: number;
  /** A known URL (e.g. the signed one from GET /accounts/me) instead of the redirect. */
  src?: string | null;
  className?: string;
}) => {
  const url = src === undefined ? accountLogoSrc(account) : src;
  const [failed, setFailed] = useState<string | null>(null);
  if (url && failed !== url)
    return (
      <img
        src={url}
        alt=""
        aria-hidden
        width={size}
        height={size}
        onError={() => setFailed(url)}
        style={{ width: size, height: size }}
        className={cn('shrink-0 rounded-full bg-surface object-cover', className)}
        data-testid="account-logo-img"
      />
    );
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: Math.round(size / 2) }}
      className={cn(
        'grid shrink-0 place-items-center rounded-full bg-accent font-display font-extrabold text-on-accent',
        className,
      )}
      data-testid="account-logo-letter"
    >
      {account.name.trim().charAt(0).toUpperCase()}
    </span>
  );
};
