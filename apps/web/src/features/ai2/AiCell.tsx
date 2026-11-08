// SPDX-License-Identifier: AGPL-3.0-only
import { type MouseEvent, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  type AiColumnRun,
  type AiImageRerunMode,
  type AiOutput,
  aiOutputStatus,
  type AiValue,
  aiOutputsOf,
  t,
  msgKey,
  dynamicKey,
  hasMessage,
} from '@bines/shared';
import { Button, cn, Menu, useActionMenu } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { onExistingEntries } from './run-choice';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import type { CellProps } from '../board/cells';
import { Popover } from '../board/cells/Popover';
import { useRunAiColumn } from './ai2-api';
import { usePlanGate } from '../../lib/plan-gate';
import { planGateAttrs } from '../../lib/plan-limit';

/**
 * The AI column's cell (מ11): the generated text with an "AI generated" mark (when, model, cost on hover); a run
 * button (fill / run again) for whoever may edit; a panel with the whole text, run again, edit by hand, clear.
 * Every run's toast undoes it (one batch).
 */
const base = 'relative flex h-full w-full items-center px-2 text-sm';
/** A cell whose pending designs did not move for this long: its run is taken for stopped (retry offered). */
const STALE_MS = 20 * 60_000;

/** One design's state in words: waiting / retrying soon (why) / being made / not made (why). */
const designState = (o: AiOutput) => {
  const st = aiOutputStatus(o);
  if (st === 'running') return t('ai2.cell.designRunning');
  if (st === 'pending')
    return o.error ? t('ai2.cell.designRetrying', { reason: reasonText(o.error) }) : t('ai2.cell.designPending');
  if (st === 'failed') return t('ai2.cell.designFailed', { reason: reasonText(o.error ?? 'failed') });
  return null;
};

