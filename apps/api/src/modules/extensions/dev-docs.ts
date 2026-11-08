// SPDX-License-Identifier: AGPL-3.0-only
import { type ExtensionDocPage, type ExtensionDocPageKey, resolvePublicAddress } from '@bines/shared';
import type { AccountContext, AppDeps } from '../../types';
import { docsBrandOf } from '../apidocs/apidocs.routes';
import { type ExtDocsBrand, renderExtDocBody } from '../apidocs/extension-docs';
import { loadPlatformSettings } from '../platform/platform-settings';
import { assertAccountAdmin } from '../../lib/account-admin';
import { EXTENSION_ADMINS } from './extensions.service';

/**
 * s37market — the extension developer guide inside the app (Admin → Extensions → For developers → the guide): the
 * same bundled Markdown as the public pages (/api/docs/extensions[/quickstart]), white-labelled the same way (the
 * owner's product name and the deployment's public API address), as JSON the app renders in its own shell. For
 * whoever may manage extensions in the account (the same check as the extensions admin).
 */
type Deps = Pick<AppDeps, 'db' | 'env'>;

/** Rendered once per page and brand (Platform settings are cached ~30 s in this process). */
const cache = new Map<string, ExtensionDocPage>();

export const getExtensionDoc = async (
  deps: Deps,
  ctx: AccountContext,
  page: ExtensionDocPageKey,
): Promise<ExtensionDocPage> => {
  assertAccountAdmin(ctx, EXTENSION_ADMINS);
  const settings = await loadPlatformSettings(deps.db);
  const brand = docsBrandOf(deps.env, settings);
  const b: ExtDocsBrand = {
    productName: brand.productName,
    origin: resolvePublicAddress(settings.public_address, deps.env).api,
  };
  const key = JSON.stringify([page, b]);
  let doc = cache.get(key);
  if (!doc) {
    doc = { ...renderExtDocBody(page, b), product_name: b.productName };
    if (cache.size > 20) cache.clear();
    cache.set(key, doc);
  }
  return doc;
};
