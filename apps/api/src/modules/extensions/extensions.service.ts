// SPDX-License-Identifier: AGPL-3.0-only
import { createHash } from 'node:crypto';
import {
  AppError,
  blockKey,
  type ExtensionConsent,
  type ExtensionFrameFeature,
  type ExtensionManifest,
  type ExtensionSource,
  extensionKind,
  extensionManifestSchema,
  extensionWidgetSettingsSchema,
  featureOrigin,
  type FrameFeature,
  frameOriginsOf,
  isFrameFeature,
  isLocalOrigin,
  manifestDelta,
  newId,
  viewSettingsSchema,
} from '@bines/shared';
import type { z } from 'zod';
import type { updateInstallationSchema } from '@bines/shared';
import type { Db } from '../../db/client';
import { RateLimiter } from '../../lib/rate-limit';
import type { AccountContext, AppDeps, RequestMeta, Actor } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import { loadBoardAccess, readableBoardIds } from '../boards/boards.access';
import { boardsByIds, listAccountBoards, listBoardsInWorkspaces, listWorkspaces } from '../boards/boards.repo';
import { loadDashboardAccess } from '../dashboards/dashboards.access';
import { findWidget } from '../dashboards/dashboards.repo';
import { findView } from '../views/views.repo';
import { dashboardSettingsOf } from '../dashboards/dashboards.service';
import { forgetExtensionOrigins } from './ext-origins';
import { rotateSigningSecret, signingSecretOf, storedSigningSecret } from './ext-signing';
import { liveInstallation, newClaims, signExtToken } from './ext-token';
import {
  clearStorage,
  findAccountExtension,
  findInstallation,
  findInstallationById,
  findInstallationByKey,
  findKill,
  type InstallationRow,
  insertExtension,
  insertInstallation,
  killedKeys,
  listCatalog,
  listInstallations,
  updateExtensionRow,
  updateInstallationRow,
} from './extensions.repo';
import { parseManifest, resolveSource, type ResolvedManifest } from './manifest-source';
import { boardInScope, inScope, scopeIsAll, scopeWorkspaceIds, withScopeWorkspaces } from './scope';
import { installPackData, packStateOf, packSummary, removePackTemplates } from './packs';
import {
  deprovisionServer,
  provisionServer,
  rotateServerCredentials,
  type ServerCredentials,
  sendLifecycle,
} from './server-side';
import { afterVersionChange, listVersions, recordVersion, rollbackTo, runUpdateCheck } from './updates';
import { assertAccountAdmin, isAccountAdmin } from '../../lib/account-admin';

/**
 * Extensions per account (D27 ת0–ת2): admins add (catalog / URL / pasted manifest), consent, enable, disable and
 * uninstall; any member may open an enabled board view (guests only where allowed). Every change is audited and
 * drops the cached CSP / CORS origins.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'secrets'>;
type UpdateInstallation = z.infer<typeof updateInstallationSchema>;

/** Extensions are the admins' (their clients know this reason). */
export const EXTENSION_ADMINS = { reason: 'extensions_admins_only' } as const;

const manifestOf = (raw: unknown): ExtensionManifest => extensionManifestSchema.parse(raw);

const WRITE_SCOPES = new Set([
  'boards:write',
  'items:write',
  'updates:write',
  'users:write',
  'teams:write',
  'automations:write',
  'agents:run',
  'agents:write',
  'webhooks',
  'notifications:write',
]);
const scopeLines = (scopes: readonly string[]) => scopes.map((s) => ({ scope: s, write: WRITE_SCOPES.has(s) }));

const featuresOf = (m: ExtensionManifest) =>
  m.features.map((f) => ({
    type: f.type,
    key: f.key,
    name: f.name,
    name_en: f.name_en ?? null,
    url: 'url' in f ? f.url : null,
  }));

const dto = (row: InstallationRow, killed: boolean) => {
  const m = manifestOf(row.manifest);
  const pending = row.pendingManifest ? extensionManifestSchema.safeParse(row.pendingManifest) : null;
  const delta = pending?.success ? manifestDelta(m, pending.data) : null;
  return {
    id: row.id,
    key: row.key,
    name: m.name,
    name_en: m.name_en ?? null,
    description: m.description ?? null,
    icon: m.icon ?? null,
    version: row.version,
    kind: extensionKind(m),
    status: row.status as 'enabled' | 'disabled',
    killed,
    publisher: { name: m.publisher.name, email: m.publisher.email ?? null, url: m.publisher.url ?? null },
    source: row.source as 'url' | 'manifest' | 'catalog',
    source_url: null as string | null,
    requested_scopes: m.permissions,
    granted_scopes: row.grantedScopes,
    board_ids: row.boardIds ?? null,
    workspace_ids: scopeWorkspaceIds(row),
    allow_guests: row.allowGuests,
    frame_origins: frameOriginsOf(m),
    features: featuresOf(m),
    data: packSummary(m),
    pending_update:
      pending?.success && delta
        ? {
            version: pending.data.version,
            requested_scopes: pending.data.permissions,
            added_scopes: delta.addedScopes,
            added_origins: delta.addedOrigins,
            added_features: delta.addedFeatures,
          }
        : null,
    consented_at: row.consentedAt?.toISOString() ?? null,
    installed_at: row.createdAt.toISOString(),
    version_locked: row.versionLocked,
    auto_update: row.autoUpdate,
    last_checked_at: row.lastCheckedAt?.toISOString() ?? null,
    check_error: row.checkError ?? null,
    server: m.server
      ? {
          lifecycle_url: m.server.lifecycle_url,
          status: (row.serverStatus ?? 'pending') as 'pending' | 'connected' | 'failed',
          client_id: row.serverClientId ?? null,
          last_error: row.serverError ?? null,
          last_event: row.serverEvent ?? null,
          last_event_at: row.serverEventAt?.toISOString() ?? null,
        }
      : null,
  };
};

