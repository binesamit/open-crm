// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { aiUsage, boards, dashboards, docs, folders } from '../../db/schema';
import { listWorkspaces } from '../boards/boards.repo';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';

const has = async (db: Db, table: typeof boards | typeof dashboards | typeof docs | typeof folders, ws: string) =>
  (
    await db
      .select({ n: sql<number>`1` })
      .from(table)
      .where(and(eq(table.workspaceId, ws), isNull(table.deletedAt)))
      .limit(1)
  ).length > 0;

/**
 * The account's first workspace when nothing was made in it yet (a sign-up's "main workspace"): a kit or a
 * blueprint is built into it instead of leaving an empty one beside the new one.
 */
export const emptyFirstWorkspace = async (db: Db, accountId: string) => {
  const [first] = await listWorkspaces(db, accountId);
  if (!first) return null;
  for (const table of [boards, dashboards, docs, folders]) if (await has(db, table, first.id)) return null;
  return first;
};

/** What the platform paid for this account's AI set-up (`ai_usage` source `onboarding`), in USD. */
export const onboardingSpend = async (db: Db, accountId: string) => {
  const [row] = await db
    .select({ cost: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)` })
    .from(aiUsage)
    .where(and(eq(aiUsage.accountId, accountId), eq(aiUsage.source, 'onboarding')));
  return Number(row?.cost ?? 0);
};

/** Keeps the sample rows a kit / blueprint made (account settings `onboarding.sample_item_ids`, newest last). */
export const rememberSampleItems = async (db: Db, accountId: string, ids: string[]) => {
  const stored = (await getAccountSettings(db, accountId)) as Record<string, unknown>;
  const onboarding = (stored.onboarding ?? {}) as { sample_item_ids?: string[] };
  const all = [...new Set([...(onboarding.sample_item_ids ?? []), ...ids])].slice(-5000);
  await upsertAccountSettings(db, accountId, { ...stored, onboarding: { ...onboarding, sample_item_ids: all } });
};

/** Forgets them (after "delete the sample data"). */
export const forgetSampleItems = async (db: Db, accountId: string) => {
  const stored = (await getAccountSettings(db, accountId)) as Record<string, unknown>;
  const onboarding = (stored.onboarding ?? {}) as Record<string, unknown>;
  await upsertAccountSettings(db, accountId, { ...stored, onboarding: { ...onboarding, sample_item_ids: [] } });
};
