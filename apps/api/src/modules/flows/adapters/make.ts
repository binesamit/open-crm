// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  FLOW_PLATFORM_CAPS,
  type Flow,
  type FlowRun,
  type FlowRunStatus,
  type FlowStats,
} from '@bines/shared';
import {
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
 * Make — API v2 (`https://<zone>.make.com/api/v2`, header `Authorization: Token <token>`; developers.make.com):
 * - `GET /scenarios?teamId&pg[limit]` → `{scenarios}`; `GET /scenarios/{id}` → `{scenario}` (isActive, isPaused,
 *   isinvalid, lastEdit, nextExec);
 * - `POST /scenarios/{id}/start|stop`;
 * - `GET /scenarios/{id}/logs?status&from&to&pg[limit]` (token scope `scenarios:read`, the same as the list) →
 *   `{scenarioLogs}` (status 1 success · 2 warning · 3 error; timestamp, duration ms, id = the execution id). Make
 *   documents them as newest first (sorted by `imtId`, descending), so no `pg[sortBy]`/`pg[sortDir]` is sent (prod
 *   answered 400 to `pg[limit]=100&pg[sortDir]=desc`, 2026-10-07); small pages; `from`/`to` in epoch milliseconds.
 *   A refused logs call never fails the list: that scenario shows `warning` + Make's reason. The logs also hold the
 *   scenario's edits (`type: "modify"`, no status): they are not runs and are left out.
 *   Make limits API calls per organization per minute (by plan: Core 60, Pro 120, Teams 240, Enterprise 1000) and
 *   answers 429 past it; a pass over many scenarios stops calling at the first 429 (or at our own budget, see
 * flows.limits.ts) instead of burning the minute's quota further (2026-10-08).
 *   So the list is ONE call (`GET /scenarios`): a scenario's last run and failures of the week need two logs calls
 *   each, and are asked lazily per scenario (`flowStats`, for the active scenarios on screen, paced, kept). The list's
 *   `cols[]=executions|errors` count "the reported period" (not 7 days, not the last run), so they are not used.
 *   `GET /scenarios/{id}/logs/{executionId}`;
 * - `POST /scenarios/{id}/executions/{executionId}/replay` (a new run with the original data, latest blueprint).
 * Runs live under a scenario, so the account-wide failure check walks the scenarios (capped).
 *
 * Creating scenarios stays off (caps.create = false), on purpose. Make's API can do it — `POST /scenarios` with
 * `teamId`, `blueprint` and `scheduling` (both as JSON strings) creates an inactive scenario, `?confirmed=true` when
 * the blueprint uses an app the organization has not installed yet — but a clean draft → blueprint compiler needs
 * three things that do not exist yet:
 * 1. the module ids of our Make app (integrations/make-app-bines-os): a blueprint names `<app name>:<module>` plus the
 *    app version, and Make assigns the app's name only when it is pushed — it would be a per-connection setting;
 * 2. a translation of the draft's values: drafts carry n8n expressions (`={{ $json.item.name }}`, see
 *    packages/shared/src/flows/draft.ts) while Make maps by module number (`{{1.item.name}}`), and core steps map to
 *    other modules (http, set variables, sleep, filters on routes);
 * 3. the instant trigger's hook and the Bines OS connection inside Make (`__IMTHOOK__`, `__IMTCONN__`): both are made
 *    in Make with the person's own API token, which this server never holds.
 * Until then the AI builder offers creating only where `create` is true (n8n).
 */
type MakeScenario = {
  id: number;
  name: string;
  teamId?: number;
  isActive?: boolean;
  isPaused?: boolean;
  isinvalid?: boolean;
  lastEdit?: string;
};
type MakeLog = {
  id?: string;
  imtId?: string;
  executionId?: string;
  status?: number;
  timestamp?: string;
  duration?: number;
  type?: string;
  error?: { message?: string; name?: string; module?: { name?: string } } | string | null;
  detail?: { error?: { message?: string } };
};

const MAX_FLOWS = 200;
/** Scenarios the account-wide runs / failure check look at (one call each; active scenarios only). */
const MAX_SCANNED = 50;
/** One page of logs (Make's pages are small; the 7-day failure count is "at least" this many). */
const LOGS_PAGE = 50;

const STATUS: Record<number, FlowRunStatus> = { 1: 'success', 2: 'warning', 3: 'error' };
/** A log row that is a run (an execution), not an edit of the scenario. */
const isRun = (l: MakeLog) => l.type !== 'modify';
/** Make's "too many requests for the organization" — the rest of a pass would only get it again. */
const isRateLimited = (err: unknown) =>
  err instanceof AppError && (err.details?.status === 429 || err.code === 'rate_limited');