const audit = (db: Db, a: Actor, meta: RequestMeta, action: string, row: { id: string }, payload: object) =>
  recordAudit(db, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action,
    targetType: 'extension',
    targetId: row.id,
    payload: payload as Record<string, unknown>,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

// ---- reading ----

export const listExtensions = async (deps: Deps, a: Actor) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  const [rows, catalog] = await Promise.all([listInstallations(deps.db, a.ctx.accountId), listCatalog(deps.db)]);
  const killed = await killedKeys(deps.db, [...rows.map((r) => r.key), ...catalog.map((c) => c.key)]);
  const installed = new Set(rows.map((r) => r.key));
  const installedVersion = new Map(rows.map((r) => [r.key, r.version]));
  return {
    installed: rows.map((r) => dto(r, killed.has(r.key))),
    catalog: catalog.flatMap((c) => {
      const m = extensionManifestSchema.safeParse(c.manifest);
      if (!m.success) return [];
      return [
        {
          key: c.key,
          name: m.data.name,
          name_en: m.data.name_en ?? null,
          description: m.data.description ?? null,
          icon: m.data.icon ?? null,
          version: m.data.version,
          kind: extensionKind(m.data),
          data: packSummary(m.data),
          installed: installed.has(c.key),
          killed: killed.has(c.key),
          description_en: m.data.description_en ?? null,
          publisher: { name: m.data.publisher.name, url: m.data.publisher.url ?? null },
          feature_types: [...new Set(m.data.features.map((f) => f.type))],
          permissions: m.data.permissions,
          installed_version: installedVersion.get(c.key) ?? null,
        },
      ];
    }),
  };
};

/** sha256 of a validated manifest (EXT-RT3): what the consent screen showed, compared again at install. */
export const manifestDigest = (m: ExtensionManifest) => createHash('sha256').update(JSON.stringify(m)).digest('hex');

const preview = async (deps: Deps, a: Actor, resolved: ResolvedManifest) => {
  const m = resolved.manifest;
  const existing = await findInstallationByKey(deps.db, a.ctx.accountId, m.id);
  const live = existing && !existing.uninstalledAt ? existing : null;
  const delta = live ? manifestDelta(manifestOf(live.manifest), m) : null;
  const warnings: string[] = [];
  if (extensionKind(m) === 'code') warnings.push('runs_code');
  if (m.origins.some(isLocalOrigin)) warnings.push('local_origin');
  if (m.permissions.some((s) => WRITE_SCOPES.has(s))) warnings.push('can_write');
  // ת6: its own server acts as a service user (within the grant) without anyone opening it.
  if (m.server) warnings.push('has_server');
  if (await findKill(deps.db, m.id)) warnings.push('killed');
  return {
    manifest: m,
    digest: manifestDigest(m),
    kind: extensionKind(m),
    scopes: scopeLines(m.permissions),
    frame_origins: frameOriginsOf(m),
    features: featuresOf(m),
    data: packSummary(m),
    warnings,
    existing:
      live && delta
        ? {
            installation_id: live.id,
            version: live.version,
            added_scopes: delta.addedScopes,
            added_origins: delta.addedOrigins,
            added_features: delta.addedFeatures,
          }
        : null,
  };
};

/** POST /extensions/preview — the consent screen's content: what it adds, which permissions, in plain words. */
export const previewExtension = async (deps: Deps, a: Actor, source: ExtensionSource) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  return preview(deps, a, await resolveSource(deps, source));
};

// ---- consent ----

/** The admin grants at most what the manifest asks for, on boards of this account. */
const checkConsent = async (db: Db, accountId: string, m: ExtensionManifest, consent: ExtensionConsent) => {
  const extra = consent.scopes.filter((s) => !m.permissions.includes(s));
  if (extra.length) throw new AppError('invalid_value', 'scope_not_requested', { scopes: extra });
  if (consent.board_ids) {
    const ids = [...new Set(consent.board_ids)];
    const found = (await boardsByIds(db, accountId, ids)).filter((b) => !b.parentBoardId);
    if (found.length !== ids.length) throw new AppError('invalid_value', 'unknown_board');
  }
  const workspaceIds = consent.workspace_ids ? [...new Set(consent.workspace_ids)] : null;
  if (workspaceIds) {
    const live = new Set((await listWorkspaces(db, accountId)).map((w) => w.id));
    if (workspaceIds.some((w) => !live.has(w))) throw new AppError('invalid_value', 'unknown_workspace');
  }
  return {
    columns: {
      grantedScopes: [...new Set(consent.scopes)],
      boardIds: consent.board_ids ? [...new Set(consent.board_ids)] : null,
      allowGuests: consent.allow_guests,
    },
    workspaceIds,
  };
};

