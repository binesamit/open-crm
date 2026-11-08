// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { t, type BoardDetail, type MessageKey } from '@bines/shared';
import { Button, Dialog, Field, Input, Notice, Picker } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { useBoard, useWorkspaces } from '../board/board-api';
import { showToast } from '../../lib/toast';

const MODES = ['structure', 'items', 'items_updates'] as const;
type Mode = (typeof MODES)[number];

/** "שכפול הבורד" (07 §4.1): name, what to copy, keep subscribers — then open the copy. */
export const DuplicateBoardDialog = ({
  accountId,
  accountSlug,
  board,
  onClose,
}: {
  accountId: string;
  accountSlug: string;
  board: { id: string; name: string };
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState(t('boardCopy.defaultName', { name: board.name }));
  const [mode, setMode] = useState<Mode>('structure');
  const [keep, setKeep] = useState(false);
  // Into another Workspace (its root) — the source's by default.
  const workspaces = useWorkspaces(accountId).data?.data ?? [];
  const source = useBoard(accountId, board.id).data;
  const [workspaceId, setWorkspaceId] = useState<string | undefined>(undefined);
  const ws = workspaceId ?? source?.workspace_id;
  const copy = useMutation({
    mutationFn: () =>
      api(accountId).post<BoardDetail>(`/boards/${board.id}/duplicate`, {
        mode,
        name: name.trim(),
        keep_subscribers: keep,
        ...(ws && ws !== source?.workspace_id ? { workspace_id: ws } : {}),
      }),
    onSuccess: async (created) => {
      showToast({ message: t('boardCopy.done', { name: created.name }) });
      await qc.invalidateQueries({ queryKey: ['account', accountId] });
      onClose();
      await navigate({ to: '/a/$accountSlug/b/$boardId', params: { accountSlug, boardId: created.id } });
    },
  });
  return (
    <Dialog
      open
      title={t('boardCopy.title', { name: board.name })}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            data-testid="board-copy-confirm"
            disabled={!name.trim()}
            busy={copy.isPending}
            onClick={() => copy.mutate()}
          >
            {t('boardCopy.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="board-copy-dialog">
        <Field label={t('boardCopy.name')}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('boardCopy.mode')}>
          <Picker<Mode>
            testId="board-copy-mode"
            label={t('boardCopy.mode')}
            value={mode}
            onChange={setMode}
            options={MODES.map((m) => ({ value: m, label: t(`boardCopy.mode.${m}` as MessageKey) }))}
          />
        </Field>
        {workspaces.length > 1 ? (
          <Field label={t('move.workspace')}>
            <Picker<string>
              testId="board-copy-workspace"
              label={t('move.workspace')}
              value={ws ?? ''}
              onChange={setWorkspaceId}
              options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
            />
          </Field>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={keep} onChange={() => setKeep((v) => !v)} className="accent-[var(--check)]" />
          {t('boardCopy.keepSubscribers')}
        </label>
        {copy.isError ? <Notice tone="error">{errorMessage(copy.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};
