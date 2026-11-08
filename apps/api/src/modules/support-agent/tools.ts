// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AppError,
  newId,
  scrubSecrets,
  SUPPORT_AGENT_ACTION_KINDS,
  supportAgentReportSchema,
  type SupportAgentSettings,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { errorEvents, supportAgentActions, supportAgentRuns } from '../../db/schema';
import type { AppDeps } from '../../types';
import { toTsQuery } from '../agents/knowledge/extract';
import { getErrorDetail, type HubActor } from '../errors/errors.service';
import { searchPassages } from '../help/help.repo';
import { resolveAccountAccess } from '../support/support.access';
import { findTicket, listMessages } from '../tickets/tickets.repo';
import {
  DATA_OPS,
  DATA_TABLE_NAMES,
  DATA_TABLES,
  type DataQuery,
  describeById,
  MAX_ROWS,
  runDataQuery,
} from './data-access';
import { type LogLine, searchLogs } from './logs';
import { pickOpsType } from './ops-tasks';
import { logSourceToken } from './support-agent.settings';
import {
  assertWritablePath,
  fileOnBranch,
  type GithubCtx,
  type GithubWriteCtx,
  listCommits,
  openDraftPr,
  putAgentFile,
  readFile,
  searchCode,
} from './github';

/**
 * The support agent's tools. Everything reads, except two: `propose_action` only records a
 * proposal a person decides, and `submit_report` ends the run with the report.
 *
 * What the model may see (Israel Privacy Law amendment 13): an account's data — names, contents, addresses — only
 * while the person who started the run has access to that account (a support grant or a membership), exactly like
 * entering it; without it, metadata only (ids, statuses, counts, times). Secret columns never leave, and email
 * addresses / phone numbers are masked in any text that does.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger' | 'secrets'>;
export type RunRow = typeof supportAgentRuns.$inferSelect;
export type ToolCtx = {
  deps: Deps;
  run: RunRow;
  actor: HubActor;
  settings: SupportAgentSettings;
  github: GithubCtx | null;
};
export type SupportTool = {
  name: string;
  description: string;
  input: z.ZodObject;
  run: (c: ToolCtx, input: Record<string, unknown>) => Promise<unknown>;
  /** Ends the run once it succeeded. */
  final?: boolean;
  /** Its result is data written by people (wrapped as untrusted for the model). */
  data?: boolean;
};

/** Email addresses and phone numbers out of any text (and secrets, always). */
export const maskContact = (text: string) =>
  scrubSecrets(text)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]')
    .replace(/(?<![\w-])\+?\d[\d\s().-]{7,}\d(?![\w-])/g, '[phone]');

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const hasAccess = async (db: Db, accountId: string | null | undefined, userId: string) =>
  !!accountId && !!(await resolveAccountAccess(db, accountId, userId));

// ---- describe_record / query_data: the allow-list in data-access.ts ----

/** The record kinds and their tables (a fixed map: the model never names a table here). */
const KIND_TABLES = {
  account: 'accounts',
  workspace: 'workspaces',
  board: 'boards',
  item: 'items',
  user: 'users',
  automation: 'automations',
  automation_run: 'automation_runs',
  agent: 'agents',
  agent_run: 'agent_runs',
  webhook: 'webhooks',
  form: 'forms',
  doc: 'docs',
  import_job: 'import_jobs',
  ticket: 'support_tickets',
  error: 'error_events',
} as const;
const RECORD_KINDS = Object.keys(KIND_TABLES) as [keyof typeof KIND_TABLES, ...(keyof typeof KIND_TABLES)[]];

/** Any value leaving for the model: dates as ISO, text masked and cut, JSON never (no JSON column is listed). */
const showValue = (v: unknown) => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') return cut(maskContact(v), 500);
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  return cut(maskContact(JSON.stringify(v)), 500);
};

const dataCtx = (c: ToolCtx) => ({
  runId: c.run.id,
  actorId: c.run.requestedBy,
  hasAccess: (accountId: string) => hasAccess(c.deps.db, accountId, c.actor.user.id),
  mask: showValue,
});

