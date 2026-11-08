// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { formatDateTime, t, type MessageKey, type ScenarioDto } from '@bines/shared';
import { Button, Dialog, Spinner, Switch } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDialog, promptDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import type { BoardDetail } from '../board/board-api';
import type { FilterCtx } from '../board/toolbar/FilterPanel';
import { ScenarioEditor } from './ScenarioEditor';
import { useScenarioMutations, useScenarios } from './scenarios-api';

/**
 * phase 3 — a board's scenarios (the board's "more" menu): each with its switch, its last run and what stops
 * it; "new scenario" asks for a name and opens the editor. Beside the automations, independent of them.
 */
export const ScenariosDialog = ({
  accountId,
  board,
  filterCtx,
  onClose,
}: {
  accountId: string;
  board: BoardDetail;
  filterCtx: FilterCtx;
  onClose: () => void;
}) => {
  const list = useScenarios(accountId, board.id);
  const m = useScenarioMutations(accountId, board.id);
  const [editing, setEditing] = useState<string | null>(null);
  const canCreate = !!board.capabilities['automation.manage'];
  const scenarios = list.data ?? [];
  const current = scenarios.find((s) => s.id === editing);

  const create = async () => {
    const name = await promptDialog({
      title: t('scenario.newTitle'),
      label: t('scenario.name'),
      confirmLabel: t('scenario.create'),
    });
    if (!name?.trim()) return;
    try {
      const s = await m.create.mutateAsync({ name: name.trim() });
      setEditing(s.id);
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  const toggle = async (s: ScenarioDto, on: boolean) => {
    try {
      await m.setActive.mutateAsync({ id: s.id, active: on });
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  const remove = async (s: ScenarioDto) => {
    if (
      !(await confirmDialog({
        title: t('dialog.delete.title', { what: s.name }),
        message: t('scenario.deleteMessage'),
        danger: true,
      }))
    )
      return;
    m.remove.mutate(s.id);
  };

  if (current) {
    return (
      <ScenarioEditor
        accountId={accountId}
        board={board}
        filterCtx={filterCtx}
        scenario={current}
        onClose={() => setEditing(null)}
      />
    );
  }
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('scenario.listTitle')}
      subtitle={board.name}
      className="max-w-2xl!"
      footer={
        canCreate ? (
          <Button onClick={() => void create()} data-testid="scenario-new">
            <Icon name="plus" size={15} />
            {t('scenario.new')}
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3" data-testid="scenarios-dialog">
        <p className="text-sm text-muted">{t('scenario.listHint')}</p>
        {list.isLoading ? <Spinner label={t('app.loading')} /> : null}
        {!list.isLoading && !scenarios.length ? (
          <p className="rounded-[12px] border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
            {t('scenario.none')}
          </p>
        ) : null}
        <ul className="flex flex-col gap-2">
          {scenarios.map((s) => (
            <li
              key={s.id}
              className="flex items-center gap-3 rounded-[12px] border border-line px-3.5 py-2.5"
              data-testid="scenario-row"
            >
              <Switch
                checked={s.is_active}
                disabled={!s.can_manage || (!s.is_active && s.issues.length > 0)}
                onChange={(on) => void toggle(s, on)}
                label={t('scenario.active')}
                testId="scenario-row-active"
              />
              <button
                type="button"
                onClick={() => setEditing(s.id)}
                className="flex min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 text-start"
                data-testid="scenario-open"
              >
                <span className="truncate text-sm text-fg">{s.name}</span>
                <span className="text-xs text-muted">
                  {s.issues.length
                    ? t('scenario.hasIssues', { n: s.issues.length })
                    : s.deactivated_reason
                      ? t(`scenario.off.${s.deactivated_reason}` as MessageKey)
                      : s.last_run
                        ? t('scenario.lastRun', {
                            status: t(`scenario.status.${s.last_run.status}` as MessageKey),
                            date: formatDateTime(s.last_run.created_at),
                          })
                        : t('scenario.neverRan')}
                </span>
              </button>
              {s.can_manage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('common.delete')}
                  title={t('common.delete')}
                  className="w-8 px-0 text-muted"
                  onClick={() => void remove(s)}
                >
                  <Icon name="trash" size={15} />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
};
