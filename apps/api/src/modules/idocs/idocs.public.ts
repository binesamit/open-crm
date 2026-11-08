// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import {
  AppError,
  cellFromText,
  columnTypes,
  deriveValues,
  emptyIdocTheme,
  effectiveSelection,
  maskEmail,
  mergeIdocText,
  newId,
  type ConsentEvidence,
  type PublicIdoc,
  type PublicIdocRow,
  type SignatureValue,
} from '@bines/shared';
import type { z } from 'zod';
import type {
  publicIdocAskSchema,
  publicIdocInputsSchema,
  publicIdocSelectSchema,
  publicIdocSignSchema,
} from '@bines/shared';
import { IDOC_CODE_MINUTES, idocCodeEmail, idocSignedEmail } from '@bines/server-mail';
import type { AppDeps } from '../../types';
import { findAccountById, findMembership } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import { assertAccountOpen } from '../billing/entitlements';
import { findAsset, insertAsset, markUploaded } from '../files/files.repo';
import { attachToCell, safeName } from '../files/files.service';
import { cellsByItemIds, updateItemRow, upsertCell } from '../items/items.repo';
import { updateItem, type Actor } from '../items/items.service';
import { notifyUsers } from '../notifications/notify';
import { accountMailBrand } from '../platform/mail-brand';
import { findUserById } from '../users/users.repo';
import { choiceSummary, signedCopyHtml } from './idocs.copy';
import { docPdf } from './idocs.export';
import { askQuestion } from './idocs.questions';
import * as repo from './idocs.repo';
import type { IdocDocRow } from './idocs.repo';
import { buildDocView, docStateOf, inputToCell, type DocState, type DocView } from './idocs.resolve';
import { contactEmailOf, docUrl, isDocToken, logEvent, publicDocOf, statusOf } from './idocs.service';

/**
 * The public page of an interactive document (`/p/<token>`, API `/public/idocs/{token}`): no account, no session —
 * the token names the document. Everything is read and written with the document's sender's rights (like a public
 * form's creator): a sender who left the account, a suspended / closed account or a replaced link → 404.
 * Rules the page cannot bypass: expiry, revocation, the lock after signing, the one-time code when the document
 * asks for one, the section's own switches (who may tick, change quantities, ask) and the row keys of THIS document.
 */

type Deps = Pick<AppDeps, 'db' | 'storage' | 'mailer' | 'env' | 'logger'>;
export type Visitor = {
  ip: string | null;
  userAgent: string | null;
  key: string | null;
  requestId: string;
  /** A signed-in visitor (the members' look when they belong to the document's account). */
  userId?: string | null;
};

const audienceOf = async (deps: Pick<Deps, 'db'>, doc: IdocDocRow, v: Visitor): Promise<'guests' | 'members'> => {
  if (!v.userId) return 'guests';
  const m = await findMembership(deps.db, doc.accountId, v.userId);
  return m?.status === 'active' && m.role !== 'guest' ? 'members' : 'guests';
};

type Otp = {
  hash?: string;
  email?: string;
  expires_at?: string;
  attempts?: number;
  sends?: string[];
  visitors?: { h: string; exp: string; email: string }[];
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const VISIT_HOURS = 12;
const MAX_CODE_SENDS_PER_HOUR = 5;
const MAX_CODE_ATTEMPTS = 6;
/** One "opened" event (and one notification) per visit, not per refresh. */
const VISIT_GAP_MS = 30 * 60_000;

/** The sender's identity (their rights) for everything the page reads and writes. */
const docActor = async (deps: Pick<Deps, 'db'>, doc: IdocDocRow, requestId: string): Promise<Actor> => {
  const account = await findAccountById(deps.db, doc.accountId);
  if (!account || account.status !== 'active') throw new AppError('not_found', 'Document not found');
  await assertAccountOpen(deps.db, doc.accountId);
  const userId = doc.createdBy;
  const [membership, user] = userId
    ? await Promise.all([findMembership(deps.db, doc.accountId, userId), findUserById(deps.db, userId)])
    : [undefined, undefined];
  if (
    !membership ||
    membership.status !== 'active' ||
    !user ||
    membership.role === 'viewer' ||
    membership.role === 'guest'
  )
    throw new AppError('not_found', 'Document not found');
  return {
    ctx: { account, accountId: account.id, role: membership.role, membershipId: membership.id },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: !!user.emailVerified,
      isPlatformOwner: false,
      locale: user.locale,
      timezone: user.timezone,
    },
    requestId,
    relationPolicy: 'mark',
  };
};

