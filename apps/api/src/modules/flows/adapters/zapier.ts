// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, FLOW_PLATFORM_CAPS, type Flow, type FlowRun, type FlowRunStatus } from '@bines/shared';
import {
  durationOf,
  type FlowAdapter,
  type FlowErrorReporter,
  type FlowHttp,
  iso,
  jsonCall,
  statsWarning,
  str,
  WEEK_MS,
} from './types';

/**
 * Zapier — monitoring only (question 4): the Workflow API (`https://api.zapier.com/v2`, OAuth bearer)
 * - `GET /v2/zaps?limit&offset` (scope `zap:all`) → `{data:[{id, title, is_enabled, updated_at,
 *   last_successful_run_date, links.html_editor}], links.next}`;
 * - `GET /v2/zap-runs?zap_id&statuses&from_date&limit` (scope `zap:runs`) → `{data:[{id, zap_id, status, start_time,
 *   end_time, zap_title, steps}]}`.
 * Switching, re-running and creating Zaps need Zapier's partner approval — not offered (caps all false).
 */
type Zap = {
  id: string | number;
  title?: string;
  is_enabled?: boolean;
  updated_at?: string;
  last_successful_run_date?: string | null;
  links?: { html_editor?: string };
};
type ZapRun = {
  id: string;
  zap_id?: string | number;
  status?: string;
  start_time?: string;
  end_time?: string | null;
  zap_title?: string;
  steps?: { status?: string; title?: string; app?: { title?: string }; error?: string | { message?: string } }[];
};
type Page<T> = { data?: T[]; links?: { next?: string | null } };

const API = 'https://api.zapier.com/v2';
const MAX_FLOWS = 300;

const STATUS: Record<string, FlowRunStatus> = {
  success: 'success',
  error: 'error',
  halted: 'canceled',
  error_handled: 'warning',
  throttled: 'warning',
  held: 'waiting',
  pending: 'running',
  delayed: 'waiting',
  scheduled: 'waiting',
  filtered: 'skipped',
  skipped: 'skipped',
};

export const zapierAdapter = (opts: {
  accessToken: string;
  http: FlowHttp;
  onFlowError?: FlowErrorReporter;
}): FlowAdapter => {
  const headers = { authorization: `Bearer ${opts.accessToken}` };
  const call = <T>(path: string) => jsonCall<T>(opts.http, { method: 'GET', url: `${API}${path}`, headers });

  const toRun = (r: ZapRun): FlowRun => {
    const status = (r.status && STATUS[r.status]) || 'other';
    const started = iso(r.start_time);
    const finished = iso(r.end_time);
    const failed = (r.steps ?? []).find((s) => s.status === 'error' || s.error);
    const err = failed?.error;
    return {
      id: String(r.id),
      flow_id: str(r.zap_id),
      flow_name: r.zap_title ?? null,
      status,
      started_at: started,
      finished_at: finished,
      duration_ms: durationOf(started, finished),
      error: status === 'error' ? ((typeof err === 'string' ? err : err?.message) ?? null) : null,
      error_node: status === 'error' ? (failed?.title ?? failed?.app?.title ?? null) : null,
      mode: null,
      can_retry: false,
      open_url: null,
    };
  };

  const runs = async (q: { zapId?: string; status?: string; limit: number; from?: Date }) => {
    const params = new URLSearchParams({ limit: String(Math.min(100, q.limit)) });
    if (q.zapId) params.set('zap_id', q.zapId);
    if (q.status) params.set('statuses', q.status);
    if (q.from) params.set('from_date', q.from.toISOString());
    return ((await call<Page<ZapRun>>(`/zap-runs?${params}`)).data ?? []).map(toRun);
  };

  type Stats = { last?: FlowRun; errors?: number; warning?: string; warning_detail?: string };
  const toFlow = (z: Zap, stats?: Stats): Flow => ({
    id: String(z.id),
    name: z.title ?? String(z.id),
    active: !!z.is_enabled,
    status: stats?.last?.status === 'error' ? 'error' : z.is_enabled ? 'active' : 'inactive',
    updated_at: iso(z.updated_at),
    last_run_at: stats?.last?.started_at ?? iso(z.last_successful_run_date),
    last_run_status: stats?.last?.status ?? (z.last_successful_run_date ? 'success' : null),
    errors_7d: stats && !stats.warning ? (stats.errors ?? 0) : null,
    open_url: z.links?.html_editor ?? null,
    tags: [],
    ...(stats?.warning ? { warning: stats.warning, warning_detail: stats.warning_detail ?? null } : {}),
  });

  const zaps = async () => {
    const out: Zap[] = [];
    for (let offset = 0; out.length < MAX_FLOWS; offset += 100) {
      const page = await call<Page<Zap>>(`/zaps?${new URLSearchParams({ limit: '100', offset: String(offset) })}`);
      out.push(...(page.data ?? []));
      if (!page.links?.next || !page.data?.length) break;
    }
    return out.slice(0, MAX_FLOWS);
  };

  const weekStats = async () => {
    const [recent, failed] = await Promise.all([
      runs({ limit: 100 }),
      runs({ status: 'error', limit: 100, from: new Date(Date.now() - WEEK_MS) }),
    ]);
    const by = new Map<string, { last?: FlowRun; errors: number }>();
    for (const r of recent) {
      if (!r.flow_id) continue;
      const s = by.get(r.flow_id) ?? { errors: 0 };
      if (!s.last) s.last = r;
      by.set(r.flow_id, s);
    }
    for (const r of failed) {
      if (!r.flow_id) continue;
      const s = by.get(r.flow_id) ?? { errors: 0 };
      s.errors += 1;
      by.set(r.flow_id, s);
    }
    return by;
  };

  return {
    caps: FLOW_PLATFORM_CAPS.zapier,
    test: async () => {
      await call('/zaps?limit=1');
      // Runs need their own scope (`zap:runs`): connected without it → a warning, not a failure.
      try {
        await runs({ limit: 1 });
      } catch (err) {
        return { warning: statsWarning(err).warning_detail };
      }
    },
    listFlows: async () => {
      const [list, stats] = await Promise.all([
        zaps(),
        weekStats().catch((err: unknown) => {
          opts.onFlowError?.('*', err);
          return statsWarning(err);
        }),
      ]);
      return list.map((z) => toFlow(z, stats instanceof Map ? (stats.get(String(z.id)) ?? { errors: 0 }) : stats));
    },
    getFlow: async (id) => {
      const found = (await zaps()).find((z) => String(z.id) === id);
      if (!found) throw new AppError('not_found', 'flow_platform_not_found');
      let recent: FlowRun[];
      try {
        recent = await runs({ zapId: id, limit: 50 });
      } catch (err) {
        opts.onFlowError?.(id, err);
        return toFlow(found, statsWarning(err));
      }
      const weekAgo = Date.now() - WEEK_MS;
      return toFlow(found, {
        ...(recent[0] ? { last: recent[0] } : {}),
        errors: recent.filter((r) => r.status === 'error' && r.started_at && Date.parse(r.started_at) >= weekAgo)
          .length,
      });
    },
    listRuns: (q) =>
      runs({
        ...(q.flowId ? { zapId: q.flowId } : {}),
        ...(q.status === 'error' ? { status: 'error' } : {}),
        limit: q.limit,
        ...(q.since ? { from: q.since } : {}),
      }),
    getRun: async (id, flowId) => {
      const found = (await runs({ ...(flowId ? { zapId: flowId } : {}), limit: 100 })).find((r) => r.id === id);
      if (!found) throw new AppError('not_found', 'flow_platform_not_found');
      return found;
    },
  };
};
