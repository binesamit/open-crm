// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type Flow,
  type FlowConnection,
  type FlowConnectionSettings,
  type FlowConnectionTarget,
  type FlowDraftAnswer,
  type FlowLimit,
  type FlowPlatform,
  type FlowRun,
  type FlowStats,
  formatTime,
  type MyAccount,
  relativeTime,
  t,
  tDynamic,
} from '@bines/shared';
import {
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  Picker,
  Segmented,
  SkeletonRows,
  Switch,
} from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDelete } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { PlanUpgradeLink, usePlanGate } from '../../lib/plan-gate';
import { planGateAttrs } from '../../lib/plan-limit';
import { showToast } from '../../lib/toast';
import { Panel } from '../admin/admin-parts';
import { AssistantPanel } from '../ai2/AssistantPanel';
import { defaultChoiceLabel, modelChoices, modelPickerOptions, useAiConnections, useAiModels } from '../ai/ai-api';
import { useMembers } from '../board/board-api';
import { fetchFlowStats, useFlowConnections, useFlowMutations, useFlowRuns, useFlows } from './flows-api';
import { brandText } from '../../lib/branding';

const STATUS_TONE: Record<string, 'ok' | 'danger' | 'neutral' | 'info' | 'warn'> = {
  active: 'ok',
  inactive: 'neutral',
  error: 'danger',
  success: 'ok',
  warning: 'warn',
  running: 'info',
  waiting: 'info',
  canceled: 'neutral',
  skipped: 'neutral',
  other: 'neutral',
};

/**
 * The platform cannot be asked right now. Our own per-minute budget: a calm line — the rest
 * comes at the time it says, nothing is wrong. The platform's "too many requests": its limit is the customer's whole
 * account, shared with any other system on it, so it says so, that we slowed down (to how many calls a minute) and
 * when we go on. The platform's own text is in the tooltip, not the sentence.
 */
const LimitNotice = ({ limit, platform }: { limit: FlowLimit; platform: FlowPlatform }) => (
  <div data-testid="flow-limited" data-by={limit.by} title={limit.reason ?? undefined}>
    <Notice tone={limit.by === 'platform' ? 'warn' : 'info'}>
      {limit.by === 'platform'
        ? t('flows.limited.platform', { platform: t(`flows.platform.${platform}`), time: formatTime(limit.until) })
        : t('flows.limited.budget', { time: formatTime(limit.until) })}
      {limit.slowed_to ? ` · ${t('flows.limited.slowed', { calls: limit.slowed_to })}` : null}
    </Notice>
  </div>
);

/** A limit still in force (its time not passed). */
const activeLimit = (limit: FlowLimit | null | undefined, now: number) =>
  limit && new Date(limit.until).getTime() > now ? limit : null;

const External = ({ href, testId }: { href: string; testId?: string }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    data-testid={testId}
    className="inline-flex h-7 items-center gap-1 rounded-[8px] px-2 text-xs font-semibold text-primary hover:bg-surface-2"
  >
    <Icon name="link" size={12} />
    {t('flows.open')}
  </a>
);

/**
 * "זרימות": the account's connections to external automation platforms (n8n / Make / Zapier) and
 * their flows — status, last run, failures of the week, on / off, run history with errors, "run again", and "new flow
 * with AI" (a draft the admin approves; created switched off). Admins manage; members see a connection an admin
 * opened to them, read only. What each platform allows comes from the server (`caps`).
 *
 * /: `link` (the URL's `?connection=&flow=&run=` — a flow notification, `{flow.url}` in an
 * automation) opens that connection and the flow's runs, the run marked; "ask the assistant" opens the assistant
 * panel with the flow (and run) ready in its box.
 */
export type FlowLinkParams = { connection?: string; flow?: string; run?: string };