const loadByToken = async (deps: Pick<Deps, 'db'>, token: string) => {
  if (!isDocToken(token)) throw new AppError('not_found', 'Document not found');
  const doc = await repo.findDocByToken(deps.db, token);
  if (!doc) throw new AppError('not_found', 'Document not found');
  return doc;
};

const otpOf = (doc: IdocDocRow): Otp => (doc.otp ?? {}) as Otp;

/** The verified address of this visitor, or null (no code asked, or none entered). */
const verifiedEmail = (doc: IdocDocRow, key: string | null) => {
  if (!key) return null;
  const h = sha(`${doc.id}:${key}`);
  const now = Date.now();
  return otpOf(doc).visitors?.find((v) => v.h === h && Date.parse(v.exp) > now)?.email ?? null;
};

const needsCode = (doc: IdocDocRow, view: Pick<DocView, 'settings'>, key: string | null) =>
  view.settings.verify === 'email_code' && !verifiedEmail(doc, key);

/** Open, or why not: expired / revoked / signed (read-only). */
const pageState = (doc: IdocDocRow): PublicIdoc['state'] => {
  const s = statusOf(doc);
  return s === 'revoked' ? 'revoked' : s === 'expired' ? 'expired' : s === 'signed' ? 'signed' : 'open';
};

const assertOpen = (doc: IdocDocRow) => {
  const s = pageState(doc);
  if (s !== 'open') throw new AppError('conflict', `idoc_${s}`);
};

const closedPage = (doc: IdocDocRow, state: PublicIdoc['state'], emailHint: string | null = null): PublicIdoc => ({
  state,
  title: state === 'revoked' ? '' : doc.name,
  language: 'he',
  version: doc.version,
  expires_at: doc.expiresAt?.toISOString() ?? null,
  account: { name: '', logo_url: null, color: '' },
  currency: 'ILS',
  vat_percent: 0,
  prices_include_vat: false,
  sections: [],
  questions: [],
  signed: null,
  email_hint: emailHint,
  theme: emptyIdocTheme(),
});

/** Who to tell: the people of the document's notify column (members), else its sender. */
const notifyDoc = async (deps: Pick<Deps, 'db'>, doc: IdocDocRow, view: DocView, excerpt: string) => {
  let ids: string[] = [];
  const key = view.settings.notify_column_key;
  const col = key ? view.itemColumns.find((c) => c.key === key && c.type === 'people') : undefined;
  if (col) {
    const cell = (await cellsByItemIds(deps.db, [doc.itemId])).find((c) => c.columnId === col.id);
    const v = cell?.value as { persons_and_teams?: { id: string; kind: string }[] } | undefined;
    ids = (v?.persons_and_teams ?? []).filter((p) => p.kind === 'person').map((p) => p.id);
  }
  if (!ids.length && doc.createdBy) ids = [doc.createdBy];
  await notifyUsers(
    deps.db,
    {
      accountId: doc.accountId,
      type: 'idoc_activity',
      actorId: null,
      boardIds: [doc.boardId],
      target: { boardId: doc.boardId, itemId: doc.itemId },
      payload: { excerpt, doc_id: doc.id },
    },
    ids,
  );
};

const clientName = (view: DocView, doc: IdocDocRow, fallback: string) => {
  const key = view.settings.contact_name_column_key;
  return (key ? view.lookup(`col:${key}`)?.trim() : '') || view.settings.contact_name || doc.sentTo || fallback;
};