/** The extension row an installation points at: the catalog's, or this account's private one (upserted by key). */
const extensionRowFor = async (tx: Db, a: Actor, r: ResolvedManifest) => {
  const m = r.manifest;
  if (r.source === 'catalog') {
    const rows = await listCatalog(tx);
    const row = rows.find((x) => x.key === m.id);
    if (!row) throw new AppError('not_found', 'Extension not found');
    return row.id;
  }
  const mine = await findAccountExtension(tx, a.ctx.accountId, m.id);
  const fields = {
    name: m.name,
    version: m.version,
    kind: extensionKind(m),
    manifest: m as unknown as Record<string, unknown>,
    sourceUrl: r.sourceUrl,
  };
  if (mine) {
    await updateExtensionRow(tx, mine.id, fields);
    return mine.id;
  }
  const id = newId();
  await insertExtension(tx, { id, accountId: a.ctx.accountId, key: m.id, createdBy: a.user.id, ...fields });
  return id;
};

/**
 * POST /extensions/install — with the admin's consent. A pack's data is loaded in the same transaction
 * (idempotent: a reinstall reuses the uninstalled row and its state, so nothing is created twice).
 */
export const installExtension = async (
  deps: Deps,
  a: Actor,
  input: { source: ExtensionSource; consent: ExtensionConsent; manifest_digest?: string },
  meta: RequestMeta,
  /** A starter kit built into this workspace instead of a new one (the start screen). */
  opts: { workspaceId?: string; withItems?: boolean } = {},
) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  const resolved = await resolveSource(deps, input.source);
  const m = resolved.manifest;
  // EXT-RT3: a URL may serve one manifest to the consent screen and another to the install.
  if (input.manifest_digest && input.manifest_digest !== manifestDigest(m))
    throw new AppError('conflict', 'manifest_changed', { version: m.version });
  if (await findKill(deps.db, m.id)) throw new AppError('forbidden', 'extension_killed');
  const grant = await checkConsent(deps.db, a.ctx.accountId, m, input.consent);
  let creds: ServerCredentials | null = null;
  const row = await deps.db.transaction(async (tx) => {
    const existing = await findInstallationByKey(tx, a.ctx.accountId, m.id);
    if (existing && !existing.uninstalledAt) throw new AppError('conflict', 'extension_already_installed');
    const extensionId = await extensionRowFor(tx, a, resolved);
    const now = new Date();
    const fields = {
      extensionId,
      version: m.version,
      manifest: m as unknown as Record<string, unknown>,
      source: resolved.source,
      ...grant.columns,
      status: 'enabled',
      pendingManifest: null,
      consentedBy: a.user.id,
      consentedAt: now,
      installedBy: a.user.id,
      uninstalledAt: null,
    };
    const id = existing?.id ?? newId();
    if (existing) await updateInstallationRow(tx, id, fields);
    else await insertInstallation(tx, { id, accountId: a.ctx.accountId, key: m.id, ...fields });
    const state = await installPackData(
      tx,
      { accountId: a.ctx.accountId, actorId: a.user.id, requestId: a.requestId ?? meta.requestId },
      m,
      existing ? packStateOf(existing) : {},
      opts,
    );
    await updateInstallationRow(tx, id, { state: withScopeWorkspaces(state, grant.workspaceIds) });
    await recordVersion(tx, { id, accountId: a.ctx.accountId }, m, 'installed', a.user.id);
    // ת6: an extension with its own server gets its service user and credentials (sent in `installed`).
    if (m.server)
      creds = await provisionServer(
        tx,
        deps.secrets,
        { id, accountId: a.ctx.accountId, serviceUserId: existing?.serviceUserId ?? null },
        m,
        a.user.id,
      );
    await audit(
      tx,
      a,
      meta,
      existing ? 'extension.reinstalled' : 'extension.installed',
      { id },
      {
        key: m.id,
        version: m.version,
        kind: extensionKind(m),
        source: resolved.source,
        source_url: resolved.sourceUrl,
        scopes: grant.columns.grantedScopes,
        board_ids: grant.columns.boardIds,
        workspace_ids: grant.workspaceIds,
        allow_guests: grant.columns.allowGuests,
        frame_origins: frameOriginsOf(m),
        server: m.server ? m.server.lifecycle_url : null,
      },
    );
    return (await findInstallation(tx, a.ctx.accountId, id))!;
  });
  forgetExtensionOrigins();
  const issued = creds as ServerCredentials | null;
  if (issued)
    await sendLifecycle(deps, row, m, { event: 'installed', signingSecret: issued.signingSecret, credentials: issued });
  return dto((await findInstallation(deps.db, a.ctx.accountId, row.id)) ?? row, false);
};

const mustFind = async (db: Db, accountId: string, id: string) => {
  const row = await findInstallation(db, accountId, id);
  if (!row) throw new AppError('not_found', 'Extension not found');
  return row;
};

