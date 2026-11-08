// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { ApiError } from '@bines/sdk';
import {
  AGENT_AVATAR_AUTO,
  animalAvatarDataUrl,
  type AgentApproval,
  type AgentRun,
  type AgentRunStep,
  aiTool,
  aiToolLabel,
  hasMessage,
  localizeToolPreview,
  exactTime,
  relativeTime,
  t,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, Dialog, Notice, SkeletonRows } from '@bines/ui';
import { api, errorMessage, type MyAccount } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { ActionDescriptionView } from '../ai/ActionDescription';
import { Markdown } from '../ai/Markdown';
import { useAgentMutations, useRun } from './agents-api';
import { attachedText, promptParts, promptPlain } from './prompt-text';

export const fail = (err: unknown) => showToast({ message: errorMessage(err), tone: 'error' });

export const usd = (n: number) => `$${n.toFixed(n > 0 && n < 1 ? 4 : 2)}`;

/**
 * The agent's face: one of our animals, a "the agent will pick" mark while a new agent waits for its
 * own pick, else its emoji / letters (or the first letter of its name) on a violet tile.
 */
export const AgentAvatar = ({ name, avatar, size = 36 }: { name: string; avatar: string | null; size?: number }) => {
  const animal = animalAvatarDataUrl(avatar);
  if (animal)
    return (
      <img
        src={animal}
        alt=""
        aria-hidden
        data-avatar={avatar ?? undefined}
        className="shrink-0 rounded-full"
        style={{ width: size, height: size }}
      />
    );
  if (avatar === AGENT_AVATAR_AUTO)
    return (
      <span
        aria-hidden
        data-avatar={avatar}
        className="grid shrink-0 place-items-center rounded-full border border-dashed border-violet-fg/50 bg-violet-soft text-violet-fg"
        style={{ width: size, height: size }}
      >
        <Icon name="sparkle" size={Math.round(size * 0.45)} />
      </span>
    );
  return (
    <span
      aria-hidden
      className="grid shrink-0 place-items-center rounded-[12px] bg-violet-soft font-display font-extrabold text-violet-fg"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }}
    >
      {avatar?.trim() || name.trim().slice(0, 1) || '?'}
    </span>
  );
};

const RUN_TONE: Record<AgentRun['status'], 'neutral' | 'info' | 'ok' | 'warn' | 'danger' | 'violet'> = {
  queued: 'neutral',
  running: 'info',
  waiting_approval: 'warn',
  succeeded: 'ok',
  failed: 'danger',
  cancelled: 'neutral',
  skipped: 'neutral',
};

export const RunStatus = ({ run }: { run: Pick<AgentRun, 'status'> }) => (
  <span data-testid="run-status" data-status={run.status}>
    <Badge tone={RUN_TONE[run.status]}>{t(`agents.run.status.${run.status}`)}</Badge>
  </span>
);

/** Why a run ended badly / was skipped, in words (codes from the engine: limit_steps, quota_budget …). */
export const runReason = (run: Pick<AgentRun, 'error' | 'skip_reason'>) => {
  const code = run.skip_reason ?? run.error;
  if (!code) return null;
  // A refusal of the shared AI gate (plan_read_only, plan_suspended …) reads as the API's error text.
  return !hasMessage(`agents.reason.${code}`) && hasMessage(`error.${code}`)
    ? tDynamic(`error.${code}`)
    : tDynamic(`agents.reason.${code}`);
};

/** r27: localized for every tool (agents.tool / ai2.tool keys); the English title only when no key exists. */
export const toolLabel = (name: string) => aiToolLabel(name, aiTool(name)?.title);

const OUTCOME_TONE: Record<string, 'neutral' | 'info' | 'ok' | 'warn' | 'danger'> = {
  ran: 'ok',
  dry_run: 'info',
  rejected: 'danger',
  expired: 'warn',
  blocked: 'danger',
  failed: 'danger',
};