// ——— read ———

export const getPublicDoc = async (deps: Deps, token: string, v: Visitor): Promise<PublicIdoc> => {
  const doc = await loadByToken(deps, token);
  const state = pageState(doc);
  if (state === 'revoked') return closedPage(doc, 'revoked');
  const a = await docActor(deps, doc, v.requestId);
  const view = await buildDocView(deps, a, doc);
  if (needsCode(doc, view, v.key)) {
    const email = contactEmailOf(view, doc);
    return closedPage(doc, 'verify', email ? maskEmail(email) : null);
  }
  if (state === 'expired')
    return {
      ...closedPage(doc, 'expired'),
      title: doc.name,
      account: { name: view.accountName, logo_url: null, color: view.settings.color },
    };
  const now = new Date();
  const last = doc.lastViewedAt?.getTime() ?? 0;
  await repo.countView(deps.db, doc.id, now);
  if (now.getTime() - last > VISIT_GAP_MS) {
    const who = clientName(view, doc, '');
    await logEvent(deps, doc, 'opened', { who, ip: v.ip, data: { ua: v.userAgent } });
    if (doc.status === 'sent' || doc.status === 'draft')
      await repo.updateDocRow(deps.db, doc.id, { status: doc.status === 'sent' ? 'viewed' : doc.status });
    if (view.settings.notify.viewed && state === 'open') await notifyDoc(deps, doc, view, `👁 ${who || doc.name}`);
  }
  return publicDocOf(deps, doc, view, state, await audienceOf(deps, doc, v));
};

// ——— one-time code ———

export const startVerify = async (deps: Deps, token: string, v: Visitor) => {
  const doc = await loadByToken(deps, token);
  if (pageState(doc) === 'revoked') throw new AppError('not_found', 'Document not found');
  const a = await docActor(deps, doc, v.requestId);
  const view = await buildDocView(deps, a, doc);
  if (view.settings.verify !== 'email_code') throw new AppError('conflict', 'idoc_no_code_needed');
  const email = contactEmailOf(view, doc);
  if (!email) throw new AppError('conflict', 'idoc_no_email');
  const otp = otpOf(doc);
  const hourAgo = Date.now() - 3_600_000;
  const sends = (otp.sends ?? []).filter((s) => Date.parse(s) > hourAgo);
  if (sends.length >= MAX_CODE_SENDS_PER_HOUR) throw new AppError('rate_limited', 'idoc_code_limit');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await repo.updateDocRow(deps.db, doc.id, {
    otp: {
      ...otp,
      hash: sha(`${doc.id}:${code}`),
      email,
      expires_at: new Date(Date.now() + IDOC_CODE_MINUTES * 60_000).toISOString(),
      attempts: 0,
      sends: [...sends, new Date().toISOString()],
    },
  });
  await deps.mailer.send(
    idocCodeEmail({
      to: email,
      brand: await accountMailBrand(deps, a.ctx.account, view.settings.language),
      docName: doc.name,
      code,
    }),
  );
  return { email_hint: maskEmail(email) };
};

export const checkVerify = async (deps: Deps, token: string, v: Visitor, code: string) => {
  const doc = await loadByToken(deps, token);
  const otp = otpOf(doc);
  if (!otp.hash || !otp.expires_at || Date.parse(otp.expires_at) < Date.now())
    throw new AppError('invalid_value', 'idoc_code_expired');
  if ((otp.attempts ?? 0) >= MAX_CODE_ATTEMPTS) throw new AppError('rate_limited', 'idoc_code_attempts');
  const given = Buffer.from(sha(`${doc.id}:${code.trim()}`));
  const ok = given.length === otp.hash.length && timingSafeEqual(given, Buffer.from(otp.hash));
  if (!ok) {
    await repo.updateDocRow(deps.db, doc.id, { otp: { ...otp, attempts: (otp.attempts ?? 0) + 1 } });
    throw new AppError('invalid_value', 'idoc_code_wrong');
  }
  const key = newId() + newId();
  const exp = new Date(Date.now() + VISIT_HOURS * 3_600_000).toISOString();
  const now = Date.now();
  const visitors = [
    ...(otp.visitors ?? []).filter((x) => Date.parse(x.exp) > now),
    { h: sha(`${doc.id}:${key}`), exp, email: otp.email ?? '' },
  ].slice(-20);
  await repo.updateDocRow(deps.db, doc.id, { otp: { visitors } });
  await logEvent(deps, doc, 'verified', { who: otp.email ?? null, ip: v.ip });
  return { visitor_key: key, expires_at: exp };
};

