// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import { AppError, extensionKind, extensionManifestSchema } from '@bines/shared';
import type { Db } from '../../db/client';
import { extensionInstallations } from '../../db/schema';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { auditInstalls, catalogEntries } from './catalog';
import { storedSigningSecret } from './ext-signing';
import { sendLifecycle } from './server-side';
import { forgetExtensionOrigins } from './ext-origins';
import {
  deleteKill,
  findKill,
  insertKill,
  installCountsByKey,
  installedKeys,
  listCatalog,
  listKills,
} from './extensions.repo';
import { starterKits } from './packs';

/**
 * The platform owner's view of extensions (owner console, D12 × D27): the catalog and every key installed
 * anywhere, with the emergency kill switch — a key switched off in every account at once (tokens, frames, CORS).
 */
export const listPlatformExtensions = async (db: Db) => {
  const [catalog, installed, counts, kills, entries] = await Promise.all([
    listCatalog(db),
    installedKeys(db),
    installCountsByKey(db),
    listKills(db),
    catalogEntries(db),
  ]);
  const killed = new Map(kills.map((k) => [k.key, k]));
  const out = new Map<string, { key: string; name: string; kind: 'data' | 'code'; catalog: boolean }>();
  for (const c of catalog) {
    const m = extensionManifestSchema.safeParse(c.manifest);
    out.set(c.key, { key: c.key, name: c.name, kind: m.success ? extensionKind(m.data) : 'data', catalog: true });
  }
  for (const r of installed) {
    if (out.has(r.key)) continue;
    const m = extensionManifestSchema.safeParse(r.manifest);
    out.set(r.key, {
      key: r.key,
      name: m.success ? m.data.name : r.key,
      kind: m.success ? extensionKind(m.data) : 'code',
      catalog: false,
    });
  }
  // A killed key nobody has installed any more still shows (so it can be switched back on).
  for (const k of kills) if (!out.has(k.key)) out.set(k.key, { key: k.key, name: k.key, kind: 'code', catalog: false });
  return {
    data: [...out.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((e) => {
        const k = killed.get(e.key);
        return {
          ...e,
          installs: counts.get(e.key) ?? 0,
          killed: k ? { reason: k.reason, at: k.createdAt.toISOString() } : null,
          entry: entries.get(e.key) ?? null,
        };
      }),
  };
};

/**
 * ת7 × ת6: the servers of the key's enabled installations hear `disabled` / `enabled` (reason `platform_kill`) —
 * their tokens already stop (or work again) on the next request either way.
 */
const tellServers = async (
  deps: Pick<AppDeps, 'db' | 'env' | 'secrets'>,
  key: string,
  event: 'disabled' | 'enabled',
) => {
  const rows = await deps.db
    .select()
    .from(extensionInstallations)
    .where(
      and(
        eq(extensionInstallations.key, key),
        isNull(extensionInstallations.uninstalledAt),
        eq(extensionInstallations.status, 'enabled'),
      ),
    );
  for (const row of rows) {
    const m = extensionManifestSchema.safeParse(row.manifest);
    const secret = storedSigningSecret(deps.secrets, row);
    if (m.success && m.data.server && secret)
      await sendLifecycle(deps, row, m.data, { event, signingSecret: secret, reason: 'platform_kill' });
  }
};

/** POST /platform/extensions/kill — the emergency kill switch: effective on the next request in every account. */
export const killExtension = async (
  deps: Pick<AppDeps, 'db' | 'env' | 'secrets'>,
  owner: SessionUser,
  input: { key: string; reason: string },
  meta: RequestMeta,
) => {
  await deps.db.transaction(async (tx) => {
    await insertKill(tx, { key: input.key, reason: input.reason, killedBy: owner.id });
    await auditInstalls(tx, input.key, owner, 'extension.killed', { reason: input.reason }, meta);
  });
  forgetExtensionOrigins();
  await tellServers(deps, input.key, 'disabled');
  return { ok: true as const };
};

export const unkillExtension = async (
  deps: Pick<AppDeps, 'db' | 'env' | 'secrets'>,
  owner: SessionUser,
  key: string,
  meta: RequestMeta,
) => {
  if (!(await findKill(deps.db, key))) throw new AppError('not_found', 'Not killed');
  await deps.db.transaction(async (tx) => {
    await deleteKill(tx, key);
    await auditInstalls(tx, key, owner, 'extension.unkilled', {}, meta);
  });
  forgetExtensionOrigins();
  await tellServers(deps, key, 'enabled');
  return { ok: true as const };
};

/** GET /platform/starter-kits — the kits a new account can open with (catalog packs with a starter kit). */
export const starterKitOptions = async (db: Db) => ({
  data: (await starterKits(db)).map((m) => ({
    key: m.id,
    name: m.name,
    name_en: m.name_en ?? null,
    default: !!m.data?.starter_kit?.default,
    description: m.description ?? null,
    version: m.version,
    icon: m.icon ?? null,
    folders: m.data?.starter_kit?.folders.length ?? 0,
    boards: m.data?.starter_kit?.boards.length ?? 0,
  })),
});
