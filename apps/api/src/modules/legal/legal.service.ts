// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  AppError,
  LEGAL_PLACEHOLDERS,
  OPTIONAL_LEGAL_PLACEHOLDERS,
  type SubProcessorsList,
  isSafeDocHref,
  markdownToDocHtml,
  newId,
  resolvePublicAddress,
  type LegalAcceptance,
  type LegalDocAdmin,
  type LegalDocSummary,
  type LegalDocView,
  type LegalList,
  type LegalLocale,
  type LegalVersion,
  type BillingSettings,
  type PlatformSettings,
  type UpdateLegalDoc,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { legalConsents, legalDocumentVersions, legalDocuments, users, type LegalTextsJson } from '../../db/schema';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { loadBillingSettings } from '../billing/billing-settings';
import { listPublicPlans } from '../billing/plans.service';
import { loadPlatformSettings, productName } from '../platform/platform-settings';
import { LEGAL_DEFAULTS } from './legal.defaults';

/**
 * Legal documents. The platform ships default drafts (marked "for legal review") that are seeded and
 * published once, the first time anything reads the documents; from then on the owner console owns them. Nothing
 * here names an operator: `{{company_name}}` … come from platform settings → `legal` at render time.
 */
type Deps = Pick<AppDeps, 'db' | 'env'>;
type DocRow = typeof legalDocuments.$inferSelect;

const seeded = new WeakSet<object>();
/** Tests: as after a restart — the next read checks the defaults again. */
export const resetLegalSeed = (db: object) => seeded.delete(db);

export const ensureLegalDefaults = async (db: Db) => {
  if (seeded.has(db)) return;
  // Every default the platform does not have yet — a new platform gets them all; an existing one gets a default added
  // later (the accessibility statement). Built-in documents cannot be deleted, so nothing the owner
  // removed comes back; one they edited is never touched. A `publish: false` default lands as a draft only (the owner
  // publishes it from the console once its details are filled).
  const have = new Set((await db.select({ slug: legalDocuments.slug }).from(legalDocuments)).map((r) => r.slug));
  const missing = LEGAL_DEFAULTS.map((d, i) => ({ d, i })).filter(({ d }) => !have.has(d.slug));
  if (missing.length) {
    await db.transaction(async (tx) => {
      for (const { d, i } of missing) {
        const id = newId();
        const inserted = await tx
          .insert(legalDocuments)
          .values({
            id,
            slug: d.slug,
            sortOrder: i * 10,
            requiresConsent: d.requiresConsent,
            purchaseConsent: d.purchaseConsent ?? false,
            draft: d.texts,
            publishedVersion: d.publish === false ? null : 1,
          })
          .onConflictDoNothing()
          .returning({ id: legalDocuments.id });
        if (inserted.length && d.publish !== false)
          await tx.insert(legalDocumentVersions).values({ id: newId(), documentId: id, version: 1, texts: d.texts });
      }
    });
  }
  seeded.add(db);
};

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const publishedRows = async (db: Db) =>
  db
    .select({ doc: legalDocuments, ver: legalDocumentVersions })
    .from(legalDocuments)
    .innerJoin(
      legalDocumentVersions,
      and(
        eq(legalDocumentVersions.documentId, legalDocuments.id),
        eq(legalDocumentVersions.version, legalDocuments.publishedVersion),
      ),
    )
    .orderBy(asc(legalDocuments.sortOrder), asc(legalDocuments.slug));

const summary = (doc: DocRow, ver: typeof legalDocumentVersions.$inferSelect): LegalDocSummary => ({
  slug: doc.slug,
  title: { he: ver.texts.title.he, en: ver.texts.title.en },
  version: ver.version,
  published_at: ver.publishedAt.toISOString(),
  requires_consent: doc.requiresConsent,
  purchase_consent: doc.purchaseConsent,
});

const labelOrNull = (t: { he?: string; en?: string }) => {
  const he = t.he?.trim() || '';
  const en = t.en?.trim() || '';
  return he || en ? { he: he || en, en: en || he } : null;
};

