// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable no-console -- a CLI maintenance script: its output is the report. */
/**
 * Local maintenance: soft-delete the boards that E2E runs leave behind in the local E2E account
 * (thousands of `… mu4x9k2a` boards slow the sidebar down and break tests).
 *
 * A board is a test leftover only when ALL hold:
 *   - top level (no parent board — sub-boards stay with their board), not already deleted, account slug = SEED_ACCOUNT_SLUG
 *     (default `demo`, the slug the E2E specs use);
 *   - its name has a random-suffix token: a whole word of 5+ chars of [0-9a-z] with at least one digit, or a
 *     `Date.now().toString(36)` stamp of these years (8 chars from `mr…` to `mz…`, digits or not — `mutjkssb`)
 *     (`Date.now().toString(36)` / `Math.random().toString(36)` in the specs) — the 19-board kit has none;
 *   - created more than 2 hours ago (never a board of a run in progress).
 *
 * Soft delete only (`deleted_at`, the trash purge takes it later) — never DELETE.
 *
 * Workspaces E2E runs create (`יעד mu4x9k2a`, `סגור mu…`) are soft-deleted by the same rules — random-suffix name,
 * older than 2 hours — and only when every live board in them is itself a test leftover (or there is none): a
 * workspace that holds any other board is never touched. Hundreds of them slowed the sidebar down.
 *
 * Docs, dashboards and folders E2E runs create (hundreds of `מסמך mu…` rows made the sidebar freeze) follow the
 * same rules: random-suffix name, older than 2 hours. Docs: only workspace docs (a doc that belongs to a board, an
 * item or a column stays with it). Folders: only when everything still live in them — boards, docs, dashboards,
 * sub-folders — is itself a test leftover (checked bottom-up); a folder holding anything else is never touched.
 *
 * Items E2E runs add to the boards that stay (the kit's לידים, לקוחות, … — `ליד mu4x9k2a`) are **archived**
 * (`archived_at`, restorable from the archive) by the same rules: top-level item, random-suffix name, older than
 * 2 hours. Above ~400 rows a table virtualizes and the specs that look for their row fail.
 *
 * Usage (local databases only — refuses any DATABASE_URL host other than localhost / 127.0.0.1):
 *   pnpm --filter @bines/api exec tsx scripts/cleanup-local-test-data.ts           # dry run: counts + 20 samples
 *   pnpm --filter @bines/api exec tsx scripts/cleanup-local-test-data.ts --apply   # soft-deletes them
 */
import { and, eq, inArray, isNull, lt } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { accounts, boards, dashboards, docs, folders, items, workspaces } from '../src/db/schema';

const APPLY = process.argv.includes('--apply');
const MIN_AGE_MS = 2 * 60 * 60 * 1000;
/** A whole word, 5+ chars of [0-9a-z], at least one digit. */
const RANDOM_SUFFIX = /(?:^|\s)(?=[0-9a-z]*[0-9])[0-9a-z]{5,}(?=\s|$)/;
/** A base-36 millisecond stamp of 2025–2027 as a whole word (`mutjkssb`): no digit needed. */
const TIME_STAMP = /(?:^|\s)m[r-z][0-9a-z]{6}(?=\s|$)/;

const isTestBoardName = (name: string) => RANDOM_SUFFIX.test(name) || TIME_STAMP.test(name);