const StepRow = ({ step }: { step: AgentRunStep }) => {
  if (step.kind === 'prompt')
    return (
      <li data-testid="run-step" data-kind="prompt" className="rounded-[10px] bg-surface-2 px-3 py-2 text-[0.8125rem]">
        <div className="mb-1 text-xs font-semibold text-muted">{t('agents.step.prompt')}</div>
        {/* r27: the model's wrapper tags (<task>, <untrusted_content>) are not shown — the task, then what came
            with it, each under its source. */}
        {promptParts(step.text ?? '').map((p, i) =>
          p.kind === 'text' ? (
            <p key={i} className="break-words whitespace-pre-wrap text-fg" data-testid="run-prompt-text">
              {p.text}
            </p>
          ) : (
            <div key={i} className="mt-1.5 border-s-2 border-line ps-2" data-testid="run-prompt-attached">
              <div className="text-[0.6875rem] font-semibold text-muted">
                {p.source === 'item' || p.source === 'update'
                  ? t(`r27.run.source.${p.source}`)
                  : t('r27.run.source.other', { source: p.source })}
              </div>
              <p className="line-clamp-6 break-words whitespace-pre-wrap text-fg-2">{attachedText(p)}</p>
            </div>
          ),
        )}
      </li>
    );
  if (step.kind === 'model')
    return step.text ? (
      <li data-testid="run-step" data-kind="model" className="px-1 py-1 text-[0.8125rem]">
        <div className="mb-0.5 text-xs font-semibold text-muted">{t('agents.step.answer')}</div>
        <Markdown text={step.text} className="text-[0.8125rem] text-fg" />
      </li>
    ) : null;
  // A tool call: what it did in words (names resolved for me), the input / result only as technical details (sync-ai).
  return (
    <li
      data-testid="run-step"
      data-kind="tool"
      data-tool={step.tool ?? ''}
      data-outcome={step.outcome ?? ''}
      className="rounded-[10px] border border-line px-3 py-2 text-[0.8125rem]"
    >
      <div className="flex items-start gap-2">
        <ActionDescriptionView
          className="flex-1"
          description={step.description}
          toolLabel={toolLabel(step.tool ?? '')}
          input={step.input}
          output={step.output}
          outputError={step.is_error}
          sentenceClassName="text-[0.8125rem] font-medium"
        />
        <span className="shrink-0">
          <Badge tone={OUTCOME_TONE[step.outcome ?? ''] ?? 'neutral'}>
            {tDynamic(`agents.outcome.${step.outcome ?? 'ran'}`)}
          </Badge>
        </span>
      </div>
    </li>
  );
};

