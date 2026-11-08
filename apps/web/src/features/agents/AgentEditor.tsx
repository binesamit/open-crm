// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  type Agent,
  AGENT_AVATAR_AUTO,
  AGENT_EFFORTS,
  AGENT_TOOL_NAMES,
  AGENT_TRIGGER_DEFAULTS,
  type AgentTriggers,
  type AgentApprovalMode,
  type AgentBoardLevel,
  type AgentEffort,
  AI_TOOLS,
  type AiToolDef,
  isSensitiveTool,
  newAgentTriggerDefaults,
  parseAnimalAvatar,
  randomAnimalAvatar,
  t,
} from '@bines/shared';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Notice,
  Picker,
  RadioCard,
  Segmented,
  SkeletonRows,
  Switch,
  Tabs,
} from '@bines/ui';
import { errorMessage, type MyAccount } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { PlanUpgradeLink, usePlanGate } from '../../lib/plan-gate';
import { planGateAttrs } from '../../lib/plan-limit';
import { showToast } from '../../lib/toast';
import { h1 } from '../admin/admin-parts';
import { AgentAvatar, fail, RunDialog, RunRow, RunView, toolLabel } from './agent-parts';
import { AvatarPickerDialog } from '../account/AvatarPickerDialog';
import { KnowledgeTab } from './AgentKnowledge';
import { AgentMcpTools } from '../mcp-servers/AgentMcpTools';
import { TriggersTab } from './AgentTriggers';
import { ImproveInstructions } from './ImproveInstructions';
import {
  type BoardChoice,
  useAgent,
  useAgentConnections,
  useAgentMutations,
  useAgentRuns,
  useAgents,
  useBoardChoices,
} from './agents-api';
import { modelChoices, modelPickerOptions, modelHasTools, useAiModels } from '../ai/ai-api';

/**
 * The agent editor (the planning notes "AGENTS-MCP" §6): profile, model + AI connection, allowed tools, boards, approval
 * mode and limits; "run now" with a prompt (optionally a dry run); its runs. Every field is data the admin sets —
 * the same screen builds any agent.
 */
type Tab = 'profile' | 'model' | 'tools' | 'boards' | 'triggers' | 'knowledge' | 'limits' | 'run' | 'runs';

type Draft = {
  name: string;
  avatar: string;
  role: string;
  instructions: string;
  connection_id: string;
  model: string;
  effort: AgentEffort;
  tools: string[];
  approval_tools: string[];
  boards: { board_id: string; level: AgentBoardLevel }[];
  approval_mode: AgentApprovalMode;
  max_steps: string;
  max_usd_per_run: string;
  max_runs_per_day: string;
  is_active: boolean;
  triggers: AgentTriggers;
  web_search: boolean;
};

/** `newMention`: a new agent's mention trigger (the account's AI setting, on by default). */
/** `newAvatar`: a new agent starts on a random animal, picked once per editor. */
const draftOf = (a: Agent | undefined, newMention = true, newAvatar = ''): Draft => ({
  name: a?.name ?? '',
  avatar: a?.avatar ?? newAvatar,
  role: a?.role ?? '',
  instructions: a?.instructions ?? '',
  connection_id: a?.connection_id ?? '',
  // A new agent: '' = the connection's default model (its own, else the newest tool-calling model of its live list).
  model: a?.model ?? '',
  effort: a?.effort ?? 'medium',
  tools: a?.tools ?? ['get_board', 'query_items', 'get_item'],
  approval_tools: a?.approval_tools ?? [],
  boards: a?.boards.map((b) => ({ board_id: b.board_id, level: b.level })) ?? [],
  approval_mode: a?.approval_mode ?? 'learner',
  max_steps: String(a?.limits.max_steps ?? 25),
  max_usd_per_run: String(a?.limits.max_usd_per_run ?? 1),
  max_runs_per_day: String(a?.limits.max_runs_per_day ?? 50),
  is_active: a?.is_active ?? true,
  web_search: !!a && a.web_search.status !== 'off',
  triggers: a ? { ...AGENT_TRIGGER_DEFAULTS, ...a.triggers } : newAgentTriggerDefaults(newMention),
});

const textareaClass =
  'w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none';