/** Loads an open document for a write from the page (code checked when asked for). */
const forWrite = async (deps: Deps, token: string, v: Visitor) => {
  const doc = await loadByToken(deps, token);
  assertOpen(doc);
  const a = await docActor(deps, doc, v.requestId);
  const view = await buildDocView(deps, a, doc);
  if (needsCode(doc, view, v.key)) throw new AppError('unauthenticated', 'idoc_code_required');
  return { doc, a, view };
};

// ——— choices ———

/** Writes the totals into the item's number columns when the document names them. */
const writeTotals = async (deps: Deps, a: Actor, doc: IdocDocRow, view: DocView) => {
  const cells: Record<string, unknown> = {};
  const one = view.settings.total_one_time_column_key;
  const rec = view.settings.total_recurring_column_key;
  if (one) cells[one] = view.totals.grand_total;
  if (rec) cells[rec] = view.totals.recurring_total;
  if (Object.keys(cells).length) await updateItem(deps.db, a, doc.itemId, { cells });
};

export const selectRow = async (
  deps: Deps,
  token: string,
  v: Visitor,
  input: z.infer<typeof publicIdocSelectSchema>,
) => {
  const { doc, a, view } = await forWrite(deps, token, v);
  const lines = view.lines.find((l) => l.section.id === input.section_id);
  if (!lines) throw new AppError('not_found', 'Section not found');
  const { section, rows } = lines;
  const next = new Map(rows.map((r) => [r.key, { selected: r.selected, qty: r.qty }]));
  // Select all / clear all (the product owner): free-choice sections only, with the section's switch on. Every row is
  // ticked (so whatever a row needs in the section is ticked too) or cleared; quantities stay.
  if (input.all !== undefined) {
    if (!section.client_can_select || section.mode !== 'multi' || !section.select_all)
      throw new AppError('forbidden', 'idoc_select_all_off');
    for (const r of rows) next.get(r.key)!.selected = input.all;
  }
  const row = input.all === undefined ? rows.find((r) => r.key === input.row) : undefined;
  if (input.all === undefined && !row) throw new AppError('not_found', 'Row not found');
  if (input.selected !== undefined && (!section.client_can_select || section.mode === 'fixed'))
    throw new AppError('forbidden', 'idoc_select_off');
  if (input.qty !== undefined && !section.client_can_change_qty) throw new AppError('forbidden', 'idoc_qty_off');

  // The wanted ticks: this row's change, then the section's rules (one in `single`; required rows follow).
  if (row && input.selected !== undefined) {
    if (section.mode === 'single' && input.selected) for (const r of rows) next.get(r.key)!.selected = false;
    next.get(row.key)!.selected = input.selected;
    if (input.selected) {
      // Ticking a row ticks what it needs (and what that needs).
      const add = (r: PublicIdocRow) => {
        for (const k of r.requires) {
          const n = next.get(k);
          if (n && !n.selected) {
            n.selected = true;
            add(rows.find((x) => x.key === k)!);
          }
        }
      };
      if (section.mode === 'multi') add(row);
    }
  }
  if (row && input.qty !== undefined) {
    const q = Math.round(Math.min(section.max_qty, Math.max(section.min_qty, input.qty)));
    next.get(row.key)!.qty = q;
  }
  // Unticking a row unticks the rows that need it.
  const effective = effectiveSelection(
    section.mode,
    rows.map((r) => ({ ...r, selected: next.get(r.key)!.selected })),
  );
  for (const r of rows) if (section.mode !== 'fixed') next.get(r.key)!.selected = effective.has(r.key);

  // Write: columns when mapped (the board shows the client's choice), else the document's own state.
  const state: DocState = docStateOf(doc);
  const own = { ...(state.rows?.[section.id] ?? {}) };
  const changes: string[] = [];
  for (const r of rows) {
    const n = next.get(r.key)!;
    const cells: Record<string, unknown> = {};
    if (n.selected !== r.selected) {
      changes.push(`${n.selected ? '✓' : '✗'} ${r.name}`);
      if (section.mapping.selected) cells[section.mapping.selected] = { checked: n.selected };
      else own[r.itemId] = { ...own[r.itemId], s: n.selected };
    }
    if (n.qty !== r.qty && n.qty !== null) {
      changes.push(`${r.name} × ${n.qty}`);
      if (section.mapping.quantity) cells[section.mapping.quantity] = n.qty;
      else own[r.itemId] = { ...own[r.itemId], q: n.qty };
    }
    if (Object.keys(cells).length) await updateItem(deps.db, a, r.itemId, { cells });
  }
  if (!changes.length) return { section_id: section.id, rows: rows.map(({ itemId: _i, boardId: _b, ...r }) => r) };
  await repo.updateDocRow(deps.db, doc.id, { state: { ...state, rows: { ...(state.rows ?? {}), [section.id]: own } } });
  const fresh = await buildDocView(deps, a, {
    ...doc,
    state: { ...state, rows: { ...(state.rows ?? {}), [section.id]: own } },
  });
  await writeTotals(deps, a, doc, fresh);
  const who = clientName(fresh, doc, '');
  await logEvent(deps, doc, 'selected', { who, detail: changes.join(' · '), ip: v.ip });
  if (fresh.settings.notify.selected) await notifyDoc(deps, doc, fresh, changes.join(' · '));
  const out = fresh.lines.find((l) => l.section.id === section.id)!;
  return { section_id: section.id, rows: out.rows.map(({ itemId: _i, boardId: _b, ...r }) => r) };
};

