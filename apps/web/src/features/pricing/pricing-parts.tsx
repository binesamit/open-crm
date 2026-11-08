// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import {
  getLocale,
  isPlanFeatureKey,
  PLAN_FEATURE_KEYS,
  PLAN_LIMIT_KINDS,
  type PlanLimitKind,
  planIncludesFeature,
  type PlanQuote,
  type PricingAddon,
  type PricingPlan,
  type QuoteInterval,
  quotePlan,
  t,
} from '@bines/shared';
import { cn } from '@bines/ui';

/**
 * The pricing calculator's pieces (canvas "דף מחירים ומחשבון", variant A): the seats stepper, the
 * billing switch, the VAT switch, the add-on rows and the plan card — shared by the public page (`/pricing`) and the
 * upgrade dialog. Every number comes from `quotePlan` (@bines/shared), the one calculation the server shares.
 */

export const SEATS_MAX = 100_000;

/** "₪69" / "$590": the symbol first, whole units (the canvas). */
export const money = (n: number, currency: string) => {
  try {
    const parts = new Intl.NumberFormat(getLocale() === 'en' ? 'en-US' : 'he-IL', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: 0,
      minimumFractionDigits: 0,
    }).formatToParts(Math.round(n));
    const symbol = parts.find((p) => p.type === 'currency')?.value ?? '';
    const digits = parts
      .filter((p) => p.type === 'integer' || p.type === 'group' || p.type === 'minusSign')
      .map((p) => p.value)
      .join('');
    return `${symbol}${digits}`;
  } catch {
    return `${Math.round(n)} ${currency}`;
  }
};

export const count = (n: number) =>
  new Intl.NumberFormat(getLocale() === 'en' ? 'en-US' : 'he-IL', { maximumFractionDigits: 0 }).format(n);

/** A limit as the comparison table shows it (null = unlimited). */
export const limitText = (kind: PlanLimitKind, v: number | null | undefined) => {
  if (v === null || v === undefined) return t('pricing.unlimited');
  if (kind === 'storage_gb') return v >= 1024 && v % 1024 === 0 ? `${count(v / 1024)}TB` : `${count(v)}GB`;
  if (kind === 'ai_usd') return `$${count(v)}`;
  return count(v);
};

/** The calculator's state: seats (as typed), the interval, VAT, add-on quantities. */
export const useCalculator = (init: { seats?: number; vat?: boolean; interval?: QuoteInterval } = {}) => {
  const [seatsText, setSeatsText] = useState(String(init.seats ?? 5));
  const [interval, setInterval] = useState<QuoteInterval>(init.interval ?? 'year');
  const [withVat, setWithVat] = useState(!!init.vat);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const seats = Math.min(SEATS_MAX, Math.max(1, Number(seatsText) || 1));
  return {
    seats,
    seatsText,
    setSeatsText: (v: string) => setSeatsText(v.replace(/[^0-9]/g, '').slice(0, 6)),
    tidySeats: () => setSeatsText(String(seats)),
    step: (d: number) => setSeatsText(String(Math.min(SEATS_MAX, Math.max(1, seats + d)))),
    interval,
    setInterval,
    withVat,
    setWithVat,
    quantities,
    setQty: (id: string, qty: number) => setQuantities((q) => ({ ...q, [id]: qty })),
  };
};
export type Calculator = ReturnType<typeof useCalculator>;

export const quoteFor = (
  plan: PricingPlan,
  calc: Pick<Calculator, 'seats' | 'interval' | 'withVat' | 'quantities'>,
  addons: PricingAddon[],
  vatPct: number,
): PlanQuote =>
  quotePlan(plan, {
    seats: calc.seats,
    interval: calc.interval,
    withVat: calc.withVat,
    vatPct,
    addons,
    quantities: calc.quantities,
  });

const MinusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M5 12h14" />
  </svg>
);
const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const CheckIcon = ({ className }: { className?: string }) => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.6"
    className={className}
    aria-hidden="true"
  >
    <path d="M5 12l5 5 9-10" />
  </svg>
);

const stepBtn =
  'grid shrink-0 place-items-center rounded-[12px] border border-line-strong bg-surface text-heading hover:bg-surface-2 disabled:opacity-40';

