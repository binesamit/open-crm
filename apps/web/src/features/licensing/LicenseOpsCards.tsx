// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type LicenseOps,
  PAYMENT_MODES,
  type PaymentMode,
  PURCHASABLE_PLANS,
  PURCHASE_TIERS_MAX,
  type PurchasablePlan,
  t,
  type UpdateLicenseOps,
} from '@bines/shared';
import { Badge, Button, Card, Field, Input, Notice, Segmented, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { licensingKeys, useLicenseServer } from './licensing-api';

/**
 * The license server's operations, in the owner console → Licensing — only where this installation
 * is the license server: "Expiry reminders" (on/off, the days before expiry) and "Payments" (optional: Stripe's
 * secret key and webhook secret — write-only, sealed on the server — and a Price ID per edition). With payments
 * off or unready, nothing about buying shows anywhere.
 */
const useLicenseOps = (enabled: boolean) =>
  useQuery({
    queryKey: licensingKeys.ops,
    queryFn: () => api().get<LicenseOps>('/platform/license-ops'),
    enabled,
  });

const useSaveOps = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateLicenseOps) => api().patch<LicenseOps>('/platform/license-ops', patch),
    onSuccess: (res) => {
      qc.setQueryData(licensingKeys.ops, res);
      showToast({ message: t('licensing.ops.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
};

export const LicenseOpsCards = () => {
  const server = useLicenseServer();
  const on = !!server.data?.enabled;
  const ops = useLicenseOps(on);
  if (!on) return null;
  if (ops.isPending) return <SkeletonRows rows={2} label={t('app.loading')} />;
  if (ops.isError) return <Notice tone="error">{errorMessage(ops.error)}</Notice>;
  return (
    <>
      <RemindersCard ops={ops.data} />
      <PaymentsCard key={JSON.stringify(ops.data.payments.plans)} ops={ops.data} />
    </>
  );
};

/** "30, 7" → [30, 7]; null when not valid (whole numbers 1–365, up to 6, no repeats). */
export const parseDays = (text: string): number[] | null => {
  const parts = text
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length || parts.length > 6 || parts.some((p) => !/^\d{1,3}$/.test(p))) return null;
  const days = parts.map(Number);
  if (days.some((d) => d < 1 || d > 365) || new Set(days).size !== days.length) return null;
  return days;
};

const RemindersCard = ({ ops }: { ops: LicenseOps }) => {
  const save = useSaveOps();
  const [text, setText] = useState(ops.reminders.days.join(', '));
  const days = parseDays(text);
  return (
    <Card className="space-y-3" data-testid="license-reminders">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-fg">{t('licensing.ops.reminders.title')}</h3>
        <p className="max-w-[640px] text-xs text-muted">{t('licensing.ops.reminders.hint')}</p>
      </div>
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-fg">{t('licensing.ops.reminders.enabled')}</span>
        <Switch
          checked={ops.reminders.enabled}
          disabled={save.isPending}
          onChange={(enabled) => save.mutate({ reminders: { enabled } })}
          label={t('licensing.ops.reminders.enabled')}
          testId="license-reminders-switch"
        />
      </label>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (days) save.mutate({ reminders: { days } });
        }}
      >
        <Field
          label={t('licensing.ops.reminders.days')}
          hint={days ? t('licensing.ops.reminders.daysHint') : t('licensing.ops.reminders.daysInvalid')}
        >
          <Input
            dir="ltr"
            inputMode="numeric"
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="license-reminders-days"
          />
        </Field>
        <Button type="submit" size="sm" variant="secondary" disabled={!days} busy={save.isPending}>
          {t('licensing.ops.save')}
        </Button>
      </form>
    </Card>
  );
};

type TierDraft = { seats: string; price_id: string; amount: string };
type PlanDraft = {
  price_id: string;
  seats: string;
  mode: PaymentMode;
  /** The yearly price shown on the pricing page and at /buy, and its currency. */
  amount: string;
  currency: string;
  tiers: TierDraft[];
};
const amountOf = (v: string) => {
  const n = Number(v.trim().replace(',', '.'));
  return v.trim() && Number.isFinite(n) && n >= 0 ? n : null;
};

