// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  FLOW_PLATFORM_CAPS,
  type Flow,
  type FlowRun,
  type FlowRunStatus,
  type N8nWorkflowFull,
} from '@bines/shared';
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
 * n8n — its public REST API (`<instance>/api/v1`, header `X-N8N-API-KEY`; docs.n8n.io → n8n API):
 * - `GET /workflows` (cursor pages, ≤ 250), `GET /workflows/{id}`, `POST /workflows` (a new workflow is inactive);
 * - `POST /workflows/{id}/activate|deactivate` — renamed `publish|unpublish` in n8n 2.40 (the old names still work
 *   there, and the new ones do not exist before it): the old name first, the new one when the old is gone;
 * - `GET /executions?workflowId&status&limit&cursor&includeData`, `GET /executions/{id}`, `POST /executions/{id}/retry`
 *   (only error / crashed / canceled runs). Status: canceled · crashed · error · new · running · success · unknown ·
 *   waiting.
 * n8n Cloud offers the API on paid plans only (not in the trial) — the connection test says so plainly.
 */
type N8nWorkflow = {
  id: string;
  name: string;
  active: boolean;
  isArchived?: boolean;
  updatedAt?: string;
  tags?: { name?: string }[];
};
type N8nExecution = {
  id: string | number;
  workflowId?: string | number;
  status?: string;
  finished?: boolean;
  mode?: string;
  startedAt?: string;
  stoppedAt?: string | null;
  data?: {
    resultData?: {
      error?: { message?: string; description?: string; node?: { name?: string } | string };
      lastNodeExecuted?: string;
    };
  };
};
type Page<T> = { data: T[]; nextCursor?: string | null };

const MAX_FLOWS = 500;

/** Workflow settings n8n's public API accepts on save (it refuses any other key). */
const N8N_SETTINGS = [
  'saveExecutionProgress',
  'saveManualExecutions',
  'saveDataErrorExecution',
  'saveDataSuccessExecution',
  'executionTimeout',
  'errorWorkflow',
  'timezone',
  'executionOrder',
  'callerPolicy',
  'callerIds',
  'timeSavedPerExecution',
  'availableInMCP',
];
const RUNS_FOR_STATS = 250;

const STATUS: Record<string, FlowRunStatus> = {
  success: 'success',
  error: 'error',
  crashed: 'error',
  canceled: 'canceled',
  running: 'running',
  new: 'running',
  waiting: 'waiting',
};

export const n8nRunStatus = (e: Pick<N8nExecution, 'status' | 'finished'>): FlowRunStatus =>
  (e.status ? STATUS[e.status] : undefined) ?? (e.finished === true ? 'success' : 'other');