// ——— inputs ———

export const saveInputs = async (
  deps: Deps,
  token: string,
  v: Visitor,
  input: z.infer<typeof publicIdocInputsSchema>,
) => {
  const { doc, a, view } = await forWrite(deps, token, v);
  const mine = view.inputs.filter((i) => i.sectionId === input.section_id);
  if (!mine.length) throw new AppError('not_found', 'Section not found');
  const cells: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(input.values)) {
    const it = mine.find((i) => i.input.id === id);
    if (!it) continue;
    const value = inputToCell(it.input.kind, raw);
    if (value === undefined) throw new AppError('invalid_value', 'idoc_input_invalid', { input: id });
    cells[it.column.key] = value;
  }
  if (Object.keys(cells).length) await updateItem(deps.db, a, doc.itemId, { cells });
  await logEvent(deps, doc, 'input', {
    who: clientName(view, doc, ''),
    detail: mine
      .filter((i) => i.input.id in input.values)
      .map((i) => i.input.label)
      .join(', '),
    ip: v.ip,
  });
  return { ok: true };
};

// ——— questions ———

export const ask = async (deps: Deps, token: string, v: Visitor, input: z.infer<typeof publicIdocAskSchema>) => {
  const doc = await loadByToken(deps, token);
  // Questions stay open on a signed document (after-sale questions), never on a revoked / expired one.
  const s = pageState(doc);
  if (s === 'revoked' || s === 'expired') throw new AppError('conflict', `idoc_${s}`);
  const a = await docActor(deps, doc, v.requestId);
  const view = await buildDocView(deps, a, doc);
  if (needsCode(doc, view, v.key)) throw new AppError('unauthenticated', 'idoc_code_required');
  const section = input.section_id ? view.publicSections.find((x) => x.id === input.section_id) : null;
  if (section && section.ask === false) throw new AppError('forbidden', 'idoc_ask_off');
  const name =
    (input.name?.trim() || clientName(view, doc, '') || verifiedEmail(doc, v.key) || '').slice(0, 200) || '—';
  await askQuestion(deps, a, doc, view, input, name);
  await logEvent(deps, doc, 'question', { who: name, detail: input.text.slice(0, 200), ip: v.ip });
  return publicDocOf(deps, doc, view, pageState(doc), await audienceOf(deps, doc, v));
};

