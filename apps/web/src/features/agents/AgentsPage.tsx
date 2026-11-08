// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { type Agent, getLocale, t } from '@bines/shared';
import { Badge, Button, Card, Dialog, EmptyState, Notice, Picker, SkeletonRows, Tabs } from '@bines/ui';
import { errorMessage, type MyAccount } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { PlanUpgradeLink, usePlanGate } from '../../lib/plan-gate';
import { planGateAttrs } from '../../lib/plan-limit';
import { showToast } from '../../lib/toast';
import { h1 } from '../admin/admin-parts';
import { AgentAvatar, ApprovalCard, fail, RunDialog, RunRow, usd } from './agent-parts';
import {
  useAgentConnections,
  useAgentMutations,
  useAgents,
  useAgentRuns,
  useAgentTemplates,
  useApprovals,
} from './agents-api';

/**
 * "סוכנים" (the planning notes "AGENTS-MCP" §6): the account's agents (name, role, state, runs in 7 days, cost this month,
 * waiting approvals), the approvals inbox and every run. Agents are built in the editor — nothing here is per
 * client; starter templates are data an admin adds on demand.
 */
type Tab = 'agents' | 'approvals' | 'runs';

export const AgentsPage = ({ account }: { account: MyAccount }) => {
  const list = useAgents(account.id);
  const approvals = useApprovals(account.id, 'pending');
  const [tab, setTab] = useState<Tab>('agents');
  const pending = approvals.data?.data.length ?? 0;
  // New agents need the plan's `ai`; the existing ones stay listed.
  const aiGate = usePlanGate(account.id, 'ai');
  const newClass =
    'inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-primary px-3.5 text-sm font-semibold text-on-primary';
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 pb-16" data-testid="agents-page">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className={h1}>{t('agents.title')}</h1>
          <p className="max-w-[680px] text-sm text-muted">{t('agents.subtitle')}</p>
        </div>
        {list.data?.can_create && !aiGate.allowed ? (
          <span className="flex items-center gap-2">
            <span
              role="link"
              tabIndex={0}
              data-testid="agent-new"
              data-tour="agents.new"
              {...planGateAttrs(aiGate)}
              className={`${newClass} cursor-not-allowed opacity-45`}
            >
              <Icon name="plus" size={15} />
              {t('agents.new')}
            </span>
            <PlanUpgradeLink gate={aiGate} />
          </span>
        ) : list.data?.can_create ? (
          <Link
            to="/a/$accountSlug/agents/$agentId"
            params={{ accountSlug: account.slug, agentId: 'new' }}
            data-testid="agent-new"
            data-tour="agents.new"
            className={`${newClass} hover:opacity-90`}
          >
            <Icon name="plus" size={15} />
            {t('agents.new')}
          </Link>
        ) : null}
      </header>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'agents', label: t('agents.tab.agents'), testId: 'agents-tab-agents' },
          {
            value: 'approvals',
            label: (
              <>
                {t('agents.tab.approvals')}
                {pending ? <Badge tone="warn">{pending}</Badge> : null}
              </>
            ),
            testId: 'agents-tab-approvals',
          },
          { value: 'runs', label: t('agents.tab.runs'), testId: 'agents-tab-runs' },
        ]}
      />
      {tab === 'agents' ? <AgentList account={account} /> : null}
      {tab === 'approvals' ? <Approvals account={account} /> : null}
      {tab === 'runs' ? <Runs account={account} /> : null}
    </div>
  );
};

const AgentList = ({ account }: { account: MyAccount }) => {
  const list = useAgents(account.id);
  const [templates, setTemplates] = useState(false);
  const aiGate = usePlanGate(account.id, 'ai');
  const openTemplates = () => aiGate.allowed && setTemplates(true);
  if (list.isPending) return <SkeletonRows rows={4} label={t('app.loading')} />;
  if (list.isError) return <Notice tone="error">{errorMessage(list.error)}</Notice>;
  const { data, can_create } = list.data;
  return (
    <>
      {!data.length ? (
        <EmptyState
          testId="agents-empty"
          icon={<Icon name="person" size={26} />}
          title={can_create ? t('agents.empty') : t('agents.emptyNoAccess')}
          action={
            can_create ? (
              <Button
                variant="secondary"
                onClick={openTemplates}
                data-testid="agent-templates"
                {...planGateAttrs(aiGate)}
              >
                {t('agents.templates.open')}
              </Button>
            ) : null
          }
        >
          {can_create ? t('agents.emptyHint') : null}
        </EmptyState>
      ) : (
        <Card className="p-0" data-tour="agents.list">
          {data.map((a) => (
            <AgentRow key={a.id} account={account} agent={a} />
          ))}
        </Card>
      )}
      {data.length && can_create ? (
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={openTemplates}
            data-testid="agent-templates"
            {...planGateAttrs(aiGate)}
          >
            {t('agents.templates.open')}
          </Button>
        </div>
      ) : null}
      {templates ? <TemplatesDialog account={account} onClose={() => setTemplates(false)} /> : null}
    </>
  );
};