/** "How many people?": − [n] + (44px targets). */
export const SeatsStepper = ({ calc, id, testId }: { calc: Calculator; id: string; testId?: string }) => (
  <div className="flex flex-col gap-2">
    <label htmlFor={id} className="text-xs text-fg-2">
      {t('pricing.seats.label')}
    </label>
    <div className="flex items-center gap-2">
      <button
        type="button"
        className={cn(stepBtn, 'size-11')}
        aria-label={t('pricing.seats.less')}
        disabled={calc.seats <= 1}
        onClick={() => calc.step(-1)}
        data-testid={testId ? `${testId}-less` : undefined}
      >
        <MinusIcon />
      </button>
      <input
        id={id}
        inputMode="numeric"
        value={calc.seatsText}
        onChange={(e) => calc.setSeatsText(e.target.value)}
        onBlur={calc.tidySeats}
        className="h-11 w-[84px] rounded-[12px] border border-line-strong bg-surface text-center text-lg text-fg"
        data-testid={testId}
      />
      <button
        type="button"
        className={cn(stepBtn, 'size-11')}
        aria-label={t('pricing.seats.more')}
        onClick={() => calc.step(1)}
        data-testid={testId ? `${testId}-more` : undefined}
      >
        <PlusIcon />
      </button>
    </div>
    <span className="text-xs text-muted">{t('pricing.seats.hint')}</span>
  </div>
);

const segBtn = (on: boolean) =>
  cn(
    'inline-flex h-9 items-center gap-1.5 rounded-[9px] px-3.5 text-[0.8125rem]',
    on ? 'bg-primary text-on-primary' : 'text-fg-2 hover:text-fg',
  );

/** Monthly / yearly (yearly carries the owner's saving note when there is one). */
export const IntervalSwitch = ({
  calc,
  yearlyNote,
  testId = 'pricing-interval',
}: {
  calc: Calculator;
  yearlyNote?: string | null;
  testId?: string;
}) => (
  <div className="flex flex-col gap-2">
    <span className="text-xs text-fg-2" id={`${testId}-label`}>
      {t('pricing.interval.label')}
    </span>
    <div
      role="radiogroup"
      aria-labelledby={`${testId}-label`}
      className="inline-flex gap-0.5 self-start rounded-[12px] bg-surface-2 p-[3px]"
      data-testid={testId}
    >
      <button
        type="button"
        role="radio"
        aria-checked={calc.interval === 'month'}
        className={segBtn(calc.interval === 'month')}
        onClick={() => calc.setInterval('month')}
        data-testid={`${testId}-month`}
      >
        {t('pricing.interval.month')}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={calc.interval === 'year'}
        className={segBtn(calc.interval === 'year')}
        onClick={() => calc.setInterval('year')}
        data-testid={`${testId}-year`}
      >
        {t('pricing.interval.year')}
        {yearlyNote ? (
          <span className="inline-flex h-5 items-center rounded-full bg-accent-soft px-[7px] text-[0.6875rem] text-accent-fg">
            {yearlyNote}
          </span>
        ) : null}
      </button>
    </div>
  </div>
);

/** "Incl. VAT (18%)". */
export const VatSwitch = ({
  calc,
  vatPct,
  testId = 'pricing-vat',
}: {
  calc: Calculator;
  vatPct: number;
  testId?: string;
}) => (
  <label className="flex cursor-pointer items-center gap-2 text-[0.8125rem] text-fg">
    <input
      type="checkbox"
      role="switch"
      checked={calc.withVat}
      onChange={(e) => calc.setWithVat(e.target.checked)}
      data-testid={testId}
      className={cn(
        'relative h-5 w-9 shrink-0 cursor-pointer appearance-none rounded-full bg-[var(--switch-off)] transition-colors checked:bg-ok',
        "after:absolute after:top-0.5 after:start-0.5 after:size-4 after:rounded-full after:bg-white after:shadow-[0_1px_2px_rgba(0,0,0,0.25)] after:transition-[inset-inline-start] after:content-['']",
        'checked:after:start-[18px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
      )}
    />
    {t('pricing.vat', { pct: count(vatPct) })}
  </label>
);