const describeRecord = async (c: ToolCtx, kind: keyof typeof KIND_TABLES, id: string) => {
  const table = KIND_TABLES[kind];
  const row = await describeById(c.deps.db, table, id, dataCtx(c));
  if (!row) return { found: false, kind, id };
  return { found: true, kind, id, fields: row };
};

// ---- the tools ----

const getError: SupportTool = {
  name: 'get_error',
  description:
    'The error from the errors hub: source, code, severity, the redacted message, counts, first/last seen, links (ids of the board, item, automation, run, request…), status, its last 24 hours, the run trace (with access to the account), other errors with the same code, and earlier investigations of it.',
  input: z.object({ error_id: z.string().length(26) }),
  data: true,
  run: async (c, i) => {
    const id = String(i.error_id);
    const detail = await getErrorDetail(c.deps, c.actor, id);
    const e = detail.event;
    const similar = await c.deps.db
      .select({
        id: errorEvents.id,
        source: errorEvents.source,
        account_id: errorEvents.accountId,
        message: errorEvents.message,
        count: errorEvents.count,
        status: errorEvents.status,
        last_seen_at: errorEvents.lastSeenAt,
      })
      .from(errorEvents)
      .where(and(eq(errorEvents.code, e.code), ne(errorEvents.id, id)))
      .orderBy(desc(errorEvents.lastSeenAt))
      .limit(10);
    const earlier = await c.deps.db
      .select({ id: supportAgentRuns.id, report: supportAgentRuns.report, created_at: supportAgentRuns.createdAt })
      .from(supportAgentRuns)
      .where(and(eq(supportAgentRuns.errorEventId, id), ne(supportAgentRuns.id, c.run.id)))
      .orderBy(desc(supportAgentRuns.createdAt))
      .limit(3);
    return {
      error: e,
      hourly: detail.hourly.filter((h) => h.count > 0),
      access: detail.access,
      trace: detail.trace,
      similar,
      earlier_investigations: earlier
        .filter((r) => r.report)
        .map((r) => ({
          run_id: r.id,
          at: r.created_at,
          summary: (r.report as { summary?: string }).summary ?? '',
          root_cause: (r.report as { root_cause?: string }).root_cause ?? '',
        })),
    };
  },
};

const getTicket: SupportTool = {
  name: 'get_ticket',
  description:
    'A support ticket: subject, status, priority, the account, its context (e.g. the error it came from) and the conversation (customer messages and internal staff notes, oldest first). Email addresses and phone numbers are masked.',
  input: z.object({ ticket_id: z.string().length(26) }),
  data: true,
  run: async (c, i) => {
    const t = await findTicket(c.deps.db, String(i.ticket_id));
    if (!t) throw new AppError('not_found', 'ticket_not_found');
    const messages = (await listMessages(c.deps.db, t.id, false)).slice(-40);
    return {
      ticket: {
        id: t.id,
        number: t.number,
        account_id: t.accountId,
        subject: maskContact(t.subject),
        status: t.status,
        priority: t.priority,
        context: t.context,
        created_at: t.createdAt,
      },
      messages: messages.map((m) => ({
        at: m.createdAt,
        from: m.kind,
        visibility: m.visibility,
        body: cut(maskContact(m.body), 4000),
      })),
    };
  },
};

const describe: SupportTool = {
  name: 'describe_record',
  description: `One record by kind and id (${RECORD_KINDS.join(', ')}): its listed columns. Ids, statuses, counts and times always; names / titles / error texts only with access to its account ("[hidden: no access]" otherwise). Credentials and secrets are not readable at all.`,
  input: z.object({ kind: z.enum(RECORD_KINDS), id: z.string().min(1).max(40) }),
  data: true,
  run: (c, i) => describeRecord(c, i.kind as keyof typeof KIND_TABLES, String(i.id)),
};

const dbSchema: SupportTool = {
  name: 'db_schema',
  description:
    "The tables and columns the agent may read (describe_record, query_data): `m` = metadata (filter / group / order by these), `c` = an account's content (shown with access only). Nothing else in the database is readable.",
  input: z.object({}),
  run: async () => ({
    tables: Object.fromEntries(Object.entries(DATA_TABLES).map(([t, r]) => [t, r.columns])),
  }),
};

