// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type SupportLogSource } from '@bines/shared';
import type { Db } from '../../db/client';
import { outboundRequest } from '../../lib/outbound';
import { insertPlatformAudit } from '../account-deletion/account-deletion.repo';

/**
 * Phase 3: the support agent reads logs from the sources the owner set (Support agent settings →
 * Log sources). One function per provider kind behind `searchLogs`; adding a provider = a new kind + an adapter here.
 *
 * Read-only by construction: each adapter sends only its fixed read call (Railway: the `environmentLogs` query —
 * never a mutation; Sentry-compatible: GET of issues and their latest event). Through the outbound guard (public
 * address, no redirects, size cap); every call in the platform's audit log, never the token.
 */
export type LogLine = { at: string | null; level: string | null; text: string; where?: string | null; link?: string };
export type LogQuery = { query?: string; request_id?: string; before?: string; after?: string; limit: number };

const MAX_BYTES = 2 * 1024 * 1024;
const LINE_CHARS = 1200;

type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; body: string }>;
const realFetch: Fetcher = (url, init) => outboundRequest(url, { ...init, timeoutMs: 20_000, maxBytes: MAX_BYTES });
let fetcher: Fetcher = realFetch;
/** Tests swap the network for fake providers; `null` restores the real one. */
export const setLogFetchForTests = (f: Fetcher | null) => {
  fetcher = f ?? realFetch;
};

type Ctx = { db: Db; runId: string; actorId: string | null };

const call = async (c: Ctx, src: SupportLogSource, url: string, init: Parameters<Fetcher>[1]) => {
  let res: Awaited<ReturnType<Fetcher>>;
  try {
    res = await fetcher(url, init);
  } catch (err) {
    await audit(c, src, init.method, 0);
    throw new AppError('unprocessable', 'logs_unreachable', { cause: String(err).slice(0, 200) });
  }
  await audit(c, src, init.method, res.status);
  if (res.status === 401 || res.status === 403) throw new AppError('unprocessable', 'logs_forbidden');
  if (!res.ok) throw new AppError('unprocessable', 'logs_failed', { status: res.status });
  return res.body;
};

const audit = (c: Ctx, src: SupportLogSource, method: string, status: number) =>
  insertPlatformAudit(c.db, {
    action: 'support_agent.logs',
    targetType: 'log_source',
    targetId: src.id.slice(0, 64),
    actorId: c.actorId,
    payload: { run_id: c.runId, kind: src.kind, method, status },
  });

const cut = (s: string) => (s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS)}…` : s);

// ---- Railway ----

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';
/** The one query this adapter ever sends. */
const RAILWAY_QUERY = `query Logs($environmentId: String!, $filter: String, $beforeDate: String, $beforeLimit: Int) {
  environmentLogs(environmentId: $environmentId, filter: $filter, beforeDate: $beforeDate, beforeLimit: $beforeLimit) {
    timestamp message severity tags { serviceId deploymentId }
  }
}`;

const railway = async (c: Ctx, src: SupportLogSource, token: string, q: LogQuery): Promise<LogLine[]> => {
  const filter = [q.request_id, q.query].filter(Boolean).join(' ').trim();
  const body = await call(c, src, RAILWAY_API, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: RAILWAY_QUERY,
      variables: {
        environmentId: src.environment_id,
        filter: filter || null,
        beforeDate: q.before ?? new Date().toISOString(),
        // Read a wider window when one service is wanted (the others are dropped below).
        beforeLimit: Math.min(500, src.service_id ? q.limit * 4 : q.limit),
      },
    }),
  });
  const json = JSON.parse(body) as {
    data?: {
      environmentLogs?: {
        timestamp: string;
        message: string;
        severity: string | null;
        tags?: { serviceId?: string };
      }[];
    };
    errors?: { message: string }[];
  };
  if (json.errors?.length)
    throw new AppError('unprocessable', 'logs_failed', { error: json.errors[0]!.message.slice(0, 200) });
  return (json.data?.environmentLogs ?? [])
    .filter((l) => !src.service_id || l.tags?.serviceId === src.service_id)
    .filter((l) => !q.after || l.timestamp >= q.after)
    .slice(-q.limit)
    .map((l) => ({ at: l.timestamp, level: l.severity, text: cut(l.message), where: l.tags?.serviceId ?? null }));
};

// ---- Sentry-compatible (Sentry, GlitchTip) ----

type SentryIssue = {
  id: string;
  title: string;
  culprit?: string;
  count?: string | number;
  lastSeen?: string;
  permalink?: string;
  level?: string;
};
type SentryEvent = {
  message?: string;
  dateCreated?: string;
  entries?: {
    type: string;
    data?: {
      values?: {
        type?: string;
        value?: string;
        stacktrace?: { frames?: { filename?: string; function?: string; lineNo?: number }[] };
      }[];
    };
  }[];
  tags?: { key: string; value: string }[];
};

const sentry = async (c: Ctx, src: SupportLogSource, token: string, q: LogQuery): Promise<LogLine[]> => {
  const base = src.base_url!.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  const query = [q.request_id ? `request_id:${q.request_id}` : null, q.query].filter(Boolean).join(' ');
  const issues = JSON.parse(
    await call(
      c,
      src,
      `${base}/api/0/projects/${encodeURIComponent(src.org!)}/${encodeURIComponent(src.project!)}/issues/?limit=10&statsPeriod=14d${query ? `&query=${encodeURIComponent(query)}` : ''}`,
      { method: 'GET', headers },
    ),
  ) as SentryIssue[];
  const out: LogLine[] = [];
  for (const issue of issues.slice(0, Math.min(5, q.limit))) {
    let detail = '';
    try {
      const ev = JSON.parse(
        await call(c, src, `${base}/api/0/issues/${encodeURIComponent(issue.id)}/events/latest/`, {
          method: 'GET',
          headers,
        }),
      ) as SentryEvent;
      const ex = ev.entries?.find((e) => e.type === 'exception')?.data?.values?.[0];
      const frames = (ex?.stacktrace?.frames ?? [])
        .slice(-8)
        .reverse()
        .map((f) => `  at ${f.function ?? '?'} (${f.filename ?? '?'}:${f.lineNo ?? '?'})`);
      const rid = ev.tags?.find((t) => t.key === 'request_id')?.value;
      detail = [
        ex ? `${ex.type ?? 'Error'}: ${ex.value ?? ''}` : (ev.message ?? ''),
        rid ? `request_id=${rid}` : null,
        ...frames,
      ]
        .filter(Boolean)
        .join('\n');
    } catch {
      // The issue alone still says something.
    }
    out.push({
      at: issue.lastSeen ?? null,
      level: issue.level ?? null,
      text: cut(
        [`${issue.title}${issue.culprit ? ` — ${issue.culprit}` : ''} (×${issue.count ?? '?'})`, detail]
          .filter(Boolean)
          .join('\n'),
      ),
      ...(issue.permalink ? { link: issue.permalink } : {}),
    });
  }
  return out;
};

const ADAPTERS: Record<
  SupportLogSource['kind'],
  (c: Ctx, s: SupportLogSource, t: string, q: LogQuery) => Promise<LogLine[]>
> = {
  railway,
  sentry,
};

/** Searches one source. The caller masks and wraps the result as untrusted data. */
export const searchLogs = (c: Ctx, src: SupportLogSource, token: string, q: LogQuery) =>
  ADAPTERS[src.kind](c, src, token, q);