const AgentRow = ({ account, agent }: { account: MyAccount; agent: Agent }) => (
  <Link
    to="/a/$accountSlug/agents/$agentId"
    params={{ accountSlug: account.slug, agentId: agent.id }}
    data-testid="agent-row"
    data-name={agent.name}
    className="flex flex-wrap items-center gap-3 border-b border-line-soft px-3.5 py-3 last:border-b-0 hover:bg-surface-2"
  >
    <AgentAvatar name={agent.name} avatar={agent.avatar} />
    <span className="min-w-0 flex-1 basis-56">
      <span className="flex flex-wrap items-center gap-1.5">
        <b className="font-semibold text-fg">{agent.name}</b>
        <Badge tone={agent.is_active ? 'ok' : 'neutral'}>
          {agent.is_active ? t('agents.state.active') : t('agents.state.paused')}
        </Badge>
        <Badge tone={agent.approval_mode === 'learner' ? 'warn' : 'violet'}>
          {t(`agents.mode.${agent.approval_mode}`)}
        </Badge>
      </span>
      {agent.role ? <span className="mt-0.5 block truncate text-xs text-muted">{agent.role}</span> : null}
    </span>
    <span className="flex flex-wrap items-center gap-3 text-xs text-muted tabular-nums">
      <span>{t('agents.stats.runs', { n: agent.stats.runs_7d })}</span>
      <span>
        <bdi>{usd(agent.stats.cost_month_usd)}</bdi> {t('agents.stats.month')}
      </span>
      {agent.stats.pending_approvals ? (
        <Badge tone="warn">{t('agents.stats.pending', { n: agent.stats.pending_approvals })}</Badge>
      ) : null}
    </span>
  </Link>
);

const Approvals = ({ account }: { account: MyAccount }) => {
  const q = useApprovals(account.id, 'pending');
  const [run, setRun] = useState<string | null>(null);
  if (q.isPending) return <SkeletonRows rows={3} label={t('app.loading')} />;
  if (q.isError) return <Notice tone="error">{errorMessage(q.error)}</Notice>;
  if (!q.data.data.length) return <EmptyState testId="approvals-empty" title={t('agents.approvals.empty')} />;
  return (
    <div className="flex flex-col gap-2" data-testid="approvals-inbox">
      {q.data.data.map((a) => (
        <div key={a.id} className="flex flex-col gap-1">
          <ApprovalCard account={account} approval={a} showAgent />
          <button
            type="button"
            className="self-start text-xs font-semibold text-primary underline"
            onClick={() => setRun(a.run_id)}
          >
            {t('agents.approvals.openRun')}
          </button>
        </div>
      ))}
      <RunDialog account={account} runId={run} onClose={() => setRun(null)} />
    </div>
  );
};

const Runs = ({ account }: { account: MyAccount }) => {
  const q = useAgentRuns(account.id, null);
  const [run, setRun] = useState<string | null>(null);
  if (q.isPending) return <SkeletonRows rows={4} label={t('app.loading')} />;
  if (q.isError) return <Notice tone="error">{errorMessage(q.error)}</Notice>;
  if (!q.data.data.length) return <EmptyState testId="runs-empty" title={t('agents.runs.empty')} />;
  return (
    <Card className="p-0">
      {q.data.data.map((r) => (
        <RunRow key={r.id} run={r} showAgent onOpen={() => setRun(r.id)} />
      ))}
      <RunDialog account={account} runId={run} onClose={() => setRun(null)} />
    </Card>
  );
};

/** Starter agents (seed/agents/*.json): added inactive, in learner mode, without boards — then edited. */
const TemplatesDialog = ({ account, onClose }: { account: MyAccount; onClose: () => void }) => {
  const templates = useAgentTemplates(account.id, true);
  const connections = useAgentConnections(account.id);
  const m = useAgentMutations(account.id);
  const [connection, setConnection] = useState('');
  const conn = connection || connections.data?.data[0]?.id || '';
  const add = (keys: string[]) =>
    m.seed.mutate(
      { connection_id: conn, keys },
      {
        onSuccess: (r) => showToast({ message: t('agents.templates.added', { n: r.data.length }) }),
        onError: fail,
      },
    );
  return (
    <Dialog open onClose={onClose} title={t('agents.templates.title')} subtitle={t('agents.templates.hint')}>
      <div className="flex flex-col gap-3" data-testid="agent-templates-dialog">
        {connections.data && !connections.data.data.length ? (
          <Notice tone="warn">{t('agents.noConnection')}</Notice>
        ) : (
          <Picker
            value={conn}
            label={t('agents.field.connection')}
            onChange={setConnection}
            options={(connections.data?.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
        )}
        {templates.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
        {templates.data?.data.map((tpl) => (
          <div
            key={tpl.key}
            className="flex items-start gap-3 rounded-[12px] border border-line px-3 py-2.5"
            data-testid="agent-template"
            data-key={tpl.key}
          >
            <AgentAvatar name={tpl.name} avatar={tpl.avatar} size={32} />
            <span className="min-w-0 flex-1">
              <b className="block text-sm font-semibold text-fg">{tpl.name}</b>
              <span className="block text-xs text-muted">{tpl.role}</span>
              <span className="mt-1 block text-[0.6875rem] text-muted" dir={getLocale() === 'en' ? 'ltr' : 'rtl'}>
                {tpl.tools.length} {t('agents.templates.tools')}
              </span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              disabled={tpl.added || !conn}
              busy={m.seed.isPending}
              onClick={() => add([tpl.key])}
              data-testid="agent-template-add"
            >
              {tpl.added ? t('agents.templates.isAdded') : t('agents.templates.add')}
            </Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
};