// ——— signing ———

/** JSON with sorted keys: the same content always hashes the same. */
export const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
};

const writeSignatureCell = async (
  deps: Deps,
  a: Actor,
  doc: IdocDocRow,
  view: DocView,
  key: string,
  value: SignatureValue,
) => {
  const column = view.itemColumns.find((c) => c.key === key && c.type === 'signature');
  if (!column) return;
  const def = columnTypes.get('signature')!;
  const d = deriveValues(def, column.settings, value);
  const now = new Date();
  await deps.db.transaction(async (tx) => {
    await upsertCell(tx, {
      itemId: doc.itemId,
      columnId: column.id,
      accountId: doc.accountId,
      boardId: doc.boardId,
      value,
      textValue: d.textValue,
      numberValue: d.numberValue,
      dateValue: d.dateValue,
      dateEndValue: null,
      updatedBy: a.user.id,
      updatedByType: 'document',
    });
    await updateItemRow(tx, doc.itemId, { lastCellChangeAt: now, lastCellChangeBy: a.user.id });
    await recordEvent(tx, {
      accountId: doc.accountId,
      type: 'signature.signed',
      actorId: a.user.id,
      actorType: 'document',
      requestId: a.requestId,
      boardId: doc.boardId,
      itemId: doc.itemId,
      columnId: column.id,
      meta: { column_key: column.key, column_type: 'signature', doc_id: doc.id, signature_id: value.signature_id },
    });
  });
};

/** The signed copy into the files column (as the sender, like any attachment). */
/** The signed copy into the files column: a PDF, or the self-contained HTML copy when the PDF cannot be made. */
const keepCopy = async (
  deps: Deps,
  a: Actor,
  doc: IdocDocRow,
  key: string,
  file: { body: Buffer; mime: 'application/pdf' | 'text/html'; ext: 'pdf' | 'html' },
  signatureId: string,
) => {
  const id = newId();
  const name = `${safeName(doc.name).slice(0, 80) || 'document'}-v${doc.version}.${file.ext}`;
  const storageKey = `${doc.accountId}/${id}/${name}`;
  await insertAsset(deps.db, {
    id,
    accountId: doc.accountId,
    ownerId: a.user.id,
    kind: 'file',
    storageKey,
    fileName: name,
    mime: file.mime,
    size: file.body.length,
    uploadStatus: 'pending',
  });
  await deps.storage.put(storageKey, file.body, file.mime);
  await markUploaded(deps.db, id, file.body.length, file.mime);
  await attachToCell(deps, a, doc.itemId, key, [id]);
  await repo.setSignatureFile(deps.db, signatureId, id);
};

