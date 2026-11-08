// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type ExtensionManifest, newId } from '@bines/shared';
import type { Db } from '../../db/client';
import { findCatalogEntry, insertInstallation, updateInstallationRow } from './extensions.repo';
import { installPackData } from './packs';

/**
 * A new account's starter kit (D12 × D27 ת1): the catalog pack is installed into the account like any other pack
 * — an installation row (no consent needed: a data pack asks for no scopes; the platform owner chose it), its kit
 * built into the account's first workspace. Must run inside the provisioning transaction.
 */
export const installStarterPack = async (
  tx: Db,
  p: { accountId: string; workspaceId: string; manifest: ExtensionManifest },
) => {
  const catalog = await findCatalogEntry(tx, p.manifest.id);
  if (!catalog) throw new AppError('invalid_value', 'unknown_starter_kit');
  const id = newId();
  await insertInstallation(tx, {
    id,
    accountId: p.accountId,
    extensionId: catalog.id,
    key: p.manifest.id,
    version: p.manifest.version,
    manifest: p.manifest as unknown as Record<string, unknown>,
    source: 'catalog',
    grantedScopes: [],
    boardIds: null,
    allowGuests: false,
    status: 'enabled',
    consentedAt: new Date(),
  });
  const state = await installPackData(
    tx,
    { accountId: p.accountId, actorId: null },
    p.manifest,
    {},
    {
      workspaceId: p.workspaceId,
    },
  );
  await updateInstallationRow(tx, id, { state: state as Record<string, unknown> });
  return state;
};
