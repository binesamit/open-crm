// SPDX-License-Identifier: AGPL-3.0-only
/**
 * D26 one-off (library half; the CLI is fix-mcp-automations.ts) — rebuilds the seed automations that waited for
 * `{{MCP_URL}}` / `mcp:*` from built-in actions, in the accounts that already loaded them (automations:seed):
 *   L3  lead won → create the client item (contact, phone, email) and link it both ways (only if no client yet)
 *   S3c P1 → SLA date = now + 4 hours   (+ S3d, new: P2 → now + 24 hours)
 *   T1  task's project set → copy the project's client into the task's client relation (copy_from_linked)
 *   Q1  stays a webhook to n8n (Morning): its placeholder becomes {{N8N_URL}} — paste the n8n URL in the builder.
 * The recipes come from the private recipes folder (SEED_AUTOMATIONS_DIR — the same data the seeder loads), resolved
 * on each account's own boards; nothing account-specific is in code. A copy someone already changed by hand (its
 * recipe no longer holds the old webhook / extension) is left alone. Rebuilt automations stay inactive — the admin
 * switches each on after a test.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull } from 'drizzle-orm';
import { newId, normalizeRecipe, type Recipe, recipeText, validateRecipe } from '@bines/shared';
import type { Db } from '../src/db/client';
import { accounts, automations, boards, columns, groups } from '../src/db/schema';
import { recordEvent } from '../src/modules/activity/activity.repo';
import { loadSeedAutomations, seedAutomationsDir, type SeedAutomation } from './seed-automations-dir';

type Template = { key: string; name: string; existing_board_id?: number | string | null };
type Seeds = Map<string, SeedAutomation>;

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../seed');
const templates = new Map<string, Template>(
  readdirSync(join(root, 'templates'))
    .filter((f) => f.endsWith('.json') && f !== 'README.json')
    .map((f) => JSON.parse(readFileSync(join(root, 'templates', f), 'utf8')) as Template)
    .filter((t) => t.key)
    .map((t) => [t.key, t]),
);

/** The seed keys rebuilt here, and how to recognise a copy still waiting for the old MCP endpoint. */
const REBUILT = ['L3', 'S3c', 'T1'] as const;
const stillOld = (recipe: unknown) =>
  /\{\{MCP_URL\}\}|"run_extension"|mcp:task\.inherit_account/.test(JSON.stringify(recipe));

export type Line = { account: string; key: string; result: string; issues?: string[] };

type ColumnRow = typeof columns.$inferSelect;

/**
 * Fixes every account (or the one with `slug`) inside `db` — the caller owns the transaction (dry run = roll back).
 * The recipes come from `seedsDir` (default SEED_AUTOMATIONS_DIR); none configured = an error, nothing changes.
 */
export const fixMcpAutomations = async (db: Db, slug?: string, seedsDir?: string) => {
  const dir = seedAutomationsDir(seedsDir);
  if (!dir) throw new Error('set SEED_AUTOMATIONS_DIR to the folder of the seed automation recipes');
  const seeds: Seeds = new Map(loadSeedAutomations(dir).map((s) => [s.id, s]));
  const report: Line[] = [];
  const list = await db
    .select()
    .from(accounts)
    .where(slug ? eq(accounts.slug, slug) : undefined);
  if (slug && !list.length) throw new Error(`no account "${slug}"`);
  for (const account of list) await fixAccount(db, account, report, seeds);
  return report;
};

