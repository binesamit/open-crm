// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  formatDateTime,
  t,
  type MessageKey,
  type ScenarioDto,
  type ScenarioNode,
  type ScenarioRunDto,
} from '@bines/shared';
import { cn, Dialog, Spinner } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { useScenarioRuns } from './scenarios-api';

/**
 * phase 3 — a scenario's run log (the approved design's second screen): the runs, newest first, and the
 * chosen run's steps — each block's outcome, what came out of it, the branches a router took, why a path stopped.
 */
const STATUS_TONE: Record<string, string> = {
  succeeded: 'bg-ok',
  partial: 'bg-accent',
  failed: 'bg-danger',
  skipped: 'bg-[var(--muted)]',
  waiting: 'bg-info',
  running: 'bg-info',
  pending: 'bg-info',
};
const STEP_TONE: Record<string, string> = {
  ok: 'bg-ok-soft text-ok-fg',
  error: 'bg-danger-soft text-danger-fg',
  skipped: 'bg-surface-2 text-muted',
  waiting: 'bg-info-soft text-info-fg',
};

const statusText = (s: string) => t(`scenario.status.${s}` as MessageKey);

/** A skip / error reason as people read it (known codes have a text; anything else shows as it is). */
const reasonText = (reason: string | undefined) => {
  if (!reason) return '';
  const [code, detail] = reason.split(':', 2);
  const known = ['conditions', 'not_available', 'workflow_blocked', 'item_gone', 'nothing_to_do', 'inactive'];
  return known.includes(code!) ? t(`scenario.reason.${code}` as MessageKey, { detail: detail ?? '' }) : reason;
};

export const ScenarioRunsDialog = ({
  accountId,
  scenario,
  summary,
  onClose,
}: {
  accountId: string;
  scenario: Pick<ScenarioDto, 'id' | 'name' | 'graph'>;
  summary: (n: ScenarioNode) => string;
  onClose: () => void;
}) => {
  const runs = useScenarioRuns(accountId, scenario.id);
  const [chosen, setChosen] = useState<string | null>(null);
  const list = runs.data ?? [];
  const run = list.find((r) => r.id === chosen) ?? list[0] ?? null;
  const nodeOf = (id: string) => scenario.graph.nodes.find((n) => n.id === id);
  return (
    <Dialog open onClose={onClose} title={t('scenario.runsTitle', { name: scenario.name })} className="max-w-5xl!">
      <div className="flex min-h-[28rem] gap-4 max-md:flex-col" data-testid="scenario-runs-dialog">
        <ul className="flex w-80 shrink-0 flex-col gap-1 overflow-y-auto max-md:w-full" aria-label={t('scenario.runs')}>
          {runs.isLoading ? <Spinner label={t('app.loading')} /> : null}
          {!runs.isLoading && !list.length ? <li className="text-sm text-muted">{t('scenario.noRuns')}</li> : null}
          {list.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => setChosen(r.id)}
                data-testid="scenario-run"
                data-status={r.status}
                aria-current={r.id === run?.id || undefined}
                className={cn(
                  'flex w-full cursor-pointer flex-col gap-0.5 rounded-[10px] px-3 py-2 text-start',
                  r.id === run?.id ? 'bg-surface-2' : 'hover:bg-surface-2',
                )}
              >
                <span className="flex items-center gap-2 text-sm">
                  <span className={cn('size-2 shrink-0 rounded-full', STATUS_TONE[r.status] ?? 'bg-[var(--muted)]')} />
                  {statusText(r.status)}
                </span>
                <span className="text-xs text-muted">
                  {formatDateTime(r.created_at)}
                  {r.item_name ? ` · ${r.item_name}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {run ? <RunDetail run={run} nodeOf={nodeOf} summary={summary} /> : null}
      </div>
    </Dialog>
  );
};

const RunDetail = ({
  run,
  nodeOf,
  summary,
}: {
  run: ScenarioRunDto;
  nodeOf: (id: string) => ScenarioNode | undefined;
  summary: (n: ScenarioNode) => string;
}) => {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3" data-testid="scenario-run-detail">
      <div className="flex items-center gap-2">
        <h3 className="font-display text-base font-semibold text-heading">
          {t('scenario.runOf', { date: formatDateTime(run.created_at) })}
        </h3>
        <span
          className={cn(
            'rounded-full px-2.5 py-0.5 text-xs',
            STEP_TONE[run.status === 'succeeded' ? 'ok' : run.status === 'failed' ? 'error' : 'skipped'],
          )}
        >
          {statusText(run.status)}
        </span>
      </div>
      {run.skip_reason && !run.steps.length ? (
        <p className="text-sm text-muted">{reasonText(run.skip_reason)}</p>
      ) : null}
      {run.error && !run.steps.length ? <p className="text-sm text-danger-fg">{run.error}</p> : null}
      <ol className="flex flex-col gap-2">
        {run.steps.map((s, i) => {
          const n = nodeOf(s.node_id);
          const detail = s.output !== undefined && s.output !== null;
          return (
            <li
              key={i}
              className={cn('rounded-[12px] border bg-surface', s.status === 'error' ? 'border-danger' : 'border-line')}
              data-testid="scenario-step"
              data-status={s.status}
            >
              <button
                type="button"
                onClick={() => setOpen(open === i ? null : i)}
                aria-expanded={open === i}
                className="flex w-full cursor-pointer items-center gap-2.5 px-3.5 py-2.5 text-start text-sm"
              >
                <span className={cn('grid size-5 shrink-0 place-items-center rounded-full', STEP_TONE[s.status])}>
                  <Icon
                    name={
                      s.status === 'ok'
                        ? 'check'
                        : s.status === 'error'
                          ? 'x'
                          : s.status === 'waiting'
                            ? 'clock'
                            : 'minus'
                    }
                    size={11}
                  />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {n ? `${n.label || t(`scenario.kind.${n.kind}` as MessageKey)} · ${summary(n)}` : s.node_id}
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {s.branches?.length
                    ? t('scenario.tookBranches', {
                        names: s.branches
                          .map((b) =>
                            b === 'else'
                              ? t('scenario.else')
                              : ((n?.kind === 'router' ? n.branches.find((x) => x.id === b)?.label : b) ?? b),
                          )
                          .join(', '),
                      })
                    : s.error
                      ? t('scenario.status.failed')
                      : s.reason
                        ? reasonText(s.reason)
                        : t('scenario.ms', { n: s.duration_ms })}
                </span>
              </button>
              {open === i && (detail || s.error || s.reason) ? (
                <div className="border-t border-line px-3.5 py-2.5 text-xs">
                  {s.error ? <p className="text-danger-fg">{s.error}</p> : null}
                  {s.reason ? <p className="text-muted">{reasonText(s.reason)}</p> : null}
                  {detail ? (
                    <pre
                      dir="ltr"
                      className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-fg-2"
                    >
                      {JSON.stringify(s.output, null, 2)}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
};
