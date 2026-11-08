// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDateTime,
  type SupportAgentAction,
  type SupportAgentConnections,
  type SupportAgentRun,
  type SupportAgentRunDetail,
  type SupportAgentSettingsDto,
  type UpdateSupportAgentSettings,
  t,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, Card, cn, Field, Input, Notice, Picker, Switch } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { TEXTAREA } from '../../support/NewTicketDialog';
import { useAiModels } from '../../ai/ai-api';

/**
 * The support agent in the owner console: "investigate" on an error or a ticket, the run as it goes
 * (each tool it used, its reasoning), its report, and its proposals waiting for a person (approve / reject; a reply
 * to the customer can be edited first). The settings card lives in Errors & health → Settings.
 */
export const supportAgentKeys = {
  all: ['platform', 'support-agent'] as const,
  settings: ['platform', 'support-agent', 'settings'] as const,
  runs: (f: { error_id?: string; ticket_id?: string }) => ['platform', 'support-agent', 'runs', f] as const,
  run: (id: string) => ['platform', 'support-agent', 'run', id] as const,
};

export const useSupportAgentSettings = () =>
  useQuery({
    queryKey: supportAgentKeys.settings,
    queryFn: () => api().get<SupportAgentSettingsDto>('/platform/support-agent/settings'),
  });

const live = (s: SupportAgentRun['status'] | undefined) => s === 'queued' || s === 'running';
const devLive = (s: SupportAgentRun['dev_status'] | undefined) => s === 'approved' || s === 'running';

const statusTone = (s: SupportAgentRun['status']) =>
  s === 'succeeded' ? 'ok' : s === 'failed' ? 'danger' : s === 'stopped' ? 'neutral' : 'info';

/** Why a run ended badly, in words (an unknown code: shown as is). */
const RUN_ERRORS = [
  'disabled',
  'timeout',
  'limit_steps',
  'limit_run_usd',
  'limit_month_usd',
  'tool_errors',
  'stopped_by_person',
  'ai_not_configured',
  'ai_no_model',
  'refusal',
  'max_tokens',
  'requester_gone',
  'crashed',
  'github_write_not_configured',
  'no_pull_request',
  'no_development_prompt',
  'ai_connection_missing',
];
const runErrorLabel = (code: string) =>
  RUN_ERRORS.includes(code) ? tDynamic(`supportAgent.error.${code}`) : t('supportAgent.error.other', { code });

