// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type OpsBoards,
  type OpsTaskTypeDto,
  type OpsTaskTypeInput,
  type SupportAgentConnections,
  type SupportAgentSettingsDto,
  t,
} from '@bines/shared';
import { Badge, Button, Field, Input, Picker, Switch } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { showToast } from '../../../lib/toast';
import { supportAgentKeys } from './SupportAgent';

/**
 * Errors & health → Settings → Support agent — tools → "Ops tasks": the types of task the agent may
 * propose for the operations team, each on a board (and group) of an account where the person setting it is an
 * admin. An approved proposal opens the task there. The owner and leads edit; everyone in the console reads.
 */
const FIRST_GROUP = '';

const toInput = (x: OpsTaskTypeDto): OpsTaskTypeInput => ({
  id: x.id,
  name: x.name,
  hint: x.hint,
  account_id: x.account_id,
  board_id: x.board_id,
  group_id: x.group_id,
  is_default: x.is_default,
});

export const OpsTaskTypes = ({ s }: { s: SupportAgentSettingsDto }) => {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<OpsTaskTypeDto | 'new' | null>(null);
  const save = useMutation({
    mutationFn: (list: OpsTaskTypeInput[]) =>
      api().patch<SupportAgentSettingsDto>('/platform/support-agent/settings', { ops_tasks: list }),
    onSuccess: (res) => {
      qc.setQueryData(supportAgentKeys.settings, res);
      showToast({ message: t('admin.general.saved') });
      setEditing(null);
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const list = s.ops_tasks.map(toInput);
  return (
    <section className="space-y-2" data-testid="support-agent-ops">
      <h4 className="text-xs text-fg-2">{t('supportAgent.ops.title')}</h4>
      <p className="text-xs text-muted">{t('supportAgent.ops.hint')}</p>
      {s.ops_tasks.length ? (
        <ul className="space-y-1.5">
          {s.ops_tasks.map((x) => (
            <li
              key={x.id}
              className="flex flex-wrap items-center gap-2 rounded-[8px] bg-surface-2 px-2.5 py-1.5 text-sm"
              data-testid="support-agent-ops-type"
            >
              <span className="flex-1">
                {x.name}
                <span className="block text-xs text-muted">
                  {x.missing
                    ? t('supportAgent.ops.missing')
                    : [x.account_name, x.board_name, x.group_name].filter(Boolean).join(' · ')}
                </span>
              </span>
              {x.is_default ? <Badge>{t('supportAgent.ops.default')}</Badge> : null}
              {x.missing ? <Badge tone="danger">{t('supportAgent.ops.missingBadge')}</Badge> : null}
              {s.can_edit ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(x)}>
                    {t('common.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={save.isPending}
                    onClick={() => save.mutate(list.filter((y) => y.id !== x.id))}
                    data-testid="support-agent-ops-remove"
                  >
                    {t('common.delete')}
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">{t('supportAgent.ops.none')}</p>
      )}
      {editing ? (
        <OpsTypeForm
          key={editing === 'new' ? 'new' : editing.id}
          current={editing === 'new' ? null : editing}
          busy={save.isPending}
          onCancel={() => setEditing(null)}
          onSave={(x) => {
            // One default: choosing this one clears the others.
            const rest = list.map((y) => (x.is_default ? { ...y, is_default: false } : y));
            save.mutate(x.id ? rest.map((y) => (y.id === x.id ? x : y)) : [...rest, x]);
          }}
        />
      ) : s.can_edit && s.ops_tasks.length < 20 ? (
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')} data-testid="support-agent-ops-add">
          {t('supportAgent.ops.add')}
        </Button>
      ) : null}
    </section>
  );
};

const OpsTypeForm = ({
  current,
  busy,
  onSave,
  onCancel,
}: {
  current: OpsTaskTypeDto | null;
  busy: boolean;
  onSave: (x: OpsTaskTypeInput) => void;
  onCancel: () => void;
}) => {
  const [name, setName] = useState(current?.name ?? '');
  const [hint, setHint] = useState(current?.hint ?? '');
  const [account, setAccount] = useState(current?.account_id ?? '');
  const [board, setBoard] = useState(current?.board_id ?? '');
  const [group, setGroup] = useState(current?.group_id ?? FIRST_GROUP);
  const [isDefault, setIsDefault] = useState(current?.is_default ?? false);
  const accounts = useQuery({
    queryKey: [...supportAgentKeys.all, 'connections'],
    queryFn: () => api().get<SupportAgentConnections>('/platform/support-agent/connections'),
  });
  const boards = useQuery({
    queryKey: [...supportAgentKeys.all, 'ops-boards', account],
    queryFn: () => api().get<OpsBoards>(`/platform/support-agent/ops-boards?account_id=${account}`),
    enabled: !!account,
  });
  const accountOptions = (accounts.data?.accounts ?? []).map((a) => ({
    value: a.id,
    label: a.name,
    testId: `support-agent-ops-account-${a.id}`,
  }));
  // A saved place in an account I am not an admin of stays as it is (shown by its names).
  if (current && !accountOptions.some((o) => o.value === current.account_id))
    accountOptions.push({ value: current.account_id, label: current.account_name || '—', testId: '' });
  const boardList = boards.data?.data ?? [];
  const boardOptions = boardList.map((b) => ({
    value: b.id,
    label: b.name,
    group: b.workspace,
    testId: `support-agent-ops-board-${b.id}`,
  }));
  if (current && board === current.board_id && !boardOptions.some((o) => o.value === board))
    boardOptions.push({ value: board, label: current.board_name || '—', group: '', testId: '' });
  const groups = boardList.find((b) => b.id === board)?.groups ?? [];
  const groupOptions = [
    { value: FIRST_GROUP, label: t('supportAgent.ops.firstGroup') },
    ...groups.map((g) => ({ value: g.id, label: g.name })),
  ];
  if (current && group && group === current.group_id && !groups.some((g) => g.id === group))
    groupOptions.push({ value: group, label: current.group_name ?? '—' });
  return (
    <div className="space-y-2 rounded-[10px] border border-line p-2.5" data-testid="support-agent-ops-form">
      <div className="flex flex-wrap gap-3">
        <Field label={t('supportAgent.ops.name')}>
          <Input
            className="w-48"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="support-agent-ops-name"
          />
        </Field>
        <Field label={t('supportAgent.ops.whenHint')} hint={t('supportAgent.ops.whenHintHelp')}>
          <Input
            className="w-80"
            value={hint}
            onChange={(e) => setHint(e.target.value)}
            data-testid="support-agent-ops-when"
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label={t('supportAgent.ops.account')} hint={t('supportAgent.ops.accountHint')}>
          <Picker
            label={t('supportAgent.ops.account')}
            className="w-56"
            value={account}
            onChange={(v) => {
              setAccount(v);
              setBoard('');
              setGroup(FIRST_GROUP);
            }}
            testId="support-agent-ops-account"
            options={[{ value: '', label: t('supportAgent.ops.choose'), disabled: true }, ...accountOptions]}
          />
        </Field>
        <Field label={t('supportAgent.ops.board')}>
          <Picker
            label={t('supportAgent.ops.board')}
            className="w-56"
            value={board}
            onChange={(v) => {
              setBoard(v);
              setGroup(FIRST_GROUP);
            }}
            testId="support-agent-ops-board"
            options={[{ value: '', label: t('supportAgent.ops.choose'), disabled: true }, ...boardOptions]}
          />
        </Field>
        <Field label={t('supportAgent.ops.group')}>
          <Picker
            label={t('supportAgent.ops.group')}
            className="w-48"
            value={group}
            onChange={setGroup}
            testId="support-agent-ops-group"
            options={groupOptions}
          />
        </Field>
      </div>
      <label className="flex items-center gap-3">
        <Switch
          checked={isDefault}
          onChange={setIsDefault}
          label={t('supportAgent.ops.makeDefault')}
          testId="support-agent-ops-default"
        />
        <span className="text-sm text-fg">{t('supportAgent.ops.makeDefault')}</span>
      </label>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="accent"
          busy={busy}
          disabled={!name.trim() || !account || !board}
          onClick={() =>
            onSave({
              ...(current ? { id: current.id } : {}),
              name: name.trim(),
              hint: hint.trim(),
              account_id: account,
              board_id: board,
              group_id: group || null,
              is_default: isDefault,
            })
          }
          data-testid="support-agent-ops-save"
        >
          {t('common.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};
