// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  accountRoleSchema,
  formatDateTime,
  t,
  type AccountRole,
  type BulkUsers,
  type MyAccount,
  tDynamic,
} from '@bines/shared';
import {
  Avatar,
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  EmptyState,
  Menu,
  MenuTrigger,
  Notice,
  Picker,
  SkeletonRows,
  useActionMenu,
  type MenuEntry,
} from '@bines/ui';
import { errorMessage, fetchMe, type Invitation, type Member, queryKeys } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { confirmDialog } from '../../../lib/dialogs';
import { downloadFrom } from '../../../lib/download';
import { showToast } from '../../../lib/toast';
import { InviteForm } from '../../account/InviteForm';
import { InvitationSettingsCard } from './InvitationSettings';
import { CopyLinkField, reasonMessage } from '../../account/CopyLink';
import {
  InvitationActions,
  type InvitationHandlers,
  InvitationLinkDialog,
  InvitationRowBody,
} from '../../account/Invitations';
import { useWindowedRows } from '../../../lib/use-windowed-rows';
import { Ago, SearchBox, TD, TH, TR, useNarrow } from '../../trash/TrashPage';
import { DeleteDetailsDialog, displayName, EditUserDialog, roleLabel, TransferDialog } from './UserDialogs';
import {
  useAdminInvitations,
  useAdminMembers,
  useAdminTeams,
  useDefaultTransfer,
  useUsersMutations,
} from './users-api';

type Mutations = ReturnType<typeof useUsersMutations>;
type StatusFilter = 'all' | 'active' | 'deactivated';
type Open =
  | { kind: 'edit'; member: Member }
  | { kind: 'deactivate'; member: Member }
  | { kind: 'transfer'; member: Member }
  | { kind: 'delete'; member: Member }
  | { kind: 'invite' }
  | { kind: 'link'; title: string; subtitle: string; url: string; note: string; testId: string }
  | null;

/** Selection keys: people `u:<user id>`, pending invitations `i:<invitation id>`. */
const userKey = (id: string) => `u:${id}`;
const inviteKey = (id: string) => `i:${id}`;

const roleTone = (role: AccountRole) => (role === 'admin' ? 'ok' : role === 'guest' ? 'violet' : 'neutral');

const StatusBadge = ({ member }: { member: Member }) => (
  <span className="inline-flex items-center gap-1">
    <MemberStatus member={member} />
    {member.erasure_requested_at && !member.anonymised ? (
      // Privacy: the person asked for their details to be deleted — deactivate, then delete details.
      <span
        title={t('adminUsers.erasureRequested.hint', { date: formatDateTime(member.erasure_requested_at) })}
        data-testid="admin-user-erasure-requested"
      >
        <Badge tone="warn">{t('adminUsers.erasureRequested')}</Badge>
      </span>
    ) : null}
  </span>
);

const MemberStatus = ({ member }: { member: Member }) =>
  member.anonymised ? (
    <Badge tone="danger">{t('adminUsers.status.anonymised')}</Badge>
  ) : member.status === 'deactivated' ? (
    <Badge>{t('adminUsers.status.deactivated')}</Badge>
  ) : member.status === 'invited' ? (
    <Badge tone="info">{t('adminUsers.status.invited')}</Badge>
  ) : (
    <Badge tone="ok">{t('adminUsers.status.active')}</Badge>
  );

const Teams = ({ member }: { member: Member }) => {
  const teams = member.teams ?? [];
  if (!teams.length) return <span className="text-muted">—</span>;
  return (
    <span className="flex items-center gap-1">
      {teams.slice(0, 2).map((team) => (
        <Badge key={team.id}>{team.name}</Badge>
      ))}
      {teams.length > 2 ? <span className="text-xs text-muted">+{teams.length - 2}</span> : null}
    </span>
  );
};

const Check = ({
  checked,
  onChange,
  label,
  testId,
  indeterminate,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  testId: string;
  indeterminate?: boolean;
}) => (
  <input
    type="checkbox"
    checked={checked}
    onChange={onChange}
    aria-label={label}
    data-testid={testId}
    ref={(el) => {
      if (el) el.indeterminate = !!indeterminate;
    }}
    className="size-4 shrink-0 cursor-pointer accent-[var(--check)]"
  />
);

