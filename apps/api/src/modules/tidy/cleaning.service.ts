// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  newId,
  TIDY_RULE_KEYS,
  type TidyPreview,
  type TidyRuleKey,
  type TidyRuleResult,
  type TidyRules,
  type TidyRun,
  type TidySample,
  type TidySettings,
  tidyRulesOf,
  toCsv,
  type UpdateTidyRules,
  updateTidyRulesSchema,
} from '@bines/shared';
import { accountClosed } from '../billing/entitlements';
import type { Db } from '../../db/client';
import type { Logger } from '../../lib/logger';
import type { RequestMeta } from '../../types';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import { recordEvent, recordEvents } from '../activity/activity.repo';
import { type AdminActor } from '../admin/security.service';
import { recordAudit } from '../audit/audit.repo';
import { hasActiveOwner } from '../boards/boards.repo';
import { purgeAutoVersions } from '../docs/docs.repo';
import {
  activeAccountIds,
  archiveBoardNow,
  archiveItemsNow,
  countActivity,
  countAgentSteps,
  countAutoVersions,
  countDoneItems,
  countExpiredOauth,
  countNotifications,
  countTrash,
  deleteActivityPage,
  deleteAgentSteps,
  deleteExpiredOauth,
  deleteNotifications,
  doneItems,
  findRun,
  idleBoards,
  insertRun,
  listRuns,
  makeTrashDue,
  purgeGlobalExpired,
  trashSample,
} from './tidy.repo';
import { assertAccountAdmin } from '../../lib/account-admin';

/**
 * Administration → סדר וניקיון → ניקוי מתוזמן (M8 ד13, 08 §9): account rules run daily by the worker job
 * `tidy.scheduled_cleaning` (api process, D21 — it uses the same services as the routes), or now by an admin. Each
 * rule has a dry run (counts + a sample, nothing changes). Every real run is a `tidy_runs` row (the last-run report and
 * its CSV) and a `tidy.run` audit row. Archiving writes `item.archived` / `board.archived` events as `system`, so the
 * archive page restores them as usual. Boards without an active owner are never archived.
 */
const DAY = 86_400_000;
/** Per run and rule: content changes are bounded (the next day's run continues). */
const MAX_ITEMS = 5000;
const MAX_BOARDS = 200;
const ACTIVITY_PAGE = 5000;
const ACTIVITY_PAGES = 20;
const SAMPLE = 50;
const DETAILS_MAX = 2000;

const cutoff = (now: Date, days: number) => new Date(now.getTime() - days * DAY);

type Tidy = { rules?: unknown; updated_by?: string | null };
const tidyOf = (settings: Record<string, unknown>): Tidy =>
  settings.tidy && typeof settings.tidy === 'object' ? (settings.tidy as Tidy) : {};

export const rulesOfAccount = async (db: Db, accountId: string) => {
  const tidy = tidyOf(await getAccountSettings(db, accountId));
  return { rules: tidyRulesOf(tidy.rules), updatedBy: tidy.updated_by ?? null };
};

const runDto = (r: Awaited<ReturnType<typeof listRuns>>[number]): TidyRun => ({
  id: r.run.id,
  trigger: r.run.trigger as TidyRun['trigger'],
  status: r.run.status as TidyRun['status'],
  results: r.run.results as TidyRuleResult[],
  actor_name: r.actorName ?? null,
  started_at: r.run.startedAt.toISOString(),
  finished_at: r.run.finishedAt.toISOString(),
});

/** GET /admin/tidy/rules */
export const getTidySettings = async (db: Db, a: AdminActor): Promise<TidySettings> => {
  assertAccountAdmin(a.ctx);
  const [{ rules }, last] = await Promise.all([rulesOfAccount(db, a.ctx.accountId), listRuns(db, a.ctx.accountId, 1)]);
  return { rules, last_run: last[0] ? runDto(last[0]) : null };
};

