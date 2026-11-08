// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type BoardSecretUpdates,
  type MyAccount,
  type SecretUpdateSettings,
  secretUpdateSettingsOf,
  t,
} from '@bines/shared';
import { Button, Dialog, Notice, Segmented, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { Panel } from '../admin/admin-parts';
import {
  fieldsOf,
  fieldsValid,
  type SecretFields,
  SecretSettingsFields,
  settingsOfFields,
} from './SecretSettingsFields';
import { useSecretStepUp } from './step-up';

/**
 * Settings of secret updates — all in the UI: the account's default (Administration → Security) and a
 * board's own override (the board's ⋯ menu; its subitems follow it). The same fields as a secret column, plus
 * whether people may write secret updates at all. Every change takes a fresh two-factor code (the server asks; the
 * step-up dialog takes it and the change is sent again).
 */
type AccountRef = { id: string; slug: string };

const toSettings = (f: SecretFields): SecretUpdateSettings => secretUpdateSettingsOf(settingsOfFields(f));

const accountKey = (accountId: string) => ['account', accountId, 'secret-update-settings'] as const;
const boardKey = (accountId: string, boardId: string) => ['account', accountId, 'board', boardId, 'secret-updates'];

/** Administration → Security → Secret updates: the account's default (admins). */
export const SecretUpdatesPanel = ({ account }: { account: MyAccount }) => {
  const qc = useQueryClient();
  const current = useQuery({
    queryKey: accountKey(account.id),
    queryFn: () => api(account.id).get<{ settings: SecretUpdateSettings }>('/secrets/update-settings'),
  });
  return (
    <Panel title={t('secretUpdates.settings.title')} hint={t('secretUpdates.settings.hint')} testId="secret-updates">
      <div className="p-3.5">
        {current.isError ? <Notice tone="error">{errorMessage(current.error)}</Notice> : null}
        {current.data ? (
          <AccountForm
            account={account}
            initial={current.data.settings}
            onSaved={(settings) => {
              qc.setQueryData(accountKey(account.id), { settings });
              // Every board that follows the account changes with it.
              void qc.invalidateQueries({
                predicate: (q) => q.queryKey.includes('secret-updates') && q.queryKey[0] === 'account',
              });
            }}
          />
        ) : current.isPending ? (
          <SkeletonRows rows={3} label={t('app.loading')} />
        ) : null}
      </div>
    </Panel>
  );
};

const AccountForm = ({
  account,
  initial,
  onSaved,
}: {
  account: MyAccount;
  initial: SecretUpdateSettings;
  onSaved: (s: SecretUpdateSettings) => void;
}) => {
  const [fields, setFields] = useState(() => fieldsOf(initial));
  const stepUp = useSecretStepUp(account);
  const save = useMutation({
    mutationFn: () =>
      stepUp.run(
        () =>
          api(account.id).put<{ settings: SecretUpdateSettings }>('/secrets/update-settings', {
            settings: toSettings(fields),
          }),
        { change: true },
      ),
    onSuccess: (res) => {
      if (!res) return;
      onSaved(res.settings);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  return (
    <div className="flex flex-col gap-3.5" data-testid="secret-updates-account">
      <Notice tone="warn">{t('secretUpdates.settings.about')}</Notice>
      <SecretSettingsFields accountId={account.id} value={fields} onChange={setFields} kind="updates" />
      <p className="text-xs text-muted">{t('secretUpdates.settings.codeHint')}</p>
      <div className="flex justify-end">
        <Button
          busy={save.isPending}
          disabled={!fieldsValid(fields)}
          onClick={() => save.mutate()}
          data-testid="secret-updates-save"
        >
          {t('common.save')}
        </Button>
      </div>
      {stepUp.dialog}
    </div>
  );
};

/** The board's ⋯ menu → Secret updates: follow the account's default, or the board's own settings. */
export const BoardSecretUpdatesDialog = ({
  account,
  boardId,
  onClose,
}: {
  account: AccountRef;
  boardId: string;
  onClose: () => void;
}) => {
  const current = useQuery({
    queryKey: boardKey(account.id, boardId),
    queryFn: () => api(account.id).get<BoardSecretUpdates>(`/boards/${boardId}/secret-updates`),
  });
  return (
    <Dialog open onClose={onClose} title={t('secretUpdates.board.title')} className="max-w-xl">
      {current.isError ? <Notice tone="error">{errorMessage(current.error)}</Notice> : null}
      {current.data ? (
        <BoardForm account={account} boardId={boardId} data={current.data} onClose={onClose} />
      ) : current.isPending ? (
        <SkeletonRows rows={4} label={t('app.loading')} />
      ) : null}
    </Dialog>
  );
};

const BoardForm = ({
  account,
  boardId,
  data,
  onClose,
}: {
  account: AccountRef;
  boardId: string;
  data: BoardSecretUpdates;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const [own, setOwn] = useState(!!data.board);
  const [fields, setFields] = useState(() => fieldsOf(data.board ?? data.account));
  const stepUp = useSecretStepUp(account);
  const readOnly = !data.can_manage;
  const save = useMutation({
    mutationFn: () =>
      stepUp.run(
        () =>
          api(account.id).put<BoardSecretUpdates>(`/boards/${boardId}/secret-updates`, {
            settings: own ? toSettings(fields) : null,
          }),
        { change: true },
      ),
    onSuccess: (res) => {
      if (!res) return;
      qc.setQueryData(boardKey(account.id, boardId), res);
      showToast({ message: t('admin.general.saved') });
      onClose();
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  return (
    <div className="flex flex-col gap-3.5" data-testid="secret-updates-board">
      {readOnly ? <Notice>{t('secretUpdates.board.readOnly')}</Notice> : null}
      <Segmented
        label={t('secretUpdates.board.title')}
        value={own ? 'own' : 'account'}
        testId="secret-updates-source"
        onChange={(v) => !readOnly && setOwn(v === 'own')}
        options={[
          { value: 'account', label: t('secretUpdates.board.inherit'), testId: 'secret-updates-inherit' },
          { value: 'own', label: t('secretUpdates.board.own'), testId: 'secret-updates-own' },
        ]}
      />
      {own ? (
        <SecretSettingsFields
          accountId={account.id}
          value={fields}
          onChange={setFields}
          kind="updates"
          disabled={readOnly}
        />
      ) : (
        <div
          className="flex flex-col gap-1 rounded-[10px] bg-surface-2 p-3 text-sm"
          data-testid="secret-updates-inherited"
        >
          <span>{data.account.enabled ? t('secretUpdates.board.stateOn') : t('secretUpdates.board.stateOff')}</span>
          <span className="text-xs text-muted">{t('secretUpdates.board.inheritHint')}</span>
        </div>
      )}
      <p className="text-xs text-muted">{t('secretUpdates.board.subitemsHint')}</p>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        {readOnly ? null : (
          <Button
            busy={save.isPending}
            disabled={own && !fieldsValid(fields)}
            onClick={() => save.mutate()}
            data-testid="secret-updates-board-save"
          >
            {t('common.save')}
          </Button>
        )}
      </div>
      {stepUp.dialog}
    </div>
  );
};
