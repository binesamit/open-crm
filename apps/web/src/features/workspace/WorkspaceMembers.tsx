// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { t } from '@bines/shared';
import { Avatar, Badge, Button, Menu, Notice, SkeletonRows, useActionMenu } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { boardKeys, useMembers } from '../board/board-api';
import { EmailInvite, type EmailInviteResult } from './EmailInvite';

/** GET /workspaces/:id/members (fix6-server 3b). */
type WorkspaceMembersData = {
  kind: 'open' | 'closed';
  members: { user_id: string; name: string; email: string; role: 'owner' | 'member'; account_role: string }[];
  can_manage: boolean;
};

const membersKey = (accountId: string, workspaceId: string) =>
  ['account', accountId, 'workspace', workspaceId, 'members'] as const;

/**
 * A workspace's members (owner fix6-server 3b): who sees it when it is closed. Its editors add account members,
 * invite new people by email (they join on accepting) and remove members; everyone who sees it reads the list.
 */
export const WorkspaceMembers = ({ accountId, workspaceId }: { accountId: string; workspaceId: string }) => {
  const qc = useQueryClient();
  const key = membersKey(accountId, workspaceId);
  const list = useQuery({
    queryKey: key,
    queryFn: () => api(accountId).get<WorkspaceMembersData>(`/workspaces/${workspaceId}/members`),
  });
  const account = useMembers(accountId).data?.data ?? [];
  const addMenu = useActionMenu();
  const apply = async (data: WorkspaceMembersData) => {
    qc.setQueryData(key, data);
    await qc.invalidateQueries({ queryKey: boardKeys.workspaces(accountId) });
  };
  const add = useMutation({
    mutationFn: (userId: string) =>
      api(accountId).post<WorkspaceMembersData>(`/workspaces/${workspaceId}/members`, { user_ids: [userId] }),
    onSuccess: apply,
  });
  const remove = useMutation({
    mutationFn: (userId: string) =>
      api(accountId).delete<WorkspaceMembersData>(`/workspaces/${workspaceId}/members/${userId}`),
    onSuccess: apply,
  });

  const data = list.data;
  const outside = account.filter(
    (m) => m.status === 'active' && m.role !== 'guest' && !data?.members.some((x) => x.user_id === m.user_id),
  );
  const error = list.error ?? add.error ?? remove.error;

  return (
    <div className="space-y-2" data-testid="workspace-members">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-fg-2">
          {t('workspace.members')}
          {data ? <span className="ms-1.5 font-normal text-muted">{data.members.length}</span> : null}
        </h3>
        {data?.can_manage && outside.length ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              data-testid="workspace-add-member"
              aria-haspopup="menu"
              onClick={addMenu.fromTrigger}
            >
              <Icon name="plus" size={15} />
              {t('workspace.members.add')}
            </Button>
            <Menu
              at={addMenu.at}
              onClose={addMenu.close}
              label={t('workspace.members.add')}
              items={outside.map((m) => ({ label: m.name || m.email, onSelect: () => add.mutate(m.user_id) }))}
            />
          </>
        ) : null}
      </div>
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      {list.isPending ? (
        <SkeletonRows rows={2} label={t('app.loading')} />
      ) : data && data.members.length ? (
        <ul className="overflow-hidden rounded-[14px] border border-line">
          {data.members.map((m) => (
            <li
              key={m.user_id}
              className="flex items-center gap-2.5 border-b border-line-soft px-3 py-2 last:border-b-0"
              data-testid="workspace-member"
              data-email={m.email}
            >
              <Avatar name={m.name || m.email} size={26} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-bold text-fg">{m.name || m.email}</span>
                {m.name ? (
                  <span className="truncate text-end text-xs text-muted" dir="ltr">
                    {m.email}
                  </span>
                ) : null}
              </span>
              {m.role === 'owner' ? <Badge tone="violet">{t('workspace.members.owner')}</Badge> : null}
              {data.can_manage ? (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t('perm.remove', { name: m.name || m.email })}
                  title={t('perm.remove', { name: m.name || m.email })}
                  data-testid="workspace-member-remove"
                  className="w-8 shrink-0 px-0 text-muted hover:text-danger-fg"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(m.user_id)}
                >
                  <Icon name="x" size={15} />
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted" data-testid="workspace-members-empty">
          {t('workspace.members.none')}
        </p>
      )}
      {data?.can_manage ? (
        <div className="space-y-1.5 border-t border-line-soft pt-3">
          <h3 className="text-xs font-semibold text-fg-2">{t('perm.inviteByEmail')}</h3>
          <p className="text-xs text-muted">{t('workspace.members.inviteHint')}</p>
          <EmailInvite<EmailInviteResult & WorkspaceMembersData>
            accountId={accountId}
            path={`/workspaces/${workspaceId}/members`}
            testId="workspace-invite"
            roles={['admin', 'member', 'viewer']}
            defaultRole="member"
            onDone={(res) => {
              void apply({ kind: res.kind, members: res.members, can_manage: res.can_manage });
              // Account members added by email: the add-member menu and users lists change too.
              void qc.invalidateQueries({ queryKey: boardKeys.members(accountId) });
            }}
          />
        </div>
      ) : null}
    </div>
  );
};