const fail = (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' });

/** What a tool call read, in one short line (ids and paths only). */
const inputLine = (input: unknown) => {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  const parts = ['kind', 'id', 'error_id', 'ticket_id', 'path', 'query', 'table']
    .filter((k) => typeof i[k] === 'string' || typeof i[k] === 'number')
    .map((k) => String(i[k]));
  if (typeof i.start_line === 'number') parts.push(`:${i.start_line}-${i.end_line ?? ''}`);
  return parts.join(' ');
};

export const SupportAgentPanel = ({ errorId, ticketId }: { errorId?: string; ticketId?: string }) => {
  const qc = useQueryClient();
  const filter: Record<string, string> = errorId ? { error_id: errorId } : { ticket_id: ticketId! };
  const settings = useSupportAgentSettings();
  const runs = useQuery({
    queryKey: supportAgentKeys.runs(filter),
    queryFn: () =>
      api().get<{ data: SupportAgentRun[] }>(`/platform/support-agent/runs?${new URLSearchParams(filter).toString()}`),
  });
  const [picked, setPicked] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [prompt, setPrompt] = useState('');
  const current = picked ?? runs.data?.data[0]?.id ?? null;
  const start = useMutation({
    mutationFn: () =>
      api().post<SupportAgentRunDetail>('/platform/support-agent/runs', {
        ...filter,
        ...(prompt.trim() ? { prompt } : {}),
      }),
    onSuccess: (res) => {
      qc.setQueryData(supportAgentKeys.run(res.id), res);
      setPicked(res.id);
      setAsking(false);
      setPrompt('');
      void qc.invalidateQueries({ queryKey: supportAgentKeys.runs(filter) });
    },
    onError: fail,
  });
  const s = settings.data;
  const off = s ? !s.enabled || !s.ai_ready : true;
  return (
    <section className="space-y-2" data-testid="support-agent">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="flex-1 text-xs font-semibold text-fg-2">{t('supportAgent.title')}</h3>
        {!asking ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={off || live(runs.data?.data[0]?.status)}
            onClick={() => setAsking(true)}
            data-testid="support-agent-investigate"
          >
            <Icon name="sparkle" size={14} /> {t('supportAgent.investigate')}
          </Button>
        ) : null}
      </div>
      {s && off ? (
        <p className="text-xs text-muted" data-testid="support-agent-off">
          {!s.ai_ready ? t('supportAgent.noAi') : t('supportAgent.off')}
        </p>
      ) : null}
      {asking ? (
        <div className="space-y-2">
          <textarea
            className={TEXTAREA}
            rows={2}
            dir="auto"
            maxLength={2000}
            value={prompt}
            placeholder={t('supportAgent.promptPlaceholder')}
            onChange={(e) => setPrompt(e.target.value)}
            data-testid="support-agent-prompt"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="accent"
              busy={start.isPending}
              onClick={() => start.mutate()}
              data-testid="support-agent-start"
            >
              {t('supportAgent.start')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
      {runs.data && runs.data.data.length > 1 ? (
        <Picker
          label={t('supportAgent.history')}
          className="w-64"
          value={current ?? ''}
          onChange={setPicked}
          testId="support-agent-history"
          options={runs.data.data.map((r) => ({
            value: r.id,
            label: `${formatDateTime(r.created_at)} · ${tDynamic(`supportAgent.status.${r.status}`)}`,
          }))}
        />
      ) : null}
      {current ? <RunView id={current} filter={filter} /> : null}
    </section>
  );
};

const RunView = ({ id, filter }: { id: string; filter: { error_id?: string; ticket_id?: string } }) => {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: supportAgentKeys.run(id),
    queryFn: () => api().get<SupportAgentRunDetail>(`/platform/support-agent/runs/${id}`),
    // The investigation as it goes: every two seconds while it runs.
    refetchInterval: (query) =>
      live(query.state.data?.status) || devLive(query.state.data?.dev_status) ? 2000 : false,
  });
  const done = (res: SupportAgentRunDetail) => {
    qc.setQueryData(supportAgentKeys.run(id), res);
    void qc.invalidateQueries({ queryKey: supportAgentKeys.runs(filter) });
  };
  const stop = useMutation({
    mutationFn: () => api().post<SupportAgentRunDetail>(`/platform/support-agent/runs/${id}/stop`, {}),
    onSuccess: done,
    onError: fail,
  });
  if (q.isPending) return <p className="text-xs text-muted">{t('app.loading')}</p>;
  if (q.isError) return <Notice tone="error">{errorMessage(q.error)}</Notice>;
  const r = q.data;
  return (
    <div
      className="space-y-2 rounded-[10px] border border-line p-2.5"
      data-testid="support-agent-run"
      data-status={r.status}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={statusTone(r.status)}>{tDynamic(`supportAgent.status.${r.status}`)}</Badge>
        <span className="text-muted">
          {t('supportAgent.meta', { steps: r.steps, tools: r.tool_calls, cost: r.cost_usd.toFixed(3) })}
        </span>
        {r.requested_by ? <span className="text-muted">· {r.requested_by.name}</span> : null}
        <span className="flex-1" />
        {live(r.status) ? (
          <Button
            size="sm"
            variant="ghost"
            busy={stop.isPending}
            onClick={() => stop.mutate()}
            data-testid="support-agent-stop"
          >
            {t('supportAgent.stop')}
          </Button>
        ) : null}
      </div>
      {r.error ? <Notice tone={r.status === 'stopped' ? 'info' : 'error'}>{runErrorLabel(r.error)}</Notice> : null}
      {r.report ? (
        <ReportView report={r.report} />
      ) : r.final_text ? (
        <p className="text-sm whitespace-pre-wrap">{r.final_text}</p>
      ) : null}
      {r.actions.length ? (
        <div className="space-y-1.5" data-testid="support-agent-actions">
          <h4 className="text-xs text-fg-2">{t('supportAgent.actions')}</h4>
          {r.actions.map((a) => (
            <ActionRow key={a.id} a={a} onDone={done} />
          ))}
        </div>
      ) : null}
      {r.status === 'succeeded' && r.report ? <DevelopBox r={r} onDone={done} /> : null}
      <details open={live(r.status) || devLive(r.dev_status)}>
        <summary className="cursor-pointer text-xs text-muted">
          {t('supportAgent.steps', { n: r.step_list.length })}
        </summary>
        <ol className="mt-1.5 space-y-1 text-xs" data-testid="support-agent-steps">
          {r.step_list.map((st, i) => (
            <li key={st.seq} className={cn('flex flex-wrap gap-1.5', st.is_error && 'text-danger-fg')}>
              {st.phase === 'develop' && r.step_list[i - 1]?.phase !== 'develop' ? (
                <span className="w-full pt-1 text-fg-2" data-testid="support-agent-steps-develop">
                  {t('supportAgent.dev.steps')}
                </span>
              ) : null}
              {st.kind === 'tool' ? (
                <>
                  <Icon name={st.is_error ? 'warn' : 'check'} size={12} />
                  <span className="font-mono" dir="ltr">
                    {st.tool} {inputLine(st.input)}
                  </span>
                </>
              ) : st.text ? (
                <span className="whitespace-pre-wrap text-fg-2">{st.text}</span>
              ) : null}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
};

/**
 * "Approve development" (phase 2): a person the settings allow sends the agent to write the report's
 * fix on its own `agent/…` branch and open a DRAFT pull request — reviewed and merged by people, never by it.
 */
const DevelopBox = ({ r, onDone }: { r: SupportAgentRunDetail; onDone: (r: SupportAgentRunDetail) => void }) => {
  const settings = useSupportAgentSettings();
  const [asking, setAsking] = useState(false);
  const [instructions, setInstructions] = useState('');
  const go = useMutation({
    mutationFn: () =>
      api().post<SupportAgentRunDetail>(`/platform/support-agent/runs/${r.id}/develop`, {
        ...(instructions.trim() ? { instructions } : {}),
      }),
    onSuccess: (res) => {
      setAsking(false);
      setInstructions('');
      onDone(res);
    },
    onError: fail,
  });
  const may = settings.data?.may_develop ?? false;
  const canStart = may && (!r.dev_status || r.dev_status === 'failed');
  if (!r.dev_status && !may) return null;
  return (
    <div className="space-y-1.5" data-testid="support-agent-develop" data-status={r.dev_status ?? 'none'}>
      <h4 className="text-xs text-fg-2">{t('supportAgent.dev.title')}</h4>
      {r.dev_status ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge tone={r.dev_status === 'opened' ? 'ok' : r.dev_status === 'failed' ? 'danger' : 'info'}>
            {tDynamic(`supportAgent.dev.status.${r.dev_status}`)}
          </Badge>
          {r.dev_approved_by ? (
            <span className="text-muted">{t('supportAgent.dev.approvedBy', { name: r.dev_approved_by.name })}</span>
          ) : null}
          {r.dev_branch ? (
            <span className="font-mono text-muted" dir="ltr">
              {r.dev_branch}
            </span>
          ) : null}
          {r.dev_pr_url ? (
            <a
              href={r.dev_pr_url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary underline"
              data-testid="support-agent-pr"
            >
              {t('supportAgent.dev.openPr')}
            </a>
          ) : null}
        </div>
      ) : null}
      {r.dev_error ? <Notice tone="error">{runErrorLabel(r.dev_error)}</Notice> : null}
      {canStart && !asking ? (
        <>
          <p className="text-xs text-muted">{t('supportAgent.dev.hint')}</p>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAsking(true)}
            data-testid="support-agent-develop-open"
          >
            {t(r.dev_status === 'failed' ? 'supportAgent.dev.retry' : 'supportAgent.dev.approve')}
          </Button>
        </>
      ) : null}
      {asking ? (
        <div className="space-y-2">
          <textarea
            className={TEXTAREA}
            rows={2}
            dir="auto"
            maxLength={4000}
            value={instructions}
            placeholder={t('supportAgent.dev.instructions')}
            onChange={(e) => setInstructions(e.target.value)}
            data-testid="support-agent-develop-instructions"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="accent"
              busy={go.isPending}
              onClick={() => go.mutate()}
              data-testid="support-agent-develop-confirm"
            >
              {t('supportAgent.dev.confirm')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setAsking(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
};

const ReportView = ({ report }: { report: NonNullable<SupportAgentRun['report']> }) => (
  <div className="space-y-2 text-sm" data-testid="support-agent-report">
    <p className="whitespace-pre-wrap">{report.summary}</p>
    <Labeled label={t('supportAgent.report.rootCause')} text={report.root_cause} />
    {report.evidence.length ? (
      <div>
        <div className="text-xs text-muted">{t('supportAgent.report.evidence')}</div>
        <ul className="list-disc space-y-0.5 ps-5">
          {report.evidence.map((e, i) => (
            <li key={i}>
              {e.title}
              {e.ref ? (
                <span className="ms-1 font-mono text-xs text-muted" dir="ltr">
                  {e.ref}
                </span>
              ) : null}
              {e.detail ? <div className="text-xs text-fg-2">{e.detail}</div> : null}
            </li>
          ))}
        </ul>
      </div>
    ) : null}
    {report.impact ? <Labeled label={t('supportAgent.report.impact')} text={report.impact} /> : null}
    {report.proposed_fix ? <Labeled label={t('supportAgent.report.fix')} text={report.proposed_fix} /> : null}
    <div className="text-xs text-muted">
      {t('supportAgent.report.confidence')}: {tDynamic(`supportAgent.confidence.${report.confidence}`)}
    </div>
  </div>
);

const Labeled = ({ label, text }: { label: string; text: string }) => (
  <div>
    <div className="text-xs text-muted">{label}</div>
    <p className="whitespace-pre-wrap">{text}</p>
  </div>
);

const ActionRow = ({ a, onDone }: { a: SupportAgentAction; onDone: (r: SupportAgentRunDetail) => void }) => {
  const p = a.payload as {
    reason?: string;
    body?: string;
    mute_hours?: number;
    title?: string;
    ops_type?: string;
    task?: { url: string; type: string };
  };
  const [body, setBody] = useState(p.body ?? '');
  const [title, setTitle] = useState(p.title ?? '');
  const [opsType, setOpsType] = useState(p.ops_type ?? '');
  const ops = a.kind === 'open_ops_task';
  const editable = a.kind === 'reply_to_customer' || ops;
  const settings = useSupportAgentSettings();
  const types = settings.data?.ops_tasks ?? [];
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api().post<SupportAgentRunDetail>(`/platform/support-agent/actions/${a.id}`, {
        approve,
        ...(approve && editable ? { body } : {}),
        ...(approve && ops ? { title, ...(opsType ? { ops_type: opsType } : {}) } : {}),
      }),
    onSuccess: onDone,
    onError: fail,
  });
  return (
    <div className="space-y-1.5 rounded-[8px] bg-surface-2 p-2" data-testid="support-agent-action" data-kind={a.kind}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="flex-1">
          {tDynamic(`supportAgent.action.${a.kind}`, { n: p.mute_hours ?? 0 })}
          {p.reason ? <span className="block text-xs text-muted">{p.reason}</span> : null}
        </span>
        {a.status === 'pending' ? null : (
          <Badge tone={a.status === 'approved' ? 'ok' : 'neutral'}>
            {tDynamic(`supportAgent.decided.${a.status}`, { name: a.decided_by?.name ?? '' })}
          </Badge>
        )}
      </div>
      {ops && a.status === 'pending' ? (
        <div className="flex flex-wrap gap-3">
          <Field label={t('supportAgent.ops.taskTitle')}>
            <Input
              className="w-72"
              dir="auto"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="support-agent-ops-title"
            />
          </Field>
          <Field label={t('supportAgent.ops.type')}>
            <Picker
              label={t('supportAgent.ops.type')}
              className="w-56"
              value={opsType}
              onChange={setOpsType}
              testId="support-agent-ops-pick"
              options={types.map((x) => ({
                value: x.id,
                label: x.name,
                hint: [x.account_name, x.board_name].filter(Boolean).join(' · '),
              }))}
            />
          </Field>
        </div>
      ) : ops ? (
        <p className="text-sm">{p.title}</p>
      ) : null}
      {editable ? (
        a.status === 'pending' ? (
          <textarea
            className={TEXTAREA}
            rows={4}
            dir="auto"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            data-testid={ops ? 'support-agent-ops-body' : 'support-agent-reply'}
          />
        ) : (
          <p className="text-xs whitespace-pre-wrap text-fg-2">{p.body}</p>
        )
      ) : null}
      {p.task ? (
        <a
          href={p.task.url}
          target="_blank"
          rel="noreferrer"
          className="text-sm text-link underline-offset-2 hover:underline"
          data-testid="support-agent-ops-link"
        >
          {t('supportAgent.ops.openTask', { type: p.task.type })}
        </a>
      ) : null}
      {a.status === 'pending' ? (
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="accent"
            busy={decide.isPending && decide.variables === true}
            disabled={(editable && !body.trim()) || (ops && (!title.trim() || !types.length))}
            onClick={() => decide.mutate(true)}
            data-testid="support-agent-approve"
          >
            {t(
              a.kind === 'reply_to_customer'
                ? 'supportAgent.approveSend'
                : ops
                  ? 'supportAgent.ops.approve'
                  : 'supportAgent.approve',
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            busy={decide.isPending && decide.variables === false}
            onClick={() => decide.mutate(false)}
            data-testid="support-agent-reject"
          >
            {t('supportAgent.reject')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

// ---- settings ----

const numOk = (v: string, min: number, max: number) => /^\d+(\.\d+)?$/.test(v) && Number(v) >= min && Number(v) <= max;

const Num = ({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  disabled: boolean;
  testId: string;
}) => (
  <Field label={label}>
    <Input
      inputMode="decimal"
      dir="ltr"
      className={cn('w-28 text-end tabular-nums', !numOk(value, min, max) && 'border-danger')}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      data-testid={testId}
    />
  </Field>
);

/** Errors & health → Settings → "Support agent": the switch, model, caps, GitHub (owner and leads edit). */
export const SupportAgentSettingsCard = () => {
  const q = useSupportAgentSettings();
  if (!q.data) return null;
  return <SettingsForm key={JSON.stringify(q.data)} s={q.data} />;
};

/** The picker's value for "the help center's platform AI" (no connection chosen). */
const HELP = 'help';
const connOf = (v: string) => {
  if (v === HELP) return null;
  const [account_id, connection_id] = v.split(':');
  return { account_id: account_id!, connection_id: connection_id! };
};

/**
 * Which AI the agent calls (the product owner 2026-10-12: "from the AI connections — not keys again"): an existing connection of
 * an account where I am an admin, or the help center's platform AI. Then the model, from that connection's live list.
 */
const AiSourceFields = ({
  s,
  edit,
  conn,
  onConn,
  model,
  onModel,
}: {
  s: SupportAgentSettingsDto;
  edit: boolean;
  conn: string;
  onConn: (v: string) => void;
  model: string;
  onModel: (v: string) => void;
}) => {
  const list = useQuery({
    queryKey: [...supportAgentKeys.all, 'connections'],
    queryFn: () => api().get<SupportAgentConnections>('/platform/support-agent/connections'),
  });
  const chosen = connOf(conn);
  const models = useAiModels(chosen?.account_id ?? '', chosen?.connection_id);
  // the platform's AI first (recommended); then each account's connections under its name — internal
  // accounts first — each saying whose AI budget it is billed to.
  const accountConns = [...(list.data?.data ?? [])].sort(
    (a, b) =>
      Number(b.internal) - Number(a.internal) ||
      a.account_name.localeCompare(b.account_name) ||
      a.account_id.localeCompare(b.account_id),
  );
  const options: {
    value: string;
    label: string;
    disabled?: boolean;
    hint?: string;
    group?: string;
    testId?: string;
  }[] = [
    {
      value: HELP,
      label: t('supportAgent.settings.aiHelp'),
      group: t('supportAgent.settings.aiGroupPlatform'),
      disabled: !list.data?.help_center,
      testId: 'support-agent-connection-help',
      ...(list.data && !list.data.help_center ? { hint: t('supportAgent.settings.aiHelpOff') } : {}),
    },
    ...accountConns.map((c) => ({
      value: `${c.account_id}:${c.connection_id}`,
      label: `${c.name} · ${c.account_name}`,
      group: c.internal
        ? t('supportAgent.settings.aiGroupInternal', { account: c.account_name })
        : t('supportAgent.settings.aiGroupAccount', { account: c.account_name }),
      hint: t('supportAgent.settings.aiBilledTo', { provider: c.provider, account: c.account_name }),
      testId: `support-agent-connection-${c.connection_id}`,
    })),
  ];
  // The saved one may be in an account I am not an admin of: still shown, as it is.
  if (
    s.ai_connection &&
    !options.some((o) => o.value === `${s.ai_connection!.account_id}:${s.ai_connection!.connection_id}`)
  )
    options.push({
      value: `${s.ai_connection.account_id}:${s.ai_connection.connection_id}`,
      label: s.ai_connection.missing
        ? t('supportAgent.settings.aiMissing')
        : `${s.ai_connection.name} · ${s.ai_connection.account_name}`,
      hint: s.ai_connection.provider,
    });
  return (
    <>
      <Field label={t('supportAgent.settings.ai')} hint={t('supportAgent.settings.aiHint')}>
        {edit ? (
          <Picker
            label={t('supportAgent.settings.ai')}
            className="w-72"
            value={conn}
            onChange={onConn}
            testId="support-agent-connection"
            options={options}
          />
        ) : (
          <span className="text-sm">{options.find((o) => o.value === conn)?.label ?? '—'}</span>
        )}
      </Field>
      <Field label={t('supportAgent.settings.model')} hint={t('supportAgent.settings.modelHint')}>
        {chosen && edit ? (
          <Picker
            label={t('supportAgent.settings.model')}
            className="w-64"
            value={model}
            onChange={onModel}
            testId="support-agent-model"
            options={[
              {
                value: '',
                label: t('supportAgent.settings.modelDefault', {
                  model: models.data?.default_model ?? '—',
                }),
              },
              ...(models.data?.data ?? [])
                .filter((m) => m.capabilities.tools)
                .map((m) => ({ value: m.id, label: m.display_name })),
              ...(model && !models.data?.data.some((m) => m.id === model) ? [{ value: model, label: model }] : []),
            ]}
          />
        ) : (
          <Input
            dir="ltr"
            className="w-56"
            value={model}
            disabled={!edit}
            onChange={(e) => onModel(e.target.value)}
            data-testid="support-agent-model"
          />
        )}
      </Field>
    </>
  );
};

/**
 * the platform's own accounts, marked by the owner or a lead (on the accounts they administer); with "only"
 * on, the connection picker lists just theirs. Saved at once.
 */
const InternalAccounts = ({ s }: { s: SupportAgentSettingsDto }) => {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: [...supportAgentKeys.all, 'connections'],
    queryFn: () => api().get<SupportAgentConnections>('/platform/support-agent/connections'),
  });
  const save = useMutation({
    mutationFn: (internal_accounts: { only: boolean; account_ids: string[] }) =>
      api().patch<SupportAgentSettingsDto>('/platform/support-agent/settings', { internal_accounts }),
    onSuccess: async (res) => {
      qc.setQueryData(supportAgentKeys.settings, res);
      await qc.invalidateQueries({ queryKey: [...supportAgentKeys.all, 'connections'] });
      showToast({ message: t('admin.general.saved') });
    },
    onError: fail,
  });
  const accounts = list.data?.accounts ?? [];
  const marked = accounts.filter((a) => a.internal).map((a) => a.id);
  const put = (only: boolean, ids: string[]) => save.mutate({ only, account_ids: ids });
  return (
    <div className="space-y-1.5" data-testid="support-agent-internal">
      <div className="space-y-0.5">
        <span className="text-xs text-muted">{t('supportAgent.settings.internalTitle')}</span>
        <p className="text-xs text-muted">{t('supportAgent.settings.internalHint')}</p>
      </div>
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-fg">{t('supportAgent.settings.internalOnly')}</span>
        <Switch
          checked={s.internal_accounts.only}
          onChange={(on) => put(on, marked)}
          label={t('supportAgent.settings.internalOnly')}
          disabled={save.isPending}
          testId="support-agent-internal-only"
        />
      </label>
      {list.data && !accounts.length ? (
        <p className="text-xs text-muted">{t('supportAgent.settings.internalNone')}</p>
      ) : null}
      {accounts.map((a) => (
        <label key={a.id} className="flex items-center justify-between gap-3">
          <span className="text-sm text-fg">{a.name}</span>
          <Switch
            checked={a.internal}
            onChange={(on) => put(s.internal_accounts.only, on ? [...marked, a.id] : marked.filter((x) => x !== a.id))}
            label={t('supportAgent.settings.internalMark', { account: a.name })}
            disabled={save.isPending}
            testId={`support-agent-internal-${a.id}`}
          />
        </label>
      ))}
    </div>
  );
};

const SettingsForm = ({ s }: { s: SupportAgentSettingsDto }) => {
  const qc = useQueryClient();
  const edit = s.can_edit;
  const [enabled, setEnabled] = useState(s.enabled);
  const initialConn = s.ai_connection ? `${s.ai_connection.account_id}:${s.ai_connection.connection_id}` : HELP;
  const [conn, setConn] = useState(initialConn);
  const [model, setModel] = useState(s.model ?? '');
  const [effort, setEffort] = useState(s.effort);
  const [steps, setSteps] = useState(String(s.max_steps));
  const [perRun, setPerRun] = useState(String(s.max_usd_per_run));
  const [perMonth, setPerMonth] = useState(String(s.max_usd_per_month));
  const [repo, setRepo] = useState(s.github.repo);
  const [token, setToken] = useState('');
  const [writeToken, setWriteToken] = useState('');
  const [base, setBase] = useState(s.github.base_branch);
  const [roles, setRoles] = useState<('owner' | 'lead' | 'agent')[]>(s.develop_roles);
  const save = useMutation({
    mutationFn: (patch: UpdateSupportAgentSettings) =>
      api().patch<SupportAgentSettingsDto>('/platform/support-agent/settings', patch),
    onSuccess: (res) => {
      qc.setQueryData(supportAgentKeys.settings, res);
      setToken('');
      setWriteToken('');
      showToast({ message: t('admin.general.saved') });
    },
    onError: fail,
  });
  const valid =
    numOk(steps, 5, 80) &&
    numOk(perRun, 0.05, 50) &&
    numOk(perMonth, 1, 5000) &&
    /^$|^[\w.-]+\/[\w.-]+$/.test(repo.trim()) &&
    /^[\w./-]{1,100}$/.test(base.trim());
  return (
    <Card className="space-y-3" data-testid="support-agent-settings" data-editable={edit ? 'true' : 'false'}>
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-fg">{t('supportAgent.settings.title')}</h3>
        <p className="text-xs text-muted">{t('supportAgent.settings.hint')}</p>
      </div>
      {!s.ai_ready ? <Notice tone="warn">{t('supportAgent.noAi')}</Notice> : null}
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-fg">{t('supportAgent.settings.enabled')}</span>
        <Switch
          checked={enabled}
          onChange={setEnabled}
          label={t('supportAgent.settings.enabled')}
          disabled={!edit}
          testId="support-agent-enabled"
        />
      </label>
      <div className="flex flex-wrap gap-3">
        <AiSourceFields
          s={s}
          edit={edit}
          conn={conn}
          onConn={(v) => {
            setConn(v);
            setModel('');
          }}
          model={model}
          onModel={setModel}
        />
        <Field label={t('supportAgent.settings.effort')}>
          <Picker
            label={t('supportAgent.settings.effort')}
            className="w-32"
            value={effort}
            onChange={(v) => setEffort(v)}
            testId="support-agent-effort"
            options={(['low', 'medium', 'high'] as const).map((v) => ({
              value: v,
              label: tDynamic(`supportAgent.effort.${v}`),
            }))}
          />
        </Field>
      </div>
      {edit ? <InternalAccounts s={s} /> : null}
      <div className="flex flex-wrap gap-3">
        <Num
          label={t('supportAgent.settings.maxSteps')}
          value={steps}
          onChange={setSteps}
          min={5}
          max={80}
          disabled={!edit}
          testId="support-agent-steps-max"
        />
        <Num
          label={t('supportAgent.settings.perRun')}
          value={perRun}
          onChange={setPerRun}
          min={0.05}
          max={50}
          disabled={!edit}
          testId="support-agent-per-run"
        />
        <Num
          label={t('supportAgent.settings.perMonth')}
          value={perMonth}
          onChange={setPerMonth}
          min={1}
          max={5000}
          disabled={!edit}
          testId="support-agent-per-month"
        />
      </div>
      <p className="text-xs text-muted" data-testid="support-agent-month">
        {t('supportAgent.settings.monthSpend', { usd: s.month_usd.toFixed(2) })}
      </p>
      <div className="space-y-2">
        <h4 className="text-xs text-fg-2">{t('supportAgent.settings.github')}</h4>
        <p className="text-xs text-muted">{t('supportAgent.settings.githubHint')}</p>
        <div className="flex flex-wrap gap-3">
          <Field label={t('supportAgent.settings.repo')}>
            <Input
              dir="ltr"
              className="w-56"
              placeholder="owner/repository"
              value={repo}
              disabled={!edit}
              onChange={(e) => setRepo(e.target.value)}
              data-testid="support-agent-repo"
            />
          </Field>
          <Field
            label={t('supportAgent.settings.readToken')}
            hint={
              s.github.has_read_token
                ? t('supportAgent.settings.tokenSaved', { hint: s.github.read_token_hint ?? '' })
                : undefined
            }
          >
            <Input
              type="password"
              autoComplete="off"
              dir="ltr"
              className="w-72"
              value={token}
              disabled={!edit}
              onChange={(e) => setToken(e.target.value)}
              data-testid="support-agent-token"
            />
          </Field>
        </div>
        {edit && s.github.has_read_token ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => save.mutate({ github_read_token: null })}
            data-testid="support-agent-token-remove"
          >
            {t('supportAgent.settings.removeToken')}
          </Button>
        ) : null}
      </div>
      <div className="space-y-2" data-testid="support-agent-dev-settings">
        <h4 className="text-xs text-fg-2">{t('supportAgent.settings.dev')}</h4>
        <p className="text-xs text-muted">{t('supportAgent.settings.devHint')}</p>
        <div className="flex flex-wrap gap-3">
          <Field
            label={t('supportAgent.settings.writeToken')}
            hint={
              s.github.has_write_token
                ? t('supportAgent.settings.tokenSaved', { hint: s.github.write_token_hint ?? '' })
                : undefined
            }
          >
            <Input
              type="password"
              autoComplete="off"
              dir="ltr"
              className="w-72"
              value={writeToken}
              disabled={!edit}
              onChange={(e) => setWriteToken(e.target.value)}
              data-testid="support-agent-write-token"
            />
          </Field>
          <Field label={t('supportAgent.settings.base')}>
            <Input
              dir="ltr"
              className="w-40"
              value={base}
              disabled={!edit}
              onChange={(e) => setBase(e.target.value)}
              data-testid="support-agent-base"
            />
          </Field>
        </div>
        {edit && s.github.has_write_token ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => save.mutate({ github_write_token: null })}
            data-testid="support-agent-write-token-remove"
          >
            {t('supportAgent.settings.removeWriteToken')}
          </Button>
        ) : null}
        <div className="space-y-1.5">
          <span className="text-xs text-muted">{t('supportAgent.settings.developRoles')}</span>
          {(['lead', 'agent'] as const).map((role) => (
            <label key={role} className="flex items-center justify-between gap-3">
              <span className="text-sm text-fg">{tDynamic(`supportAgent.role.${role}`)}</span>
              <Switch
                checked={roles.includes(role)}
                onChange={(on) => setRoles(on ? [...roles, role] : roles.filter((x) => x !== role))}
                label={tDynamic(`supportAgent.role.${role}`)}
                disabled={!edit}
                testId={`support-agent-role-${role}`}
              />
            </label>
          ))}
        </div>
      </div>
      {edit ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="accent"
            disabled={!valid}
            busy={save.isPending}
            onClick={() =>
              save.mutate({
                enabled,
                // The connection only when changed (one chosen by another admin stays as it is).
                ...(conn !== initialConn ? { ai_connection: connOf(conn) } : {}),
                model: model.trim() || null,
                effort,
                max_steps: Number(steps),
                max_usd_per_run: Number(perRun),
                max_usd_per_month: Number(perMonth),
                github_repo: repo.trim(),
                ...(token.trim() ? { github_read_token: token.trim() } : {}),
                ...(writeToken.trim() ? { github_write_token: writeToken.trim() } : {}),
                github_base_branch: base.trim(),
                develop_roles: roles,
              })
            }
            data-testid="support-agent-settings-save"
          >
            {t('common.save')}
          </Button>
        </div>
      ) : null}
    </Card>
  );
};
