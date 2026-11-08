// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Load-test data (12-ROADMAP ס3, docs/PERFORMANCE-REVIEW.md): one account with ~100,000 items, 50 users and
 * realistic shape — 10 boards of very different sizes (3 boards of 25k–30k), every common column family
 * (status, people, date, numbers, text, dropdown, tags, relation, mirror, formula, files), groups, views,
 * subitems, updates (some with files), notifications and the item.created activity rows.
 *
 * The structure (account, users, boards, columns, groups, views, tags, the sub-boards) is created through the
 * real HTTP API in-process (owner console → invitation → password sign-up → accept), so it is exactly what the app
 * makes. The bulk rows (items, cells, links, subitems, updates, …) are inserted in batches through Drizzle, with
 * each cell parsed and derived by the column registry (`parseCellValue`) like a service write.
 *
 * Usage (local only — refuses a non-local DATABASE_URL unless PERF_SEED_ALLOW_REMOTE=1):
 *   pnpm --filter @bines/api perf:seed [--slug perf100k] [--items 100000] [--users 50] [--reset]
 * Writes perf/.perf-<slug>.json (git-ignored): API base, account id, user emails + password, boards and columns.
 * If the account already exists it is reused as is (only the config file is rewritten); --reset deletes it first.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { columnTypes, newId, parseCellValue, rankBetween } from '@bines/shared';
import { memoryMailer } from '@bines/server-mail';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createApp } from '../src/app';
import { createDb } from '../src/db/client';
import {
  accounts,
  activityLog,
  assets,
  boards,
  cellFiles,
  cells,
  columns,
  groups,
  itemLinks,
  items,
  notifications,
  updateFiles,
  updates,
  users,
} from '../src/db/schema';
import { createDeps } from '../src/deps';
import { loadEnv } from '../src/env';
import { createLogger } from '../src/lib/logger';
import { nullBus } from '../src/lib/realtime';
import { memoryStorage } from '../src/lib/storage';

// ---------------------------------------------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------------------------------------------
const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const SLUG = arg('slug', 'perf100k');
const TOTAL = Number(arg('items', '100000'));
const USERS = Number(arg('users', '50'));
const RESET = process.argv.includes('--reset');
const PASSWORD = 'perf-load-password-1';
const DOMAIN = `${SLUG}.test`;
const API_BASE = process.env.PERF_API_BASE ?? 'http://host.docker.internal:3100';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // no .env: rely on the environment
}
const env = loadEnv({ ...process.env, LOG_LEVEL: 'warn' });
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
if (!env.SEED_ADMIN_EMAIL) throw new Error('SEED_ADMIN_EMAIL (the platform owner) is not set');
const host = new URL(env.DATABASE_URL).hostname;
if (!['localhost', '127.0.0.1', '::1'].includes(host) && process.env.PERF_SEED_ALLOW_REMOTE !== '1') {
  throw new Error(`refusing to seed ${host}: local databases only (PERF_SEED_ALLOW_REMOTE=1 to override)`);
}

/** Board shapes: the sizes add up to 100k at the default --items and scale with it. */
const BOARDS = [
  { key: 'deals', name: 'עסקאות', share: 0.3, groups: 8, relation: true, subitems: true, files: true },
  { key: 'tickets', name: 'פניות תמיכה', share: 0.27, groups: 6, relation: true, subitems: true, files: false },
  { key: 'tasks', name: 'משימות', share: 0.25, groups: 10, relation: true, subitems: true, files: false },
  { key: 'clients', name: 'לקוחות', share: 0.06, groups: 4, relation: false, subitems: false, files: false },
  { key: 'leads', name: 'לידים', share: 0.04, groups: 5, relation: true, subitems: false, files: false },
  { key: 'projects', name: 'פרויקטים', share: 0.03, groups: 4, relation: true, subitems: true, files: false },
  { key: 'invoices', name: 'חשבוניות', share: 0.02, groups: 3, relation: true, subitems: false, files: false },
  { key: 'hr', name: 'גיוס', share: 0.015, groups: 3, relation: false, subitems: false, files: false },
  { key: 'assets', name: 'ציוד', share: 0.01, groups: 3, relation: false, subitems: false, files: false },
  { key: 'ideas', name: 'רעיונות', share: 0.005, groups: 2, relation: false, subitems: false, files: false },
] as const;

