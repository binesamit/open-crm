// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Creates a board with many items in the local E2E account (SEED_ACCOUNT_SLUG, default `demo`), for the M2 performance check
 * (`PERF=1 pnpm e2e m2-perf`). Earlier boards made by this script are moved to the trash first.
 * Usage: pnpm --filter @bines/api exec tsx scripts/seed-big-board.ts [count]   → prints the board id.
 */
import { columnTypes, newId, parseCellValue, rankBetween } from '@bines/shared';
import { and, eq, like } from 'drizzle-orm';
import { loadEnv } from '../src/env';
import { createDb } from '../src/db/client';
import { accounts, boards, cells, columns, groups, items, users, workspaces } from '../src/db/schema';

const N = Number(process.argv[2] ?? 10_000);
const PREFIX = 'ביצועים 10k';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // no .env: rely on the environment
}
const env = loadEnv(process.env);
const { db, close } = createDb(env.DATABASE_URL!);
try {
  const slug = process.env.SEED_ACCOUNT_SLUG?.trim() || 'demo';
  const account = (await db.select().from(accounts).where(eq(accounts.slug, slug)).limit(1))[0];
  if (!account) throw new Error(`no account "${slug}" — run pnpm db:seed`);
  const owner = (await db.select().from(users).where(eq(users.email, env.SEED_ADMIN_EMAIL!)).limit(1))[0];
  const ws = (await db.select().from(workspaces).where(eq(workspaces.accountId, account.id)).limit(1))[0]!;
  await db
    .update(boards)
    .set({ deletedAt: new Date() })
    .where(and(eq(boards.accountId, account.id), like(boards.name, `${PREFIX}%`)));

  const boardId = newId();
  await db.insert(boards).values({
    id: boardId,
    accountId: account.id,
    workspaceId: ws.id,
    name: `${PREFIX} · ${new Date().toISOString().slice(0, 16)}`,
    position: rankBetween(null, null),
    createdBy: owner?.id ?? null,
  });
  const groupIds: string[] = [];
  let gp: string | null = null;
  const colors = ['blue', 'forest', 'orange', 'purple', 'red'] as const;
  for (let i = 0; i < 5; i++) {
    gp = rankBetween(gp, null);
    const id = newId();
    groupIds.push(id);
    await db
      .insert(groups)
      .values({ id, accountId: account.id, boardId, title: `קבוצה ${i + 1}`, color: colors[i], position: gp });
  }
  const defs = [
    { key: 'name', type: 'name', title: 'שם', settings: {} },
    { key: 'status', type: 'status', title: 'סטטוס', settings: columnTypes.get('status')!.defaultSettings as object },
    { key: 'amount', type: 'numbers', title: 'סכום', settings: { unit: { symbol: '₪', direction: 'left' } } },
    { key: 'due', type: 'date', title: 'תאריך יעד', settings: {} },
    { key: 'owner', type: 'people', title: 'אחראי', settings: {} },
    { key: 'note', type: 'text', title: 'הערה', settings: {} },
  ];
  const colIds = new Map<string, string>();
  let cp: string | null = null;
  for (const d of defs) {
    cp = rankBetween(cp, null);
    const id = newId();
    colIds.set(d.key, id);
    await db.insert(columns).values({
      id,
      accountId: account.id,
      boardId,
      key: d.key,
      type: d.type,
      title: d.title,
      settings: d.settings,
      position: cp,
    });
  }

  let pos: string | null = null;
  for (let start = 0; start < N; start += 1000) {
    const itemRows: (typeof items.$inferInsert)[] = [];
    const cellRows: (typeof cells.$inferInsert)[] = [];
    for (let i = start; i < Math.min(N, start + 1000); i++) {
      const id = newId();
      pos = rankBetween(pos, null);
      itemRows.push({
        id,
        accountId: account.id,
        boardId,
        groupId: groupIds[i % 5]!,
        position: pos,
        name: `פריט ${i + 1}`,
      });
      const values: Record<string, unknown> = {
        status: { index: i % 3 },
        amount: (i * 37) % 5000,
        due: { date: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}` },
        ...(owner ? { owner: { persons_and_teams: i % 2 ? [{ id: owner.id, kind: 'person' }] : [] } } : {}),
        note: `הערה ${i % 97}`,
      };
      for (const [key, raw] of Object.entries(values)) {
        const d = defs.find((x) => x.key === key)!;
        const def = columnTypes.get(d.type)!;
        const parsed = parseCellValue(def, { ...(def.defaultSettings as object), ...d.settings }, raw);
        if (!parsed.ok) throw new Error(`${key}: ${parsed.error}`);
        cellRows.push({
          itemId: id,
          columnId: colIds.get(key)!,
          accountId: account.id,
          boardId,
          value: parsed.value as Record<string, never>,
          ...parsed.derived,
        });
      }
    }
    await db.insert(items).values(itemRows);
    await db.insert(cells).values(cellRows);
  }
  process.stdout.write(`${boardId}\n`);
} finally {
  await close();
}
