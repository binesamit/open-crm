// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type Flow,
  type FlowPlatformCaps,
  type FlowRun,
  type FlowStats,
  type N8nWorkflowDraft,
  type N8nWorkflowFull,
} from '@bines/shared';
import { outboundExchange } from '../../../lib/outbound';

/**
 * One external automation platform behind one interface. An adapter only maps the platform's REST
 * API to our shapes; permissions, secrets, limits, audit and alerts live in flows.service.ts. A method a platform's
 * API cannot do is absent (the caps say so) — the service answers `flow_not_supported` for it.
 *
 * Deleting is deliberately not part of the interface: flows are deleted in the platform itself (the plan: the AI
 * never deletes, and no screen here needs it).
 */
export type FlowAdapter = {
  caps: FlowPlatformCaps;
  /**
   * A cheap authenticated call; throws an AppError the person can read. Connected but a part refused (e.g. the run
   * history) → `{warning}` with the platform's reason.
   */
  test: () => Promise<FlowTestResult>;
  /**
   * Every flow (a sane cap), with its last run and failures of the last 7 days when the platform tells cheaply. A
   * platform that needs calls per flow for them (Make) lists the flows alone and has `flowStats`.
   */
  listFlows: () => Promise<Flow[]>;
  /**
   * One flow's stats, asked on their own (the service loads them for the flows on screen, paced and kept). Throws on
   * a rate limit (the caller stops); any other trouble with the flow → stats with `warning`.
   */
  flowStats?: (flow: Pick<Flow, 'id' | 'name'>) => Promise<FlowStats>;
  getFlow: (id: string) => Promise<Flow>;
  setActive?: (id: string, active: boolean) => Promise<Flow>;
  /** Newest first. `flowId` is required by platforms whose runs live under a flow (Make). */
  listRuns: (q: {
    flowId?: string;
    status: 'error' | 'all';
    limit: number;
    since?: Date;
    /** The flows as last listed (kept by the service): a platform walking its flows uses them instead of listing again. */
    flows?: Pick<Flow, 'id' | 'name' | 'active'>[];
    /** Told after each flow's runs were read in such a walk (the caller rotates the order: least recently read first). */
    onFlowRead?: (flowId: string) => void;
  }) => Promise<FlowRun[]>;
  getRun: (id: string, flowId?: string) => Promise<FlowRun>;
  retryRun?: (id: string, flowId?: string) => Promise<{ run_id: string | null }>;
  /** Creates the flow switched off; returns it. */
  createFlow?: (workflow: N8nWorkflowDraft) => Promise<Flow>;
  /** The flow's own definition (n8n workflow JSON), for an edit. */
  getDefinition?: (id: string) => Promise<N8nWorkflowFull>;
  /** Saves an edited definition; `active` = whether the flow is left on afterwards. */
  saveDefinition?: (id: string, workflow: N8nWorkflowFull, active: boolean) => Promise<Flow>;
};

// ---- HTTP (SSRF-safe; replaceable in tests) ----

export type FlowHttpRequest = { method: string; url: string; headers: Record<string, string>; body?: string };
export type FlowHttpResponse = {
  status: number;
  ok: boolean;
  body: string;
  /** The answer's headers (a 429's `Retry-After` / `X-RateLimit-Reset`); fakes may leave them out. */
  headers?: Record<string, string | string[] | undefined>;
};
export type FlowHttp = (req: FlowHttpRequest) => Promise<FlowHttpResponse>;

export const FLOW_TIMEOUT_MS = 20_000;
const MAX_BYTES = 4 * 1024 * 1024;

/** The real transport: lib/outbound (public addresses only unless allowed, no redirects, size-capped). */
export const outboundHttp =
  (allowPrivate: boolean): FlowHttp =>
  async (req) => {
    const res = await outboundExchange(req.url, {
      method: req.method,
      headers: req.headers,
      ...(req.body !== undefined ? { body: req.body } : {}),
      timeoutMs: FLOW_TIMEOUT_MS,
      allowPrivate,
      maxBytes: MAX_BYTES,
    });
    return { status: res.status, ok: res.ok, body: res.body, headers: res.headers };
  };

/** A JSON call: the platform's error becomes an AppError (`external_error`, its message as `remote_message`). */
export const jsonCall = async <T>(
  http: FlowHttp,
  req: { method: string; url: string; headers: Record<string, string>; json?: unknown },
): Promise<T> => {
  let res: FlowHttpResponse;
  try {
    res = await http({
      method: req.method,
      url: req.url,
      headers: {
        accept: 'application/json',
        ...(req.json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...req.headers,
      },
      ...(req.json !== undefined ? { body: JSON.stringify(req.json) } : {}),
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('external_error', 'flow_platform_unreachable');
  }
  let body: unknown = null;
  try {
    body = res.body ? JSON.parse(res.body) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const remote = remoteMessage(body) ?? res.body.slice(0, 300);
    if (res.status === 401 || res.status === 403)
      throw new AppError('external_error', 'flow_platform_unauthorized', {
        status: res.status,
        remote_message: remote,
      });
    if (res.status === 404)
      throw new AppError('not_found', 'flow_platform_not_found', { status: res.status, remote_message: remote });
    throw new AppError('external_error', 'flow_platform_error', { status: res.status, remote_message: remote });
  }
  return body as T;
};

/**
 * The platform's reason, as one line. Make answers `{message, detail, code, suberrors:[{message}]}` — `message` alone
 * is often just "Validation failed", so every part is kept (`Validation failed — <detail> [IM005]`).
 */
export const remoteMessage = (body: unknown): string | null => {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const parts: string[] = [];
  const add = (v: unknown) => {
    const text =
      typeof v === 'string'
        ? v
        : v && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string'
          ? (v as { message: string }).message
          : null;
    if (text && !parts.includes(text)) parts.push(text);
  };
  for (const k of ['message', 'detail', 'error', 'errors', 'suberrors']) {
    const v = b[k];
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 3)) {
        if (typeof x === 'string' || (x && typeof (x as { message?: unknown }).message === 'string')) add(x);
        else if (x !== undefined) parts.push(JSON.stringify(x));
      }
    } else add(v);
  }
  if (!parts.length) return null;
  const code = typeof b.code === 'string' ? ` [${b.code}]` : '';
  return `${parts.join(' — ')}${code}`.slice(0, 300);
};

/** What a connection test found: connected, maybe with the run history refused (`warning` = the platform's reason). */
export type FlowTestResult = { warning?: string } | void;

/** A flow whose run stats failed: the list keeps it, with null stats and the reason. */
export const statsWarning = (err: unknown) => ({
  warning: 'flow_stats_unavailable',
  warning_detail:
    err instanceof AppError
      ? `${err.message}${typeof err.details?.status === 'number' ? ` (${err.details.status})` : ''}${
          typeof err.details?.remote_message === 'string' ? `: ${err.details.remote_message}` : ''
        }`.slice(0, 300)
      : 'flow_platform_unreachable',
});

/** Told when one flow's call fails inside a multi-flow pass (the pass goes on). The service logs it. */
export type FlowErrorReporter = (flowId: string, err: unknown) => void;

// ---- small helpers the adapters share ----

export const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export const durationOf = (start: string | null, end: string | null) =>
  start && end ? Math.max(0, new Date(end).getTime() - new Date(start).getTime()) : null;

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export const str = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null;