/** PATCH /extensions/installations/:id — enable / disable, narrower or wider (≤ requested) scopes, boards, guests. */
export const updateInstallation = async (
  deps: Deps,
  a: Actor,
  id: string,
  input: UpdateInstallation,
  meta: RequestMeta,
) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  const row = await mustFind(deps.db, a.ctx.accountId, id);
  const m = manifestOf(row.manifest);
  const patch: Partial<InstallationRow> = {};
  if (input.status) patch.status = input.status;
  if (
    input.scopes ||
    input.board_ids !== undefined ||
    input.workspace_ids !== undefined ||
    input.allow_guests !== undefined
  ) {
    const grant = await checkConsent(deps.db, a.ctx.accountId, m, {
      accept: true,
      scopes: input.scopes ?? (row.grantedScopes as ExtensionConsent['scopes']),
      board_ids: input.board_ids !== undefined ? input.board_ids : row.boardIds,
      workspace_ids: input.workspace_ids !== undefined ? input.workspace_ids : scopeWorkspaceIds(row),
      allow_guests: input.allow_guests ?? row.allowGuests,
    });
    Object.assign(patch, grant.columns);
    if (input.workspace_ids !== undefined) patch.state = withScopeWorkspaces(row.state, grant.workspaceIds);
    // Granting more than before is a new consent.
    if (grant.columns.grantedScopes.some((s) => !row.grantedScopes.includes(s))) {
      patch.consentedBy = a.user.id;
      patch.consentedAt = new Date();
    }
  }
  await deps.db.transaction(async (tx) => {
    await updateInstallationRow(tx, id, patch);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'state') {
        before.workspace_ids = scopeWorkspaceIds(row);
        after.workspace_ids = scopeWorkspaceIds({ state: v as InstallationRow['state'] });
        continue;
      }
      before[k] = (row as Record<string, unknown>)[k];
      after[k] = v;
    }
    await audit(tx, a, meta, 'extension.updated', row, { key: row.key, before, after });
  });
  forgetExtensionOrigins();
  let next = (await mustFind(deps.db, a.ctx.accountId, id))!;
  // ת6: the extension's server hears about it (on / off, or a changed grant).
  const secret = m.server ? storedSigningSecret(deps.secrets, next) : null;
  if (secret && Object.keys(patch).length) {
    const event =
      patch.status && patch.status !== row.status ? (patch.status === 'enabled' ? 'enabled' : 'disabled') : 'updated';
    await sendLifecycle(deps, next, m, { event, signingSecret: secret });
    next = (await mustFind(deps.db, a.ctx.accountId, id))!;
  }
  return dto(next, !!(await findKill(deps.db, row.key)));
};

/**
 * DELETE /extensions/installations/:id — its views stop loading and its tokens stop working at once; a pack's
 * templates leave the picker. Boards, automations and agents it created stay (they are the account's now).
 */
export const uninstallExtension = async (deps: Deps, a: Actor, id: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  const row = await mustFind(deps.db, a.ctx.accountId, id);
  const secret = storedSigningSecret(deps.secrets, row);
  await deps.db.transaction(async (tx) => {
    // The signing secret ends with the installation (a reinstall gets a new one); the last call is signed with it.
    await updateInstallationRow(tx, id, {
      uninstalledAt: new Date(),
      status: 'disabled',
      pendingManifest: null,
      signingSecret: null,
    });
    await removePackTemplates(tx, a.ctx.accountId, packStateOf(row));
    // Its storage ends with it too: a reinstall reuses the row (one per account and key), and must never hand an
    // extension — maybe another publisher's under the same id — what the last one kept.
    await clearStorage(tx, id);
    // ת6: every server token, the credentials and the service user's membership end with the installation.
    if (row.serviceUserId || row.serverClientId) await deprovisionServer(tx, row);
    await audit(tx, a, meta, 'extension.uninstalled', row, { key: row.key, version: row.version });
  });
  forgetExtensionOrigins();
  const m = extensionManifestSchema.safeParse(row.manifest);
  if (secret && m.success) {
    const gone = (await findInstallationById(deps.db, id))!;
    await sendLifecycle(deps, gone, m.data, { event: 'uninstalled', signingSecret: secret });
  }
  return { ok: true as const };
};

/**
 * POST /extensions/installations/:id/check-update — the manifest again (its URL or the catalog), the same routine
 * as the daily job (updates.ts): nothing new to consent to → updated now; a new scope, origin or feature (or
 * auto-update off) → it waits for the admin; a locked installation only reports it.
 */
export const checkForUpdate = async (deps: Deps, a: Actor, id: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  const row = await mustFind(deps.db, a.ctx.accountId, id);
  const status = await runUpdateCheck(deps, row, by(a, meta), { manual: true });
  const after = (await mustFind(deps.db, a.ctx.accountId, id))!;
  return { status, installation: dto(after, !!(await findKill(deps.db, row.key))) };
};

