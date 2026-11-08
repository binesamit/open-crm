// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import {
  AppError,
  idocSectionsOf,
  idocSettingsOf,
  idocStarter,
  mergeIdocText,
  mergeIdocThemes,
  newId,
  type IdocAudience,
  type IdocCertificate,
  type IdocDoc,
  type IdocEvent,
  type IdocEventKind,
  type IdocSection,
  type IdocSettings,
  type IdocStatus,
  type IdocTemplate,
  type PublicIdoc,
} from '@bines/shared';
import type { z } from 'zod';
import type {
  createIdocDocSchema,
  createIdocTemplateSchema,
  sendIdocDocSchema,
  updateIdocDocSchema,
  updateIdocTemplateSchema,
} from '@bines/shared';
import { idocLinkEmail } from '@bines/server-mail';
import type { AppDeps } from '../../types';
import { assertBoard, loadBoardAccess } from '../boards/boards.access';
import { findBoard } from '../boards/boards.repo';
import { loadItem, type Actor } from '../items/items.service';
import { accountMailBrand } from '../platform/mail-brand';
import { webOrigin } from '../platform/public-address';
import { findUserById } from '../users/users.repo';
import * as repo from './idocs.repo';
import type { IdocDocRow, IdocTemplateRow } from './idocs.repo';
import { buildDocView, docStateOf, type DocView } from './idocs.resolve';
import { publicQuestions } from './idocs.questions';

type Deps = Pick<AppDeps, 'db' | 'storage' | 'mailer' | 'env' | 'logger'>;

/** A public link's secret: 32 characters of [a-z0-9] (≈165 bits). */
export const newDocToken = () => {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(32)].map((b) => abc[b % abc.length]).join('');
};
export const isDocToken = (token: string) => /^[a-z0-9]{32}$/.test(token);

export const docUrl = async (deps: Pick<AppDeps, 'db' | 'env'>, token: string) => `${await webOrigin(deps)}/p/${token}`;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ——— templates ———

export const templateDto = (row: IdocTemplateRow): IdocTemplate => ({
  id: row.id,
  name: row.name,
  description: row.description,
  board_id: row.boardId,
  sections: idocSectionsOf(row.sections),
  settings: idocSettingsOf(row.settings),
  created_by: row.createdBy,
  created_at: row.createdAt.toISOString(),
  updated_at: row.updatedAt.toISOString(),
});

/** People who build documents: members and admins (not viewers or guests). */
const assertBuilder = (a: Actor) => {
  if (a.ctx.role === 'viewer' || a.ctx.role === 'guest') throw new AppError('forbidden', 'idoc_builders_only');
};

/** Admins and the template's creator change or delete it; everyone else may use and copy it. */
const assertTemplateOwner = (a: Actor, row: IdocTemplateRow) => {
  if (a.ctx.role !== 'admin' && row.createdBy !== a.user.id)
    throw new AppError('forbidden', 'idoc_template_owner_only');
};

const loadTemplate = async (deps: Deps, a: Actor, id: string) => {
  const row = await repo.findTemplate(deps.db, a.ctx.accountId, id);
  if (!row) throw new AppError('not_found', 'Template not found');
  if (row.boardId) await loadBoardAccess(deps.db, a.ctx, a.user, row.boardId);
  return row;
};

export const listTemplates = async (deps: Deps, a: Actor, boardId?: string) => {
  if (boardId) await loadBoardAccess(deps.db, a.ctx, a.user, boardId);
  const rows = await repo.listTemplates(deps.db, a.ctx.accountId, boardId ?? null);
  // Board templates of boards the person cannot open are not theirs to see.
  const out: IdocTemplate[] = [];
  for (const r of rows) {
    if (r.boardId && r.boardId !== boardId) {
      const ok = await loadBoardAccess(deps.db, a.ctx, a.user, r.boardId).then(
        () => true,
        () => false,
      );
      if (!ok) continue;
    }
    out.push(templateDto(r));
  }
  return out;
};

export const getTemplate = async (deps: Deps, a: Actor, id: string) => templateDto(await loadTemplate(deps, a, id));