/** GET /legal: every published document (public), the DPO and whether a sub-processors list is published. */
export const listLegalDocs = async ({ db }: Deps): Promise<LegalList> => {
  await ensureLegalDefaults(db);
  const legal = (await loadPlatformSettings(db)).legal;
  return {
    data: (await publishedRows(db)).map((r) => summary(r.doc, r.ver)),
    consent_checkbox: !!legal.consent_checkbox,
    dpo: legal.dpo_name ? { name: legal.dpo_name, email: legal.dpo_email ?? null } : null,
    sub_processors: legal.sub_processors.length > 0,
    collection_notice: {
      he: legal.collection_notice.he?.trim() || null,
      en: legal.collection_notice.en?.trim() || null,
    },
    marketing_opt_in: labelOrNull(legal.marketing_opt_in),
  };
};

/** GET /legal/sub-processors (public): the services that process personal data on the operator's behalf. */
export const listSubProcessors = async ({ db }: Deps): Promise<SubProcessorsList> => ({
  data: (await loadPlatformSettings(db)).legal.sub_processors,
});

const dateIn = (d: Date, locale: LegalLocale) =>
  new Intl.DateTimeFormat(locale === 'he' ? 'he-IL' : 'en-GB', {
    dateStyle: 'long',
    timeZone: 'Asia/Jerusalem',
  }).format(d);

/** Fills `{{placeholder}}` from platform settings; an empty setting stays visible as `[name]` so the owner notices. */
export const fillLegalPlaceholders = (
  text: string,
  settings: PlatformSettings,
  ctx: { locale: LegalLocale; siteUrl: string; lastUpdated: Date; billing?: BillingSettings; currency?: string },
) => {
  const {
    consent_checkbox: _style,
    sub_processors: _list,
    collection_notice: _notice,
    marketing_opt_in: _optIn,
    ...details
  } = settings.legal;
  const b = ctx.billing;
  const values: Record<string, string | undefined> = {
    ...details,
    product_name: productName(settings, ctx.locale),
    site_url: ctx.siteUrl,
    last_updated: dateIn(ctx.lastUpdated, ctx.locale),
    // The cancellation rules: the same numbers the cancel screen computes with.
    ...(b
      ? {
          cooling_off_days: String(b.cooling_off_days),
          cancel_fee_pct: String(b.cancel_fee_pct),
          cancel_fee_cap:
            b.cancel_fee_cap === null
              ? undefined
              : new Intl.NumberFormat(ctx.locale === 'he' ? 'he-IL' : 'en-GB', {
                  style: 'currency',
                  currency: ctx.currency ?? 'ILS',
                  maximumFractionDigits: 2,
                }).format(b.cancel_fee_cap),
          renewal_reminder_days: b.renewal_reminder_days === null ? undefined : String(b.renewal_reminder_days),
          change_notice_days: String(b.change_notice_days),
        }
      : {}),
  };
  return text.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, key: string) => {
    if (!(LEGAL_PLACEHOLDERS as readonly string[]).includes(key)) return all;
    const v = values[key]?.trim();
    // An optional detail (no DPO named) is simply absent — not a `[marker]` the public would see.
    if (!v && (OPTIONAL_LEGAL_PLACEHOLDERS as readonly string[]).includes(key)) return '';
    return v || `[${key}]`;
  });
};

/** In-page anchors, safe absolute links and the platform's own paths (`/legal/privacy`); anything else is text. */
const linkFor = (href: string) => (isSafeDocHref(href) || /^\/[a-z0-9/_-]*$/i.test(href.trim()) ? href.trim() : null);

