// SPDX-License-Identifier: AGPL-3.0-only
import { useQueries } from '@tanstack/react-query';
import { type Agent, type AgentTriggers, t } from '@bines/shared';
import { Badge, Card, cn, EmptyState, Field, Notice, SkeletonRows, Switch } from '@bines/ui';
import { api, type MyAccount } from '../../lib/api';
import { boardKeys, type BoardDetail } from '../board/board-api';
import { type BoardChoice, useAgentAutomations, useBoardChoices } from './agents-api';

/**
 * "מתי הסוכן פועל" (the planning notes "AGENTS-MCP" §6, מ8): a mention in an update, an assignment in a people column
 * (optionally only some columns), on all of its boards or some, guests or not, and the task each one gives it.
 * Automations that run the agent (`run_agent`, schedules too) are listed below — they are built in the builder.
 */
const textareaClass =
  'w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none';

/** A pressed / not pressed chip (a choice among several; no native select). */
const Chip = ({
  on,
  onClick,
  children,
  testId,
}: {
  on: boolean;
  onClick: () => void;
  children: string;
  testId?: string;
}) => (
  <button
    type="button"
    aria-pressed={on}
    onClick={onClick}
    data-testid={testId}
    className={cn(
      'inline-flex h-7 items-center rounded-full border px-3 text-xs font-semibold transition-colors',
      on ? 'border-primary bg-primary-soft text-primary' : 'border-line text-fg-2 hover:bg-surface-2',
    )}
  >
    {children}
  </button>
);

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export const TriggersTab = ({
  account,
  agent,
  triggers,
  boardIds,
  onChange,
}: {
  account: MyAccount;
  agent?: Agent;
  triggers: AgentTriggers;
  boardIds: string[];
  onChange: (next: AgentTriggers) => void;
}) => {
  const set = <K extends keyof AgentTriggers>(k: K, v: AgentTriggers[K]) => onChange({ ...triggers, [k]: v });
  const choices = useBoardChoices(account.id);
  const nameOf = (id: string) => choices.data?.find((b: BoardChoice) => b.id === id)?.name ?? id;
  const details = useQueries({
    queries: boardIds.map((id) => ({
      queryKey: boardKeys.board(account.id, id),
      queryFn: () => api(account.id).get<BoardDetail>(`/boards/${id}`),
    })),
  });
  // People columns of its boards, by key (the same key on several boards is one choice).
  const peopleColumns = new Map<string, string[]>();
  for (const q of details)
    for (const c of q.data?.columns ?? [])
      if (c.type === 'people') peopleColumns.set(c.id, [...(peopleColumns.get(c.id) ?? []), c.title]);

  return (
    <div className="flex flex-col gap-3" data-testid="agent-triggers">
      <Card className="flex flex-col gap-3">
        <p className="text-xs text-muted">{t('agents.triggers.hint')}</p>
        {!boardIds.length ? <Notice tone="warn">{t('agents.triggers.noBoards')}</Notice> : null}
        {/*: with mention off the agent shows greyed out in the @ list — say so plainly. */}
        {!triggers.mention ? (
          <div data-testid="agent-mention-off-note">
            <Notice tone="info">{t('agents.triggers.mentionOff')}</Notice>
          </div>
        ) : null}
        {/* people pick it in the AI panel and chat with it; its changes wait for their approval. */}
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2.5 text-sm font-semibold text-fg">
            <Switch
              checked={triggers.chat}
              onChange={(v) => set('chat', v)}
              label={t('agents.triggers.chat')}
              testId="agent-trigger-chat"
            />
            {t('agents.triggers.chat')}
          </label>
          <span className="text-xs text-muted">{t('agents.triggers.chatHint')}</span>
        </div>
        <label className="flex items-center gap-2.5 text-sm font-semibold text-fg">
          <Switch
            checked={triggers.mention}
            onChange={(v) => set('mention', v)}
            label={t('agents.triggers.mention')}
            testId="agent-trigger-mention"
          />
          {t('agents.triggers.mention')}
        </label>
        {triggers.mention ? (
          <Field label={t('agents.triggers.mentionTask')} hint={t('agents.triggers.mentionTaskHint')}>
            <textarea
              rows={3}
              maxLength={4000}
              value={triggers.mention_prompt}
              placeholder={t('agents.triggers.defaultTask')}
              onChange={(e) => set('mention_prompt', e.target.value)}
              className={textareaClass}
              data-testid="agent-trigger-mention-task"
            />
          </Field>
        ) : null}
        <label className="flex items-center gap-2.5 text-sm font-semibold text-fg">
          <Switch
            checked={triggers.assign}
            onChange={(v) => set('assign', v)}
            label={t('agents.triggers.assign')}
            testId="agent-trigger-assign"
          />
          {t('agents.triggers.assign')}
        </label>
        {triggers.assign ? (
          <>
            <Field label={t('agents.triggers.columns')} hint={t('agents.triggers.columnsHint')}>
              <div className="flex flex-wrap gap-1.5" data-testid="agent-trigger-columns">
                <Chip on={!triggers.assign_columns.length} onClick={() => set('assign_columns', [])}>
                  {t('agents.triggers.anyColumn')}
                </Chip>
                {[...peopleColumns].map(([key, titles]) => (
                  <Chip
                    key={key}
                    on={triggers.assign_columns.includes(key)}
                    onClick={() => set('assign_columns', toggle(triggers.assign_columns, key))}
                    testId={`agent-trigger-column-${key}`}
                  >
                    {[...new Set(titles)].join(' / ')}
                  </Chip>
                ))}
              </div>
            </Field>
            <Field label={t('agents.triggers.assignTask')} hint={t('agents.triggers.assignTaskHint')}>
              <textarea
                rows={3}
                maxLength={4000}
                value={triggers.assign_prompt}
                placeholder={t('agents.triggers.defaultTask')}
                onChange={(e) => set('assign_prompt', e.target.value)}
                className={textareaClass}
                data-testid="agent-trigger-assign-task"
              />
            </Field>
          </>
        ) : null}
        {triggers.mention || triggers.assign ? (
          <>
            <Field label={t('agents.triggers.boards')} hint={t('agents.triggers.boardsHint')}>
              <div className="flex flex-wrap gap-1.5" data-testid="agent-trigger-boards">
                <Chip on={!triggers.board_ids.length} onClick={() => set('board_ids', [])}>
                  {t('agents.triggers.allBoards')}
                </Chip>
                {boardIds.map((id) => (
                  <Chip
                    key={id}
                    on={triggers.board_ids.includes(id)}
                    onClick={() => set('board_ids', toggle(triggers.board_ids, id))}
                    testId={`agent-trigger-board-${id}`}
                  >
                    {nameOf(id)}
                  </Chip>
                ))}
              </div>
            </Field>
            <label className="flex items-center gap-2.5 text-sm text-fg">
              <Switch
                checked={triggers.allow_guests}
                onChange={(v) => set('allow_guests', v)}
                label={t('agents.triggers.guests')}
                testId="agent-trigger-guests"
              />
              <span>
                {t('agents.triggers.guests')}
                <span className="block text-xs text-muted">{t('agents.triggers.guestsHint')}</span>
              </span>
            </label>
          </>
        ) : null}
      </Card>
      <Card className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg">{t('agents.triggers.automations')}</h3>
        <p className="text-xs text-muted">{t('agents.triggers.automationsHint')}</p>
        {agent ? <AgentAutomations account={account} agent={agent} /> : null}
      </Card>
    </div>
  );
};

const AgentAutomations = ({ account, agent }: { account: MyAccount; agent: Agent }) => {
  const q = useAgentAutomations(account.id, agent.id);
  if (q.isPending) return <SkeletonRows rows={2} label={t('app.loading')} />;
  const rows = q.data?.data ?? [];
  if (!rows.length) return <EmptyState title={t('agents.triggers.noAutomations')} testId="agent-automations-empty" />;
  return (
    <ul className="flex flex-col gap-1" data-testid="agent-automations">
      {rows.map((r) => (
        <li key={r.id} className="flex items-center gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-fg">{r.title}</span>
          <span className="text-xs text-muted">{r.board_name}</span>
          <Badge tone={r.is_active ? 'ok' : 'neutral'}>
            {r.is_active ? t('agents.state.active') : t('agents.state.paused')}
          </Badge>
        </li>
      ))}
    </ul>
  );
};
