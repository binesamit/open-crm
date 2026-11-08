// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  PLAN_LIMIT_KINDS,
  type PlanAddon,
  type PlanAddonInput,
  type PlanLimitKind,
  type PricingPageSettings,
  type SubscriptionPlan,
  t,
} from '@bines/shared';
import { Badge, Button, Card, Dialog, Field, Input, Notice, Picker, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { pricingKey } from '../pricing/PricingPage';
import { money } from '../pricing/pricing-parts';

/**
 * Owner console → Plans (the planning notes "PRICING"): the add-ons (units that raise one limit, priced per
 * unit) and the pricing page's own settings (on / off, title, VAT, contact link, the custom plan, questions, the
 * sites that may read the JSON). Nothing is built in: every name, price and text is written here.
 */
export const addonsKey = ['platform', 'plan-addons'] as const;
const pageKey = ['platform', 'pricing-page'] as const;

export const useAddons = () =>
  useQuery({ queryKey: addonsKey, queryFn: () => api().get<{ data: PlanAddon[] }>('/platform/plan-addons') });

const textarea =
  'min-h-20 w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none focus:ring-3 focus:ring-[var(--accent-soft)]';

const num = (s: string): number | null => {
  const v = s.trim().replace(',', '.');
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
};

// ------------------------------------------------------------------------------------------------ add-ons

const unitLine = (a: PlanAddon) => `+${a.unit_amount} ${t(`plan.kind.${a.limit_kind}`)}`;

export const AddonsCard = () => {
  const addons = useAddons();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<PlanAddon | 'new' | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api().delete(`/platform/plan-addons/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: addonsKey }),
    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
  });
  const rows = addons.data?.data ?? [];
  return (
    <Card className="space-y-3" data-testid="plan-addons">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-fg">{t('addons.title')}</h3>
          <p className="max-w-[640px] text-xs text-muted">{t('addons.hint')}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')} data-testid="addon-new">
          {t('addons.new')}
        </Button>
      </div>
      {addons.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {addons.isError ? <Notice tone="error">{errorMessage(addons.error)}</Notice> : null}
      {addons.data && !rows.length ? <p className="text-xs text-muted">{t('addons.empty')}</p> : null}
      {rows.length ? (
        <ul className="divide-y divide-line-soft rounded-[12px] border border-line">
          {rows.map((a) => (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-[0.8125rem]"
              data-testid="addon-row"
              data-name={a.name}
            >
              <span className="min-w-0 flex-1">
                <span className="text-fg">{a.name}</span>
                <span className="ms-2 text-muted">{unitLine(a)}</span>
              </span>
              <span className="text-fg-2" dir="ltr">
                {money(a.price_monthly, a.currency)} / {t('plan.interval.month')} · {money(a.price_yearly, a.currency)}{' '}
                / {t('plan.interval.year')}
              </span>
              {!a.active ? <Badge tone="neutral">{t('addons.inactive')}</Badge> : null}
              <Button size="sm" variant="ghost" onClick={() => setEditing(a)} data-testid="addon-edit">
                {t('common.edit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (
                    await confirmDialog({
                      title: t('addons.deleteTitle', { name: a.name }),
                      message: t('addons.deleteBody'),
                      danger: true,
                    })
                  )
                    remove.mutate(a.id);
                }}
                data-testid="addon-delete"
              >
                {t('common.delete')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {editing ? (
        <AddonDialog addon={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />
      ) : null}
    </Card>
  );
};

const AddonDialog = ({ addon, onClose }: { addon?: PlanAddon; onClose: () => void }) => {
  const qc = useQueryClient();
  const plans = useQuery({
    queryKey: ['platform', 'plans'],
    queryFn: () => api().get<{ data: SubscriptionPlan[] }>('/platform/plans'),
  });
  const [name, setName] = useState(addon?.name ?? '');
  const [kind, setKind] = useState<PlanLimitKind>(addon?.limit_kind ?? 'storage_gb');
  const [unit, setUnit] = useState(addon ? String(addon.unit_amount) : '');
  const [monthly, setMonthly] = useState(addon ? String(addon.price_monthly) : '');
  const [yearly, setYearly] = useState(addon ? String(addon.price_yearly) : '');
  const [currency, setCurrency] = useState(addon?.currency ?? 'ILS');
  const [vatIncluded, setVatIncluded] = useState(addon?.vat_included ?? false);
  const [maxQty, setMaxQty] = useState(String(addon?.max_qty ?? 20));
  const [active, setActive] = useState(addon?.active ?? true);
  const [planIds, setPlanIds] = useState<string[]>(addon?.plan_ids ?? []);
  const body = (): PlanAddonInput | null => {
    const u = num(unit);
    const m = num(monthly) ?? 0;
    const y = num(yearly) ?? 0;
    const q = num(maxQty);
    if (!name.trim() || !u || Number.isNaN(m) || Number.isNaN(y) || !q || Number.isNaN(q)) return null;
    if (!/^[A-Z]{3}$/.test(currency.trim().toUpperCase())) return null;
    return {
      name: name.trim(),
      limit_kind: kind,
      unit_amount: u,
      price_monthly: m,
      price_yearly: y,
      currency: currency.trim().toUpperCase(),
      vat_included: vatIncluded,
      max_qty: Math.max(1, Math.round(q)),
      active,
      plan_ids: planIds,
    };
  };
  const save = useMutation({
    mutationFn: () =>
      addon ? api().patch(`/platform/plan-addons/${addon.id}`, body()) : api().post('/platform/plan-addons', body()),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: addonsKey });
      showToast({ message: t('admin.general.saved') });
      onClose();
    },
  });
  const paidPlans = (plans.data?.data ?? []).filter((p) => !p.archived);
  return (
    <Dialog open onClose={onClose} title={t(addon ? 'addons.edit' : 'addons.new')} className="max-w-xl!">
      <form
        className="flex flex-col gap-3"
        data-testid="addon-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          if (body()) save.mutate();
        }}
      >
        <Field label={t('addons.name')}>
          <Input required value={name} onChange={(e) => setName(e.target.value)} data-testid="addon-name" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('addons.kind')}>
            <Picker
              label={t('addons.kind')}
              value={kind}
              onChange={(v) => setKind(v as PlanLimitKind)}
              options={PLAN_LIMIT_KINDS.map((k) => ({ value: k, label: t(`plan.kind.${k}`) }))}
              testId="addon-kind"
            />
          </Field>
          <Field label={t('addons.unit')} hint={t('addons.unitHint')}>
            <Input
              inputMode="decimal"
              dir="ltr"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              data-testid="addon-unit"
            />
          </Field>
          <Field label={t('addons.priceMonthly')}>
            <Input
              inputMode="decimal"
              dir="ltr"
              value={monthly}
              onChange={(e) => setMonthly(e.target.value)}
              data-testid="addon-monthly"
            />
          </Field>
          <Field label={t('addons.priceYearly')}>
            <Input
              inputMode="decimal"
              dir="ltr"
              value={yearly}
              onChange={(e) => setYearly(e.target.value)}
              data-testid="addon-yearly"
            />
          </Field>
          <Field label={t('addons.currency')}>
            <Input dir="ltr" maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value)} />
          </Field>
          <Field label={t('addons.maxQty')}>
            <Input inputMode="numeric" dir="ltr" value={maxQty} onChange={(e) => setMaxQty(e.target.value)} />
          </Field>
        </div>
        <div className="flex flex-wrap gap-5">
          <label className="flex items-center gap-2 text-[0.8125rem] text-fg">
            <Switch checked={vatIncluded} onChange={setVatIncluded} />
            {t('addons.vatIncluded')}
          </label>
          <label className="flex items-center gap-2 text-[0.8125rem] text-fg">
            <Switch checked={active} onChange={setActive} testId="addon-active" />
            {t('addons.active')}
          </label>
        </div>
        {paidPlans.length ? (
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs text-fg-2">{t('addons.plans')}</legend>
            {paidPlans.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-[0.8125rem] text-fg">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={planIds.includes(p.id)}
                  onChange={(e) =>
                    setPlanIds((ids) => (e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id)))
                  }
                />
                {p.name}
              </label>
            ))}
            <span className="text-xs text-muted">{t('addons.plansHint')}</span>
          </fieldset>
        ) : null}
        {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="accent" disabled={!body()} busy={save.isPending} data-testid="addon-save">
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

// ------------------------------------------------------------------------------------------------ the page

type FaqDraft = { q: string; a: string };

export const PricingPageCard = () => {
  const qc = useQueryClient();
  const page = useQuery({ queryKey: pageKey, queryFn: () => api().get<PricingPageSettings>('/platform/pricing-page') });
  const [draft, setDraft] = useState<
    | (Omit<PricingPageSettings, 'cors_origins' | 'vat_pct' | 'contact_url'> & {
        cors: string;
        vat: string;
        contact: string;
      })
    | null
  >(null);
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api().patch<PricingPageSettings>('/platform/pricing-page', patch),
    onSuccess: (next) => {
      qc.setQueryData(pageKey, next);
      void qc.invalidateQueries({ queryKey: pricingKey });
      setDraft(null);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
  });
  const p = page.data;
  if (page.isError) return <Notice tone="error">{errorMessage(page.error)}</Notice>;
  if (!p) return null;
  const d = draft ?? {
    ...p,
    cors: p.cors_origins.join('\n'),
    vat: String(p.vat_pct),
    contact: p.contact_url ?? '',
  };
  const set = (patch: Partial<typeof d>) => setDraft({ ...d, ...patch });
  const setFaq = (i: number, patch: Partial<FaqDraft>) =>
    set({ faq: d.faq.map((f, j) => (j === i ? { ...f, ...patch } : f)) });
  const vat = num(d.vat);
  const valid = vat !== null && !Number.isNaN(vat) && vat <= 100 && d.faq.every((f) => f.q.trim() && f.a.trim());
  const submit = () =>
    save.mutate({
      headline: d.headline.trim(),
      subheadline: d.subheadline.trim(),
      yearly_note: d.yearly_note.trim(),
      vat_pct: vat,
      vat_default_on: d.vat_default_on,
      contact_url: d.contact.trim() || null,
      custom_name: d.custom_name.trim(),
      custom_text: d.custom_text.trim(),
      faq: d.faq.map((f) => ({ q: f.q.trim(), a: f.a.trim() })),
      cors_origins: d.cors
        .split(/[\s,]+/)
        .map((o) => o.trim().replace(/\/+$/, ''))
        .filter(Boolean),
    });
  return (
    <Card className="space-y-3" data-testid="pricing-page-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-fg">{t('pricingPage.title')}</h3>
          <p className="max-w-[640px] text-xs text-muted">{t('pricingPage.hint')}</p>
        </div>
        <a
          href="/pricing"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-primary"
          data-testid="pricing-page-open"
        >
          {t('pricingPage.open')}
        </a>
      </div>
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-fg">{t('pricingPage.enabled')}</span>
        <Switch
          checked={p.enabled}
          disabled={save.isPending}
          onChange={(enabled) => save.mutate({ enabled })}
          label={t('pricingPage.enabled')}
          testId="pricing-page-switch"
        />
      </label>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) submit();
        }}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={t('pricingPage.headline')} hint={t('pricingPage.headlineHint')}>
            <Input
              value={d.headline}
              maxLength={120}
              onChange={(e) => set({ headline: e.target.value })}
              data-testid="pricing-page-headline"
            />
          </Field>
          <Field label={t('pricingPage.subheadline')}>
            <Input value={d.subheadline} maxLength={300} onChange={(e) => set({ subheadline: e.target.value })} />
          </Field>
          <Field label={t('pricingPage.yearlyNote')} hint={t('pricingPage.yearlyNoteHint')}>
            <Input value={d.yearly_note} maxLength={40} onChange={(e) => set({ yearly_note: e.target.value })} />
          </Field>
          <Field label={t('pricingPage.contact')} hint={t('pricingPage.contactHint')}>
            <Input dir="ltr" value={d.contact} maxLength={500} onChange={(e) => set({ contact: e.target.value })} />
          </Field>
          <Field label={t('pricingPage.vat')}>
            <Input
              inputMode="decimal"
              dir="ltr"
              className="w-24"
              value={d.vat}
              onChange={(e) => set({ vat: e.target.value })}
              data-testid="pricing-page-vat"
            />
          </Field>
          <label className="flex items-center gap-2 self-end pb-2 text-[0.8125rem] text-fg">
            <Switch checked={d.vat_default_on} onChange={(v) => set({ vat_default_on: v })} />
            {t('pricingPage.vatDefault')}
          </label>
          <Field label={t('pricingPage.customName')} hint={t('pricingPage.customHint')}>
            <Input value={d.custom_name} maxLength={80} onChange={(e) => set({ custom_name: e.target.value })} />
          </Field>
          <Field label={t('pricingPage.customText')}>
            <Input value={d.custom_text} maxLength={300} onChange={(e) => set({ custom_text: e.target.value })} />
          </Field>
        </div>
        <fieldset className="space-y-2" data-testid="pricing-page-faq">
          <legend className="text-xs text-fg-2">{t('pricingPage.faq')}</legend>
          {d.faq.map((f, i) => (
            <div key={i} className="grid gap-2 rounded-[12px] border border-line p-2.5 md:grid-cols-[1fr_2fr_auto]">
              <Input
                aria-label={t('pricingPage.question')}
                placeholder={t('pricingPage.question')}
                value={f.q}
                maxLength={200}
                onChange={(e) => setFaq(i, { q: e.target.value })}
              />
              <textarea
                aria-label={t('pricingPage.answer')}
                placeholder={t('pricingPage.answer')}
                className={textarea}
                value={f.a}
                maxLength={1000}
                onChange={(e) => setFaq(i, { a: e.target.value })}
              />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => set({ faq: d.faq.filter((_, j) => j !== i) })}
              >
                {t('common.delete')}
              </Button>
            </div>
          ))}
          {d.faq.length < 12 ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => set({ faq: [...d.faq, { q: '', a: '' }] })}>
              {t('pricingPage.addQuestion')}
            </Button>
          ) : null}
        </fieldset>
        <Field label={t('pricingPage.cors')} hint={t('pricingPage.corsHint')}>
          <textarea
            dir="ltr"
            className={textarea}
            value={d.cors}
            placeholder="https://www.example.com"
            onChange={(e) => set({ cors: e.target.value })}
            data-testid="pricing-page-cors"
          />
        </Field>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={!valid}
          busy={save.isPending}
          data-testid="pricing-page-save"
        >
          {t('common.save')}
        </Button>
      </form>
    </Card>
  );
};
