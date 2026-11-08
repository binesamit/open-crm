// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AccountPlan,
  type BillingSettings,
  formatCurrency,
  isPlanFeatureKey,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KINDS,
  type PlanLimitKind,
  type PlanLimits,
  type PlanVersion,
  type PlanVersionInput,
  PLAN_USAGE_PERIODS,
  SUBSCRIPTION_STATUSES,
  type Subscription,
  type SubscriptionPlan,
  type SubscriptionStatus,
  t,
} from '@bines/shared';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  Picker,
  Segmented,
  SkeletonRows,
  Switch,
} from '@bines/ui';
import { api, errorMessage, type PlatformAccount } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { featureLabel, PlanHistory, PlanSummary, STATUS_TONE } from '../admin/AdminPlan';
import { PlanPaymentsCard } from './PlanPaymentsCard';
import { AddonsCard, PricingPageCard, useAddons } from './PricingCards';

export const plansKey = ['platform', 'plans'] as const;
export const subscriptionsKey = ['platform', 'subscriptions'] as const;
const settingsKey = ['platform', 'billing-settings'] as const;
const accountPlanKey = (id: string) => ['platform', 'accounts', id, 'subscription'] as const;

const textarea =
  'min-h-20 w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none focus:ring-3 focus:ring-[var(--accent-soft)]';

/** A number typed in a text field ("" = none). `null` = empty, NaN = invalid. */
const num = (s: string): number | null => {
  const v = s.trim().replace(',', '.');
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
};
const str = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

export const usePlans = () =>
  useQuery({ queryKey: plansKey, queryFn: () => api().get<{ data: SubscriptionPlan[] }>('/platform/plans') });
export const useSubscriptions = () =>
  useQuery({
    queryKey: subscriptionsKey,
    queryFn: () => api().get<{ data: Subscription[] }>('/platform/subscriptions'),
  });
const useBillingSettings = () =>
  useQuery({ queryKey: settingsKey, queryFn: () => api().get<BillingSettings>('/platform/billing-settings') });

const priceLine = (v: PlanVersion) =>
  `${formatCurrency(v.price_monthly, v.currency)} / ${t('plan.interval.month')} · ${formatCurrency(v.price_yearly, v.currency)} / ${t('plan.interval.year')}${v.pricing === 'per_seat' ? ` · ${t('plans.perSeat')}` : ''}`;
const limitsLine = (l: PlanLimits) =>
  PLAN_LIMIT_KINDS.filter((k) => l[k] !== null && l[k] !== undefined)
    .map((k) => `${t(`plan.kind.${k}`)}: ${l[k]}`)
    .join(' · ') || t('plan.unlimited');

/**
 * Owner console → חבילות: the plans editor — plans, their versions (prices, limits, features
 * trial), a new version for a new price (accounts on older versions keep theirs) — and the billing settings.
 * Nothing is built in: every plan, price and limit is written here.
 */