export const createTemplate = async (deps: Deps, a: Actor, input: z.infer<typeof createIdocTemplateSchema>) => {
  assertBuilder(a);
  if (input.board_id) await loadBoardAccess(deps.db, a.ctx, a.user, input.board_id);
  let sections: IdocSection[] = [];
  let settings: IdocSettings = idocSettingsOf({});
  if (input.starter) {
    const s = idocStarter(input.starter);
    if (!s) throw new AppError('invalid_value', 'unknown_starter');
    sections = s.sections;
    settings = s.settings;
  } else if (input.from_template_id) {
    const t = await loadTemplate(deps, a, input.from_template_id);
    sections = idocSectionsOf(t.sections);
    settings = idocSettingsOf(t.settings);
  } else if (input.from_doc_id) {
    const { doc } = await loadDoc(deps, a, input.from_doc_id);
    sections = idocSectionsOf(doc.sections);
    settings = idocSettingsOf(doc.settings);
  }
  const row = await repo.insertTemplate(deps.db, {
    id: newId(),
    accountId: a.ctx.accountId,
    boardId: input.board_id ?? null,
    name: input.name,
    description: input.description ?? '',
    sections,
    settings,
    createdBy: a.user.id,
  });
  return templateDto(row);
};

export const updateTemplate = async (
  deps: Deps,
  a: Actor,
  id: string,
  input: z.infer<typeof updateIdocTemplateSchema>,
) => {
  const row = await loadTemplate(deps, a, id);
  assertTemplateOwner(a, row);
  if (input.board_id) await loadBoardAccess(deps.db, a.ctx, a.user, input.board_id);
  const next = await repo.updateTemplateRow(deps.db, id, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.board_id !== undefined ? { boardId: input.board_id } : {}),
    ...(input.sections ? { sections: input.sections } : {}),
    ...(input.settings ? { settings: input.settings } : {}),
  });
  return templateDto(next);
};

export const deleteTemplate = async (deps: Deps, a: Actor, id: string) => {
  const row = await loadTemplate(deps, a, id);
  assertTemplateOwner(a, row);
  // Documents made from it keep their own copy (template_id → null).
  await repo.deleteTemplateRow(deps.db, id);
};

// ——— documents ———

export const statusOf = (doc: Pick<IdocDocRow, 'status' | 'expiresAt' | 'signedAt'>, now = new Date()): IdocStatus => {
  if (doc.status === 'revoked' || doc.status === 'signed') return doc.status;
  if (doc.expiresAt && doc.expiresAt.getTime() < now.getTime()) return 'expired';
  return doc.status as IdocStatus;
};

const signatureSummary = async (deps: Deps, doc: IdocDocRow) => {
  if (!doc.signatureId) return null;
  const sig = await repo.findSignature(deps.db, doc.accountId, doc.signatureId);
  if (!sig) return null;
  const ev = sig.evidence as { signer?: { name?: string; role?: string | null }; at?: string };
  return {
    id: sig.id,
    name: ev.signer?.name ?? '',
    role: ev.signer?.role ?? null,
    at: ev.at ?? sig.createdAt.toISOString(),
    version: sig.version,
  };
};

export const docDto = async (deps: Deps, doc: IdocDocRow, canEdit: boolean): Promise<IdocDoc> => ({
  id: doc.id,
  item_id: doc.itemId,
  board_id: doc.boardId,
  template_id: doc.templateId,
  name: doc.name,
  sections: idocSectionsOf(doc.sections),
  settings: idocSettingsOf(doc.settings),
  status: statusOf(doc),
  version: doc.version,
  url: canEdit ? await docUrl(deps, doc.token) : null,
  expires_at: iso(doc.expiresAt),
  sent_at: iso(doc.sentAt),
  sent_to: canEdit ? doc.sentTo : null,
  first_viewed_at: iso(doc.firstViewedAt),
  last_viewed_at: iso(doc.lastViewedAt),
  view_count: doc.viewCount,
  signature: await signatureSummary(deps, doc),
  created_by: doc.createdBy,
  created_at: doc.createdAt.toISOString(),
  updated_at: doc.updatedAt.toISOString(),
});