const PaymentsCard = ({ ops }: { ops: LicenseOps }) => {
  const save = useSaveOps();
  const p = ops.payments;
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [plans, setPlans] = useState<Record<PurchasablePlan, PlanDraft>>(
    () =>
      Object.fromEntries(
        PURCHASABLE_PLANS.map((plan) => [
          plan,
          {
            price_id: p.plans[plan].price_id,
            seats: p.plans[plan].seats?.toString() ?? '',
            mode: p.plans[plan].mode,
            amount: p.plans[plan].display_amount?.toString() ?? '',
            currency: p.plans[plan].currency,
            tiers: p.plans[plan].tiers.map((x) => ({
              seats: x.seats?.toString() ?? '',
              price_id: x.price_id,
              amount: x.display_amount?.toString() ?? '',
            })),
          },
        ]),
      ) as Record<PurchasablePlan, PlanDraft>,
  );
  const setPlan = (plan: PurchasablePlan, patch: Partial<PlanDraft>) =>
    setPlans((cur) => ({ ...cur, [plan]: { ...cur[plan], ...patch } }));
  const setTier = (plan: PurchasablePlan, i: number, patch: Partial<TierDraft>) =>
    setPlan(plan, { tiers: plans[plan].tiers.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const submit = () => {
    const payments: NonNullable<UpdateLicenseOps['payments']> = {
      plans: Object.fromEntries(
        PURCHASABLE_PLANS.map((plan) => [
          plan,
          {
            price_id: plans[plan].price_id.trim(),
            seats: plans[plan].seats ? Number(plans[plan].seats) : null,
            mode: plans[plan].mode,
            display_amount: amountOf(plans[plan].amount),
            currency: /^[A-Za-z]{3}$/.test(plans[plan].currency.trim())
              ? plans[plan].currency.trim().toUpperCase()
              : 'USD',
            tiers: plans[plan].tiers.map((x) => ({
              seats: x.seats ? Number(x.seats) : null,
              price_id: x.price_id.trim(),
              display_amount: amountOf(x.amount),
            })),
          },
        ]),
      ),
    };
    if (secretKey.trim()) payments.secret_key = secretKey.trim();
    if (webhookSecret.trim()) payments.webhook_secret = webhookSecret.trim();
    save.mutate(
      { payments },
      {
        onSuccess: () => {
          setSecretKey('');
          setWebhookSecret('');
        },
      },
    );
  };
  return (
    <Card className="space-y-3" data-testid="license-payments">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-fg">{t('licensing.ops.payments.title')}</h3>
          <p className="max-w-[640px] text-xs text-muted">{t('licensing.ops.payments.hint')}</p>
        </div>
        <span data-testid="license-payments-state" data-ready={p.ready ? 'yes' : 'no'}>
          <Badge tone={p.ready ? 'ok' : 'neutral'}>
            {t(p.ready ? 'licensing.ops.payments.ready' : 'licensing.ops.payments.notReady')}
          </Badge>
        </span>
      </div>
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-fg">{t('licensing.ops.payments.enabled')}</span>
        <Switch
          checked={p.enabled}
          disabled={save.isPending}
          onChange={(enabled) => save.mutate({ payments: { enabled } })}
          label={t('licensing.ops.payments.enabled')}
          testId="license-payments-switch"
        />
      </label>
      {!p.ready ? <p className="text-xs text-muted">{t('licensing.ops.payments.notReadyHint')}</p> : null}
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <SecretField
          label={t('licensing.ops.payments.secretKey')}
          set={p.secret_key_set}
          value={secretKey}
          onChange={setSecretKey}
          placeholder="sk_live_…"
          onClear={() => save.mutate({ payments: { secret_key: null, enabled: false } })}
          testId="license-payments-secret"
        />
        <SecretField
          label={t('licensing.ops.payments.webhookSecret')}
          set={p.webhook_secret_set}
          value={webhookSecret}
          onChange={setWebhookSecret}
          placeholder="whsec_…"
          onClear={() => save.mutate({ payments: { webhook_secret: null, enabled: false } })}
          testId="license-payments-webhook-secret"
        />
        {PURCHASABLE_PLANS.map((plan) => (
          <div key={plan} className="flex flex-wrap items-end gap-3" data-testid={`license-payments-plan-${plan}`}>
            <Field
              label={t('licensing.ops.payments.price', { plan: t(`licensing.plan.${plan}`) })}
              hint={t('licensing.ops.payments.priceHint')}
            >
              <Input
                dir="ltr"
                value={plans[plan].price_id}
                placeholder="price_…"
                maxLength={200}
                onChange={(e) => setPlan(plan, { price_id: e.target.value })}
                data-testid={`license-payments-price-${plan}`}
              />
            </Field>
            <Field label={t('licensing.ops.payments.seats')}>
              <Input
                dir="ltr"
                inputMode="numeric"
                value={plans[plan].seats}
                onChange={(e) => setPlan(plan, { seats: e.target.value.replace(/[^\d]/g, '') })}
                data-testid={`license-payments-seats-${plan}`}
              />
            </Field>
            <Field label={t('licensing.ops.payments.mode')}>
              <Segmented
                label={t('licensing.ops.payments.mode')}
                value={plans[plan].mode}
                onChange={(mode) => setPlan(plan, { mode })}
                testId={`license-payments-mode-${plan}`}
                options={PAYMENT_MODES.map((m) => ({
                  value: m,
                  label: t(`licensing.ops.payments.mode.${m}`),
                  testId: `license-payments-mode-${plan}-${m}`,
                }))}
              />
            </Field>
            <Field label={t('licensing.ops.payments.amount')} hint={t('licensing.ops.payments.amountHint')}>
              <Input
                dir="ltr"
                inputMode="decimal"
                className="w-28"
                value={plans[plan].amount}
                onChange={(e) => setPlan(plan, { amount: e.target.value })}
                data-testid={`license-payments-amount-${plan}`}
              />
            </Field>
            <Field label={t('licensing.ops.payments.currency')}>
              <Input
                dir="ltr"
                className="w-20"
                maxLength={3}
                value={plans[plan].currency}
                onChange={(e) => setPlan(plan, { currency: e.target.value })}
              />
            </Field>
            <div className="flex w-full flex-col gap-2" data-testid={`license-payments-tiers-${plan}`}>
              {plans[plan].tiers.length ? (
                <p className="text-xs text-muted">{t('licensing.ops.payments.tiersHint')}</p>
              ) : null}
              {plans[plan].tiers.map((x, i) => (
                <div key={i} className="flex flex-wrap items-end gap-3 rounded-[12px] border border-line p-2.5">
                  <span className="pb-2 text-xs text-fg-2">{t('licensing.ops.payments.tier', { n: i + 1 })}</span>
                  <Field label={t('licensing.ops.payments.seats')}>
                    <Input
                      dir="ltr"
                      inputMode="numeric"
                      className="w-24"
                      value={x.seats}
                      onChange={(e) => setTier(plan, i, { seats: e.target.value.replace(/[^\d]/g, '') })}
                    />
                  </Field>
                  <Field label={t('licensing.ops.payments.tierPrice')}>
                    <Input
                      dir="ltr"
                      value={x.price_id}
                      placeholder="price_…"
                      maxLength={200}
                      onChange={(e) => setTier(plan, i, { price_id: e.target.value })}
                    />
                  </Field>
                  <Field label={t('licensing.ops.payments.amount')}>
                    <Input
                      dir="ltr"
                      inputMode="decimal"
                      className="w-28"
                      value={x.amount}
                      onChange={(e) => setTier(plan, i, { amount: e.target.value })}
                    />
                  </Field>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setPlan(plan, { tiers: plans[plan].tiers.filter((_, j) => j !== i) })}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              ))}
              {plans[plan].tiers.length < PURCHASE_TIERS_MAX ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="self-start"
                  onClick={() =>
                    setPlan(plan, { tiers: [...plans[plan].tiers, { seats: '', price_id: '', amount: '' }] })
                  }
                  data-testid={`license-payments-add-tier-${plan}`}
                >
                  {t('licensing.ops.payments.addTier')}
                </Button>
              ) : null}
            </div>
          </div>
        ))}
        <Button type="submit" size="sm" variant="secondary" busy={save.isPending} data-testid="license-payments-save">
          {t('licensing.ops.save')}
        </Button>
      </form>
      <div className="space-y-1 border-t border-line pt-3 text-xs text-muted">
        <div>{t('licensing.ops.payments.webhookUrl')}</div>
        <code dir="ltr" className="block break-all text-fg-2" data-testid="license-payments-webhook-url">
          {p.webhook_url}
        </code>
        <div>{t('licensing.ops.payments.buyUrl')}</div>
        <code dir="ltr" className="block break-all text-fg-2">
          {p.buy_url}
        </code>
      </div>
    </Card>
  );
};

export const SecretField = ({
  label,
  set,
  value,
  onChange,
  placeholder,
  onClear,
  testId,
}: {
  label: string;
  set: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  onClear: () => void;
  testId: string;
}) => (
  <div className="flex flex-wrap items-end gap-2">
    <Field label={label} hint={set ? t('licensing.ops.payments.set') : t('licensing.ops.payments.notSet')}>
      <Input
        type="password"
        dir="ltr"
        autoComplete="off"
        value={value}
        placeholder={set ? '••••••••' : placeholder}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </Field>
    {set ? (
      <Button type="button" size="sm" variant="ghost" onClick={onClear} data-testid={`${testId}-clear`}>
        {t('licensing.ops.payments.clear')}
      </Button>
    ) : null}
  </div>
);