const searchHelpTool: SupportTool = {
  name: 'search_help',
  description: "The platform's published help articles (how features are meant to work), best passages first.",
  input: z.object({ query: z.string().trim().min(2).max(200) }),
  data: true,
  run: async (c, i) => {
    const q = toTsQuery(String(i.query));
    if (!q) return { passages: [] };
    const rows = await searchPassages(c.deps.db, q, { visibilities: ['public', 'signed_in'], limit: 6 });
    return { passages: rows.map((r) => ({ article: r.title, slug: r.slug, text: cut(r.body, 1500) })) };
  },
};

const mustGithub = (c: ToolCtx) => {
  if (!c.github) throw new AppError('invalid_value', 'github_not_configured');
  return c.github;
};

const codeSearch: SupportTool = {
  name: 'search_code',
  description:
    "Search the platform's source code on GitHub (the repository's default branch). Returns matching file paths; read them with read_file.",
  input: z.object({ query: z.string().trim().min(2).max(200), path: z.string().max(200).optional() }),
  data: true,
  run: (c, i) => searchCode(mustGithub(c), String(i.query), i.path ? String(i.path) : undefined),
};

const fileRead: SupportTool = {
  name: 'read_file',
  description:
    'A source file at the commit running in production (lines numbered), from `start_line` to `end_line` (at most 400 lines a call). Cite evidence as path:line.',
  input: z.object({
    path: z.string().trim().min(1).max(300),
    start_line: z.number().int().min(1).optional(),
    end_line: z.number().int().min(1).optional(),
  }),
  data: true,
  run: (c, i) =>
    readFile(
      mustGithub(c),
      String(i.path),
      c.run.codeRef,
      typeof i.start_line === 'number' ? i.start_line : 1,
      typeof i.end_line === 'number' ? i.end_line : undefined,
    ),
};

const commits: SupportTool = {
  name: 'list_commits',
  description: 'The latest commits up to the production build, optionally only those touching `path`.',
  input: z.object({ path: z.string().max(300).optional(), limit: z.number().int().min(1).max(30).optional() }),
  data: true,
  run: (c, i) =>
    listCommits(
      mustGithub(c),
      c.run.codeRef,
      i.path ? String(i.path) : undefined,
      typeof i.limit === 'number' ? i.limit : 10,
    ),
};

const proposeInput = z.object({
  kind: z.enum(SUPPORT_AGENT_ACTION_KINDS),
  reason: z.string().trim().min(1).max(1000),
  /** mute_error: for how many hours. */
  mute_hours: z.number().int().min(1).max(720).optional(),
  /** reply_to_customer: the reply, in the customer's language. open_ops_task: what the team should do. */
  body: z.string().trim().min(1).max(8000).optional(),
  /** open_ops_task: the task's name (short, says what to do). */
  title: z.string().trim().min(1).max(200).optional(),
  /** open_ops_task: the type's name from the list in your instructions (none = the default type). */
  ops_type: z.string().trim().max(60).optional(),
});

/** The ticket a reply goes to: the run's, else the error's. */
export const ticketOfRun = async (db: Db, run: RunRow) => {
  if (run.ticketId) return run.ticketId;
  if (!run.errorEventId) return null;
  const [e] = await db
    .select({ ticketId: errorEvents.ticketId })
    .from(errorEvents)
    .where(eq(errorEvents.id, run.errorEventId))
    .limit(1);
  return e?.ticketId ?? null;
};