/**
 * Administration → users (08 §3, account admin A2; product decision 2026-10-04): the account's people with search and filters
 * (role, status, team), inline role, edit, deactivate (transfer first) / activate, transfer ownership, delete details,
 * multi-select with a batch bar, pending invitations, invite and CSV export. The default "transfer to" member is
 * set at the top.
 */
export const UsersAdminPage = ({ account }: { account: MyAccount }) => {
  const narrow = useNarrow();
  const [now] = useState(() => Date.now());
  const members = useAdminMembers(account.id);
  const invitations = useAdminInvitations(account.id);
  const teams = useAdminTeams(account.id);
  const defaultTransfer = useDefaultTransfer(account.id);
  const m = useUsersMutations(account.id);
  const [q, setQ] = useState('');
  const [role, setRole] = useState<AccountRole | 'all'>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [team, setTeam] = useState('all');
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [open, setOpen] = useState<Open>(null);
  const [sort, setSort] = useState<Sort | null>(null);
  // My row: never my own role or membership (the API refuses too). /auth/me is already cached by the app shell.
  const meId = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe, staleTime: 60_000 }).data?.user.id ?? null;

  // Search, filters and sorting run over the whole list; only the rendering is windowed (below).
  const all = useMemo(() => members.data?.data ?? [], [members.data]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = all.filter(
      (u) =>
        (role === 'all' || u.role === role) &&
        (status === 'all' || u.status === status) &&
        (team === 'all' || u.teams?.some((x) => x.id === team)) &&
        (!needle || `${u.name} ${u.email} ${u.title ?? ''} ${u.department ?? ''}`.toLowerCase().includes(needle)),
    );
    return sort ? sortMembers(list, sort) : list;
  }, [all, q, role, status, team, sort]);
  const pending = invitations.data?.data ?? [];
  const { attach, measure, ...windowed } = useWindowedRows<HTMLElement>({
    count: rows.length,
    estimate: narrow ? NARROW_ROW_PX : ROW_PX,
    getKey: (i) => rows[i]!.user_id,
    scroll: 'page',
  });

  if (account.role !== 'admin')
    return (
      <div data-testid="admin-users">
        <Notice tone="info">{t('adminUsers.adminsOnly')}</Notice>
      </div>
    );

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const rowKeys = rows.map((u) => userKey(u.user_id));
  const pickedRows = rowKeys.filter((k) => selected.has(k)).length;
  const toggleAll = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      const on = pickedRows < rowKeys.length;
      for (const k of rowKeys) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });

  const exportCsv = () =>
    void downloadFrom(account.id, '/users/export.csv', `users-${account.slug}.csv`).catch((err: unknown) =>
      showToast({ message: errorMessage(err), tone: 'error' }),
    );

  const ctx: RowCtx = {
    account,
    mutations: m,
    meId,
    now,
    selected,
    toggle,
    open: setOpen,
  };

  return (
    <div data-testid="admin-users" className="flex flex-col gap-4 pb-24">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="font-display text-[1.625rem] leading-tight font-extrabold tracking-[-0.5px] text-heading max-md:text-2xl">
            {t('members.title')}
          </h1>
          <p className="max-w-[640px] text-sm text-muted">{t('adminUsers.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={exportCsv} data-testid="users-export">
            <Icon name="download" size={15} />
            {t('adminUsers.export')}
          </Button>
          <Button
            variant="accent"
            onClick={() => setOpen({ kind: 'invite' })}
            data-testid="users-invite-open"
            data-tour="admin.invite"
          >
            <Icon name="plus" size={15} />
            {t('members.invite')}
          </Button>
        </div>
      </header>

      <DefaultTransferPicker
        members={all}
        value={defaultTransfer.data?.user_id ?? null}
        loading={defaultTransfer.isPending}
        mutations={m}
      />

      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} label={t('adminUsers.search')} />
        <FilterPicker
          testId="users-filter-role"
          label={t('adminUsers.filter.role')}
          value={role}
          onChange={setRole}
          options={[
            { value: 'all', label: t('adminUsers.filter.allRoles') },
            ...accountRoleSchema.options.map((r) => ({ value: r, label: roleLabel(r) })),
          ]}
        />
        <FilterPicker<StatusFilter>
          testId="users-filter-status"
          label={t('adminUsers.filter.status')}
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: t('adminUsers.filter.allStatuses') },
            { value: 'active', label: t('adminUsers.status.active') },
            { value: 'deactivated', label: t('adminUsers.status.deactivated') },
          ]}
        />
        <FilterPicker
          testId="users-filter-team"
          label={t('adminUsers.filter.team')}
          value={team}
          onChange={setTeam}
          options={[
            { value: 'all', label: t('adminUsers.filter.allTeams') },
            ...(teams.data?.data ?? []).map((x) => ({ value: x.id, label: x.name })),
          ]}
        />
        <span className="ms-auto text-xs text-muted" data-testid="users-count">
          {t('adminUsers.count', { n: rows.length, total: all.length })}
        </span>
      </div>

      {members.isPending ? <SkeletonRows rows={5} label={t('app.loading')} /> : null}
      {members.isError ? <Notice tone="error">{errorMessage(members.error)}</Notice> : null}
      {members.data && !rows.length ? (
        <EmptyState icon={<Icon name="people" size={28} />} title={t('adminUsers.empty')} testId="users-empty" />
      ) : null}

      {rows.length && narrow ? (
        <ul ref={attach} className="overflow-hidden rounded-[14px] border border-line" data-testid="users-list">
          {windowed.before ? <li aria-hidden style={{ height: windowed.before }} /> : null}
          {windowed.rows.map((v) => (
            <UserRow key={v.key} member={rows[v.index]!} index={v.index} measure={measure} ctx={ctx} narrow />
          ))}
          {windowed.after ? <li aria-hidden style={{ height: windowed.after }} /> : null}
        </ul>
      ) : rows.length ? (
        <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={cn(TH, 'w-10')}>
                  <Check
                    checked={pickedRows > 0 && pickedRows === rowKeys.length}
                    indeterminate={pickedRows > 0 && pickedRows < rowKeys.length}
                    onChange={toggleAll}
                    label={t('adminUsers.selectAll')}
                    testId="users-select-all"
                  />
                </th>
                <SortTh by="name" sort={sort} onSort={setSort} />
                <SortTh by="role" sort={sort} onSort={setSort} />
                <th className={TH}>{t('adminUsers.col.title')}</th>
                <th className={TH}>{t('adminUsers.col.teams')}</th>
                <SortTh by="lastSeen" sort={sort} onSort={setSort} />
                <SortTh by="status" sort={sort} onSort={setSort} />
                <th className={cn(TH, 'w-10')} />
              </tr>
            </thead>
            <tbody ref={attach} data-testid="users-list">
              {windowed.before ? (
                <tr aria-hidden style={{ height: windowed.before }}>
                  <td colSpan={COLS} className="p-0" />
                </tr>
              ) : null}
              {windowed.rows.map((v) => (
                <UserRow key={v.key} member={rows[v.index]!} index={v.index} measure={measure} ctx={ctx} />
              ))}
              {windowed.after ? (
                <tr aria-hidden style={{ height: windowed.after }}>
                  <td colSpan={COLS} className="p-0" />
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      <PendingInvitations
        list={pending}
        loading={invitations.isPending}
        selected={selected}
        toggle={toggle}
        mutations={m}
      />

      <InvitationSettingsCard account={account} />

      <UsersBatchBar selected={selected} members={all} clear={() => setSelected(new Set())} mutations={m} meId={meId} />

      {open?.kind === 'invite' ? (
        <Dialog open onClose={() => setOpen(null)} title={t('members.invite')}>
          <InviteForm accountId={account.id} />
        </Dialog>
      ) : null}
      {open?.kind === 'link' ? (
        <Dialog open onClose={() => setOpen(null)} title={open.title} subtitle={open.subtitle}>
          <div className="space-y-3" data-testid={open.testId}>
            <CopyLinkField url={open.url} testId={`${open.testId}-field`} />
            <p className="text-xs text-muted">{open.note}</p>
          </div>
        </Dialog>
      ) : null}
      {open?.kind === 'edit' ? (
        <EditUserDialog
          member={open.member}
          isSelf={open.member.user_id === meId}
          mutations={m}
          onClose={() => setOpen(null)}
        />
      ) : null}
      {open?.kind === 'deactivate' || open?.kind === 'transfer' ? (
        <TransferDialog
          member={open.member}
          members={all}
          defaultTransferId={defaultTransfer.data?.user_id ?? null}
          mode={open.kind}
          mutations={m}
          onClose={() => {
            m.deactivate.reset();
            m.transfer.reset();
            setOpen(null);
          }}
        />
      ) : null}
      {open?.kind === 'delete' ? (
        <DeleteDetailsDialog
          member={open.member}
          mutations={m}
          onClose={() => {
            m.deleteDetails.reset();
            setOpen(null);
          }}
        />
      ) : null}
    </div>
  );
};

type RowCtx = {
  account: MyAccount;
  mutations: Mutations;
  meId: string | null;
  now: number;
  selected: Set<string>;
  toggle: (key: string) => void;
  open: (o: Open) => void;
};

/** Row heights the window starts from (rows are measured as they render). */
const ROW_PX = 53;
const NARROW_ROW_PX = 86;
const INVITE_ROW_PX = 64;
const COLS = 8;

type SortKey = 'name' | 'role' | 'lastSeen' | 'status';
type Sort = { by: SortKey; dir: 'asc' | 'desc' };
const SORT_LABEL: Record<SortKey, string> = {
  name: 'adminUsers.col.name',
  role: 'adminUsers.col.role',
  lastSeen: 'adminUsers.col.lastSeen',
  status: 'adminUsers.col.status',
};
const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
const statusRank = (u: Member) => (u.anonymised ? 3 : u.status === 'active' ? 0 : u.status === 'invited' ? 1 : 2);
/** Ascending order per column; members without a value (never seen) go last either way. */
const SORT_CMP: Record<SortKey, (a: Member, b: Member) => number> = {
  name: (a, b) => collator.compare(displayName(a), displayName(b)),
  role: (a, b) => accountRoleSchema.options.indexOf(a.role) - accountRoleSchema.options.indexOf(b.role),
  lastSeen: (a, b) => (a.last_seen_at ?? '').localeCompare(b.last_seen_at ?? ''),
  status: (a, b) => statusRank(a) - statusRank(b),
};
const sortMembers = (list: Member[], sort: Sort) => {
  const cmp = SORT_CMP[sort.by];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...list].sort((a, b) => {
    if (sort.by === 'lastSeen' && !a.last_seen_at !== !b.last_seen_at) return a.last_seen_at ? -1 : 1;
    return sign * cmp(a, b) || collator.compare(displayName(a), displayName(b));
  });
};

/** A sortable column header: first click ascending, then descending, then back to the list's own order. */
const SortTh = ({ by, sort, onSort }: { by: SortKey; sort: Sort | null; onSort: (s: Sort | null) => void }) => {
  const dir = sort?.by === by ? sort.dir : null;
  const label = tDynamic(SORT_LABEL[by]);
  return (
    <th
      className={cn(TH, 'group/th')}
      aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}
    >
      <button
        type="button"
        data-testid={`users-sort-${by}`}
        title={t('adminUsers.sortBy', { col: label })}
        onClick={() => onSort(dir === null ? { by, dir: 'asc' } : dir === 'asc' ? { by, dir: 'desc' } : null)}
        className={cn('inline-flex items-center gap-1 rounded hover:text-fg', dir && 'text-fg')}
      >
        {label}
        <Icon
          name="chevronDown"
          size={12}
          className={cn(!dir && 'opacity-0 group-hover/th:opacity-60', dir === 'asc' && 'rotate-180')}
        />
      </button>
    </th>
  );
};