/** POST /extensions/installations/:id/approve-update — the admin consents to the waiting version (re-consent). */
export const approveUpdate = async (
  deps: Deps,
  a: Actor,
  id: string,
  consent: ExtensionConsent,
  meta: RequestMeta,
  expectedVersion?: string,
) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  const row = await mustFind(deps.db, a.ctx.accountId, id);
  if (!row.pendingManifest) throw new AppError('bad_request', 'no_pending_update');
  const next = parseManifest(deps.env, row.pendingManifest);
  // EXT-RT3: the daily check may have put another version in its place since the admin looked.
  if (expectedVersion !== undefined && expectedVersion !== next.version)
    throw new AppError('conflict', 'pending_update_changed', { version: next.version });
  if (await findKill(deps.db, next.id)) throw new AppError('forbidden', 'extension_killed');
  const grant = await checkConsent(deps.db, a.ctx.accountId, next, consent);
  const before = manifestOf(row.manifest);
  let creds: ServerCredentials | null = null;
  await deps.db.transaction(async (tx) => {
    const state = await installPackData(
      tx,
      { accountId: a.ctx.accountId, actorId: a.user.id, requestId: a.requestId ?? meta.requestId },
      next,
      packStateOf(row),
    );
    await updateInstallationRow(tx, id, {
      manifest: next as unknown as Record<string, unknown>,
      version: next.version,
      pendingManifest: null,
      ...grant.columns,
      consentedBy: a.user.id,
      consentedAt: new Date(),
      state: withScopeWorkspaces(state, grant.workspaceIds),
    });
    await recordVersion(tx, row, next, 'approved', a.user.id);
    // A version that brings a server (consented to just now) gets its identity here.
    if (next.server && !row.serverClientId) creds = await provisionServer(tx, deps.secrets, row, next, a.user.id);
    await audit(tx, a, meta, 'extension.update_approved', row, {
      key: row.key,
      from: row.version,
      to: next.version,
      scopes: grant.columns.grantedScopes,
      board_ids: grant.columns.boardIds,
      workspace_ids: grant.workspaceIds,
    });
  });
  forgetExtensionOrigins();
  const issued = creds as ServerCredentials | null;
  const fresh = (await mustFind(deps.db, a.ctx.accountId, id))!;
  if (issued)
    await sendLifecycle(deps, fresh, next, {
      event: 'installed',
      signingSecret: issued.signingSecret,
      credentials: issued,
      previousVersion: before.version,
    });
  else await afterVersionChange(deps, row, before.version);
  return dto((await mustFind(deps.db, a.ctx.accountId, id))!, false);
};

// ---- ת6: versions and the extension's own server ----

function by(a: Actor, meta: RequestMeta) {
  return { userId: a.user.id, requestId: a.requestId ?? meta.requestId, meta };
}

/** PATCH /extensions/installations/:id/versioning — lock on this version / automatic updates on or off. */
export const setVersioning = async (
  deps: Deps,
  a: Actor,
  id: string,
  input: { version_locked?: boolean; auto_update?: boolean },
  meta: RequestMeta,
) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  const row = await mustFind(deps.db, a.ctx.accountId, id);
  const patch: Partial<InstallationRow> = {};
  if (input.version_locked !== undefined) patch.versionLocked = input.version_locked;
  if (input.auto_update !== undefined) patch.autoUpdate = input.auto_update;
  if (Object.keys(patch).length)
    await deps.db.transaction(async (tx) => {
      await updateInstallationRow(tx, id, patch);
      await audit(tx, a, meta, 'extension.versioning', row, {
        key: row.key,
        version: row.version,
        version_locked: patch.versionLocked ?? row.versionLocked,
        auto_update: patch.autoUpdate ?? row.autoUpdate,
      });
    });
  return dto((await mustFind(deps.db, a.ctx.accountId, id))!, !!(await findKill(deps.db, row.key)));
};

/** GET /extensions/installations/:id/versions — every version this installation ran, newest first. */
export const installationVersions = async (deps: Deps, a: Actor, id: string) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  return { data: await listVersions(deps.db, await mustFind(deps.db, a.ctx.accountId, id)) };
};

/** POST /extensions/installations/:id/rollback — back to an approved version (and locked there). */
export const rollbackInstallation = async (deps: Deps, a: Actor, id: string, versionId: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  const row = await mustFind(deps.db, a.ctx.accountId, id);
  const status = await rollbackTo(deps, row, versionId, by(a, meta));
  return { status, installation: dto((await mustFind(deps.db, a.ctx.accountId, id))!, false) };
};

/**
 * POST /extensions/installations/:id/server/reconnect — new credentials (the old ones and their tokens stop) sent
 * in a fresh `installed` call: after the developer fixed their server, or when a secret may have leaked.
 */
export const reconnectServer = async (deps: Deps, a: Actor, id: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  const row = await mustFind(deps.db, a.ctx.accountId, id);
  const m = manifestOf(row.manifest);
  if (!m.server || !row.serverClientId) throw new AppError('bad_request', 'extension_has_no_server');
  if (row.status !== 'enabled' || (await findKill(deps.db, row.key)))
    throw new AppError('bad_request', 'extension_not_active');
  const status = await rotateServerCredentials(deps, row, m);
  await audit(deps.db, a, meta, 'extension.server_reconnected', row, { key: row.key, status });
  return dto((await mustFind(deps.db, a.ctx.accountId, id))!, false);
};

// ---- board views (ת2) ----

export const mayUse = (ctx: AccountContext, row: InstallationRow) => ctx.role !== 'guest' || row.allowGuests;

/** The board a list is asked for, with its workspace (an unknown id is in no scope but the whole account's). */
const scopeBoard = async (db: Db, accountId: string, boardId?: string) =>
  boardId ? ((await boardsByIds(db, accountId, [boardId]))[0] ?? { id: boardId, workspaceId: null }) : null;

