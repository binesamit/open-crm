// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type KeyboardEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type BillingSettings,
  SIGNUP_METHODS,
  SIGNUP_TRIAL_END_STATUSES,
  type SignupMethod,
  type SignupMissing,
  type SignupSettings,
  type SignupSettingsResponse,
  type SubscriptionPlan,
  t,
} from '@bines/shared';
import { Badge, Button, cn, Field, Input, Notice, Picker, Segmented, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { useAuthConfig } from '../../lib/branding';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { kitName, useKits } from './StarterKits';
import { usePlans } from './Plans';
import { TrialEmailsSection, trialEmailsPatch } from './TrialEmails';
import { type ConsoleTarget, useConsoleJump } from './console-links';

export const signupSettingsKey = ['platform', 'signup-settings'] as const;
const billingKey = ['platform', 'billing-settings'] as const;

export const useSignupSettings = () =>
  useQuery({
    queryKey: signupSettingsKey,
    queryFn: () => api().get<SignupSettingsResponse>('/platform/signup-settings'),
  });

/** What the "before turning it on" list always shows, then what is missing only in some installations. */
const ALWAYS: SignupMissing[] = ['email', 'legal', 'captcha', 'default_plan', 'methods'];
const SOMETIMES: SignupMissing[] = ['mode'];

/** Where each missing requirement is fixed (`hasPlans`: a public plan exists — pick it here, else make one). */
export const missingTarget = (k: SignupMissing, hasPlans: boolean): ConsoleTarget =>
  ({
    email: 'email',
    captcha: 'captcha',
    default_plan: hasPlans ? 'signup-plan' : 'plans',
    methods: 'signup-methods',
    legal: 'legal',
    mode: 'signup-methods',
  })[k] as ConsoleTarget;

/**
 * The readiness list (canvas OwnerSettings): a ✓ or ✗ per requirement, from the server's `missing`; each ✗ links to
 * where it is fixed.
 */
export const SignupReadiness = ({
  missing,
  captcha,
  hasPlans = true,
}: {
  missing: SignupMissing[];
  captcha: boolean;
  hasPlans?: boolean;
}) => {
  const jump = useConsoleJump();
  const items = [
    ...ALWAYS.filter((k) => k !== 'captcha' || captcha || missing.includes('captcha')),
    ...SOMETIMES.filter((k) => missing.includes(k)),
  ];
  const n = missing.length;
  return (
    <div
      className={cn('flex flex-col gap-2 rounded-[12px] p-3', n ? 'bg-accent-soft' : 'bg-ok-soft')}
      data-testid="signup-readiness"
      data-missing={missing.join(' ')}
    >
      <span className={cn('text-[0.8125rem]', n ? 'text-accent-fg' : 'text-ok-fg')}>
        {n === 0 ? t('signup.ready.all') : n === 1 ? t('signup.ready.one') : t('signup.ready.many', { n })}
      </span>
      <ul className="grid grid-cols-2 gap-x-4 gap-y-1.5 max-md:grid-cols-1">
        {items.map((k) => {
          const ok = !missing.includes(k);
          return (
            <li
              key={k}
              data-testid={`signup-ready-${k}`}
              data-ok={ok}
              className={cn('flex items-center gap-2 text-[0.78125rem]', ok ? 'text-ok-fg' : 'text-danger-fg')}
            >
              <Icon name={ok ? 'check' : 'x'} size={14} strokeWidth={2.6} />
              {ok ? t(`signup.ready.${k}`) : t(`signup.missing.${k}`)}
              {ok ? null : (
                <button
                  type="button"
                  onClick={() => jump(missingTarget(k, hasPlans))}
                  data-testid={`signup-fix-${k}`}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  {t('signup.ready.fix')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/** A list of domains as chips: type and Enter (or ",") adds, ✕ removes. */
const DomainList = ({
  label,
  value,
  onChange,
  testId,
}: {
  label: string;
  value: string[];
  onChange: (v: string[]) => void;
  testId: string;
}) => {
  const [text, setText] = useState('');
  const add = () => {
    const parts = text
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
      .filter((d) => /^([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/.test(d));
    if (parts.length) onChange([...new Set([...value, ...parts])]);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    }
  };
  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <span className="text-xs font-semibold text-fg-2">{label}</span>
      <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-2 py-1 focus-within:border-primary">
        {value.map((d) => (
          <span
            key={d}
            className="inline-flex h-[22px] items-center gap-1 rounded-full bg-surface-2 ps-2 pe-1 text-xs text-fg-2"
            dir="ltr"
          >
            {d}
            <button
              type="button"
              aria-label={t('signup.settings.removeDomain', { domain: d })}
              onClick={() => onChange(value.filter((x) => x !== d))}
              className="grid size-4 place-items-center rounded-full hover:bg-surface-3"
            >
              <Icon name="x" size={10} />
            </button>
          </span>
        ))}
        <input
          value={text}
          dir="ltr"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          onBlur={add}
          placeholder={t('signup.settings.addDomain')}
          aria-label={label}
          data-testid={`${testId}-input`}
          className="min-w-[8rem] flex-1 bg-transparent text-sm text-fg placeholder:text-muted focus:outline-none"
        />
      </div>
    </div>
  );
};

/** A switch with its words beside it (the canvas `.tg`). */
const Toggle = ({
  label,
  checked,
  onChange,
  testId,
  disabled,
}: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  testId: string;
  disabled?: boolean;
}) => (
  <label className="flex items-center gap-2 text-[0.78125rem] text-fg">
    <Switch checked={checked} onChange={onChange} testId={testId} disabled={disabled} />
    {label}
  </label>
);

const numField = (s: string) => {
  const n = Number(s.trim());
  return s.trim() && Number.isInteger(n) && n >= 0 ? n : Number.NaN;
};

/**
 * Owner console → Plans → "הרשמה עצמית" (canvas OwnerSettings, screen 10): the switch with what is still missing
 * before it can be on, the trial and plan, the starter kit, the methods, manual approval, the protections and what
 * the trial ends in. Every value is the server's setting (GET / PATCH /platform/signup-settings); the suspension
 * delay is the billing settings' `read_only_days`.
 */
export const SignupSettingsCard = () => {
  const settings = useSignupSettings();
  const billing = useQuery({
    queryKey: billingKey,
    queryFn: () => api().get<BillingSettings>('/platform/billing-settings'),
  });
  if (settings.isPending || billing.isPending) return <SkeletonRows rows={3} label={t('app.loading')} />;
  if (settings.isError) return <Notice tone="error">{errorMessage(settings.error)}</Notice>;
  return (
    <SignupSettingsForm
      key={JSON.stringify(settings.data.settings)}
      data={settings.data}
      readOnlyDays={billing.data?.read_only_days ?? null}
    />
  );
};

const SignupSettingsForm = ({ data, readOnlyDays }: { data: SignupSettingsResponse; readOnlyDays: number | null }) => {
  const qc = useQueryClient();
  const plans = usePlans().data?.data ?? [];
  const kits = useKits().data?.data ?? [];
  const auth = useAuthConfig().data;
  const [s, setS] = useState<SignupSettings>(data.settings);
  const set = <K extends keyof SignupSettings>(k: K, v: SignupSettings[K]) => setS((cur) => ({ ...cur, [k]: v }));
  const [nums, setNums] = useState({
    trial_days: String(s.trial_days),
    rate_ip_hour: String(s.rate_ip_hour),
    rate_email_day: String(s.rate_email_day),
    daily_cap: String(s.daily_cap),
    link_hours: String(s.link_hours),
    resend_seconds: String(s.resend_seconds),
  });
  const [emailsOk, setEmailsOk] = useState(true);
  const [suspendDays, setSuspendDays] = useState(readOnlyDays === null ? '' : String(readOnlyDays));
  const offered = plans.filter(
    (p: SubscriptionPlan) => p.visibility === 'public' && !p.archived && p.current_version_id,
  );

  const save = useMutation({
    mutationFn: async () => {
      const days = suspendDays.trim() ? numField(suspendDays) : null;
      if (days !== readOnlyDays) await api().patch('/platform/billing-settings', { read_only_days: days });
      return api().patch<SignupSettingsResponse>('/platform/signup-settings', {
        ...s,
        emails: trialEmailsPatch(s.emails),
        trial_days: numField(nums.trial_days),
        rate_ip_hour: numField(nums.rate_ip_hour),
        rate_email_day: numField(nums.rate_email_day),
        daily_cap: numField(nums.daily_cap),
        link_hours: numField(nums.link_hours),
        resend_seconds: numField(nums.resend_seconds),
      });
    },
    onSuccess: async (res) => {
      qc.setQueryData(signupSettingsKey, res);
      await qc.invalidateQueries({ queryKey: billingKey });
      showToast({ message: t('plans.saved') });
    },
  });
  const valid =
    emailsOk &&
    Object.values(nums).every((v) => !Number.isNaN(numField(v))) &&
    (!suspendDays.trim() || !Number.isNaN(numField(suspendDays)));

  const statusChip = data.open ? (
    <Badge tone="ok">{t('signup.settings.state.open')}</Badge>
  ) : data.settings.enabled ? (
    <Badge tone="danger">{t('signup.settings.state.unavailable')}</Badge>
  ) : (
    <Badge>{t('signup.settings.state.off')}</Badge>
  );
  const methodOn = (m: SignupMethod) => s.methods.includes(m);
  const providerReady = (m: SignupMethod) => m === 'password' || !!auth?.[m];
  const numInput = (k: keyof typeof nums, label: string) => (
    <Field label={label}>
      <Input
        inputMode="numeric"
        dir="ltr"
        className="text-end"
        value={nums[k]}
        onChange={(e) => setNums((cur) => ({ ...cur, [k]: e.target.value }))}
        data-testid={`signup-set-${k}`}
      />
    </Field>
  );
  const sub = 'flex flex-col gap-3 border-t border-line-soft pt-3.5';
  const h3 = 'text-[0.8125rem] text-fg';
  const hint = 'max-w-[640px] text-xs leading-normal text-muted';

  return (
    <section
      className="flex flex-col gap-3.5 rounded-[16px] border border-line bg-surface p-4"
      data-testid="signup-settings"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className={h3}>{t('signup.settings.title')}</h3>
            <span data-testid="signup-settings-state">{statusChip}</span>
          </div>
          <p className={cn(hint, 'mt-0.5')}>{t('signup.settings.hint')}</p>
        </div>
        <label className="flex shrink-0 items-center gap-2 text-[0.8125rem] text-fg">
          {t('signup.settings.enabled')}
          <Switch checked={s.enabled} onChange={(on) => set('enabled', on)} testId="signup-set-enabled" />
        </label>
      </div>

      <SignupReadiness missing={data.missing} captcha={s.require_captcha} hasPlans={offered.length > 0} />

      <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
        {numInput('trial_days', t('signup.settings.trialDays'))}
        <Field label={t('signup.settings.defaultPlan')}>
          <Picker
            label={t('signup.settings.defaultPlan')}
            value={s.default_plan_id ?? ''}
            placeholder={t('signup.settings.noPlan')}
            onChange={(v) => set('default_plan_id', v || null)}
            testId="signup-set-plan"
            options={offered.map((p) => ({ value: p.id, label: p.name, testId: `signup-set-plan-${p.id}` }))}
          />
        </Field>
        <Field label={t('owner.accounts.templateSet')}>
          <Picker
            label={t('owner.accounts.templateSet')}
            value={s.starter_kit}
            onChange={(v) => set('starter_kit', v)}
            testId="signup-set-kit"
            options={[
              { value: 'empty', label: t('owner.accounts.templateSet.empty') },
              ...kits.map((k) => ({ value: k.key, label: `${k.icon ? `${k.icon} ` : ''}${kitName(k)}` })),
            ]}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-5">
        <Toggle
          label={t('signup.settings.choosePlan')}
          checked={s.choose_plan}
          onChange={(v) => set('choose_plan', v)}
          testId="signup-set-choose-plan"
        />
        <Toggle
          label={t('signup.settings.notify')}
          checked={s.notify_owner}
          onChange={(v) => set('notify_owner', v)}
          testId="signup-set-notify"
        />
        <Toggle
          label={t('signup.settings.approval')}
          checked={s.approval}
          onChange={(v) => set('approval', v)}
          testId="signup-set-approval"
        />
      </div>

      <OnboardingFields
        value={s.onboarding}
        onChange={(v) => set('onboarding', v)}
        className={sub}
        h3={h3}
        hint={hint}
      />

      <div className={sub} data-testid="signup-set-methods">
        <h3 className={h3}>{t('signup.settings.methods')}</h3>
        <div className="flex flex-wrap gap-2">
          {SIGNUP_METHODS.map((m) => {
            const on = methodOn(m);
            const ready = providerReady(m);
            return (
              <button
                key={m}
                type="button"
                aria-pressed={on}
                disabled={!ready && !on}
                onClick={() => set('methods', on ? s.methods.filter((x) => x !== m) : [...s.methods, m])}
                data-testid={`signup-set-method-${m}`}
                className={cn(
                  'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[0.78125rem] disabled:cursor-not-allowed disabled:opacity-50',
                  on ? 'bg-primary-soft text-heading' : 'border border-line-strong text-fg-2',
                )}
              >
                {on ? <Icon name="check" size={12} strokeWidth={3} /> : null}
                {t(`signup.method.${m}`)}
              </button>
            );
          })}
        </div>
        <p className={hint}>{t('signup.settings.methodsHint')}</p>
        <Segmented
          label={t('signup.settings.mode')}
          value={s.mode}
          onChange={(v) => set('mode', v)}
          options={[
            { value: 'open', label: t('signup.settings.mode.open'), testId: 'signup-set-mode-open' },
            {
              value: 'domain_join',
              label: t('signup.settings.mode.domainJoin'),
              testId: 'signup-set-mode-domain',
              disabled: s.mode !== 'domain_join',
            },
          ]}
          className="self-start"
        />
      </div>

      <div className={sub}>
        <h3 className={h3}>{t('signup.settings.protection')}</h3>
        <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
          {numInput('rate_ip_hour', t('signup.settings.rateIp'))}
          {numInput('rate_email_day', t('signup.settings.rateEmail'))}
          {numInput('daily_cap', t('signup.settings.dailyCap'))}
          {numInput('link_hours', t('signup.settings.linkHours'))}
          {numInput('resend_seconds', t('signup.settings.resendSeconds'))}
        </div>
        <div className="flex flex-wrap gap-5">
          <Toggle
            label={t('signup.settings.captcha')}
            checked={s.require_captcha}
            onChange={(v) => set('require_captcha', v)}
            testId="signup-set-captcha"
          />
          <Toggle
            label={t('signup.settings.disposable')}
            checked={s.block_disposable}
            onChange={(v) => set('block_disposable', v)}
            testId="signup-set-disposable"
          />
          <Toggle
            label={t('signup.settings.workEmail')}
            checked={s.require_work_email}
            onChange={(v) => set('require_work_email', v)}
            testId="signup-set-work-email"
          />
        </div>
        <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
          <DomainList
            label={t('signup.settings.allow')}
            value={s.domain_allow}
            onChange={(v) => set('domain_allow', v)}
            testId="signup-set-allow"
          />
          <DomainList
            label={t('signup.settings.block')}
            value={s.domain_block}
            onChange={(v) => set('domain_block', v)}
            testId="signup-set-block"
          />
          {s.block_disposable ? (
            <DomainList
              label={t('signup.settings.disposableExtra')}
              value={s.disposable_domains}
              onChange={(v) => set('disposable_domains', v)}
              testId="signup-set-disposable-list"
            />
          ) : null}
        </div>
      </div>

      <div className={sub}>
        <h3 className={h3}>{t('signup.settings.trialEnd')}</h3>
        <p className={hint}>{t(`signup.settings.trialEnd.${s.trial_end_status}`)}</p>
        <Segmented
          label={t('signup.settings.trialEnd')}
          value={s.trial_end_status}
          onChange={(v) => set('trial_end_status', v)}
          className="self-start"
          options={SIGNUP_TRIAL_END_STATUSES.map((v) => ({
            value: v,
            label: t(`plan.status.${v}`),
            testId: `signup-set-trial-end-${v}`,
          }))}
        />
        <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
          <Field label={t('signup.settings.suspendAfter')} hint={t('plans.emptyNever')}>
            <Input
              inputMode="numeric"
              dir="ltr"
              className="text-end"
              value={suspendDays}
              onChange={(e) => setSuspendDays(e.target.value)}
              data-testid="signup-set-suspend-days"
            />
          </Field>
          <Field label={t('signup.settings.close')}>
            <Input readOnly value={t('signup.settings.closeManual')} className="bg-surface-3 text-muted focus:ring-0" />
          </Field>
        </div>
      </div>

      <TrialEmailsSection value={s.emails} onChange={(v) => set('emails', v)} onValid={setEmailsOk} />

      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      <div className="flex justify-end">
        <Button
          variant="primary"
          busy={save.isPending}
          disabled={!valid}
          onClick={() => save.mutate()}
          data-testid="signup-settings-save"
        >
          {t('signup.settings.save')}
        </Button>
      </div>
    </section>
  );
};

/**
 * "How to start?" after sign-up: the start screen on / off, "Build with AI" and what the platform
 * pays for it per account, and the quick picks (empty = the built-in ones in the reader's language).
 */
const OnboardingFields = ({
  value,
  onChange,
  className,
  h3,
  hint,
}: {
  value: SignupSettings['onboarding'];
  onChange: (v: SignupSettings['onboarding']) => void;
  className: string;
  h3: string;
  hint: string;
}) => {
  const [cap, setCap] = useState(String(value.ai_cap_usd));
  const [chip, setChip] = useState('');
  const addChip = () => {
    const c = chip.trim().slice(0, 40);
    if (!c || value.chips.includes(c) || value.chips.length >= 12) return;
    onChange({ ...value, chips: [...value.chips, c] });
    setChip('');
  };
  return (
    <div className={className} data-testid="signup-set-onboarding">
      <h3 className={h3}>{t('signup.settings.onboarding.title')}</h3>
      <p className={hint}>{t('signup.settings.onboarding.hint')}</p>
      <div className="flex flex-wrap gap-5">
        <Toggle
          label={t('signup.settings.onboarding.enabled')}
          checked={value.enabled}
          onChange={(enabled) => onChange({ ...value, enabled })}
          testId="signup-set-onboarding-enabled"
        />
        <Toggle
          label={t('signup.settings.onboarding.ai')}
          checked={value.ai}
          onChange={(ai) => onChange({ ...value, ai })}
          testId="signup-set-onboarding-ai"
        />
      </div>
      <div className="grid grid-cols-3 gap-3 max-md:grid-cols-1">
        <Field label={t('signup.settings.onboarding.cap')} hint={t('signup.settings.onboarding.capHint')}>
          <Input
            inputMode="decimal"
            dir="ltr"
            className="text-end"
            value={cap}
            onChange={(e) => {
              setCap(e.target.value);
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 0 && n <= 20) onChange({ ...value, ai_cap_usd: n });
            }}
            data-testid="signup-set-onboarding-cap"
          />
        </Field>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-fg-2">{t('signup.settings.onboarding.chips')}</span>
        <div className="flex flex-wrap gap-2">
          {value.chips.map((c) => (
            <span
              key={c}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-primary-soft ps-2.5 pe-1 text-[0.78125rem] text-heading"
            >
              {c}
              <button
                type="button"
                aria-label={t('signup.settings.onboarding.removeChip', { chip: c })}
                onClick={() => onChange({ ...value, chips: value.chips.filter((x) => x !== c) })}
                className="flex size-5 items-center justify-center rounded-full hover:bg-surface"
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          {!value.chips.length ? (
            <span className="text-xs text-muted">{t('signup.settings.onboarding.chipsDefault')}</span>
          ) : null}
        </div>
        <div className="flex max-w-[420px] gap-2">
          <Input
            value={chip}
            maxLength={40}
            placeholder={t('signup.settings.onboarding.chipPlaceholder')}
            onChange={(e) => setChip(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addChip();
              }
            }}
            data-testid="signup-set-onboarding-chip"
          />
          <Button variant="secondary" onClick={addChip} disabled={!chip.trim() || value.chips.length >= 12}>
            {t('signup.settings.onboarding.addChip')}
          </Button>
        </div>
      </div>
    </div>
  );
};