const main = async () => {
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url));
  } catch {
    // no .env: rely on the environment
  }
  const SLUG = process.env.SEED_ACCOUNT_SLUG?.trim() || 'demo';
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1'].includes(host)) {
    throw new Error(`refusing to touch ${host}: local databases only (localhost / 127.0.0.1)`);
  }

  const { db, close } = createDb(url);
  try {
    const [account] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.slug, SLUG));
    if (!account) throw new Error(`no account with slug ${SLUG}`);
    const live = await db
      .select({ id: boards.id, name: boards.name, createdAt: boards.createdAt })
      .from(boards)
      .where(and(eq(boards.accountId, account.id), isNull(boards.parentBoardId), isNull(boards.deletedAt)));
    const cutoff = new Date(Date.now() - MIN_AGE_MS);
    const old = live.filter((b) => b.createdAt < cutoff);
    const targets = old.filter((b) => isTestBoardName(b.name));
    const kept = live.filter((b) => !targets.includes(b));

    console.log(`account ${SLUG}: ${live.length} live top-level boards`);
    console.log(`  test leftovers (random suffix, older than 2h): ${targets.length}`);
    console.log(`  kept: ${kept.length}`);
    console.log('sample of what would be soft-deleted:');
    for (const b of targets.slice(0, 20)) console.log(`  - ${b.name}  (${b.createdAt.toISOString()})`);
    console.log('sample of what stays:');
    for (const b of kept.filter((b) => !isTestBoardName(b.name)).slice(0, 20)) console.log(`  + ${b.name}`);

    // Test workspaces: random-suffix name, older than 2h, and no live board in them but test leftovers (and
    // their sub-boards).
    const liveWorkspaces = await db
      .select({ id: workspaces.id, name: workspaces.name, createdAt: workspaces.createdAt })
      .from(workspaces)
      .where(and(eq(workspaces.accountId, account.id), isNull(workspaces.deletedAt)));
    const allLiveBoards = await db
      .select({
        id: boards.id,
        parentId: boards.parentBoardId,
        workspaceId: boards.workspaceId,
        folderId: boards.folderId,
      })
      .from(boards)
      .where(and(eq(boards.accountId, account.id), isNull(boards.deletedAt)));
    const targetIds = new Set(targets.map((b) => b.id));
    const holdsReal = new Set(
      allLiveBoards
        .filter((b) => !targetIds.has(b.id) && !(b.parentId && targetIds.has(b.parentId)))
        .map((b) => b.workspaceId),
    );
    const wsTargets = liveWorkspaces.filter(
      (w) => w.createdAt < cutoff && isTestBoardName(w.name) && !holdsReal.has(w.id),
    );
    console.log(
      `\nworkspaces: ${liveWorkspaces.length} live; test leftovers (no other board in them): ${wsTargets.length}`,
    );
    for (const w of wsTargets.slice(0, 20)) console.log(`  - ${w.name}  (${w.createdAt.toISOString()})`);
    console.log('sample of workspaces that stay:');
    for (const w of liveWorkspaces.filter((w) => !wsTargets.includes(w)).slice(0, 20)) console.log(`  + ${w.name}`);

    // Test docs (workspace docs only), dashboards and folders.
    const liveDocs = await db
      .select({
        id: docs.id,
        name: docs.name,
        createdAt: docs.createdAt,
        folderId: docs.folderId,
        boardId: docs.boardId,
        itemId: docs.itemId,
        columnId: docs.columnId,
      })
      .from(docs)
      .where(and(eq(docs.accountId, account.id), isNull(docs.deletedAt)));
    const docTargets = liveDocs.filter(
      (d) => !d.boardId && !d.itemId && !d.columnId && d.createdAt < cutoff && isTestBoardName(d.name),
    );
    const liveDashboards = await db
      .select({
        id: dashboards.id,
        name: dashboards.name,
        createdAt: dashboards.createdAt,
        folderId: dashboards.folderId,
      })
      .from(dashboards)
      .where(and(eq(dashboards.accountId, account.id), isNull(dashboards.deletedAt)));
    const dashTargets = liveDashboards.filter((d) => d.createdAt < cutoff && isTestBoardName(d.name));
    const liveFolders = await db
      .select({ id: folders.id, name: folders.name, createdAt: folders.createdAt, parentId: folders.parentFolderId })
      .from(folders)
      .where(and(eq(folders.accountId, account.id), isNull(folders.deletedAt)));
    // A folder goes only when all it still holds goes: anything else in it (or in a sub-folder that stays) keeps it.
    const docGone = new Set(docTargets.map((d) => d.id));
    const dashGone = new Set(dashTargets.map((d) => d.id));
    const keepsFolder = new Set<string>();
    for (const b of allLiveBoards)
      if (b.folderId && !targetIds.has(b.id) && !(b.parentId && targetIds.has(b.parentId))) keepsFolder.add(b.folderId);
    for (const d of liveDocs) if (d.folderId && !docGone.has(d.id)) keepsFolder.add(d.folderId);
    for (const d of liveDashboards) if (d.folderId && !dashGone.has(d.id)) keepsFolder.add(d.folderId);
    const folderCandidate = (f: (typeof liveFolders)[number]) => f.createdAt < cutoff && isTestBoardName(f.name);
    for (const f of liveFolders) if (!folderCandidate(f)) keepsFolder.add(f.id);
    // A kept folder keeps its parents (bottom-up).
    const parentOf = new Map(liveFolders.map((f) => [f.id, f.parentId]));
    for (const id of [...keepsFolder]) {
      let p = parentOf.get(id) ?? null;
      while (p && !keepsFolder.has(p)) {
        keepsFolder.add(p);
        p = parentOf.get(p) ?? null;
      }
    }
    const folderTargets = liveFolders.filter((f) => !keepsFolder.has(f.id));
    for (const [label, all, gone] of [
      ['docs', liveDocs, docTargets],
      ['dashboards', liveDashboards, dashTargets],
      ['folders', liveFolders, folderTargets],
    ] as const) {
      console.log(`\n${label}: ${all.length} live; test leftovers: ${gone.length}`);
      for (const x of gone.slice(0, 12)) console.log(`  - ${x.name}  (${x.createdAt.toISOString()})`);
      console.log(`sample of ${label} that stay:`);
      for (const x of all.filter((y) => !(gone as readonly { id: string }[]).some((g) => g.id === y.id)).slice(0, 12))
        console.log(`  + ${x.name}`);
    }

    // Test items on the boards that stay.
    const keptIds = kept.map((b) => b.id);
    const liveItems: { id: string; name: string; boardId: string; createdAt: Date }[] = [];
    for (let i = 0; i < keptIds.length; i += 500)
      liveItems.push(
        ...(await db
          .select({ id: items.id, name: items.name, boardId: items.boardId, createdAt: items.createdAt })
          .from(items)
          .where(
            and(
              eq(items.accountId, account.id),
              inArray(items.boardId, keptIds.slice(i, i + 500)),
              isNull(items.parentItemId),
              isNull(items.deletedAt),
              isNull(items.archivedAt),
            ),
          )),
      );
    const itemTargets = liveItems.filter((it) => it.createdAt < cutoff && isTestBoardName(it.name));
    const boardName = new Map(kept.map((b) => [b.id, b.name]));
    const perBoard = new Map<string, number>();
    for (const it of itemTargets) perBoard.set(it.boardId, (perBoard.get(it.boardId) ?? 0) + 1);
    console.log(`\ntest items on the boards that stay (random suffix, older than 2h): ${itemTargets.length}`);
    for (const [id, n] of [...perBoard].sort((a, b) => b[1] - a[1]).slice(0, 15))
      console.log(`  ${boardName.get(id)}: ${n}`);
    console.log('sample of items that would be archived:');
    for (const it of itemTargets.slice(0, 20)) console.log(`  - ${it.name}`);
    console.log('sample of items that stay:');
    for (const it of liveItems.filter((it) => !isTestBoardName(it.name)).slice(0, 10)) console.log(`  + ${it.name}`);

    if (!APPLY) {
      console.log(
        '\ndry run — nothing changed. Re-run with --apply to soft-delete the boards, workspaces, docs, dashboards and folders and archive the items.',
      );
      return;
    }
    const now = new Date();
    const ids = targets.map((b) => b.id);
    for (let i = 0; i < ids.length; i += 500) {
      await db
        .update(boards)
        .set({ deletedAt: now })
        .where(
          and(
            eq(boards.accountId, account.id),
            inArray(boards.id, ids.slice(i, i + 500)),
            lt(boards.createdAt, cutoff),
          ),
        );
    }
    const after = await db
      .select({ id: boards.id })
      .from(boards)
      .where(and(eq(boards.accountId, account.id), isNull(boards.parentBoardId), isNull(boards.deletedAt)));
    console.log(`\nsoft-deleted ${ids.length}; live top-level boards: ${live.length} → ${after.length}`);
    const itemIds = itemTargets.map((it) => it.id);
    for (let i = 0; i < itemIds.length; i += 500)
      await db
        .update(items)
        .set({ archivedAt: now })
        .where(
          and(
            eq(items.accountId, account.id),
            inArray(items.id, itemIds.slice(i, i + 500)),
            isNull(items.archivedAt),
            lt(items.createdAt, cutoff),
          ),
        );
    console.log(`archived ${itemIds.length} test items`);
    const wsIds = wsTargets.map((w) => w.id);
    for (let i = 0; i < wsIds.length; i += 500)
      await db
        .update(workspaces)
        .set({ deletedAt: now })
        .where(
          and(
            eq(workspaces.accountId, account.id),
            inArray(workspaces.id, wsIds.slice(i, i + 500)),
            isNull(workspaces.deletedAt),
            lt(workspaces.createdAt, cutoff),
          ),
        );
    console.log(
      `soft-deleted ${wsIds.length} test workspaces; live: ${liveWorkspaces.length} → ${liveWorkspaces.length - wsIds.length}`,
    );
    const softDelete = async (
      table: typeof docs | typeof dashboards | typeof folders,
      list: readonly { id: string }[],
    ) => {
      const ids = list.map((x) => x.id);
      for (let i = 0; i < ids.length; i += 500)
        await db
          .update(table)
          .set({ deletedAt: now })
          .where(
            and(
              eq(table.accountId, account.id),
              inArray(table.id, ids.slice(i, i + 500)),
              isNull(table.deletedAt),
              lt(table.createdAt, cutoff),
            ),
          );
      return ids.length;
    };
    console.log(`soft-deleted ${await softDelete(docs, docTargets)} test docs`);
    console.log(`soft-deleted ${await softDelete(dashboards, dashTargets)} test dashboards`);
    console.log(`soft-deleted ${await softDelete(folders, folderTargets)} test folders`);
  } finally {
    await close();
  }
};

await main();