/** GET /legal/{slug}: a published version rendered to safe HTML (older versions: owner only). */
export const viewLegalDoc = async (
  { db, env }: Deps,
  slug: string,
  opts: { locale: LegalLocale; version?: number; owner: boolean },
): Promise<LegalDocView> => {
  await ensureLegalDefaults(db);
  const doc = (await db.select().from(legalDocuments).where(eq(legalDocuments.slug, slug)).limit(1))[0];
  if (!doc?.publishedVersion) throw new AppError('not_found', 'Document not found');
  const wanted = opts.version && opts.owner ? opts.version : doc.publishedVersion;
  const ver = (
    await db
      .select()
      .from(legalDocumentVersions)
      .where(and(eq(legalDocumentVersions.documentId, doc.id), eq(legalDocumentVersions.version, wanted)))
      .limit(1)
  )[0];
  if (!ver) throw new AppError('not_found', 'Version not found');
  const settings = await loadPlatformSettings(db);
  const siteUrl = resolvePublicAddress(settings.public_address, env).web;
  const billing = await loadBillingSettings(db);
  const currency = (await listPublicPlans(db)).data[0]?.currency;
  const fill = (s: string) =>
    fillLegalPlaceholders(s, settings, {
      locale: opts.locale,
      siteUrl,
      lastUpdated: ver.publishedAt,
      billing,
      ...(currency ? { currency } : {}),
    });
  const rendered = markdownToDocHtml(fill(ver.texts.body[opts.locale]), { linkFor });
  return {
    slug: doc.slug,
    locale: opts.locale,
    title: fill(ver.texts.title[opts.locale]),
    html: rendered.html,
    headings: rendered.headings,
    version: ver.version,
    published_at: ver.publishedAt.toISOString(),
    requires_consent: doc.requiresConsent,
    documents: (await publishedRows(db)).map((r) => summary(r.doc, r.ver)),
  };
};

// ------------------------------------------------------------------------------------------------ owner console

const sameTexts = (a: LegalTextsJson, b: LegalTextsJson | undefined) => !!b && JSON.stringify(a) === JSON.stringify(b);

const findDoc = async (db: Db, slug: string) => {
  // A built-in document may be edited before anything read the list (the defaults are seeded on first use).
  await ensureLegalDefaults(db);
  const doc = (await db.select().from(legalDocuments).where(eq(legalDocuments.slug, slug)).limit(1))[0];
  if (!doc) throw new AppError('not_found', 'Document not found');
  return doc;
};

const consentCounts = async (db: Db) => {
  const rows = await db
    .select({ documentId: legalConsents.documentId, version: legalConsents.version, n: count() })
    .from(legalConsents)
    .groupBy(legalConsents.documentId, legalConsents.version);
  return new Map(rows.map((r) => [`${r.documentId}:${r.version}`, Number(r.n)]));
};

const toAdmin = async (db: Db, doc: DocRow, counts?: Map<string, number>): Promise<LegalDocAdmin> => {
  const ver = doc.publishedVersion
    ? (
        await db
          .select()
          .from(legalDocumentVersions)
          .where(
            and(eq(legalDocumentVersions.documentId, doc.id), eq(legalDocumentVersions.version, doc.publishedVersion)),
          )
          .limit(1)
      )[0]
    : undefined;
  const c = counts ?? (await consentCounts(db));
  return {
    id: doc.id,
    slug: doc.slug,
    sort_order: doc.sortOrder,
    requires_consent: doc.requiresConsent,
    purchase_consent: doc.purchaseConsent,
    draft: doc.draft,
    draft_changed: !sameTexts(doc.draft, ver?.texts),
    published_version: doc.publishedVersion,
    published_at: iso(ver?.publishedAt),
    consents: doc.publishedVersion ? (c.get(`${doc.id}:${doc.publishedVersion}`) ?? 0) : 0,
    updated_at: doc.updatedAt.toISOString(),
  };
};

export const adminListLegalDocs = async ({ db }: Deps): Promise<LegalDocAdmin[]> => {
  await ensureLegalDefaults(db);
  const docs = await db.select().from(legalDocuments).orderBy(asc(legalDocuments.sortOrder), asc(legalDocuments.slug));
  const counts = await consentCounts(db);
  return Promise.all(docs.map((d) => toAdmin(db, d, counts)));
};

