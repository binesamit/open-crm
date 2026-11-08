// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import {
  type AccountSession,
  emailDomainSchema,
  type GuestDomainMode,
  type MyAccount,
  type SecuritySettings,
  t,
  type UpdateSecurity,
} from '@bines/shared';
import {
  Avatar,
  Badge,
  Button,
  cn,
  EmptyState,
  Input,
  Notice,
  RadioCard,
  Segmented,
  SkeletonRows,
  Switch,
} from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { Ago, TD, TH, TR, useNarrow } from '../trash/TrashPage';
import { useSecurity, useSessionMutations, useSessions, useUpdateSecurity } from './admin-a45-api';
import { deviceOf, Panel, Row, SectionHeader } from './admin-parts';
import { reasonMessage } from '../account/CopyLink';
import { IpAllowlistPanel, PasswordPolicyPanel, TwoFactorPolicyPanel } from './SecurityAccessPanels';
import { SupportAccessPanel } from './SupportAccessPanel';
import { DomainJoinStatus } from './DomainJoinStatus';
import { SsoPolicyPanel } from './SsoPolicyPanel';
import { TicketSettingsPanel } from '../support/TicketSettingsPanel';
import { SecretLogPanel } from '../secrets/SecretLogPanel';
import { SecretUpdatesPanel } from '../secrets/SecretUpdatesSettings';
import { SecretPolicyPanel } from '../secrets/SecretSettingsFields';
import { AccountCaptchaPanel } from '../captcha/CaptchaPanels';

// The reason when the server gives one (e.g. "the allowlist leaves out your own address"), else the code's message.
const fail = (err: unknown) => showToast({ message: reasonMessage(err), tone: 'error' });

/**
 * Administration → אבטחה (08 §5, account admin A4): who is signed in (sign one out / everyone but me), the
 * account's domains (members only from them, auto-join), which domains guests may come from, who must use two-factor
 * authentication and the IP allowlist (M8 ד12).
 */
export const AdminSecurity = ({ account }: { account: MyAccount }) => {
  const security = useSecurity(account.id);
  const update = useUpdateSecurity(account.id);
  const save = (patch: UpdateSecurity) =>
    update.mutate(patch, { onSuccess: () => showToast({ message: t('admin.general.saved') }), onError: fail });
  return (
    <div className="flex flex-col gap-4 pb-12" data-testid="admin-security">
      <SectionHeader title={t('admin.section.security')} subtitle={t('a45.security.subtitle')} />
      <SessionsPanel account={account} />
      {security.isError ? <Notice tone="error">{errorMessage(security.error)}</Notice> : null}
      {security.data ? (
        <>
          <DomainsPanel accountId={account.id} settings={security.data} busy={update.isPending} onSave={save} />
          <GuestPolicyPanel
            key={JSON.stringify(security.data.guest_domain_policy)}
            settings={security.data}
            busy={update.isPending}
            onSave={save}
          />
          {/* Plan: members sign in through Google / Microsoft only. */}
          <SsoPolicyPanel settings={security.data} busy={update.isPending} onSave={save} />
          <TwoFactorPolicyPanel settings={security.data} busy={update.isPending} onSave={save} />
          <PasswordPolicyPanel
            key={`password-${security.data.password_min_length}`}
            settings={security.data}
            busy={update.isPending}
            onSave={save}
          />
          <IpAllowlistPanel account={account} settings={security.data} busy={update.isPending} onSave={save} />
          {/* Cloudflare Turnstile: keys, master switch, the account's public places. */}
          <AccountCaptchaPanel accountId={account.id} />
          <SupportAccessPanel account={account} busy={update.isPending} onSave={save} />
          {/* Support tickets: who opens tickets, who sees them (not under a support grant). */}
          {account.support ? null : <TicketSettingsPanel accountId={account.id} />}
          {/* Secret updates: the account's default (a board may set its own). */}
          {account.support ? null : <SecretUpdatesPanel account={account} />}
          {/* the longest a fresh code counts for the account's secrets. */}
          {account.support ? null : (
            <SecretPolicyPanel
              key={`secret-policy-${security.data.secret_max_verify_minutes}`}
              saved={security.data.secret_max_verify_minutes}
              busy={update.isPending}
              onSave={(m) => save({ secret_max_verify_minutes: m })}
            />
          )}
          {/* Secret columns: who revealed which secret and when. */}
          <SecretLogPanel account={account} />
        </>
      ) : !security.isError ? (
        <SkeletonRows rows={4} label={t('app.loading')} />
      ) : null}
    </div>
  );
};