const fixAccount = async (db: Db, account: typeof accounts.$inferSelect, report: Line[], seeds: Seeds) => {
  const rows = await db
    .select()
    .from(automations)
    .where(and(eq(automations.accountId, account.id), isNull(automations.deletedAt)));
  const bySeed = new Map(rows.filter((r) => r.seedKey).map((r) => [r.seedKey!, r]));
  if (![...REBUILT, 'Q1'].some((k) => bySeed.has(k))) return; // this account never loaded the seed automations

  const accountBoards = await db
    .select()
    .from(boards)
    .where(and(eq(boards.accountId, account.id), isNull(boards.deletedAt), isNull(boards.parentBoardId)));
  const boardOf = (key: string) => {
    const t = templates.get(key);
    if (!t) return null;
    const bySourceId = t.existing_board_id
      ? accountBoards.find((b) => b.sourceBoardId !== null && String(b.sourceBoardId) === String(t.existing_board_id))
      : undefined;
    return bySourceId ?? accountBoards.find((b) => b.name.trim() === t.name.trim()) ?? null;
  };
  const columnsOf = (boardId: string) =>
    db
      .select()
      .from(columns)
      .where(and(eq(columns.boardId, boardId), isNull(columns.deletedAt)));
  const line = (key: string, result: string, issues?: string[]) =>
    report.push({ account: account.slug, key, result, ...(issues?.length ? { issues } : {}) });

  /** The seed recipe on this account's board (+ issues), with T1's target found by its link when the key differs. */
  const build = async (key: string, boardId: string) => {
    const seed = seeds.get(key)!;
    const cols = await columnsOf(boardId);
    const grps = await db
      .select()
      .from(groups)
      .where(and(eq(groups.boardId, boardId), isNull(groups.deletedAt)));
    const normalized = normalizeRecipe(seed, {
      columns: cols.map((c) => ({ key: c.key, title: c.title, type: c.type })),
      resolveBoard: (ref) => (ref.startsWith('@') ? null : (boardOf(ref)?.id ?? null)),
    });
    if (!normalized.ok) return { error: normalized.error } as const;
    const recipe = normalized.recipe;
    const notes: string[] = normalized.unresolved.map((u) => `unresolved ${u}`);
    for (const a of recipe.actions) {
      if (a.type === 'copy_from_linked' && !cols.some((c) => c.key === a.column)) {
        const found = await relationLike(db, cols, a.relation, a.source);
        if (found) {
          notes.push(`target column "${a.column}" → "${found.key}" (${found.title})`);
          a.column = found.key;
        }
      }
      if (a.type === 'create_item') {
        const target = await columnsOf(a.board);
        const missing = [
          ...Object.keys(a.mapping ?? {}),
          ...(a.connect_back_column ? [a.connect_back_column] : []),
        ].filter((k) => k !== 'name' && !target.some((c) => c.key === k));
        if (missing.length) notes.push(`target board lacks columns: ${missing.join(', ')}`);
      }
    }
    const { errors, warnings } = validateRecipe(recipe, {
      columns: cols.map((c) => ({
        key: c.key,
        type: c.type,
        title: c.title,
        settings: c.settings as Record<string, unknown>,
      })),
      groups: grps.map((g) => ({ id: g.id, title: g.title })),
    });
    const issues = [
      ...errors.map((e) => `${e.code} ${e.path}${e.detail ? ` (${e.detail})` : ''}`),
      ...warnings.map((w) => `${w.code} ${w.path}${w.detail ? ` (${w.detail})` : ''}`),
      ...notes,
    ];
    const title = (
      seed.title ??
      recipeText(recipe, {
        columns: cols.map((c) => ({ key: c.key, title: c.title, type: c.type })),
        groups: grps.map((g) => ({ id: g.id, title: g.title })),
        boardName: (id) => accountBoards.find((b) => b.id === id)?.name,
      })
    ).slice(0, 255);
    return { recipe, errors: errors.length, issues, title, note: seed.note ?? null } as const;
  };

  const writeEvent = (id: string, boardId: string | null, type: string, seedKey: string) =>
    recordEvent(db, {
      accountId: account.id,
      type,
      actorId: null,
      actorType: 'system',
      boardId,
      meta: { automation_id: id, seed_key: seedKey, source: 'fix-mcp-automations' },
    });

  for (const key of REBUILT) {
    const row = bySeed.get(key);
    if (!row?.boardId) {
      line(key, 'not loaded in this account (automations:seed) — skipped');
      continue;
    }
    if (!stillOld(row.recipe)) {
      line(key, 'already changed by hand — left as is');
      continue;
    }
    const built = await build(key, row.boardId);
    if ('error' in built) {
      line(key, `cannot build: ${built.error}`);
      continue;
    }
    await db
      .update(automations)
      .set({
        recipe: built.recipe as never,
        title: built.title,
        note:
          [built.note, built.issues.length ? `fix: ${built.issues.join('; ')}` : null].filter(Boolean).join('\n') ||
          null,
        isActive: false,
        deactivatedReason: built.errors ? 'needs_fixing' : null,
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(automations.id, row.id));
    await writeEvent(row.id, row.boardId, 'automation.updated', key);
    line(
      key,
      built.errors ? 'rebuilt (still needs fixing)' : 'rebuilt (inactive — switch on after a test)',
      built.issues,
    );
  }

  // S3d is new (the P2 half of the old S3c): added next to S3c, like the seeder would.
  const s3c = bySeed.get('S3c');
  if (s3c?.boardId && !bySeed.has('S3d')) {
    const built = await build('S3d', s3c.boardId);
    if ('error' in built) line('S3d', `cannot build: ${built.error}`);
    else {
      const id = newId();
      await db.insert(automations).values({
        id,
        accountId: account.id,
        boardId: s3c.boardId,
        title: built.title,
        recipe: built.recipe as Recipe as never,
        isActive: false,
        ownerId: s3c.ownerId,
        createdBy: s3c.ownerId,
        seedKey: 'S3d',
        note:
          [built.note, built.issues.length ? `fix: ${built.issues.join('; ')}` : null].filter(Boolean).join('\n') ||
          null,
        deactivatedReason: built.errors ? 'needs_fixing' : null,
      });
      await writeEvent(id, s3c.boardId, 'automation.created', 'S3d');
      line('S3d', 'added (inactive — switch on after a test)', built.issues);
    }
  }

  // Q1 stays a webhook to n8n: only its placeholder and note change; the admin pastes the URL in the builder.
  const q1 = bySeed.get('Q1');
  if (q1 && JSON.stringify(q1.recipe).includes('{{MCP_URL}}')) {
    const recipe = JSON.parse(JSON.stringify(q1.recipe).replaceAll('{{MCP_URL}}', '{{N8N_URL}}')) as Recipe;
    await db
      .update(automations)
      .set({
        recipe: recipe as never,
        note: seeds.get('Q1')?.note ?? q1.note,
        deactivatedReason: 'needs_fixing',
        revision: q1.revision + 1,
        updatedAt: new Date(),
      })
      .where(eq(automations.id, q1.id));
    await writeEvent(q1.id, q1.boardId, 'automation.updated', 'Q1');
    line('Q1', 'webhook kept — paste the n8n URL in the builder ({{N8N_URL}} placeholder)');
  } else if (q1) line('Q1', 'already has its URL — left as is');
};

/**
 * T1's target on a board whose key differs from the template's: a relation column (not the trigger's relation)
 * that links to the same board as the source relation on the linked board.
 */
const relationLike = async (db: Db, cols: ColumnRow[], relationKey: string, sourceKey: string) => {
  const rel = cols.find((c) => c.key === relationKey);
  const linkedBoardId = ((rel?.settings as { board_ids?: string[] } | undefined)?.board_ids ?? [])[0];
  if (!linkedBoardId) return null;
  const source = (
    await db
      .select()
      .from(columns)
      .where(and(eq(columns.boardId, linkedBoardId), eq(columns.key, sourceKey), isNull(columns.deletedAt)))
      .limit(1)
  )[0];
  const wanted = ((source?.settings as { board_ids?: string[] } | undefined)?.board_ids ?? [])[0];
  if (!wanted) return null;
  return (
    cols.find(
      (c) =>
        c.type === 'board_relation' &&
        c.key !== relationKey &&
        ((c.settings as { board_ids?: string[] }).board_ids ?? []).includes(wanted),
    ) ?? null
  );
};
