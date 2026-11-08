// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { type AccountExport, AppError, exportRequestSchema, formatDateTime, newId, todayIn } from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import type { AppDeps, AccountContext, RequestMeta, SessionUser } from '../../types';
import { assertAccountAdmin } from '../../lib/account-admin';
import { enqueueJob } from '../../lib/jobs';
import { st } from '../../lib/i18n';
import { toXlsxBook } from '../../lib/xlsx';
import { createZipFile, isCompressedMime, safeName, uniqueIn } from '../../lib/zip-file';
import { recordAudit } from '../audit/audit.repo';
import { accountRegion } from '../accounts/region';
import { findAccountById, findMembership } from '../accounts/accounts.repo';
import { findSubBoard } from '../boards/boards.repo';
import { exportDoc } from '../docs/docs.export';
import { boardExportRows } from '../export/export.service';
import { accountMailBrand } from '../platform/mail-brand';
import { loadPlatformSettings } from '../platform/platform-settings';
import { appLink } from '../platform/public-address';
import { usersCsv } from '../users/admin.service';
import {
  boardFiles,
  boardUpdates,
  type ExportRow,
  expiredExports,
  exportableBoards,
  exportableDocs,
  findExport,
  findUserForActor,
  insertExport,
  itemNamesOf,
  listExports,
  runningExport,
  updateExport,
} from './account-deletion.repo';

/**
 * The full account export: Administration → General → "Export all data". An admin asks; a background
 * job (`account.export`) packs one ZIP — every board as an Excel workbook (items with their subitems, and the updates
 * as a second sheet), every doc (Markdown and HTML), every file in folders by board and item, and `users.csv` — and
 * keeps it in storage under `exports/<account>/` for the owner's `export_days` (7 by default). The requester gets an
 * email; the app shows the download meanwhile. The export reads as its requester: what an admin may not read (a
 * private board they are not in) is left out and named in the summary and in README.txt — nothing is bypassed.
 *
 * Large accounts: the ZIP is written to a temporary file entry by entry (files stream from storage one at a time),
 * then uploaded; the next board is read only once the previous is packed.
 */

export const EXPORT_TASK = 'account.export';
export const EXPORT_PREFIX = 'exports/';

type Deps = Pick<AppDeps, 'db' | 'storage' | 'env' | 'mailer' | 'logger'>;
type AdminActor = { ctx: AccountContext; user: SessionUser; requestId?: string };

const exportDto = (row: ExportRow, requesterName: string | null): AccountExport => ({
  id: row.id,
  status: row.status as AccountExport['status'],
  requested_by: row.requestedBy ? { id: row.requestedBy, name: requesterName ?? '' } : null,
  created_at: row.createdAt.toISOString(),
  finished_at: row.finishedAt?.toISOString() ?? null,
  expires_at: row.expiresAt?.toISOString() ?? null,
  size_bytes: row.sizeBytes ?? null,
  summary: (row.summary as AccountExport['summary']) ?? null,
  error: row.error ?? null,
});

const assertExportAdmin = (a: AdminActor) => {
  if (a.ctx.support) throw new AppError('forbidden', 'not_for_support');
  assertAccountAdmin(a.ctx, { reason: 'admin_only' });
};

/** GET /account-export: the account's latest exports (admins). */
export const listAccountExports = async (deps: Pick<Deps, 'db'>, a: AdminActor) => {
  assertExportAdmin(a);
  return { data: (await listExports(deps.db, a.ctx.accountId)).map((r) => exportDto(r.row, r.requesterName)) };
};

/**
 * POST /account-export: starts one (409 `export_in_progress` while another is being built). Queued for the worker;
 * where no worker runs (tests, a bare install) it is built right away.
 */