const FilterPicker = <V extends string>(props: {
  value: V;
  options: { value: V; label: string }[];
  onChange: (v: V) => void;
  label: string;
  testId: string;
}) => <Picker {...props} className="h-9 w-[150px] max-md:flex-1" />;

/** "משתמש ברירת מחדל להעברה" — offered first whenever someone is deactivated (product decision 2026-10-04). */
const DefaultTransferPicker = ({
  members,
  value,
  loading,
  mutations,
}: {
  members: Member[];
  value: string | null;
  loading: boolean;
  mutations: Mutations;
}) => {
  const options = [
    { value: '', label: t('adminUsers.defaultTransfer.none') },
    ...members
      .filter((x) => x.status === 'active' && (x.role === 'admin' || x.role === 'member'))
      .map((x) => ({ value: x.user_id, label: displayName(x) })),
  ];
  return (
    <Card soft className="flex flex-wrap items-center gap-3 py-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-surface text-heading">
        <Icon name="person" size={18} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-semibold text-heading">{t('adminUsers.defaultTransfer.title')}</span>
        <span className="text-xs text-muted">{t('adminUsers.defaultTransfer.hint')}</span>
      </span>
      <div className="w-[220px] max-md:w-full">
        <Picker
          label={t('adminUsers.defaultTransfer.title')}
          value={loading ? '' : (value ?? '')}
          testId="users-default-transfer"
          onChange={(v) =>
            mutations.setDefaultTransfer.mutate(v || null, {
              onSuccess: () => showToast({ message: t('adminUsers.saved') }),
              onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
            })
          }
          options={options}
        />
      </div>
    </Card>
  );
};

