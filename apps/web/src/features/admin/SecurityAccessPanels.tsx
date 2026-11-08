// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import {
  DEFAULT_PASSWORD_MIN_LENGTH,
  formatDateTime,
  ipRangeSchema,
  PASSWORD_MIN_CEILING,
  PASSWORD_MIN_FLOOR,
  type MyAccount,
  type SecuritySettings,
  TWO_FACTOR_MODES,
  type TwoFactorMode,
  type UpdateSecurity,
  t,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, Input, Notice, RadioCard, Segmented, Switch } from '@bines/ui';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { Panel, Row } from './admin-parts';
import { useAdminMembers } from './users/users-api';

/**
 * Administration → אבטחה (M8 ד12): who must use two-factor authentication, and the IP allowlist. Both decide who gets
 * in, so a change that can keep people out asks first; the allowlist cannot be saved without your own address.
 */
const GRACE = ['0', '3', '7', '14', '30'] as const;
const rank: Record<TwoFactorMode, number> = { optional: 0, required_admins: 1, required_all: 2 };

export const TwoFactorPolicyPanel = ({
  settings,
  busy,
  onSave,
}: {
  settings: SecuritySettings;
  busy: boolean;
  onSave: (patch: UpdateSecurity) => void;
}) => {
  const policy = settings.two_factor;
  const choose = async (mode: TwoFactorMode) => {
    if (mode === policy.mode) return;
    if (rank[mode] > rank[policy.mode]) {
      const ok = await confirmDialog({
        title: tDynamic(`sec2.policy.confirm.${mode}`),
        message: t('sec2.policy.confirmHint', { days: policy.grace_days }),
        confirmLabel: t('sec2.policy.confirmAction'),
      });
      if (!ok) return;
    }
    onSave({ two_factor: { mode, grace_days: policy.grace_days } });
  };
  const deadline =
    policy.mode !== 'optional' && policy.required_since
      ? new Date(Date.parse(policy.required_since) + policy.grace_days * 86_400_000).toISOString()
      : null;
  return (
    <Panel title={t('sec2.policy.title')} hint={t('sec2.policy.hint')} testId="security-two-factor">
      <div className="grid gap-2 p-3.5 md:grid-cols-3">
        {TWO_FACTOR_MODES.map((m) => (
          <RadioCard
            key={m}
            name="two-factor-mode"
            checked={policy.mode === m}
            onSelect={() => void choose(m)}
            disabled={busy}
            title={t(`sec2.policy.mode.${m}`)}
            hint={t(`sec2.policy.mode.${m}.hint`)}
            testId={`two-factor-mode-${m}`}
          />
        ))}
      </div>
      {policy.mode !== 'optional' ? (
        <Row label={t('sec2.policy.grace')} hint={t('sec2.policy.graceHint')}>
          <Segmented
            label={t('sec2.policy.grace')}
            value={String(policy.grace_days) as (typeof GRACE)[number]}
            onChange={(v) => onSave({ two_factor: { mode: policy.mode, grace_days: Number(v) } })}
            testId="two-factor-grace"
            options={GRACE.map((d) => ({
              value: d,
              label: d === '0' ? t('sec2.policy.graceNone') : t('sec2.policy.graceDays', { n: d }),
              testId: `two-factor-grace-${d}`,
            }))}
          />
        </Row>
      ) : null}
      {deadline ? (
        <div className="border-t border-line-soft px-3.5 py-3 text-xs text-muted" data-testid="two-factor-deadline">
          {t('sec2.policy.deadline', { date: formatDateTime(deadline) })}
        </div>
      ) : null}
    </Panel>
  );
};

