// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type PlanOffer, type PlanPayments, t, type UpdatePlanPayments } from '@bines/shared';
import { Badge, Button, Card, Field, Input, Notice, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { SecretField } from '../licensing/LicenseOpsCards';
import { useAddons } from './PricingCards';

const key = ['platform', 'plan-payments'] as const;

/**
 * Owner console → Plans → "תשלום על תוכניות" (self sign-up ה9): the paid upgrade through Stripe — the switch, the keys
 * (the license purchase's: one Stripe account, shared), each public plan's Stripe price per interval, and the webhook
 * endpoint (the same one). Off by default; "request upgrade" stays either way.
 */
export const PlanPaymentsCard = () => {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: key, queryFn: () => api().get<PlanPayments>('/platform/plan-payments') });
  const plans = useQuery({
    queryKey: ['public', 'plans'],
    queryFn: () => api().get<PlanOffer>('/plans/public'),
    staleTime: 60_000,
  });
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [prices, setPrices] = useState<Record<string, { month: string; year: string }> | null>(null);
  // Add-ons: each active add-on's Stripe price per interval, sold as its own line at checkout.
  const addons = useAddons();
  const [addonPrices, setAddonPrices] = useState<Record<string, { month: string; year: string }> | null>(null);
  const save = useMutation({
    mutationFn: (patch: UpdatePlanPayments) => api().patch<PlanPayments>('/platform/plan-payments', patch),
    onSuccess: (next) => {
      qc.setQueryData(key, next);
      setSecretKey('');
      setWebhookSecret('');
      showToast({ message: t('admin.general.saved') });
    },
    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
  });
  const p = data.data;
  if (data.isError) return <Notice tone="error">{errorMessage(data.error)}</Notice>;
  if (!p) return null;
  const draft =
    prices ??
    Object.fromEntries(Object.entries(p.prices).map(([id, v]) => [id, { month: v.month ?? '', year: v.year ?? '' }]));
  const setPrice = (planId: string, interval: 'month' | 'year', value: string) =>
    setPrices({ ...draft, [planId]: { ...(draft[planId] ?? { month: '', year: '' }), [interval]: value } });
  const addonDraft =
    addonPrices ??
    Object.fromEntries(
      Object.entries(p.addon_prices ?? {}).map(([id, v]) => [id, { month: v.month ?? '', year: v.year ?? '' }]),
    );
  const setAddonPrice = (id: string, interval: 'month' | 'year', value: string) =>
    setAddonPrices({ ...addonDraft, [id]: { ...(addonDraft[id] ?? { month: '', year: '' }), [interval]: value } });
  const addonNames = new Map((addons.data?.data ?? []).map((a) => [a.id, a.name]));
  const submit = () => {
    const patch: UpdatePlanPayments = {
      prices: Object.fromEntries(
        Object.entries(draft).map(([id, v]) => [id, { month: v.month.trim() || null, year: v.year.trim() || null }]),
      ),
      addon_prices: Object.fromEntries(
        Object.entries(addonDraft).map(([id, v]) => [
          id,
          { month: v.month.trim() || null, year: v.year.trim() || null },
        ]),
      ),
    };
    if (secretKey.trim()) patch.secret_key = secretKey.trim();
    if (webhookSecret.trim()) patch.webhook_secret = webhookSecret.trim();
    save.mutate(patch, {
      onSuccess: () => {
        setPrices(null);
        setAddonPrices(null);
      },
    });
  };
  const names = new Map((plans.data?.data ?? []).map((pl) => [pl.id, pl.name]));
  return (
    <Card className="space-y-3" data-testid="plan-payments">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-fg">{t('planPayments.title')}</h3>
          <p className="max-w-[640px] text-xs text-muted">{t('planPayments.hint')}</p>
        </div>
        <span data-testid="plan-payments-state" data-ready={p.ready ? 'yes' : 'no'}>
          <Badge tone={p.ready ? 'ok' : 'neutral'}>{t(p.ready ? 'planPayments.ready' : 'planPayments.notReady')}</Badge>
        </span>
      </div>
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-fg">{t('planPayments.enabled')}</span>
        <Switch
          checked={p.enabled}
          disabled={save.isPending}
          onChange={(enabled) => save.mutate({ enabled })}
          label={t('planPayments.enabled')}
          testId="plan-payments-switch"
        />
      </label>
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
          onClear={() => save.mutate({ secret_key: null, enabled: false })}
          testId="plan-payments-secret"
        />
        <SecretField
          label={t('licensing.ops.payments.webhookSecret')}
          set={p.webhook_secret_set}
          value={webhookSecret}
          onChange={setWebhookSecret}
          placeholder="whsec_…"
          onClear={() => save.mutate({ webhook_secret: null, enabled: false })}
          testId="plan-payments-webhook-secret"
        />
        <p className="text-xs text-muted">{t('planPayments.sharedKeys')}</p>
        {Object.keys(draft).length ? (
          Object.keys(draft).map((id) => (
            <div key={id} className="flex flex-wrap items-end gap-3" data-testid="plan-payments-plan" data-plan={id}>
              <span className="min-w-[120px] pb-2 text-sm text-fg">{names.get(id) ?? id}</span>
              {(['month', 'year'] as const).map((interval) => (
                <Field key={interval} label={t(`planPayments.price.${interval}`)}>
                  <Input
                    dir="ltr"
                    value={draft[id]![interval]}
                    placeholder="price_…"
                    maxLength={130}
                    onChange={(e) => setPrice(id, interval, e.target.value)}
                    data-testid={`plan-payments-price-${interval}`}
                  />
                </Field>
              ))}
            </div>
          ))
        ) : (
          <p className="text-xs text-muted">{t('planPayments.noPlans')}</p>
        )}
        {Object.keys(addonDraft).length ? (
          <div className="space-y-2 border-t border-line pt-3">
            <p className="text-xs text-fg-2">{t('planPayments.addons')}</p>
            {Object.keys(addonDraft).map((id) => (
              <div
                key={id}
                className="flex flex-wrap items-end gap-3"
                data-testid="plan-payments-addon"
                data-addon={id}
              >
                <span className="min-w-[120px] pb-2 text-sm text-fg">{addonNames.get(id) ?? id}</span>
                {(['month', 'year'] as const).map((interval) => (
                  <Field key={interval} label={t(`planPayments.price.${interval}`)}>
                    <Input
                      dir="ltr"
                      value={addonDraft[id]![interval]}
                      placeholder="price_…"
                      maxLength={130}
                      onChange={(e) => setAddonPrice(id, interval, e.target.value)}
                      data-testid={`plan-payments-addon-price-${interval}`}
                    />
                  </Field>
                ))}
              </div>
            ))}
          </div>
        ) : null}
        <Button type="submit" size="sm" variant="secondary" busy={save.isPending} data-testid="plan-payments-save">
          {t('common.save')}
        </Button>
      </form>
      <div className="space-y-1 border-t border-line pt-3 text-xs text-muted">
        <div>{t('planPayments.webhookUrl')}</div>
        <code dir="ltr" className="block break-all text-fg-2" data-testid="plan-payments-webhook-url">
          {p.webhook_url}
        </code>
      </div>
    </Card>
  );
};
