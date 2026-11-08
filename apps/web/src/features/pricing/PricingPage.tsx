// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BUSINESS_FEATURE_KEYS,
  COMMUNITY_CAPABILITIES,
  EDITION_SUPPORT,
  ENTERPRISE_FEATURE_KEYS,
  getLocale,
  LICENSED_FEATURES_BUILT,
  type LicensedFeatureKey,
  type PricingPlan,
  type PublicPricing,
  REGISTERED_FEATURE_KEYS,
  t,
} from '@bines/shared';
import { cn, Notice, SkeletonRows } from '@bines/ui';
import { api } from '../../lib/api';
import { useBranding } from '../../lib/branding';
import { AuthShell } from '../auth/AuthShell';
import {
  AddonRows,
  CheckIcon,
  CompareTable,
  count,
  IntervalSwitch,
  money,
  PlanCard,
  quoteFor,
  SeatsStepper,
  useCalculator,
  VatSwitch,
} from './pricing-parts';

/**
 * The public pricing page (canvas "דף מחירים ומחשבון", variant A — approved): a green band with the
 * title and the cloud / self-hosted tabs, the calculator card over it, the plan cards, the custom-plan strip, the
 * comparison table and the questions. Everything shown is the owner's (GET /public/pricing); off = "not available".
 * `?embed=1` drops the top bar (for a frame on another site).
 */
export const pricingKey = ['public', 'pricing'] as const;
export const usePublicPricing = () =>
  useQuery({
    queryKey: pricingKey,
    queryFn: () => api().get<PublicPricing>('/public/pricing'),
    retry: false,
    staleTime: 60_000,
  });

type Tab = 'cloud' | 'self';