/** A document of an item the person can read; `edit` = they may change the item (create, send, change). */
export const loadDoc = async (deps: Pick<Deps, 'db'>, a: Actor, id: string, edit = false) => {
  const doc = await repo.findDoc(deps.db, a.ctx.accountId, id);
  if (!doc) throw new AppError('not_found', 'Document not found');
  const { item, access } = await loadItem(deps.db, a, doc.itemId);
  if (edit) assertBoard(access, 'item.update');
  return { doc, item, access };
};

const canEditItem = (access: Awaited<ReturnType<typeof loadItem>>['access']) => {
  try {
    assertBoard(access, 'item.update');
    return true;
  } catch {
    return false;
  }
};

export const logEvent = (
  deps: Pick<Deps, 'db'>,
  doc: Pick<IdocDocRow, 'id' | 'accountId'>,
  kind: IdocEventKind,
  x: {
    userId?: string | null;
    who?: string | null;
    detail?: string;
    data?: Record<string, unknown>;
    ip?: string | null;
  } = {},
) =>
  repo.insertEvent(deps.db, {
    id: newId(),
    accountId: doc.accountId,
    docId: doc.id,
    kind,
    userId: x.userId ?? null,
    who: x.who?.slice(0, 200) ?? null,
    detail: (x.detail ?? '').slice(0, 500),
    data: x.data ?? null,
    ip: x.ip ?? null,
  });

export const listItemDocs = async (deps: Deps, a: Actor, itemId: string) => {
  const { access } = await loadItem(deps.db, a, itemId);
  const edit = canEditItem(access);
  return Promise.all((await repo.listItemDocs(deps.db, a.ctx.accountId, itemId)).map((d) => docDto(deps, d, edit)));
};

export const getDoc = async (deps: Deps, a: Actor, id: string) => {
  const { doc, access } = await loadDoc(deps, a, id);
  return docDto(deps, doc, canEditItem(access));
};

export const createDoc = async (deps: Deps, a: Actor, itemId: string, input: z.infer<typeof createIdocDocSchema>) => {
  assertBuilder(a);
  const { item, access } = await loadItem(deps.db, a, itemId);
  assertBoard(access, 'item.update');
  let sections: IdocSection[];
  let settings: IdocSettings;
  let name: string;
  let templateId: string | null = null;
  if (input.template_id) {
    const t = await loadTemplate(deps, a, input.template_id);
    sections = idocSectionsOf(t.sections);
    settings = idocSettingsOf(t.settings);
    name = t.name;
    templateId = t.id;
  } else {
    const s = idocStarter(input.starter ?? 'blank');
    if (!s) throw new AppError('invalid_value', 'unknown_starter');
    sections = s.sections;
    settings = s.settings;
    name = s.name.he;
  }
  const doc = await repo.insertDoc(deps.db, {
    id: newId(),
    accountId: a.ctx.accountId,
    boardId: item.boardId,
    itemId: item.id,
    templateId,
    name: (input.name?.trim() || `${name} · ${item.name}`).slice(0, 200),
    sections,
    settings,
    token: newDocToken(),
    state: { salt: randomBytes(12).toString('base64url') },
    createdBy: a.user.id,
  });
  await logEvent(deps, doc, 'created', { userId: a.user.id, who: a.user.name });
  return docDto(deps, doc, true);
};

/** A signed document is fixed until it is reopened (when the document locks after signing). */
const assertChangeable = (doc: IdocDocRow) => {
  if (doc.status === 'signed' && idocSettingsOf(doc.settings).lock_after_sign)
    throw new AppError('conflict', 'idoc_signed');
};

export const updateDoc = async (deps: Deps, a: Actor, id: string, input: z.infer<typeof updateIdocDocSchema>) => {
  const { doc } = await loadDoc(deps, a, id, true);
  if (input.sections || input.settings) assertChangeable(doc);
  const next = await repo.updateDocRow(deps.db, id, {
    ...(input.name ? { name: input.name } : {}),
    ...(input.sections ? { sections: input.sections } : {}),
    ...(input.settings ? { settings: input.settings } : {}),
  });
  return docDto(deps, next, true);
};

