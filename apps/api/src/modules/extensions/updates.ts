// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  AppError,
  compareSemver,
  type ExtensionManifest,
  type ExtensionSource,
  extensionManifestSchema,
  manifestDelta,
  newId,
  type UpdateCheckResult,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accountMembers, extensionInstallations, extensionVersions, users } from '../../db/schema';
import type { AppDeps, RequestMeta } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import { notifyUsers } from '../notifications/notify';
import { forgetExtensionOrigins } from './ext-origins';
import {
  findAccountExtension,
  findInstallation,
  findKill,
  type InstallationRow,
  updateExtensionRow,
  updateInstallationRow,
} from './extensions.repo';
import { resolveSource } from './manifest-source';
import { installPackData, packStateOf } from './packs';
import { storedSigningSecret } from './ext-signing';
import { deprovisionServer, sendLifecycle } from './server-side';

/**
 * Versions of an installed extension (D27 ת6, MARKETPLACE §4.5). One routine for the admin's "check for updates"
 * and the daily job (`extensions.update_check`): the manifest again (its URL, or the catalog entry) →
 *   the same version → current;
 *   older → current (never downgraded by itself — "back to a version" is the admin's rollback);
 *   locked → kept as "available" (pending), never applied;
 *   a new scope / origin / feature, or auto-update off → waits for an admin's consent (pending + a bell);
 *   anything else → applied now (+ a version row, the `updated` lifecycle call).
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'secrets'>;
export type By = { userId: string | null; requestId: string; meta: RequestMeta | null };

const manifestOf = (raw: unknown): ExtensionManifest => extensionManifestSchema.parse(raw);

export const recordVersion = (
  db: Db,
  row: Pick<InstallationRow, 'id' | 'accountId'>,
  m: ExtensionManifest,
  via: 'installed' | 'auto' | 'approved' | 'manual' | 'rollback',
  userId: string | null,
) =>
  db.insert(extensionVersions).values({
    id: newId(),
    accountId: row.accountId,
    installationId: row.id,
    version: m.version,
    manifest: m as unknown as Record<string, unknown>,
    via,
    appliedBy: userId,
  });

const audit = (db: Db, row: InstallationRow, by: By, action: string, payload: Record<string, unknown>) =>
  recordAudit(db, {
    accountId: row.accountId,
    actorId: by.userId,
    action,
    targetType: 'extension',
    targetId: row.id,
    payload: { key: row.key, ...payload },
    ip: by.meta?.ip ?? null,
    userAgent: by.meta?.userAgent ?? null,
  });

/** Admins hear (bell) that a version waits for them — once per waiting version. */
const notifyAdmins = async (db: Db, row: InstallationRow, m: ExtensionManifest) => {
  const admins = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.userId))
    .where(
      and(
        eq(accountMembers.accountId, row.accountId),
        eq(accountMembers.status, 'active'),
        eq(accountMembers.role, 'admin'),
        eq(users.isService, false),
      ),
    );
  // Required (security): a version asking for more permissions always reaches the admins.
  await notifyUsers(
    db,
    {
      accountId: row.accountId,
      type: 'extension_update',
      actorId: null,
      payload: {
        excerpt: `${m.name} ${m.version}`,
        extension: { installation_id: row.id, key: row.key, version: m.version },
      },
    },
    admins.map((a) => a.userId),
  );
};

/** Where an installation's manifest is fetched again from; null = pasted JSON (nothing to check). */
export const updateSourceOf = async (db: Db, row: InstallationRow): Promise<ExtensionSource | null> => {
  if (row.source === 'catalog') return { catalog_key: row.key };
  if (row.source === 'url') {
    const ext = await findAccountExtension(db, row.accountId, row.key);
    if (ext?.sourceUrl) return { manifest_url: ext.sourceUrl };
  }
  return null;
};

/** After a version changed: the server hears `updated` (or loses its identity when the version has no server). */
export const afterVersionChange = async (deps: Deps, before: InstallationRow, previousVersion: string) => {
  const row = await findInstallation(deps.db, before.accountId, before.id);
  if (!row) return;
  const m = manifestOf(row.manifest);
  const secret = storedSigningSecret(deps.secrets, row);
  if (!m.server) {
    if (row.serviceUserId && row.serverClientId) await deprovisionServer(deps.db, row);
    return;
  }
  if (secret) await sendLifecycle(deps, row, m, { event: 'updated', signingSecret: secret, previousVersion });
};

