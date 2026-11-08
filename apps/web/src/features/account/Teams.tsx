// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t, type MyAccount, type Team } from '@bines/shared';
import { Avatar, avatarColor, Button, Card, Dialog, Menu, MenuTrigger, Notice, useActionMenu } from '@bines/ui';
import { api, errorMessage, type Member, queryKeys } from '../../lib/api';
import { confirmDelete, promptDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { useWindowedRows } from '../../lib/use-windowed-rows';

/**
 * Teams (05 §7): everyone but guests sees them; admins create, rename, set members and delete. A team can be
 * assigned in people cells, and counts as "mine" in filters and in board item visibility.
 */
export const Teams = ({ account }: { account: MyAccount }) => {
  const qc = useQueryClient();
  const client = api(account.id);
  const isAdmin = account.role === 'admin';
  const key = ['account', account.id, 'teams'];
  const teams = useQuery({ queryKey: key, queryFn: () => client.get<{ data: Team[] }>('/teams') });
  const members = useQuery({
    queryKey: queryKeys.members(account.id),
    queryFn: () => client.get<{ data: Member[] }>('/users'),
  });
  const [editing, setEditing] = useState<Team | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: key });
  const save = useMutation({
    mutationFn: (v: { id?: string; name?: string; member_ids?: string[] }) =>
      v.id ? client.patch<Team>(`/teams/${v.id}`, v) : client.post<Team>('/teams', v),
    onSuccess: refresh,
  });
  const remove = useMutation({ mutationFn: (id: string) => client.delete(`/teams/${id}`), onSuccess: refresh });
  const people = members.data?.data.filter((m) => m.status === 'active') ?? [];

  const create = async () => {
    const name = await promptDialog({
      title: t('teams.new'),
      label: t('teams.name'),
      confirmLabel: t('dialog.create'),
    });
    if (name) save.mutate({ name });
  };

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-display text-[1rem] leading-snug font-extrabold text-heading">{t('teams.title')}</h2>
        {isAdmin ? (
          <Button variant="secondary" size="sm" onClick={() => void create()} data-testid="team-new">
            <Icon name="plus" size={14} strokeWidth={2} />
            {t('teams.new')}
          </Button>
        ) : null}
      </div>
      {save.isError || remove.isError ? <Notice tone="error">{errorMessage(save.error ?? remove.error)}</Notice> : null}
      {teams.data && !teams.data.data.length ? <p className="text-sm text-muted">{t('teams.empty')}</p> : null}
      {teams.data?.data.length ? (
        <ul className="overflow-hidden rounded-[14px] border border-line">
          {teams.data.data.map((team) => (
            <TeamRow
              key={team.id}
              team={team}
              canEdit={isAdmin}
              onRename={async () => {
                const name = await promptDialog({
                  title: t('teams.rename'),
                  label: t('teams.name'),
                  initial: team.name,
                });
                if (name && name !== team.name) save.mutate({ id: team.id, name });
              }}
              onMembers={() => setEditing(team)}
              onDelete={() => void confirmDelete(team.name).then((ok) => ok && remove.mutate(team.id))}
            />
          ))}
        </ul>
      ) : null}
      {editing ? (
        <TeamMembersDialog
          team={editing}
          people={people}
          onClose={() => setEditing(null)}
          onSave={(member_ids) => save.mutateAsync({ id: editing.id, member_ids })}
        />
      ) : null}
    </Card>
  );
};

const TeamRow = ({
  team,
  canEdit,
  onRename,
  onMembers,
  onDelete,
}: {
  team: Team;
  canEdit: boolean;
  onRename: () => void;
  onMembers: () => void;
  onDelete: () => void;
}) => {
  const menu = useActionMenu();
  const label = t('teams.actions', { name: team.name });
  return (
    <li
      className="group flex items-center gap-3 border-b border-line-soft bg-surface px-3 py-2.5 last:border-b-0"
      data-testid="team-row"
      data-name={team.name}
    >
      <span
        aria-hidden
        style={{ backgroundColor: avatarColor(team.name) }}
        className="grid size-7 shrink-0 place-items-center rounded-[9px] text-[0.6875rem] font-semibold text-white"
      >
        {team.name.trim().charAt(0).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1 truncate font-semibold">{team.name}</span>
      <span className="shrink-0 text-xs text-muted">{t('teams.count', { n: team.member_ids.length })}</span>
      {canEdit ? (
        <>
          <MenuTrigger
            label={label}
            onClick={menu.fromTrigger}
            className="grid size-8 place-items-center rounded-[10px] text-base text-fg-2 opacity-100"
          />
          <Menu
            at={menu.at}
            onClose={menu.close}
            label={label}
            items={[
              { label: t('teams.members'), onSelect: onMembers },
              { label: t('teams.rename'), onSelect: onRename },
              { kind: 'separator' },
              { label: t('teams.delete'), danger: true, onSelect: onDelete },
            ]}
          />
        </>
      ) : null}
    </li>
  );
};

const TeamMembersDialog = ({
  team,
  people,
  onClose,
  onSave,
}: {
  team: Team;
  people: Member[];
  onClose: () => void;
  onSave: (ids: string[]) => Promise<unknown>;
}) => {
  const [ids, setIds] = useState(team.member_ids);
  const [busy, setBusy] = useState(false);
  // Hundreds of people: the checklist mounts only the rows in view of its scroll box.
  const { attach, measure, ...windowed } = useWindowedRows<HTMLDivElement>({
    count: people.length,
    estimate: 34,
    getKey: (i) => people[i]!.user_id,
    scroll: 'self',
  });
  return (
    <Dialog
      open
      title={`${t('teams.members')} — ${team.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            data-testid="team-members-save"
            busy={busy}
            onClick={() => {
              setBusy(true);
              void onSave(ids).then(onClose, () => setBusy(false));
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div ref={attach} className="max-h-72 overflow-auto" data-testid="team-members">
        {windowed.before ? <div aria-hidden style={{ height: windowed.before }} /> : null}
        {windowed.rows
          .map((v) => [v, people[v.index]!] as const)
          .map(([v, m]) => (
            <label
              key={v.key}
              ref={measure}
              data-index={v.index}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2"
            >
              <input
                type="checkbox"
                checked={ids.includes(m.user_id)}
                onChange={() =>
                  setIds((x) => (x.includes(m.user_id) ? x.filter((y) => y !== m.user_id) : [...x, m.user_id]))
                }
                className="accent-[var(--check)]"
              />
              <Avatar name={m.name || m.email} url={m.avatar_url} size={24} />
              <span className="min-w-0 flex-1 truncate">{m.name || m.email}</span>
            </label>
          ))}
        {windowed.after ? <div aria-hidden style={{ height: windowed.after }} /> : null}
      </div>
    </Dialog>
  );
};