/** The add-on rows: − qty + name … price per month. */
export const AddonRows = ({
  calc,
  addons,
  vatPct,
  only,
}: {
  calc: Calculator;
  addons: PricingAddon[];
  vatPct: number;
  /** Only these (the add-ons that can be bought here); undefined = all. */
  only?: string[];
}) => {
  const shown = only ? addons.filter((a) => only.includes(a.id)) : addons;
  if (!shown.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs text-fg-2">{t('pricing.addons.label')}</span>
      {shown.map((a) => {
        const qty = calc.quantities[a.id] ?? 0;
        const vat = 1 + vatPct / 100;
        const net = a.vat_included ? a.price_monthly / vat : a.price_monthly;
        const price = calc.withVat ? net * vat : net;
        return (
          <div
            key={a.id}
            className="flex items-center gap-2.5 text-[0.8125rem] text-fg"
            data-testid={`pricing-addon-${a.id}`}
          >
            <button
              type="button"
              className={cn(stepBtn, 'size-8 rounded-[9px]')}
              aria-label={t('pricing.addons.less', { name: a.name })}
              disabled={qty <= 0}
              onClick={() => calc.setQty(a.id, Math.max(0, qty - 1))}
            >
              <MinusIcon />
            </button>
            <span className="w-[18px] text-center" aria-live="polite">
              {qty}
            </span>
            <button
              type="button"
              className={cn(stepBtn, 'size-8 rounded-[9px]')}
              aria-label={t('pricing.addons.more', { name: a.name })}
              disabled={qty >= a.max_qty}
              onClick={() => calc.setQty(a.id, Math.min(a.max_qty, qty + 1))}
              data-testid={`pricing-addon-${a.id}-more`}
            >
              <PlusIcon />
            </button>
            <span className="min-w-0 truncate">{a.name}</span>
            <span className="ms-auto shrink-0 text-muted">
              {t('pricing.perMonth', { price: money(price, a.currency) })}
            </span>
          </div>
        );
      })}
    </div>
  );
};