export const createLegalDoc = async (
  { db }: Deps,
  owner: SessionUser,
  input: { slug: string; title: { he: string; en: string } },
): Promise<LegalDocAdmin> => {
  await ensureLegalDefaults(db);
  const max =
    (await db.select({ max: sql<number>`coalesce(max(${legalDocuments.sortOrder}), 0)` }).from(legalDocuments))[0]
      ?.max ?? 0;
  const rows = await db
    .insert(legalDocuments)
    .values({
      id: newId(),
      slug: input.slug,
      sortOrder: Number(max) + 10,
      draft: { title: input.title, body: { he: '', en: '' } },
      updatedBy: owner.id,
    })
    .onConflictDoNothing()
    .returning();
  if (!rows[0]) throw new AppError('slug_taken', 'A document with this address already exists');
  return toAdmin(db, rows[0]);
};

export const updateLegalDoc = async ({ db }: Deps, owner: SessionUser, slug: string, patch: UpdateLegalDoc) => {
  const doc = await findDoc(db, slug);
  const draft: LegalTextsJson = {
    title: { ...doc.draft.title, ...stripUndefined(patch.draft?.title) },
    body: { ...doc.draft.body, ...stripUndefined(patch.draft?.body) },
  };
  const [row] = await db
    .update(legalDocuments)
    .set({
      draft,
      ...(patch.requires_consent !== undefined ? { requiresConsent: patch.requires_consent } : {}),
      ...(patch.purchase_consent !== undefined ? { purchaseConsent: patch.purchase_consent } : {}),
      ...(patch.sort_order !== undefined ? { sortOrder: patch.sort_order } : {}),
      updatedBy: owner.id,
      updatedAt: new Date(),
    })
    .where(eq(legalDocuments.id, doc.id))
    .returning();
  return toAdmin(db, row!);
};

const stripUndefined = <T extends Record<string, unknown>>(o: T | undefined) =>
  Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * Publishes the draft as the next version (both languages need a title and a body). A minor version (
 * wording, a typo) does not ask people to accept again; the first version is always material.
 */
export const publishLegalDoc = async (
  { db }: Deps,
  owner: SessionUser,
  slug: string,
  opts: { material?: boolean } = {},
) => {
  const doc = await findDoc(db, slug);
  for (const l of ['he', 'en'] as const) {
    if (!doc.draft.title[l]?.trim() || !doc.draft.body[l]?.trim())
      throw new AppError('validation_failed', 'Both languages need a title and a text', { locale: l });
  }
  const version = (doc.publishedVersion ?? 0) + 1;
  await db.transaction(async (tx) => {
    await tx.insert(legalDocumentVersions).values({
      id: newId(),
      documentId: doc.id,
      version,
      texts: doc.draft,
      publishedBy: owner.id,
      material: version === 1 || opts.material !== false,
    });
    await tx
      .update(legalDocuments)
      .set({ publishedVersion: version, updatedBy: owner.id, updatedAt: new Date() })
      .where(eq(legalDocuments.id, doc.id));
  });
  return toAdmin(db, await findDoc(db, slug));
};

export const listLegalVersions = async ({ db }: Deps, slug: string): Promise<LegalVersion[]> => {
  const doc = await findDoc(db, slug);
  const counts = await consentCounts(db);
  const rows = await db
    .select()
    .from(legalDocumentVersions)
    .where(eq(legalDocumentVersions.documentId, doc.id))
    .orderBy(sql`${legalDocumentVersions.version} desc`);
  return rows.map((v) => ({
    version: v.version,
    title: { he: v.texts.title.he, en: v.texts.title.en },
    published_at: v.publishedAt.toISOString(),
    published_by: v.publishedBy,
    consents: counts.get(`${doc.id}:${v.version}`) ?? 0,
    material: v.material,
  }));
};

