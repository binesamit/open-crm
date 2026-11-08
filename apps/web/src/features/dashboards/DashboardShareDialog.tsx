// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  DASHBOARD_KINDS,
  DASHBOARD_LEVELS,
  t,
  type DashboardDetail,
  type DashboardKind,
  type DashboardLevel,
  type MyAccount,
  msgKey,
  dynamicKey,
} from '@bines/shared';
import { Avatar, Badge, Button, Dialog, Input, Notice, Picker, Segmented, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { Icon, type IconName } from '../../lib/icons';
import { useMembers, useTeams } from '../board/board-api';
import { InviteLinks, SendEmailSwitch } from '../account/InviteLinks';
import { useDashboardMembers, useDashboardMutations } from './dashboard-api';

type Row = { type: 'user' | 'team'; id: string; name: string; email: string | null; level: DashboardLevel };

export const DASHBOARD_KIND_ICON: Record<DashboardKind, IconName> = {
  main: 'building',
  private: 'lock',
  shareable: 'people',
};
/** The dashboard's real kind: `sharing` (main / private / shareable); `kind` still says main / private only. */
export const dashboardKindOf = (d: Pick<DashboardDetail, 'kind' | 'sharing'>): DashboardKind => d.sharing ?? d.kind;

/** Section label (F4 `.lbl`), as in the board permissions dialog. */
const Label = ({ children }: { children: string }) => <h3 className="text-xs font-semibold text-fg-2">{children}</h3>;
const listCls = 'overflow-hidden rounded-[14px] border border-line';
const rowCls = 'flex items-center gap-3 border-b border-line-soft px-3 py-2 last:border-b-0';
/** A guest is at most an editor of a dashboard (never its owner). */
const levelOptions = (guest: boolean) =>
  DASHBOARD_LEVELS.filter((l) => !guest || l !== 'owner').map((l) => ({
    value: l,
    label: t(msgKey(`dashboards.level.${l}`)),
  }));
const forGuest = (level: DashboardLevel, guest: boolean): DashboardLevel =>
  guest && level === 'owner' ? 'editor' : level;

/**
 * "שיתוף" of a dashboard (D25; "like boards"): its type — main (the whole workspace sees it), private
 * (only who is invited) or shareable (invited only, guests too) — who is invited at which level (owner / editor /
 * viewer; a guest at most an editor), and an invitation by email. Owners and admins (`dashboard.manage`) open it.
 */
export const DashboardShareDialog = ({
  account,
  dashboard,
  onClose,
}: {
  account: MyAccount;
  dashboard: DashboardDetail;
  onClose: () => void;
}) => {
  const current = useDashboardMembers(account.id, dashboard.id);
  const people = useMembers(account.id).data?.data ?? [];
  const teams = useTeams(account.id).data?.data ?? [];
  const mut = useDashboardMutations(account.id);
  const saved = dashboardKindOf(dashboard);
  const [kind, setKind] = useState<DashboardKind>(saved);
  const [rows, setRows] = useState<Row[] | null>(null);
  const list = rows ?? current.data?.data ?? [];
  const guestIds = new Set(people.filter((m) => m.role === 'guest').map((m) => m.user_id));
  const isGuest = (r: Pick<Row, 'type' | 'id'>) => r.type === 'user' && guestIds.has(r.id);
  const taken = new Set(list.map((r) => `${r.type}:${r.id}`));
  const addable = [
    ...people
      .filter((m) => m.status === 'active' && !taken.has(`user:${m.user_id}`))
      // Guests join only a shareable dashboard (like a shareable board / doc).
      .filter((m) => m.role !== 'guest' || kind === 'shareable')
      .map((m) => ({
        value: `user:${m.user_id}`,
        label: m.role === 'guest' ? `${m.name || m.email} · ${t('role.guest')}` : m.name || m.email,
        keywords: m.email,
      })),
    ...teams
      .filter((tm) => !taken.has(`team:${tm.id}`))
      .map((tm) => ({ value: `team:${tm.id}`, label: `${tm.name} · ${t('dashboards.share.team')}` })),
  ];
  const add = (value: string) => {
    const [type, id] = value.split(':') as ['user' | 'team', string];
    const person = people.find((m) => m.user_id === id);
    const team = teams.find((tm) => tm.id === id);
    setRows([
      ...list,
      {
        type,
        id,
        name: type === 'user' ? (person?.name ?? '') : (team?.name ?? ''),
        email: person?.email ?? null,
        level: 'viewer',
      },
    ]);
  };
  const save = async () => {
    if (kind !== saved) await mut.update.mutateAsync({ id: dashboard.id, kind });
    if (rows)
      await mut.setMembers.mutateAsync({
        id: dashboard.id,
        members: rows.map(({ type, id, level }) => ({ type, id, level })),
      });
    onClose();
  };
  const error = mut.update.error ?? mut.setMembers.error;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('dashboards.share.title', { name: dashboard.name })}
      className="max-w-[640px]!"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            busy={mut.update.isPending || mut.setMembers.isPending}
            data-testid="dashboard-share-save"
            onClick={() => void save()}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5" data-testid="dashboard-share">
        <section className="flex flex-col gap-1.5">
          <Label>{t('dashboards.share.kind')}</Label>
          <Segmented<DashboardKind>
            label={t('dashboards.share.kind')}
            className="self-start"
            value={kind}
            onChange={setKind}
            testId="dashboard-share-kind"
            options={DASHBOARD_KINDS.map((v) => ({
              value: v,
              label: t(msgKey(`dashboards.kind.${v}`)),
              icon: <Icon name={DASHBOARD_KIND_ICON[v]} size={14} />,
              testId: `dashboard-kind-${v}`,
            }))}
          />
          <p className="text-xs text-muted" data-testid="dashboard-kind-hint">
            {t(msgKey(`dashboards.kind.${kind}.hint`))}
          </p>
        </section>

        <section className="flex flex-col gap-1.5">
          <Label>{t('dashboards.share.members')}</Label>
          {current.isPending ? (
            <SkeletonRows rows={3} label={t('app.loading')} />
          ) : list.length ? (
            <ul className={listCls} aria-label={t('dashboards.share.members')}>
              {list.map((r) => {
                const guest = isGuest(r);
                const name = r.name || r.email || '';
                return (
                  <li
                    key={`${r.type}:${r.id}`}
                    className={rowCls}
                    data-testid="dashboard-member"
                    data-email={r.email ?? undefined}
                    data-level={r.level}
                    data-guest={guest || undefined}
                  >
                    <Avatar name={name || '?'} size={28} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-bold text-fg">{name}</span>
                        {guest ? <Badge tone="info">{t('role.guest')}</Badge> : null}
                      </span>
                      {r.name && r.email ? (
                        <span className="truncate text-end text-xs text-muted" dir="ltr">
                          {r.email}
                        </span>
                      ) : null}
                    </span>
                    <div className="w-36 shrink-0 max-sm:w-28">
                      <Picker<DashboardLevel>
                        className="h-8"
                        label={t('dashboards.share.level')}
                        value={forGuest(r.level, guest)}
                        options={levelOptions(guest)}
                        testId="dashboard-member-level"
                        onChange={(level) => setRows(list.map((x) => (x === r ? { ...x, level } : x)))}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-8 shrink-0 px-0 text-muted hover:text-danger-fg"
                      aria-label={t('dashboards.share.remove', { name })}
                      title={t('dashboards.share.remove', { name })}
                      data-testid="dashboard-member-remove"
                      onClick={() => setRows(list.filter((x) => x !== r))}
                    >
                      <Icon name="x" size={15} />
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <Picker
            label={t('dashboards.share.add')}
            placeholder={`+ ${t('dashboards.share.add')}`}
            value=""
            options={addable}
            searchable
            className="self-start"
            testId="dashboard-share-add"
            onChange={add}
          />
          {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
        </section>

        {/* Keyed by the saved kind: the role starts as guest once the dashboard is shareable. */}
        <DashboardInvite key={saved} account={account} dashboard={dashboard} shareable={saved === 'shareable'} />
      </div>
    </Dialog>
  );
};

const errorText = (code: string) => {
  const key = dynamicKey(`error.${code}`);
  const text = t(key);
  return text === key ? code : text;
};

/**
 * Invite by email (like the board's `perm-invite`): people already in the account join the dashboard at once at
 * the level chosen; new people get an account invitation that adds them on accepting. Guests only while the saved
 * kind is shareable (the server checks the saved kind), never as owners (a guest owner invitation = an editor).
 */
const DashboardInvite = ({
  account,
  dashboard,
  shareable,
}: {
  account: MyAccount;
  dashboard: DashboardDetail;
  shareable: boolean;
}) => {
  const { invite } = useDashboardMutations(account.id);
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState<'member' | 'guest'>(shareable ? 'guest' : 'member');
  const [level, setLevel] = useState<DashboardLevel>('viewer');
  const [message, setMessage] = useState('');
  const [sendEmail, setSendEmail] = useState(true);
  const asRole = shareable ? role : 'member';
  const guest = asRole === 'guest';
  const list = emails
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  const result = invite.data;
  const guestLabel = t('role.guest');
  const send = () =>
    invite.mutate(
      {
        id: dashboard.id,
        emails: list,
        role: asRole,
        level: forGuest(level, guest),
        ...(message.trim() ? { message: message.trim() } : {}),
        ...(sendEmail ? {} : { send_email: false }),
      },
      {
        onSuccess: () => {
          setEmails('');
          setMessage('');
        },
      },
    );
  return (
    <section className="flex flex-col gap-2 border-t border-line-soft pt-3" data-testid="dashboard-invite">
      <Label>{t('dashboards.share.invite')}</Label>
      <Input
        value={emails}
        dir="ltr"
        placeholder="name@company.co.il, …"
        aria-label={t('members.emails')}
        data-testid="dashboard-invite-emails"
        onChange={(e) => setEmails(e.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">{t('dashboards.share.inviteRole')}</span>
        <Segmented<'member' | 'guest'>
          label={t('dashboards.share.inviteRole')}
          value={asRole}
          // Guest shows, but stays off until the dashboard is saved as shareable.
          onChange={(r) => (r === 'guest' && !shareable ? undefined : setRole(r))}
          testId="dashboard-invite-role"
          options={[
            { value: 'member', label: t('role.member'), testId: 'dashboard-invite-member' },
            {
              value: 'guest',
              label: shareable ? (
                guestLabel
              ) : (
                <span className="opacity-45" title={t('error.guest_needs_shareable_dashboard')}>
                  {guestLabel}
                </span>
              ),
              testId: 'dashboard-invite-guest',
            },
          ]}
        />
        <div className="w-36">
          <Picker<DashboardLevel>
            className="h-8"
            label={t('dashboards.share.level')}
            value={forGuest(level, guest)}
            options={levelOptions(guest)}
            testId="dashboard-invite-level"
            onChange={setLevel}
          />
        </div>
      </div>
      <Input
        value={message}
        maxLength={1000}
        placeholder={t('dashboards.share.message')}
        aria-label={t('dashboards.share.message')}
        data-testid="dashboard-invite-message"
        onChange={(e) => setMessage(e.target.value)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SendEmailSwitch checked={sendEmail} onChange={setSendEmail} testId="dashboard-invite-send-email" />
        <Button
          variant="secondary"
          disabled={!list.length}
          busy={invite.isPending}
          data-testid="dashboard-invite-send"
          onClick={send}
        >
          {invite.isPending ? null : <Icon name="send" size={14} />}
          {t('members.send')}
        </Button>
      </div>
      {!shareable ? <p className="text-xs text-muted">{t('error.guest_needs_shareable_dashboard')}</p> : null}
      {invite.error ? <Notice tone="error">{errorMessage(invite.error)}</Notice> : null}
      {result ? (
        <Notice tone={result.errors.length ? 'info' : 'success'}>
          <span data-testid="dashboard-invite-result">
            {result.invited.length ? `${t('dashboards.share.invited')}: ${result.invited.length}.` : null}
            {result.added.length ? ` ${t('invite.addedNow', { n: result.added.length })}` : null}
          </span>
          {result.errors.map((e) => (
            <span key={e.email} className="block" dir="ltr" data-testid="dashboard-invite-error" data-code={e.code}>
              {e.email}: {errorText(e.code)}
            </span>
          ))}
        </Notice>
      ) : null}
      {result ? <InviteLinks invited={result.invited} testId="dashboard-invite-links" /> : null}
    </section>
  );
};