export const n8nAdapter = (opts: {
  baseUrl: string;
  apiKey: string;
  http: FlowHttp;
  onFlowError?: FlowErrorReporter;
}): FlowAdapter => {
  const root = opts.baseUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  const api = `${root}/api/v1`;
  const headers = { 'X-N8N-API-KEY': opts.apiKey };
  const call = <T>(method: string, path: string, json?: unknown) =>
    jsonCall<T>(opts.http, { method, url: `${api}${path}`, headers, ...(json !== undefined ? { json } : {}) });

  const flowUrl = (id: string) => `${root}/workflow/${encodeURIComponent(id)}`;
  const runUrl = (wf: string | null, id: string) =>
    wf ? `${root}/workflow/${encodeURIComponent(wf)}/executions/${encodeURIComponent(id)}` : null;

  const toRun = (e: N8nExecution, names?: Map<string, string>): FlowRun => {
    const status = n8nRunStatus(e);
    const started = iso(e.startedAt);
    const finished = iso(e.stoppedAt);
    const err = e.data?.resultData?.error;
    const node = typeof err?.node === 'string' ? err.node : (err?.node?.name ?? null);
    const flowId = str(e.workflowId);
    const id = String(e.id);
    return {
      id,
      flow_id: flowId,
      flow_name: flowId ? (names?.get(flowId) ?? null) : null,
      status,
      started_at: started,
      finished_at: finished,
      duration_ms: durationOf(started, finished),
      error: status === 'error' ? [err?.message, err?.description].filter(Boolean).join(' — ') || null : null,
      error_node: status === 'error' ? (node ?? e.data?.resultData?.lastNodeExecuted ?? null) : null,
      mode: e.mode ?? null,
      can_retry: status === 'error' || status === 'canceled',
      open_url: runUrl(flowId, id),
    };
  };

  type Stats = { last?: FlowRun; errors?: number; warning?: string; warning_detail?: string };
  const toFlow = (w: N8nWorkflow, stats?: Stats): Flow => ({
    id: String(w.id),
    name: w.name,
    active: !!w.active,
    status: stats?.last?.status === 'error' ? 'error' : w.active ? 'active' : 'inactive',
    updated_at: iso(w.updatedAt),
    last_run_at: stats?.last?.started_at ?? null,
    last_run_status: stats?.last?.status ?? null,
    errors_7d: stats && !stats.warning ? (stats.errors ?? 0) : null,
    open_url: flowUrl(String(w.id)),
    tags: (w.tags ?? []).map((t) => t.name ?? '').filter(Boolean),
    ...(stats?.warning ? { warning: stats.warning, warning_detail: stats.warning_detail ?? null } : {}),
  });

  const executions = async (q: { flowId?: string; status?: string; limit: number; data?: boolean }) => {
    const params = new URLSearchParams({ limit: String(Math.min(250, q.limit)) });
    if (q.flowId) params.set('workflowId', q.flowId);
    if (q.status) params.set('status', q.status);
    if (q.data) params.set('includeData', 'true');
    return (await call<Page<N8nExecution>>('GET', `/executions?${params}`)).data ?? [];
  };

  const allWorkflows = async () => {
    const out: N8nWorkflow[] = [];
    let cursor: string | null | undefined;
    do {
      const params = new URLSearchParams({ limit: '250' });
      if (cursor) params.set('cursor', cursor);
      const page = await call<Page<N8nWorkflow>>('GET', `/workflows?${params}`);
      out.push(...(page.data ?? []));
      cursor = page.nextCursor;
    } while (cursor && out.length < MAX_FLOWS);
    return out.filter((w) => !w.isArchived).slice(0, MAX_FLOWS);
  };

  /** The last run and the failures of the week per workflow — two calls for the whole instance. */
  const stats = async () => {
    const [recent, failed] = await Promise.all([
      executions({ limit: RUNS_FOR_STATS }),
      executions({ limit: RUNS_FOR_STATS, status: 'error' }),
    ]);
    const weekAgo = Date.now() - WEEK_MS;
    const by = new Map<string, { last?: FlowRun; errors: number }>();
    for (const e of recent) {
      const r = toRun(e);
      if (!r.flow_id) continue;
      const s = by.get(r.flow_id) ?? { errors: 0 };
      if (!s.last) s.last = r;
      by.set(r.flow_id, s);
    }
    for (const e of failed) {
      const r = toRun(e);
      if (!r.flow_id || !r.started_at || new Date(r.started_at).getTime() < weekAgo) continue;
      const s = by.get(r.flow_id) ?? { errors: 0 };
      s.errors += 1;
      by.set(r.flow_id, s);
    }
    return by;
  };

  const toggle = async (id: string, active: boolean) => {
    const enc = encodeURIComponent(id);
    try {
      return await call<N8nWorkflow>('POST', `/workflows/${enc}/${active ? 'activate' : 'deactivate'}`);
    } catch (err) {
      // n8n ≥ 2.40 may drop the old names: try the new ones once.
      if (err instanceof AppError && err.code === 'not_found')
        return call<N8nWorkflow>('POST', `/workflows/${enc}/${active ? 'publish' : 'unpublish'}`);
      throw err;
    }
  };

  return {
    caps: FLOW_PLATFORM_CAPS.n8n,
    test: async () => {
      await call('GET', '/workflows?limit=1');
      try {
        await executions({ limit: 1 });
      } catch (err) {
        return { warning: statsWarning(err).warning_detail };
      }
    },
    listFlows: async () => {
      // The executions failing (a key without that scope, an old instance) leaves the list with null stats.
      const [flows, s] = await Promise.all([
        allWorkflows(),
        stats().catch((err: unknown) => {
          opts.onFlowError?.('*', err);
          return statsWarning(err);
        }),
      ]);
      return flows.map((w) => toFlow(w, s instanceof Map ? (s.get(String(w.id)) ?? { errors: 0 }) : s));
    },
    getFlow: async (id) => {
      const w = await call<N8nWorkflow>('GET', `/workflows/${encodeURIComponent(id)}`);
      let runs: N8nExecution[];
      try {
        runs = await executions({ flowId: id, limit: 50 });
      } catch (err) {
        opts.onFlowError?.(id, err);
        return toFlow(w, statsWarning(err));
      }
      const weekAgo = Date.now() - WEEK_MS;
      const mapped = runs.map((e) => toRun(e));
      return toFlow(w, {
        ...(mapped[0] ? { last: mapped[0] } : {}),
        errors: mapped.filter(
          (r) => r.status === 'error' && r.started_at && new Date(r.started_at).getTime() >= weekAgo,
        ).length,
      });
    },
    setActive: async (id, active) => {
      const w = await toggle(id, active);
      return toFlow({ ...w, active: w.active ?? active });
    },
    listRuns: async (q) => {
      const rows = await executions({
        ...(q.flowId ? { flowId: q.flowId } : {}),
        ...(q.status === 'error' ? { status: 'error' } : {}),
        limit: q.limit,
      });
      const runs = rows.map((e) => toRun(e));
      return q.since ? runs.filter((r) => !r.started_at || new Date(r.started_at) >= q.since!) : runs;
    },
    getRun: async (id) =>
      toRun(await call<N8nExecution>('GET', `/executions/${encodeURIComponent(id)}?includeData=true`)),
    retryRun: async (id) => {
      const out = await call<{ id?: string | number } | null>('POST', `/executions/${encodeURIComponent(id)}/retry`, {
        loadWorkflow: true,
      });
      return { run_id: str(out?.id) };
    },
    createFlow: async (workflow) => {
      // Only the fields n8n accepts on create (`active` is read-only there: a new workflow is always inactive).
      const w = await call<N8nWorkflow>('POST', '/workflows', {
        name: workflow.name,
        nodes: workflow.nodes,
        connections: workflow.connections,
        settings: workflow.settings,
      });
      // Never left running by us, whatever a future n8n does on create.
      if (w.active) await toggle(String(w.id), false);
      return toFlow({ ...w, active: false });
    },
    getDefinition: async (id) => call<N8nWorkflowFull>('GET', `/workflows/${encodeURIComponent(id)}`),
    saveDefinition: async (id, workflow, active) => {
      const enc = encodeURIComponent(id);
      // Switched off first: an edit is never live before a person switches it on (unless they asked to keep it).
      if (!active && workflow.active) await toggle(id, false);
      const settings = Object.fromEntries(
        Object.entries(workflow.settings ?? {}).filter(([k]) => N8N_SETTINGS.includes(k)),
      );
      const w = await call<N8nWorkflow>('PUT', `/workflows/${enc}`, {
        name: workflow.name,
        nodes: workflow.nodes,
        connections: workflow.connections,
        settings,
        ...(workflow.staticData !== undefined && workflow.staticData !== null
          ? { staticData: workflow.staticData }
          : {}),
      });
      if (active && !w.active) await toggle(id, true);
      return toFlow({ ...w, active });
    },
  };
};
