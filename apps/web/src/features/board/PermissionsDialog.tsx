// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BOARD_ROLES,
  type BoardPermissions,
  type BoardRole,
  type DeleteGuard,
  type MessageKey,
  PERMISSION_SETS,
  t,
} from '@bines/shared';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  Menu,
  Notice,
  Picker,
  RadioCard,
  scrollBehavior,
  Segmented,
  SkeletonRows,
  Switch,
  useActionMenu,
} from '@bines/ui';
import { Icon, type IconName } from '../../lib/icons';
import { api, errorMessage } from '../../lib/api';
import { type BoardDetail, useMembers, useTeams } from './board-api';
import { EmailInvite, type EmailInviteResult } from '../workspace/EmailInvite';
import { PickerButton } from './toolbar/parts';
import { stepUpRequest } from '../secrets/step-up';
import { VerifyWindowField } from '../secrets/SecretSettingsFields';

type Set = (typeof PERMISSION_SETS)[number];
type Subscription = { role: 'owner' | 'subscriber'; level: BoardRole | null };
/** One picker value per subscription: owner, "per the set", or an explicit (lower) role. */
type Choice = 'owner' | 'set' | BoardRole;

const SET_ROLE: Record<Set, BoardRole> = {
  edit_everything: 'editor',
  edit_content: 'contributor',
  edit_assigned: 'assigned_contributor',
  view_comment: 'viewer',
};
const KIND_ICON: Record<BoardDetail['kind'], IconName> = { main: 'building', private: 'lock', shareable: 'people' };
/** Section label (F4 `.lbl`). */
const Label = ({ children }: { children: string }) => <h3 className="text-xs font-semibold text-fg-2">{children}</h3>;
const listCls = 'overflow-hidden rounded-[14px] border border-line';
const rowCls = 'flex items-center gap-3 border-b border-line-soft px-3 py-2 last:border-b-0';

const choiceOf = (s: Subscription): Choice => (s.role === 'owner' ? 'owner' : (s.level ?? 'set'));
const subscriptionOf = (c: Choice): Subscription =>
  c === 'owner' ? { role: 'owner', level: null } : { role: 'subscriber', level: c === 'set' ? null : c };

/** Owner / per the set / the roles below what the set gives (an explicit role only lowers it — 05 §4). */
const SubscriptionPicker = ({
  set,
  value,
  label,
  disabled,
  onChange,
}: {
  set: Set;
  value: Subscription;
  label: string;
  disabled: boolean;
  onChange: (s: Subscription) => void;
}) => {
  const lower = BOARD_ROLES.slice(BOARD_ROLES.indexOf(SET_ROLE[set]) + 1);
  // A stored role the set has since lowered past still shows (it has no effect until the set rises again).
  const levels = value.level && !lower.includes(value.level) ? [value.level, ...lower] : lower;
  return (
    <div className="w-[190px] shrink-0 max-sm:w-36">
      <Picker<Choice>
        className="h-8"
        label={label}
        value={choiceOf(value)}
        onChange={(c) => !disabled && onChange(subscriptionOf(c))}
        options={[
          { value: 'owner', label: t('perm.role.owner') },
          { value: 'set', label: t('perm.role.set') },
          ...levels.map((l) => ({ value: l, label: t(`perm.level.${l}` as MessageKey) })),
        ]}
      />
    </div>
  );
};

/**
 * Board permissions (05 §4–6): what non-owners may do (the set), which items they see, owners and subscribers,
 * and owner-only columns. Owners and admins change it; everyone else reads it.
 */