export const startAccountExport = async (deps: Deps, a: AdminActor, meta: RequestMeta) => {
  assertExportAdmin(a);
  if (await runningExport(deps.db, a.ctx.accountId)) throw new AppError('export_in_progress', 'An export is running');
  const id = newId();
  await insertExport(deps.db, { id, accountId: a.ctx.accountId, requestedBy: a.user.id, status: 'pending' });
  await recordAudit(deps.db, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action: 'account.export_requested',
    targetType: 'account',
    targetId: a.ctx.accountId,
    payload: { export_id: id },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  if (!(await enqueueJob(deps.db, EXPORT_TASK, { id }, { maxAttempts: 1 }))) await runAccountExport(deps, id);
  const row = (await findExport(deps.db, id))!;
  return exportDto(row, a.user.name);
};

/** GET /account-export/{id}/download: a short-lived link to a ready export (admins; audited). */
export const accountExportLink = async (
  deps: Pick<Deps, 'db' | 'storage'>,
  a: AdminActor,
  id: string,
  meta: RequestMeta,
) => {
  assertExportAdmin(a);
  const row = await findExport(deps.db, id);
  if (!row || row.accountId !== a.ctx.accountId) throw new AppError('not_found', 'Export not found');
  if (row.status !== 'ready' || !row.storageKey || !row.expiresAt || row.expiresAt <= new Date())
    throw new AppError('not_found', 'export_not_ready');
  const date = todayIn(await accountRegion(deps.db, a.ctx.accountId, a.user));
  const ttl = 15 * 60;
  const url = await deps.storage.presignGet(row.storageKey, `${a.ctx.account.slug}-export-${date}.zip`, { ttl });
  await recordAudit(deps.db, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action: 'account.export_downloaded',
    targetType: 'account',
    targetId: a.ctx.accountId,
    payload: { export_id: id },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  return { url, expires_at: new Date(Date.now() + ttl * 1000).toISOString() };
};

// ---- the job ----

const fileStream = async (deps: Pick<Deps, 'storage'>, key: string): Promise<Readable | null> => {
  if (deps.storage.getStream) return deps.storage.getStream(key);
  const body = await deps.storage.get(key, 2 * 1024 ** 3);
  return body ? Readable.from([body]) : null;
};

/** The requester as the export's actor: still an active admin of the account, else the export fails. */
const actorOf = async (deps: Pick<Deps, 'db'>, row: ExportRow) => {
  const account = await findAccountById(deps.db, row.accountId);
  if (!account || !row.requestedBy) return null;
  const membership = await findMembership(deps.db, row.accountId, row.requestedBy);
  if (!membership || membership.status !== 'active' || membership.role !== 'admin') return null;
  const user = await findUserForActor(deps.db, row.requestedBy);
  if (!user) return null;
  const ctx: AccountContext = { account, accountId: account.id, role: 'admin', membershipId: membership.id };
  return { ctx, user };
};

const MB = 1024 * 1024;

/**
 * Builds one export (the job; idempotent — a finished or failed one is left alone). Every failure is kept on the row
 * (`failed` + the reason) and the temporary file is removed.
 */
export const runAccountExport = async (deps: Deps, id: string) => {
  const row = await findExport(deps.db, id);
  if (!row || (row.status !== 'pending' && row.status !== 'running')) return;
  await updateExport(deps.db, id, { status: 'running', startedAt: new Date(), error: null });
  const tmp = join(tmpdir(), `bines-export-${id}-${randomBytes(4).toString('hex')}.zip`);
  try {
    const a = await actorOf(deps, row);
    if (!a) throw new AppError('forbidden', 'requester_not_admin');
    const region = await accountRegion(deps.db, a.ctx.accountId, a.user);
    const lang = region.language;
    const zip = await createZipFile(tmp);
    const skipped: string[] = [];
    let boardsDone = 0;
    let docsDone = 0;
    let filesDone = 0;
    try {
      // Boards: one workbook each (items + subitems, updates), then their files.
      const usedBoards = new Set<string>();
      for (const board of await exportableBoards(deps.db, a.ctx.accountId)) {
        let rows;
        try {
          rows = await boardExportRows(
            deps.db,
            a,
            board.id,
            exportRequestSchema.parse({ format: 'xlsx', include_subitems: true }),
            { all: true },
          );
        } catch (err) {
          if (err instanceof AppError && (err.code === 'not_found' || err.code === 'forbidden')) {
            skipped.push(board.name);
            continue;
          }
          throw err;
        }
        const folder = uniqueIn(usedBoards, safeName(board.name, board.id));
        const sub = await findSubBoard(deps.db, board.id);
        const boardIds = sub ? [board.id, sub.id] : [board.id];
        const names = await itemNamesOf(deps.db, a.ctx.accountId, boardIds);
        const updates = await boardUpdates(deps.db, a.ctx.accountId, boardIds);
        const book = toXlsxBook([
          { name: st('accountExport.sheet.items', undefined, lang), header: rows.header, rows: rows.rows },
          {
            name: st('accountExport.sheet.updates', undefined, lang),
            header: ['item', 'author', 'date', 'reply', 'text'].map((k) =>
              st(`accountExport.updates.${k}`, undefined, lang),
            ),
            rows: updates.map((u) => [
              names.get(u.itemId)?.name ?? '',
              u.author ?? '',
              formatDateTime(u.createdAt, {}, region),
              u.parentUpdateId ? '↳' : '',
              // A secret update stays sealed in the export: only that there is one.
              u.isSecret ? '🔒' : u.bodyText,
            ]),
          },
        ]);
        await zip.add(`boards/${folder}.xlsx`, book);
        boardsDone++;

        const usedFiles = new Map<string, Set<string>>();
        for (const f of await boardFiles(deps.db, a.ctx.accountId, boardIds)) {
          const item = names.get(f.itemId);
          if (!item || !f.storageKey) continue;
          const parent = item.parentItemId ? names.get(item.parentItemId) : null;
          const itemFolder = [parent ? safeName(parent.name, parent.id) : null, safeName(item.name, item.id)]
            .filter(Boolean)
            .join('/');
          const dir = `files/${folder}/${itemFolder}`;
          const used = usedFiles.get(dir) ?? new Set<string>();
          usedFiles.set(dir, used);
          const stream = await fileStream(deps, f.storageKey);
          if (!stream) continue; // gone from storage: nothing to pack
          await zip.add(`${dir}/${uniqueIn(used, safeName(f.fileName, f.assetId))}`, stream, {
            store: isCompressedMime(f.mime),
          });
          filesDone++;
        }
      }

      // Docs: Markdown and HTML (images link for an hour; the files themselves are under files/ when in a board).
      const usedDocs = new Set<string>();
      for (const doc of await exportableDocs(deps.db, a.ctx.accountId)) {
        let md, html;
        try {
          md = await exportDoc(deps, a, doc.id, 'md');
          html = await exportDoc(deps, a, doc.id, 'html');
        } catch (err) {
          if (err instanceof AppError && (err.code === 'not_found' || err.code === 'forbidden')) {
            skipped.push(doc.name);
            continue;
          }
          throw err;
        }
        const name = uniqueIn(usedDocs, safeName(doc.name, doc.id));
        await zip.add(`docs/${name}.md`, md.body);
        await zip.add(`docs/${name}.html`, html.body);
        docsDone++;
      }

      // The people: members and roles.
      const csv = await usersCsv(deps, a);
      await zip.add('users.csv', csv);
      const usersCount = Math.max(0, csv.split('\r\n').filter(Boolean).length - 1);

      const summary = { boards: boardsDone, docs: docsDone, files: filesDone, users: usersCount, skipped };
      await zip.add(
        'README.txt',
        [
          st('accountExport.readme.title', { name: a.ctx.account.name }, lang),
          st('accountExport.readme.date', { date: formatDateTime(new Date(), {}, region) }, lang),
          st('accountExport.readme.by', { name: a.user.name || a.user.email }, lang),
          '',
          st(
            'accountExport.readme.counts',
            { boards: boardsDone, docs: docsDone, files: filesDone, users: usersCount },
            lang,
          ),
          st('accountExport.readme.layout', undefined, lang),
          ...(skipped.length
            ? ['', st('accountExport.readme.skipped', undefined, lang), ...skipped.map((n) => `• ${n}`)]
            : []),
          '',
        ].join('\r\n'),
      );
      const size = await zip.close();
      const key = `${EXPORT_PREFIX}${a.ctx.accountId}/${id}.zip`;
      if (deps.storage.putFile) await deps.storage.putFile(key, tmp, 'application/zip');
      else await deps.storage.put(key, await readFile(tmp), 'application/zip');
      const days = (await loadPlatformSettings(deps.db)).account_deletion.export_days;
      const expiresAt = new Date(Date.now() + days * 86_400_000);
      await updateExport(deps.db, id, {
        status: 'ready',
        storageKey: key,
        sizeBytes: size,
        summary,
        finishedAt: new Date(),
        expiresAt,
      });
      await recordAudit(deps.db, {
        accountId: a.ctx.accountId,
        actorId: a.user.id,
        action: 'account.exported',
        targetType: 'account',
        targetId: a.ctx.accountId,
        payload: { export_id: id, ...summary, size_mb: Math.round((size / MB) * 10) / 10 },
      });
      await emailReady(deps, a, expiresAt, days).catch((err) =>
        deps.logger.warn({ err, exportId: id }, 'account export email failed'),
      );
    } catch (err) {
      await zip.abort();
      throw err;
    }
  } catch (err) {
    const reason = err instanceof AppError ? err.message || err.code : 'export_failed';
    deps.logger.error({ err, exportId: id }, 'account export failed');
    await updateExport(deps.db, id, { status: 'failed', error: reason, finishedAt: new Date() });
  } finally {
    await rm(tmp, { force: true });
  }
};

/** "Your export is ready": to the requester, with the link to Administration → General (sign-in needed). */
const emailReady = async (deps: Deps, a: AdminActor, expiresAt: Date, days: number) => {
  const brand = await accountMailBrand(deps, a.ctx.account, a.user.locale);
  const l = brand.locale;
  const region = await accountRegion(deps.db, a.ctx.accountId, a.user);
  const url = await appLink(deps, `/a/${a.ctx.account.slug}/admin/general?export=1`);
  await deps.mailer.send(
    noticeEmail({
      to: a.user.email,
      brand,
      subject: st('accountExport.mail.subject', { name: a.ctx.account.name }, l),
      title: st('accountExport.mail.title', undefined, l),
      hero: {
        kind: 'crate',
        caption: st('mail.obj.crate.caption', undefined, l),
        name: a.ctx.account.name,
        fields: [[st('mail.obj.crate.until', undefined, l), formatDateTime(expiresAt, {}, region)]],
        formats: ['ZIP', 'CSV', 'JSON'],
        stamp: st('mail.obj.crate.stamp', undefined, l),
      },
      lines: [
        st('accountExport.mail.body', { name: a.ctx.account.name }, l),
        st('accountExport.mail.valid', { days, date: formatDateTime(expiresAt, {}, region) }, l),
      ],
      cta: { label: st('accountExport.mail.cta', undefined, l), url },
      reason: st('accountExport.mail.reason', { name: a.ctx.account.name }, l),
    }),
  );
};

/** The sweep: exports past their time leave storage (the row stays, `expired`). */
export const expireExports = async (deps: Pick<Deps, 'db' | 'storage' | 'logger'>, now = new Date()) => {
  let n = 0;
  for (const row of await expiredExports(deps.db, now)) {
    try {
      if (row.storageKey) await deps.storage.remove(row.storageKey);
      await updateExport(deps.db, row.id, { status: 'expired', storageKey: null });
      n++;
    } catch (err) {
      deps.logger.warn({ err, exportId: row.id }, 'export cleanup failed');
    }
  }
  return n;
};
