// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { t } from '@bines/shared';
import { Button, Dialog, Field, Segmented } from '@bines/ui';
import { useReadableBoards, useWorkspaces } from '../board/board-api';
import { BoardPickerDialog } from '../board/BoardPickerDialog';
import { PickerButton } from '../board/toolbar/parts';

/**
 * Where an installation works: the whole account, or chosen workspaces and / or chosen boards. A
 * workspace also covers boards added to it later.
 */
export type ExtScope = { mode: 'all' | 'chosen'; workspaceIds: string[]; boardIds: string[] };

export const scopeFrom = (v: { board_ids: string[] | null; workspace_ids?: string[] | null }): ExtScope => ({
  mode: v.board_ids || v.workspace_ids ? 'chosen' : 'all',
  workspaceIds: v.workspace_ids ?? [],
  boardIds: v.board_ids ?? [],
});

/** The API's shape: null lists = not limited by that kind; both null = the whole account. */
export const scopeToGrant = (s: ExtScope) =>
  s.mode === 'all'
    ? { board_ids: null, workspace_ids: null }
    : {
        board_ids: s.boardIds.length ? s.boardIds : null,
        workspace_ids: s.workspaceIds.length ? s.workspaceIds : null,
      };

/** "Chosen" with nothing chosen can't be saved. */
export const scopeIncomplete = (s: ExtScope) => s.mode === 'chosen' && !s.boardIds.length && !s.workspaceIds.length;

const Chip = ({ label, testId, onRemove }: { label: string; testId: string; onRemove: () => void }) => (
  <button
    type="button"
    className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs"
    title={t('ext.consent.removeBoard')}
    onClick={onRemove}
    data-testid={testId}
  >
    {label} ×
  </button>
);

/** Choose one workspace (those already chosen are not offered). */
const WorkspacePickerDialog = ({
  accountId,
  exclude,
  onClose,
  onPick,
}: {
  accountId: string;
  exclude: string[];
  onClose: () => void;
  onPick: (id: string) => void;
}) => {
  const workspaces = (useWorkspaces(accountId).data?.data ?? []).filter((w) => !exclude.includes(w.id));
  const [picked, setPicked] = useState('');
  const target = workspaces.find((w) => w.id === picked);
  return (
    <Dialog
      open
      title={t('ext.consent.addWorkspace')}
      onClose={onClose}
      className="max-w-md"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            data-testid="ext-workspace-picker-confirm"
            disabled={!target}
            onClick={() => {
              onPick(picked);
              onClose();
            }}
          >
            {t('ext.consent.addWorkspace')}
          </Button>
        </>
      }
    >
      <Field label={t('move.workspace')}>
        <PickerButton
          testId="ext-workspace-picker"
          menuLabel={t('move.workspace')}
          placeholder={t('move.workspace')}
          label={target?.name}
          items={workspaces.map((w) => ({ label: w.name, checked: w.id === picked, onSelect: () => setPicked(w.id) }))}
        />
      </Field>
    </Dialog>
  );
};

export const ScopePicker = ({
  accountId,
  value,
  onChange,
}: {
  accountId: string;
  value: ExtScope;
  onChange: (next: ExtScope) => void;
}) => {
  const workspaces = useWorkspaces(accountId).data?.data ?? [];
  const boards = useReadableBoards(accountId).data?.data ?? [];
  const [picking, setPicking] = useState<'workspace' | 'board' | null>(null);
  const wsName = (id: string) => workspaces.find((w) => w.id === id)?.name ?? '…';
  const boardName = (id: string) => boards.find((b) => b.id === id)?.name ?? '…';
  return (
    <div className="space-y-2" data-testid="ext-scope">
      <Segmented
        label={t('ext.consent.boards')}
        value={value.mode}
        onChange={(mode) => onChange({ ...value, mode })}
        options={[
          { value: 'all', label: t('ext.consent.boardsAll'), testId: 'ext-boards-all' },
          { value: 'chosen', label: t('ext.consent.boardsChosen'), testId: 'ext-boards-chosen' },
        ]}
      />
      {value.mode === 'chosen' ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {value.workspaceIds.map((id) => (
              <Chip
                key={id}
                label={t('ext.consent.workspaceChip', { name: wsName(id) })}
                testId={`ext-scope-ws-${id}`}
                onRemove={() => onChange({ ...value, workspaceIds: value.workspaceIds.filter((x) => x !== id) })}
              />
            ))}
            {value.boardIds.map((id) => (
              <Chip
                key={id}
                label={boardName(id)}
                testId={`ext-scope-board-${id}`}
                onRemove={() => onChange({ ...value, boardIds: value.boardIds.filter((x) => x !== id) })}
              />
            ))}
            <Button size="sm" variant="dashed" onClick={() => setPicking('workspace')} data-testid="ext-workspaces-add">
              {t('ext.consent.addWorkspace')}
            </Button>
            <Button size="sm" variant="dashed" onClick={() => setPicking('board')} data-testid="ext-boards-add">
              {t('ext.consent.addBoard')}
            </Button>
          </div>
          <p className="text-xs text-muted">{t('ext.consent.scopeHint')}</p>
        </>
      ) : null}
      {picking === 'workspace' ? (
        <WorkspacePickerDialog
          accountId={accountId}
          exclude={value.workspaceIds}
          onClose={() => setPicking(null)}
          onPick={(id) => onChange({ ...value, workspaceIds: [...value.workspaceIds, id] })}
        />
      ) : null}
      {picking === 'board' ? (
        <BoardPickerDialog
          accountId={accountId}
          title={t('ext.consent.addBoard')}
          confirmLabel={t('ext.consent.addBoard')}
          exclude={value.boardIds}
          onClose={() => setPicking(null)}
          onPick={async (b) => onChange({ ...value, boardIds: [...value.boardIds, b.id] })}
        />
      ) : null}
    </div>
  );
};

/** One line for the installed list: "the whole account" / "2 workspaces · 3 boards". */
export const scopeSummary = (v: { board_ids: string[] | null; workspace_ids?: string[] | null }) => {
  if (!v.board_ids && !v.workspace_ids) return t('ext.consent.boardsAll');
  return [
    v.workspace_ids
      ? v.workspace_ids.length === 1
        ? t('ext.admin.workspaces1')
        : t('ext.admin.workspacesN', { n: v.workspace_ids.length })
      : null,
    v.board_ids
      ? v.board_ids.length === 1
        ? t('ext.admin.boards1')
        : t('ext.admin.boardsN', { n: v.board_ids.length })
      : null,
  ]
    .filter(Boolean)
    .join(' · ');
};

/** Change where an installed extension works, in the app's own dialog. */
export const ScopeDialog = ({
  accountId,
  name,
  initial,
  onClose,
  onSave,
}: {
  accountId: string;
  name: string;
  initial: { board_ids: string[] | null; workspace_ids?: string[] | null };
  onClose: () => void;
  onSave: (grant: ReturnType<typeof scopeToGrant>) => Promise<unknown>;
}) => {
  const [scope, setScope] = useState(() => scopeFrom(initial));
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open
      title={t('ext.admin.scopeTitle', { name })}
      onClose={onClose}
      className="max-w-lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="accent"
            busy={busy}
            disabled={scopeIncomplete(scope)}
            data-testid="ext-scope-save"
            onClick={() => {
              setBusy(true);
              void onSave(scopeToGrant(scope))
                .then(onClose)
                .catch(() => undefined)
                .finally(() => setBusy(false));
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <ScopePicker accountId={accountId} value={scope} onChange={setScope} />
    </Dialog>
  );
};
