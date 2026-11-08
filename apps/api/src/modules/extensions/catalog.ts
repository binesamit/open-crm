// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import {
  AppError,
  type CatalogReview,
  type CatalogSource,
  type ExtensionManifest,
  extensionKind,
  extensionManifestSchema,
  isLocalOrigin,
  newId,
  REVIEW_CHECKS,
  reviewComplete,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { extensionInstallations, users } from '../../db/schema';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import { forgetExtensionOrigins } from './ext-origins';
import { findCatalogEntry, findKill, insertExtension, listCatalog, updateExtensionRow } from './extensions.repo';
import { resolveSource } from './manifest-source';

/**
 * The platform catalog (D27 ת7, MARKETPLACE §4.6): the platform owner publishes an extension "for every account" —
 * accounts still install it themselves, through the same consent screen. A code extension enters only with the
 * §8 security review fully ticked (kept with the entry, shown in the owner console); a data pack runs no code, so
 * its review is optional. Republishing a key replaces the entry (installations pick the new version up through
 * their update check — with consent if it asks for more). Unpublishing hides it from the catalog; installations
 * keep the version they approved. The emergency kill switch stays the way to stop one everywhere.
 */
type Deps = Pick<AppDeps, 'db' | 'env'>;

const warningsOf = (m: ExtensionManifest) => {
  const w: string[] = [];
  if (extensionKind(m) === 'code') w.push('runs_code');
  if (m.origins.some(isLocalOrigin)) w.push('local_origin');
  if (m.origins.some((o) => !o.startsWith('https://'))) w.push('not_https');
  if (m.server) w.push('has_server');
  if (m.permissions.some((s) => s.endsWith(':write') || s === 'webhooks')) w.push('can_write');
  return w;
};

const resolveCatalogSource = async (deps: Deps, source: CatalogSource) => {
  const r = await resolveSource(deps, source);
  return { manifest: r.manifest, sourceUrl: r.sourceUrl };
};

/** POST /platform/extensions/catalog/preview — what would be published (and what it replaces). */
export const previewCatalog = async (deps: Deps, source: CatalogSource) => {
  const { manifest } = await resolveCatalogSource(deps, source);
  const existing = await findCatalogEntry(deps.db, manifest.id);
  return {
    manifest,
    kind: extensionKind(manifest),
    warnings: warningsOf(manifest),
    existing: existing ? { version: existing.version } : null,
    review_required: extensionKind(manifest) === 'code',
  };
};

/** POST /platform/extensions/catalog — publish (or republish) with the §8 review. */
export const publishCatalog = async (
  deps: Deps,
  owner: SessionUser,
  input: { source: CatalogSource; review: CatalogReview },
  meta: RequestMeta,
) => {
  const { manifest: m, sourceUrl } = await resolveCatalogSource(deps, input.source);
  const kind = extensionKind(m);
  if (kind === 'code' && !reviewComplete(input.review))
    throw new AppError('invalid_value', 'review_incomplete', {
      missing: REVIEW_CHECKS.filter((k) => !input.review.checks[k]),
    });
  // Development origins pass only outside production (manifest-source refuses them there) — with a warning.
  if (await findKill(deps.db, m.id)) throw new AppError('forbidden', 'extension_killed');
  const now = new Date();
  const review = {
    checks: Object.fromEntries(REVIEW_CHECKS.map((k) => [k, !!input.review.checks[k]])),
    notes: input.review.notes,
    privacy_url: input.review.privacy_url ?? null,
    reviewed_by: owner.id,
    reviewed_at: now.toISOString(),
  };
  const fields = {
    name: m.name,
    version: m.version,
    kind,
    manifest: m as unknown as Record<string, unknown>,
    sourceUrl,
    review,
    publishedBy: owner.id,
    publishedAt: now,
  };
  const existing = await findCatalogEntry(deps.db, m.id);
  await deps.db.transaction(async (tx) => {
    if (existing) await updateExtensionRow(tx, existing.id, fields);
    else await insertExtension(tx, { id: newId(), accountId: null, key: m.id, createdBy: owner.id, ...fields });
    await auditInstalls(tx, m.id, owner, 'extension.catalog_published', { version: m.version }, meta);
  });
  forgetExtensionOrigins();
  return { ok: true as const };
};

/** DELETE /platform/extensions/catalog/:key — out of the catalog (installed copies keep their approved version). */
export const unpublishCatalog = async (deps: Deps, owner: SessionUser, key: string, meta: RequestMeta) => {
  const existing = await findCatalogEntry(deps.db, key);
  if (!existing) throw new AppError('not_found', 'Extension not found');
  await deps.db.transaction(async (tx) => {
    await updateExtensionRow(tx, existing.id, { deletedAt: new Date() });
    await auditInstalls(tx, key, owner, 'extension.catalog_unpublished', { version: existing.version }, meta);
  });
  return { ok: true as const };
};

/** Accounts that have the key installed see catalog changes in their audit log (who, which version). */
/** Audits a platform-owner action on every live installation of a key (the owner console; duplication #7). */
export const auditInstalls = async (
  db: Db,
  key: string,
  owner: SessionUser,
  action: string,
  payload: Record<string, unknown>,
  meta: RequestMeta,
) => {
  const rows = await db
    .select({ id: extensionInstallations.id, accountId: extensionInstallations.accountId })
    .from(extensionInstallations)
    .where(and(eq(extensionInstallations.key, key), isNull(extensionInstallations.uninstalledAt)));
  for (const r of rows)
    await recordAudit(db, {
      accountId: r.accountId,
      actorId: owner.id,
      action,
      targetType: 'extension',
      targetId: r.id,
      payload: { key, ...payload, via: 'platform_owner' },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
};

/** The catalog entries' publishing details (the owner console list). */
export const catalogEntries = async (db: Db) => {
  const rows = await listCatalog(db);
  const reviewers = new Map<string, string>();
  for (const r of rows) {
    const id = (r.review as { reviewed_by?: string } | null)?.reviewed_by;
    if (id && !reviewers.has(id)) {
      const u = (
        await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, id)).limit(1)
      )[0];
      reviewers.set(id, u?.name || u?.email || '');
    }
  }
  return new Map(
    rows.map((r) => {
      const review = r.review as {
        checks?: Record<string, boolean>;
        notes?: string;
        privacy_url?: string | null;
        reviewed_by?: string;
        reviewed_at?: string;
      } | null;
      const m = extensionManifestSchema.safeParse(r.manifest);
      return [
        r.key,
        {
          version: m.success ? m.data.version : r.version,
          source_url: r.sourceUrl ?? null,
          review: review
            ? {
                checks: review.checks ?? {},
                notes: review.notes ?? '',
                privacy_url: review.privacy_url ?? null,
                reviewed_by_name: review.reviewed_by ? (reviewers.get(review.reviewed_by) ?? null) : null,
                reviewed_at: review.reviewed_at ?? r.updatedAt.toISOString(),
              }
            : null,
          published_at: r.publishedAt?.toISOString() ?? null,
        },
      ] as const;
    }),
  );
};