export const deleteDoc = async (deps: Deps, a: Actor, id: string) => {
  const { doc } = await loadDoc(deps, a, id, true);
  // A signed document is evidence: only an admin removes it.
  if (doc.signatureId && a.ctx.role !== 'admin') throw new AppError('forbidden', 'idoc_signed_admin_only');
  await repo.deleteDocRow(deps.db, id);
};

/** The contact's address: the document's email column, else the typed address, else the last one it was sent to. */
export const contactEmailOf = (view: Pick<DocView, 'lookup' | 'settings'>, doc: Pick<IdocDocRow, 'sentTo'>) => {
  const key = view.settings.contact_email_column_key;
  const email = (x: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) ? x : '');
  const fromColumn = key ? (view.lookup(`col:${key}`) ?? '').trim() : '';
  return email(fromColumn) || email(view.settings.contact_email) || doc.sentTo || null;
};

const DAY = 86_400_000;

export const sendDoc = async (deps: Deps, a: Actor, id: string, input: z.infer<typeof sendIdocDocSchema>) => {
  const { doc } = await loadDoc(deps, a, id, true);
  if (doc.status === 'revoked') throw new AppError('conflict', 'idoc_revoked');
  const view = await buildDocView(deps, a, doc);
  const to = input.email ?? contactEmailOf(view, doc);
  if (!input.no_email && !to) throw new AppError('invalid_value', 'idoc_no_email');
  const now = new Date();
  const days = view.settings.expires_days;
  // Sending (again) opens the link for the set number of days from now.
  const expiresAt = days ? new Date(now.getTime() + days * DAY) : null;
  const next = await repo.updateDocRow(deps.db, id, {
    status: doc.status === 'signed' ? 'signed' : doc.status === 'viewed' ? 'viewed' : 'sent',
    sentAt: now,
    sentTo: to ?? doc.sentTo,
    expiresAt: doc.status === 'signed' ? doc.expiresAt : expiresAt,
  });
  if (!input.no_email && to) {
    const merge = (s: string) => mergeIdocText(s, view.lookup);
    const brand = await accountMailBrand(deps, a.ctx.account, view.settings.language);
    try {
      await deps.mailer.send(
        idocLinkEmail({
          to,
          brand,
          docName: next.name,
          url: await docUrl(deps, next.token),
          subject: merge(view.settings.email_subject),
          body: merge(view.settings.email_body),
          ...(next.expiresAt ? { expires: view.lookup('doc.expires') ?? '' } : {}),
        }),
      );
    } catch (err) {
      deps.logger.warn({ err, docId: id }, 'idoc email failed');
      throw new AppError('external_error', 'idoc_email_failed');
    }
  }
  await logEvent(deps, doc, 'sent', { userId: a.user.id, who: a.user.name, detail: to ?? '' });
  return docDto(deps, next, true);
};

export const replaceToken = async (deps: Deps, a: Actor, id: string) => {
  const { doc } = await loadDoc(deps, a, id, true);
  const next = await repo.updateDocRow(deps.db, id, { token: newDocToken(), otp: null });
  await logEvent(deps, doc, 'link_replaced', { userId: a.user.id, who: a.user.name });
  return docDto(deps, next, true);
};

export const revokeDoc = async (deps: Deps, a: Actor, id: string) => {
  const { doc } = await loadDoc(deps, a, id, true);
  const next = await repo.updateDocRow(deps.db, id, { status: 'revoked' });
  await logEvent(deps, doc, 'revoked', { userId: a.user.id, who: a.user.name });
  return docDto(deps, next, true);
};

/** Reopen a signed / revoked / expired document: a new version the client can change and sign again. */
export const reopenDoc = async (deps: Deps, a: Actor, id: string) => {
  const { doc } = await loadDoc(deps, a, id, true);
  const days = idocSettingsOf(doc.settings).expires_days;
  const signed = !!doc.signatureId;
  const next = await repo.updateDocRow(deps.db, id, {
    status: doc.sentAt ? 'sent' : 'draft',
    version: signed ? doc.version + 1 : doc.version,
    signedAt: null,
    signatureId: null,
    expiresAt: days ? new Date(Date.now() + days * DAY) : null,
  });
  await logEvent(deps, doc, 'reopened', { userId: a.user.id, who: a.user.name, detail: `v${next.version}` });
  return docDto(deps, next, true);
};