export const makeAdapter = (opts: {
  zone: string;
  teamId: number;
  apiToken: string;
  http: FlowHttp;
  onFlowError?: FlowErrorReporter;
}): FlowAdapter => {
  const origin = `https://${opts.zone}.make.com`;
  const api = `${origin}/api/v2`;
  const headers = { authorization: `Token ${opts.apiToken}` };
  const call = <T>(method: string, path: string, json?: unknown) =>
    jsonCall<T>(opts.http, { method, url: `${api}${path}`, headers, ...(json !== undefined ? { json } : {}) });
  const flowUrl = (id: string) => `${origin}/${opts.teamId}/scenarios/${encodeURIComponent(id)}/edit`;

  const toRun = (log: MakeLog, flowId: string, flowName: string | null): FlowRun => {
    const status = (log.status !== undefined && STATUS[log.status]) || 'other';
    const started = iso(log.timestamp);
    const err = log.error ?? log.detail?.error ?? null;
    const message = typeof err === 'string' ? err : (err?.message ?? null);
    const id = str(log.executionId) ?? str(log.id) ?? str(log.imtId) ?? '';
    return {
      id,
      flow_id: flowId,
      flow_name: flowName,
      status,
      started_at: started,
      finished_at:
        started && typeof log.duration === 'number'
          ? new Date(new Date(started).getTime() + log.duration).toISOString()
          : null,
      duration_ms: typeof log.duration === 'number' ? log.duration : null,
      error: status === 'error' ? message : null,
      error_node:
        status === 'error' && typeof err === 'object' && err
          ? ((err as { module?: { name?: string } }).module?.name ?? null)
          : null,
      mode: log.type ?? null,
      can_retry: status === 'error' || status === 'warning',
      open_url: flowUrl(flowId),
    };
  };

  const logs = async (flowId: string, q: { status?: number; limit: number; from?: Date }) => {
    const params = new URLSearchParams({ 'pg[limit]': String(Math.max(1, Math.min(LOGS_PAGE, q.limit))) });
    if (q.status) params.set('status', String(q.status));
    if (q.from) {
      params.set('from', String(q.from.getTime()));
      params.set('to', String(Date.now()));
    }
    return (
      (await call<{ scenarioLogs?: MakeLog[] }>('GET', `/scenarios/${encodeURIComponent(flowId)}/logs?${params}`))
        .scenarioLogs ?? []
    );
  };

  type Stats = { last?: FlowRun; errors?: number; warning?: string; warning_detail?: string };
  const toFlow = (s: MakeScenario, stats?: Stats): Flow => ({
    id: String(s.id),
    name: s.name,
    active: !!s.isActive && !s.isPaused,
    status:
      s.isinvalid || stats?.last?.status === 'error' ? 'error' : s.isActive && !s.isPaused ? 'active' : 'inactive',
    updated_at: iso(s.lastEdit),
    last_run_at: stats?.last?.started_at ?? null,
    last_run_status: stats?.last?.status ?? null,
    errors_7d: stats && !stats.warning ? (stats.errors ?? 0) : null,
    open_url: flowUrl(String(s.id)),
    tags: [],
    ...(stats?.warning ? { warning: stats.warning, warning_detail: stats.warning_detail ?? null } : {}),
  });

  /**
   * A scenario's last run and failures of the week (two logs calls). A refused logs call → null stats + the reason;
   * a rate limit (Make's 429, our budget) is thrown — the caller stops and asks again later.
   */
  const statsOf = async (s: Pick<MakeScenario, 'id' | 'name'>): Promise<Stats> => {
    const id = String(s.id);
    try {
      // A few rows, not one: the newest may be an edit of the scenario, not a run.
      const last = (await logs(id, { limit: 5 })).find(isRun);
      const failed = await logs(id, { status: 3, limit: LOGS_PAGE, from: new Date(Date.now() - WEEK_MS) });
      return { ...(last ? { last: toRun(last, id, s.name) } : {}), errors: failed.filter(isRun).length };
    } catch (err) {
      if (isRateLimited(err)) throw err;
      opts.onFlowError?.(id, err);
      return statsWarning(err);
    }
  };
  const statsDto = (st: Stats): FlowStats => ({
    last_run_at: st.last?.started_at ?? null,
    last_run_status: st.last?.status ?? null,
    errors_7d: st.warning ? null : (st.errors ?? 0),
    ...(st.last?.status === 'error' ? { status: 'error' as const } : {}),
    ...(st.warning ? { warning: st.warning, warning_detail: st.warning_detail ?? null } : {}),
  });

  const scenarios = async () =>
    (
      (
        await call<{ scenarios?: MakeScenario[] }>(
          'GET',
          `/scenarios?${new URLSearchParams({ teamId: String(opts.teamId), 'pg[limit]': String(MAX_FLOWS) })}`,
        )
      ).scenarios ?? []
    ).slice(0, MAX_FLOWS);

  const scenario = async (id: string) =>
    (await call<{ scenario: MakeScenario }>('GET', `/scenarios/${encodeURIComponent(id)}`)).scenario;

  return {
    caps: FLOW_PLATFORM_CAPS.make,
    test: async () => {
      const first = (
        await call<{ scenarios?: MakeScenario[] }>(
          'GET',
          `/scenarios?${new URLSearchParams({ teamId: String(opts.teamId), 'pg[limit]': '1' })}`,
        )
      ).scenarios?.[0];
      if (!first) return;
      // The run history is a second permission in practice (a token's scopes, a team's role): check it too.
      try {
        await logs(String(first.id), { limit: 1 });
      } catch (err) {
        return { warning: statsWarning(err).warning_detail };
      }
    },
    // One call; the stats come per scenario through `flowStats`.
    listFlows: async () => (await scenarios()).map((s) => toFlow(s)),
    flowStats: async (f) => statsDto(await statsOf({ id: Number(f.id), name: f.name })),
    getFlow: async (id) => {
      const s = await scenario(id);
      try {
        return toFlow(s, await statsOf(s));
      } catch (err) {
        if (!isRateLimited(err)) throw err;
        return toFlow(s, statsWarning(err));
      }
    },
    setActive: async (id, active) => {
      await call('POST', `/scenarios/${encodeURIComponent(id)}/${active ? 'start' : 'stop'}`);
      return toFlow(await scenario(id));
    },
    listRuns: async (q) => {
      const status = q.status === 'error' ? 3 : undefined;
      // One scenario: its logs only — no extra `GET /scenarios/{id}` for the name (the caller has it; a call less
      // against Make's per-minute limit). An unknown scenario answers 404 from the logs call itself.
      // Many: the active scenarios only (an inactive one does not run), from the kept list when the caller has it.
      const targets: { id: string; name: string | null }[] = q.flowId
        ? [{ id: q.flowId, name: null }]
        : (q.flows ?? (await scenarios()).map((s) => toFlow(s)))
            .filter((f) => f.active)
            .slice(0, MAX_SCANNED)
            .map((f) => ({ id: f.id, name: f.name }));
      const runs: FlowRun[] = [];
      for (const s of targets) {
        let rows: MakeLog[];
        try {
          rows = await logs(String(s.id), {
            ...(status ? { status } : {}),
            limit: q.limit,
            ...(q.since ? { from: q.since } : {}),
          });
        } catch (err) {
          // One scenario: its error goes up (the runs endpoint answers it as a warning, flows.service listFlowRuns).
          // Many (the failure check, the account's runs): skip it, go on — and stop at Make's per-minute limit.
          if (q.flowId) throw err;
          opts.onFlowError?.(String(s.id), err);
          if (isRateLimited(err)) break;
          continue;
        }
        q.onFlowRead?.(s.id);
        runs.push(...rows.filter(isRun).map((l) => toRun(l, s.id, s.name)));
      }
      return runs.sort((x, y) => (y.started_at ?? '').localeCompare(x.started_at ?? '')).slice(0, q.limit);
    },
    getRun: async (id, flowId) => {
      if (!flowId) throw new AppError('invalid_value', 'flow_id_required');
      const log = await call<{ scenarioLog?: MakeLog } & MakeLog>(
        'GET',
        `/scenarios/${encodeURIComponent(flowId)}/logs/${encodeURIComponent(id)}`,
      );
      return toRun({ ...(log.scenarioLog ?? log), executionId: id }, flowId, null);
    },
    retryRun: async (id, flowId) => {
      if (!flowId) throw new AppError('invalid_value', 'flow_id_required');
      const out = await call<{ executionId?: string } | null>(
        'POST',
        `/scenarios/${encodeURIComponent(flowId)}/executions/${encodeURIComponent(id)}/replay`,
      );
      return { run_id: str(out?.executionId) };
    },
  };
};