export const PlansPanel = () => {
  const plans = usePlans();
  const [editing, setEditing] = useState<
    | { mode: 'new' }
    | { mode: 'plan'; plan: SubscriptionPlan }
    | { mode: 'version'; plan: SubscriptionPlan; version?: PlanVersion }
    | null
  >(null);
  const rows = plans.data?.data ?? [];
  return (
    <section className="space-y-2.5" data-testid="owner-plans">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-0.5">
          <h2 className="font-display text-base font-bold text-heading">{t('plans.title')}</h2>
          <p className="max-w-[640px] text-xs text-muted">{t('plans.hint')}</p>
        </div>
        <Button variant="accent" size="sm" data-testid="plan-new" onClick={() => setEditing({ mode: 'new' })}>
          {t('plans.new')}
        </Button>
      </header>
      {plans.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {plans.isError ? <Notice tone="error">{errorMessage(plans.error)}</Notice> : null}
      {plans.data && !rows.length ? <EmptyState title={t('plans.empty')} testId="plans-empty" /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((p) => (
          <PlanCard key={p.id} plan={p} onEdit={setEditing} />
        ))}
      </div>
      {editing?.mode === 'new' || editing?.mode === 'plan' ? (
        <PlanDialog plan={editing.mode === 'plan' ? editing.plan : undefined} onClose={() => setEditing(null)} />
      ) : null}
      {editing?.mode === 'version' ? (
        <VersionDialog plan={editing.plan} version={editing.version} onClose={() => setEditing(null)} />
      ) : null}
      {/* The pricing page: add-ons and the page's own settings. */}
      <AddonsCard />
      <PricingPageCard />
      {/* Self sign-up ה9: paid upgrades through Stripe (the license purchase's keys). */}
      <PlanPaymentsCard />
      <BillingSettingsCard />
    </section>
  );
};

type EditTarget =
  { mode: 'plan'; plan: SubscriptionPlan } | { mode: 'version'; plan: SubscriptionPlan; version?: PlanVersion };

const PlanCard = ({ plan, onEdit }: { plan: SubscriptionPlan; onEdit: (e: EditTarget) => void }) => {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: plansKey });
  const archive = useMutation({
    mutationFn: () => api().patch(`/platform/plans/${plan.id}`, { archived: !plan.archived }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api().delete(`/platform/plans/${plan.id}`),
    onSuccess: refresh,
  });
  const used = plan.versions.some((v) => v.locked);
  const error = archive.error ?? remove.error;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-2" data-testid="plan-card" data-name={plan.name}>
        <div className="min-w-0 flex-1 space-y-0.5">
          <h3 className="font-display text-base font-extrabold text-heading">{plan.name}</h3>
          {plan.description ? <p className="text-xs text-muted">{plan.description}</p> : null}
        </div>
        <Badge tone={plan.visibility === 'public' ? 'ok' : 'neutral'}>{t(`plans.visibility.${plan.visibility}`)}</Badge>
        {plan.archived ? <Badge tone="warn">{t('plans.archived')}</Badge> : null}
      </div>
      <ul className="flex flex-col gap-2">
        {[...plan.versions].reverse().map((v) => (
          <li
            key={v.id}
            className="rounded-[10px] border border-line-soft px-3 py-2 text-xs"
            data-testid="plan-version"
            data-version={v.version}
            data-locked={v.locked ? 'true' : 'false'}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-fg">{t('plan.version', { n: v.version })}</span>
              {v.id === plan.current_version_id ? <Badge tone="info">{t('plans.current')}</Badge> : null}
              <span className="text-muted">{t('plans.subscribers', { n: v.subscribers })}</span>
              <span className="flex-1" />
              {!v.locked ? (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="plan-version-edit"
                  onClick={() => onEdit({ mode: 'version', plan, version: v })}
                >
                  {t('plans.edit')}
                </Button>
              ) : (
                <span className="text-muted" title={t('plans.lockedHint')}>
                  {t('plans.locked')}
                </span>
              )}
            </div>
            <p className="mt-1 text-fg-2" dir="auto">
              {priceLine(v)}
            </p>
            <p className="text-muted">{limitsLine(v.limits)}</p>
            {v.trial_days ? <p className="text-muted">{t('plans.trialDays', { n: v.trial_days })}</p> : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          size="sm"
          data-testid="plan-add-version"
          onClick={() => onEdit({ mode: 'version', plan })}
        >
          {t('plans.newVersion')}
        </Button>
        <Button variant="ghost" size="sm" data-testid="plan-edit" onClick={() => onEdit({ mode: 'plan', plan })}>
          {t('plans.editPlan')}
        </Button>
        <Button variant="ghost" size="sm" busy={archive.isPending} onClick={() => archive.mutate()}>
          {t(plan.archived ? 'plans.unarchive' : 'plans.archive')}
        </Button>
        {!used ? (
          <Button
            variant="danger-outline"
            size="sm"
            busy={remove.isPending}
            data-testid="plan-delete"
            onClick={() =>
              void confirmDialog({
                title: t('plans.deleteTitle', { name: plan.name }),
                message: t('plans.deleteBody'),
                danger: true,
              }).then((ok) => ok && remove.mutate())
            }
          >
            {t('plans.delete')}
          </Button>
        ) : null}
      </div>
      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
    </Card>
  );
};

/** The fields of a version (prices, limits, features, trial) — a new plan's first version or any later one. */
type VersionDraft = {
  price_monthly: string;
  price_yearly: string;
  currency: string;
  vat_included: boolean;
  pricing: 'flat' | 'per_seat';
  trial_days: string;
  limits: Record<PlanLimitKind, string>;
  features: string[];
};
const draftOf = (v?: PlanVersion): VersionDraft => ({
  price_monthly: str(v?.price_monthly ?? 0),
  price_yearly: str(v?.price_yearly ?? 0),
  currency: v?.currency ?? 'ILS',
  vat_included: v?.vat_included ?? true,
  pricing: v?.pricing ?? 'flat',
  trial_days: str(v?.trial_days ?? 0),
  limits: Object.fromEntries(PLAN_LIMIT_KINDS.map((k) => [k, str(v?.limits[k])])) as Record<PlanLimitKind, string>,
  features: v?.features ?? [],
});
const inputOf = (d: VersionDraft): PlanVersionInput | null => {
  const pm = num(d.price_monthly) ?? 0;
  const py = num(d.price_yearly) ?? 0;
  const trial = num(d.trial_days) ?? 0;
  const limits = Object.fromEntries(PLAN_LIMIT_KINDS.map((k) => [k, num(d.limits[k])])) as Record<
    string,
    number | null
  >;
  if ([pm, py, trial, ...Object.values(limits).filter((v) => v !== null)].some((v) => Number.isNaN(v))) return null;
  if (!/^[A-Z]{3}$/.test(d.currency.trim().toUpperCase())) return null;
  return {
    price_monthly: pm,
    price_yearly: py,
    currency: d.currency.trim().toUpperCase(),
    vat_included: d.vat_included,
    pricing: d.pricing,
    trial_days: Math.round(trial),
    limits: limits as PlanLimits,
    features: d.features,
  };
};

const VersionFields = ({ draft, onChange }: { draft: VersionDraft; onChange: (d: VersionDraft) => void }) => {
  const settings = useBillingSettings();
  const catalogue = settings.data?.features ?? [];
  // Plans: the gated features always (the catalogue may relabel them), then the owner's own keys.
  const labels = new Map(catalogue.map((f) => [f.key, f.label]));
  const options = [
    ...PLAN_FEATURE_KEYS.map((key) => ({ key, label: featureLabel(key, labels) })),
    ...catalogue.filter((f) => !isPlanFeatureKey(f.key)),
  ];
  const set = (patch: Partial<VersionDraft>) => onChange({ ...draft, ...patch });
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Field label={t('plans.priceMonthly')}>
          <Input
            inputMode="decimal"
            dir="ltr"
            data-testid="plan-price-monthly"
            value={draft.price_monthly}
            onChange={(e) => set({ price_monthly: e.target.value })}
          />
        </Field>
        <Field label={t('plans.priceYearly')}>
          <Input
            inputMode="decimal"
            dir="ltr"
            data-testid="plan-price-yearly"
            value={draft.price_yearly}
            onChange={(e) => set({ price_yearly: e.target.value })}
          />
        </Field>
        <Field label={t('plans.currency')}>
          <Input
            dir="ltr"
            maxLength={3}
            data-testid="plan-currency"
            value={draft.currency}
            onChange={(e) => set({ currency: e.target.value.toUpperCase() })}
          />
        </Field>
        <Field label={t('plans.trial')}>
          <Input
            inputMode="numeric"
            dir="ltr"
            data-testid="plan-trial"
            value={draft.trial_days}
            onChange={(e) => set({ trial_days: e.target.value })}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Segmented<'flat' | 'per_seat'>
          label={t('plans.pricing')}
          value={draft.pricing}
          onChange={(pricing) => set({ pricing })}
          testId="plan-pricing"
          options={[
            { value: 'flat', label: t('plans.flat') },
            { value: 'per_seat', label: t('plans.perSeat') },
          ]}
        />
        <label className="flex items-center gap-2 text-sm text-fg">
          <Switch checked={draft.vat_included} onChange={(vat_included) => set({ vat_included })} testId="plan-vat" />
          {t('plans.vatIncluded')}
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold text-fg-2">{t('plans.limits')}</legend>
        <p className="text-xs text-muted">{t('plans.limitsHint')}</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {PLAN_LIMIT_KINDS.map((k) => (
            <Field key={k} label={t(`plan.kind.${k}`)}>
              <Input
                inputMode="decimal"
                dir="ltr"
                placeholder="∞"
                data-testid={`plan-limit-${k}`}
                value={draft.limits[k]}
                onChange={(e) => set({ limits: { ...draft.limits, [k]: e.target.value } })}
              />
            </Field>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold text-fg-2">{t('plans.features')}</legend>
        <p className="text-xs text-muted">{t('plans.featuresAllHint')}</p>
        {options.length ? (
          <div className="flex flex-wrap gap-3">
            {options.map((f) => (
              <label key={f.key} className="flex items-center gap-2 text-sm text-fg">
                <Switch
                  checked={draft.features.includes(f.key)}
                  testId={`plan-feature-${f.key}`}
                  onChange={(on) =>
                    set({ features: on ? [...draft.features, f.key] : draft.features.filter((x) => x !== f.key) })
                  }
                />
                {f.label}
              </label>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">{t('plans.noFeatures')}</p>
        )}
      </fieldset>
    </div>
  );
};

const PlanDialog = ({ plan, onClose }: { plan?: SubscriptionPlan; onClose: () => void }) => {
  const qc = useQueryClient();
  const [name, setName] = useState(plan?.name ?? '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [visibility, setVisibility] = useState<'public' | 'hidden'>(plan?.visibility ?? 'public');
  const [sort, setSort] = useState(str(plan?.sort ?? 0));
  // The pricing page: selling points (one per line), the "recommended" mark, a per-seat minimum.
  const [highlights, setHighlights] = useState((plan?.highlights ?? []).join('\n'));
  const [recommended, setRecommended] = useState(plan?.recommended ?? false);
  const [minSeats, setMinSeats] = useState(str(plan?.min_seats));
  const [draft, setDraft] = useState<VersionDraft>(() => draftOf());
  const save = useMutation({
    mutationFn: () => {
      const base = {
        name: name.trim(),
        description: description.trim() || null,
        visibility,
        sort: Math.round(num(sort) ?? 0),
        highlights: highlights
          .split('\n')
          .map((h) => h.trim())
          .filter(Boolean)
          .slice(0, 12),
        recommended,
        min_seats: num(minSeats) ? Math.max(1, Math.round(num(minSeats)!)) : null,
      };
      if (plan) return api().patch(`/platform/plans/${plan.id}`, base);
      return api().post('/platform/plans', {
        ...base,
        description: base.description ?? undefined,
        version: inputOf(draft),
      });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: plansKey });
      showToast({ message: t('plans.saved') });
      onClose();
    },
  });
  const valid = !!name.trim() && !Number.isNaN(num(sort)) && !Number.isNaN(num(minSeats)) && (plan || inputOf(draft));
  return (
    <Dialog open onClose={onClose} title={t(plan ? 'plans.editPlan' : 'plans.new')} className="max-w-2xl!">
      <form
        className="flex flex-col gap-3"
        data-testid="plan-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) save.mutate();
        }}
      >
        <Field label={t('plans.name')}>
          <Input required data-testid="plan-name-input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('plans.description')}>
          <textarea className={textarea} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="flex flex-wrap items-end gap-4">
          <Segmented<'public' | 'hidden'>
            label={t('plans.visibility')}
            value={visibility}
            onChange={setVisibility}
            options={[
              { value: 'public', label: t('plans.visibility.public') },
              { value: 'hidden', label: t('plans.visibility.hidden') },
            ]}
          />
          <Field label={t('plans.sort')}>
            <Input
              inputMode="numeric"
              dir="ltr"
              className="w-24"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            />
          </Field>
        </div>
        <fieldset className="flex flex-col gap-3 rounded-[12px] border border-line p-3" data-testid="plan-marketing">
          <legend className="px-1 text-xs text-fg-2">{t('plans.marketing')}</legend>
          <Field label={t('plans.highlights')} hint={t('plans.highlightsHint')}>
            <textarea
              className={textarea}
              data-testid="plan-highlights"
              value={highlights}
              onChange={(e) => setHighlights(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex items-center gap-2 text-[0.8125rem] text-fg">
              <Switch checked={recommended} onChange={setRecommended} testId="plan-recommended" />
              {t('plans.recommended')}
            </label>
            <Field label={t('plans.minSeats')} hint={t('plans.minSeatsHint')}>
              <Input
                inputMode="numeric"
                dir="ltr"
                className="w-24"
                data-testid="plan-min-seats"
                value={minSeats}
                onChange={(e) => setMinSeats(e.target.value)}
              />
            </Field>
          </div>
        </fieldset>
        {!plan ? <VersionFields draft={draft} onChange={setDraft} /> : null}
        {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="accent" disabled={!valid} busy={save.isPending} data-testid="plan-save">
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

/** A new version (prefilled from the current one) or an edit of a version no account ever had. */
const VersionDialog = ({
  plan,
  version,
  onClose,
}: {
  plan: SubscriptionPlan;
  version?: PlanVersion;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const current = plan.versions.find((v) => v.id === plan.current_version_id);
  const [draft, setDraft] = useState<VersionDraft>(() => draftOf(version ?? current));
  const save = useMutation({
    mutationFn: () =>
      version
        ? api().patch(`/platform/plan-versions/${version.id}`, inputOf(draft))
        : api().post(`/platform/plans/${plan.id}/versions`, inputOf(draft)),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: plansKey });
      showToast({ message: t('plans.saved') });
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={version ? t('plans.editVersion', { n: version.version }) : t('plans.newVersion')}
      subtitle={plan.name}
      className="max-w-2xl!"
    >
      <form
        className="flex flex-col gap-3"
        data-testid="plan-version-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (inputOf(draft)) save.mutate();
        }}
      >
        {!version ? <Notice tone="info">{t('plans.grandfatherHint')}</Notice> : null}
        <VersionFields draft={draft} onChange={setDraft} />
        {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="accent"
            disabled={!inputOf(draft)}
            busy={save.isPending}
            data-testid="plan-version-save"
          >
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

/** Owner console → חבילות → settings: warning share, grace periods, upgrade text / link, feature catalogue. */
const BillingSettingsCard = () => {
  const settings = useBillingSettings();
  if (settings.isPending) return <SkeletonRows rows={2} label={t('app.loading')} />;
  if (settings.isError) return <Notice tone="error">{errorMessage(settings.error)}</Notice>;
  return <BillingSettingsForm key={JSON.stringify(settings.data)} s={settings.data} />;
};

const BillingSettingsForm = ({ s }: { s: BillingSettings }) => {
  const qc = useQueryClient();
  const [warn, setWarn] = useState(str(s.warn_pct));
  const [grace, setGrace] = useState(str(s.past_due_grace_days));
  const [readOnlyDays, setReadOnlyDays] = useState(str(s.read_only_days));
  const [trialEnd, setTrialEnd] = useState(s.trial_end_status);
  const [canceled, setCanceled] = useState(s.canceled_status);
  const [text, setText] = useState(s.upgrade_text ?? '');
  const [url, setUrl] = useState(s.upgrade_url ?? '');
  // plan-lock: the closed-account screen's text and where "contact us" goes.
  const [closedText, setClosedText] = useState(s.closed_text ?? '');
  const [contactUrl, setContactUrl] = useState(s.contact_url ?? '');
  const [features, setFeatures] = useState(s.features);
  const [usagePeriod, setUsagePeriod] = useState(s.usage_period);
  // Cancelling and renewing: the numbers the cancel screen and the subscription terms use.
  const [coolingOff, setCoolingOff] = useState(str(s.cooling_off_days));
  const [feePct, setFeePct] = useState(str(s.cancel_fee_pct));
  const [feeCap, setFeeCap] = useState(str(s.cancel_fee_cap));
  const [yearlyRefund, setYearlyRefund] = useState(s.yearly_refund);
  const [reminder, setReminder] = useState(str(s.renewal_reminder_days));
  const [changeNotice, setChangeNotice] = useState(str(s.change_notice_days));
  const save = useMutation({
    mutationFn: () =>
      api().patch<BillingSettings>('/platform/billing-settings', {
        warn_pct: Math.round(num(warn) ?? 80),
        past_due_grace_days: num(grace),
        read_only_days: num(readOnlyDays),
        trial_end_status: trialEnd,
        canceled_status: canceled,
        upgrade_text: text.trim() || null,
        upgrade_url: url.trim() || null,
        closed_text: closedText.trim() || null,
        contact_url: contactUrl.trim() || null,
        features: features.filter((f) => f.key && f.label),
        usage_period: usagePeriod,
        cooling_off_days: Math.round(num(coolingOff) ?? 0),
        cancel_fee_pct: num(feePct) ?? 0,
        cancel_fee_cap: num(feeCap),
        yearly_refund: yearlyRefund,
        renewal_reminder_days: num(reminder) === null ? null : Math.max(1, Math.round(num(reminder)!)),
        change_notice_days: Math.min(365, Math.max(1, Math.round(num(changeNotice) ?? 30))),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: settingsKey });
      showToast({ message: t('plans.saved') });
    },
  });
  const ok =
    [warn, grace, readOnlyDays, coolingOff, feePct, feeCap, reminder, changeNotice].every(
      (v) => !Number.isNaN(num(v)),
    ) &&
    (num(feePct) ?? 0) <= 100 &&
    (!url.trim() || /^https?:\/\/\S+$/.test(url.trim())) &&
    (!contactUrl.trim() || /^(https?:\/\/|mailto:)\S+$/i.test(contactUrl.trim())) &&
    features.every((f) => /^[a-z][a-z0-9_]{0,39}$/.test(f.key) && f.label.trim());
  return (
    <div data-testid="billing-settings">
      <Card className="flex flex-col gap-3">
        <div className="space-y-0.5">
          <h3 className="font-display text-base font-bold text-heading">{t('plans.settings')}</h3>
          <p className="text-xs text-muted">{t('plans.settingsHint')}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field label={t('plans.warnPct')}>
            <Input
              inputMode="numeric"
              dir="ltr"
              data-testid="billing-warn"
              value={warn}
              onChange={(e) => setWarn(e.target.value)}
            />
          </Field>
          <Field label={t('plans.graceDays')} hint={t('plans.emptyNever')}>
            <Input
              inputMode="numeric"
              dir="ltr"
              data-testid="billing-grace"
              value={grace}
              onChange={(e) => setGrace(e.target.value)}
            />
          </Field>
          <Field label={t('plans.readOnlyDays')} hint={t('plans.emptyNever')}>
            <Input
              inputMode="numeric"
              dir="ltr"
              data-testid="billing-read-only-days"
              value={readOnlyDays}
              onChange={(e) => setReadOnlyDays(e.target.value)}
            />
          </Field>
        </div>
        <div className="flex flex-wrap gap-6">
          <div className="space-y-1.5">
            <span className="block text-xs font-semibold text-fg-2">{t('plans.trialEnd')}</span>
            <Segmented<BillingSettings['trial_end_status']>
              label={t('plans.trialEnd')}
              value={trialEnd}
              onChange={setTrialEnd}
              options={(['active', 'past_due', 'read_only'] as const).map((v) => ({
                value: v,
                label: t(`plan.status.${v}`),
              }))}
            />
          </div>
          <div className="space-y-1.5">
            <span className="block text-xs font-semibold text-fg-2">{t('plans.afterCancel')}</span>
            <Segmented<BillingSettings['canceled_status']>
              label={t('plans.afterCancel')}
              value={canceled}
              onChange={setCanceled}
              options={(['read_only', 'suspended'] as const).map((v) => ({ value: v, label: t(`plan.status.${v}`) }))}
            />
          </div>
          <div className="space-y-1.5" data-testid="billing-usage-period">
            <span className="block text-xs font-semibold text-fg-2">{t('plans.usagePeriod')}</span>
            <Segmented<BillingSettings['usage_period']>
              label={t('plans.usagePeriod')}
              value={usagePeriod}
              onChange={setUsagePeriod}
              options={PLAN_USAGE_PERIODS.map((v) => ({ value: v, label: t(`plans.usagePeriod.${v}`) }))}
            />
            <p className="text-xs text-muted">{t('plans.usagePeriodHint')}</p>
          </div>
        </div>
        <fieldset className="space-y-2" data-testid="billing-cancel-settings">
          <legend className="text-xs font-semibold text-fg-2">{t('plans.cancel.title')}</legend>
          <p className="text-xs text-muted">{t('plans.cancel.hint')}</p>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
            <Field label={t('plans.cancel.coolingOff')} hint={t('plans.cancel.coolingOffHint')}>
              <Input
                inputMode="numeric"
                dir="ltr"
                data-testid="billing-cooling-off"
                value={coolingOff}
                onChange={(e) => setCoolingOff(e.target.value)}
              />
            </Field>
            <Field label={t('plans.cancel.feePct')}>
              <Input
                inputMode="decimal"
                dir="ltr"
                data-testid="billing-fee-pct"
                value={feePct}
                onChange={(e) => setFeePct(e.target.value)}
              />
            </Field>
            <Field label={t('plans.cancel.feeCap')} hint={t('plans.cancel.feeCapHint')}>
              <Input
                inputMode="decimal"
                dir="ltr"
                data-testid="billing-fee-cap"
                value={feeCap}
                onChange={(e) => setFeeCap(e.target.value)}
              />
            </Field>
            <Field label={t('plans.cancel.reminder')} hint={t('plans.cancel.reminderHint')}>
              <Input
                inputMode="numeric"
                dir="ltr"
                data-testid="billing-renewal-reminder"
                value={reminder}
                onChange={(e) => setReminder(e.target.value)}
              />
            </Field>
            <Field label={t('plans.cancel.changeNotice')} hint={t('plans.cancel.changeNoticeHint')}>
              <Input
                inputMode="numeric"
                dir="ltr"
                data-testid="billing-change-notice"
                value={changeNotice}
                onChange={(e) => setChangeNotice(e.target.value)}
              />
            </Field>
          </div>
          <div className="space-y-1.5">
            <span className="block text-xs font-semibold text-fg-2">{t('plans.cancel.yearly')}</span>
            <Segmented<BillingSettings['yearly_refund']>
              label={t('plans.cancel.yearly')}
              value={yearlyRefund}
              onChange={setYearlyRefund}
              options={(['monthly_rate', 'pro_rata', 'none'] as const).map((v) => ({
                value: v,
                label: t(`plans.cancel.yearly.${v}`),
                testId: `billing-yearly-${v}`,
              }))}
            />
            <p className="text-xs text-muted">{t(`plans.cancel.yearlyHint.${yearlyRefund}`)}</p>
          </div>
        </fieldset>
        <Field label={t('plans.upgradeText')} hint={t('plans.upgradeTextHint')}>
          <textarea
            className={textarea}
            data-testid="billing-upgrade-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </Field>
        <Field label={t('plans.upgradeUrl')}>
          <Input
            dir="ltr"
            placeholder="https://"
            data-testid="billing-upgrade-url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </Field>
        <Field label={t('plans.closedText')} hint={t('plans.closedTextHint')}>
          <textarea
            className={textarea}
            data-testid="billing-closed-text"
            value={closedText}
            onChange={(e) => setClosedText(e.target.value)}
          />
        </Field>
        <Field label={t('plans.contactUrl')} hint={t('plans.contactUrlHint')}>
          <Input
            dir="ltr"
            placeholder="https:// · mailto:"
            data-testid="billing-contact-url"
            value={contactUrl}
            onChange={(e) => setContactUrl(e.target.value)}
          />
        </Field>
        <fieldset className="space-y-2">
          <legend className="text-xs font-semibold text-fg-2">{t('plans.catalogue')}</legend>
          <p className="text-xs text-muted">{t('plans.catalogueHint')}</p>
          {features.map((f, i) => (
            <div key={i} className="flex items-center gap-2" data-testid="billing-feature">
              <Input
                dir="ltr"
                className="w-40 font-mono"
                placeholder="key"
                aria-label={t('plans.featureKey')}
                value={f.key}
                onChange={(e) =>
                  setFeatures(features.map((x, j) => (j === i ? { ...x, key: e.target.value.trim() } : x)))
                }
              />
              <Input
                placeholder={t('plans.featureLabel')}
                aria-label={t('plans.featureLabel')}
                value={f.label}
                onChange={(e) => setFeatures(features.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
              />
              <Button variant="ghost" size="sm" onClick={() => setFeatures(features.filter((_, j) => j !== i))}>
                {t('plans.remove')}
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            data-testid="billing-feature-add"
            onClick={() => setFeatures([...features, { key: '', label: '' }])}
          >
            {t('plans.addFeature')}
          </Button>
        </fieldset>
        {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
        <div className="flex justify-end">
          <Button
            variant="accent"
            disabled={!ok}
            busy={save.isPending}
            data-testid="billing-save"
            onClick={() => save.mutate()}
          >
            {t('common.save')}
          </Button>
        </div>
      </Card>
    </div>
  );
};

// ---- an account's plan (the accounts list) ----

/** The plan cell of the accounts list: the plan name and status, or "unlimited" (legacy). */
export const AccountPlanBadge = ({ sub }: { sub: Subscription | undefined }) =>
  sub ? (
    <span className="flex flex-col items-start gap-0.5" data-testid="account-plan" data-status={sub.effective_status}>
      <span className="text-sm font-semibold text-fg">{sub.plan_name}</span>
      <Badge tone={STATUS_TONE[sub.effective_status]}>{t(`plan.status.${sub.effective_status}`)}</Badge>
    </span>
  ) : (
    <span className="text-xs text-muted" data-testid="account-plan" data-status="legacy">
      {t('plan.unlimited')}
    </span>
  );

/**
 * Owner console → accounts → "חבילה": assign a plan version, the status, interval, seats bought, the owner's
 * per-limit override and a note; renew the period; or end the plan (back to unlimited). Applies at once.
 */
export const AccountPlanDialog = ({ account, onClose }: { account: PlatformAccount; onClose: () => void }) => {
  const view = useQuery({
    queryKey: accountPlanKey(account.id),
    queryFn: () => api().get<AccountPlan>(`/platform/accounts/${account.id}/subscription`),
  });
  const plans = usePlans();
  return (
    <Dialog open onClose={onClose} title={t('plans.accountPlan')} subtitle={account.name} className="max-w-3xl!">
      <div className="flex flex-col gap-4" data-testid="account-plan-dialog">
        {view.isPending || plans.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
        {view.isError ? <Notice tone="error">{errorMessage(view.error)}</Notice> : null}
        {view.data && plans.data ? (
          <AccountPlanForm
            key={JSON.stringify(view.data.subscription)}
            account={account}
            plan={view.data}
            plans={plans.data.data}
            onDone={onClose}
          />
        ) : null}
      </div>
    </Dialog>
  );
};

const AccountPlanForm = ({
  account,
  plan,
  plans,
  onDone,
}: {
  account: PlatformAccount;
  plan: AccountPlan;
  plans: SubscriptionPlan[];
  onDone: () => void;
}) => {
  const qc = useQueryClient();
  const s = plan.subscription;
  const versions = plans.flatMap((p) =>
    p.versions
      .filter((v) => !p.archived || v.id === s?.plan_version_id)
      .map((v) => ({
        value: v.id,
        label: `${p.name} · ${t('plan.version', { n: v.version })}${v.id === p.current_version_id ? ` (${t('plans.current')})` : ''}`,
        testId: `account-plan-version-${p.name}-${v.version}`,
      })),
  );
  const [versionId, setVersionId] = useState(s?.plan_version_id ?? versions.at(-1)?.value ?? '');
  const [status, setStatus] = useState<SubscriptionStatus | 'auto'>(s?.status ?? 'auto');
  const [interval, setBillingInterval] = useState<'month' | 'year'>(s?.interval ?? 'month');
  const [seats, setSeats] = useState(str(s?.seats));
  const [cancelAtEnd, setCancelAtEnd] = useState(s?.cancel_at_period_end ?? false);
  const [renew, setRenew] = useState(false);
  const [note, setNote] = useState(s?.note ?? '');
  const [statusMessage, setStatusMessage] = useState(s?.status_message ?? '');
  const [overrides, setOverrides] = useState<Record<PlanLimitKind, { on: boolean; value: string; unlimited: boolean }>>(
    () =>
      Object.fromEntries(
        PLAN_LIMIT_KINDS.map((k) => {
          const o = s?.overrides[k];
          return [k, { on: o !== undefined, value: str(o ?? null), unlimited: o === null }];
        }),
      ) as Record<PlanLimitKind, { on: boolean; value: string; unlimited: boolean }>,
  );
  // Add-ons held: a quantity per add-on (the subscription keeps a snapshot of each unit).
  const addonList = useAddons();
  const [addonQty, setAddonQty] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(s?.addons ?? {}).map(([id, a]) => [id, String(a.qty)])),
  );
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: accountPlanKey(account.id) });
    await qc.invalidateQueries({ queryKey: subscriptionsKey });
    await qc.invalidateQueries({ queryKey: plansKey });
  };
  const overridesBody = () =>
    Object.fromEntries(
      PLAN_LIMIT_KINDS.filter((k) => overrides[k].on).map((k) => [
        k,
        overrides[k].unlimited ? null : num(overrides[k].value),
      ]),
    );
  const save = useMutation({
    mutationFn: () =>
      api().put<AccountPlan>(`/platform/accounts/${account.id}/subscription`, {
        plan_version_id: versionId,
        ...(status !== 'auto' ? { status } : {}),
        interval,
        seats: num(seats),
        cancel_at_period_end: cancelAtEnd,
        overrides: overridesBody(),
        addons: Object.fromEntries(
          Object.entries(addonQty).map(([id, q]) => [id, Math.max(0, Math.round(num(q) ?? 0) || 0)]),
        ),
        note: note.trim() || null,
        status_message: statusMessage.trim() || null,
        ...(renew ? { renew: true } : {}),
      }),
    onSuccess: async () => {
      await refresh();
      showToast({ message: t('plans.assigned') });
      onDone();
    },
  });
  const end = useMutation({
    mutationFn: () => api().delete(`/platform/accounts/${account.id}/subscription`),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  const valid =
    !!versionId &&
    !Number.isNaN(num(seats)) &&
    PLAN_LIMIT_KINDS.every(
      (k) => !overrides[k].on || overrides[k].unlimited || (num(overrides[k].value) ?? Number.NaN) >= 0,
    );
  const over = plan.usage.filter((u) => u.limit !== null && u.used > u.limit);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) save.mutate();
      }}
    >
      <PlanSummary plan={plan} />
      {over.length ? (
        <Notice tone="warn">
          {t('plans.overLimits', { kinds: over.map((u) => t(`plan.kind.${u.kind}`)).join(', ') })}
        </Notice>
      ) : null}
      {!versions.length ? <Notice tone="info">{t('plans.noPlansYet')}</Notice> : null}
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('plans.planVersion')}>
          <Picker
            label={t('plans.planVersion')}
            value={versionId}
            options={versions}
            onChange={setVersionId}
            testId="account-plan-version"
          />
        </Field>
        <Field label={t('plans.status')}>
          <Picker<SubscriptionStatus | 'auto'>
            label={t('plans.status')}
            value={status}
            onChange={setStatus}
            testId="account-plan-status"
            options={[
              ...(s ? [] : [{ value: 'auto' as const, label: t('plans.statusAuto') }]),
              ...SUBSCRIPTION_STATUSES.map((v) => ({
                value: v,
                label: t(`plan.status.${v}`),
                testId: `account-plan-status-${v}`,
              })),
            ]}
          />
        </Field>
        <div className="space-y-1.5">
          <span className="block text-xs font-semibold text-fg-2">{t('plans.interval')}</span>
          <Segmented<'month' | 'year'>
            label={t('plans.interval')}
            value={interval}
            onChange={setBillingInterval}
            options={[
              { value: 'month', label: t('plan.interval.month') },
              { value: 'year', label: t('plan.interval.year') },
            ]}
          />
        </div>
        <Field label={t('plans.seats')} hint={t('plans.seatsHint')}>
          <Input
            inputMode="numeric"
            dir="ltr"
            data-testid="account-plan-seats"
            value={seats}
            onChange={(e) => setSeats(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-5">
        <label className="flex items-center gap-2 text-sm text-fg">
          <Switch checked={cancelAtEnd} onChange={setCancelAtEnd} testId="account-plan-cancel" />
          {t('plans.cancelAtEnd')}
        </label>
        {s ? (
          <label className="flex items-center gap-2 text-sm text-fg">
            <Switch checked={renew} onChange={setRenew} testId="account-plan-renew" />
            {t('plans.renew')}
          </label>
        ) : null}
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold text-fg-2">{t('plans.overrides')}</legend>
        <p className="text-xs text-muted">{t('plans.overridesHint')}</p>
        <div className="grid gap-2 md:grid-cols-2">
          {PLAN_LIMIT_KINDS.map((k) => {
            const o = overrides[k];
            const setO = (patch: Partial<typeof o>) => setOverrides({ ...overrides, [k]: { ...o, ...patch } });
            return (
              <div key={k} className="flex items-center gap-2" data-testid="account-plan-override" data-kind={k}>
                <Switch
                  checked={o.on}
                  onChange={(on) => setO({ on })}
                  label={t(`plan.kind.${k}`)}
                  testId={`override-on-${k}`}
                />
                <span className="w-32 shrink-0 text-sm text-fg">{t(`plan.kind.${k}`)}</span>
                {o.on ? (
                  <>
                    <Input
                      inputMode="decimal"
                      dir="ltr"
                      className="w-24"
                      disabled={o.unlimited}
                      aria-label={t(`plan.kind.${k}`)}
                      data-testid={`override-value-${k}`}
                      value={o.value}
                      onChange={(e) => setO({ value: e.target.value })}
                    />
                    <label className="flex items-center gap-1.5 text-xs text-fg-2">
                      <Switch checked={o.unlimited} onChange={(unlimited) => setO({ unlimited })} />
                      {t('plan.unlimited')}
                    </label>
                  </>
                ) : null}
              </div>
            );
          })}
        </div>
      </fieldset>
      {(addonList.data?.data ?? []).length || Object.keys(s?.addons ?? {}).length ? (
        <fieldset className="space-y-2" data-testid="account-plan-addons">
          <legend className="text-xs font-semibold text-fg-2">{t('plans.addons')}</legend>
          <p className="text-xs text-muted">{t('plans.addonsHint')}</p>
          <div className="grid gap-2 md:grid-cols-2">
            {[
              ...(addonList.data?.data ?? []).map((a) => ({ id: a.id, name: a.name, active: a.active })),
              ...Object.entries(s?.addons ?? {})
                .filter(([id]) => !(addonList.data?.data ?? []).some((a) => a.id === id))
                .map(([id, a]) => ({ id, name: a.name, active: false })),
            ].map((a) => (
              <label key={a.id} className="flex items-center gap-2 text-sm text-fg">
                <Input
                  inputMode="numeric"
                  dir="ltr"
                  className="w-20"
                  aria-label={a.name}
                  data-testid={`account-plan-addon-${a.id}`}
                  value={addonQty[a.id] ?? ''}
                  placeholder="0"
                  onChange={(e) => setAddonQty({ ...addonQty, [a.id]: e.target.value.replace(/[^0-9]/g, '') })}
                />
                <span className="min-w-0 truncate">{a.name}</span>
                {!a.active ? <Badge tone="neutral">{t('addons.inactive')}</Badge> : null}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <Field label={t('plans.statusMessage')} hint={t('plans.statusMessageHint')}>
        <textarea
          className={textarea}
          value={statusMessage}
          maxLength={1000}
          data-testid="account-plan-status-message"
          onChange={(e) => setStatusMessage(e.target.value)}
        />
      </Field>
      <Field label={t('plans.note')}>
        <textarea className={textarea} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      {(save.error ?? end.error) ? <Notice tone="error">{errorMessage(save.error ?? end.error)}</Notice> : null}
      <div className="flex flex-wrap justify-between gap-2">
        {s ? (
          <Button
            type="button"
            variant="danger-outline"
            busy={end.isPending}
            data-testid="account-plan-end"
            onClick={() =>
              void confirmDialog({ title: t('plans.endTitle'), message: t('plans.endBody'), danger: true }).then(
                (ok) => ok && end.mutate(),
              )
            }
          >
            {t('plans.end')}
          </Button>
        ) : (
          <span />
        )}
        <Button type="submit" variant="accent" disabled={!valid} busy={save.isPending} data-testid="account-plan-save">
          {t('common.save')}
        </Button>
      </div>
      <div>
        <h3 className="mb-1 text-xs font-semibold text-fg-2">{t('plan.history')}</h3>
        <PlanHistory plan={plan} />
      </div>
    </form>
  );
};