const propose: SupportTool = {
  name: 'propose_action',
  description:
    'Propose an action for a person to approve — it does NOT happen now: `resolve_error` (the cause is fixed or harmless), `mute_error` (with mute_hours), `reply_to_customer` (a draft reply in `body`, for the ticket), or `open_ops_task` (a task for the operations team: `title`, what to do in `body`, and `ops_type` — one of the types in your instructions). Propose only what the evidence supports.',
  input: proposeInput,
  run: async (c, raw) => {
    const i = proposeInput.parse(raw);
    if ((i.kind === 'resolve_error' || i.kind === 'mute_error') && !c.run.errorEventId)
      throw new AppError('invalid_value', 'no_error_in_this_run');
    if (i.kind === 'mute_error' && !i.mute_hours) throw new AppError('invalid_value', 'mute_hours_required');
    if (i.kind === 'reply_to_customer') {
      if (!i.body) throw new AppError('invalid_value', 'body_required');
      if (!(await ticketOfRun(c.deps.db, c.run))) throw new AppError('invalid_value', 'no_ticket_in_this_run');
    }
    let opsType: string | undefined;
    if (i.kind === 'open_ops_task') {
      if (!i.title || !i.body) throw new AppError('invalid_value', 'title_and_body_required');
      const type = pickOpsType(c.settings.ops_tasks, i.ops_type);
      if (!type) throw new AppError('invalid_value', 'no_ops_task_types');
      opsType = type.id;
    }
    const pending = await c.deps.db
      .select({ id: supportAgentActions.id })
      .from(supportAgentActions)
      .where(and(eq(supportAgentActions.runId, c.run.id), inArray(supportAgentActions.status, ['pending'])));
    if (pending.length >= 5) throw new AppError('invalid_value', 'too_many_proposals');
    const id = newId();
    await c.deps.db.insert(supportAgentActions).values({
      id,
      runId: c.run.id,
      kind: i.kind,
      payload: {
        reason: i.reason,
        ...(i.mute_hours ? { mute_hours: i.mute_hours } : {}),
        ...(i.body ? { body: i.body } : {}),
        ...(opsType ? { title: i.title, ops_type: opsType } : {}),
      },
    });
    return { proposed: true, id, note: 'Recorded. A person will approve or reject it after reading your report.' };
  },
};

const submitReport: SupportTool = {
  name: 'submit_report',
  description:
    'Submit the investigation report and end the run. Call it once, last: summary, root_cause, evidence (each with a ref such as path/to/file.ts:120 or a record id), impact, proposed_fix, confidence (low / medium / high).',
  input: supportAgentReportSchema,
  final: true,
  run: async (_c, i) => ({ submitted: true, report: supportAgentReportSchema.parse(i) }),
};

/** The tools in a fixed order (part of the cached prefix); the GitHub ones only when a repository and token are set. */
export const supportAgentTools = (
  withGithub: boolean,
  phase3: { logs: boolean; sql: boolean } = { logs: false, sql: false },
): SupportTool[] => [
  getError,
  getTicket,
  describe,
  dbSchema,
  searchHelpTool,
  similarReports,
  ...(phase3.logs ? [logsTool] : []),
  ...(phase3.sql ? [queryTool] : []),
  ...(withGithub ? [codeSearch, fileRead, commits] : []),
  propose,
  submitReport,
];

// ---- phase 3: logs, read-only SQL, earlier reports ----