/** One approval request: what the agent wants to do, approve / reject. */
export const ApprovalCard = ({
  account,
  approval,
  showAgent,
}: {
  account: MyAccount;
  approval: AgentApproval;
  showAgent?: boolean;
}) => {
  const m = useAgentMutations(account.id);
  const decide = (decision: 'approve' | 'reject') =>
    m.decide.mutate(
      { id: approval.id, decision },
      {
        onSuccess: () =>
          showToast({ message: t(decision === 'approve' ? 'agents.approval.approved' : 'agents.approval.rejected') }),
        onError: fail,
      },
    );
  const pending = approval.status === 'pending';
  return (
    <div
      data-testid="approval-row"
      data-status={approval.status}
      className="flex flex-wrap items-start gap-3 rounded-[12px] border border-line bg-surface px-3 py-2.5"
    >
      <div className="min-w-0 flex-1 basis-64 space-y-0.5">
        <div className="text-sm font-semibold text-fg">
          {showAgent && approval.agent_name ? `${approval.agent_name} · ` : ''}
          {toolLabel(approval.tool)}
        </div>
        {/* In words with real names; the JSON only behind "technical details" (sync-ai). */}
        <div data-testid="approval-preview">
          <ActionDescriptionView
            description={approval.description}
            toolLabel={approval.description ? toolLabel(approval.tool) : localizeToolPreview(approval.preview)}
            input={approval.input}
            sentenceClassName="text-[0.8125rem] text-fg-2"
          />
        </div>
        <p className="text-[0.6875rem] text-muted">
          {pending
            ? t('agents.approval.expires', { when: exactTime(approval.expires_at) })
            : tDynamic(`agents.approval.status.${approval.status}`, { who: approval.decided_by_name ?? '' })}
        </p>
      </div>
      {pending ? (
        <div className="flex shrink-0 gap-2">
          <Button size="sm" busy={m.decide.isPending} onClick={() => decide('approve')} data-testid="approval-approve">
            {t('agents.approval.approve')}
          </Button>
          <Button
            size="sm"
            variant="danger-outline"
            disabled={m.decide.isPending}
            onClick={() => decide('reject')}
            data-testid="approval-reject"
          >
            {t('agents.approval.reject')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};

/** "What the agent did": status, cost, approvals, every step; cancel and undo the whole run. */
export const RunView = ({ account, runId }: { account: MyAccount; runId: string }) => {
  const q = useRun(account.id, runId);
  const m = useAgentMutations(account.id);
  const [now] = useState(() => Date.now());
  if (q.isPending) return <SkeletonRows rows={4} label={t('app.loading')} />;
  if (q.isError) return <Notice tone="error">{errorMessage(q.error)}</Notice>;
  const { run, steps, approvals } = q.data;
  const activeRun = ['queued', 'running', 'waiting_approval'].includes(run.status);
  const undo = async () => {
    const ok = await confirmDialog({
      title: t('agents.run.undoTitle'),
      message: t('agents.run.undoHint', { n: run.changes }),
      confirmLabel: t('agents.run.undo'),
      danger: true,
    });
    if (!ok) return;
    try {
      await m.undo.mutateAsync({ runId: run.id });
    } catch (err) {
      if (!(err instanceof ApiError && err.body.code === 'changed_since')) return fail(err);
      const again = await confirmDialog({
        title: t('undo.changedSince.title'),
        message: t('undo.changedSince.message'),
        confirmLabel: t('undo.anyway'),
      });
      if (!again) return;
      try {
        await m.undo.mutateAsync({ runId: run.id, force: true });
      } catch (e) {
        return fail(e);
      }
    }
    showToast({ message: t('agents.run.undone') });
    void q.refetch();
  };
  return (
    <div className="flex flex-col gap-3" data-testid="run-view" data-run-id={run.id}>
      <div className="flex flex-wrap items-center gap-2">
        <RunStatus run={run} />
        {run.dry_run ? <Badge tone="info">{t('agents.run.dryRun')}</Badge> : null}
        {run.undone_at ? <Badge tone="neutral">{t('agents.run.undoneBadge')}</Badge> : null}
        <span className="text-xs text-muted">
          <bdi>{usd(run.cost_usd)}</bdi> · {t('agents.run.stepsCount', { n: run.steps, tools: run.tool_calls })}
          {run.model ? (
            <>
              {' · '}
              <span dir="ltr">{run.model}</span>
            </>
          ) : null}
          {' · '}
          <time dateTime={run.created_at} title={exactTime(run.created_at)}>
            {relativeTime(run.created_at, now)}
          </time>
        </span>
        <span className="ms-auto flex gap-2">
          {activeRun ? (
            <Button
              size="sm"
              variant="secondary"
              busy={m.cancel.isPending}
              onClick={() => m.cancel.mutate(run.id, { onError: fail })}
              data-testid="run-cancel"
            >
              {t('agents.run.cancel')}
            </Button>
          ) : null}
          {!activeRun && run.changes > 0 && !run.undone_at ? (
            <Button
              size="sm"
              variant="danger-outline"
              busy={m.undo.isPending}
              onClick={() => void undo()}
              data-testid="run-undo"
            >
              {t('agents.run.undoN', { n: run.changes })}
            </Button>
          ) : null}
        </span>
      </div>
      {runReason(run) ? <Notice tone={run.status === 'skipped' ? 'warn' : 'error'}>{runReason(run)}</Notice> : null}
      {approvals.length ? (
        <div className="flex flex-col gap-2" data-testid="run-approvals">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} account={account} approval={a} />
          ))}
        </div>
      ) : null}
      <ol className="flex flex-col gap-2" data-testid="run-steps">
        {steps.map((s) => (
          <StepRow key={s.seq} step={s} />
        ))}
      </ol>
      {run.final_text ? (
        <div className="rounded-[10px] bg-ok-soft px-3 py-2 text-[0.8125rem] text-ok-fg" data-testid="run-final">
          <Markdown text={run.final_text} className="text-[0.8125rem]" />
        </div>
      ) : null}
    </div>
  );
};

export const RunDialog = ({
  account,
  runId,
  onClose,
}: {
  account: MyAccount;
  runId: string | null;
  onClose: () => void;
}) => (
  <Dialog open={!!runId} onClose={onClose} title={t('agents.run.title')} className="max-w-3xl!">
    {runId ? <RunView account={account} runId={runId} /> : null}
  </Dialog>
);

/** A runs table row (history). */
export const RunRow = ({ run, onOpen, showAgent }: { run: AgentRun; onOpen: () => void; showAgent?: boolean }) => {
  const [now] = useState(() => Date.now());
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="run-row"
      data-status={run.status}
      className="flex w-full flex-wrap items-center gap-2 border-b border-line-soft px-3.5 py-2.5 text-start text-[0.8125rem] last:border-b-0 hover:bg-surface-2"
    >
      <RunStatus run={run} />
      <span className="min-w-0 flex-1 basis-48 truncate text-fg">
        {showAgent && run.agent_name ? <b className="font-semibold">{run.agent_name} · </b> : null}
        {run.prompt ? promptPlain(run.prompt) : tDynamic(`agents.trigger.${run.trigger}`)}
      </span>
      <span className="text-xs text-muted tabular-nums">
        <bdi>{usd(run.cost_usd)}</bdi>
      </span>
      <time className="text-xs text-muted" dateTime={run.created_at} title={exactTime(run.created_at)}>
        {relativeTime(run.created_at, now)}
      </time>
    </button>
  );
};

/** Fetch helper for places outside React Query (the bell's quick decision). */
export const decideApproval = (accountId: string, id: string, decision: 'approve' | 'reject') =>
  api(accountId).post<AgentApproval>(`/agents/approvals/${id}`, { decision });
