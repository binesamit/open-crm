// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from 'react';
import { type AgentBoardLevel, t } from '@bines/shared';
import { Button, Field, Input, Notice } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { usePlanGate } from '../../lib/plan-gate';
import { planGateAttrs } from '../../lib/plan-limit';
import { showToast } from '../../lib/toast';
import { useAgentMutations } from './agents-api';
import { textDiff } from './text-diff';

/**
 * "improve with AI" under the agent's instructions. The AI connection chosen for the agent rewrites
 * them from what the editor holds now (name, role, tools, boards, and an optional "what to change"); the person sees
 * the changes, may edit the suggestion, and applies it to the field — saving the agent stays the usual "Save".
 */
export const ImproveInstructions = ({
  accountId,
  agentId,
  draft,
  connectionId,
  model,
  textareaClass,
  onApply,
}: {
  accountId: string;
  agentId?: string;
  draft: {
    name: string;
    role: string;
    instructions: string;
    tools: string[];
    boards: { board_id: string; level: AgentBoardLevel }[];
  };
  connectionId: string;
  model: string;
  textareaClass: string;
  onApply: (instructions: string) => void;
}) => {
  const m = useAgentMutations(accountId);
  const gate = usePlanGate(accountId, 'ai');
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState('');
  // The suggestion and the instructions it was made from (the diff is against those, even if the field changed).
  const [result, setResult] = useState<{ from: string; text: string } | null>(null);
  const parts = useMemo(() => (result ? textDiff(result.from, result.text) : []), [result]);
  const changed = parts.some((p) => p.kind !== 'same');

  const run = () => {
    const from = draft.instructions;
    m.improve.mutate(
      {
        ...(agentId ? { agent_id: agentId } : {}),
        connection_id: connectionId,
        ...(model ? { model } : {}),
        name: draft.name,
        role: draft.role,
        instructions: from,
        tools: draft.tools,
        boards: draft.boards,
        request,
      },
      { onSuccess: (out) => setResult({ from, text: out.instructions }) },
    );
  };
  const close = () => {
    setOpen(false);
    setResult(null);
    m.improve.reset();
  };
  const apply = () => {
    if (!result) return;
    onApply(result.text);
    showToast({ message: t('agents.improve.applied') });
    close();
  };

  if (!open)
    return (
      <div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => gate.allowed && connectionId && setOpen(true)}
          disabled={gate.allowed && !connectionId}
          data-tip={connectionId ? t('agents.improve.hint') : t('agents.noConnection')}
          data-testid="agent-improve"
          {...planGateAttrs(gate)}
        >
          <Icon name="sparkle" size={14} />
          {t('agents.improve.button')}
        </Button>
      </div>
    );

  return (
    <div
      className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface-2 p-3"
      data-testid="agent-improve-panel"
    >
      <Field label={t('agents.improve.request')} hint={t('agents.improve.requestHint')}>
        <Input
          value={request}
          maxLength={1000}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !m.improve.isPending) run();
          }}
          placeholder={t('agents.improve.requestPlaceholder')}
          data-testid="agent-improve-request"
        />
      </Field>
      {m.improve.isError ? <Notice tone="error">{errorMessage(m.improve.error)}</Notice> : null}
      {result ? (
        <>
          <div className="text-xs text-muted">
            {changed ? t('agents.improve.changes') : t('agents.improve.noChanges')}
          </div>
          <div
            className="max-h-72 overflow-auto rounded-[10px] border border-line bg-surface px-2.5 py-2 text-sm whitespace-pre-wrap text-fg"
            data-testid="agent-improve-diff"
            dir="auto"
          >
            {parts.map((p, i) =>
              p.kind === 'same' ? (
                <span key={i}>{p.text}</span>
              ) : p.kind === 'add' ? (
                <ins key={i} className="bg-ok-soft text-ok-fg no-underline" data-testid="diff-add">
                  {p.text}
                </ins>
              ) : (
                <del key={i} className="bg-danger-soft text-danger-fg" data-testid="diff-del">
                  {p.text}
                </del>
              ),
            )}
          </div>
          <Field label={t('agents.improve.edit')} hint={t('agents.improve.editHint')}>
            <textarea
              rows={8}
              maxLength={20000}
              value={result.text}
              onChange={(e) => setResult({ ...result, text: e.target.value })}
              className={textareaClass}
              dir="auto"
              data-testid="agent-improve-text"
            />
          </Field>
        </>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {result ? (
          <Button size="sm" onClick={apply} disabled={!result.text.trim()} data-testid="agent-improve-apply">
            {t('agents.improve.apply')}
          </Button>
        ) : null}
        <Button
          variant={result ? 'secondary' : 'primary'}
          size="sm"
          onClick={run}
          busy={m.improve.isPending}
          data-testid="agent-improve-run"
        >
          <Icon name="sparkle" size={14} />
          {result ? t('agents.improve.again') : t('agents.improve.run')}
        </Button>
        <Button variant="ghost" size="sm" onClick={close} data-testid="agent-improve-cancel">
          {t('common.cancel')}
        </Button>
        <span className="text-xs text-muted">{t('agents.improve.notSaved')}</span>
      </div>
    </div>
  );
};