export const eventDto = (e: repo.IdocEventRow): IdocEvent => ({
  id: e.id,
  kind: e.kind as IdocEventKind,
  at: e.createdAt.toISOString(),
  who: e.who,
  detail: e.detail,
  ip: e.ip,
});

export const listDocEvents = async (deps: Deps, a: Actor, id: string) => {
  const { doc } = await loadDoc(deps, a, id);
  return (await repo.listEvents(deps.db, doc.id)).map(eventDto);
};

/**
 * The page as the client would see it, for the builder's preview — with the sections / settings being edited when
 * given (not saved), read with the editor's own rights.
 */
export const previewDoc = async (
  deps: Deps,
  a: Actor,
  id: string,
  draft?: { sections?: IdocSection[]; settings?: IdocSettings; audience?: IdocAudience },
): Promise<PublicIdoc> => {
  const { doc } = await loadDoc(deps, a, id);
  const view = await buildDocView(deps, a, doc, draft);
  return publicDocOf(deps, doc, view, 'open', draft?.audience ?? 'guests');
};

export const publicDocOf = async (
  deps: Pick<Deps, 'db'>,
  doc: IdocDocRow,
  view: DocView,
  state: PublicIdoc['state'],
  audience: IdocAudience = 'guests',
): Promise<PublicIdoc> => {
  const signature = doc.signatureId ? await repo.findSignature(deps.db, doc.accountId, doc.signatureId) : null;
  const ev = signature?.evidence as { signer?: { name?: string; role?: string | null }; at?: string } | undefined;
  return {
    state,
    title: doc.name,
    language: view.settings.language,
    version: doc.version,
    expires_at: iso(doc.expiresAt),
    account: {
      name: view.accountName,
      logo_url: view.logoRef ? `/api/v1/public/idocs/${doc.token}/files/${view.logoRef}` : null,
      color: view.settings.color,
    },
    currency: view.settings.currency,
    vat_percent: view.settings.vat_percent,
    prices_include_vat: view.settings.prices_include_vat,
    sections: view.publicSections,
    questions: await publicQuestions(deps, doc, view),
    signed: signature ? { name: ev?.signer?.name ?? '', role: ev?.signer?.role ?? null, at: ev?.at ?? '' } : null,
    email_hint: null,
    theme: themeFor(view, audience),
  };
};

/** The look for an audience: the account's default for it, then the document's own (the legacy header colour too). */
export const themeFor = (view: Pick<DocView, 'accountThemes' | 'settings'>, audience: IdocAudience) =>
  mergeIdocThemes(
    view.accountThemes[audience],
    view.settings.color ? { header: view.settings.color } : null,
    view.settings.theme,
  );

export const certificate = async (deps: Deps, a: Actor, signatureId: string): Promise<IdocCertificate> => {
  const sig = await repo.findSignature(deps.db, a.ctx.accountId, signatureId);
  if (!sig) throw new AppError('not_found', 'Signature not found');
  const { doc } = await loadDoc(deps, a, sig.docId);
  const snap = sig.snapshot as { summary?: string[] };
  return {
    id: sig.id,
    doc_id: doc.id,
    doc_name: doc.name,
    item_id: doc.itemId,
    version: sig.version,
    sha256: sig.sha256,
    evidence: sig.evidence as IdocCertificate['evidence'],
    drawing: sig.drawing,
    summary: snap.summary ?? [],
    events: (await repo.listEvents(deps.db, doc.id)).map(eventDto),
    file_id: sig.fileAssetId,
  };
};

/** The board a document belongs to must still exist (a moved item keeps its documents). */
export const boardOf = (deps: Pick<Deps, 'db'>, doc: IdocDocRow) => findBoard(deps.db, doc.accountId, doc.boardId);

export { docStateOf, findUserById };