export const sign = async (deps: Deps, token: string, v: Visitor, input: z.infer<typeof publicIdocSignSchema>) => {
  const { doc, a, view } = await forWrite(deps, token, v);
  if (input.version !== doc.version) throw new AppError('conflict', 'idoc_version_changed');
  const section = view.sections.find((s) => s.id === input.section_id && s.kind === 'signature' && !s.hidden);
  if (!section || section.kind !== 'signature') throw new AppError('not_found', 'Section not found');
  const ticked = new Set(input.consents);
  const missingConsent = section.consents.find((c) => c.required && !ticked.has(c.key));
  if (missingConsent) throw new AppError('invalid_value', 'idoc_consent_required', { consent: missingConsent.key });
  // A typed signature (the name, no pointer needed) stands for a drawn one — accessibility, recorded as typed.
  if (section.mode === 'sign' && section.require_drawing && !input.drawing?.trim() && !input.typed)
    throw new AppError('invalid_value', 'idoc_drawing_required');
  // "Approve" shows no name field (unless it asks for the role): the name falls back to the item's contact.
  const typedName = input.name.length >= 2 ? input.name : '';
  if (section.mode === 'sign' && !typedName) throw new AppError('invalid_value', 'idoc_name_required');
  const name = (typedName || clientName(view, doc, '') || verifiedEmail(doc, v.key) || '').slice(0, 200) || '—';
  const empty = view.inputs.filter(
    (i) => i.input.required && (i.input.value === null || i.input.value === '' || i.input.value === false),
  );
  if (empty.length)
    throw new AppError('invalid_value', 'idoc_inputs_missing', { inputs: empty.map((i) => i.input.label) });

  const at = new Date().toISOString();
  const email = verifiedEmail(doc, v.key);
  const summary = choiceSummary(view);
  const evidenceBase = {
    at,
    ip: v.ip,
    user_agent: v.userAgent?.slice(0, 300) ?? null,
    signer: { name, email: email ?? contactEmailOf(view, doc), role: input.role?.trim() || null },
    verified_by: email ? 'email_code' : 'none',
    consents: section.consents.map((c) => ({
      key: c.key,
      text: mergeIdocText(c.text, view.lookup),
      checked: ticked.has(c.key),
    })),
  } as const;
  // What was signed: the page as shown, the choices, the totals and who signs (the hash covers all of it).
  const snapshot = {
    document: { id: doc.id, name: doc.name, version: doc.version },
    account: view.accountName,
    sections: view.publicSections,
    totals: view.totals,
    summary,
    signer: evidenceBase.signer,
    consents: evidenceBase.consents,
    drawing: input.drawing ?? null,
    typed_signature: !input.drawing && !!input.typed,
    at,
  };
  const sha256 = sha(canonical(snapshot));
  const evidence: ConsentEvidence = {
    ...evidenceBase,
    signer: { ...evidenceBase.signer },
    consents: [...evidenceBase.consents],
    document: { kind: 'idoc', id: doc.id, version: doc.version, sha256 },
  };
  const signatureId = newId();
  await deps.db.transaction(async (tx) => {
    // Only the first signature counts: a second click / tab finds the document signed.
    const fresh = await repo.findDoc(tx, doc.accountId, doc.id);
    if (!fresh || fresh.signatureId || fresh.version !== doc.version) throw new AppError('conflict', 'idoc_signed');
    await repo.insertSignature(tx, {
      id: signatureId,
      accountId: doc.accountId,
      docId: doc.id,
      itemId: doc.itemId,
      version: doc.version,
      sha256,
      evidence,
      drawing: input.drawing ?? null,
      snapshot,
    });
    await repo.updateDocRow(tx, doc.id, { status: 'signed', signedAt: new Date(at), signatureId });
    await logEvent({ db: tx }, doc, 'signed', {
      who: name,
      detail: summary.slice(-1)[0] ?? '',
      ip: v.ip,
      data: { sha256 },
    });
  });

  // What signing writes on the item — each step on its own, so one failing column never loses the signature.
  const step = async (what: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      deps.logger.warn({ err, docId: doc.id, what }, 'idoc sign step failed');
    }
  };
  const value: SignatureValue = {
    signature_id: signatureId,
    name,
    role: input.role?.trim() || null,
    at,
    doc_id: doc.id,
    version: doc.version,
    has_drawing: !!input.drawing,
  };
  if (section.signature_column_key)
    await step('signature', () => writeSignatureCell(deps, a, doc, view, section.signature_column_key!, value));
  if (section.status_column_key && section.status_label) {
    const col = view.itemColumns.find((c) => c.key === section.status_column_key);
    const value = col ? cellFromText(col.type, section.status_label, col.settings) : undefined;
    if (col && value) await step('status', () => updateItem(deps.db, a, doc.itemId, { cells: { [col.key]: value } }));
  }
  await step('totals', () => writeTotals(deps, a, doc, view));
  if (section.file_column_key)
    await step('copy', async () => {
      const signedDoc = { ...doc, signatureId, status: 'signed' as const, signedAt: new Date(at) };
      const sig = { evidence, sha256, drawing: input.drawing ?? null, snapshot, version: doc.version };
      let file: Parameters<typeof keepCopy>[4];
      try {
        const pdf = await docPdf(deps, signedDoc, view, sig);
        file = { body: Buffer.from(pdf.bytes), mime: 'application/pdf', ext: 'pdf' };
      } catch (err) {
        deps.logger.warn({ err, docId: doc.id }, 'idoc signed PDF failed, keeping the HTML copy');
        const html = signedCopyHtml({
          view,
          docName: doc.name,
          version: doc.version,
          evidence,
          sha256,
          drawing: input.drawing ?? null,
          summary,
        });
        file = { body: Buffer.from(html, 'utf8'), mime: 'text/html', ext: 'html' };
      }
      await keepCopy(deps, a, doc, section.file_column_key!, file, signatureId);
    });
  if (view.settings.notify.signed)
    await step('notify', () =>
      notifyDoc(deps, doc, view, `✍ ${name}${summary.length ? ` · ${summary.slice(-1)[0]}` : ''}`),
    );
  const to = evidence.signer.email;
  if (to)
    await step('email', async () =>
      deps.mailer.send(
        idocSignedEmail({
          to,
          brand: await accountMailBrand(deps, a.ctx.account, view.settings.language),
          docName: doc.name,
          signer: name,
          at: new Intl.DateTimeFormat(view.settings.language === 'he' ? 'he-IL' : 'en-GB', {
            dateStyle: 'short',
            timeStyle: 'short',
            timeZone: view.timezone,
          }).format(new Date(at)),
          sha256,
          summary,
          url: await docUrl(deps, doc.token),
        }),
      ),
    );
  return { signed: { name, role: value.role ?? null, at }, sha256 };
};