/** GET /extensions/board-views?board_id= — enabled board-view features this member may add / open on the board. */
export const listBoardViews = async (deps: Deps, a: Actor, boardId?: string) => {
  const rows = await listInstallations(deps.db, a.ctx.accountId);
  const board = await scopeBoard(deps.db, a.ctx.accountId, boardId);
  const killed = await killedKeys(
    deps.db,
    rows.map((r) => r.key),
  );
  return {
    data: rows.flatMap((row) => {
      if (row.status !== 'enabled' || killed.has(row.key) || !mayUse(a.ctx, row)) return [];
      if (board && !inScope(row, board)) return [];
      const m = extensionManifestSchema.safeParse(row.manifest);
      if (!m.success) return [];
      return m.data.features
        .flatMap((f) => (f.type === 'board_view' ? [f] : []))
        .map((f) => ({
          installation_id: row.id,
          extension_key: row.key,
          extension_name: m.data.name,
          icon: m.data.icon ?? null,
          feature: f.key,
          name: f.name,
          name_en: f.name_en ?? null,
          url: f.url,
          origin: new URL(f.url).origin,
          ...(f.offline ? { offline: true } : {}),
        }));
    }),
  };
};

/** A framed feature as the web lists it (one shape for every slot). */
const frameEntry = (row: InstallationRow, m: ExtensionManifest, f: FrameFeature): ExtensionFrameFeature => ({
  installation_id: row.id,
  extension_key: row.key,
  extension_name: m.name,
  icon: m.icon ?? null,
  feature: f.key,
  type: f.type,
  name: f.name,
  name_en: f.name_en ?? null,
  url: f.url,
  origin: new URL(f.url).origin,
  contexts: f.type === 'board_menu_action' ? f.contexts : null,
  modal: f.type === 'board_menu_action' || f.type === 'batch_action' ? f.modal : null,
  default_size: f.type === 'dashboard_widget' ? f.default_size : null,
  ...(f.type === 'app_page' ? { page_icon: f.icon ?? null } : {}),
});

/**
 * GET /extensions/features?board_id=&type= — the framed features of enabled, not-killed installations this member
 * may open (guests only where allowed): on a board only where the installation is allowed; settings pages to
 * admins only.
 */
export const listFrameFeatures = async (
  deps: Deps,
  a: Actor,
  q: { board_id?: string; workspace_id?: string; type?: string },
) => {
  const rows = await listInstallations(deps.db, a.ctx.accountId);
  const board = await scopeBoard(deps.db, a.ctx.accountId, q.board_id);
  // A dashboard's workspace: a widget is offered there when the installation works on the whole workspace or on
  // one of its boards.
  const wsBoards = q.workspace_id
    ? (await listBoardsInWorkspaces(deps.db, a.ctx.accountId, [q.workspace_id])).map((b) => b.id)
    : [];
  const killed = await killedKeys(
    deps.db,
    rows.map((r) => r.key),
  );
  const admin = isAccountAdmin(a.ctx);
  return {
    data: rows.flatMap((row) => {
      if (row.status !== 'enabled' || killed.has(row.key) || !mayUse(a.ctx, row)) return [];
      const m = extensionManifestSchema.safeParse(row.manifest);
      if (!m.success) return [];
      return m.data.features.flatMap((f) => {
        if (!isFrameFeature(f) || (q.type && f.type !== q.type)) return [];
        if (f.type === 'account_settings_page' && !admin) return [];
        // a member's own page (in their profile) is for every member the installation reaches; so is a
        // page in the sidebar.
        const onBoards =
          f.type !== 'dashboard_widget' &&
          f.type !== 'account_settings_page' &&
          f.type !== 'user_settings_page' &&
          f.type !== 'panel' &&
          f.type !== 'app_page';
        if (onBoards && board && !inScope(row, board)) return [];
        if (
          f.type === 'dashboard_widget' &&
          q.workspace_id &&
          !inScope(row, { id: '', workspaceId: q.workspace_id }) &&
          !wsBoards.some((id) => row.boardIds?.includes(id))
        )
          return [];
        return [frameEntry(row, m.data, f)];
      });
    }),
  };
};

/** Token mints per user × installation per minute (a frame asks again only when its token is about to expire). */
const mintLimiter = new RateLimiter(60, 60_000);

/**
 * A dashboard widget's boards (ת5): the widget's chosen boards of its dashboard (all the dashboard's when none),
 * only those the viewer reads, only top-level boards, only those the installation is allowed on.
 */
const widgetBoards = async (
  deps: Deps,
  a: Actor,
  row: InstallationRow,
  feature: string,
  dashboardId?: string,
  widgetId?: string,
) => {
  if (!dashboardId || !widgetId) throw new AppError('bad_request', 'widget_required');
  const access = await loadDashboardAccess(deps.db, a.ctx, a.user, dashboardId);
  const w = await findWidget(deps.db, a.ctx.accountId, widgetId);
  const s = w ? extensionWidgetSettingsSchema.safeParse(w.settings) : null;
  if (
    !w ||
    w.dashboardId !== dashboardId ||
    w.type !== 'extension' ||
    !s?.success ||
    s.data.installation_id !== row.id ||
    s.data.feature !== feature
  )
    throw new AppError('not_found', 'Widget not found');
  const dash = dashboardSettingsOf(access.dashboard).board_ids;
  const chosen = s.data.board_ids.filter((id) => dash.includes(id));
  const ids = chosen.length ? chosen : dash;
  const readable = await readableBoardIds(deps.db, a.ctx, a.user, ids);
  const top = new Map(
    (await boardsByIds(deps.db, a.ctx.accountId, [...readable])).filter((b) => !b.parentBoardId).map((b) => [b.id, b]),
  );
  return ids.filter((id) => top.has(id) && inScope(row, top.get(id)!));
};