/** One person: a table row on desktop, a list card on a phone. */
const UserRow = ({
  member: u,
  index,
  measure,
  ctx,
  narrow,
}: {
  member: Member;
  /** Position in the (filtered, sorted) list and the window's measuring ref. */
  index: number;
  measure: (el: Element | null) => void;
  ctx: RowCtx;
  narrow?: boolean;
}) => {
  const menu = useActionMenu();
  const m = ctx.mutations;
  const isSelf = u.user_id === ctx.meId;
  const key = userKey(u.user_id);
  const off = u.status === 'deactivated';
  const fail = (err: unknown) => showToast({ message: errorMessage(err), tone: 'error' });
  const changeRole = (role: AccountRole) =>
    role !== u.role &&
    m.setRole.mutate(
      { id: u.user_id, role },
      {
        onSuccess: () => showToast({ message: t('adminUsers.roleChanged', { name: displayName(u) }) }),
        onError: fail,
      },
    );

  const items: MenuEntry[] = [
    {
      label: t('adminUsers.menu.edit'),
      icon: <Icon name="edit" size={16} />,
      testId: 'user-menu-edit',
      onSelect: () => ctx.open({ kind: 'edit', member: u }),
    },
    ...(!isSelf && !u.anonymised
      ? [
          {
            kind: 'submenu' as const,
            label: t('adminUsers.menu.role'),
            icon: <Icon name="shield" size={16} />,
            testId: 'user-menu-role',
            items: accountRoleSchema.options.map((r) => ({
              label: roleLabel(r),
              checked: r === u.role,
              onSelect: () => changeRole(r),
            })),
          },
        ]
      : []),
    ...(!isSelf && u.status === 'active' && !u.anonymised
      ? [
          {
            label: t('adminUsers.menu.recoveryLink'),
            icon: <Icon name="key" size={16} />,
            testId: 'user-menu-recovery-link',
            onSelect: () =>
              m.recoveryLink.mutate(u.user_id, {
                onSuccess: (link) =>
                  ctx.open({
                    kind: 'link',
                    title: t('adminUsers.recovery.title'),
                    subtitle: `${displayName(u)} · ${u.email}`,
                    url: link.url,
                    note: t('adminUsers.recovery.note'),
                    testId: 'recovery-link-dialog',
                  }),
                onError: (err) => showToast({ message: reasonMessage(err), tone: 'error' }),
              }),
          },
        ]
      : []),
    // Privacy: a member's access request — their data in this account, as one JSON file (audited).
    ...(u.email.endsWith('@anon.invalid')
      ? []
      : [
          {
            label: t('privacy.memberData.export'),
            icon: <Icon name="download" size={16} />,
            testId: 'user-menu-export-data',
            onSelect: () =>
              void downloadFrom(
                ctx.account.id,
                `/users/${u.user_id}/export`,
                `member-data-${displayName(u).replace(/[^\p{L}\p{N}._-]+/gu, '_')}.json`,
              ).catch(fail),
          },
        ]),
    // M8 ד12: a member who lost their authenticator and backup codes — the admin turns 2FA off (audited).
    ...(!isSelf && u.status === 'active' && u.two_factor_enabled
      ? [
          {
            label: t('sec2.users.reset'),
            icon: <Icon name="lock" size={16} />,
            testId: 'user-menu-reset-2fa',
            onSelect: () =>
              void confirmDialog({
                title: t('sec2.users.resetConfirm', { name: displayName(u) }),
                message: t('sec2.users.resetHint'),
                confirmLabel: t('sec2.users.reset'),
                danger: true,
              }).then(
                (ok) =>
                  ok &&
                  m.resetTwoFactor.mutate(u.user_id, {
                    onSuccess: () => showToast({ message: t('sec2.users.resetDone', { name: displayName(u) }) }),
                    onError: (err) => showToast({ message: reasonMessage(err), tone: 'error' }),
                  }),
              ),
          },
        ]
      : []),
    ...(!isSelf && u.status === 'active'
      ? [
          {
            label: t('adminUsers.menu.transfer'),
            icon: <Icon name="move" size={16} />,
            testId: 'user-menu-transfer',
            onSelect: () => ctx.open({ kind: 'transfer', member: u }),
          },
          { kind: 'separator' as const },
          {
            label: t('adminUsers.menu.deactivate'),
            icon: <Icon name="lock" size={16} />,
            danger: true,
            testId: 'user-menu-deactivate',
            onSelect: () => ctx.open({ kind: 'deactivate', member: u }),
          },
        ]
      : []),
    ...(off && !u.anonymised
      ? [
          {
            label: t('adminUsers.menu.transfer'),
            icon: <Icon name="move" size={16} />,
            testId: 'user-menu-transfer',
            onSelect: () => ctx.open({ kind: 'transfer', member: u }),
          },
          {
            label: t('adminUsers.menu.activate'),
            icon: <Icon name="restore" size={16} />,
            testId: 'user-menu-activate',
            onSelect: () =>
              m.activate.mutate(u.user_id, {
                onSuccess: () => showToast({ message: t('adminUsers.activated', { name: displayName(u) }) }),
                onError: fail,
              }),
          },
          { kind: 'separator' as const },
          {
            label: t('adminUsers.menu.deleteDetails'),
            icon: <Icon name="trash" size={16} />,
            danger: true,
            testId: 'user-menu-delete-details',
            onSelect: () => ctx.open({ kind: 'delete', member: u }),
          },
        ]
      : []),
  ];

  const name = (
    // A deactivated user: a grey avatar and the secondary ink — not faded (opacity broke the 4.5:1 contrast, audit
    // 2026-10-10 /).
    <span className="flex min-w-0 items-center gap-2.5" data-off={off || undefined}>
      <Avatar name={displayName(u)} url={u.avatar_url} size={30} className={off ? 'grayscale' : undefined} />
      <span className="flex min-w-0 flex-col">
        <span className={cn('truncate font-semibold', off ? 'text-fg-2' : 'text-fg')}>
          {displayName(u)}
          {isSelf ? <span className="ms-1.5 text-xs font-normal text-muted">({t('adminUsers.you')})</span> : null}
          {u.two_factor_enabled ? (
            <span className="ms-1.5 align-middle" title={t('sec2.users.badgeHint')} data-testid="user-2fa">
              <Badge tone="ok">2FA</Badge>
            </span>
          ) : null}
        </span>
        <span className="truncate text-start text-[0.6875rem] text-muted [unicode-bidi:isolate]" dir="ltr">
          {u.email}
        </span>
      </span>
    </span>
  );
  const rolePicker =
    isSelf || u.anonymised ? (
      <Badge tone={roleTone(u.role)}>{roleLabel(u.role)}</Badge>
    ) : (
      <Picker
        label={t('adminUsers.roleOf', { name: displayName(u) })}
        value={u.role}
        onChange={changeRole}
        testId="user-role"
        className="h-8 w-[130px]"
        options={accountRoleSchema.options.map((r) => ({ value: r, label: roleLabel(r) }))}
      />
    );
  const lastSeen = u.last_seen_at ? <Ago iso={u.last_seen_at} now={ctx.now} /> : <span className="text-muted">—</span>;
  const check = (
    <Check
      checked={ctx.selected.has(key)}
      onChange={() => ctx.toggle(key)}
      label={t('adminUsers.select', { name: displayName(u) })}
      testId="user-select"
    />
  );
  const actions = (
    <>
      <MenuTrigger
        label={t('adminUsers.actionsFor', { name: displayName(u) })}
        onClick={menu.fromTrigger}
        className={narrow ? 'opacity-100' : undefined}
      />
      <Menu at={menu.at} onClose={menu.close} items={items} label={displayName(u)} />
    </>
  );
  const common = {
    'data-testid': 'user-row',
    'data-user-id': u.user_id,
    'data-email': u.email,
    'data-status': u.status,
    'data-index': index,
    ref: measure,
    onContextMenu: menu.onContextMenu,
    onKeyDown: menu.onKeyDown,
  };

  if (narrow)
    return (
      <li
        {...common}
        className="group flex items-center gap-3 border-b border-line-soft bg-surface px-3.5 py-3 last:border-b-0"
      >
        {check}
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          {name}
          <span className="flex flex-wrap items-center gap-1.5">
            {rolePicker}
            <StatusBadge member={u} />
            {u.title ? <span className="truncate text-xs text-fg-2">{u.title}</span> : null}
          </span>
        </span>
        {actions}
      </li>
    );

  return (
    <tr {...common} className={cn(TR, 'group hover:bg-row-alt')}>
      <td className={TD}>{check}</td>
      <td className={cn(TD, 'max-w-[280px]')}>{name}</td>
      <td className={TD}>{rolePicker}</td>
      <td className={cn(TD, 'max-w-[200px] truncate text-fg-2')} data-testid="user-title">
        {[u.title, u.department].filter(Boolean).join(' · ') || <span className="text-muted">—</span>}
      </td>
      <td className={TD}>
        <Teams member={u} />
      </td>
      <td className={cn(TD, 'text-fg-2')}>{lastSeen}</td>
      <td className={TD}>
        <StatusBadge member={u} />
      </td>
      <td className={cn(TD, 'text-end')}>{actions}</td>
    </tr>
  );
};

