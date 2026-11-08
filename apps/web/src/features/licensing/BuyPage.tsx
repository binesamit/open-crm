// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { getLocale, type PublicPurchaseConfig, type PurchasablePlan, t } from '@bines/shared';
import { Button, Field, Input, Notice, Segmented, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { AuthShell } from '../auth/AuthShell';
import { money } from '../pricing/pricing-parts';

/**
 * The license server's public purchase pages: `/buy?plan=&instance=` picks an edition and goes to the
 * payment provider's hosted page; `/buy/success` says the key is on its way by email. Where the purchase is not set
 * up (or this is not a license server) the page only says it is not available — no form, no prices. An edition sold
 * in tiers asks which tier (`?tier=` from the pricing page picks it); the owner's shown price is on
 * each choice.
 */
export const purchaseConfigKey = ['public', 'licenses', 'purchase'] as const;

/** Leaves for the provider's page (tests replace it). */
export const goTo = { href: (url: string) => window.location.assign(url) };

export const BuyPage = ({
  plan: initialPlan,
  tier: initialTier,
  instance,
  canceled,
}: {
  plan?: string;
  tier?: number;
  instance?: string;
  canceled?: boolean;
}) => {
  const lang = getLocale() === 'en' ? 'en' : 'he';
  const config = useQuery({
    queryKey: purchaseConfigKey,
    queryFn: () => api().get<PublicPurchaseConfig>('/public/licenses/purchase'),
    retry: false,
  });
  const plans = config.data?.available ? config.data.plans : [];
  const [plan, setPlan] = useState<PurchasablePlan | ''>('');
  const chosen = plan || plans.find((p) => p.plan === initialPlan)?.plan || plans[0]?.plan || '';
  const chosenPlan = plans.find((p) => p.plan === chosen);
  const tiers = chosenPlan?.tiers ?? [];
  const [tier, setTier] = useState<number | null>(null);
  const chosenTier =
    tiers.find((x) => x.index === tier) ?? tiers.find((x) => x.index === initialTier) ?? tiers[0] ?? null;
  const yearly = (amount: number | null | undefined, currency: string) =>
    amount === null || amount === undefined
      ? ''
      : ` · ${t('licensing.buy.perYear', { price: money(amount, currency) })}`;
  const seatsLabel = (seats: number | null) =>
    seats ? t('licensing.buy.seats', { seats }) : t('licensing.buy.unlimited');
  const [instanceId, setInstanceId] = useState(instance ?? '');
  const [email, setEmail] = useState('');
  const checkout = useMutation({
    mutationFn: () =>
      api().post<{ url: string }>('/public/licenses/checkout', {
        plan: chosen,
        ...(chosenTier ? { tier: chosenTier.index } : {}),
        instance_id: instanceId.trim() || null,
        ...(email.trim() ? { email: email.trim() } : {}),
        locale: lang,
      }),
    onSuccess: (res) => goTo.href(res.url),
  });
  const instanceOk = !instanceId.trim() || /^[A-Za-z0-9-]{8,64}$/.test(instanceId.trim());
  const emailOk = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const available = !!config.data?.available && plans.length > 0;
  return (
    <AuthShell title={t('licensing.buy.title')} subtitle={available ? t('licensing.buy.subtitle') : undefined}>
      <div className="space-y-3" data-testid="buy">
        {config.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
        {config.isError || (config.data && !available) ? (
          <div data-testid="buy-unavailable">
            <Notice tone="info">{t('licensing.buy.unavailable')}</Notice>
          </div>
        ) : null}
        {available ? (
          <form
            className="space-y-3"
            data-testid="buy-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (chosen && instanceOk && emailOk) checkout.mutate();
            }}
          >
            {canceled ? <Notice tone="info">{t('licensing.buy.canceled')}</Notice> : null}
            <Field label={t('licensing.buy.plan')}>
              <Segmented
                label={t('licensing.buy.plan')}
                value={chosen}
                onChange={(v) => {
                  setPlan(v as PurchasablePlan);
                  setTier(null);
                }}
                testId="buy-plan"
                options={plans.map((p) => ({
                  value: p.plan,
                  label: p.tiers?.length
                    ? t(`licensing.plan.${p.plan}`)
                    : `${t(`licensing.plan.${p.plan}`)} · ${seatsLabel(p.seats)}${yearly(p.amount, p.currency)}`,
                  testId: `buy-plan-${p.plan}`,
                }))}
              />
            </Field>
            {tiers.length && chosenPlan ? (
              <Field label={t('licensing.buy.tier')}>
                <Segmented
                  label={t('licensing.buy.tier')}
                  value={String(chosenTier?.index ?? 0)}
                  onChange={(v) => setTier(Number(v))}
                  testId="buy-tier"
                  options={tiers.map((x) => ({
                    value: String(x.index),
                    label: `${seatsLabel(x.seats)}${yearly(x.amount, chosenPlan.currency)}`,
                    testId: `buy-tier-${x.index}`,
                  }))}
                />
              </Field>
            ) : null}
            <Field label={t('licensing.public.instance')} hint={t('licensing.buy.instanceHint')}>
              <Input
                dir="ltr"
                value={instanceId}
                maxLength={64}
                onChange={(e) => setInstanceId(e.target.value)}
                data-testid="buy-instance"
              />
            </Field>
            <Field label={t('licensing.buy.email')}>
              <Input
                type="email"
                dir="ltr"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                data-testid="buy-email"
              />
            </Field>
            {checkout.isError ? <Notice tone="error">{errorMessage(checkout.error)}</Notice> : null}
            <Button
              type="submit"
              busy={checkout.isPending}
              disabled={!chosen || !instanceOk || !emailOk}
              data-testid="buy-continue"
            >
              {t('licensing.buy.continue')}
            </Button>
          </form>
        ) : null}
      </div>
    </AuthShell>
  );
};

export const BuySuccessPage = () => (
  <AuthShell title={t('licensing.buy.successTitle')}>
    <div data-testid="buy-success">
      <Notice tone="success">{t('licensing.buy.successBody')}</Notice>
    </div>
  </AuthShell>
);