/** The most boards a panel token names (its claims travel with every request). */
const PANEL_BOARDS_MAX = 200;

/**
 * A panel's boards: the installation's top-level boards (its chosen boards and workspaces, or the
 * whole account) that this person reads — never more. The page then looks items up on them itself.
 */
const panelBoards = async (deps: Deps, a: Actor, row: InstallationRow) => {
  const ws = scopeWorkspaceIds(row);
  const candidates = scopeIsAll(row)
    ? await listAccountBoards(deps.db, a.ctx.accountId)
    : [
        ...(row.boardIds?.length ? await boardsByIds(deps.db, a.ctx.accountId, row.boardIds) : []),
        ...(ws ? await listBoardsInWorkspaces(deps.db, a.ctx.accountId, ws) : []),
      ];
  const ids = [...new Set(candidates.filter((b) => !b.parentBoardId).map((b) => b.id))];
  const readable = await readableBoardIds(deps.db, a.ctx, a.user, ids);
  return ids.filter((id) => readable.has(id)).slice(0, PANEL_BOARDS_MAX);
};

/**
 * A board view's extra boards: the tab's `settings.extension.board_ids` — the tab must be this
 * feature's view on this board — only those this viewer reads, only top-level boards, only those the installation is
 * allowed on. A person picks them in the app's own dialog; the extension never names them itself.
 */
const viewBoards = async (
  deps: Deps,
  a: Actor,
  row: InstallationRow,
  feature: string,
  board: string,
  viewId: string,
) => {
  const view = await findView(deps.db, a.ctx.accountId, viewId);
  if (!view || view.boardId !== board || view.type !== 'extension') throw new AppError('not_found', 'View not found');
  if (view.visibility === 'private' && view.createdBy !== a.user.id) throw new AppError('not_found', 'View not found');
  const s = viewSettingsSchema.safeParse(view.settings);
  const ext = s.success ? s.data.extension : undefined;
  if (!ext || ext.installation_id !== row.id || ext.feature !== feature)
    throw new AppError('not_found', 'View not found');
  const wanted = [...new Set(ext.board_ids ?? [])].filter((id) => id !== board);
  if (!wanted.length) return [];
  const readable = await readableBoardIds(deps.db, a.ctx, a.user, wanted);
  const top = new Map(
    (await boardsByIds(deps.db, a.ctx.accountId, [...readable])).filter((b) => !b.parentBoardId).map((b) => [b.id, b]),
  );
  return wanted.filter((id) => top.has(id) && inScope(row, top.get(id)!));
};

/**
 * POST /extensions/installations/:id/token — a token for one feature where it is shown, minutes long, scoped to the
 * granted scopes:
 * - on a board (board view, item tab, menu / batch action): the board must be one the installation is allowed on
 *   **and** one this user can read; a board view's tab (`view_id`) adds the boards picked for it (`viewBoards`);
 * - a dashboard widget: the widget's boards this viewer reads (never more — ת5);
 * - the settings page: admins only, no board content at all;
 * a member's own page: any member the installation reaches, no board content at all
 * a panel or a page in the sidebar: the installation's top-level boards this
 *   member reads (`panelBoards`), so the page reads and writes items there with the member's own rights.
 */
export const mintToken = async (
  deps: Deps,
  a: Actor,
  id: string,
  input: { feature: string; board_id?: string; view_id?: string; dashboard_id?: string; widget_id?: string },
) => {
  const live = await liveInstallation(deps.db, id, a.ctx.accountId);
  if (!live || !mayUse(a.ctx, live.row)) throw new AppError('not_found', 'Extension not found');
  const feature = live.manifest.features.find((f) => f.key === input.feature);
  if (!feature || !isFrameFeature(feature)) throw new AppError('not_found', 'Extension feature not found');
  let board = '';
  let boards: string[] | undefined;
  if (feature.type === 'dashboard_widget')
    boards = await widgetBoards(deps, a, live.row, feature.key, input.dashboard_id, input.widget_id);
  else if (feature.type === 'account_settings_page') {
    assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
    boards = [];
  } else if (feature.type === 'user_settings_page') {
    // the member's own page — no board content; the token names who they are (`u`).
    boards = [];
  } else if (feature.type === 'panel' || feature.type === 'app_page')
    // a page in the sidebar works on items like a panel does — the member's own boards, never more.
    boards = await panelBoards(deps, a, live.row);
  else {
    if (!input.board_id) throw new AppError('bad_request', 'board_required');
    if (!(await boardInScope(deps.db, live.row, input.board_id)))
      throw new AppError('forbidden', 'extension_not_on_board');
    const access = await loadBoardAccess(deps.db, a.ctx, a.user, input.board_id);
    if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
    board = input.board_id;
    if (feature.type === 'board_view' && input.view_id) {
      const extra = await viewBoards(deps, a, live.row, feature.key, board, input.view_id);
      if (extra.length) boards = [board, ...extra];
    }
  }
  const wait = mintLimiter.hit(`${a.user.id}:${id}`);
  if (wait > 0) throw new AppError('rate_limited', 'Too many tokens for this extension', { retry_after_ms: wait });
  const origin = featureOrigin(feature)!;
  const claims = newClaims({
    i: live.row.id,
    a: a.ctx.accountId,
    u: a.user.id,
    b: board,
    ...(boards ? { bs: boards } : {}),
    f: feature.key,
    s: live.row.grantedScopes,
    o: origin,
  });
  return {
    token: signExtToken(deps.env, claims),
    expires_at: new Date(claims.e * 1000).toISOString(),
    scopes: claims.s,
    board_id: claims.b,
    board_ids: boards ?? [board],
    origin,
    api_base: '/api/v1',
  };
};