const GROUP_COLORS = ['forest', 'yellow', 'turquoise', 'crimson', 'navy', 'purple'];
const WORDS = [
  'אלפא',
  'בטא',
  'גמא',
  'דלתא',
  'תל אביב',
  'חיפה',
  'ירושלים',
  'באר שבע',
  'פרויקט',
  'שדרוג',
  'התקנה',
  'חידוש',
  'מנוי',
  'הצעה',
  'חוזה',
  'תמיכה',
  'אתר',
  'אפליקציה',
  'קמפיין',
  'שיווק',
  'כספים',
  'Acme',
  'Globex',
  'Initech',
  'Umbrella',
  'Hooli',
  'Stark',
  'Wayne',
  'Pied Piper',
  'server',
  'migration',
  'invoice',
  'renewal',
  'onboarding',
];
const CATEGORIES = ['קטן', 'בינוני', 'גדול', 'אסטרטגי', 'ממשלתי', 'פרטי', 'עמותה', 'אחר'];
const TAGS = ['דחוף', 'VIP', 'חדש', 'חוזר', 'בסיכון', 'צפון', 'מרכז', 'דרום', 'B2B', 'B2C', 'שותף', 'מכרז'];

// Deterministic pseudo-random numbers (mulberry32), so two runs make the same data.
let seed = 0x5eed;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
/** Skewed choice: a few values are used much more than the rest (people, groups — like real boards). */
const skewed = <T>(xs: readonly T[]) => xs[Math.floor(rnd() ** 2 * xs.length)]!;
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------------
// In-process app on the target database (memory mailer: the invitation and magic links are read from it)
// ---------------------------------------------------------------------------------------------------------------
const logger = createLogger(env);
const { db, close } = createDb(env.DATABASE_URL);
const mailer = memoryMailer();
const deps = createDeps({ env, logger, db, mailer, storage: memoryStorage(), bus: nullBus });
const app = createApp(deps);
const ORIGIN = env.WEB_ORIGIN;

