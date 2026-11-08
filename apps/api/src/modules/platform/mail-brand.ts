// SPDX-License-Identifier: AGPL-3.0-only
import { accountSettingsSchema, type Locale } from '@bines/shared';
import { emailLogoUrl, mailBrand, type MailBrand } from '@bines/server-mail';
import type { Db } from '../../db/client';
import type { AppDeps } from '../../types';
import { asLocale } from '../../lib/i18n';
import { getAccountSettings, type AccountRow } from '../accounts/accounts.repo';
import { loadPlatformSettings } from './platform-settings';
import { webOrigin } from './public-address';

/**
 * The brand of an email (ANSWERS 6א.3): the recipient's language, the platform's product name, and the sender
 * name / Reply-To / logo of the account it belongs to (or of the platform, for sign-in and reset emails).
 */
type Deps = { db: Db; env: Pick<AppDeps['env'], 'WEB_ORIGIN'> };

/** An email of no account (sign-in link, password reset, the owner's channel test). */
export const platformMailBrand = async (deps: Pick<Deps, 'db'>, locale: unknown): Promise<MailBrand> =>
  mailBrand({ locale: asLocale(locale), platform: await loadPlatformSettings(deps.db) });

/** The email logo of an account: its own email logo, else the account logo; null = none. */
export const accountEmailLogo = (account: Pick<AccountRow, 'id' | 'logoAssetId'>, emailLogoId?: string | null) =>
  emailLogoId || account.logoAssetId || null;

/** An account's email; `locale` = the recipient's (a person not yet a user reads the account's language). */
export const accountMailBrand = async (
  deps: Deps,
  account: Pick<AccountRow, 'id' | 'name' | 'logoAssetId'>,
  locale?: unknown,
): Promise<MailBrand> => {
  const parsed = accountSettingsSchema.safeParse(await getAccountSettings(deps.db, account.id));
  const settings = parsed.success ? parsed.data : accountSettingsSchema.parse({});
  const logo = accountEmailLogo(account, settings.branding.email_logo_asset_id);
  return mailBrand({
    locale: asLocale(locale ?? settings.locale.language) as Locale,
    platform: await loadPlatformSettings(deps.db),
    account: { name: account.name, branding: settings.branding },
    logoUrl: logo ? emailLogoUrl(await webOrigin(deps), account.id, logo) : null,
  });
};