export const money = (usd: number) => (usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`);

/** A run's / a design's reason as words (the code itself when there are none). */
export const reasonText = (code: string) =>
  hasMessage(`ai2.reason.${code}`) ? t(dynamicKey(`ai2.reason.${code}`)) : code;

/**
 * An image run starts (the images queue): its designs are made one after the other in the
 * background — said at once, not "done".
 */
export const runStartToast = (run: AiColumnRun) => {
  if (run.unit === 'image' && run.total > 0) showToast({ message: t('ai2.run.queuedImages', { n: run.total }) });
};

/** The toast after a run: what happened, what it cost, and undo for the whole run. */
export const runToast = (accountId: string, run: AiColumnRun, invalidate: () => Promise<unknown>) => {
  if (run.status === 'queued' || run.status === 'running') {
    // Still making images after the wait: they keep appearing in their cells.
    showToast({ message: t('ai2.run.stillRunning', { done: run.done, total: run.total }) });
    return;
  }
  if (run.status === 'failed' && !run.done) {
    const why = run.stopped ?? run.errors[0]?.error ?? 'failed';
    showToast({ message: t('ai2.run.failed', { reason: reasonText(why) }), tone: 'error' });
    return;
  }
  if (run.unit === 'image' && run.total === 0) {
    showToast({ message: t('ai2.run.nothingMissing') });
    return;
  }
  const parts = [
    run.unit === 'image'
      ? t('ai2.run.imagesDone', { done: run.done, total: run.total, cost: money(run.cost_usd) })
      : t('ai2.run.done', { n: run.done, cost: money(run.cost_usd) }),
  ];
  if (run.failed)
    parts.push(
      run.unit === 'image' ? t('ai2.run.imagesFailed', { n: run.failed }) : t('ai2.run.someFailed', { n: run.failed }),
    );
  // Why ("no image in the source column" on a bulk run), when the reason reads as words.
  const firstError = run.failed ? run.errors[0]?.error : undefined;
  if (firstError && hasMessage(`ai2.reason.${firstError}`)) parts.push(t(dynamicKey(`ai2.reason.${firstError}`)));
  if (run.stopped) parts.push(reasonText(run.stopped));
  showToast({
    message: parts.join(' · '),
    ...(run.batch_id
      ? {
          action: {
            label: t('undo.action'),
            run: async () => {
              await api(accountId).post(`/activity/batches/${run.batch_id}/undo`, {});
              await invalidate();
            },
          },
        }
      : {}),
  });
};

export const AiCell = ({ column, value, text, editable, onChange, accountId, itemId, boardId }: CellProps) => {
  const qc = useQueryClient();
  const v = value as AiValue | null;
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const run = useRunAiColumn(accountId, boardId, { onStart: runStartToast });
  // Plan feature gate: without `ai` the run button stays, disabled with the upgrade hint.
  const aiGate = usePlanGate(accountId, 'ai');
  const invalidate = () => qc.invalidateQueries({ queryKey: ['account', accountId] });
  const handlers = {
    onSuccess: (r: AiColumnRun) => runToast(accountId, r, invalidate),
    onError: (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' }),
  };
  const runWith = (onExisting?: AiImageRerunMode) =>
    aiGate.allowed &&
    run.mutate(
      { columnId: column.id, mode: 'items', item_ids: [itemId], ...(onExisting ? { on_existing: onExisting } : {}) },
      handlers,
    );
  // The images queue: make only the designs that were not made — never a made one again.
  const retryMissing = () =>
    aiGate.allowed &&
    run.mutate(
      { columnId: column.id, mode: 'items', item_ids: [itemId], path: `items/${itemId}/retry-missing` },
      handlers,
    );
  // Round 4: the designs this cell made; a re-run of a cell that has some asks what to do with them.
  const outputs = aiOutputsOf(v);
  // The images queue: how far the cell's designs are, and what was not made.
  const made = outputs.filter((o) => aiOutputStatus(o) === 'done').length;
  const inProgress = outputs.filter((o) => ['pending', 'running'].includes(aiOutputStatus(o))).length;
  const failed = outputs.filter((o) => aiOutputStatus(o) === 'failed').length;
  // Designs left pending by a run that stopped long ago (its job died) can be completed too; the server checks.
  // (Measured when the panel opened — the button lives there.)
  const stale = inProgress > 0 && !!v?.ai?.at && openedAt - new Date(v.ai.at).getTime() > STALE_MS;
  const canRetry = editable && (failed > 0 || stale);
  const choice = useActionMenu();
  const go = (e?: MouseEvent<HTMLElement>) => {
    if (outputs.some((o) => !o.rejected) && e && aiGate.allowed) choice.fromTrigger(e);
    else runWith();
  };
  // Photo numbers in the order their designs are listed (null = all photos together / none).
  const photoIds = [...new Set(outputs.map((o) => o.source_asset_id).filter((x): x is string => !!x))];
  const reject = async (fileId: string) => {
    const ok = await confirmDialog({
      title: t('ai2.cell.rejectTitle'),
      message: t('ai2.cell.rejectMessage'),
      confirmLabel: t('ai2.cell.reject'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api(accountId).post(
        `/boards/${boardId}/ai-columns/${column.id}/items/${itemId}/outputs/${fileId}/reject`,
        {},
      );
      showToast({ message: t('ai2.cell.rejectedToast') });
      await invalidate();
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    }
  };
  const note =
    v?.ai?.note && hasMessage(`ai2.cell.note.${v.ai.note}`) ? t(dynamicKey(`ai2.cell.note.${v.ai.note}`)) : null;
  const meta = v?.ai
    ? t('ai2.cell.generated', {
        model: v.ai.model,
        cost: money(v.ai.cost_usd),
        at: new Date(v.ai.at).toLocaleString(),
      })
    : undefined;
  // Photos as input: fewer went than there were (the provider's limit — the newest went).
  const photos = v?.ai?.source_images;
  // Style examples of other items (round 3) went too: always said, with how many of the images they were.
  const photosNote = photos?.examples
    ? t('ai2.cell.photosSentStyle', { sent: photos.sent, total: photos.total, examples: photos.examples })
    : photos && photos.sent < photos.total
      ? t('ai2.cell.photosSent', { sent: photos.sent, total: photos.total })
      : undefined;
  const runButton = editable ? (
    <button
      type="button"
      data-testid="ai-cell-run"
      disabled={run.isPending}
      {...planGateAttrs(aiGate)}
      onClick={(e) => {
        e.stopPropagation();
        go(e);
      }}
      title={aiGate.allowed ? t(msgKey(text ? 'ai2.cell.rerun' : 'ai2.cell.run')) : undefined}
      aria-label={t(msgKey(text ? 'ai2.cell.rerun' : 'ai2.cell.run'))}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-[6px] text-violet-fg hover:bg-violet-soft disabled:opacity-60',
        !aiGate.allowed && 'cursor-not-allowed opacity-45',
        text && !run.isPending && 'opacity-0 group-hover/ai:opacity-100 focus-visible:opacity-100',
      )}
    >
      {run.isPending ? (
        <span className="size-3.5 animate-spin rounded-full border-2 border-[var(--line)] border-e-[var(--primary)]" />
      ) : (
        <Icon name={text ? 'restore' : 'play'} size={14} />
      )}
    </button>
  ) : null;

  return (
    <div
      className={cn(base, 'group/ai gap-1', (text || outputs.length > 0) && 'cursor-pointer hover:bg-surface-2')}
      data-testid="ai-cell"
      data-ai={v?.ai ? 'generated' : v ? 'manual' : 'empty'}
      data-progress={inProgress ? 'running' : failed ? 'missing' : undefined}
      onClick={() => {
        if (!text && !outputs.length) return;
        setOpenedAt(Date.now());
        setOpen(true);
      }}
    >
      {v?.ai ? (
        <span
          className="shrink-0 text-violet-fg"
          title={
            photosNote
              ? `${meta}
${photosNote}`
              : meta
          }
          data-testid="ai-cell-mark"
        >
          <Icon name="sparkle" size={13} />
        </span>
      ) : null}
      <span className="min-w-0 flex-1 truncate" dir="auto">
        {text}
      </span>
      {/* The images queue: "3 of 8 made" while the designs are made; what was not made, after. */}
      {inProgress ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted" data-testid="ai-cell-progress">
          <span className="size-3 animate-spin rounded-full border-2 border-[var(--line)] border-e-[var(--primary)]" />
          {t('ai2.cell.progress', { done: made, total: outputs.length })}
        </span>
      ) : failed ? (
        <span className="shrink-0 text-xs text-danger-fg" data-testid="ai-cell-missing">
          {t('ai2.cell.missing', { n: failed })}
        </span>
      ) : null}
      {runButton}
      {/* The run-time choice (round 4); its clicks stay out of the cell (which opens the panel). */}
      <span className="contents" onClick={(e) => e.stopPropagation()}>
        <Menu
          at={choice.at}
          onClose={choice.close}
          label={t('ai2.cell.rerun')}
          items={onExistingEntries(column, (on) => runWith(on), 'ai-cell-existing')}
        />
      </span>
      {open ? (
        <Popover
          open
          onClose={() => {
            setOpen(false);
            setEditing(null);
          }}
          className="w-80 p-3"
        >
          <div className="flex flex-col gap-2" data-testid="ai-cell-panel">
            {editing === null ? (
              <p
                className="max-h-64 overflow-auto text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
                dir="auto"
                data-testid="ai-cell-text"
              >
                {text}
              </p>
            ) : (
              <textarea
                autoFocus
                value={editing}
                data-testid="ai-cell-edit-input"
                onChange={(e) => setEditing(e.target.value)}
                className="h-32 w-full resize-y rounded-[10px] border border-line-strong bg-surface p-2 text-sm focus:border-primary focus:outline-none"
              />
            )}
            {outputs.length && editing === null ? (
              // Round 4: every design with its photo / variation / version; ✕ moves one to the trash (rejected). The
              // images queue: each design's state — waiting, being made, retrying soon, not made (why).
              <div className="flex flex-col gap-1" data-testid="ai-cell-designs">
                <p className="text-xs text-muted">
                  {inProgress || failed
                    ? t('ai2.cell.designsProgress', { done: made, total: outputs.length })
                    : t('ai2.cell.designs')}
                </p>
                {outputs.map((o) => {
                  const state = designState(o);
                  const st = aiOutputStatus(o);
                  return (
                    <div
                      key={`${o.source_asset_id ?? 'all'}-${o.variation}`}
                      className="flex items-center gap-1.5 rounded-[8px] bg-surface-2 px-2 py-1 text-xs"
                      data-testid="ai-cell-design"
                      data-file={o.file_id}
                      data-status={st}
                      data-rejected={o.rejected ? 'true' : undefined}
                    >
                      <span className="min-w-0 flex-1 truncate" dir="auto" title={o.name}>
                        {o.source_asset_id
                          ? t('ai2.cell.designPhoto', {
                              photo: photoIds.indexOf(o.source_asset_id) + 1,
                              variation: o.variation,
                            })
                          : t('ai2.cell.designAll', { variation: o.variation })}
                        {o.version ? ` · ${t('ai2.cell.version', { n: o.version })}` : ''}
                      </span>
                      {state ? (
                        <span
                          className={cn('min-w-0 shrink truncate', st === 'failed' ? 'text-danger-fg' : 'text-muted')}
                          title={state}
                          data-testid="ai-cell-design-state"
                        >
                          {state}
                        </span>
                      ) : null}
                      {o.rejected ? (
                        <span className="shrink-0 text-muted" data-testid="ai-cell-design-rejected">
                          {t('ai2.cell.rejected')}
                        </span>
                      ) : editable && o.file_id && st === 'done' ? (
                        <button
                          type="button"
                          className="grid size-5 shrink-0 place-items-center rounded-[6px] text-muted hover:bg-surface hover:text-fg"
                          data-testid="ai-cell-design-reject"
                          aria-label={t('ai2.cell.reject')}
                          title={t('ai2.cell.reject')}
                          onClick={() => void reject(o.file_id!)}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      ) : null}
                    </div>
                  );
                })}
                {canRetry ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="self-start"
                    data-testid="ai-cell-retry-missing"
                    busy={run.isPending}
                    disabled={!aiGate.allowed}
                    onClick={() => retryMissing()}
                  >
                    <Icon name="restore" size={14} />
                    {t('ai2.cell.retryMissing', { n: failed + (stale ? inProgress : 0) })}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {note ? (
              <p className="text-xs text-muted" data-testid="ai-cell-note">
                {note}
              </p>
            ) : null}
            {photosNote ? (
              <p className="text-xs text-muted" data-testid="ai-cell-photos">
                {photosNote}
              </p>
            ) : null}
            {meta ? (
              <p className="text-xs text-muted">{meta}</p>
            ) : (
              <p className="text-xs text-muted">{t('ai2.cell.manual')}</p>
            )}
            {editable ? (
              <div className="flex flex-wrap gap-1.5">
                {editing === null ? (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      data-testid="ai-cell-rerun"
                      busy={run.isPending}
                      onClick={(e) => go(e)}
                    >
                      <Icon name="sparkle" size={14} />
                      {t('ai2.cell.rerun')}
                    </Button>
                    <Button size="sm" variant="ghost" data-testid="ai-cell-edit" onClick={() => setEditing(text ?? '')}>
                      {t('ai2.cell.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="ai-cell-clear"
                      onClick={() => {
                        onChange(null);
                        setOpen(false);
                      }}
                    >
                      {t('ai2.cell.clear')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      size="sm"
                      data-testid="ai-cell-edit-save"
                      onClick={() => {
                        onChange(editing.trim() ? { text: editing } : null);
                        setEditing(null);
                        setOpen(false);
                      }}
                    >
                      {t('common.save')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                      {t('common.cancel')}
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </Popover>
      ) : null}
    </div>
  );
};