// ---- signing secret (ת4) ----

/** GET /extensions/installations/:id/secret — admins: the secret its server checks our calls with. Audited. */
export const revealSecret = async (deps: Deps, a: Actor, id: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  const row = await mustFind(deps.db, a.ctx.accountId, id);
  const secret = await signingSecretOf(deps, row);
  await audit(deps.db, a, meta, 'extension.secret_viewed', row, { key: row.key });
  return { secret, installation_id: row.id };
};

/** POST /extensions/installations/:id/secret/rotate — admins: a new secret; the old one stops at once. */
export const rotateSecret = async (deps: Deps, a: Actor, id: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  const row = await mustFind(deps.db, a.ctx.accountId, id);
  const m = manifestOf(row.manifest);
  let secret: string;
  if (m.server && row.serverClientId) {
    // ת6: the secret came to its server with the credentials — rotate them together and send `installed` again,
    // so the server learns the new secret (otherwise our next call would fail its check).
    await rotateServerCredentials(deps, row, m);
    secret = storedSigningSecret(deps.secrets, (await mustFind(deps.db, a.ctx.accountId, id))!)!;
  } else secret = await rotateSigningSecret(deps, row);
  await audit(deps.db, a, meta, 'extension.secret_rotated', row, { key: row.key });
  return { secret, installation_id: row.id };
};

// ---- automation blocks (ת4) ----

/**
 * GET /extensions/automation-blocks?board_id= — the actions and triggers of enabled, not-killed installations
 * allowed on the board, with their forms (the builder offers them by name).
 */
export const listAutomationBlocks = async (deps: Deps, a: Actor, boardId?: string) => {
  const rows = await listInstallations(deps.db, a.ctx.accountId);
  const killed = await killedKeys(
    deps.db,
    rows.map((r) => r.key),
  );
  const board = await scopeBoard(deps.db, a.ctx.accountId, boardId);
  const actions: ReturnType<typeof actionBlock>[] = [];
  const triggers: ReturnType<typeof triggerBlock>[] = [];
  for (const row of rows) {
    if (row.status !== 'enabled' || killed.has(row.key) || !mayUse(a.ctx, row)) continue;
    if (board && !inScope(row, board)) continue;
    const m = extensionManifestSchema.safeParse(row.manifest);
    if (!m.success) continue;
    for (const f of m.data.features) {
      if (f.type === 'automation_action') actions.push(actionBlock(row, m.data, f));
      if (f.type === 'automation_trigger') triggers.push(triggerBlock(row, m.data, f));
    }
  }
  return { actions, triggers };
};

type Feature = ExtensionManifest['features'][number];
const actionBlock = (
  row: InstallationRow,
  m: ExtensionManifest,
  f: Extract<Feature, { type: 'automation_action' }>,
) => ({
  block: blockKey(row.key, f.key),
  extension_name: m.name,
  icon: m.icon ?? null,
  name: f.name,
  name_en: f.name_en ?? null,
  description: f.description ?? null,
  inputs: f.inputs.map((i) => ({
    key: i.key,
    label: i.label,
    label_en: i.label_en ?? null,
    type: i.type,
    required: i.required,
    options: i.options ?? null,
    column_types: i.column_types ?? null,
    placeholder: i.placeholder ?? null,
  })),
});
const triggerBlock = (
  row: InstallationRow,
  m: ExtensionManifest,
  f: Extract<Feature, { type: 'automation_trigger' }>,
) => ({
  block: blockKey(row.key, f.key),
  extension_name: m.name,
  icon: m.icon ?? null,
  name: f.name,
  name_en: f.name_en ?? null,
  description: f.description ?? null,
  payload_fields: f.payload_fields,
  inputs: f.inputs.map((i) => ({
    key: i.key,
    label: i.label,
    label_en: i.label_en ?? null,
    type: i.type,
    placeholder: i.placeholder ?? null,
  })),
});

// ---- agent templates from installed packs (D26 × D27) ----

/** Agent templates of this account's enabled packs (the agents' "starter agents" picker merges them in). */
export const packAgentTemplates = async (db: Db, accountId: string): Promise<Record<string, unknown>[]> => {
  const rows = await listInstallations(db, accountId);
  const killed = await killedKeys(
    db,
    rows.map((r) => r.key),
  );
  return rows.flatMap((row) => {
    if (row.status !== 'enabled' || killed.has(row.key)) return [];
    const m = extensionManifestSchema.safeParse(row.manifest);
    return m.success ? (m.data.data?.agent_templates ?? []) : [];
  });
};