type Json = Record<string, unknown>;
const call = async <T = Json>(
  cookie: string | undefined,
  method: string,
  path: string,
  body?: unknown,
  accountId?: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: T; res: Response }> => {
  const res = await app.request(path.startsWith('/api/') ? path : `/api/v1${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
      ...(accountId ? { 'x-account-id': accountId } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = (text ? JSON.parse(text) : {}) as T;
  return { status: res.status, data, res };
};
const must = async <T = Json>(p: ReturnType<typeof call<T>>, what: string) => {
  const r = await p;
  if (r.status >= 300) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
};
const cookieOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .find((c) => c.startsWith('bos.session_token='));
const lastMail = (to: string) => {
  const m = [...mailer.sent].reverse().find((x) => x.to === to);
  if (!m) throw new Error(`no email to ${to}`);
  return m.text;
};

const ownerCookie = async () => {
  await must(
    call(undefined, 'POST', '/api/auth/sign-in/magic-link', { email: env.SEED_ADMIN_EMAIL, callbackURL: '/' }),
    'magic link',
  );
  const url = new URL(/https?:\/\/[^\s"]+magic-link\/verify[^\s"<]+/.exec(lastMail(env.SEED_ADMIN_EMAIL!))![0]);
  const { res } = await call(undefined, 'GET', `${url.pathname}${url.search}`);
  const cookie = cookieOf(res);
  if (!cookie) throw new Error('owner sign-in failed');
  return cookie;
};

/** Signs up with the invitation token (or signs in when the user exists from an earlier run) and accepts. */
const join = async (email: string) => {
  const token = /\/invite\/([\w-]+)/.exec(lastMail(email))![1]!;
  let { res, status } = await call(
    undefined,
    'POST',
    '/api/auth/sign-up/email',
    { email, password: PASSWORD, name: email.split('@')[0] },
    undefined,
    { 'x-invite-token': token },
  );
  if (status !== 200)
    ({ res, status } = await call(undefined, 'POST', '/api/auth/sign-in/email', { email, password: PASSWORD }));
  const cookie = cookieOf(res);
  if (status !== 200 || !cookie) throw new Error(`${email}: cannot sign up or in (${status})`);
  await must(call(cookie, 'POST', '/invitations/accept', { token }), `${email} accept`);
  return cookie;
};

// ---------------------------------------------------------------------------------------------------------------
// Bulk insert helpers
// ---------------------------------------------------------------------------------------------------------------
const chunked = async <T>(rows: T[], size: number, fn: (part: T[]) => Promise<unknown>) => {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
};

type ColumnRow = typeof columns.$inferSelect;
const userNames = new Map<string, string>();
const cellRow = (accountId: string, boardId: string, col: ColumnRow, itemId: string, raw: unknown, by: string) => {
  const def = columnTypes.get(col.type)!;
  // People cells derive their text from member names (search and sort read it), like a service write.
  const parsed = parseCellValue(def, col.settings, raw, { userName: (id) => userNames.get(id) });
  if (!parsed.ok) throw new Error(`${col.key}: ${parsed.error} ${JSON.stringify(raw)}`);
  return {
    itemId,
    columnId: col.id,
    accountId,
    boardId,
    value: parsed.value as Record<string, never>,
    ...parsed.derived,
    updatedBy: by,
  } satisfies typeof cells.$inferInsert;
};

// ---------------------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------------------
const started = Date.now();
const log = (msg: string) => console.warn(`[perf-seed ${((Date.now() - started) / 1000).toFixed(1)}s] ${msg}`);

const writeConfig = async (accountId: string) => {
  const boardRows = await db
    .select()
    .from(boards)
    .where(and(eq(boards.accountId, accountId), isNull(boards.deletedAt), isNull(boards.parentBoardId)));
  const cols = await db.select().from(columns).where(eq(columns.accountId, accountId));
  const counts = await db
    .select({ boardId: items.boardId, n: sql<number>`count(*)::int` })
    .from(items)
    .where(and(eq(items.accountId, accountId), isNull(items.deletedAt)))
    .groupBy(items.boardId);
  const subOf = new Map(
    (
      await db
        .select({ id: boards.id, parent: boards.parentBoardId })
        .from(boards)
        .where(and(eq(boards.accountId, accountId), sql`${boards.parentBoardId} is not null`))
    ).map((b) => [b.parent!, b.id]),
  );
  const people = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(sql`${users.email} like ${`%@${DOMAIN}`}`);
  const config = {
    base: API_BASE,
    account_id: accountId,
    slug: SLUG,
    password: PASSWORD,
    users: people.map((u) => u.email).sort(),
    boards: boardRows
      .map((b) => ({
        id: b.id,
        name: b.name,
        items: counts.find((c) => c.boardId === b.id)?.n ?? 0,
        sub_board_id: subOf.get(b.id) ?? null,
        columns: Object.fromEntries(cols.filter((c) => c.boardId === b.id).map((c) => [c.key, c.id])),
      }))
      .sort((a, b) => b.items - a.items),
  };
  mkdirSync(new URL('../../../perf/', import.meta.url), { recursive: true });
  const file = new URL(`../../../perf/.perf-${SLUG}.json`, import.meta.url);
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  log(`config → perf/.perf-${SLUG}.json (${config.boards.length} boards, ${config.users.length} users)`);
};

try {
  const existing = (await db.select().from(accounts).where(eq(accounts.slug, SLUG)).limit(1))[0];
  if (existing && RESET) {
    log(`--reset: deleting account ${SLUG} and its rows`);
    await db.delete(accounts).where(eq(accounts.id, existing.id));
  } else if (existing) {
    log(`account ${SLUG} exists — reusing it (pass --reset to rebuild)`);
    await writeConfig(existing.id);
    process.exit(0);
  }

  // 1. Account + users ------------------------------------------------------------------------------------------
  const owner = await ownerCookie();
  const adminEmail = `admin@${DOMAIN}`;
  const created = await must<{ account: { id: string } }>(
    call(owner, 'POST', '/platform/accounts', {
      name: `Perf ${TOTAL.toLocaleString('en')}`,
      slug: SLUG,
      first_admin_email: adminEmail,
      template_set: 'empty',
    }),
    'create account',
  );
  const accountId = created.account.id;
  const admin = await join(adminEmail);
  const A = (method: string, path: string, body?: unknown) =>
    must(call(admin, method, path, body, accountId), `${method} ${path}`);
  log(`account ${SLUG} = ${accountId}`);

  const memberEmails = Array.from({ length: USERS - 1 }, (_, i) => `user${String(i + 1).padStart(2, '0')}@${DOMAIN}`);
  for (let i = 0; i < memberEmails.length; i += 50) {
    await A('POST', '/users/invite', { emails: memberEmails.slice(i, i + 50), role: 'member' });
  }
  for (const email of memberEmails) await join(email);
  const people = await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(inArray(users.email, [adminEmail, ...memberEmails]));
  const userIds = people.map((p) => p.id);
  for (const p of people) userNames.set(p.id, p.name);
  log(`${userIds.length} users joined`);

  // 2. Structure through the API --------------------------------------------------------------------------------
  const workspaceId = (await A('GET', '/workspaces')).data as { id: string }[];
  const wsId = workspaceId[0]!.id;
  const tagIds: string[] = [];
  for (const name of TAGS) tagIds.push(((await A('POST', '/tags', { name })) as { id: string }).id);

  const made: { key: string; id: string; size: number; spec: (typeof BOARDS)[number] }[] = [];
  let assigned = 0;
  for (const [i, spec] of BOARDS.entries()) {
    const size = i === BOARDS.length - 1 ? TOTAL - assigned : Math.round(TOTAL * spec.share);
    assigned += size;
    const b = (await A('POST', '/boards', { name: spec.name, workspace_id: wsId })) as { id: string };
    made.push({ key: spec.key, id: b.id, size, spec });
  }
  const clients = made.find((m) => m.key === 'clients')!;

  for (const m of made) {
    const base = `/boards/${m.id}`;
    const add = (body: Json) => A('POST', `${base}/columns`, body);
    await add({ id: 'status', title: 'סטטוס', type: 'status' });
    await add({ id: 'owner', title: 'אחראי', type: 'people' });
    await add({ id: 'due', title: 'תאריך יעד', type: 'date' });
    await add({ id: 'amount', title: 'סכום', type: 'numbers', settings: { unit: { symbol: '₪', direction: 'left' } } });
    await add({ id: 'note', title: 'הערה', type: 'text' });
    await add({
      id: 'category',
      title: 'קטגוריה',
      type: 'dropdown',
      settings: { labels: CATEGORIES.map((label, id) => ({ id, label })) },
    });
    await add({ id: 'tags', title: 'תגיות', type: 'tags' });
    await add({ id: 'total', title: 'כולל מע"מ', type: 'formula', settings: { formula: '{amount}*1.18' } });
    if (m.spec.relation) {
      await add({
        id: 'client',
        title: 'לקוח',
        type: 'board_relation',
        settings: { board_ids: [clients.id], allow_multiple: true },
      });
      await add({
        id: 'client_value',
        title: 'שווי לקוח',
        type: 'mirror',
        settings: { relation_column_id: 'client', source_column_id: 'amount', aggregate: 'sum' },
      });
    }
    if (m.spec.files) await add({ id: 'files', title: 'קבצים', type: 'file' });

    const detail = (await A('GET', base)) as { groups: { id: string }[] };
    for (let g = detail.groups.length; g < m.spec.groups; g++) {
      await A('POST', `${base}/groups`, { title: `קבוצה ${g + 1}`, color: GROUP_COLORS[g % GROUP_COLORS.length] });
    }
    await A('POST', `${base}/views`, { type: 'kanban', name: 'קנבן', settings: { kanban: { column_id: 'status' } } });
    await A('POST', `${base}/views`, {
      type: 'table',
      name: 'פתוחים שלי',
      settings: {
        query: {
          filter: {
            kind: 'group',
            operator: 'and',
            rules: [{ column_id: 'status', operator: 'any_of', values: [0, 2] }],
          },
          person: 'me',
          sort: [{ column_id: 'due', direction: 'asc' }],
        },
      },
    });
  }
  log(`${made.length} boards with columns, groups and views`);

  // 3. Items + cells (bulk) -------------------------------------------------------------------------------------
  const boardCols = new Map<string, ColumnRow[]>();
  for (const c of await db.select().from(columns).where(eq(columns.accountId, accountId))) {
    boardCols.set(c.boardId, [...(boardCols.get(c.boardId) ?? []), c]);
  }
  const groupRows = await db
    .select({ id: groups.id, boardId: groups.boardId })
    .from(groups)
    .where(and(eq(groups.accountId, accountId), isNull(groups.deletedAt)))
    .orderBy(asc(groups.position));
  const groupsOf = (boardId: string) => groupRows.filter((g) => g.boardId === boardId).map((g) => g.id);

  const clientIds: string[] = [];
  const itemIdsOf = new Map<string, string[]>();
  // Clients first: the relation columns of the other boards point at them.
  const order = [clients, ...made.filter((m) => m !== clients)];
  for (const m of order) {
    const cols = new Map((boardCols.get(m.id) ?? []).map((c) => [c.key, c]));
    const gs = groupsOf(m.id);
    const ids: string[] = [];
    const positions = new Map<string, string | null>();
    for (let start = 0; start < m.size; start += 1000) {
      const itemRows: (typeof items.$inferInsert)[] = [];
      const cellRows: (typeof cells.$inferInsert)[] = [];
      const linkRows: (typeof itemLinks.$inferInsert)[] = [];
      const events: (typeof activityLog.$inferInsert)[] = [];
      for (let i = start; i < Math.min(m.size, start + 1000); i++) {
        const id = newId();
        ids.push(id);
        const groupId = skewed(gs);
        const pos = rankBetween(positions.get(groupId) ?? null, null);
        positions.set(groupId, pos);
        const by = skewed(userIds);
        const name = `${pick(WORDS)} ${pick(WORDS)} ${i + 1}`;
        const createdAt = new Date(Date.now() - Math.floor(rnd() * 400) * 86_400_000);
        itemRows.push({
          id,
          accountId,
          boardId: m.id,
          groupId,
          position: pos,
          name,
          createdBy: by,
          createdAt,
          updatedAt: createdAt,
        });
        events.push({
          id: newId(),
          accountId,
          boardId: m.id,
          itemId: id,
          actorId: by,
          type: 'item.created',
          payload: { after: { name } },
          createdAt,
        });
        const put = (key: string, raw: unknown) => {
          const col = cols.get(key);
          if (col && raw !== undefined) cellRows.push(cellRow(accountId, m.id, col, id, raw, by));
        };
        if (rnd() < 0.92) put('status', { index: Math.floor(rnd() * 3) });
        if (rnd() < 0.85) {
          const who = [skewed(userIds)];
          if (rnd() < 0.2) who.push(pick(userIds));
          put('owner', { persons_and_teams: [...new Set(who)].map((uid) => ({ id: uid, kind: 'person' })) });
        }
        if (rnd() < 0.75) put('due', { date: isoDay(Math.floor(rnd() * 240) - 120) });
        if (rnd() < 0.8) put('amount', Math.round(rnd() * 50_000));
        if (rnd() < 0.5) put('note', `${pick(WORDS)} ${pick(WORDS)} — הערה ${i % 997}`);
        if (rnd() < 0.6) put('category', { ids: [Math.floor(rnd() * CATEGORIES.length)] });
        if (rnd() < 0.4) put('tags', { tag_ids: [...new Set([pick(tagIds), pick(tagIds)])] });
        if (m.spec.relation && clientIds.length && rnd() < 0.7) {
          const to = [pick(clientIds)];
          if (rnd() < 0.15) to.push(pick(clientIds));
          const uniq = [...new Set(to)];
          put('client', { item_ids: uniq });
          let lp: string | null = null;
          for (const t of uniq) {
            lp = rankBetween(lp, null);
            linkRows.push({
              id: newId(),
              accountId,
              columnId: cols.get('client')!.id,
              fromItemId: id,
              toItemId: t,
              position: lp,
              createdBy: by,
            });
          }
        }
      }
      await db.insert(items).values(itemRows);
      await chunked(cellRows, 4000, (p) => db.insert(cells).values(p));
      await chunked(linkRows, 4000, (p) => db.insert(itemLinks).values(p));
      await chunked(events, 4000, (p) => db.insert(activityLog).values(p));
    }
    itemIdsOf.set(m.id, ids);
    if (m === clients) clientIds.push(...ids);
    log(`${m.spec.name}: ${m.size.toLocaleString('en')} items`);
  }

  // 4. Subitems: the sub-board through the API (first subitem), the rest in bulk -------------------------------
  let subTotal = 0;
  for (const m of made.filter((x) => x.spec.subitems)) {
    const parents = itemIdsOf.get(m.id)!;
    const first = (await A('POST', `/items/${parents[0]}/subitems`, { name: 'סאב-אייטם 1' })) as { board_id: string };
    const subId = first.board_id;
    const subCols = new Map((await db.select().from(columns).where(eq(columns.boardId, subId))).map((c) => [c.key, c]));
    const withSubs = parents.filter(() => rnd() < 0.08);
    const rows: (typeof items.$inferInsert)[] = [];
    const subCells: (typeof cells.$inferInsert)[] = [];
    const childCount = new Map<string, number>();
    for (const parentId of withSubs) {
      const n = 1 + Math.floor(rnd() * 4);
      let p: string | null = null;
      for (let k = 0; k < n; k++) {
        p = rankBetween(p, null);
        const id = newId();
        const by = skewed(userIds);
        rows.push({
          id,
          accountId,
          boardId: subId,
          groupId: null,
          parentItemId: parentId,
          rootItemId: parentId,
          depth: 1,
          position: p,
          name: `שלב ${k + 1}`,
          createdBy: by,
        });
        if (rnd() < 0.8)
          subCells.push(cellRow(accountId, subId, subCols.get('status')!, id, { index: Math.floor(rnd() * 3) }, by));
        if (rnd() < 0.7)
          subCells.push(
            cellRow(
              accountId,
              subId,
              subCols.get('person')!,
              id,
              { persons_and_teams: [{ id: skewed(userIds), kind: 'person' }] },
              by,
            ),
          );
        if (rnd() < 0.6)
          subCells.push(
            cellRow(accountId, subId, subCols.get('date')!, id, { date: isoDay(Math.floor(rnd() * 90) - 30) }, by),
          );
      }
      childCount.set(parentId, n);
    }
    await chunked(rows, 2000, (p) => db.insert(items).values(p));
    await chunked(subCells, 4000, (p) => db.insert(cells).values(p));
    const pairs = [...childCount.entries()];
    await chunked(pairs, 1000, (part) =>
      db.execute(
        sql`update items set child_count = v.n from (values ${sql.join(
          part.map(([id, n]) => sql`(${id}::varchar, ${n}::int)`),
          sql`, `,
        )}) as v(id, n) where items.id = v.id`,
      ),
    );
    subTotal += rows.length + 1;
    log(`${m.spec.name}: ${rows.length + 1} subitems under ${withSubs.length + 1} items`);
  }

  // 5. Updates (+ replies), files on some, notifications -------------------------------------------------------
  const bigBoards = made.slice(0, 3);
  const updRows: (typeof updates.$inferInsert)[] = [];
  const assetRows: (typeof assets.$inferInsert)[] = [];
  const updFileRows: (typeof updateFiles.$inferInsert)[] = [];
  const notifRows: (typeof notifications.$inferInsert)[] = [];
  for (const m of made) {
    const ids = itemIdsOf.get(m.id)!;
    const n = Math.round(ids.length * (bigBoards.includes(m) ? 0.12 : 0.05));
    for (let k = 0; k < n; k++) {
      const itemId = pick(ids);
      const by = skewed(userIds);
      const text = `${pick(WORDS)} ${pick(WORDS)}: עדכון מספר ${k + 1} — ${pick(WORDS)}`;
      const id = newId();
      const createdAt = new Date(Date.now() - Math.floor(rnd() * 200) * 86_400_000);
      updRows.push({
        id,
        accountId,
        boardId: m.id,
        itemId,
        bodyHtml: `<p>${text}</p>`,
        bodyText: text,
        createdBy: by,
        createdAt,
      });
      if (rnd() < 0.25) {
        const r = `תגובה: ${pick(WORDS)}`;
        updRows.push({
          id: newId(),
          accountId,
          boardId: m.id,
          itemId,
          parentUpdateId: id,
          bodyHtml: `<p>${r}</p>`,
          bodyText: r,
          createdBy: pick(userIds),
          createdAt,
        });
      }
      if (rnd() < 0.05) {
        const assetId = newId();
        assetRows.push({
          id: assetId,
          accountId,
          ownerId: by,
          storageKey: `perf/${assetId}.pdf`,
          fileName: `מסמך-${k}.pdf`,
          mime: 'application/pdf',
          size: 120_000,
          uploadStatus: 'complete',
        });
        updFileRows.push({ updateId: id, assetId, accountId, position: rankBetween(null, null) });
      }
      if (rnd() < 0.3) {
        const to = pick(userIds);
        if (to !== by)
          notifRows.push({
            id: newId(),
            accountId,
            userId: to,
            type: rnd() < 0.5 ? 'mention' : 'reply',
            boardId: m.id,
            itemId,
            updateId: id,
            actorId: by,
            payload: { excerpt: text.slice(0, 80) },
            createdAt,
            readAt: rnd() < 0.6 ? createdAt : null,
          });
      }
    }
  }
  await chunked(updRows, 3000, (p) => db.insert(updates).values(p));
  await chunked(assetRows, 3000, (p) => db.insert(assets).values(p));
  await chunked(updFileRows, 3000, (p) => db.insert(updateFiles).values(p));
  await chunked(notifRows, 3000, (p) => db.insert(notifications).values(p));
  log(`${updRows.length} updates, ${assetRows.length} update files, ${notifRows.length} notifications`);

  // Files column on the deals board: asset rows + a cell (the value cache) + cell_files.
  const deals = made.find((m) => m.spec.files)!;
  const fileCol = boardCols.get(deals.id)!.find((c) => c.key === 'files')!;
  const fAssets: (typeof assets.$inferInsert)[] = [];
  const fCells: (typeof cells.$inferInsert)[] = [];
  const fLinks: (typeof cellFiles.$inferInsert)[] = [];
  for (const itemId of itemIdsOf.get(deals.id)!.filter(() => rnd() < 0.05)) {
    const assetId = newId();
    const by = pick(userIds);
    fAssets.push({
      id: assetId,
      accountId,
      ownerId: by,
      storageKey: `perf/${assetId}.pdf`,
      fileName: `הצעה-${assetId.slice(-5)}.pdf`,
      mime: 'application/pdf',
      size: 250_000,
      uploadStatus: 'complete',
    });
    fCells.push(
      cellRow(
        accountId,
        deals.id,
        fileCol,
        itemId,
        {
          files: [
            {
              asset_id: assetId,
              name: `הצעה-${assetId.slice(-5)}.pdf`,
              size: 250_000,
              mime: 'application/pdf',
              version: 1,
              added_by: by,
              added_at: new Date().toISOString(),
            },
          ],
        },
        by,
      ),
    );
    fLinks.push({
      id: newId(),
      accountId,
      itemId,
      columnId: fileCol.id,
      assetId,
      position: rankBetween(null, null),
      createdBy: by,
    });
  }
  await chunked(fAssets, 3000, (p) => db.insert(assets).values(p));
  await chunked(fCells, 3000, (p) => db.insert(cells).values(p));
  await chunked(fLinks, 3000, (p) => db.insert(cellFiles).values(p));
  log(`${fLinks.length} files in the deals board's files column`);

  await db.execute(sql`analyze`);
  log(`done: ${TOTAL.toLocaleString('en')} items + ${subTotal} subitems`);
  await writeConfig(accountId);
} finally {
  await close();
}