export const AgentEditorPage = ({
  account,
  agentId,
  runId,
}: {
  account: MyAccount;
  agentId: string;
  runId?: string;
}) => {
  const isNew = agentId === 'new';
  const q = useAgent(account.id, isNew ? null : agentId);
  // A new agent starts from the account's choices (its mention trigger), which come with the list.
  const list = useAgents(account.id);
  if ((!isNew && q.isPending) || (isNew && list.isPending)) return <SkeletonRows rows={6} label={t('app.loading')} />;
  if (!isNew && q.isError)
    return (
      <div className="mx-auto max-w-3xl px-4 py-8">
        <Notice tone="error">{errorMessage(q.error)}</Notice>
      </div>
    );
  return (
    <Editor
      key={q.data?.id ?? 'new'}
      account={account}
      agent={q.data}
      initialRun={runId ?? null}
      newMention={list.data?.new_agent_mention ?? true}
    />
  );
};

const Editor = ({
  account,
  agent,
  initialRun,
  newMention,
}: {
  account: MyAccount;
  agent?: Agent;
  initialRun: string | null;
  newMention: boolean;
}) => {
  const navigate = useNavigate();
  const m = useAgentMutations(account.id);
  const [newAvatar] = useState(() => randomAnimalAvatar());
  const [draft, setDraft] = useState<Draft>(() => draftOf(agent, newMention, newAvatar));
  const [tab, setTab] = useState<Tab>(initialRun ? 'runs' : 'profile');
  const [openRun, setOpenRun] = useState<string | null>(initialRun);
  const connections = useAgentConnections(account.id);
  const connectionId = draft.connection_id || connections.data?.data[0]?.id || '';
  // The connection's live model list (any provider): the model in force is the chosen one, else its default.
  const models = useAiModels(account.id, connectionId || null);
  const model = draft.model || models.data?.default_model || '';
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(draftOf(agent, newMention, newAvatar)) || (!agent && !!connectionId);
  // Creating an agent needs the plan's `ai`; an existing agent stays editable.
  const aiGate = usePlanGate(account.id, 'ai');
  const createGate = agent ? { ...aiGate, allowed: true } : aiGate;

  const num = (s: string) => Number(s.replace(',', '.'));
  const save = () => {
    const limits = {
      max_steps: Math.round(num(draft.max_steps)),
      max_usd_per_run: num(draft.max_usd_per_run),
      max_runs_per_day: Math.round(num(draft.max_runs_per_day)),
    };
    if (Object.values(limits).some((v) => !Number.isFinite(v) || v <= 0))
      return fail(new Error(t('agents.limits.invalid')));
    if (!draft.name.trim()) return fail(new Error(t('agents.field.nameRequired')));
    if (!connectionId) return fail(new Error(t('agents.noConnection')));
    if (!model) return fail(new Error(t('error.ai_no_model')));
    const body = {
      name: draft.name.trim(),
      avatar: draft.avatar.trim() || null,
      role: draft.role.trim(),
      instructions: draft.instructions,
      connection_id: connectionId,
      model,
      effort: draft.effort,
      tools: draft.tools,
      approval_tools: draft.approval_tools.filter((x) => draft.tools.includes(x)),
      boards: draft.boards,
      approval_mode: draft.approval_mode,
      limits,
      is_active: draft.is_active,
      triggers: draft.triggers,
      web_search: draft.web_search,
    };
    if (agent)
      m.update.mutate(
        { id: agent.id, ...body },
        { onSuccess: () => showToast({ message: t('agents.saved') }), onError: fail },
      );
    else
      m.create.mutate(body, {
        onSuccess: (created) => {
          showToast({ message: t('agents.created') });
          void navigate({
            to: '/a/$accountSlug/agents/$agentId',
            params: { accountSlug: account.slug, agentId: created.id },
          });
        },
        onError: fail,
      });
  };
  const remove = async () => {
    if (!agent) return;
    const ok = await confirmDialog({
      title: t('agents.deleteTitle', { name: agent.name }),
      message: t('agents.deleteHint'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (ok)
      m.remove.mutate(agent.id, {
        onSuccess: () => void navigate({ to: '/a/$accountSlug/agents', params: { accountSlug: account.slug } }),
        onError: fail,
      });
  };

  const tabs: { value: Tab; label: string; testId: string }[] = [
    { value: 'profile', label: t('agents.tab.profile'), testId: 'agent-tab-profile' },
    { value: 'model', label: t('agents.tab.model'), testId: 'agent-tab-model' },
    { value: 'tools', label: t('agents.tab.tools'), testId: 'agent-tab-tools' },
    { value: 'boards', label: t('agents.tab.boards'), testId: 'agent-tab-boards' },
    { value: 'triggers', label: t('agents.tab.triggers'), testId: 'agent-tab-triggers' },
    ...(agent
      ? ([{ value: 'knowledge', label: t('agents.tab.knowledge'), testId: 'agent-tab-knowledge' }] as const)
      : []),
    { value: 'limits', label: t('agents.tab.limits'), testId: 'agent-tab-limits' },
    ...(agent
      ? ([
          { value: 'run', label: t('agents.tab.run'), testId: 'agent-tab-run' },
          { value: 'runs', label: t('agents.tab.runs'), testId: 'agent-tab-runs' },
        ] as const)
      : []),
  ];

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-4 py-6 pb-16" data-testid="agent-editor">
      <Link
        to="/a/$accountSlug/agents"
        params={{ accountSlug: account.slug }}
        className="self-start text-xs font-semibold text-muted hover:text-fg"
        data-testid="agent-back"
      >
        {t('agents.back')}
      </Link>
      <header className="flex flex-wrap items-center gap-3">
        <AgentAvatar name={draft.name || '?'} avatar={draft.avatar || null} size={44} />
        <div className="min-w-0 flex-1 space-y-1">
          <h1 className={h1}>{agent ? agent.name : t('agents.new')}</h1>
          {agent ? (
            <div className="flex flex-wrap gap-1.5">
              <Badge tone={agent.is_active ? 'ok' : 'neutral'}>
                {agent.is_active ? t('agents.state.active') : t('agents.state.paused')}
              </Badge>
              <Badge tone={agent.approval_mode === 'learner' ? 'warn' : 'violet'}>
                {t(`agents.mode.${agent.approval_mode}`)}
              </Badge>
              {/* Mention off: it shows greyed out in the @ list — say so where it is fixed. */}
              {!agent.triggers.mention ? (
                <span data-tip={t('agents.triggers.mentionOffHint')} data-testid="agent-mention-off-badge">
                  <Badge tone="neutral">{t('agents.triggers.mentionOffBadge')}</Badge>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {agent ? (
            <Button variant="danger-outline" size="sm" onClick={() => void remove()} data-testid="agent-delete">
              {t('common.delete')}
            </Button>
          ) : null}
          <PlanUpgradeLink gate={createGate} />
          <Button
            size="sm"
            onClick={() => createGate.allowed && save()}
            disabled={createGate.allowed && !dirty}
            busy={m.create.isPending || m.update.isPending}
            data-testid="agent-save"
            {...planGateAttrs(createGate)}
          >
            {agent ? t('common.save') : t('agents.create')}
          </Button>
        </div>
      </header>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'profile' ? (
        <ProfileTab
          draft={draft}
          set={set}
          improve={{ accountId: account.id, agentId: agent?.id, connectionId, model }}
        />
      ) : null}
      {tab === 'model' ? (
        <ModelTab account={account} draft={draft} set={set} connectionId={connectionId} model={model} />
      ) : null}
      {tab === 'tools' ? <ToolsTab account={account} agent={agent} draft={draft} set={set} /> : null}
      {tab === 'boards' ? <BoardsTab account={account} draft={draft} set={set} /> : null}
      {tab === 'triggers' ? (
        <TriggersTab
          account={account}
          agent={agent}
          triggers={draft.triggers}
          boardIds={draft.boards.map((b) => b.board_id)}
          onChange={(next) => set('triggers', next)}
        />
      ) : null}
      {tab === 'knowledge' && agent ? <KnowledgeTab account={account} agent={agent} /> : null}
      {tab === 'limits' ? <LimitsTab draft={draft} set={set} /> : null}
      {tab === 'run' && agent ? <RunNow account={account} agent={agent} dirty={dirty} /> : null}
      {tab === 'runs' && agent ? <AgentRuns account={account} agent={agent} onOpen={setOpenRun} /> : null}
      <RunDialog account={account} runId={openRun} onClose={() => setOpenRun(null)} />
    </div>
  );
};

type TabProps = { draft: Draft; set: <K extends keyof Draft>(k: K, v: Draft[K]) => void };

const ProfileTab = ({
  draft,
  set,
  improve,
}: TabProps & { improve: { accountId: string; agentId?: string; connectionId: string; model: string } }) => (
  <Card className="flex flex-col gap-3">
    <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
      <Field label={t('agents.field.name')}>
        <Input
          value={draft.name}
          maxLength={80}
          onChange={(e) => set('name', e.target.value)}
          data-testid="agent-name"
          autoFocus
        />
      </Field>
      <Field label={t('agents.field.avatar')} hint={t('agents.field.avatarHint')}>
        <AvatarChoice name={draft.name} value={draft.avatar} onChange={(v) => set('avatar', v)} />
      </Field>
    </div>
    <Field label={t('agents.field.role')} hint={t('agents.field.roleHint')}>
      <Input
        value={draft.role}
        maxLength={200}
        onChange={(e) => set('role', e.target.value)}
        data-testid="agent-role"
      />
    </Field>
    <Field label={t('agents.field.instructions')} hint={t('agents.field.instructionsHint')}>
      <textarea
        rows={10}
        maxLength={20000}
        value={draft.instructions}
        onChange={(e) => set('instructions', e.target.value)}
        className={textareaClass}
        data-testid="agent-instructions"
      />
    </Field>
    <ImproveInstructions
      {...improve}
      draft={draft}
      textareaClass={textareaClass}
      onApply={(text) => set('instructions', text)}
    />
    <label className="flex items-center gap-2.5 text-sm text-fg">
      <Switch
        checked={draft.is_active}
        onChange={(v) => set('is_active', v)}
        label={t('agents.field.active')}
        testId="agent-active"
      />
      {t('agents.field.active')}
    </label>
  </Card>
);

const ModelTab = ({
  account,
  draft,
  set,
  connectionId,
  model,
}: TabProps & { account: MyAccount; connectionId: string; model: string }) => {
  const connections = useAgentConnections(account.id);
  const list = connections.data?.data ?? [];
  // The connection's live model list (any provider), newest and most capable first — nothing else is offered.
  const models = useAiModels(account.id, connectionId || null);
  return (
    <Card className="flex flex-col gap-3">
      {connections.data && !list.length ? (
        <Notice tone="warn">
          {t('agents.noConnection')}{' '}
          {account.role === 'admin' ? (
            <Link
              to="/a/$accountSlug/admin/$section"
              params={{ accountSlug: account.slug, section: 'ai' }}
              className="font-semibold underline"
            >
              {t('agents.noConnectionLink')}
            </Link>
          ) : null}
        </Notice>
      ) : null}
      <Field label={t('agents.field.connection')} hint={t('agents.field.connectionHint')}>
        <Picker
          value={connectionId}
          label={t('agents.field.connection')}
          testId="agent-connection"
          onChange={(v) => {
            set('connection_id', v);
            // Another connection = another provider's models: start from its default again.
            if (v !== connectionId) set('model', '');
          }}
          options={list.map((c) => ({ value: c.id, label: c.name }))}
        />
      </Field>
      <Field label={t('agents.field.model')}>
        <Picker
          value={model}
          label={t('agents.field.model')}
          testId="agent-model"
          onChange={(v) => set('model', v)}
          options={modelPickerOptions(modelChoices(models.data, model || null), 'agent-model-option')}
        />
        {/* An agent works through tools: a model that cannot call them is refused on save. */}
        {modelHasTools(models.data, model) ? null : (
          <div className="mt-1.5" data-testid="agent-model-no-tools">
            <Notice tone="warn">{t('error.ai_model_no_tools')}</Notice>
          </div>
        )}
      </Field>
      <Field label={t('agents.field.effort')} hint={t('agents.field.effortHint')}>
        <Segmented
          value={draft.effort}
          label={t('agents.field.effort')}
          testId="agent-effort"
          onChange={(v) => set('effort', v)}
          options={AGENT_EFFORTS.map((e) => ({ value: e, label: t(`agents.effort.${e}`) }))}
        />
      </Field>
    </Card>
  );
};

const FAMILIES = [...new Set(AI_TOOLS.map((x) => x.family))];

/**
 * "Web search": an admin's "on" approves it; anyone else's asks, and the agent does not search until
 * an admin approves. Works only when the platform allows it and the account set a search service (AI settings).
 */
const WebSearchSection = ({
  account,
  agent,
  draft,
  set,
}: TabProps & { account: MyAccount; agent: Agent | undefined }) => {
  const m = useAgentMutations(account.id);
  const status = agent?.web_search.status ?? 'off';
  const admin = account.role === 'admin';
  const decide = (decision: 'approve' | 'reject') =>
    m.webSearch.mutate(
      { id: agent!.id, decision },
      { onSuccess: () => showToast({ message: t('agents.saved') }), onError: fail },
    );
  return (
    <section className="px-3.5 pt-3.5" data-testid="agent-web-search" data-status={status}>
      <div className="flex flex-wrap items-center gap-2.5">
        <Switch
          checked={draft.web_search}
          onChange={(v) => set('web_search', v)}
          label={t('agents.webSearch.label')}
          testId="agent-web-search-switch"
        />
        <span className="min-w-0 flex-1 text-sm text-fg">{t('agents.webSearch.label')}</span>
        {status === 'approved' ? (
          <Badge tone="ok">{t('agents.webSearch.approved')}</Badge>
        ) : status === 'requested' ? (
          <Badge tone="warn">{t('agents.webSearch.requested')}</Badge>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted">
        {admin ? t('agents.webSearch.hintAdmin') : t('agents.webSearch.hintMember')}
      </p>
      {admin && status === 'requested' && agent ? (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            busy={m.webSearch.isPending}
            onClick={() => decide('approve')}
            data-testid="agent-web-search-approve"
          >
            {t('agents.webSearch.approve')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={m.webSearch.isPending}
            onClick={() => decide('reject')}
            data-testid="agent-web-search-reject"
          >
            {t('agents.webSearch.reject')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};

const ToolsTab = ({ account, agent, draft, set }: TabProps & { account: MyAccount; agent: Agent | undefined }) => {
  const toggle = (name: string, on: boolean) =>
    set('tools', on ? [...new Set([...draft.tools, name])] : draft.tools.filter((x) => x !== name));
  const toggleApproval = (name: string, on: boolean) =>
    set(
      'approval_tools',
      on ? [...new Set([...draft.approval_tools, name])] : draft.approval_tools.filter((x) => x !== name),
    );
  const riskBadge = (tool: AiToolDef) =>
    isSensitiveTool(tool) ? (
      <Badge tone="danger">{t('agents.risk.sensitive')}</Badge>
    ) : tool.risk === 'write' ? (
      <Badge tone="info">{t('agents.risk.write')}</Badge>
    ) : (
      <Badge tone="neutral">{t('agents.risk.read')}</Badge>
    );
  return (
    <Card className="flex flex-col gap-4 p-0">
      <WebSearchSection account={account} agent={agent} draft={draft} set={set} />
      <p className="px-3.5 pt-3.5 text-xs text-muted">{t('agents.tools.hint')}</p>
      {FAMILIES.map((family) => {
        const tools = AI_TOOLS.filter((x) => x.family === family && AGENT_TOOL_NAMES.includes(x.name));
        if (!tools.length) return null;
        return (
          <section key={family} className="border-t border-line-soft">
            <h3 className="px-3.5 pt-2.5 pb-1 text-xs font-semibold text-muted">{t(`agents.family.${family}`)}</h3>
            {tools.map((tool) => {
              const on = draft.tools.includes(tool.name);
              return (
                <div
                  key={tool.name}
                  className="flex flex-wrap items-center gap-2.5 px-3.5 py-2"
                  data-testid="agent-tool"
                  data-tool={tool.name}
                >
                  <Switch
                    checked={on}
                    onChange={(v) => toggle(tool.name, v)}
                    label={toolLabel(tool.name)}
                    testId={`agent-tool-${tool.name}`}
                  />
                  <span className="min-w-0 flex-1 text-sm text-fg">
                    {toolLabel(tool.name)}{' '}
                    <span dir="ltr" className="text-xs text-muted">
                      {tool.name}
                    </span>
                  </span>
                  {riskBadge(tool)}
                  {on && tool.risk === 'write' && !isSensitiveTool(tool) && draft.approval_mode === 'autonomous' ? (
                    <label className="flex items-center gap-1.5 text-xs text-muted">
                      <Switch
                        checked={draft.approval_tools.includes(tool.name)}
                        onChange={(v) => toggleApproval(tool.name, v)}
                        label={t('agents.tools.withApproval')}
                      />
                      {t('agents.tools.withApproval')}
                    </label>
                  ) : null}
                </div>
              );
            })}
          </section>
        );
      })}
      {/* Remote MCP tools the admin enabled (מ10): per agent, one by one. */}
      <AgentMcpTools accountId={account.id} tools={draft.tools} onToggle={toggle} />
    </Card>
  );
};

const BoardsTab = ({ account, draft, set }: TabProps & { account: MyAccount }) => {
  const choices = useBoardChoices(account.id);
  const byId = new Map((choices.data ?? []).map((b) => [b.id, b]));
  const free = (choices.data ?? []).filter((b) => !draft.boards.some((x) => x.board_id === b.id));
  const label = (b: BoardChoice) => `${b.name} · ${b.workspace}`;
  return (
    <Card className="flex flex-col gap-3">
      <p className="text-xs text-muted">{t('agents.boards.hint')}</p>
      {!draft.boards.length ? <EmptyState title={t('agents.boards.empty')} testId="agent-boards-empty" /> : null}
      {draft.boards.map((b) => (
        <div
          key={b.board_id}
          className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-line px-3 py-2"
          data-testid="agent-board"
          data-board={b.board_id}
        >
          <span className="min-w-0 flex-1 text-sm font-semibold text-fg">
            {byId.get(b.board_id)?.name ?? b.board_id}
          </span>
          <Segmented
            value={b.level}
            label={t('agents.boards.level')}
            testId="agent-board-level"
            onChange={(v) =>
              set(
                'boards',
                draft.boards.map((x) => (x.board_id === b.board_id ? { ...x, level: v } : x)),
              )
            }
            options={[
              { value: 'view', label: t('agents.boards.view') },
              { value: 'edit', label: t('agents.boards.edit'), testId: 'agent-board-edit' },
            ]}
          />
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              set(
                'boards',
                draft.boards.filter((x) => x.board_id !== b.board_id),
              )
            }
          >
            {t('agents.boards.remove')}
          </Button>
        </div>
      ))}
      {free.length ? (
        <Picker
          value={'' as string}
          placeholder={t('agents.boards.add')}
          label={t('agents.boards.add')}
          testId="agent-board-add"
          onChange={(v) => v && set('boards', [...draft.boards, { board_id: v, level: 'view' }])}
          options={free.map((b) => ({ value: b.id, label: label(b), keywords: b.workspace }))}
        />
      ) : null}
    </Card>
  );
};

const LimitsTab = ({ draft, set }: TabProps) => (
  <Card className="flex flex-col gap-4">
    <div className="flex flex-col gap-2" role="radiogroup" aria-label={t('agents.mode.title')}>
      <div className="text-sm font-semibold text-fg">{t('agents.mode.title')}</div>
      <RadioCard
        name="approval-mode"
        checked={draft.approval_mode === 'learner'}
        onSelect={() => set('approval_mode', 'learner')}
        title={t('agents.mode.learner')}
        hint={t('agents.mode.learnerHint')}
        testId="agent-mode-learner"
      />
      <RadioCard
        name="approval-mode"
        checked={draft.approval_mode === 'autonomous'}
        onSelect={() => set('approval_mode', 'autonomous')}
        title={t('agents.mode.autonomous')}
        hint={t('agents.mode.autonomousHint')}
        testId="agent-mode-autonomous"
      />
    </div>
    <div className="grid gap-3 sm:grid-cols-3">
      <Field label={t('agents.limits.steps')} hint={t('agents.limits.stepsHint')}>
        <Input
          dir="ltr"
          inputMode="numeric"
          value={draft.max_steps}
          onChange={(e) => set('max_steps', e.target.value)}
          data-testid="agent-limit-steps"
        />
      </Field>
      <Field label={t('agents.limits.usd')} hint={t('agents.limits.usdHint')}>
        <Input
          dir="ltr"
          inputMode="decimal"
          value={draft.max_usd_per_run}
          onChange={(e) => set('max_usd_per_run', e.target.value)}
          data-testid="agent-limit-usd"
        />
      </Field>
      <Field label={t('agents.limits.runs')} hint={t('agents.limits.runsHint')}>
        <Input
          dir="ltr"
          inputMode="numeric"
          value={draft.max_runs_per_day}
          onChange={(e) => set('max_runs_per_day', e.target.value)}
          data-testid="agent-limit-runs"
        />
      </Field>
    </div>
  </Card>
);

const RunNow = ({ account, agent, dirty }: { account: MyAccount; agent: Agent; dirty: boolean }) => {
  const m = useAgentMutations(account.id);
  const [prompt, setPrompt] = useState('');
  const [dry, setDry] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  // Running an agent needs the plan's `ai`.
  const aiGate = usePlanGate(account.id, 'ai');
  const gate = planGateAttrs(aiGate);
  const start = () =>
    aiGate.allowed &&
    m.start.mutate(
      { agentId: agent.id, prompt: prompt.trim(), dry_run: dry },
      {
        onSuccess: (r) => setRunId(r.id),
        onError: fail,
      },
    );
  return (
    <Card className="flex flex-col gap-3">
      {dirty ? <Notice tone="warn">{t('agents.run.unsaved')}</Notice> : null}
      {!agent.is_active ? <Notice tone="warn">{t('agents.run.inactive')}</Notice> : null}
      <Field label={t('agents.run.prompt')} hint={t('agents.run.promptHint')}>
        <textarea
          rows={4}
          maxLength={8000}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className={textareaClass}
          data-testid="agent-run-prompt"
        />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-fg">
          <Switch checked={dry} onChange={setDry} label={t('agents.run.dry')} testId="agent-run-dry" />
          {t('agents.run.dry')}
        </label>
        <span className="ms-auto flex items-center gap-2">
          <PlanUpgradeLink gate={aiGate} />
          <Button
            onClick={start}
            disabled={aiGate.allowed && (!prompt.trim() || !agent.is_active)}
            busy={m.start.isPending}
            data-testid="agent-run-start"
            {...gate}
          >
            <Icon name="bolt" size={14} />
            {t('agents.run.start')}
          </Button>
        </span>
      </div>
      {runId ? <RunView account={account} runId={runId} /> : null}
    </Card>
  );
};

const AgentRuns = ({ account, agent, onOpen }: { account: MyAccount; agent: Agent; onOpen: (id: string) => void }) => {
  const q = useAgentRuns(account.id, agent.id);
  if (q.isPending) return <SkeletonRows rows={4} label={t('app.loading')} />;
  if (q.isError) return <Notice tone="error">{errorMessage(q.error)}</Notice>;
  if (!q.data.data.length) return <EmptyState title={t('agents.runs.empty')} testId="agent-runs-empty" />;
  return (
    <Card className="p-0">
      <div data-testid="agent-runs">
        {q.data.data.map((r) => (
          <RunRow key={r.id} run={r} onOpen={() => onOpen(r.id)} />
        ))}
      </div>
    </Card>
  );
};

/**
 * The agent's avatar (product decision): one of our animals — picked, random, or "the agent picks" (its own
 * model chooses when it is saved) — or one emoji / a couple of letters. Changeable any time.
 */
const AvatarChoice = ({ name, value, onChange }: { name: string; value: string; onChange: (v: string) => void }) => {
  const [picking, setPicking] = useState(false);
  const animal = !!parseAnimalAvatar(value);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="agent-avatar-choice" data-value={value}>
      <AgentAvatar name={name || '?'} avatar={value || null} size={36} />
      <Button variant="secondary" size="sm" onClick={() => setPicking(true)} data-testid="agent-avatar-pick">
        {t('agents.avatar.pick')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => onChange(randomAnimalAvatar())}
        data-testid="agent-avatar-random"
      >
        <Icon name="duplicate" size={14} />
        {t('agents.avatar.random')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={value === AGENT_AVATAR_AUTO}
        onClick={() => onChange(AGENT_AVATAR_AUTO)}
        data-testid="agent-avatar-auto"
        title={t('agents.avatar.autoHint')}
      >
        <Icon name="sparkle" size={14} />
        {t('agents.avatar.auto')}
      </Button>
      <Input
        value={animal || value === AGENT_AVATAR_AUTO ? '' : value}
        placeholder={t('agents.avatar.text')}
        aria-label={t('agents.avatar.text')}
        maxLength={8}
        onChange={(e) => onChange(e.target.value)}
        data-testid="agent-avatar"
        className="w-28"
      />
      {picking ? (
        <AvatarPickerDialog
          initial={animal ? value : null}
          onCancel={() => setPicking(false)}
          onPick={(code) => {
            onChange(code);
            setPicking(false);
          }}
        />
      ) : null}
    </div>
  );
};