/**
 * Open invitations: status (sent / opened / failed / expired / link only), who invited and when, the
 * email history; send again (with another lifetime), copy a fresh link, cancel; selectable for a batch resend.
 */
const PendingInvitations = ({
  list,
  loading,
  selected,
  toggle,
  mutations: m,
}: {
  list: Invitation[];
  loading: boolean;
  selected: Set<string>;
  toggle: (key: string) => void;
  mutations: Mutations;
}) => {
  const [now] = useState(() => Date.now());
  const [shown, setShown] = useState<{ email: string; url: string; emailed: boolean } | null>(null);
  const { attach, measure, ...windowed } = useWindowedRows<HTMLUListElement>({
    count: list.length,
    estimate: INVITE_ROW_PX,
    getKey: (i) => list[i]!.id,
    scroll: 'page',
  });
  if (loading || !list.length) return null;
  const handlers: InvitationHandlers = {
    resend: (id, days) => m.resend.mutateAsync({ id, days }),
    link: (id, days) => m.inviteLink.mutateAsync({ id, days }),
    revoke: (id) => m.revoke.mutateAsync(id),
  };
  return (
    <section className="flex flex-col gap-2.5" data-testid="users-pending">
      <h2 className="font-display text-base font-bold text-heading">
        {t('members.pending')} <span className="text-sm font-normal text-muted">({list.length})</span>
      </h2>
      <ul ref={attach} className="overflow-hidden rounded-[14px] border border-line">
        {windowed.before ? <li aria-hidden style={{ height: windowed.before }} /> : null}
        {windowed.rows
          .map((v) => [v, list[v.index]!] as const)
          .map(([v, inv]) => (
            <li
              key={v.key}
              ref={measure}
              data-index={v.index}
              data-testid="invitation-row"
              data-email={inv.email}
              data-status={inv.status}
              className="border-b border-line-soft bg-surface px-3.5 py-2.5 last:border-b-0"
            >
              <InvitationRowBody
                inv={inv}
                now={now}
                leading={
                  <Check
                    checked={selected.has(inviteKey(inv.id))}
                    onChange={() => toggle(inviteKey(inv.id))}
                    label={t('adminUsers.select', { name: inv.email })}
                    testId="invitation-select"
                  />
                }
                actions={<InvitationActions inv={inv} handlers={handlers} onLink={setShown} />}
              />
            </li>
          ))}
        {windowed.after ? <li aria-hidden style={{ height: windowed.after }} /> : null}
      </ul>
      <InvitationLinkDialog shown={shown} onClose={() => setShown(null)} />
    </section>
  );
};