// ——— PDF ———

/**
 * The client's PDF (GET /public/idocs/{token}/pdf, the visitor key in ?k= for a download link): what the page shows
 * now — or, once signed, what was signed. Not for a closed or expired link; the one-time code first when asked.
 */
export const publicPdf = async (deps: Deps, token: string, v: Visitor) => {
  const doc = await loadByToken(deps, token);
  const state = pageState(doc);
  if (state === 'revoked' || state === 'expired') throw new AppError('not_found', 'Document not found');
  const a = await docActor(deps, doc, v.requestId);
  const view = await buildDocView(deps, a, doc);
  if (needsCode(doc, view, v.key)) throw new AppError('unauthenticated', 'idoc_code_required');
  const pdf = await docPdf(deps, doc, view);
  await logEvent(deps, doc, 'downloaded', { who: clientName(view, doc, ''), ip: v.ip, data: { ua: v.userAgent } });
  return pdf;
};

// ——— files ———

/** A file the page shows (logo, cover, gallery, attachments, people photos) → a short-lived download link. */
export const fileLink = async (deps: Deps, token: string, ref: string, v: Visitor) => {
  const doc = await loadByToken(deps, token);
  if (pageState(doc) === 'revoked') throw new AppError('not_found', 'File not found');
  const a = await docActor(deps, doc, v.requestId);
  const view = await buildDocView(deps, a, doc);
  // The logo shows on the code screen too; anything else waits for the code.
  if (needsCode(doc, view, v.key) && ref !== view.logoRef) throw new AppError('unauthenticated', 'idoc_code_required');
  const assetId = view.files.get(ref);
  if (!assetId) throw new AppError('not_found', 'File not found');
  const asset = await findAsset(deps.db, doc.accountId, assetId);
  if (!asset?.storageKey) throw new AppError('not_found', 'File not found');
  const inline = /^image\//.test(asset.mime);
  return deps.storage.presignGet(asset.storageKey, asset.fileName, { inline, ttl: 300 });
};