// ---- sessions ----
const SessionsPanel = ({ account }: { account: MyAccount }) => {
  const sessions = useSessions(account.id);
  const m = useSessionMutations(account.id);
  const narrow = useNarrow();
  const [now] = useState(() => Date.now());
  const list = sessions.data?.data ?? [];
  const others = list.filter((s) => !s.current).length;

  const signOut = async (s: AccountSession) => {
    const ok = await confirmDialog({
      title: t('a45.sessions.confirmOne', { name: s.user_name || s.user_email }),
      message: t('a45.sessions.globalHint'),
      confirmLabel: t('a45.sessions.signOut'),
      danger: true,
    });
    if (ok) m.signOut.mutate(s.id, { onSuccess: () => showToast({ message: t('a45.sessions.done') }), onError: fail });
  };
  const signOutAll = async () => {
    const ok = await confirmDialog({
      title: t('a45.sessions.confirmAll'),
      message: t('a45.sessions.globalHint'),
      confirmLabel: t('a45.sessions.signOutAll'),
      danger: true,
    });
    if (ok)
      m.signOutAll.mutate(undefined, {
        onSuccess: (r) =>
          showToast({
            message: r.skipped
              ? `${t('a45.sessions.doneAll', { n: r.signed_out })} ${t('a45.sessions.skippedAdmins', { n: r.skipped })}`
              : t('a45.sessions.doneAll', { n: r.signed_out }),
          }),
        onError: fail,
      });
  };

  const who = (s: AccountSession) => (
    <span className="flex min-w-0 items-center gap-2.5">
      <Avatar name={s.user_name || s.user_email} size={28} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-semibold text-fg">
          {s.user_name || s.user_email}
          {s.current ? (
            <span className="ms-1.5 align-middle">
              <Badge tone="ok">{t('a45.sessions.thisDevice')}</Badge>
            </span>
          ) : null}
        </span>
        <span className="truncate text-start text-[0.6875rem] text-muted [unicode-bidi:isolate]" dir="ltr">
          {s.user_email}
        </span>
      </span>
    </span>
  );
  const action = (s: AccountSession) =>
    s.current ? null : s.admin_elsewhere ? (
      <span title={t('a45.sessions.adminElsewhereHint')} data-testid="session-admin-elsewhere">
        <Badge tone="neutral">{t('a45.sessions.adminElsewhere')}</Badge>
      </span>
    ) : (
      <Button
        variant="danger-outline"
        size="sm"
        data-testid="session-sign-out"
        busy={m.signOut.isPending && m.signOut.variables === s.id}
        onClick={() => void signOut(s)}
      >
        {t('a45.sessions.signOut')}
      </Button>
    );
  const device = (s: AccountSession) => (
    <span title={s.user_agent ?? undefined} className="flex items-center gap-1.5">
      {deviceOf(s.user_agent)}
      {s.other_accounts ? (
        <span title={t('a45.sessions.otherAccountsHint')}>
          <Badge tone="info">{t('a45.sessions.otherAccounts')}</Badge>
        </span>
      ) : null}
    </span>
  );

  return (
    <Panel
      title={t('a45.sessions.title')}
      hint={t('a45.sessions.hint')}
      testId="security-sessions"
      actions={
        <Button
          variant="danger-outline"
          size="sm"
          onClick={() => void signOutAll()}
          disabled={!others}
          busy={m.signOutAll.isPending}
          data-testid="sessions-sign-out-all"
        >
          <Icon name="lock" size={14} />
          {t('a45.sessions.signOutAll')}
        </Button>
      }
    >
      {sessions.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {sessions.isError ? <Notice tone="error">{errorMessage(sessions.error)}</Notice> : null}
      {sessions.data && !list.length ? (
        <EmptyState title={t('a45.sessions.empty')} testId="sessions-empty" />
      ) : narrow ? (
        <ul>
          {list.map((s) => (
            <li
              key={s.id}
              data-testid="session-row"
              data-user={s.user_email}
              className="flex items-center gap-3 border-b border-line-soft px-3.5 py-3 last:border-b-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                {who(s)}
                <span className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted">
                  {device(s)} · <bdi>{s.ip ?? '—'}</bdi> · <Ago iso={s.last_seen_at} now={now} />
                </span>
              </span>
              {action(s)}
            </li>
          ))}
        </ul>
      ) : list.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>{t('a45.sessions.col.user')}</th>
                <th className={TH}>{t('a45.sessions.col.device')}</th>
                <th className={TH}>{t('a45.sessions.col.ip')}</th>
                <th className={TH}>{t('a45.sessions.col.created')}</th>
                <th className={TH}>{t('a45.sessions.col.lastSeen')}</th>
                <th className={cn(TH, 'w-24')} />
              </tr>
            </thead>
            <tbody>
              {list.map((s) => (
                <tr
                  key={s.id}
                  className={cn(TR, 'hover:bg-row-alt')}
                  data-testid="session-row"
                  data-user={s.user_email}
                >
                  <td className={cn(TD, 'max-w-[260px]')}>{who(s)}</td>
                  <td className={cn(TD, 'text-fg-2')}>{device(s)}</td>
                  <td className={cn(TD, 'text-fg-2')}>
                    <bdi dir="ltr">{s.ip ?? '—'}</bdi>
                  </td>
                  <td className={cn(TD, 'text-fg-2')}>
                    <Ago iso={s.created_at} now={now} />
                  </td>
                  <td className={cn(TD, 'text-fg-2')}>
                    <Ago iso={s.last_seen_at} now={now} />
                  </td>
                  <td className={cn(TD, 'text-end')}>{action(s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Panel>
  );
};

// ---- domains ----

/** A list of email domains: chips with ×, and a field that adds one (validated like the API). */
export const DomainList = ({
  value,
  onChange,
  busy,
  testId,
  label,
  schema = emailDomainSchema,
  prefix = '@',
  placeholder = 'example.com',
}: {
  value: string[];
  onChange: (next: string[]) => void;
  busy: boolean;
  testId: string;
  label: string;
  /** What one entry must be (default: an email domain); also other identifiers, e.g. a directory id (S-72). */
  schema?: { safeParse: (v: unknown) => { success: true; data: string } | { success: false } };
  /** Shown before each chip ('@' for a domain, '' for an id). */
  prefix?: string;
  placeholder?: string;
}) => {
  const [draft, setDraft] = useState('');
  const entry = draft.trim();
  const parsed = schema.safeParse(prefix && entry.startsWith(prefix) ? entry.slice(prefix.length) : entry);
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!parsed.success) return;
    if (!value.includes(parsed.data)) onChange([...value, parsed.data]);
    setDraft('');
  };
  return (
    <div className="flex w-full flex-col gap-2" data-testid={testId}>
      {value.length ? (
        <div className="flex flex-wrap gap-1.5">
          {value.map((d) => (
            <span
              key={d}
              data-testid={`${testId}-chip`}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 ps-2.5 pe-1 text-xs font-semibold text-fg-2"
            >
              <bdi dir="ltr">
                {prefix}
                {d}
              </bdi>
              <button
                type="button"
                aria-label={t('a45.domains.remove', { domain: d })}
                data-testid={`${testId}-remove`}
                disabled={busy}
                onClick={() => onChange(value.filter((x) => x !== d))}
                className="grid size-5 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-fg"
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <span className="text-xs text-muted">{t('a45.domains.none')}</span>
      )}
      <form onSubmit={add} className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          aria-label={label}
          dir="ltr"
          className="h-9 max-w-[260px] text-start"
          data-testid={`${testId}-input`}
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={!parsed.success || busy}
          data-testid={`${testId}-add`}
        >
          <Icon name="plus" size={14} />
          {t('a45.domains.add')}
        </Button>
      </form>
    </div>
  );
};

const DomainsPanel = ({
  accountId,
  settings,
  busy,
  onSave,
}: {
  accountId: string;
  settings: SecuritySettings;
  busy: boolean;
  onSave: (patch: UpdateSecurity) => void;
}) => (
  <Panel title={t('a45.domains.title')} hint={t('a45.domains.hint')} testId="security-domains">
    <Row
      label={t('a45.domains.list')}
      hint={t('a45.domains.listHint')}
      className="max-md:flex-col max-md:items-stretch"
    >
      <div className="w-[360px] max-md:w-full">
        <DomainList
          value={settings.domains}
          onChange={(domains) => onSave({ domains })}
          busy={busy}
          testId="security-domain"
          label={t('a45.domains.list')}
        />
      </div>
    </Row>
    <Row label={t('a45.domains.restrict')} hint={t('a45.domains.restrictHint')}>
      <Switch
        checked={settings.restrict_members_to_domains}
        onChange={(on) => onSave({ restrict_members_to_domains: on })}
        disabled={busy || (!settings.domains.length && !settings.restrict_members_to_domains)}
        label={t('a45.domains.restrict')}
        testId="security-restrict"
      />
    </Row>
    <Row label={t('a45.autoJoin.title')} hint={t('a45.autoJoin.hint')}>
      {settings.auto_join ? (
        <Segmented
          label={t('a45.autoJoin.role')}
          value={settings.auto_join_role}
          onChange={(v) => onSave({ auto_join_role: v })}
          testId="security-auto-join-role"
          options={[
            { value: 'member', label: t('role.member'), testId: 'auto-join-role-member' },
            { value: 'viewer', label: t('role.viewer'), testId: 'auto-join-role-viewer' },
          ]}
        />
      ) : null}
      <Switch
        checked={settings.auto_join}
        onChange={(on) => onSave({ auto_join: on })}
        disabled={busy}
        label={t('a45.autoJoin.title')}
        testId="security-auto-join"
      />
    </Row>
    {/* Plan ה7: which domains count for joining (verified), and the page to share. */}
    <DomainJoinStatus accountId={accountId} domains={settings.domains} autoJoin={settings.auto_join} />
  </Panel>
);

const MODES: GuestDomainMode[] = ['any', 'allow_list', 'block_list'];

const GuestPolicyPanel = ({
  settings,
  busy,
  onSave,
}: {
  settings: SecuritySettings;
  busy: boolean;
  onSave: (patch: UpdateSecurity) => void;
}) => {
  const policy = settings.guest_domain_policy;
  // The mode applies once it has its list: picking a list mode waits for the first domain.
  const [mode, setMode] = useState<GuestDomainMode>(policy.mode);
  const choose = (next: GuestDomainMode) => {
    setMode(next);
    if (next === 'any') onSave({ guest_domain_policy: { mode: 'any', domains: policy.domains } });
    else if (policy.domains.length) onSave({ guest_domain_policy: { mode: next, domains: policy.domains } });
  };
  return (
    <Panel title={t('a45.guests.title')} hint={t('a45.guests.hint')} testId="security-guests">
      <div className="grid gap-2 p-3.5 md:grid-cols-3">
        {MODES.map((m) => (
          <RadioCard
            key={m}
            name="guest-domain-mode"
            checked={mode === m}
            onSelect={() => choose(m)}
            disabled={busy}
            title={t(`a45.guests.mode.${m}`)}
            hint={t(`a45.guests.mode.${m}.hint`)}
            testId={`guest-mode-${m}`}
          />
        ))}
      </div>
      {mode !== 'any' ? (
        <div className="border-t border-line-soft px-3.5 py-3">
          <DomainList
            value={policy.domains}
            onChange={(domains) => onSave({ guest_domain_policy: { mode, domains } })}
            busy={busy}
            testId="guest-domain"
            label={t(`a45.guests.list.${mode}`)}
          />
          {mode !== policy.mode ? (
            <p className="mt-2 text-xs text-muted" data-testid="guest-mode-pending">
              {t('a45.guests.pending')}
            </p>
          ) : null}
        </div>
      ) : null}
    </Panel>
  );
};