/** The floating batch bar (like the board's): role · deactivate · activate · resend · ✕. */
const UsersBatchBar = ({
  selected,
  members,
  clear,
  mutations: m,
  meId,
}: {
  selected: Set<string>;
  members: Member[];
  clear: () => void;
  mutations: Mutations;
  meId: string | null;
}) => {
  const roleMenu = useActionMenu();
  const keys = [...selected];
  const userIds = keys.filter((k) => k.startsWith('u:')).map((k) => k.slice(2));
  const inviteIds = keys.filter((k) => k.startsWith('i:')).map((k) => k.slice(2));
  const n = keys.length;
  if (!n) return null;
  const people = members.filter((u) => userIds.includes(u.user_id) && u.user_id !== meId);
  const activeIds = people.filter((u) => u.status === 'active').map((u) => u.user_id);
  const offIds = people.filter((u) => u.status === 'deactivated' && !u.anonymised).map((u) => u.user_id);

  const run = (body: BulkUsers, message: (done: number) => string) =>
    m.bulk.mutate(body, {
      onSuccess: (res) => {
        const skipped = res.skipped.length ? ` · ${t('adminUsers.batch.skipped', { n: res.skipped.length })}` : '';
        showToast({ message: `${message(res.done)}${skipped}`, tone: res.skipped.length ? 'error' : undefined });
        clear();
      },
      onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
    });

  const button =
    'flex h-full min-w-16 shrink-0 flex-col items-center justify-center gap-0.5 rounded-[10px] px-3 text-[0.6875rem] text-fg-2 hover:bg-surface-2 hover:text-fg disabled:opacity-40';
  const action = (
    testId: string,
    icon: ReactNode,
    label: string,
    onClick: (e: MouseEvent<HTMLButtonElement>) => void,
    disabled = false,
  ) => (
    <button
      type="button"
      className={button}
      onClick={onClick}
      disabled={disabled || m.bulk.isPending}
      data-testid={testId}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div
      role="toolbar"
      aria-label={t('adminUsers.batch.title', { n })}
      data-testid="users-batch-bar"
      className="fixed inset-x-0 bottom-7 z-40 mx-auto flex h-14 w-max max-w-[calc(100vw-2rem)] items-stretch overflow-x-auto rounded-[16px] border border-line bg-surface p-1 shadow-[var(--shadow-pop)]"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 self-center border-e border-line ps-1.5 pe-3">
        <span
          className="grid h-8 min-w-8 place-items-center rounded-[10px] bg-accent px-1.5 font-bold text-on-accent"
          data-testid="users-batch-count"
        >
          {n}
        </span>
        <span className="text-sm font-semibold">{t('batch.selected')}</span>
      </div>
      {action(
        'users-batch-role',
        <Icon name="shield" size={18} />,
        t('adminUsers.batch.role'),
        roleMenu.fromTrigger,
        !people.length,
      )}
      <Menu
        at={roleMenu.at}
        onClose={roleMenu.close}
        label={t('adminUsers.batch.role')}
        items={accountRoleSchema.options.map((r) => ({
          label: roleLabel(r),
          onSelect: () =>
            run({ op: 'set_role', role: r, ids: people.map((u) => u.user_id) }, (done) =>
              t('adminUsers.batch.done.role', { n: done, role: roleLabel(r) }),
            ),
        }))}
      />
      {action(
        'users-batch-deactivate',
        <Icon name="lock" size={18} />,
        t('adminUsers.batch.deactivate'),
        () =>
          void confirmDialog({
            title: t('adminUsers.batch.deactivate.title', { n: activeIds.length }),
            message: t('adminUsers.batch.deactivate.message'),
            confirmLabel: t('adminUsers.deactivate.confirm'),
            danger: true,
          }).then(
            (ok) =>
              ok &&
              run({ op: 'deactivate', ids: activeIds }, (done) => t('adminUsers.batch.done.deactivate', { n: done })),
          ),
        !activeIds.length,
      )}
      {action(
        'users-batch-activate',
        <Icon name="restore" size={18} />,
        t('adminUsers.batch.activate'),
        () => run({ op: 'activate', ids: offIds }, (done) => t('adminUsers.batch.done.activate', { n: done })),
        !offIds.length,
      )}
      {action(
        'users-batch-resend',
        <Icon name="send" size={18} />,
        t('adminUsers.resend'),
        () => run({ op: 'resend', ids: inviteIds }, (done) => t('adminUsers.resent', { n: done })),
        !inviteIds.length,
      )}
      {action('users-batch-clear', <Icon name="x" size={18} />, t('adminUsers.batch.clear'), clear)}
    </div>
  );
};