/** Copies an older version back into the draft (publish it to make it current again). */
export const restoreLegalVersion = async ({ db }: Deps, owner: SessionUser, slug: string, version: number) => {
  const doc = await findDoc(db, slug);
  const ver = (
    await db
      .select()
      .from(legalDocumentVersions)
      .where(and(eq(legalDocumentVersions.documentId, doc.id), eq(legalDocumentVersions.version, version)))
      .limit(1)
  )[0];
  if (!ver) throw new AppError('not_found', 'Version not found');
  const [row] = await db
    .update(legalDocuments)
    .set({ draft: ver.texts, updatedBy: owner.id, updatedAt: new Date() })
    .where(eq(legalDocuments.id, doc.id))
    .returning();
  return toAdmin(db, row!);
};

/** Removes a document the owner added (the documents the platform ships stay — they can be edited, not deleted). */
export const deleteLegalDoc = async ({ db }: Deps, slug: string) => {
  const doc = await findDoc(db, slug);
  if (LEGAL_DEFAULTS.some((d) => d.slug === doc.slug))
    throw new AppError('conflict', 'A built-in document can be edited but not deleted');
  await db.delete(legalDocuments).where(eq(legalDocuments.id, doc.id));
};

// ------------------------------------------------------------------------------------------------ consent

/**
 * GET /me/legal: newer versions of the "requires consent" documents than this person already agreed to. The baseline
 * is the highest of: a version they accepted, the version that was current when they joined (joining agrees to it —
 * the sign-up screen says so), and — for people who were here before a document's first version — version 1.
 * So only a version the owner publishes later asks everyone again.
 */
export const myPendingLegal = async ({ db }: Deps, user: SessionUser): Promise<LegalDocSummary[]> => {
  await ensureLegalDefaults(db);
  const required = (await publishedRows(db)).filter((r) => r.doc.requiresConsent);
  if (!required.length) return [];
  const ids = required.map((r) => r.doc.id);
  const accepted = await db
    .select({ documentId: legalConsents.documentId, v: sql<number>`max(${legalConsents.version})` })
    .from(legalConsents)
    .where(and(eq(legalConsents.userId, user.id), inArray(legalConsents.documentId, ids)))
    .groupBy(legalConsents.documentId);
  const acceptedV = new Map(accepted.map((a) => [a.documentId, Number(a.v)]));
  const joined = (await db.select({ at: users.createdAt }).from(users).where(eq(users.id, user.id)).limit(1))[0]?.at;
  const versions = await db
    .select({
      documentId: legalDocumentVersions.documentId,
      version: legalDocumentVersions.version,
      at: legalDocumentVersions.publishedAt,
      material: legalDocumentVersions.material,
    })
    .from(legalDocumentVersions)
    .where(inArray(legalDocumentVersions.documentId, ids));
  // A minor version asks nobody: what must have been accepted is the latest material version.
  const lastMaterial = (docId: string, published: number) =>
    Math.max(
      1,
      ...versions.filter((v) => v.documentId === docId && v.material && v.version <= published).map((v) => v.version),
    );
  const baseline = (docId: string) => {
    const mine = versions.filter((v) => v.documentId === docId);
    const atJoin = joined ? Math.max(0, ...mine.filter((v) => v.at <= joined).map((v) => v.version)) : 0;
    const grandfathered = joined && mine.length && mine.every((v) => v.at > joined) ? 1 : 0;
    return Math.max(acceptedV.get(docId) ?? 0, atJoin, grandfathered);
  };
  return required
    .filter((r) => lastMaterial(r.doc.id, r.ver.version) > baseline(r.doc.id))
    .map((r) => summary(r.doc, r.ver));
};

/** The current version of every published document that asks for consent (what joining agrees to). */
export const requiredLegal = async (db: Db): Promise<LegalDocSummary[]> => {
  await ensureLegalDefaults(db);
  return (await publishedRows(db)).filter((r) => r.doc.requiresConsent).map((r) => summary(r.doc, r.ver));
};

