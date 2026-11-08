// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '@bines/sdk';
import { type ColumnConversion, CONVERT_BACKUP_DAYS, formatDateTime, UNDO_WINDOW_DAYS, t } from '@bines/shared';
import { Badge, Button, Dialog, Notice, Switch } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { columnTypeLabel } from '../../../lib/locale';
import { showToast } from '../../../lib/toast';
import { undoAction } from '../../../lib/undo';
import { type BoardDetail, type Column, useMembers } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { PickerButton } from '../toolbar/parts';
import { DependentsList } from './ConvertColumnDialog';
import {
  clearFailed,
  previewRestore,
  type RestorePreview,
  runRestore,
  useColumnConversions,
  useConversionSettings,
} from './convert-api';

const STATUS_TONE = { running: 'info', done: 'ok', failed: 'danger', undone: 'neutral' } as const;

/**
 * "היסטוריית שינוי סוג" (plan §7, §10): who changed the column's type, when, from what, the counts and the report;
 * "undo" within the undo window, "restore from backup" after it (its own preview), "clear the marks" of failed
 * cells. Admins set how long the original values are kept.
 */
export const ConversionHistoryDialog = ({
  accountId,
  board,
  column,
  onClose,
}: {
  accountId: string;
  board: BoardDetail;
  column: Column;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const { meId } = useContext(BoardAccountContext);
  const members = useMembers(accountId).data?.data ?? [];
  const isAdmin = members.find((m) => m.user_id === meId)?.role === 'admin';
  const list = useColumnConversions(accountId, board.id, column.id);
  const settings = useConversionSettings(accountId, isAdmin);
  const [now] = useState(() => Date.now());
  const [open, setOpen] = useState<string | null>(null);
  const [restore, setRestore] = useState<{ id: string; preview: RestorePreview; force: boolean } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['account', accountId, 'board', board.id] });
  const who = (id: string | null) => members.find((m) => m.user_id === id)?.name ?? '';

  const askRestore = async (id: string, force = false) => {
    try {
      setRestore({ id, preview: await previewRestore(accountId, board.id, id, force), force });
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  const doRestore = async () => {
    if (!restore) return;
    try {
      await runRestore(accountId, board.id, restore.id, restore.preview.fingerprint, restore.force);
      setRestore(null);
      await refresh();
      showToast({ message: t('convert.restored') });
    } catch (err) {
      if (err instanceof ApiError && err.body.code === 'preview_stale') void askRestore(restore.id, restore.force);
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  const undoable = (c: ColumnConversion) =>
    c.status === 'done' && !!c.event_id && now - Date.parse(c.created_at) <= UNDO_WINDOW_DAYS * 86_400_000;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('convert.history.title', { name: column.title })}
      className="max-w-3xl!"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          {isAdmin && settings.data ? (
            <label className="flex items-center gap-2 text-[0.8125rem]">
              <span className="text-fg-2">{t('convert.retention')}</span>
              <PickerButton
                testId="convert-retention"
                label={t(`convert.retention.${settings.data.backup_days}`)}
                placeholder=""
                menuLabel={t('convert.retention')}
                items={CONVERT_BACKUP_DAYS.map((d) => ({
                  label: t(`convert.retention.${d}`),
                  checked: settings.data!.backup_days === d,
                  onSelect: () =>
                    void api(accountId)
                      .put('/conversions/settings', { backup_days: d })
                      .then(() => qc.invalidateQueries({ queryKey: ['account', accountId, 'conversion-settings'] })),
                }))}
              />
            </label>
          ) : (
            <span />
          )}
          <Button variant="ghost" onClick={onClose}>
            {t('convert.close')}
          </Button>
        </div>
      }
    >
      <div className="space-y-2" data-testid="convert-history">
        {list.isLoading ? null : !list.data?.data.length ? (
          <p className="text-[0.8125rem] text-muted">{t('convert.history.empty')}</p>
        ) : (
          list.data.data.map((c) => (
            <div
              key={c.id}
              data-testid="convert-history-row"
              data-status={c.status}
              className="rounded-[10px] border border-[var(--line)] p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-[0.8125rem]">
                <Badge tone={STATUS_TONE[c.status]}>{t(`convert.status.${c.status}`)}</Badge>
                <span className="font-medium text-heading">
                  {c.kind === 'restore' ? t('convert.history.restore') : ''}
                  {columnTypeLabel(c.from_type)} → {columnTypeLabel(c.to_type)}
                </span>
                <span className="text-muted">
                  {who(c.created_by)} · {formatDateTime(c.created_at)}
                </span>
                <span className="text-xs text-muted">
                  {t('convert.history.counts', {
                    converted: c.counts.converted,
                    failed: c.counts.failed,
                    empty: c.counts.empty,
                  })}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button size="sm" variant="ghost" onClick={() => setOpen(open === c.id ? null : c.id)}>
                  {t('convert.history.report')}
                </Button>
                {undoable(c) ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="convert-history-undo"
                    onClick={() =>
                      void undoAction(qc, accountId, c.event_id!).then(async (ok) => {
                        if (ok) await refresh();
                      })
                    }
                  >
                    {t('convert.history.undo')}
                  </Button>
                ) : null}
                {c.status === 'done' && c.backup ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-testid="convert-history-restore"
                    onClick={() => void askRestore(c.id)}
                  >
                    {t('convert.history.restoreBackup')}
                  </Button>
                ) : null}
                {c.failed_marked ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void clearFailed(accountId, board.id, c.id).then(refresh)}
                  >
                    {t('convert.clearMarks')}
                  </Button>
                ) : null}
              </div>
              {c.backup_until && c.backup ? (
                <p className="mt-1 text-xs text-muted">
                  {t('convert.history.backupUntil', { date: formatDateTime(c.backup_until) })}
                </p>
              ) : !c.backup ? (
                <p className="mt-1 text-xs text-muted">{t('convert.history.noBackup')}</p>
              ) : null}
              {open === c.id ? (
                <div className="mt-2">
                  <DependentsList dependents={c.dependents} />
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>
      {restore ? (
        <Dialog
          open
          onClose={() => setRestore(null)}
          title={t('convert.restore.title', { type: columnTypeLabel(restore.preview.to_type) })}
          footer={
            <div className="flex w-full justify-end gap-2">
              <Button variant="ghost" onClick={() => setRestore(null)}>
                {t('convert.cancel')}
              </Button>
              <Button data-testid="convert-restore-apply" onClick={() => void doRestore()}>
                {t('convert.restore.apply')}
              </Button>
            </div>
          }
        >
          <div className="space-y-3 text-[0.8125rem]" data-testid="convert-restore">
            <p>
              {t('convert.restore.counts', {
                converted: restore.preview.counts.converted,
                failed: restore.preview.counts.failed,
              })}
            </p>
            {restore.preview.changed_since ? (
              <Notice tone="warn">
                <div className="space-y-2">
                  <p>{t('convert.restore.changed', { n: restore.preview.changed_since })}</p>
                  <label className="flex items-center gap-2">
                    <Switch checked={restore.force} onChange={(on) => void askRestore(restore.id, on)} />
                    {t('convert.restore.force')}
                  </label>
                </div>
              </Notice>
            ) : null}
            <DependentsList dependents={restore.preview.dependents} />
          </div>
        </Dialog>
      ) : null}
    </Dialog>
  );
};