export const PricingPage = ({ embed, tab: initialTab }: { embed?: boolean; tab?: Tab }) => {
  const pricing = usePublicPricing();
  const { productName } = useBranding();
  const data = pricing.data;
  const [tab, setTab] = useState<Tab>(initialTab ?? 'cloud');
  if (pricing.isPending)
    return (
      <main className="min-h-dvh bg-shell px-4 py-10" data-testid="pricing-loading">
        <div className="mx-auto max-w-[1240px] rounded-[20px] bg-surface p-6">
          <SkeletonRows rows={6} label={t('app.loading')} />
        </div>
      </main>
    );
  if (!data?.enabled)
    return (
      <AuthShell title={t('pricing.title')} testId="pricing-off">
        <Notice tone="info">{t('pricing.unavailable')}</Notice>
      </AuthShell>
    );
  const selfTab = tab === 'self' && !!data.self_host;
  return (
    <div className="flex min-h-dvh flex-col bg-surface-3 text-fg" data-testid="pricing">
      <div className="flex flex-col gap-9 bg-shell bg-[radial-gradient(1200px_600px_at_80%_-10%,rgba(255,176,32,0.10),transparent_60%)] px-4 pb-[150px] md:px-12">
        {embed ? (
          <div className="h-6" />
        ) : (
          <header className="flex h-[72px] items-center gap-2.5">
            <a href="/" className="flex items-center gap-2.5 text-white no-underline">
              <span className="grid size-9 place-items-center rounded-full bg-accent font-display text-lg font-extrabold text-on-accent">
                {productName.trim().charAt(0).toUpperCase()}
              </span>
              <span className="font-display text-xl font-extrabold">{productName}</span>
            </a>
            <nav aria-label={t('pricing.nav')} className="ms-auto flex items-center gap-5 text-sm">
              <a href="/login" className="text-shell-fg no-underline hover:text-white" data-testid="pricing-login">
                {t('pricing.login')}
              </a>
              {data.signup_open ? (
                <a
                  href="/signup"
                  className="inline-flex h-10 items-center rounded-[12px] bg-accent px-4 text-on-accent no-underline"
                  data-testid="pricing-signup"
                >
                  {t('pricing.tryFree')}
                </a>
              ) : null}
            </nav>
          </header>
        )}
        <div className="flex flex-col items-center gap-3.5 text-center">
          <h1 className="font-display text-[2rem] font-extrabold tracking-[-0.8px] text-white md:text-[2.75rem]">
            {data.headline || t('pricing.headline')}
          </h1>
          <p className="max-w-[720px] text-base text-shell-fg">{data.subheadline || t('pricing.subheadline')}</p>
          {data.self_host ? (
            <div
              role="tablist"
              aria-label={t('pricing.tabs.label')}
              className="mt-1.5 flex gap-0.5 rounded-[12px] bg-white/[0.08] p-1"
            >
              {(['cloud', 'self'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={tab === k}
                  aria-controls={`pricing-panel-${k}`}
                  id={`pricing-tab-${k}`}
                  onClick={() => setTab(k)}
                  className={cn(
                    'inline-flex h-9 items-center rounded-[9px] px-3.5 text-[0.8125rem]',
                    tab === k ? 'bg-white text-shell' : 'text-shell-fg hover:text-white',
                  )}
                  data-testid={`pricing-tab-${k}`}
                >
                  {t(`pricing.tabs.${k}`)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
      <main
        id={selfTab ? 'pricing-panel-self' : 'pricing-panel-cloud'}
        role={data.self_host ? 'tabpanel' : undefined}
        aria-labelledby={data.self_host ? `pricing-tab-${selfTab ? 'self' : 'cloud'}` : undefined}
        className="mx-auto -mt-[110px] flex w-full max-w-[1240px] flex-col gap-7 px-4 pb-16"
      >
        {selfTab ? <SelfHostPanel data={data} /> : <CloudPanel data={data} />}
      </main>
    </div>
  );
};

/** The plan's button: a trial / a free start at sign-up when it is open, else "talk to us" (or nothing). */
const PlanCta = ({ plan, data, paid }: { plan: PricingPlan; data: PublicPricing; paid: boolean }) => {
  const cls = cn(
    'flex h-11 items-center justify-center rounded-[12px] text-sm no-underline',
    plan.recommended ? 'bg-accent text-on-accent' : 'bg-primary text-on-primary',
  );
  if (data.signup_open)
    return (
      <a href={`/signup?plan=${encodeURIComponent(plan.id)}`} className={cls} data-testid={`pricing-cta-${plan.id}`}>
        {!paid
          ? t('pricing.cta.free')
          : plan.trial_days > 0
            ? t('pricing.cta.trial', { days: count(plan.trial_days) })
            : t('pricing.cta.start')}
      </a>
    );
  if (data.contact_url)
    return (
      <a href={data.contact_url} className={cls} data-testid={`pricing-cta-${plan.id}`}>
        {t('pricing.cta.contact')}
      </a>
    );
  return null;
};

/** "שקל חדש" / "US dollar" (the code when the browser has no name for it). */
const currencyName = (code: string) => {
  try {
    return new Intl.DisplayNames([getLocale() === 'en' ? 'en' : 'he'], { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
};

const CloudPanel = ({ data }: { data: PublicPricing }) => {
  const calc = useCalculator({ vat: data.vat_default_on });
  const plans = data.plans;
  const cols = Math.min(4, Math.max(1, plans.length));
  const noMinimum = plans.every((p) => !p.min_seats || p.min_seats <= 1);
  const currency = plans[0]?.currency;
  return (
    <>
      <section
        aria-label={t('pricing.calculator')}
        className="grid grid-cols-1 items-start gap-7 rounded-[20px] bg-surface p-6 shadow-[0_24px_60px_rgba(13,59,53,0.14)] md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1.4fr)] md:px-7"
        data-testid="pricing-calculator"
      >
        <SeatsStepper calc={calc} id="pricing-seats" testId="pricing-seats" />
        <div className="flex flex-col gap-3.5">
          <IntervalSwitch calc={calc} yearlyNote={data.yearly_note || null} />
          <VatSwitch calc={calc} vatPct={data.vat_pct} />
        </div>
        <AddonRows calc={calc} addons={data.addons} vatPct={data.vat_pct} />
      </section>

      {plans.length ? (
        <div
          className={cn(
            'grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2',
            cols >= 3 && 'lg:grid-cols-3',
            cols >= 4 && 'xl:grid-cols-4',
          )}
          data-testid="pricing-plans"
        >
          {plans.map((p) => {
            const quote = quoteFor(p, calc, data.addons, data.vat_pct);
            return (
              <PlanCard
                key={p.id}
                plan={p}
                quote={quote}
                calc={calc}
                cta={<PlanCta plan={p} data={data} paid={quote.paid} />}
                testId={`pricing-plan-${p.id}`}
              />
            );
          })}
        </div>
      ) : (
        <Notice tone="info">{t('pricing.noPlans')}</Notice>
      )}

      {data.custom ? (
        <section
          className="flex flex-wrap items-center gap-5 rounded-[16px] bg-shell px-6 py-5 text-white"
          data-testid="pricing-custom"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h2 className="font-display text-xl font-medium">{data.custom.name}</h2>
            {data.custom.text ? <p className="text-[0.8125rem] text-shell-fg">{data.custom.text}</p> : null}
          </div>
          {data.contact_url ? (
            <a
              href={data.contact_url}
              className="inline-flex h-11 items-center rounded-[12px] bg-accent px-[18px] text-sm text-on-accent no-underline"
            >
              {t('pricing.cta.contact')}
            </a>
          ) : null}
        </section>
      ) : null}

      {plans.length ? <CompareTable plans={plans} catalogue={data.features} /> : null}

      {data.faq.length ? (
        <section
          aria-labelledby="pricing-faq"
          className="grid grid-cols-1 gap-4 md:grid-cols-3"
          data-testid="pricing-faq"
        >
          <h2 id="pricing-faq" className="font-display text-lg font-medium text-heading md:col-span-3">
            {t('pricing.faq')}
          </h2>
          {data.faq.map((f, i) => (
            <div key={i} className="flex flex-col gap-1.5 rounded-[16px] border border-line bg-surface p-4">
              <h3 className="text-sm font-normal text-fg">{f.q}</h3>
              <p className="text-[0.8125rem] leading-normal whitespace-pre-line text-muted">{f.a}</p>
            </div>
          ))}
        </section>
      ) : null}

      <p className="text-center text-xs text-muted" data-testid="pricing-footnote">
        {[
          noMinimum ? t('pricing.foot.noMinimum') : null,
          currency
            ? t(calc.withVat ? 'pricing.foot.withVat' : 'pricing.foot.noVat', { currency: currencyName(currency) })
            : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
    </>
  );
};

// ------------------------------------------------------------------------------------------------ self-hosted

const SUPPORT_KEY = { community: 'community', standard: 'standard', sla: 'sla' } as const;
const SELF_LABEL = {
  unregistered: 'licensing.plan.community',
  registered: 'licensing.plan.registered',
  business: 'licensing.plan.business',
  enterprise: 'licensing.plan.enterprise',
} as const;

const featureCell = (on: boolean, key: LicensedFeatureKey | null) => (
  <>
    {on ? <CheckIcon className="text-ok" /> : <span aria-hidden="true">—</span>}
    <span className="sr-only">{on ? t('pricing.compare.yes') : t('pricing.compare.no')}</span>
    {on && key && !LICENSED_FEATURES_BUILT.includes(key) ? (
      <span className="ms-1.5 text-xs text-muted">{t('pricing.self.soon')}</span>
    ) : null}
  </>
);

/**
 * The self-hosted editions (the license server only): everything is included and free on any installation (no key,
 * no limits); a key names a plan with its seats and support. Business by tiers, how to get each.
 */
const SelfHostPanel = ({ data }: { data: PublicPricing }) => {
  const host = data.self_host!;
  const business = host.editions.find((e) => e.plan === 'business');
  const tiers = business?.tiers ?? [];
  const [tier, setTier] = useState(tiers[0]?.index ?? 0);
  const chosen = tiers.find((x) => x.index === tier) ?? tiers[0];
  // The first column is Community: no key at all.
  const editions = ['unregistered', 'registered', 'business', 'enterprise'] as const;
  const label = (ed: (typeof editions)[number]) => t(SELF_LABEL[ed]);
  const has = (ed: (typeof editions)[number], key: LicensedFeatureKey) =>
    ed === 'enterprise' ||
    (ed === 'business' && !(ENTERPRISE_FEATURE_KEYS as readonly string[]).includes(key)) ||
    (ed === 'registered' && (REGISTERED_FEATURE_KEYS as readonly string[]).includes(key));
  const th = 'border-b border-line px-3.5 py-3 text-start text-[0.8125rem] font-normal text-heading';
  const td = 'border-b border-line-soft px-3.5 py-[11px] text-[0.8125rem] text-fg-2';
  const card = 'flex flex-col gap-3 rounded-[16px] border border-line bg-surface p-5';
  return (
    <>
      <section
        className="grid grid-cols-1 gap-4 rounded-[20px] bg-surface p-6 shadow-[0_24px_60px_rgba(13,59,53,0.14)] md:grid-cols-3"
        data-testid="pricing-self"
      >
        <div className={card}>
          <h2 className="font-display text-xl font-medium text-heading">{t('pricing.self.free')}</h2>
          <span className="font-display text-[2.5rem] leading-none text-fg">{t('pricing.self.zero')}</span>
          <p className="text-[0.8125rem] leading-normal text-muted">{t('pricing.self.freeText')}</p>
        </div>
        <div className={cn(card, 'border-2 border-accent')} data-testid="pricing-self-business">
          <h2 className="font-display text-xl font-medium text-heading">{t('licensing.plan.business')}</h2>
          {chosen ? (
            <>
              <div className="flex flex-wrap items-baseline gap-1.5">
                <span className="font-display text-[2.5rem] leading-none text-fg">
                  {chosen.amount !== null ? money(chosen.amount, business!.currency) : t('pricing.self.ask')}
                </span>
                {chosen.amount !== null ? (
                  <span className="text-[0.8125rem] text-muted">{t('pricing.self.perYear')}</span>
                ) : null}
              </div>
              {tiers.length > 1 ? (
                <div role="radiogroup" aria-label={t('pricing.self.tier')} className="flex flex-wrap gap-1.5">
                  {tiers.map((x) => (
                    <button
                      key={x.index}
                      type="button"
                      role="radio"
                      aria-checked={x.index === chosen.index}
                      onClick={() => setTier(x.index)}
                      className={cn(
                        'inline-flex h-9 items-center rounded-[9px] border px-3 text-[0.8125rem]',
                        x.index === chosen.index
                          ? 'border-primary bg-primary text-on-primary'
                          : 'border-line-strong text-fg-2',
                      )}
                      data-testid={`pricing-tier-${x.index}`}
                    >
                      {x.seats ? t('pricing.self.upTo', { seats: count(x.seats) }) : t('pricing.self.unlimited')}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="text-[0.8125rem] text-fg-2">
                  {chosen.seats ? t('pricing.self.upTo', { seats: count(chosen.seats) }) : t('pricing.self.unlimited')}
                </span>
              )}
              {host.buy_available ? (
                <a
                  href={`/buy?plan=business&tier=${chosen.index}`}
                  className="flex h-11 items-center justify-center rounded-[12px] bg-accent text-sm text-on-accent no-underline"
                  data-testid="pricing-self-buy"
                >
                  {t('pricing.self.buy')}
                </a>
              ) : data.contact_url ? (
                <a
                  href={data.contact_url}
                  className="flex h-11 items-center justify-center rounded-[12px] bg-primary text-sm text-on-primary no-underline"
                >
                  {t('pricing.cta.contact')}
                </a>
              ) : null}
            </>
          ) : (
            <p className="text-[0.8125rem] text-muted">{t('pricing.self.ask')}</p>
          )}
        </div>
        <div className={card}>
          <h2 className="font-display text-xl font-medium text-heading">{t('licensing.plan.enterprise')}</h2>
          <span className="font-display text-[1.75rem] leading-none text-fg">{t('pricing.self.ask')}</span>
          <p className="text-[0.8125rem] leading-normal text-muted">{t('pricing.self.enterpriseText')}</p>
          {data.contact_url ? (
            <a
              href={data.contact_url}
              className="flex h-11 items-center justify-center rounded-[12px] bg-primary text-sm text-on-primary no-underline"
            >
              {t('pricing.cta.contact')}
            </a>
          ) : null}
        </div>
      </section>

      <section
        aria-labelledby="pricing-self-compare"
        className="overflow-hidden rounded-[16px] border border-line bg-surface"
      >
        <h2 id="pricing-self-compare" className="px-[18px] py-4 font-display text-lg font-medium text-heading">
          {t('pricing.self.compare')}
        </h2>
        <div
          className="relative overflow-x-auto focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
          role="region"
          aria-labelledby="pricing-self-compare"
          tabIndex={0}
        >
          <table className="w-full min-w-[640px] border-collapse">
            <thead>
              <tr>
                <th scope="col" className={cn(th, 'w-[34%]')}>
                  <span className="sr-only">{t('pricing.compare.what')}</span>
                </th>
                {editions.map((ed) => (
                  <th key={ed} scope="col" className={th}>
                    {label(ed)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {COMMUNITY_CAPABILITIES.map((c) => (
                <tr key={c}>
                  <th scope="row" className={cn(td, 'font-normal text-fg')}>
                    {t(`pricing.capability.${c}`)}
                  </th>
                  {editions.map((ed) => (
                    <td key={ed} className={td}>
                      {featureCell(true, null)}
                    </td>
                  ))}
                </tr>
              ))}
              {[...REGISTERED_FEATURE_KEYS, ...BUSINESS_FEATURE_KEYS, ...ENTERPRISE_FEATURE_KEYS].map((key) => (
                <tr key={key}>
                  <th scope="row" className={cn(td, 'font-normal text-fg')}>
                    {t(`licensing.feature.${key}`)}
                  </th>
                  {editions.map((ed) => (
                    <td key={ed} className={td}>
                      {featureCell(has(ed, key), key)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr>
                <th scope="row" className={cn(td, 'font-normal text-fg')}>
                  {t('pricing.self.support')}
                </th>
                {editions.map((ed) => (
                  <td key={ed} className={td}>
                    {t(`licensing.support.${SUPPORT_KEY[EDITION_SUPPORT[ed]]}`)}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <p className="text-center text-xs text-muted">{t('pricing.self.foot')}</p>
    </>
  );
};
