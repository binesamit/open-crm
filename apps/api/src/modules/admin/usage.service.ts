// SPDX-License-Identifier: AGPL-3.0-only
import { SERVICE_TOKEN_PREFIX, type Usage, usageQuerySchema } from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import {
  automationRunStats,
  boardsTotal,
  dailyCounts,
  itemsTotal,
  memberActivity,
  recentTokens,
  storageStats,
  tokensUsedSince,
  topAutomations,
  webhookStats,
} from './admin.repo';
import { type AdminActor } from './security.service';
import { assertAccountAdmin } from '../../lib/account-admin';

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * GET /usage (08 §8, account admin A5): numbers for the last N days, computed on the fly from the tables (no
 * `usage_daily` rollup yet): automation runs and failures, webhook deliveries, storage, items, active people, the
 * busiest automations and the tokens used last. API calls are not counted per request → null.
 */
export const getUsage = async (db: Db, a: AdminActor, raw: z.input<typeof usageQuerySchema>): Promise<Usage> => {
  assertAccountAdmin(a.ctx);
  const { days } = usageQuerySchema.parse(raw);
  const now = new Date();
  // From the start of the first day (UTC) of the period, today included.
  const from = new Date(`${isoDay(new Date(now.getTime() - (days - 1) * DAY))}T00:00:00.000Z`);
  const id = a.ctx.accountId;
  const [runs, hooks, daily, storage, itemCount, boardCount, people, autos, tokens, tokensUsed] = await Promise.all([
    automationRunStats(db, id, from),
    webhookStats(db, id, from),
    dailyCounts(db, id, from),
    storageStats(db, id),
    itemsTotal(db, id),
    boardsTotal(db, id),
    memberActivity(db, id, from),
    topAutomations(db, id, from),
    recentTokens(db, id),
    tokensUsedSince(db, id, from),
  ]);
  const series = Array.from({ length: days }, (_, i) => {
    const day = isoDay(new Date(from.getTime() + i * DAY));
    return { day, automation_runs: daily.runs.get(day) ?? 0, webhook_deliveries: daily.hooks.get(day) ?? 0 };
  });
  return {
    from: from.toISOString(),
    to: now.toISOString(),
    days,
    automation_runs: runs.runs,
    automation_failures: runs.failures,
    api_calls: null,
    tokens_used: tokensUsed,
    webhook_deliveries: hooks.total,
    webhook_failures: hooks.failures,
    storage_bytes: storage.bytes,
    files: storage.files,
    items_total: itemCount,
    boards_total: boardCount,
    active_users: people.active,
    members_total: people.total,
    daily: series,
    top_automations: autos.map((r) => ({
      id: r.id,
      title: r.title,
      board_id: r.boardId,
      board_name: r.boardName ?? null,
      runs: Number(r.runs),
      failures: Number(r.failures),
      last_run_at: r.lastRunAt?.toISOString() ?? null,
      is_active: r.isActive,
    })),
    top_tokens: tokens.map((r) => ({
      id: r.id,
      name: r.name,
      prefix: r.prefix,
      user_name: r.userName ?? null,
      service: r.prefix.startsWith(SERVICE_TOKEN_PREFIX),
      last_used_at: r.lastUsedAt?.toISOString() ?? null,
    })),
  };
};