/** PUT /admin/tidy/rules — only what was sent changes; audited `tidy.rules_changed`. */
export const updateTidyRules = async (db: Db, a: AdminActor, raw: UpdateTidyRules, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  const patch = updateTidyRulesSchema.parse(raw);
  await db.transaction(async (tx) => {
    const settings = await getAccountSettings(tx, a.ctx.accountId);
    const tidy = tidyOf(settings);
    const before = tidyRulesOf(tidy.rules);
    const next = { ...before } as TidyRules;
    for (const key of TIDY_RULE_KEYS) if (patch[key]) next[key] = { ...before[key], ...patch[key] };
    const after = tidyRulesOf(next);
    const changed = TIDY_RULE_KEYS.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
    if (!changed.length) return;
    // The admin who last changed the rules is who the scheduled archiving is recorded under (archived_by).
    await upsertAccountSettings(
      tx,
      a.ctx.accountId,
      { ...settings, tidy: { rules: after, updated_by: a.user.id } },
      a.user.id,
    );
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'account.updated',
      actorId: a.user.id,
      requestId: a.requestId ?? meta.requestId,
      before: { tidy: Object.fromEntries(changed.map((k) => [k, before[k]])) },
      after: { tidy: Object.fromEntries(changed.map((k) => [k, after[k]])) },
    });
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'tidy.rules_changed',
      targetType: 'account',
      targetId: a.ctx.accountId,
      payload: {
        rules: changed,
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: Object.fromEntries(changed.map((k) => [k, after[k]])),
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return getTidySettings(db, a);
};

// ---- the rules ----
type RuleCtx = { db: Db; accountId: string; now: Date; actorId: string | null; batchId: string };
type Outcome = { count: number; details: TidySample[] };
type RuleImpl = {
  preview: (c: RuleCtx, rule: TidyRules[TidyRuleKey]) => Promise<Outcome>;
  apply: (c: RuleCtx, rule: TidyRules[TidyRuleKey]) => Promise<Outcome>;
};
const counted = (n: number): Outcome => ({ count: n, details: [] });

const RULES: Record<TidyRuleKey, RuleImpl> = {
  archive_done_items: {
    preview: async ({ db, accountId, now }, r) => {
      const before = cutoff(now, r.days);
      const [n, sample] = await Promise.all([
        countDoneItems(db, accountId, before, r.exclude_workspace_ids),
        doneItems(db, accountId, before, r.exclude_workspace_ids, SAMPLE),
      ]);
      return {
        count: n,
        details: sample.map((i) => ({ rule: 'archive_done_items', type: 'item', id: i.id, name: i.name })),
      };
    },
    apply: async ({ db, accountId, now, actorId, batchId }, r) => {
      const found = await doneItems(db, accountId, cutoff(now, r.days), r.exclude_workspace_ids, MAX_ITEMS);
      if (!found.length) return counted(0);
      await db.transaction(async (tx) => {
        await archiveItemsNow(
          tx,
          found.map((i) => i.id),
          actorId,
        );
        await recordEvents(
          tx,
          found.map((i) => ({
            accountId,
            type: 'item.archived',
            actorId,
            actorType: 'system' as const,
            boardId: i.board_id,
            itemId: i.id,
            batchId,
            before: { name: i.name, group_id: i.group_id },
            meta: { tidy_rule: 'archive_done_items' },
          })),
        );
      });
      return {
        count: found.length,
        details: found.map((i) => ({ rule: 'archive_done_items', type: 'item', id: i.id, name: i.name })),
      };
    },
  },
  archive_idle_boards: {
    preview: async ({ db, accountId, now }, r) => {
      const found = await idleBoards(db, accountId, cutoff(now, r.days), r.exclude_workspace_ids, MAX_BOARDS);
      const owned = [];
      for (const b of found) if (await hasActiveOwner(db, accountId, b.id)) owned.push(b);
      return {
        count: owned.length,
        details: owned
          .slice(0, SAMPLE)
          .map((b) => ({ rule: 'archive_idle_boards', type: 'board', id: b.id, name: b.name })),
      };
    },
    apply: async ({ db, accountId, now, actorId, batchId }, r) => {
      const found = await idleBoards(db, accountId, cutoff(now, r.days), r.exclude_workspace_ids, MAX_BOARDS);
      const done: TidySample[] = [];
      for (const b of found) {
        // A board nobody active owns is left for an admin to hand over first (tidy up → transfer ownership).
        if (!(await hasActiveOwner(db, accountId, b.id))) continue;
        await db.transaction(async (tx) => {
          await archiveBoardNow(tx, b.id, actorId);
          await recordEvent(tx, {
            accountId,
            type: 'board.archived',
            actorId,
            actorType: 'system',
            boardId: b.id,
            batchId,
            before: { name: b.name },
            meta: { tidy_rule: 'archive_idle_boards' },
          });
        });
        done.push({ rule: 'archive_idle_boards', type: 'board', id: b.id, name: b.name });
      }
      return { count: done.length, details: done };
    },
  },
  empty_trash: {
    preview: async ({ db, accountId, now }, r) => {
      const before = cutoff(now, r.days);
      const [n, sample] = await Promise.all([
        countTrash(db, accountId, before),
        trashSample(db, accountId, before, SAMPLE),
      ]);
      return {
        count: n,
        details: sample.map((t) => ({ rule: 'empty_trash', type: t.type, id: t.id, name: t.name })),
      };
    },
    apply: async ({ db, accountId, now }, r) => {
      const before = cutoff(now, r.days);
      const sample = await trashSample(db, accountId, before, DETAILS_MAX);
      const n = await makeTrashDue(db, accountId, before);
      return {
        count: n,
        details: sample.map((t) => ({ rule: 'empty_trash', type: t.type, id: t.id, name: t.name })),
      };
    },
  },
  notifications_retention: {
    preview: async ({ db, accountId, now }, r) => counted(await countNotifications(db, accountId, cutoff(now, r.days))),
    apply: async ({ db, accountId, now }, r) => counted(await deleteNotifications(db, accountId, cutoff(now, r.days))),
  },
  activity_retention: {
    preview: async ({ db, accountId, now }, r) => counted(await countActivity(db, accountId, cutoff(now, r.days))),
    apply: async ({ db, accountId, now }, r) => {
      const before = cutoff(now, r.days);
      let total = 0;
      for (let page = 0; page < ACTIVITY_PAGES; page++) {
        const n = await deleteActivityPage(db, accountId, before, ACTIVITY_PAGE);
        total += n;
        if (n < ACTIVITY_PAGE) break;
      }
      return counted(total);
    },
  },
  doc_auto_versions: {
    preview: async ({ db, accountId, now }, r) => counted(await countAutoVersions(db, accountId, cutoff(now, r.days))),
    apply: async ({ db, accountId, now }, r) => {
      const before = cutoff(now, r.days);
      const n = await countAutoVersions(db, accountId, before);
      if (n) await purgeAutoVersions(db, accountId, before);
      return counted(n);
    },
  },
  agent_run_logs: {
    preview: async ({ db, accountId, now }, r) => counted(await countAgentSteps(db, accountId, cutoff(now, r.days))),
    apply: async ({ db, accountId, now }, r) => counted(await deleteAgentSteps(db, accountId, cutoff(now, r.days))),
  },
  expired_oauth: {
    preview: async ({ db, accountId, now }, r) => counted(await countExpiredOauth(db, accountId, cutoff(now, r.days))),
    apply: async ({ db, accountId, now }, r) => counted(await deleteExpiredOauth(db, accountId, cutoff(now, r.days))),
  },
};

/** POST /admin/tidy/preview — every rule that is on (or `only`), counted now; nothing changes. */
export const previewTidy = async (
  db: Db,
  a: AdminActor,
  opts: { only?: TidyRuleKey[]; now?: Date } = {},
): Promise<TidyPreview> => {
  assertAccountAdmin(a.ctx);
  const { rules } = await rulesOfAccount(db, a.ctx.accountId);
  const keys = opts.only?.length ? opts.only : TIDY_RULE_KEYS.filter((k) => rules[k].enabled);
  const ctx: RuleCtx = { db, accountId: a.ctx.accountId, now: opts.now ?? new Date(), actorId: null, batchId: '' };
  const results: TidyRuleResult[] = [];
  const samples: TidySample[] = [];
  for (const rule of keys) {
    const out = await RULES[rule].preview(ctx, rules[rule]);
    results.push({ rule, count: out.count });
    samples.push(...out.details);
  }
  return { results, samples };
};

/**
 * One run over an account's enabled rules. A failing rule is reported (status `partial`) and the others still run.
 * Accounts with nothing enabled write no row.
 */
export const runTidy = async (
  deps: { db: Db; logger?: Logger },
  accountId: string,
  opts: { trigger: 'schedule' | 'manual'; actorId?: string | null; meta?: RequestMeta; now?: Date },
): Promise<TidyRun | null> => {
  const { db } = deps;
  const { rules, updatedBy } = await rulesOfAccount(db, accountId);
  const keys = TIDY_RULE_KEYS.filter((k) => rules[k].enabled);
  if (!keys.length) return null;
  const startedAt = new Date();
  const actorId = opts.actorId ?? updatedBy ?? null;
  const ctx: RuleCtx = { db, accountId, now: opts.now ?? startedAt, actorId, batchId: newId() };
  const results: TidyRuleResult[] = [];
  const details: TidySample[] = [];
  for (const rule of keys) {
    try {
      const out = await RULES[rule].apply(ctx, rules[rule]);
      results.push({ rule, count: out.count });
      details.push(...out.details.slice(0, Math.max(0, DETAILS_MAX - details.length)));
    } catch (err) {
      deps.logger?.error({ err, accountId, rule }, 'tidy rule failed');
      results.push({ rule, count: 0, error: (err as Error).message.slice(0, 200) });
    }
  }
  const failures = results.filter((r) => r.error).length;
  const status = !failures ? 'succeeded' : failures === results.length ? 'failed' : 'partial';
  const id = newId();
  const finishedAt = new Date();
  await insertRun(db, {
    id,
    accountId,
    trigger: opts.trigger,
    dryRun: false,
    status,
    results,
    details,
    actorId: opts.trigger === 'manual' ? actorId : null,
    startedAt,
    finishedAt,
  });
  await recordAudit(db, {
    accountId,
    actorId: opts.trigger === 'manual' ? actorId : null,
    action: 'tidy.run',
    targetType: 'tidy_run',
    targetId: id,
    payload: { trigger: opts.trigger, status, results },
    ip: opts.meta?.ip ?? null,
    userAgent: opts.meta?.userAgent ?? null,
  });
  const [row] = await listRuns(db, accountId, 1);
  return row ? runDto(row) : null;
};

/** POST /admin/tidy/run — the enabled rules, now (admin; audited). */
export const runTidyNow = async (db: Db, a: AdminActor, meta: RequestMeta, logger?: Logger) => {
  assertAccountAdmin(a.ctx);
  const run = await runTidy({ db, logger }, a.ctx.accountId, { trigger: 'manual', actorId: a.user.id, meta });
  if (!run) throw new AppError('conflict', 'no_rules_enabled');
  return run;
};

/** GET /admin/tidy/runs — the latest runs. */
export const listTidyRuns = async (db: Db, a: AdminActor) => {
  assertAccountAdmin(a.ctx);
  return (await listRuns(db, a.ctx.accountId, 30)).map(runDto);
};

/** GET /admin/tidy/runs/:id/export.csv — what one run touched, plus a line per rule. */
export const tidyRunCsv = async (db: Db, a: AdminActor, runId: string) => {
  assertAccountAdmin(a.ctx);
  const found = await findRun(db, a.ctx.accountId, runId);
  if (!found) throw new AppError('not_found', 'Run not found');
  const results = found.run.results as TidyRuleResult[];
  const details = found.run.details as TidySample[];
  return toCsv(
    ['rule', 'kind', 'id', 'name', 'count', 'error'],
    [
      ...results.map((r) => [r.rule, 'summary', '', '', r.count, r.error ?? '']),
      ...details.map((d) => [d.rule, d.type, d.id, d.name, '', '']),
    ],
  );
};

/**
 * The daily job: every active account's enabled rules, then the platform-wide expired leftovers. One account's
 * failure never stops the others.
 */
export const scheduledCleaning = async (deps: { db: Db; logger?: Logger }, now = new Date()) => {
  let runs = 0;
  for (const accountId of await activeAccountIds(deps.db)) {
    try {
      // plan-lock: a closed account's rules wait until it is reopened (nothing is archived or deleted meanwhile).
      if (await accountClosed(deps.db, accountId)) continue;
      if (await runTidy(deps, accountId, { trigger: 'schedule', now })) runs++;
    } catch (err) {
      deps.logger?.error({ err, accountId }, 'tidy.scheduled_cleaning: account failed');
    }
  }
  const global = await purgeGlobalExpired(deps.db, new Date(now.getTime() - DAY));
  return { runs, ...global };
};