export const IpAllowlistPanel = ({
  account,
  settings,
  busy,
  onSave,
}: {
  account: MyAccount;
  settings: SecuritySettings;
  busy: boolean;
  onSave: (patch: UpdateSecurity) => void;
}) => {
  const list = settings.ip_allowlist;
  const mine = settings.current_ip ?? null;
  const [draft, setDraft] = useState('');
  const parsed = ipRangeSchema.safeParse(draft);
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (!parsed.success) return;
    if (!list.ranges.includes(parsed.data)) onSave({ ip_allowlist: { ranges: [...list.ranges, parsed.data] } });
    setDraft('');
  };
  const remove = async (range: string) => {
    if (list.enabled) {
      const ok = await confirmDialog({
        title: t('sec2.ip.removeConfirm', { range }),
        message: t('sec2.ip.removeHint'),
        confirmLabel: t('sec2.ip.remove'),
        danger: true,
      });
      if (!ok) return;
    }
    const ranges = list.ranges.filter((r) => r !== range);
    onSave({ ip_allowlist: { ranges, ...(ranges.length ? {} : { enabled: false }) } });
  };
  const toggle = async (on: boolean) => {
    if (on) {
      const ok = await confirmDialog({
        title: t('sec2.ip.enableConfirm'),
        message: t('sec2.ip.enableHint'),
        confirmLabel: t('sec2.ip.enable'),
      });
      if (!ok) return;
    }
    onSave({ ip_allowlist: { enabled: on } });
  };
  return (
    <Panel
      title={t('sec2.ip.title')}
      hint={t('sec2.ip.hint')}
      testId="security-ip-allowlist"
      actions={
        <Switch
          checked={list.enabled}
          onChange={(on) => void toggle(on)}
          disabled={busy || (!list.enabled && !list.ranges.length)}
          label={t('sec2.ip.enable')}
          testId="ip-allowlist-toggle"
        />
      }
    >
      <Row label={t('sec2.ip.mine')} hint={t('sec2.ip.mineHint')}>
        <bdi dir="ltr" className="font-mono text-sm" data-testid="ip-current">
          {mine ?? '—'}
        </bdi>
        {mine && !list.ranges.includes(mine) ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => onSave({ ip_allowlist: { ranges: [...list.ranges, mine] } })}
            data-testid="ip-add-mine"
          >
            <Icon name="plus" size={14} />
            {t('sec2.ip.addMine')}
          </Button>
        ) : null}
      </Row>
      <div className="flex flex-col gap-2 px-3.5 py-3">
        {list.ranges.length ? (
          <div className="flex flex-wrap gap-1.5">
            {list.ranges.map((r) => (
              <span
                key={r}
                data-testid="ip-range-chip"
                data-range={r}
                className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 ps-2.5 pe-1 font-mono text-xs text-fg-2"
              >
                <bdi dir="ltr">{r}</bdi>
                <button
                  type="button"
                  aria-label={t('sec2.ip.removeConfirm', { range: r })}
                  data-testid="ip-range-remove"
                  disabled={busy}
                  onClick={() => void remove(r)}
                  className="grid size-5 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-fg"
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted">{t('sec2.ip.none')}</span>
        )}
        <form onSubmit={add} className="flex items-center gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="203.0.113.0/24"
            aria-label={t('sec2.ip.add')}
            dir="ltr"
            className="h-9 max-w-[260px] text-start font-mono"
            data-testid="ip-range-input"
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={!parsed.success || busy}
            data-testid="ip-range-add"
          >
            <Icon name="plus" size={14} />
            {t('sec2.ip.add')}
          </Button>
        </form>
        {list.enabled ? (
          <span className="self-start">
            <Badge tone="ok">{t('sec2.ip.on')}</Badge>
          </span>
        ) : null}
      </div>
      <IpExemptPeople account={account} settings={settings} busy={busy} onSave={onSave} />
      <div className="border-t border-line-soft px-3.5 py-3">
        <Notice tone="info">{t('support.ip.ownerNote')}</Notice>
      </div>
    </Panel>
  );
};

/**
 * People the allowlist does not hold: a traveller, an outside contractor. Chosen from the account's
 * active people by a search field (no native select); each one removable.
 */
const IpExemptPeople = ({
  account,
  settings,
  busy,
  onSave,
}: {
  account: MyAccount;
  settings: SecuritySettings;
  busy: boolean;
  onSave: (patch: UpdateSecurity) => void;
}) => {
  const members = useAdminMembers(account.id);
  const [q, setQ] = useState('');
  const ids = settings.ip_allowlist.exempt_user_ids;
  const people = (members.data?.data ?? []).filter((m) => m.status === 'active');
  const byId = new Map(people.map((m) => [m.user_id, m]));
  const needle = q.trim().toLowerCase();
  const matches = needle
    ? people
        .filter((m) => !ids.includes(m.user_id))
        .filter((m) => m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle))
        .slice(0, 6)
    : [];
  const set = (next: string[]) => onSave({ ip_allowlist: { exempt_user_ids: next } });
  return (
    <div className="flex flex-col gap-2 border-t border-line-soft px-3.5 py-3" data-testid="ip-exempt">
      <div className="space-y-0.5">
        <div className="text-sm font-semibold text-fg">{t('support.ip.exempt')}</div>
        <p className="text-xs text-muted">{t('support.ip.exemptHint')}</p>
      </div>
      {ids.length ? (
        <div className="flex flex-wrap gap-1.5">
          {ids.map((id) => {
            const m = byId.get(id);
            return (
              <span
                key={id}
                data-testid="ip-exempt-chip"
                data-user={m?.email ?? id}
                className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 ps-2.5 pe-1 text-xs font-semibold text-fg-2"
              >
                {m ? m.name || m.email : id}
                <button
                  type="button"
                  aria-label={t('support.ip.exemptRemove', { name: m?.name || m?.email || id })}
                  data-testid="ip-exempt-remove"
                  disabled={busy}
                  onClick={() => set(ids.filter((x) => x !== id))}
                  className="grid size-5 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-fg"
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        <span className="text-xs text-muted">{t('support.ip.exemptNone')}</span>
      )}
      <Input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('support.ip.exemptSearch')}
        aria-label={t('support.ip.exemptSearch')}
        className="h-9 max-w-[320px]"
        data-testid="ip-exempt-search"
      />
      {matches.length ? (
        <ul className="flex max-w-[320px] flex-col overflow-hidden rounded-[10px] border border-line">
          {matches.map((m) => (
            <li key={m.user_id}>
              <button
                type="button"
                disabled={busy}
                data-testid="ip-exempt-option"
                data-user={m.email}
                onClick={() => {
                  set([...ids, m.user_id]);
                  setQ('');
                }}
                className="flex w-full flex-col items-start px-3 py-2 text-start hover:bg-surface-2"
              >
                <span className="text-sm font-semibold text-fg">{m.name || m.email}</span>
                <bdi dir="ltr" className="text-[0.6875rem] text-muted">
                  {m.email}
                </bdi>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

/**
 * Administration → אבטחה → passwords: the shortest password the account's people may choose. Empty = the
 * platform's default (owner console), shown as the placeholder. Applies when a password is chosen, never to one
 * already set.
 */
export const PasswordPolicyPanel = ({
  settings,
  busy,
  onSave,
}: {
  settings: SecuritySettings;
  busy: boolean;
  onSave: (patch: UpdateSecurity) => void;
}) => {
  const saved = settings.password_min_length;
  const platform = settings.platform_password_min_length ?? DEFAULT_PASSWORD_MIN_LENGTH;
  const [draft, setDraft] = useState(saved === null ? '' : String(saved));
  const trimmed = draft.trim();
  const value = trimmed ? Number(trimmed) : null;
  const valid =
    value === null || (/^\d{1,2}$/.test(trimmed) && value >= PASSWORD_MIN_FLOOR && value <= PASSWORD_MIN_CEILING);
  const dirty = value !== saved;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && dirty) onSave({ password_min_length: value });
  };
  return (
    <Panel
      title={t('pass.policy.title')}
      hint={t('pass.policy.hint', { n: platform })}
      testId="security-password-policy"
    >
      <form onSubmit={submit}>
        <Row
          label={t('pass.policy.minLength')}
          hint={t('pass.policy.minLengthHint', { min: PASSWORD_MIN_FLOOR, max: PASSWORD_MIN_CEILING })}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            inputMode="numeric"
            maxLength={2}
            dir="ltr"
            placeholder={String(platform)}
            aria-label={t('pass.policy.minLength')}
            aria-invalid={!valid}
            className="h-9 w-20 text-center"
            data-testid="password-min-length"
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={busy || !valid || !dirty}
            data-testid="password-min-length-save"
          >
            {t('common.save')}
          </Button>
        </Row>
        {!valid ? (
          <div className="px-3.5 pb-3 text-xs text-danger-fg" data-testid="password-min-length-invalid">
            {t('pass.policy.invalid', { min: PASSWORD_MIN_FLOOR, max: PASSWORD_MIN_CEILING })}
          </div>
        ) : null}
      </form>
    </Panel>
  );
};