/** The current version of every published document an account accepts when it buys a plan. */
export const purchaseLegal = async (db: Db): Promise<LegalDocSummary[]> => {
  await ensureLegalDefaults(db);
  return (await publishedRows(db)).filter((r) => r.doc.purchaseConsent).map((r) => summary(r.doc, r.ver));
};

/** Throws 422 legal_consent_required unless every document in `required` is accepted at its current version. */
export const assertAccepted = (required: LegalDocSummary[], accepted: LegalAcceptance[] = []) => {
  const missing = required.filter((d) => !accepted.some((a) => a.slug === d.slug && a.version === d.version));
  if (missing.length)
    throw new AppError('legal_consent_required', 'Accept the current terms to continue', {
      documents: missing.map((d) => ({ slug: d.slug, version: d.version })),
    });
};

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // A leading = + - @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const csv = (rows: unknown[][]) => `\ufeff${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

/** GET /platform/legal/consents.csv (owner): who accepted which version, when, where and how. */
export const exportLegalConsents = async ({ db }: Deps, slug?: string) => {
  const rows = await db
    .select({
      slug: legalDocuments.slug,
      version: legalConsents.version,
      at: legalConsents.createdAt,
      context: legalConsents.context,
      email: users.email,
      name: users.name,
      ip: legalConsents.ip,
      userAgent: legalConsents.userAgent,
    })
    .from(legalConsents)
    .innerJoin(legalDocuments, eq(legalDocuments.id, legalConsents.documentId))
    .innerJoin(users, eq(users.id, legalConsents.userId))
    .where(slug ? eq(legalDocuments.slug, slug) : undefined)
    .orderBy(desc(legalConsents.createdAt))
    .limit(200_000);
  return csv([
    ['document', 'version', 'accepted_at', 'context', 'email', 'name', 'ip', 'user_agent'],
    ...rows.map((r) => [r.slug, r.version, r.at, r.context, r.email, r.name, r.ip, r.userAgent]),
  ]);
};

/** GET /platform/legal/marketing.csv (owner): the people who agreed to marketing email, and when. */
export const exportMarketingOptIns = async ({ db }: Deps) => {
  const rows = await db
    .select({ email: users.email, name: users.name, at: users.marketingOptInAt, locale: users.locale })
    .from(users)
    .where(isNotNull(users.marketingOptInAt))
    .orderBy(desc(users.marketingOptInAt))
    .limit(200_000);
  return csv([['email', 'name', 'locale', 'opted_in_at'], ...rows.map((r) => [r.email, r.name, r.locale, r.at])]);
};

/** Records acceptance of the CURRENT published versions only (a stale version is refused — the text changed). */
export const acceptLegal = async (
  { db }: Deps,
  user: SessionUser,
  accepted: LegalAcceptance[],
  context: 'invite' | 'prompt' | 'signup' | 'checkout',
  meta: RequestMeta,
) => {
  if (!accepted.length) return myPendingLegal({ db } as Deps, user);
  await ensureLegalDefaults(db);
  const docs = await db
    .select()
    .from(legalDocuments)
    .where(
      inArray(
        legalDocuments.slug,
        accepted.map((a) => a.slug),
      ),
    );
  const bySlug = new Map(docs.map((d) => [d.slug, d]));
  const rows = accepted.map((a) => {
    const doc = bySlug.get(a.slug);
    if (!doc || doc.publishedVersion !== a.version)
      throw new AppError('validation_failed', 'This version is not the current one — reload and accept again', {
        slug: a.slug,
      });
    return {
      id: newId(),
      userId: user.id,
      documentId: doc.id,
      version: a.version,
      context,
      ip: meta.ip?.slice(0, 64) ?? null,
      userAgent: meta.userAgent?.slice(0, 300) ?? null,
    };
  });
  await db.insert(legalConsents).values(rows).onConflictDoNothing();
  return myPendingLegal({ db } as Deps, user);
};