const logsInput = z.object({
  source: z.string().max(40).optional(),
  query: z.string().trim().max(200).optional(),
  request_id: z.string().trim().max(100).optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const logsTool: SupportTool = {
  name: 'search_logs',
  description:
    "Search the platform's logs in the configured sources (each with its own provider: Railway service logs, Sentry-compatible error tracking). Filter by request_id (from the error's links), free text and a time window (ISO). Without `source`, every source. Emails, phones and secrets are masked.",
  input: logsInput,
  data: true,
  run: async (c, raw) => {
    const i = logsInput.parse(raw);
    const sources = c.settings.log_sources.filter((l) => !i.source || l.id === i.source || l.name === i.source);
    if (!sources.length) throw new AppError('not_found', 'log_source_not_found');
    const out: { source: string; kind: string; lines?: LogLine[]; error?: string }[] = [];
    for (const src of sources) {
      const token = logSourceToken(c.deps, src);
      if (!token) {
        out.push({ source: src.name, kind: src.kind, error: 'no_token' });
        continue;
      }
      try {
        const lines = await searchLogs({ db: c.deps.db, runId: c.run.id, actorId: c.run.requestedBy }, src, token, {
          ...(i.query ? { query: i.query } : {}),
          ...(i.request_id ? { request_id: i.request_id } : {}),
          ...(i.before ? { before: i.before } : {}),
          ...(i.after ? { after: i.after } : {}),
          limit: i.limit ?? 50,
        });
        out.push({
          source: src.name,
          kind: src.kind,
          lines: lines.map((l) => ({ ...l, text: maskContact(l.text) })),
        });
      } catch (err) {
        out.push({ source: src.name, kind: src.kind, error: err instanceof AppError ? err.message : 'logs_failed' });
      }
    }
    return { results: out };
  },
};

const filterInput = z.object({
  column: z.string().max(64),
  op: z.enum(DATA_OPS),
  value: z
    .union([z.string().max(200), z.number(), z.boolean(), z.array(z.union([z.string().max(200), z.number()])).max(100)])
    .optional(),
});
const queryInput = z.object({
  table: z.enum(DATA_TABLE_NAMES),
  columns: z.array(z.string().max(64)).max(20).default([]),
  filters: z.array(filterInput).max(10).optional(),
  group_by: z.array(z.string().max(64)).max(4).optional(),
  count: z.boolean().optional(),
  order_by: z.object({ column: z.string().max(64), dir: z.enum(['asc', 'desc']).optional() }).optional(),
  limit: z.number().int().min(1).max(MAX_ROWS).optional(),
});
const queryTool: SupportTool = {
  name: 'query_data',
  description: `A read-only query over the listed tables (see db_schema): choose a table, its columns, filters (on metadata columns: eq, neq, gt, gte, lt, lte, in, is_null, not_null), an order and a limit (≤ ${MAX_ROWS}); or count, optionally grouped by metadata columns. Content columns show only with access to the row's account. No SQL text: everything else in the database is not reachable.`,
  input: queryInput,
  data: true,
  run: async (c, raw) => {
    if (!c.settings.sql.enabled) throw new AppError('forbidden', 'support_agent_sql_off');
    const q = queryInput.parse(raw);
    return runDataQuery(c.deps.db, q as DataQuery, dataCtx(c));
  },
};

const similarInput = z.object({ query: z.string().trim().min(3).max(200) });
const similarReports: SupportTool = {
  name: 'find_similar_reports',
  description:
    'Earlier investigation reports whose summary or root cause mentions the words (an error code, a function, a symptom) — start from what was already found.',
  input: similarInput,
  data: true,
  run: async (c, raw) => {
    const words = similarInput
      .parse(raw)
      .query.split(/\s+/)
      .filter((w) => w.length >= 3)
      .slice(0, 5);
    if (!words.length) return { reports: [] };
    const match = words.map(
      (w) =>
        sql`(${supportAgentRuns.report}->>'summary' ilike ${`%${w}%`} or ${supportAgentRuns.report}->>'root_cause' ilike ${`%${w}%`})`,
    );
    const rows = await c.deps.db
      .select({
        id: supportAgentRuns.id,
        errorId: supportAgentRuns.errorEventId,
        report: supportAgentRuns.report,
        at: supportAgentRuns.createdAt,
      })
      .from(supportAgentRuns)
      .where(and(ne(supportAgentRuns.id, c.run.id), sql`${supportAgentRuns.report} is not null`, and(...match)))
      .orderBy(desc(supportAgentRuns.createdAt))
      .limit(5);
    return {
      reports: rows.map((r) => {
        const rep = r.report as { summary?: string; root_cause?: string; proposed_fix?: string; confidence?: string };
        return {
          run_id: r.id,
          error_id: r.errorId,
          at: r.at,
          summary: rep.summary ?? '',
          root_cause: rep.root_cause ?? '',
          proposed_fix: rep.proposed_fix ?? '',
          confidence: rep.confidence ?? null,
        };
      }),
    };
  },
};

// ---- the "approve development" tools ----

/** What a development run carries: the write client, its `agent/…` branch, created on the first write. */
export type DevCtx = ToolCtx & {
  write: GithubWriteCtx;
  branch: string;
  ensureBranch: () => Promise<void>;
  writes: { n: number };
};
const MAX_WRITES = 25;
const MAX_FILE_BYTES = 300_000;

const asDev = (c: ToolCtx) => c as DevCtx;

const devRead: SupportTool = {
  name: 'read_file',
  description:
    'A source file (lines numbered), from `start_line` to `end_line` (at most 400 lines a call) — on your branch once you wrote to it, else at the production commit.',
  input: fileRead.input,
  data: true,
  run: async (c, i) => {
    const d = asDev(c);
    return readFile(
      d.write,
      String(i.path),
      d.run.devBranch ?? d.run.codeRef,
      typeof i.start_line === 'number' ? i.start_line : 1,
      typeof i.end_line === 'number' ? i.end_line : undefined,
    );
  },
};

const writeInput = z.object({
  path: z.string().trim().min(1).max(300),
  content: z.string().max(MAX_FILE_BYTES),
  message: z.string().trim().min(1).max(200),
});
const writeFile: SupportTool = {
  name: 'write_file',
  description:
    'Write a whole file on your branch (a commit): a new file, or a full replacement. Prefer edit_file for changes to an existing file. CI files (.github/), env files and keys are refused.',
  input: writeInput,
  run: async (c, raw) => {
    const d = asDev(c);
    const i = writeInput.parse(raw);
    assertWritablePath(i.path);
    if (d.writes.n >= MAX_WRITES) throw new AppError('invalid_value', 'too_many_writes');
    await d.ensureBranch();
    const cur = await fileOnBranch(d.write, i.path, d.branch);
    await putAgentFile(d.write, d.branch, i.path, i.content, i.message, cur?.sha ?? null);
    d.writes.n += 1;
    return { written: i.path, branch: d.branch, created: !cur };
  },
};

const editInput = z.object({
  path: z.string().trim().min(1).max(300),
  old_text: z.string().min(1).max(20_000),
  new_text: z.string().max(20_000),
  message: z.string().trim().min(1).max(200),
});
const editFile: SupportTool = {
  name: 'edit_file',
  description:
    'Replace one exact passage in a file on your branch (a commit). `old_text` must appear exactly once — include enough surrounding lines to make it unique.',
  input: editInput,
  run: async (c, raw) => {
    const d = asDev(c);
    const i = editInput.parse(raw);
    assertWritablePath(i.path);
    if (d.writes.n >= MAX_WRITES) throw new AppError('invalid_value', 'too_many_writes');
    await d.ensureBranch();
    const cur = await fileOnBranch(d.write, i.path, d.branch);
    if (!cur) throw new AppError('not_found', 'file_not_found');
    const at = cur.text.indexOf(i.old_text);
    if (at < 0) throw new AppError('invalid_value', 'old_text_not_found');
    if (cur.text.indexOf(i.old_text, at + 1) >= 0) throw new AppError('invalid_value', 'old_text_not_unique');
    const next = cur.text.slice(0, at) + i.new_text + cur.text.slice(at + i.old_text.length);
    await putAgentFile(d.write, d.branch, i.path, next, i.message, cur.sha);
    d.writes.n += 1;
    return { edited: i.path, branch: d.branch };
  },
};

const prInput = z.object({
  title: z.string().trim().min(5).max(200),
  body: z.string().trim().min(1).max(20_000),
});
const openPr: SupportTool = {
  name: 'open_pull_request',
  description:
    'Open a DRAFT pull request from your branch to the base branch and end. Call it once, last, after your changes (with a test). The body explains the cause, the change, and how it was checked.',
  input: prInput,
  final: true,
  run: async (c, raw) => {
    const d = asDev(c);
    const i = prInput.parse(raw);
    if (!d.writes.n && !d.run.devBranch) throw new AppError('invalid_value', 'nothing_written');
    const footer = [
      '',
      '---',
      `Opened as a draft by the Bines OS support agent (investigation ${d.run.id}).`,
      'Review it, run the tests, and merge only if it is right. The agent never merges.',
    ].join('\n');
    const pr = await openDraftPr(d.write, d.branch, i.title, `${i.body}${footer}`);
    return { opened: true, url: pr.html_url, number: pr.number, branch: d.branch };
  },
};

/** The development tools, in a fixed order. */
export const supportAgentDevTools = (): SupportTool[] => [
  getError,
  getTicket,
  devRead,
  codeSearch,
  commits,
  editFile,
  writeFile,
  openPr,
];