/**
 * Checks one installation. `manual` (an admin pressed "check"): a fetch error is the request's error; the daily
 * job records it on the installation and moves on.
 */
export const runUpdateCheck = async (
  deps: Deps,
  row: InstallationRow,
  by: By,
  opts: { manual: boolean },
): Promise<UpdateCheckResult> => {
  const { db } = deps;
  const source = await updateSourceOf(db, row);
  if (!source) {
    if (opts.manual) throw new AppError('bad_request', 'no_update_source');
    return 'current';
  }
  let next: ExtensionManifest;
  try {
    const resolved = await resolveSource(deps, source);
    next = resolved.manifest;
    if (next.id !== row.key) throw new AppError('invalid_value', 'manifest_id_changed');
  } catch (err) {
    const code = err instanceof AppError ? err.message : 'manifest_unreachable';
    await updateInstallationRow(db, row.id, { lastCheckedAt: new Date(), checkError: code.slice(0, 120) });
    if (opts.manual) throw err;
    return 'failed';
  }
  const approved = manifestOf(row.manifest);
  const checked = { lastCheckedAt: new Date(), checkError: null };
  const waiting = row.pendingManifest ? extensionManifestSchema.safeParse(row.pendingManifest) : null;
  const waitingVersion = waiting?.success ? waiting.data.version : null;
  if (compareSemver(next.version, approved.version) <= 0) {
    // A newer version that was waiting and has since been withdrawn stops waiting.
    const withdrawn = waitingVersion !== null && compareSemver(waitingVersion, next.version) > 0;
    await updateInstallationRow(db, row.id, { ...checked, ...(withdrawn ? { pendingManifest: null } : {}) });
    return 'current';
  }
  const delta = manifestDelta(approved, next);
  const alreadyWaiting = waitingVersion === next.version;
  // A rollback waiting for consent is the admin's own choice: a newer version does not replace it.
  const rollbackWaiting = waitingVersion !== null && compareSemver(waitingVersion, approved.version) < 0;
  if (rollbackWaiting) {
    await updateInstallationRow(db, row.id, checked);
    return row.versionLocked ? 'locked' : 'pending';
  }
  if (row.source === 'url' && !(await findKill(db, next.id))) {
    const ext = await findAccountExtension(db, row.accountId, row.key);
    if (ext)
      await updateExtensionRow(db, ext.id, {
        name: next.name,
        version: next.version,
        manifest: next as unknown as Record<string, unknown>,
      });
  }
  if (row.versionLocked || delta.needsConsent || !row.autoUpdate) {
    await db.transaction(async (tx) => {
      await updateInstallationRow(tx, row.id, {
        ...checked,
        pendingManifest: next as unknown as Record<string, unknown>,
      });
      if (!alreadyWaiting) {
        await audit(tx, row, by, row.versionLocked ? 'extension.update_available' : 'extension.update_pending', {
          from: approved.version,
          to: next.version,
          added_scopes: delta.addedScopes,
          added_origins: delta.addedOrigins,
          added_features: delta.addedFeatures,
          locked: row.versionLocked,
        });
        if (!row.versionLocked) await notifyAdmins(tx, row, next);
      }
    });
    return row.versionLocked ? 'locked' : 'pending';
  }
  await db.transaction(async (tx) => {
    const state = await installPackData(
      tx,
      { accountId: row.accountId, actorId: by.userId, requestId: by.requestId },
      next,
      packStateOf(row),
    );
    await updateInstallationRow(tx, row.id, {
      ...checked,
      manifest: next as unknown as Record<string, unknown>,
      version: next.version,
      pendingManifest: null,
      // Scopes the new version no longer asks for are dropped from the grant.
      grantedScopes: row.grantedScopes.filter((s) => next.permissions.includes(s as never)),
      state: state as Record<string, unknown>,
    });
    await recordVersion(tx, row, next, opts.manual ? 'manual' : 'auto', by.userId);
    await audit(tx, row, by, 'extension.auto_updated', { from: approved.version, to: next.version });
  });
  forgetExtensionOrigins();
  await afterVersionChange(deps, row, approved.version);
  return 'updated';
};

