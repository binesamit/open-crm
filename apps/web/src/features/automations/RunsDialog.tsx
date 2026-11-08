// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState } from 'react';
import { formatDateTime, t, type Automation, type MessageKey } from '@bines/shared';
import { Badge, Dialog, Button, Notice, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { BoardAccountContext } from '../board/board-context';
import { useRuns } from './automations-api';
import { runReasonText } from './run-reasons';

const TONE = {
  succeeded: 'ok',
  partial: 'warn',
  failed: 'warn',
  skipped: 'neutral',
  pending: 'neutral',
  running: 'neutral',
} as const;

/** Run history (04 §8.2): every run, its status, why it was skipped, and each action's outcome. */
export const RunsDialog = ({ automation, onClose }: { automation: Automation; onClose: () => void }) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const runs = useRuns(accountId, automation.id);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('auto.runs.title', { title: automation.title })}
      className="max-w-[720px]"
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <div data-testid="automation-runs">
        {runs.isLoading ? (
          <SkeletonRows rows={4} label={t('app.loading')} />
        ) : runs.isError ? (
          <Notice tone="error">{errorMessage(runs.error)}</Notice>
        ) : !runs.data?.data.length ? (
          <p className="py-6 text-center text-muted">{t('auto.runs.empty')}</p>
        ) : (
          <ul className="overflow-hidden rounded-[14px] border border-line">
            {runs.data.data.map((r) => (
              <li
                key={r.id}
                className="border-b border-line-soft px-3.5 py-3 last:border-b-0"
                data-testid="automation-run"
                data-status={r.status}
              >
                <button
                  type="button"
                  className="flex w-full flex-wrap items-center gap-2 text-start"
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                >
                  <Badge tone={TONE[r.status]}>{t(`auto.runs.status.${r.status}` as MessageKey)}</Badge>
                  <span className="text-xs text-muted">{formatDateTime(r.created_at)}</span>
                  {r.skip_reason ? (
                    <span className="text-xs text-muted" data-testid="automation-run-reason">
                      {runReasonText(r.skip_reason)}
                    </span>
                  ) : null}
                  {r.error ? <span className="truncate text-xs text-danger-fg">{runReasonText(r.error)}</span> : null}
                </button>
                {open === r.id ? (
                  <ol
                    className="mt-2 space-y-1 rounded-[10px] bg-surface-3 p-2.5 ps-4"
                    data-testid="automation-run-log"
                  >
                    {r.log.map((l, i) => (
                      <li key={i} className="text-xs">
                        <span className="font-semibold">{t(`auto.kind.${l.type}` as MessageKey)}</span> —{' '}
                        {t(`auto.runs.action.${l.status}` as MessageKey)}
                        {l.reason ? (
                          <span data-testid="automation-log-reason"> ({runReasonText(l.reason)})</span>
                        ) : null}
                        {l.warnings?.length ? (
                          <span className="text-muted"> ({runReasonText(l.warnings.join('; '))})</span>
                        ) : null}
                        {l.error ? <span className="text-danger-fg"> {l.error}</span> : null}
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
};