export const PermissionsDialog = ({
  accountId,
  board,
  onClose,
}: {
  accountId: string;
  board: BoardDetail;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const client = api(accountId);
  const key = ['account', accountId, 'board', board.id, 'permissions'];
  const perms = useQuery({
    queryKey: key,
    queryFn: () => client.get<BoardPermissions>(`/boards/${board.id}/permissions`),
  });
  const members = useMembers(accountId).data?.data.filter((m) => m.status === 'active') ?? [];
  const teams = useTeams(accountId).data?.data ?? [];
  const apply = (p: BoardPermissions) => {
    qc.setQueryData(key, p);
    // Rights and visible items/columns may have changed for this viewer.
    void qc.invalidateQueries({ queryKey: ['account', accountId, 'board', board.id] });
  };
  const mut = useMutation({
    // while deleting takes a code, changing that asks for the code too.
    mutationFn: (v: { method: 'put' | 'post' | 'delete'; path: string; body?: unknown }) =>
      stepUpRequest(accountId, () =>
        v.method === 'delete'
          ? client.delete<BoardPermissions>(v.path)
          : client[v.method]<BoardPermissions>(v.path, v.body),
      ),
    onSuccess: apply,
  });
  // Board type ("change board type"): guests join only shareable boards.
  const kind = useMutation({
    mutationFn: (k: BoardDetail['kind']) => client.patch(`/boards/${board.id}`, { kind: k }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account', accountId] }),
  });
  const p = perms.data;
  const can = !!p?.can_manage;
  const people = board.columns.filter((c) => c.type === 'people');
  const putPerms = (body: unknown) => mut.mutate({ method: 'put', path: `/boards/${board.id}/permissions`, body });
  const outside = members.filter((m) => !p?.members.some((x) => x.user_id === m.user_id));
  const outsideTeams = teams.filter((x) => !p?.teams.some((s) => s.team_id === x.id));
  const addMember = useActionMenu();
  const inviteRef = useRef<HTMLElement>(null);
  const removeBtn = (label: string, onClick: () => void) => (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      className="w-8 shrink-0 px-0 text-muted hover:text-danger-fg"
      onClick={onClick}
    >
      <Icon name="x" size={15} />
    </Button>
  );

  return (
    <Dialog
      open
      title={t('perm.title', { name: board.name })}
      onClose={onClose}
      className="max-w-[720px]"
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <div className="flex flex-col gap-3.5" data-testid="permissions-dialog">
        {perms.isPending ? <SkeletonRows rows={6} label={t('app.loading')} /> : null}
        {mut.isError ? <Notice tone="error">{errorMessage(mut.error)}</Notice> : null}
        {p && !p.has_active_owner ? (
          <Notice tone="error">
            <span className="flex flex-wrap items-center justify-between gap-2">
              {t('perm.noOwner')}
              {can ? (
                <Button
                  data-testid="perm-claim"
                  onClick={() => mut.mutate({ method: 'post', path: `/boards/${board.id}/claim` })}
                >
                  {t('perm.claim')}
                </Button>
              ) : null}
            </span>
          </Notice>
        ) : null}
        {p ? (
          <>
            <section className="flex flex-col gap-1.5">
              <Label>{t('perm.kind')}</Label>
              <Segmented<BoardDetail['kind']>
                testId="perm-kind"
                label={t('perm.kind')}
                className="self-start"
                value={board.kind}
                onChange={(k) => can && k !== board.kind && kind.mutate(k)}
                options={(['main', 'private', 'shareable'] as const).map((k) => ({
                  value: k,
                  label: t(`perm.kind.short.${k}` as MessageKey),
                  icon: <Icon name={KIND_ICON[k]} size={14} />,
                  testId: `perm-kind-${k}`,
                }))}
              />
              {kind.isError ? <Notice tone="error">{errorMessage(kind.error)}</Notice> : null}
              <p className="text-xs text-muted">{t(`perm.kind.desc.${board.kind}` as MessageKey)}</p>
            </section>

            <section className="flex flex-col gap-1.5">
              <Label>{t('perm.set')}</Label>
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t('perm.set')}>
                {PERMISSION_SETS.map((s: Set) => (
                  <RadioCard
                    key={s}
                    name={`perm-set-${board.id}`}
                    checked={p.permission_set === s}
                    disabled={!can}
                    testId={`perm-set-${s}`}
                    onSelect={() => putPerms({ permission_set: s })}
                    title={t(`perm.set.${s}` as MessageKey)}
                    hint={t(`perm.set.${s}.hint` as MessageKey)}
                  />
                ))}
              </div>
            </section>

            <section className="flex flex-col gap-1.5">
              <Label>{t('perm.viewItems')}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  testId="perm-view-items"
                  label={t('perm.viewItems')}
                  value={p.view_items.mode}
                  onChange={(mode) => can && putPerms({ view_items: { mode, column_ids: p.view_items.column_ids } })}
                  options={[
                    { value: 'all', label: t('perm.viewItems.all') },
                    { value: 'assigned_or_created', label: t('perm.viewItems.assigned') },
                  ]}
                />
                {p.view_items.mode === 'assigned_or_created' && people.length > 1 ? (
                  <PickerButton
                    menuLabel={t('perm.viewItems.columns')}
                    placeholder={t('perm.viewItems.anyPeople')}
                    label={
                      p.view_items.column_ids === 'any_people'
                        ? t('perm.viewItems.anyPeople')
                        : people
                            .filter((c) => (p.view_items.column_ids as string[]).includes(c.id))
                            .map((c) => c.title)
                            .join(', ')
                    }
                    items={[
                      {
                        label: t('perm.viewItems.anyPeople'),
                        checked: p.view_items.column_ids === 'any_people',
                        onSelect: () =>
                          can && putPerms({ view_items: { mode: 'assigned_or_created', column_ids: 'any_people' } }),
                      },
                      ...people.map((c) => ({
                        label: c.title,
                        checked: Array.isArray(p.view_items.column_ids) && p.view_items.column_ids.includes(c.id),
                        onSelect: () =>
                          can && putPerms({ view_items: { mode: 'assigned_or_created', column_ids: [c.id] } }),
                      })),
                    ]}
                  />
                ) : null}
              </div>
            </section>

            {/* deleting / archiving items takes a two-factor code (off by default). */}
            <DeleteGuardSection
              key={JSON.stringify(p.delete_guard)}
              guard={p.delete_guard}
              disabled={!can || mut.isPending}
              onSave={(delete_guard) => putPerms({ delete_guard })}
            />

            <section className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>{t('perm.members')}</Label>
                {board.capabilities['board.invite'] ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    {outside.length ? (
                      <>
                        <Button
                          variant="secondary"
                          size="sm"
                          data-testid="perm-add-member"
                          aria-haspopup="menu"
                          onClick={addMember.fromTrigger}
                        >
                          <Icon name="plus" size={15} />
                          {t('perm.addMember')}
                        </Button>
                        <Menu
                          at={addMember.at}
                          onClose={addMember.close}
                          label={t('perm.addMember')}
                          items={outside.map((m) => ({
                            label: m.name || m.email,
                            onSelect: () =>
                              mut.mutate({
                                method: 'put',
                                path: `/boards/${board.id}/members/${m.user_id}`,
                                body: { role: 'subscriber' },
                              }),
                          }))}
                        />
                      </>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        inviteRef.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
                        inviteRef.current?.querySelector<HTMLElement>('input, textarea')?.focus();
                      }}
                    >
                      <Icon name="mail" size={15} />
                      {t('perm.inviteByEmail')}
                    </Button>
                  </span>
                ) : null}
              </div>
              {p.members.length ? (
                <ul className={listCls}>
                  {p.members.map((m) => (
                    <li key={m.user_id} className={rowCls} data-testid="perm-member" data-email={m.email}>
                      <Avatar name={m.name || m.email} size={28} />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-bold text-fg">{m.name || m.email}</span>
                        {m.name && m.email ? (
                          <span className="truncate text-end text-xs text-muted" dir="ltr">
                            {m.email}
                          </span>
                        ) : null}
                      </span>
                      <SubscriptionPicker
                        set={p.permission_set}
                        value={m}
                        label={t('perm.role')}
                        disabled={!can}
                        onChange={(body) =>
                          mut.mutate({ method: 'put', path: `/boards/${board.id}/members/${m.user_id}`, body })
                        }
                      />
                      {can
                        ? removeBtn(t('perm.remove', { name: m.name || m.email }), () =>
                            mut.mutate({ method: 'delete', path: `/boards/${board.id}/members/${m.user_id}` }),
                          )
                        : null}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>

            {board.capabilities['board.invite'] ? (
              <section
                ref={inviteRef}
                className="flex flex-col gap-1.5"
                data-testid="perm-invite"
                data-tour="board.invite"
              >
                <Label>{t('perm.inviteByEmail')}</Label>
                <p className="text-xs text-muted">{t('perm.inviteByEmail.hint')}</p>
                {/* fix6: people already in the account are subscribed at once; new people on accepting (and a
                    board in a closed workspace takes them into the workspace too). */}
                <EmailInvite<EmailInviteResult & { permissions: BoardPermissions }>
                  key={board.kind}
                  accountId={accountId}
                  path={`/boards/${board.id}/invite`}
                  testId="perm-invite-form"
                  roles={
                    board.kind === 'shareable' ? ['admin', 'member', 'viewer', 'guest'] : ['admin', 'member', 'viewer']
                  }
                  defaultRole={board.kind === 'shareable' ? 'guest' : 'member'}
                  note={board.kind !== 'shareable' ? t('members.guestsNeedShareable') : null}
                  onDone={(res) => apply(res.permissions)}
                />
              </section>
            ) : null}

            <section className="flex flex-col gap-1.5">
              <Label>{t('perm.teams')}</Label>
              <p className="text-xs text-muted">{t('perm.teams.hint')}</p>
              {p.teams.length ? (
                <ul className={listCls}>
                  {p.teams.map((x) => (
                    <li key={x.team_id} className={rowCls} data-testid="perm-team" data-name={x.name}>
                      <Avatar name={x.name} size={28} />
                      <span className="min-w-0 flex-1 truncate font-bold text-fg">{x.name}</span>
                      <SubscriptionPicker
                        set={p.permission_set}
                        value={x}
                        label={t('perm.role')}
                        disabled={!can}
                        onChange={(body) =>
                          mut.mutate({ method: 'put', path: `/boards/${board.id}/teams/${x.team_id}`, body })
                        }
                      />
                      {can
                        ? removeBtn(t('perm.remove', { name: x.name }), () =>
                            mut.mutate({ method: 'delete', path: `/boards/${board.id}/teams/${x.team_id}` }),
                          )
                        : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              {board.capabilities['board.invite'] && outsideTeams.length ? (
                <PickerButton
                  className="self-start"
                  testId="perm-add-team"
                  menuLabel={t('perm.addTeam')}
                  placeholder={`+ ${t('perm.addTeam')}`}
                  items={outsideTeams.map((x) => ({
                    label: x.name,
                    onSelect: () =>
                      mut.mutate({
                        method: 'put',
                        path: `/boards/${board.id}/teams/${x.id}`,
                        body: { role: 'subscriber' },
                      }),
                  }))}
                />
              ) : null}
            </section>

            <ColumnRestrictions
              board={board}
              perms={p}
              can={can}
              members={members}
              teams={teams}
              onPut={(columnId, body) =>
                mut.mutate({ method: 'put', path: `/boards/${board.id}/columns/${columnId}/restriction`, body })
              }
            />
            <Notice>{t('perm.readOnly')}</Notice>
          </>
        ) : null}
      </div>
    </Dialog>
  );
};

type Restriction = { kind: 'edit' | 'view' | null; users: string[]; teams: string[] };
const KINDS = ['edit', 'view'] as const;

/**
 * Restricted columns (N15): only the columns that have a restriction — its kind and who besides the owners may
 * use it. "+ הגבלה" picks a column, then the kind; "who" is chosen on the row. The kind chip changes or removes it.
 */
const ColumnRestrictions = ({
  board,
  perms: p,
  can,
  members,
  teams,
  onPut,
}: {
  board: BoardDetail;
  perms: BoardPermissions;
  can: boolean;
  members: { user_id: string; name: string; email: string }[];
  teams: { id: string; name: string }[];
  onPut: (columnId: string, body: Restriction) => void;
}) => {
  const add = useActionMenu();
  const kindMenu = useActionMenu();
  const [kindFor, setKindFor] = useState<string | null>(null);
  const restricted = p.column_restrictions.filter((r) => board.columns.some((c) => c.id === r.column_id));
  const free = board.columns.filter(
    (c) => c.type !== 'name' && !p.column_restrictions.some((r) => r.column_id === c.id),
  );
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const current = kindFor ? p.column_restrictions.find((r) => r.column_id === kindFor) : undefined;

  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label>{t('perm.columns')}</Label>
        {can && free.length ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              aria-haspopup="menu"
              data-testid="perm-add-restriction"
              onClick={add.fromTrigger}
            >
              <Icon name="plus" size={14} />
              {t('perm.columns.add')}
            </Button>
            <Menu
              at={add.at}
              onClose={add.close}
              label={t('perm.columns.add')}
              items={[
                { kind: 'label', label: t('perm.columns.pick') },
                ...free.map((c) => ({
                  kind: 'submenu' as const,
                  label: c.title,
                  items: KINDS.map((k) => ({
                    label: t(`perm.columns.${k}` as MessageKey),
                    onSelect: () => onPut(c.id, { kind: k, users: [], teams: [] }),
                  })),
                })),
              ]}
            />
          </>
        ) : null}
      </div>
      {restricted.length ? (
        <ul className={listCls}>
          {restricted.map((r) => {
            const column = board.columns.find((c) => c.id === r.column_id)!;
            const allowedNames = [
              ...teams.filter((x) => r.teams.includes(x.id)).map((x) => x.name),
              ...members.filter((m) => r.users.includes(m.user_id)).map((m) => m.name || m.email),
            ];
            const who = allowedNames.length
              ? t('perm.columns.ownersAnd', { names: allowedNames.join(', ') })
              : t('perm.columns.ownersOnly');
            const kindLabel = t(`perm.columns.${r.kind}` as MessageKey);
            return (
              <li
                key={r.column_id}
                className={`${rowCls} flex-wrap`}
                data-testid="perm-column"
                data-title={column.title}
                data-kind={r.kind}
              >
                <span className="min-w-0 flex-1 truncate font-bold text-fg">{column.title}</span>
                {can ? (
                  <button
                    type="button"
                    aria-haspopup="menu"
                    aria-label={`${column.title}: ${kindLabel}`}
                    data-testid="perm-column-kind"
                    className="rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
                    onClick={(e) => {
                      setKindFor(r.column_id);
                      kindMenu.fromTrigger(e);
                    }}
                  >
                    <Badge tone="warn">{kindLabel}</Badge>
                  </button>
                ) : (
                  <Badge tone="warn">{kindLabel}</Badge>
                )}
                {can ? (
                  <PickerButton
                    testId="perm-column-allowed"
                    menuLabel={t('perm.columns.allowed')}
                    placeholder={t('perm.columns.ownersOnly')}
                    label={who}
                    className="h-8 max-w-56 border-transparent bg-transparent text-xs text-muted"
                    items={[
                      ...teams.map((x) => ({
                        label: x.name,
                        checked: r.teams.includes(x.id),
                        onSelect: () =>
                          onPut(r.column_id, { kind: r.kind, users: r.users, teams: toggle(r.teams, x.id) }),
                      })),
                      ...members.map((m) => ({
                        label: m.name || m.email,
                        checked: r.users.includes(m.user_id),
                        onSelect: () =>
                          onPut(r.column_id, { kind: r.kind, users: toggle(r.users, m.user_id), teams: r.teams }),
                      })),
                    ]}
                  />
                ) : (
                  <span className="max-w-56 truncate text-xs text-muted" data-testid="perm-column-allowed">
                    {who}
                  </span>
                )}
                {can ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('perm.columns.remove', { column: column.title })}
                    title={t('perm.columns.remove', { column: column.title })}
                    className="w-8 shrink-0 px-0 text-muted hover:text-danger-fg"
                    data-testid="perm-column-remove"
                    onClick={() => onPut(r.column_id, { kind: null, users: [], teams: [] })}
                  >
                    <Icon name="x" size={15} />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-xs text-muted" data-testid="perm-columns-empty">
          {t('perm.columns.empty')}
        </p>
      )}
      <Menu
        at={kindMenu.at}
        onClose={kindMenu.close}
        label={t('perm.columns')}
        items={
          current
            ? [
                ...KINDS.map((k) => ({
                  label: t(`perm.columns.${k}` as MessageKey),
                  checked: current.kind === k,
                  onSelect: () => onPut(current.column_id, { kind: k, users: current.users, teams: current.teams }),
                })),
                { kind: 'separator' as const },
                {
                  label: t('perm.columns.removeShort'),
                  icon: <Icon name="x" />,
                  danger: true,
                  onSelect: () => onPut(current.column_id, { kind: null, users: [], teams: [] }),
                },
              ]
            : []
        }
      />
    </section>
  );
};

/**
 * "deleting takes a verification code" — the switch, and how long one code counts (the same window as
 * secrets; never past the account's ceiling). The switch saves at once; a new window saves with its button.
 */
const DeleteGuardSection = ({
  guard,
  disabled,
  onSave,
}: {
  guard: DeleteGuard;
  disabled: boolean;
  onSave: (g: DeleteGuard) => void;
}) => {
  const [minutes, setMinutes] = useState(String(guard.verify_minutes));
  const n = Number(minutes);
  const valid = Number.isInteger(n) && n >= 1 && n <= 720;
  return (
    <section className="flex flex-col gap-1.5" data-testid="perm-delete-guard">
      <Label>{t('perm.deleteGuard')}</Label>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={guard.enabled}
          disabled={disabled}
          onChange={(enabled) => onSave({ ...guard, enabled })}
          testId="perm-delete-guard-switch"
        />
        {t('perm.deleteGuard.switch')}
      </label>
      <p className="text-xs text-muted">{t('perm.deleteGuard.hint')}</p>
      {guard.enabled ? (
        <div className="flex items-end gap-2">
          <VerifyWindowField
            label={t('secret.settings.minutes')}
            value={minutes}
            onChange={setMinutes}
            testId="perm-delete-guard-minutes"
            disabled={disabled}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={disabled || !valid || n === guard.verify_minutes}
            onClick={() => onSave({ ...guard, verify_minutes: n })}
            data-testid="perm-delete-guard-save"
          >
            {t('common.save')}
          </Button>
        </div>
      ) : null}
    </section>
  );
};