/** `extensions.update_check` (daily): every installation with a source, one at a time; a failure never stops the rest. */
export const dailyUpdateCheck = async (deps: Deps & Pick<AppDeps, 'logger'>) => {
  const rows = await deps.db
    .select()
    .from(extensionInstallations)
    .where(isNull(extensionInstallations.uninstalledAt))
    .orderBy(extensionInstallations.createdAt);
  const out: Record<UpdateCheckResult, number> = { current: 0, updated: 0, pending: 0, locked: 0, failed: 0 };
  for (const row of rows) {
    if (row.source === 'manifest') continue;
    try {
      out[
        await runUpdateCheck(deps, row, { userId: null, requestId: `job:${newId()}`, meta: null }, { manual: false })
      ]++;
    } catch (err) {
      out.failed++;
      deps.logger.warn({ err, installationId: row.id }, 'extension update check failed');
    }
  }
  return out;
};

// ---- the version list, lock / auto-update, rollback ----

export const listVersions = async (db: Db, row: InstallationRow) => {
  const rows = await db
    .select({ v: extensionVersions, name: users.name })
    .from(extensionVersions)
    .leftJoin(users, eq(users.id, extensionVersions.appliedBy))
    .where(and(eq(extensionVersions.accountId, row.accountId), eq(extensionVersions.installationId, row.id)))
    .orderBy(desc(extensionVersions.createdAt))
    .limit(50);
  let currentMarked = false;
  return rows.map(({ v, name }) => {
    const current = !currentMarked && v.version === row.version;
    if (current) currentMarked = true;
    const m = extensionManifestSchema.safeParse(v.manifest);
    return {
      id: v.id,
      version: v.version,
      via: v.via as 'installed' | 'auto' | 'approved' | 'manual' | 'rollback',
      applied_by_name: name ?? null,
      created_at: v.createdAt.toISOString(),
      current,
      scopes: m.success ? m.data.permissions : [],
    };
  });
};

export const findVersion = async (db: Db, row: InstallationRow, versionId: string) =>
  (
    await db
      .select()
      .from(extensionVersions)
      .where(
        and(
          eq(extensionVersions.accountId, row.accountId),
          eq(extensionVersions.installationId, row.id),
          eq(extensionVersions.id, versionId),
        ),
      )
      .limit(1)
  )[0];

/**
 * Back to an approved version. It locks the installation there (or the daily check would move it forward again).
 * A version that would need more than is granted now waits for consent like an update.
 */
export const rollbackTo = async (deps: Deps, row: InstallationRow, versionId: string, by: By) => {
  const v = await findVersion(deps.db, row, versionId);
  if (!v) throw new AppError('not_found', 'Version not found');
  const target = manifestOf(v.manifest);
  const current = manifestOf(row.manifest);
  if (target.version === current.version) throw new AppError('bad_request', 'already_this_version');
  if (await findKill(deps.db, target.id)) throw new AppError('forbidden', 'extension_killed');
  const delta = manifestDelta(current, target);
  const scopesLeft = row.grantedScopes.filter((s) => target.permissions.includes(s as never));
  if (delta.needsConsent) {
    await updateInstallationRow(deps.db, row.id, {
      pendingManifest: target as unknown as Record<string, unknown>,
      versionLocked: true,
    });
    await audit(deps.db, row, by, 'extension.rollback_pending', { from: current.version, to: target.version });
    return 'pending' as const;
  }
  await deps.db.transaction(async (tx) => {
    const state = await installPackData(
      tx,
      { accountId: row.accountId, actorId: by.userId, requestId: by.requestId },
      target,
      packStateOf(row),
    );
    await updateInstallationRow(tx, row.id, {
      manifest: target as unknown as Record<string, unknown>,
      version: target.version,
      pendingManifest: null,
      grantedScopes: scopesLeft,
      versionLocked: true,
      state: state as Record<string, unknown>,
    });
    await recordVersion(tx, row, target, 'rollback', by.userId);
    await audit(tx, row, by, 'extension.rolled_back', { from: current.version, to: target.version });
  });
  forgetExtensionOrigins();
  await afterVersionChange(deps, row, current.version);
  return 'updated' as const;
};