/** The plan card (variant A): name, mark, line, unit price, the totals box, the button, the selling points. */
export const PlanCard = ({
  plan,
  quote,
  calc,
  cta,
  testId,
}: {
  plan: PricingPlan;
  quote: PlanQuote;
  calc: Pick<Calculator, 'seats' | 'interval'>;
  cta: ReactNode;
  testId?: string;
}) => {
  const perSeat = plan.pricing === 'per_seat';
  const unit = !quote.paid ? t('pricing.unit.free') : t(`pricing.unit.${perSeat ? 'seat' : 'flat'}.${calc.interval}`);
  return (
    <article
      className={cn(
        'flex flex-col gap-3.5 rounded-[16px] bg-surface p-5',
        plan.recommended ? 'border-2 border-accent shadow-[0_12px_32px_rgba(255,176,32,0.18)]' : 'border border-line',
        !quote.fits && 'opacity-[0.72]',
      )}
      data-testid={testId}
    >
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 className="font-display text-xl font-medium text-heading">{plan.name}</h2>
        {plan.recommended ? (
          <span className="inline-flex h-6 items-center rounded-full bg-accent px-[9px] text-xs text-on-accent">
            {t('pricing.recommended')}
          </span>
        ) : null}
      </div>
      {plan.description ? <p className="text-[0.8125rem] text-muted">{plan.description}</p> : null}
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span
          className="font-display text-[2.5rem] leading-none font-normal tracking-[-1px] text-fg"
          data-testid={testId ? `${testId}-unit` : undefined}
        >
          {money(quote.unit_month, plan.currency)}
        </span>
        <span className="text-[0.8125rem] text-muted">{unit}</span>
      </div>
      <div
        className="flex min-h-16 flex-col gap-1 rounded-[12px] bg-surface-3 p-3 text-[0.8125rem] text-fg-2"
        aria-live="polite"
        data-testid={testId ? `${testId}-total` : undefined}
      >
        {!quote.fits ? (
          <span className="text-accent-fg">
            {t('pricing.noFit', { max: count(plan.limits.seats ?? 0), seats: count(calc.seats) })}
          </span>
        ) : quote.paid ? (
          <>
            <span>
              {t(perSeat ? 'pricing.total.seats' : 'pricing.total.month', {
                price: money(quote.month_total, plan.currency),
                seats: count(quote.seats_billed),
              })}
            </span>
            <span className="text-muted">
              {t('pricing.total.year', { price: money(quote.year_total, plan.currency) })}
            </span>
            {quote.yearly_saving > 0 ? (
              <span className="text-ok-fg">
                {t('pricing.save', { price: money(quote.yearly_saving, plan.currency) })}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <span>{t('pricing.free.noCard')}</span>
            {plan.limits.seats != null ? (
              <span className="text-muted">{t('pricing.free.upTo', { max: count(plan.limits.seats) })}</span>
            ) : null}
          </>
        )}
      </div>
      {cta}
      {plan.highlights.length ? (
        <ul className="flex flex-col gap-[9px]">
          {plan.highlights.map((h, i) => (
            <li key={i} className="flex items-start gap-2 text-[0.8125rem] leading-[1.45] text-fg-2">
              <CheckIcon className="mt-[3px] shrink-0 text-ok" />
              {h}
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  );
};

/**
 * The comparison table: one row per limit any plan sets, then one per feature (the gated keys, the owner's
 * catalogue, any a plan lists) — ✓ / — by `planIncludesFeature` (a version that lists none has them all).
 */
export const CompareTable = ({
  plans,
  catalogue,
  testId = 'pricing-compare',
}: {
  plans: PricingPlan[];
  catalogue: { key: string; label: string }[];
  testId?: string;
}) => {
  const labels = new Map(catalogue.map((f) => [f.key, f.label]));
  const kinds = PLAN_LIMIT_KINDS.filter((k) => plans.some((p) => p.limits[k] != null));
  const listed = plans.flatMap((p) => p.features.map((f) => f.key));
  const featureKeys = [...new Set<string>([...PLAN_FEATURE_KEYS, ...catalogue.map((f) => f.key), ...listed])];
  const featureLabel = (key: string) => labels.get(key) ?? (isPlanFeatureKey(key) ? t(`plan.feature.${key}`) : key);
  const th = 'border-b border-line px-3.5 py-3 text-start text-[0.8125rem] font-normal text-heading';
  const td = 'border-b border-line-soft px-3.5 py-[11px] text-[0.8125rem] text-fg-2';
  const hl = (p: PricingPlan) => (p.recommended ? 'bg-[color-mix(in_srgb,var(--accent)_7%,var(--surface))]' : '');
  return (
    <section
      aria-labelledby={`${testId}-title`}
      className="overflow-hidden rounded-[16px] border border-line bg-surface"
      data-testid={testId}
    >
      <h2 id={`${testId}-title`} className="px-[18px] py-4 font-display text-lg font-medium text-heading">
        {t('pricing.compare.title')}
      </h2>
      {/* Keyboard users can scroll the wide table too (WCAG 2.1.1, axe scrollable-region-focusable). */}
      <div
        className="relative overflow-x-auto focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
        role="region"
        aria-labelledby={`${testId}-title`}
        tabIndex={0}
      >
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr>
              <th scope="col" className={cn(th, 'w-[28%]')}>
                <span className="sr-only">{t('pricing.compare.what')}</span>
              </th>
              {plans.map((p) => (
                <th key={p.id} scope="col" className={cn(th, hl(p))}>
                  {p.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {kinds.map((k) => (
              <tr key={k}>
                <th scope="row" className={cn(td, 'font-normal text-fg')}>
                  {t(`plan.kind.${k}`)}
                </th>
                {plans.map((p) => (
                  <td key={p.id} className={cn(td, hl(p))}>
                    {limitText(k, p.limits[k])}
                  </td>
                ))}
              </tr>
            ))}
            {featureKeys.map((key) => (
              <tr key={key}>
                <th scope="row" className={cn(td, 'font-normal text-fg')}>
                  {featureLabel(key)}
                </th>
                {plans.map((p) => {
                  const keys = p.features.map((f) => f.key);
                  const on = planIncludesFeature(keys, key);
                  return (
                    <td key={p.id} className={cn(td, hl(p))}>
                      {on ? <CheckIcon className="text-ok" /> : <span aria-hidden="true">—</span>}
                      <span className="sr-only">{on ? t('pricing.compare.yes') : t('pricing.compare.no')}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
