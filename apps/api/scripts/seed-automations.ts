// SPDX-License-Identifier: AGPL-3.0-only
/**
 * M6 stage 4 — loads the automation recipes of SEED_AUTOMATIONS_DIR (`*.json`, private data — not in the repository)
 * onto the boards of ONE named account (D21): every automation
 * **inactive**, owned by the account's admin, keyed by `seed_key` so a re-run adds only what is missing.
 *
 * Usage: pnpm --filter @bines/api automations:seed -- --account <slug> [--dir <recipes folder>] [--dry-run]
 *        [--owner-email <email>]
 *
 * Boards are found by their template (seed/templates/<key>.json → `existing_board_id` = the imported board's
 * `source_board_id`), then by the template's board name. Nothing is account-specific in code: the seed files
 * carry the column ids of the imported boards, and a board key no account board matches is reported, not guessed.
 * A recipe the board cannot satisfy (missing column / label, placeholder URL) is still loaded — inactive, with
 * the issues in its note — so it can be fixed in the builder.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull } from 'drizzle-orm';
import { newId, normalizeRecipe, recipeText, validateRecipe, type RecipeIssue } from '@bines/shared';
import { createDb } from '../src/db/client';
import { accountMembers, accounts, automations, boards, columns, groups, users } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { recordEvent } from '../src/modules/activity/activity.repo';
import { loadSeedAutomations, seedAutomationsDir } from './seed-automations-dir';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

type Template = { key: string; name: string; existing_board_id?: number | string | null };
type SeedAutomation = { id: string; board: string; title?: string; recipe: string; note?: string | null } & Record<
  string,
  unknown
>;

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../seed');
const templates = new Map<string, Template>(
  readdirSync(join(root, 'templates'))
    .filter((f) => f.endsWith('.json') && f !== 'README.json')
    .map((f) => JSON.parse(readFileSync(join(root, 'templates', f), 'utf8')) as Template)
    .filter((t) => t.key)
    .map((t) => [t.key, t]),
);
const main = async () => {
  const slug = option('account');
  if (!slug) throw new Error('--account <slug> is required');
  const dryRun = flag('dry-run');
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url));
  } catch {
    // Railway: the real environment
  }
  const dir = seedAutomationsDir(option('dir'));
  if (!dir) throw new Error('set SEED_AUTOMATIONS_DIR (or --dir) to the folder of the automation recipes');
  const seeds = loadSeedAutomations(dir) as SeedAutomation[];
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL!);
  const report: Report = [];
  try {
    const account = (await db.select().from(accounts).where(eq(accounts.slug, slug)).limit(1))[0];
    if (!account) throw new Error(`no account "${slug}"`);
    const ownerEmail = option('owner-email');
    const owner = (
      await db
        .select({ id: users.id, email: users.email })
        .from(accountMembers)
        .innerJoin(users, eq(users.id, accountMembers.userId))
        .where(
          and(
            eq(accountMembers.accountId, account.id),
            eq(accountMembers.status, 'active'),
            ownerEmail ? eq(users.email, ownerEmail) : eq(accountMembers.role, 'admin'),
          ),
        )
        .limit(1)
    )[0];
    if (!owner) throw new Error('no active admin (or --owner-email) to own the automations');

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

    await db.transaction(async (tx) => {
      for (const seed of seeds) {
        const board = boardOf(seed.board);
        if (!board) {
          report.push({ id: seed.id, board: seed.board, result: 'skipped: board not found in this account' });
          continue;
        }
        const existing = (
          await tx
            .select({ id: automations.id })
            .from(automations)
            .where(
              and(
                eq(automations.accountId, account.id),
                eq(automations.seedKey, seed.id),
                isNull(automations.deletedAt),
              ),
            )
            .limit(1)
        )[0];
        if (existing) {
          report.push({ id: seed.id, board: board.name, result: 'exists (kept as is)' });
          continue;
        }
        const [cols, grps] = await Promise.all([
          tx
            .select()
            .from(columns)
            .where(and(eq(columns.boardId, board.id), isNull(columns.deletedAt))),
          tx
            .select()
            .from(groups)
            .where(and(eq(groups.boardId, board.id), isNull(groups.deletedAt))),
        ]);
        // Group refs in the seed are the source group ids: imported groups keep theirs.
        const groupOf = (ref: unknown) =>
          typeof ref === 'string' ? (grps.find((g) => g.sourceGroupId === ref)?.id ?? ref) : ref;
        const withGroups = {
          ...seed,
          trigger: {
            ...(seed.trigger as object),
            ...('group' in (seed.trigger as object)
              ? { group: groupOf((seed.trigger as { group?: string }).group) }
              : {}),
          },
          actions: await Promise.all(
            (seed.actions as Record<string, unknown>[]).map(async (x) => {
              if (!('group' in x)) return x;
              if (x.board === undefined) return { ...x, group: groupOf(x.group) };
              // create_item / move_to_board: the group is on the target board.
              const target = typeof x.board === 'string' ? boardOf(x.board) : null;
              if (!target) return x;
              const theirs = await tx.select().from(groups).where(eq(groups.boardId, target.id));
              return { ...x, group: theirs.find((g) => g.sourceGroupId === x.group)?.id ?? x.group };
            }),
          ),
        };
        const normalized = normalizeRecipe(withGroups, {
          columns: cols.map((c) => ({ key: c.key, title: c.title, type: c.type })),
          resolveBoard: (ref) => (ref.startsWith('@') ? null : (boardOf(ref)?.id ?? null)),
        });
        if (!normalized.ok) {
          report.push({ id: seed.id, board: board.name, result: `skipped: ${normalized.error}` });
          continue;
        }
        const { errors, warnings } = validateRecipe(normalized.recipe, {
          columns: cols.map((c) => ({
            key: c.key,
            type: c.type,
            title: c.title,
            settings: c.settings as Record<string, unknown>,
          })),
          groups: grps.map((g) => ({ id: g.id, title: g.title })),
        });
        const placeholders = JSON.stringify(normalized.recipe).match(/\{\{[A-Z_]+\}\}|\{client(_item_id)?\}/g) ?? [];
        const issues = [
          ...errors.map((e: RecipeIssue) => `${e.code} ${e.path}${e.detail ? ` (${e.detail})` : ''}`),
          ...normalized.unresolved.map((u) => `unresolved ${u}`),
          ...[...new Set(placeholders)].map((p) => `placeholder ${p}`),
          ...warnings.map((w: RecipeIssue) => `${w.code} ${w.path}${w.detail ? ` (${w.detail})` : ''}`),
        ];
        const note =
          [seed.note, issues.length ? `seed: ${issues.join('; ')}` : null].filter(Boolean).join('\n') || null;
        const id = newId();
        await tx.insert(automations).values({
          id,
          accountId: account.id,
          boardId: board.id,
          // The recipe read in Hebrew on this board (the seed's sentence is English).
          title: (
            seed.title ??
            recipeText(normalized.recipe, {
              columns: cols.map((c) => ({ key: c.key, title: c.title, type: c.type })),
              groups: grps.map((g) => ({ id: g.id, title: g.title })),
              boardName: (id) => accountBoards.find((b) => b.id === id)?.name,
            })
          ).slice(0, 255),
          recipe: normalized.recipe as never,
          isActive: false, // D21: the admin switches each one on after a test
          ownerId: owner.id,
          createdBy: owner.id,
          seedKey: seed.id,
          note,
          deactivatedReason: errors.length || placeholders.length ? 'needs_fixing' : null,
        });
        await recordEvent(tx, {
          accountId: account.id,
          type: 'automation.created',
          actorId: owner.id,
          actorType: 'system',
          boardId: board.id,
          meta: { automation_id: id, seed_key: seed.id, source: 'seed' },
        });
        report.push({
          id: seed.id,
          board: board.name,
          result: errors.length || placeholders.length ? 'loaded (needs fixing)' : 'loaded',
          ...(issues.length ? { issues } : {}),
        });
      }
      if (dryRun) throw new DryRun();
    });
    print(report, false);
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
    print(report, true);
  } finally {
    await close();
  }
};

const out = (line: string) =>
  process.stdout.write(`${line}
`);
class DryRun extends Error {}
type Report = { id: string; board: string; result: string; issues?: string[] }[];
const print = (report: Report, dryRun: boolean) => {
  for (const r of report) {
    out(`${r.id.padEnd(4)} ${r.board.padEnd(22)} ${r.result}`);
    for (const i of r.issues ?? []) out(`       · ${i}`);
  }
  const count = (s: string) => report.filter((r) => r.result.startsWith(s)).length;
  out(
    `\n${dryRun ? 'DRY RUN — nothing written. ' : ''}loaded ${count('loaded')} (needs fixing ${count('loaded (needs')}), exists ${count('exists')}, skipped ${count('skipped')} of ${report.length}`,
  );
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