export const FlowsPage = ({ account, link }: { account: MyAccount; link?: FlowLinkParams }) => {
  const list = useFlowConnections(account.id);
  const [editing, setEditing] = useState<FlowConnection | 'new' | null>(null);
  const [picked, setPicked] = useState<string | null>(link?.connection ?? null);
  const connections = list.data?.data ?? [];
  const platforms = list.data?.platforms ?? [];
  const admin = account.role === 'admin';
  const flowsGate = usePlanGate(account.id, 'flows');
  const selected = connections.find((c) => c.id === picked) ?? connections[0] ?? null;
  return (
    <div className="space-y-4" data-testid="flows-page">
      <Panel
        title={t('flows.title')}
        hint={t('flows.hint')}
        testId="flow-connections"
        actions={
          admin && platforms.length ? (
            <span className="flex items-center gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => flowsGate.allowed && setEditing('new')}
                data-testid="flow-connection-add"
                {...planGateAttrs(flowsGate)}
              >
                {t('flows.connection.add')}
              </Button>
              <PlanUpgradeLink gate={flowsGate} />
            </span>
          ) : null
        }
      >
        {list.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
        {list.isError ? (
          <div className="p-3.5">
            <Notice tone="error">{errorMessage(list.error)}</Notice>
          </div>
        ) : null}
        {!list.isPending && !connections.length ? (
          <EmptyState icon={<Icon name="bolt" size={26} />} title={t('flows.none')}>
            {admin ? t('flows.noneHint') : t('flows.noneMember')}
          </EmptyState>
        ) : null}
        <ul>
          {connections.map((c) => (
            <ConnectionRow
              key={c.id}
              account={account}
              connection={c}
              selected={selected?.id === c.id}
              onSelect={() => setPicked(c.id)}
              onEdit={() => setEditing(c)}
            />
          ))}
        </ul>
      </Panel>
      {selected ? (
        <FlowsTable
          key={selected.id}
          account={account}
          connection={selected}
          link={link?.connection === selected.id ? link : undefined}
        />
      ) : null}
      {editing ? (
        <ConnectionDialog
          account={account}
          connection={editing === 'new' ? null : editing}
          platforms={platforms}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
};

const ConnectionRow = ({
  account,
  connection: c,
  selected,
  onSelect,
  onEdit,
}: {
  account: MyAccount;
  connection: FlowConnection;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
}) => {
  const m = useFlowMutations(account.id);
  const now = useNow();
  const [drafting, setDrafting] = useState(false);
  const aiOn = c.can_manage && c.caps.create && !!c.settings?.ai_create;
  // The AI flow builder needs the plan's `flows` and `ai` (the first one missing is the one shown).
  const flowsGate = usePlanGate(account.id, 'flows');
  const aiGate = usePlanGate(account.id, 'ai');
  const draftGate = flowsGate.allowed ? aiGate : flowsGate;
  return (
    <li
      className={cn(
        'space-y-2 border-b border-line-soft px-3.5 py-3 last:border-b-0',
        selected && 'bg-primary-soft/40',
      )}
      data-testid="flow-connection"
      data-platform={c.platform}
      data-name={c.name}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          className="min-w-0 flex-1 basis-60 text-start"
          data-testid="flow-connection-select"
        >
          <span className="font-semibold text-fg">{c.name}</span>{' '}
          <span className="text-xs text-muted" dir="ltr">
            {c.base_url}
          </span>
        </button>
        <Badge tone="violet">{t(`flows.platform.${c.platform}`)}</Badge>
        <Badge tone={c.status === 'ok' ? 'ok' : c.status === 'error' ? 'danger' : 'neutral'}>
          {t(`flows.connection.status.${c.status}`)}
        </Badge>
        {c.can_manage ? (
          <Switch
            checked={c.enabled}
            label={t('flows.connection.enabled')}
            disabled={m.update.isPending}
            onChange={(on) => m.update.mutate({ id: c.id, enabled: on })}
            testId="flow-connection-enabled"
          />
        ) : null}
      </div>
      {c.last_error ? <Notice tone="error">{t('flows.connection.error', { error: c.last_error })}</Notice> : null}
      {c.warning ? (
        <div data-testid="flow-connection-warning">
          <Notice tone="warn">{t('flows.connection.warning', { error: c.warning })}</Notice>
        </div>
      ) : null}
      {activeLimit(c.limited, now) ? <LimitNotice limit={c.limited!} platform={c.platform} /> : null}
      {!c.caps.toggle && !c.caps.create ? <p className="text-xs text-muted">{t('flows.caps.monitorOnly')}</p> : null}
      {c.can_manage ? (
        <div className="flex flex-wrap items-center gap-2">
          {c.secret_hint ? (
            <span className="text-xs text-muted" dir="ltr">
              {c.secret_hint}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            busy={m.test.isPending}
            onClick={() =>
              m.test.mutate(c.id, {
                onSuccess: (r) =>
                  showToast({
                    message: t(
                      r.status !== 'ok'
                        ? 'flows.connection.testFailed'
                        : r.warning
                          ? 'flows.connection.testOkWarning'
                          : 'flows.connection.testOk',
                    ),
                    ...(r.status === 'ok' ? {} : { tone: 'error' as const }),
                  }),
              })
            }
            data-testid="flow-connection-test"
          >
            {t('flows.connection.test')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit} data-testid="flow-connection-edit">
            {t('flows.connection.edit')}
          </Button>
          {aiOn ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => draftGate.allowed && setDrafting(true)}
                data-testid="flow-ai-new"
                {...planGateAttrs(draftGate)}
              >
                <Icon name="sparkle" size={14} />
                {t('flows.ai.new')}
              </Button>
              <PlanUpgradeLink gate={draftGate} />
            </>
          ) : null}
          <Button
            size="sm"
            variant="danger-outline"
            onClick={async () => {
              if (!(await confirmDelete(c.name))) return;
              await m.remove.mutateAsync(c.id);
            }}
            data-testid="flow-connection-delete"
          >
            {t('common.delete')}
          </Button>
        </div>
      ) : null}
      {drafting ? <AiDraftDialog account={account} connection={c} onClose={() => setDrafting(false)} /> : null}
    </li>
  );
};

// ---- the flows of one connection ----

/** "Ask the assistant about this flow": the panel opens (no board) with the flow — and a failed run — in its box. */
export type AskAbout = { flow: Pick<Flow, 'id' | 'name'>; run?: Pick<FlowRun, 'id' | 'status'> | null };

const askPrefill = (c: FlowConnection, q: AskAbout) =>
  t(q.run ? 'flows.ai.askPrefillRun' : 'flows.ai.askPrefill', {
    name: q.flow.name,
    platform: t(`flows.platform.${c.platform}`),
    connection: c.name,
    connection_id: c.id,
    flow_id: q.flow.id,
    run_id: q.run?.id ?? '',
  });

const AskButton = ({ account, onAsk }: { account: MyAccount; onAsk: () => void }) => {
  const aiGate = usePlanGate(account.id, 'ai');
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => aiGate.allowed && onAsk()}
      title={t('flows.ai.ask')}
      data-testid="flow-ask-assistant"
      {...planGateAttrs(aiGate)}
    >
      <Icon name="sparkle" size={14} />
      <span className="max-sm:sr-only">{t('flows.ai.ask')}</span>
    </Button>
  );
};

/** Flows per page; only the page on screen loads its stats. */
const PAGE_SIZE = 25;
/** Flows per stats request (the server paces the platform calls inside it). */
const STATS_CHUNK = 5;

/**
 * The stats of the flows on screen, for platforms that load them per flow (Make): the active flows of
 * the visible page still `stats_pending` are asked a few at a time, one request after the other; the server paces the
 * platform calls and keeps the answers. When the platform (or the connection's budget) says "not now", loading stops and
 * resumes at the time it gave.
 */
const useLazyStats = (accountId: string, connectionId: string, visible: Flow[]) => {
  const [stats, setStats] = useState<Record<string, FlowStats>>({});
  const [limited, setLimited] = useState<FlowLimit | null>(null);
  /** After "refresh": every active flow on screen is asked again (the server keeps the per-flow refresh pace). */
  const [refreshAll, setRefreshAll] = useState(false);
  /** Asked and not answered for a reason other than a limit (e.g. no longer listed): not asked again this visit. */
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const busy = useRef(false);
  const alive = useRef(true);
  const wanted = useMemo(
    () =>
      visible
        .filter((f) => (f.stats_pending || (refreshAll && f.active)) && !stats[f.id] && !skipped.has(f.id))
        .map((f) => f.id),
    [visible, stats, skipped, refreshAll],
  );
  const key = wanted.join(',');
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // One chunk per pass: its answer changes `stats`, which starts the next chunk.
  useEffect(() => {
    if (!wanted.length || busy.current) return;
    if (limited && new Date(limited.until).getTime() > Date.now()) return;
    const chunk = wanted.slice(0, STATS_CHUNK);
    const last = wanted.length <= STATS_CHUNK;
    busy.current = true;
    void fetchFlowStats(accountId, connectionId, chunk, refreshAll)
      .then((answer) => {
        busy.current = false;
        if (!alive.current) return;
        const stopped = !!answer.limited && answer.pending.length > 0;
        if (stopped) setLimited(answer.limited);
        else {
          const missing = chunk.filter((id) => !answer.data[id]);
          if (missing.length) setSkipped((x) => new Set([...x, ...missing]));
          if (last) setRefreshAll(false);
        }
        setStats((x) => ({ ...x, ...answer.data }));
      })
      .catch(() => {
        busy.current = false;
        // The list itself shows the connection's trouble; these rows are not asked again this visit.
        if (alive.current) setSkipped((x) => new Set([...x, ...chunk]));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, limited, accountId, connectionId]);
  // Resume when the limit's time has come.
  useEffect(() => {
    if (!limited) return;
    const ms = new Date(limited.until).getTime() - Date.now();
    const timer = setTimeout(() => setLimited(null), Math.max(1000, ms + 1000));
    return () => clearTimeout(timer);
  }, [limited]);
  return {
    limited,
    /** Stats still on their way (not paused by a limit). */
    loading: wanted.length > 0 && !limited,
    merge: (f: Flow): Flow => {
      const s = stats[f.id];
      if (!s) return f;
      const { status, ...rest } = s;
      return { ...f, ...rest, stats_pending: false, status: status === 'error' ? 'error' : f.status };
    },
    /** After a refresh: ask the page's stats again (the server decides whether the platform is asked). */
    reload: () => {
      setRefreshAll(true);
      setSkipped(new Set());
      setStats({});
      setLimited(null);
    },
  };
};

/** The time now, ticking (for "updated … ago" and whether a limit still holds) — never read during render. */
const useNow = (everyMs = 15_000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
};

const FlowsTable = ({
  account,
  connection: c,
  link,
}: {
  account: MyAccount;
  connection: FlowConnection;
  link?: FlowLinkParams | undefined;
}) => {
  const flows = useFlows(account.id, c.enabled ? c.id : null);
  const m = useFlowMutations(account.id);
  const now = useNow();
  const [runsOf, setRunsOf] = useState<Flow | 'all' | null>(null);
  const [asking, setAsking] = useState<AskAbout | null>(null);
  const [wantedPage, setPage] = useState(0);
  const all = useMemo(() => flows.data?.data ?? [], [flows.data]);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const page = Math.min(wantedPage, pages - 1);
  const visible = useMemo(() => all.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [all, page]);
  const lazy = useLazyStats(account.id, c.id, visible);
  const rows = visible.map((f) => lazy.merge(f));
  const limit = activeLimit(lazy.limited, now) ?? activeLimit(flows.data?.limited, now);
  // A link to one flow: its runs open once the list is here (a flow not listed opens by its id).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !link?.flow || flows.isPending) return;
    opened.current = true;
    const found = flows.data?.data.find((f) => f.id === link.flow);
    setRunsOf(
      found ?? {
        id: link.flow,
        name: link.flow,
        active: false,
        status: 'error',
        updated_at: null,
        last_run_at: null,
        last_run_status: null,
        errors_7d: null,
        open_url: null,
        tags: [],
      },
    );
  }, [link?.flow, flows.isPending, flows.data]);
  return (
    <Panel
      title={t('flows.list.title', { name: c.name })}
      hint={t('flows.list.hint')}
      testId="flows-table"
      actions={
        <div className="flex items-center gap-1.5">
          {flows.data?.fetched_at ? (
            <span className="text-xs text-muted max-sm:hidden" data-testid="flows-fetched-at">
              {t('flows.fetchedAt', { when: relativeTime(flows.data.fetched_at, now) })}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            busy={flows.refresh.isPending || lazy.loading}
            disabled={!c.enabled || flows.isPending}
            title={t('flows.refreshHint')}
            onClick={() =>
              flows.refresh.mutate(undefined, {
                onSuccess: () => lazy.reload(),
                onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
              })
            }
            data-testid="flows-refresh"
          >
            {t('flows.refresh')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRunsOf('all')} data-testid="flows-runs-all">
            {t('flows.runs.all')}
          </Button>
        </div>
      }
    >
      {!c.enabled ? (
        <div className="p-3.5">
          <Notice tone="warn">{t('flows.connection.off')}</Notice>
        </div>
      ) : null}
      {flows.isPending && c.enabled ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {flows.isError ? (
        <div className="p-3.5">
          <Notice tone="error">{errorMessage(flows.error)}</Notice>
        </div>
      ) : null}
      {limit ? (
        <div className="p-3.5 pb-0">
          <LimitNotice limit={limit} platform={c.platform} />
        </div>
      ) : null}
      {flows.isSuccess && !rows.length && !limit ? (
        <EmptyState icon={<Icon name="bolt" size={26} />} title={t('flows.list.none')} />
      ) : null}
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="flows-rows">
            <thead>
              <tr className="border-b border-line-soft text-xs text-muted">
                <th className="px-3.5 py-2 text-start font-semibold">{t('flows.col.name')}</th>
                <th className="px-2 py-2 text-start font-semibold">{t('flows.col.status')}</th>
                <th className="px-2 py-2 text-start font-semibold">{t('flows.col.lastRun')}</th>
                <th className="px-2 py-2 text-start font-semibold">{t('flows.col.errors')}</th>
                <th className="px-3.5 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((f) => (
                <tr
                  key={f.id}
                  className="border-b border-line-soft last:border-b-0"
                  data-testid="flow-row"
                  data-flow-id={f.id}
                  data-status={f.status}
                >
                  <td className="px-3.5 py-2">
                    <div className="font-semibold text-fg">{f.name}</div>
                    {f.tags.length ? <div className="text-xs text-muted">{f.tags.join(' · ')}</div> : null}
                    {f.warning ? (
                      <div className="text-xs text-accent-fg" data-testid="flow-warning">
                        {tDynamic(`flows.warning.${f.warning}`)}
                        {f.warning_detail ? <span dir="ltr"> · {f.warning_detail}</span> : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-2 py-2">
                    <Badge tone={STATUS_TONE[f.status]}>{t(`flows.status.${f.status}`)}</Badge>
                  </td>
                  <td
                    className="px-2 py-2 text-xs text-fg-2"
                    data-testid="flow-last-run"
                    data-stats-at={f.stats_at ?? undefined}
                    title={f.stats_at ? t('flows.statsAt', { when: relativeTime(f.stats_at, now) }) : undefined}
                  >
                    {f.stats_pending ? (
                      <span className="text-muted" data-testid="flow-stats-pending">
                        {t('flows.statsPending')}
                      </span>
                    ) : f.last_run_at ? (
                      <span title={f.last_run_at}>
                        {relativeTime(f.last_run_at, now)}
                        {f.last_run_status ? ` · ${t(`flows.run.${f.last_run_status}`)}` : ''}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-2 py-2 text-xs" data-testid="flow-errors">
                    {f.stats_pending ? (
                      <span className="text-muted">…</span>
                    ) : f.errors_7d === null ? (
                      '—'
                    ) : f.errors_7d ? (
                      <span className="font-semibold text-danger-fg">{f.errors_7d}</span>
                    ) : (
                      0
                    )}
                  </td>
                  <td className="px-3.5 py-2">
                    <div className="flex items-center justify-end gap-1.5">
                      {c.caps.toggle && c.can_manage ? (
                        <Switch
                          checked={f.active}
                          label={t('flows.toggle', { name: f.name })}
                          disabled={m.setActive.isPending}
                          onChange={(on) =>
                            m.setActive.mutate(
                              { id: c.id, flowId: f.id, active: on },
                              { onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }) },
                            )
                          }
                          testId="flow-toggle"
                        />
                      ) : null}
                      <Button size="sm" variant="ghost" onClick={() => setRunsOf(f)} data-testid="flow-runs">
                        {t('flows.runs.button')}
                      </Button>
                      <AskButton account={account} onAsk={() => setAsking({ flow: f })} />
                      {f.open_url ? <External href={f.open_url} testId="flow-open" /> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {pages > 1 ? (
            <div className="flex items-center justify-end gap-2 px-3.5 py-2 text-xs text-muted">
              <Button
                size="sm"
                variant="ghost"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
                data-testid="flows-page-prev"
              >
                {t('flows.page.prev')}
              </Button>
              <span data-testid="flows-page">{t('flows.page.of', { page: page + 1, pages })}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={page >= pages - 1}
                onClick={() => setPage(page + 1)}
                data-testid="flows-page-next"
              >
                {t('flows.page.next')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {runsOf ? (
        <RunsDialog
          account={account}
          connection={c}
          flow={runsOf === 'all' ? null : runsOf}
          markedRun={runsOf !== 'all' && runsOf.id === link?.flow ? (link?.run ?? null) : null}
          onAsk={(q) => {
            setRunsOf(null);
            setAsking(q);
          }}
          onClose={() => setRunsOf(null)}
        />
      ) : null}
      {asking ? (
        <AssistantPanel
          accountId={account.id}
          slug={account.slug}
          title={asking.flow.name}
          prefill={askPrefill(c, asking)}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </Panel>
  );
};

// ---- run history ----

const RunsDialog = ({
  account,
  connection: c,
  flow,
  markedRun,
  onAsk,
  onClose,
}: {
  account: MyAccount;
  connection: FlowConnection;
  flow: Flow | null;
  /** The run a link pointed at (a notification): marked and scrolled to. */
  markedRun?: string | null;
  onAsk: (q: AskAbout) => void;
  onClose: () => void;
}) => {
  const [status, setStatus] = useState<'error' | 'all'>('all');
  const runs = useFlowRuns(account.id, c.id, flow?.id ?? null, status);
  const m = useFlowMutations(account.id);
  const now = useNow();
  const retry = (r: FlowRun) =>
    m.retry.mutate(
      { id: c.id, runId: r.id, flowId: r.flow_id },
      {
        onSuccess: () => showToast({ message: t('flows.runs.retried') }),
        onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
      },
    );
  return (
    <Dialog
      open
      onClose={onClose}
      className="max-w-3xl!"
      title={flow ? t('flows.runs.titleFlow', { name: flow.name }) : t('flows.runs.titleAll', { name: c.name })}
      footer={
        <div className="flex w-full justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3" data-testid="flow-runs-dialog">
        <Segmented<'error' | 'all'>
          label={t('flows.runs.filter')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: t('flows.runs.filterAll'), testId: 'flow-runs-all-status' },
            { value: 'error', label: t('flows.runs.filterError'), testId: 'flow-runs-errors' },
          ]}
        />
        <div className="flex items-center justify-end gap-2">
          {runs.data?.fetched_at ? (
            <span className="text-xs text-muted" data-testid="flow-runs-fetched-at">
              {t('flows.fetchedAt', { when: relativeTime(runs.data.fetched_at, now) })}
            </span>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            busy={runs.refresh.isPending}
            disabled={runs.isPending}
            title={t('flows.refreshHint')}
            onClick={() =>
              runs.refresh.mutate(undefined, {
                onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
              })
            }
            data-testid="flow-runs-refresh"
          >
            {t('flows.refresh')}
          </Button>
        </div>
        {runs.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
        {runs.isError ? <Notice tone="error">{errorMessage(runs.error)}</Notice> : null}
        {activeLimit(runs.data?.limited, now) ? (
          <LimitNotice limit={runs.data!.limited!} platform={c.platform} />
        ) : null}
        {runs.data?.warning && !activeLimit(runs.data.limited, now) ? (
          <div data-testid="flow-runs-warning">
            <Notice tone="warn">
              {tDynamic(`flows.warning.${runs.data.warning}`)}
              {runs.data.warning_detail ? <span dir="ltr"> · {runs.data.warning_detail}</span> : null}
            </Notice>
          </div>
        ) : null}
        {runs.isSuccess && !runs.data.data.length && !runs.data.warning ? (
          <p className="text-sm text-muted">{t('flows.runs.none')}</p>
        ) : null}
        <ul className="space-y-2">
          {(runs.data?.data ?? []).map((r) => (
            <li
              key={`${r.flow_id}:${r.id}`}
              ref={r.id === markedRun ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
              className={cn(
                'space-y-1.5 rounded-[10px] border border-line-soft p-2.5',
                r.id === markedRun && 'border-primary ring-2 ring-[var(--primary-soft)]',
              )}
              data-testid="flow-run"
              data-run-id={r.id}
              data-marked={r.id === markedRun ? 'true' : undefined}
              data-status={r.status}
            >
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Badge tone={STATUS_TONE[r.status]}>{t(`flows.run.${r.status}`)}</Badge>
                {!flow && r.flow_name ? <span className="font-semibold text-fg">{r.flow_name}</span> : null}
                {r.started_at ? (
                  <span className="text-muted" title={r.started_at}>
                    {relativeTime(r.started_at, now)}
                  </span>
                ) : null}
                {r.duration_ms !== null ? (
                  <span className="text-muted">
                    {t('flows.runs.duration', { seconds: Math.round(r.duration_ms / 100) / 10 })}
                  </span>
                ) : null}
                <span className="flex-1" />
                {r.can_retry && c.caps.retry && c.can_manage ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={m.retry.isPending}
                    onClick={() => retry(r)}
                    data-testid="flow-run-retry"
                  >
                    {t('flows.runs.retry')}
                  </Button>
                ) : null}
                {r.status === 'error' && (flow || r.flow_id) ? (
                  <AskButton
                    account={account}
                    onAsk={() =>
                      onAsk({
                        flow: flow ?? { id: r.flow_id!, name: r.flow_name ?? r.flow_id! },
                        run: { id: r.id, status: r.status },
                      })
                    }
                  />
                ) : null}
                {r.open_url ? <External href={r.open_url} /> : null}
              </div>
              {r.error || r.error_node ? (
                // The platform's text — shown as text, never as HTML.
                <pre
                  dir="auto"
                  className="max-h-40 overflow-auto rounded-[8px] bg-danger-soft p-2 text-xs whitespace-pre-wrap text-danger-fg"
                  data-testid="flow-run-error"
                >
                  {r.error_node ? `${t('flows.runs.node', { node: r.error_node })}\n` : ''}
                  {r.error ?? ''}
                </pre>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
};

// ---- new flow with AI ----

const AiDraftDialog = ({
  account,
  connection: c,
  onClose,
}: {
  account: MyAccount;
  connection: FlowConnection;
  onClose: () => void;
}) => {
  const m = useFlowMutations(account.id);
  const [request, setRequest] = useState('');
  const [answer, setAnswer] = useState<FlowDraftAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const prepare = async () => {
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await m.aiDraft.mutateAsync({ id: c.id, request: request.trim() }));
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  const create = async () => {
    if (!answer) return;
    setError(null);
    try {
      const flow = await m.createFromDraft.mutateAsync({ id: c.id, draft: answer.draft });
      showToast({ message: t('flows.ai.created', { name: flow.name }) });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      className="max-w-2xl!"
      title={t('flows.ai.title')}
      subtitle={t('flows.ai.subtitle', { name: c.name })}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {answer ? (
            <Button busy={m.createFromDraft.isPending} onClick={() => void create()} data-testid="flow-ai-create">
              {t('flows.ai.create')}
            </Button>
          ) : (
            <Button
              busy={m.aiDraft.isPending}
              disabled={request.trim().length < 3}
              onClick={() => void prepare()}
              data-testid="flow-ai-prepare"
            >
              {t('flows.ai.prepare')}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-3" data-testid="flow-ai-dialog">
        <Field label={t('flows.ai.request')} hint={t('flows.ai.requestHint')}>
          <textarea
            dir="auto"
            rows={4}
            value={request}
            onChange={(e) => {
              setRequest(e.target.value);
              setAnswer(null);
            }}
            data-testid="flow-ai-request"
            className="w-full rounded-[10px] border border-line-strong bg-surface p-2.5 text-sm text-fg focus:border-primary focus:outline-none"
          />
        </Field>
        {answer ? (
          <div data-testid="flow-ai-draft">
            <Card className="space-y-2">
              <div className="font-semibold text-heading">{answer.draft.name}</div>
              <ol className="list-decimal space-y-1 ps-5 text-sm text-fg">
                {answer.lines.map((l, i) => (
                  <li key={i}>{brandText(l.key, l.vars)}</li>
                ))}
              </ol>
              {answer.notes ? (
                <p className="text-xs whitespace-pre-wrap text-muted" dir="auto">
                  {answer.notes}
                </p>
              ) : null}
              <Notice tone="info">{t('flows.ai.createsOff')}</Notice>
            </Card>
          </div>
        ) : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Dialog>
  );
};

// ---- add / edit a connection ----

type Draft = {
  name: string;
  platform: FlowPlatform;
  base_url: string;
  zone: string;
  team_id: string;
  secret: string;
  settings: FlowConnectionSettings;
};

const DEFAULT_SETTINGS: FlowConnectionSettings = {
  visibility: 'admins',
  ai_create: true,
  ai_operate: true,
  ai_edit: true,
  ai_connection_id: null,
  ai_model: null,
  alert_on_failure: true,
  alert_recipients: [],
  alert_channel: 'bell',
  check_every_minutes: 15,
  max_calls_per_hour: 600,
  max_calls_per_minute: 30,
  background_share_percent: 75,
  cache_list_seconds: 120,
  cache_stats_seconds: 300,
  cache_runs_seconds: 60,
  refresh_min_seconds: 30,
  stats_concurrency: 1,
  stats_pacing_ms: 400,
  backoff_default_seconds: 60,
};

/** The platform-calls settings: key, bounds (as the server's schema) and the i18n of the field. */
const LIMIT_FIELDS: {
  key: keyof FlowConnectionSettings &
    (
      | 'max_calls_per_minute'
      | 'background_share_percent'
      | 'cache_list_seconds'
      | 'cache_stats_seconds'
      | 'cache_runs_seconds'
      | 'refresh_min_seconds'
      | 'stats_concurrency'
      | 'stats_pacing_ms'
      | 'backoff_default_seconds'
    );
  min: number;
  max: number;
  testId: string;
}[] = [
  { key: 'max_calls_per_minute', min: 1, max: 1000, testId: 'flow-setting-per-minute' },
  { key: 'background_share_percent', min: 10, max: 100, testId: 'flow-setting-background-share' },
  { key: 'cache_list_seconds', min: 0, max: 3600, testId: 'flow-setting-cache-list' },
  { key: 'cache_stats_seconds', min: 0, max: 86_400, testId: 'flow-setting-cache-stats' },
  { key: 'cache_runs_seconds', min: 0, max: 3600, testId: 'flow-setting-cache-runs' },
  { key: 'refresh_min_seconds', min: 0, max: 3600, testId: 'flow-setting-refresh-min' },
  { key: 'stats_concurrency', min: 1, max: 4, testId: 'flow-setting-stats-concurrency' },
  { key: 'stats_pacing_ms', min: 0, max: 10_000, testId: 'flow-setting-stats-pacing' },
  { key: 'backoff_default_seconds', min: 5, max: 3600, testId: 'flow-setting-backoff' },
];

const ConnectionDialog = ({
  account,
  connection,
  platforms,
  onClose,
}: {
  account: MyAccount;
  connection: FlowConnection | null;
  platforms: FlowPlatform[];
  onClose: () => void;
}) => {
  const m = useFlowMutations(account.id);
  const aiConnections = useAiConnections(account.id);
  const members = useMembers(account.id);
  const [d, setD] = useState<Draft>(() => ({
    name: connection?.name ?? '',
    platform: connection?.platform ?? platforms[0] ?? 'n8n',
    base_url: connection?.platform === 'n8n' ? connection.base_url : '',
    zone: connection?.zone ?? 'eu1',
    team_id: connection?.team_id ? String(connection.team_id) : '',
    secret: '',
    settings: connection?.settings ?? DEFAULT_SETTINGS,
  }));
  // The flows AI's own connection: its live model list (any provider).
  const aiModels = useAiModels(account.id, d.settings.ai_connection_id);
  const [changeTarget, setChangeTarget] = useState(!connection);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const setS = <K extends keyof FlowConnectionSettings>(k: K, v: FlowConnectionSettings[K]) =>
    setD((x) => ({ ...x, settings: { ...x.settings, [k]: v } }));

  const target = (): FlowConnectionTarget | null => {
    const secret = d.secret.trim();
    if (secret.length < 8) return null;
    if (d.platform === 'n8n')
      return d.base_url.trim() ? { platform: 'n8n', base_url: d.base_url.trim(), api_key: secret } : null;
    if (d.platform === 'make') {
      const team = Number(d.team_id);
      return d.zone.trim() && Number.isInteger(team) && team > 0
        ? { platform: 'make', zone: d.zone.trim(), team_id: team, api_token: secret }
        : null;
    }
    return { platform: 'zapier', access_token: secret };
  };
  const tg = changeTarget ? target() : undefined;
  const valid = !!d.name.trim() && tg !== null;
  const busy = m.create.isPending || m.update.isPending;

  const save = async () => {
    setError(null);
    try {
      if (connection)
        await m.update.mutateAsync({
          id: connection.id,
          name: d.name.trim(),
          settings: d.settings,
          ...(changeTarget && tg ? { target: tg } : {}),
        });
      else await m.create.mutateAsync({ name: d.name.trim(), target: tg!, settings: d.settings });
      showToast({ message: t('flows.connection.saved', { name: d.name.trim() }) });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const recipients = (members.data?.data ?? []).filter(
    (x) => x.status === 'active' && !x.agent && (x.role === 'admin' || x.role === 'member'),
  );
  const toggleRecipient = (id: string) =>
    setS(
      'alert_recipients',
      d.settings.alert_recipients.includes(id)
        ? d.settings.alert_recipients.filter((x) => x !== id)
        : [...d.settings.alert_recipients, id],
    );

  return (
    <Dialog
      open
      onClose={onClose}
      className="max-w-2xl!"
      title={connection ? t('flows.connection.editTitle', { name: connection.name }) : t('flows.connection.addTitle')}
      subtitle={t('flows.connection.dialogHint')}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} disabled={!valid} onClick={() => void save()} data-testid="flow-connection-save">
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-4" data-testid="flow-connection-dialog">
        <Field label={t('flows.field.name')}>
          <Input value={d.name} onChange={(e) => set('name', e.target.value)} data-testid="flow-connection-name" />
        </Field>
        {!connection ? (
          <Segmented<FlowPlatform>
            label={t('flows.field.platform')}
            value={d.platform}
            onChange={(v) => set('platform', v)}
            options={platforms.map((p) => ({
              value: p,
              label: t(`flows.platform.${p}`),
              testId: `flow-platform-${p}`,
            }))}
          />
        ) : null}
        {connection && !changeTarget ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted" dir="ltr">
              {connection.base_url} {connection.secret_hint ?? ''}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setChangeTarget(true)}>
              {t('flows.connection.changeKey')}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {d.platform === 'n8n' ? (
              <Field label={t('flows.field.baseUrl')} hint={t('flows.field.baseUrlHint')}>
                <Input
                  dir="ltr"
                  value={d.base_url}
                  placeholder="https://n8n.example.com"
                  onChange={(e) => set('base_url', e.target.value)}
                  data-testid="flow-connection-url"
                />
              </Field>
            ) : null}
            {d.platform === 'make' ? (
              <>
                <Field label={t('flows.field.zone')} hint={t('flows.field.zoneHint')}>
                  <Input
                    dir="ltr"
                    value={d.zone}
                    onChange={(e) => set('zone', e.target.value)}
                    data-testid="flow-connection-zone"
                  />
                </Field>
                <Field label={t('flows.field.teamId')}>
                  <Input
                    dir="ltr"
                    inputMode="numeric"
                    value={d.team_id}
                    onChange={(e) => set('team_id', e.target.value)}
                    data-testid="flow-connection-team"
                  />
                </Field>
              </>
            ) : null}
            <Field label={t(`flows.field.secret.${d.platform}`)} hint={t('flows.field.secretHint')}>
              <Input
                dir="ltr"
                type="password"
                autoComplete="off"
                value={d.secret}
                onChange={(e) => set('secret', e.target.value)}
                data-testid="flow-connection-secret"
              />
            </Field>
          </div>
        )}

        <section className="space-y-3 border-t border-line-soft pt-3">
          <h3 className="text-sm font-semibold text-heading">{t('flows.settings.title')}</h3>
          <Segmented<'admins' | 'members'>
            label={t('flows.settings.visibility')}
            value={d.settings.visibility}
            onChange={(v) => setS('visibility', v)}
            options={[
              { value: 'admins', label: t('flows.settings.visibility.admins'), testId: 'flow-visibility-admins' },
              { value: 'members', label: t('flows.settings.visibility.members'), testId: 'flow-visibility-members' },
            ]}
          />
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={d.settings.ai_create} onChange={(on) => setS('ai_create', on)} testId="flow-setting-ai" />
            {t('flows.settings.aiCreate')}
          </label>
          {d.settings.ai_create ? (
            <Field label={t('flows.settings.aiConnection')} hint={t('flows.settings.aiConnectionHint')}>
              <Picker<string>
                label={t('flows.settings.aiConnection')}
                value={d.settings.ai_connection_id ?? ''}
                onChange={(v) => {
                  setS('ai_connection_id', v || null);
                  // Another connection = another provider's models: back to its default.
                  setS('ai_model', null);
                }}
                options={[
                  { value: '', label: t('flows.settings.aiConnectionDefault') },
                  ...(aiConnections.data?.data ?? []).map((x) => ({ value: x.id, label: x.name })),
                ]}
                testId="flow-setting-ai-connection"
              />
            </Field>
          ) : null}
          {d.settings.ai_create && d.settings.ai_connection_id ? (
            <Field label={t('flows.settings.aiModel')}>
              <Picker<string>
                label={t('flows.settings.aiModel')}
                value={d.settings.ai_model ?? ''}
                onChange={(v) => setS('ai_model', v || null)}
                options={[
                  {
                    value: '',
                    label: defaultChoiceLabel(t('ai2.form.connectionDefault'), aiModels.data),
                    testId: 'flow-setting-ai-model-default',
                  },
                  ...modelPickerOptions(
                    modelChoices(aiModels.data, d.settings.ai_model),
                    'flow-setting-ai-model-option',
                  ),
                ]}
                testId="flow-setting-ai-model"
              />
            </Field>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={d.settings.ai_operate}
              onChange={(on) => setS('ai_operate', on)}
              testId="flow-setting-ai-operate"
            />
            {t('flows.settings.aiOperate')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={d.settings.ai_edit} onChange={(on) => setS('ai_edit', on)} testId="flow-setting-ai-edit" />
            {t('flows.settings.aiEdit')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={d.settings.alert_on_failure}
              onChange={(on) => setS('alert_on_failure', on)}
              testId="flow-setting-alerts"
            />
            {t('flows.settings.alerts')}
          </label>
          {d.settings.alert_on_failure ? (
            <>
              <Segmented<FlowConnectionSettings['alert_channel']>
                label={t('flows.settings.channel')}
                value={d.settings.alert_channel}
                onChange={(v) => setS('alert_channel', v)}
                options={(['bell', 'bell_email', 'email'] as const).map((v) => ({
                  value: v,
                  label: t(`flows.settings.channel.${v}`),
                  testId: `flow-channel-${v}`,
                }))}
              />
              <Field label={t('flows.settings.recipients')} hint={t('flows.settings.recipientsHint')}>
                <div className="flex flex-wrap gap-1.5" data-testid="flow-setting-recipients">
                  {recipients.map((x) => {
                    const on = d.settings.alert_recipients.includes(x.user_id);
                    return (
                      <button
                        key={x.user_id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleRecipient(x.user_id)}
                        className={cn(
                          'h-7 rounded-full border px-2.5 text-xs',
                          on
                            ? 'border-primary bg-primary-soft text-heading'
                            : 'border-line text-fg-2 hover:bg-surface-2',
                        )}
                      >
                        {x.name}
                      </button>
                    );
                  })}
                </div>
              </Field>
            </>
          ) : null}
          {/* The check also feeds automations on flows: always shown. */}
          <Field label={t('flows.settings.interval')} hint={t('flows.settings.intervalHint')}>
            <Input
              dir="ltr"
              inputMode="numeric"
              value={String(d.settings.check_every_minutes)}
              onChange={(e) => setS('check_every_minutes', Math.min(1440, Math.max(5, Number(e.target.value) || 15)))}
              data-testid="flow-setting-interval"
            />
          </Field>
          <Field label={t('flows.settings.calls')}>
            <Input
              dir="ltr"
              inputMode="numeric"
              value={String(d.settings.max_calls_per_hour)}
              onChange={(e) =>
                setS('max_calls_per_hour', Math.min(10_000, Math.max(10, Number(e.target.value) || 600)))
              }
              data-testid="flow-setting-calls"
            />
          </Field>
        </section>
        <section className="space-y-3 border-t border-line-soft pt-3" data-testid="flow-settings-limits">
          <h3 className="text-sm font-semibold text-heading">{t('flows.settings.limitsTitle')}</h3>
          <p className="text-xs text-muted">{t('flows.settings.limitsHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {LIMIT_FIELDS.map((x) => (
              <Field key={x.key} label={t(`flows.settings.${x.key}`)} hint={t(`flows.settings.${x.key}.hint`)}>
                <Input
                  dir="ltr"
                  inputMode="numeric"
                  value={String(d.settings[x.key])}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setS(
                      x.key,
                      Number.isFinite(n) && e.target.value !== ''
                        ? Math.min(x.max, Math.max(x.min, Math.round(n)))
                        : DEFAULT_SETTINGS[x.key],
                    );
                  }}
                  data-testid={x.testId}
                />
              </Field>
            ))}
          </div>
        </section>
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Dialog>
  );
};
