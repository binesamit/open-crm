// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { t } from '@bines/shared';
import { Button, Dialog, Field } from '@bines/ui';
import { useTree, useWorkspaces } from './board-api';
import { PickerButton } from './toolbar/parts';

/** Choose a board (Workspace → board): copy a view to it, duplicate into it… `exclude` = boards not offered. */
export const BoardPickerDialog = ({
  accountId,
  title,
  confirmLabel,
  workspaceId,
  exclude = [],
  onClose,
  onPick,
}: {
  accountId: string;
  title: string;
  confirmLabel: string;
  /** The Workspace shown first. */
  workspaceId?: string;
  exclude?: string[];
  onClose: () => void;
  onPick: (board: { id: string; name: string }) => Promise<unknown>;
}) => {
  const workspaces = useWorkspaces(accountId).data?.data ?? [];
  const [wsId, setWsId] = useState<string | undefined>(workspaceId);
  const ws = wsId ?? workspaces[0]?.id;
  const tree = useTree(accountId, ws).data;
  const boards = (tree?.boards ?? []).filter((b) => !exclude.includes(b.id));
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const target = boards.find((b) => b.id === targetId);

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await onPick(target);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="board-picker-confirm" disabled={!target} busy={busy} onClick={() => void submit()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="board-picker">
        {workspaces.length > 1 ? (
          <Field label={t('move.workspace')}>
            <PickerButton
              testId="board-picker-workspace"
              menuLabel={t('move.workspace')}
              placeholder={t('move.workspace')}
              label={workspaces.find((w) => w.id === ws)?.name}
              items={workspaces.map((w) => ({
                label: w.name,
                checked: w.id === ws,
                onSelect: () => {
                  setWsId(w.id);
                  setTargetId('');
                },
              }))}
            />
          </Field>
        ) : null}
        <Field label={t('move.board')}>
          <PickerButton
            testId="board-picker-board"
            menuLabel={t('move.board')}
            placeholder={t('move.pickBoard')}
            label={target?.name}
            items={boards.map((b) => ({
              label: b.name,
              checked: b.id === targetId,
              onSelect: () => setTargetId(b.id),
            }))}
          />
        </Field>
      </div>
    </Dialog>
  );
};
