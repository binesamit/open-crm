// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type AccountPlan,
  formatCurrency,
  formatInstantDate,
  formatNumber,
  type MyAccount,
  type PlanCancelPreview,
  type PlanCheckoutOptions,
  type PlanOffer,
  type PlanUsage,
  quotePlan,
  type SubscriptionStatus,
  t,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, cn, Dialog, Field, Input, Notice, Picker, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { TD, TH, TR } from '../trash/TrashPage';
import { Panel, SectionHeader } from './admin-parts';
import { AddonRows, IntervalSwitch, money, SeatsStepper, useCalculator, VatSwitch } from '../pricing/pricing-parts';
import { legalHref, PurchaseConsentCheckbox } from '../legal/legal-links';

export const myPlanKey = (accountId: string) => ['account', accountId, 'plan'] as const;

/** Badge tone of a subscription status. */
export const STATUS_TONE: Record<SubscriptionStatus, 'ok' | 'info' | 'warn' | 'danger'> = {
  trial: 'info',
  active: 'ok',
  past_due: 'warn',
  read_only: 'danger',
  suspended: 'danger',
  closed: 'danger',
};

/** One limit's numbers in its unit: "8 / 10", "1.2 / 5 GB", "$3.20 / $10". */
export const usageText = (u: Pick<PlanUsage, 'kind' | 'used' | 'limit'>) => {
  const fmt = (v: number) =>
    u.kind === 'ai_usd'
      ? formatCurrency(v, 'USD')
      : u.kind === 'storage_gb'
        ? `${formatNumber(v, { maximumFractionDigits: 2 })} GB`
        : formatNumber(v);
  return u.limit === null ? `${fmt(u.used)} · ${t('plan.unlimited')}` : `${fmt(u.used)} / ${fmt(u.limit)}`;
};

/** A usage bar: the share used; amber from the warning share, red at the limit. */
export const UsageBar = ({ u, warnPct = 80 }: { u: PlanUsage; warnPct?: number }) => {
  const pct = u.pct ?? 0;
  return (
    <div className="space-y-1.5" data-testid="plan-usage" data-kind={u.kind} data-pct={u.pct ?? ''}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-semibold text-fg">{t(`plan.kind.${u.kind}`)}</span>
        <span className="text-xs text-muted tabular-nums" dir="ltr">
          {usageText(u)}
        </span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-surface-2"
        role="progressbar"
        aria-label={t(`plan.kind.${u.kind}`)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={u.limit === null ? undefined : Math.min(pct, 100)}
      >
        {u.limit !== null ? (
          <div
            className={cn(
              'h-full rounded-full',
              pct >= 100 ? 'bg-danger' : pct >= warnPct ? 'bg-accent' : 'bg-primary',
            )}
            style={{ inlineSize: `${Math.min(Math.max(pct, 2), 100)}%` }}
          />
        ) : null}
      </div>
      {u.period !== 'stock' ? <p className="text-[0.6875rem] text-muted">{t(`plan.period.${u.period}`)}</p> : null}
    </div>
  );
};

const date = (iso: string | null) => (iso ? formatInstantDate(iso) : '—');

/** The body shared by "My plan" and the owner console's account dialog. */
export const PlanSummary = ({ plan }: { plan: AccountPlan }) => {
  const s = plan.subscription;
  const labels = new Map(plan.features.map((f) => [f.key, f.label]));
  return (
    <div className="flex flex-col gap-4">
      {s ? (
        <div
          className="flex flex-wrap items-center gap-x-6 gap-y-2"
          data-testid="plan-current"
          data-status={s.effective_status}
        >
          <span className="font-display text-xl font-extrabold text-heading" data-testid="plan-name">
            {s.plan_name}
          </span>
          <Badge tone={STATUS_TONE[s.effective_status]}>{t(`plan.status.${s.effective_status}`)}</Badge>
          <span className="text-sm text-fg-2">
            {t(`plan.interval.${s.interval}`)} · {t('plan.version', { n: s.version })}
          </span>
          {s.trial_ends_at && s.effective_status === 'trial' ? (
            <span className="text-sm text-fg-2">{t('plan.trialEnds', { date: date(s.trial_ends_at) })}</span>
          ) : s.period_end ? (
            <span className="text-sm text-fg-2">
              {t(s.cancel_at_period_end ? 'plan.endsOn' : 'plan.renewsOn', { date: date(s.period_end) })}
            </span>
          ) : null}
        </div>
      ) : (
        <Notice tone="info">{t('plan.legacy')}</Notice>
      )}
      {s &&
      (s.effective_status === 'read_only' ||
        s.effective_status === 'suspended' ||
        s.effective_status === 'closed' ||
        s.effective_status === 'past_due') ? (
        <Notice tone={s.effective_status === 'past_due' ? 'warn' : 'error'}>
          {t(`plan.statusHint.${s.effective_status}`)}
        </Notice>
      ) : null}
      <div className="grid gap-4 md:grid-cols-2" data-testid="plan-usage-list">
        {plan.usage.map((u) => (
          <UsageBar key={u.kind} u={u} />
        ))}
      </div>
      <PlanFeatures plan={plan} labels={labels} />
    </div>
  );
};

/** The label of a feature: the owner's catalogue, else the app's own (`plan.feature.<key>`), else the key. */
export const featureLabel = (key: string, labels: Map<string, string>) => {
  const own = labels.get(key);
  if (own) return own;
  const text = tDynamic(`plan.feature.${key}`);
  return text === `plan.feature.${key}` ? key : text;
};

/**
 * Plans: every feature, included or not (a plan that lists none includes them all). What is not
 * included is shown, never hidden, so an admin knows what an upgrade adds.
 */
const PlanFeatures = ({ plan, labels }: { plan: AccountPlan; labels: Map<string, string> }) => {
  const access = plan.feature_access ?? [];
  if (!access.length) return null;
  return (
    <div className="space-y-2" data-testid="plan-features" data-all={plan.entitlements.all_features ? '1' : '0'}>
      <p className="text-sm font-semibold text-fg">{t('plan.features')}</p>
      <ul className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
        {access.map((f) => (
          <li
            key={f.key}
            className={cn('flex items-center gap-2 text-sm', f.included ? 'text-fg' : 'text-muted')}
            data-testid="plan-feature"
            data-key={f.key}
            data-included={f.included ? '1' : '0'}
          >
            <Icon
              name={f.included ? 'check' : 'x'}
              size={14}
              className={cn('shrink-0', f.included ? 'text-ok' : 'text-muted')}
            />
            <span>{f.label ?? featureLabel(f.key, labels)}</span>
            {f.included ? null : <span className="text-[0.6875rem] text-muted">· {t('plan.feature.notIncluded')}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
};

export const PlanHistory = ({ plan }: { plan: AccountPlan }) =>
  plan.history.length ? (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] border-collapse text-sm">
        <thead>
          <tr>
            <th className={TH}>{t('plan.history.plan')}</th>
            <th className={TH}>{t('plan.history.status')}</th>
            <th className={TH}>{t('plan.history.from')}</th>
            <th className={TH}>{t('plan.history.to')}</th>
          </tr>
        </thead>
        <tbody>
          {plan.history.map((h) => (
            <tr key={h.id} className={TR} data-testid="plan-history-row">
              <td className={cn(TD, 'font-semibold text-fg')}>
                {h.plan_name} · {t('plan.version', { n: h.version })}
              </td>
              <td className={TD}>
                <Badge tone={STATUS_TONE[h.effective_status]}>{t(`plan.status.${h.effective_status}`)}</Badge>
              </td>
              <td className={cn(TD, 'tabular-nums')}>{date(h.created_at)}</td>
              <td className={cn(TD, 'tabular-nums')}>{h.ended_at ? date(h.ended_at) : t('plan.history.now')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="px-3.5 py-3 text-sm text-muted">{t('plan.history.empty')}</p>
  );

/**
 * Administration → החבילה שלי: the plan, every limit with its usage (8 / 10 users…), the included
 * features, the history, and "upgrade" — for now the owner's contact text / link (billing settings), until a
 * billing provider brings self-service checkout.
 */
export const AdminPlan = ({ account }: { account: MyAccount }) => {
  const plan = useQuery({
    queryKey: myPlanKey(account.id),
    queryFn: () => api(account.id).get<AccountPlan>('/plan'),
  });
  const [upgrade, setUpgrade] = useState(false);
  // Self sign-up (ה5): during a trial, admins ask for an upgrade (a ticket / an email to the platform owner).
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState(false);
  const mayAsk = account.role === 'admin' && account.plan_status === 'trial' && !account.support;
  // Self sign-up ה9: Upgrade pays online through Stripe when the platform sells its plans; else the owner's text.
  const checkout = useQuery({
    queryKey: [...myPlanKey(account.id), 'checkout'],
    queryFn: () => api(account.id).get<PlanCheckoutOptions>('/plan/checkout'),
    enabled: account.role === 'admin' && !account.support,
  });
  const online = !!checkout.data?.available;
  // Back from Stripe: paid (the webhook activates the plan in a moment) or cancelled.
  const [back] = useState(() => new URLSearchParams(window.location.search).get('checkout'));
  const qc = useQueryClient();
  useEffect(() => {
    if (back !== 'success') return;
    const id = window.setTimeout(() => void qc.invalidateQueries({ queryKey: myPlanKey(account.id) }), 4000);
    return () => window.clearTimeout(id);
  }, [back, qc, account.id]);
  const p = plan.data;
  return (
    <div className="flex flex-col gap-4 pb-12" data-testid="admin-plan">
      <SectionHeader
        title={t('admin.section.plan')}
        subtitle={t('plan.subtitle')}
        actions={
          p ? (
            <span className="flex flex-wrap gap-2">
              {mayAsk ? (
                <Button variant="secondary" data-testid="plan-upgrade-request" onClick={() => setAsking(true)}>
                  {t('plan.upgradeRequest.button')}
                </Button>
              ) : null}
              <Button variant="accent" data-testid="plan-upgrade" onClick={() => setUpgrade(true)}>
                {t('plan.upgrade')}
              </Button>
            </span>
          ) : null
        }
      />
      {back === 'success' ? (
        <Notice tone="success">
          <span data-testid="plan-checkout-success">{t('plan.checkout.success')}</span>
        </Notice>
      ) : back === 'cancel' ? (
        <Notice>
          <span data-testid="plan-checkout-cancel">{t('plan.checkout.cancel')}</span>
        </Notice>
      ) : null}
      {asked ? (
        <Notice tone="success">
          <span data-testid="plan-upgrade-request-sent">{t('plan.upgradeRequest.sent')}</span>
        </Notice>
      ) : null}
      {asking ? (
        <UpgradeRequestDialog
          account={account}
          onClose={() => setAsking(false)}
          onSent={() => {
            setAsking(false);
            setAsked(true);
          }}
        />
      ) : null}
      {plan.isPending ? <SkeletonRows rows={4} label={t('app.loading')} /> : null}
      {plan.isError ? <Notice tone="error">{errorMessage(plan.error)}</Notice> : null}
      {p ? (
        <>
          <Panel title={t('plan.current')} testId="plan-panel">
            <div className="p-3.5">
              <PlanSummary plan={p} />
            </div>
          </Panel>
          {account.role === 'admin' && !account.support ? <CancelPanel account={account} plan={p} /> : null}
          <Panel title={t('plan.history')} testId="plan-history">
            <PlanHistory plan={p} />
          </Panel>
        </>
      ) : null}
      {upgrade && p && online && checkout.data ? (
        <CheckoutDialog
          account={account}
          options={checkout.data}
          seatsInUse={p.usage?.find((u) => u.kind === 'seats')?.used ?? 1}
          onClose={() => setUpgrade(false)}
        />
      ) : null}
      {upgrade && p && !online ? (
        <Dialog open onClose={() => setUpgrade(false)} title={t('plan.upgrade')}>
          <div className="space-y-3 whitespace-pre-line" data-testid="plan-upgrade-dialog">
            <p className="text-sm text-fg">{p.upgrade.text ?? t('plan.upgradeFallback')}</p>
            {p.upgrade.url ? (
              <a
                href={p.upgrade.url}
                target="_blank"
                rel="noreferrer noopener"
                data-testid="plan-upgrade-link"
                className="press inline-flex h-9 items-center rounded-[10px] bg-primary px-3.5 text-[0.8125rem] font-semibold text-on-primary"
              >
                {t('plan.upgradeLink')}
              </a>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </div>
  );
};

/** "בקשת שדרוג" (self sign-up ה5): the plan wanted (the public ones, or "not sure") and a note — then a notice. */
const UpgradeRequestDialog = ({
  account,
  onClose,
  onSent,
}: {
  account: MyAccount;
  onClose: () => void;
  onSent: () => void;
}) => {
  const offer = useQuery({
    queryKey: ['public', 'plans'],
    queryFn: () => api().get<PlanOffer>('/plans/public'),
    staleTime: 5 * 60_000,
  });
  const [planId, setPlanId] = useState('');
  const [note, setNote] = useState('');
  const send = useMutation({
    mutationFn: () =>
      api(account.id).post('/plan/upgrade-request', {
        plan_id: planId || null,
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    onSuccess: onSent,
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('plan.upgradeRequest.title')}
      subtitle={t('plan.upgradeRequest.subtitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="primary"
            busy={send.isPending}
            onClick={() => send.mutate()}
            data-testid="plan-upgrade-request-send"
          >
            {t('plan.upgradeRequest.send')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 whitespace-normal" data-testid="plan-upgrade-request-dialog">
        <Field label={t('plan.upgradeRequest.plan')}>
          <Picker
            label={t('plan.upgradeRequest.plan')}
            value={planId}
            onChange={setPlanId}
            testId="plan-upgrade-request-plan"
            options={[
              { value: '', label: t('plan.upgradeRequest.anyPlan') },
              ...(offer.data?.data ?? []).map((pl) => ({
                value: pl.id,
                label: pl.name,
                testId: `plan-upgrade-request-plan-${pl.id}`,
              })),
            ]}
          />
        </Field>
        <Field label={t('plan.upgradeRequest.note')}>
          <Input
            value={note}
            maxLength={1000}
            onChange={(e) => setNote(e.target.value)}
            data-testid="plan-upgrade-request-note"
          />
        </Field>
        {send.isError ? (
          <Notice tone="error">
            <span data-testid="plan-upgrade-request-error">{errorMessage(send.error)}</span>
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
};

/**
 * "שדרוג" with online payment (ה9; the calculator): the plan, the interval, the seats (a per-seat
 * plan; never fewer than the people in the account) and the add-ons sold online — with the totals as the pricing page
 * counts them — then Stripe's own payment page.
 */
const CheckoutDialog = ({
  account,
  options,
  seatsInUse,
  onClose,
}: {
  account: MyAccount;
  options: PlanCheckoutOptions;
  seatsInUse: number;
  onClose: () => void;
}) => {
  const offer = useQuery({
    queryKey: ['public', 'plans'],
    queryFn: () => api(account.id).get<PlanOffer>('/plans/public'),
    staleTime: 60_000,
  });
  const [planId, setPlanId] = useState(options.plans[0]?.plan_id ?? '');
  const chosen = options.plans.find((x) => x.plan_id === planId);
  const plan = offer.data?.data.find((x) => x.id === planId);
  const calc = useCalculator({ seats: Math.max(1, seatsInUse), interval: chosen?.intervals[0] ?? 'month' });
  const intervals = chosen?.intervals ?? [];
  const interval = intervals.includes(calc.interval) ? calc.interval : (intervals[0] ?? 'month');
  const perSeat = plan?.pricing === 'per_seat';
  const minSeats = Math.max(1, seatsInUse, plan?.min_seats ?? 1);
  const seats = Math.max(calc.seats, minSeats);
  const sellable = (options.addons ?? []).filter(
    (a) => a.intervals.includes(interval) && (!plan || a.plan_ids.length === 0 || a.plan_ids.includes(plan.id)),
  );
  const quantities = Object.fromEntries(
    Object.entries(calc.quantities).filter(([id, q]) => q > 0 && sellable.some((a) => a.id === id)),
  );
  const quote = plan
    ? quotePlan(plan, {
        seats,
        interval,
        withVat: calc.withVat,
        vatPct: options.vat_pct ?? 0,
        addons: sellable,
        quantities,
      })
    : null;
  // The purchase documents: ticked before paying, sent with their versions.
  const purchaseDocs = options.legal ?? [];
  const [agreed, setAgreed] = useState(false);
  const go = useMutation({
    mutationFn: () =>
      api(account.id).post<{ url: string }>('/plan/checkout', {
        plan_id: planId,
        interval,
        ...(perSeat ? { seats } : {}),
        ...(Object.keys(quantities).length ? { addons: quantities } : {}),
        ...(purchaseDocs.length ? { accepted: purchaseDocs.map((d) => ({ slug: d.slug, version: d.version })) } : {}),
      }),
    onSuccess: ({ url }) => window.location.assign(url),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('plan.upgrade')}
      subtitle={t('plan.checkout.subtitle')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="accent"
            busy={go.isPending}
            disabled={!chosen || (quote ? !quote.fits : false) || (purchaseDocs.length > 0 && !agreed)}
            onClick={() => go.mutate()}
            data-testid="plan-checkout-go"
          >
            {t('plan.checkout.go')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 whitespace-normal" data-testid="plan-checkout-dialog">
        <Field label={t('plan.upgradeRequest.plan')}>
          <Picker
            label={t('plan.upgradeRequest.plan')}
            value={planId}
            onChange={setPlanId}
            testId="plan-checkout-plan"
            options={options.plans.map((pl) => ({
              value: pl.plan_id,
              label: pl.name,
              testId: `plan-checkout-plan-${pl.plan_id}`,
            }))}
          />
        </Field>
        {intervals.length > 1 ? <IntervalSwitch calc={{ ...calc, interval }} testId="plan-checkout-interval" /> : null}
        {perSeat ? (
          <div className="flex flex-col gap-1">
            <SeatsStepper calc={calc} id="plan-checkout-seats" testId="plan-checkout-seats" />
            {calc.seats < minSeats ? (
              <span className="text-xs text-accent-fg" data-testid="plan-checkout-seats-min">
                {t('plan.checkout.seatsMin', { n: formatNumber(minSeats) })}
              </span>
            ) : null}
          </div>
        ) : null}
        <AddonRows calc={calc} addons={sellable} vatPct={options.vat_pct ?? 0} />
        <VatSwitch calc={calc} vatPct={options.vat_pct ?? 0} testId="plan-checkout-vat" />
        {quote && plan ? (
          <div
            className="flex flex-col gap-1 rounded-[12px] bg-surface-3 p-3 text-[0.8125rem] text-fg-2"
            aria-live="polite"
            data-testid="plan-checkout-total"
          >
            {quote.fits ? (
              <>
                <span className="text-fg">
                  {t('plan.checkout.total', {
                    month: money(quote.month_total, plan.currency),
                    year: money(quote.year_total, plan.currency),
                  })}
                </span>
                {quote.yearly_saving > 0 ? (
                  <span className="text-ok-fg">
                    {t('pricing.save', { price: money(quote.yearly_saving, plan.currency) })}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-accent-fg">
                {t('pricing.noFit', { max: formatNumber(plan.limits.seats ?? 0), seats: formatNumber(seats) })}
              </span>
            )}
          </div>
        ) : null}
        <PurchaseConsentCheckbox docs={purchaseDocs} checked={agreed} onChange={setAgreed} />
        <p className="text-xs text-muted">{t('plan.checkout.secure')}</p>
        {go.isError ? (
          <Notice tone="error">
            <span data-testid="plan-checkout-error">{errorMessage(go.error)}</span>
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
};

/**
 * "ביטול המנוי": the admin sees what cancelling now would do — the case, the refund, the fee and the
 * end date, computed by the server from the owner's billing settings — and confirms; a cancel that refunded nothing
 * can be taken back until the period ends. When nothing is refunded, deleting the account is offered (General).
 */
const CancelPanel = ({ account, plan }: { account: MyAccount; plan: AccountPlan }) => {
  const qc = useQueryClient();
  const s = plan.subscription;
  const [open, setOpen] = useState(false);
  const undo = useMutation({
    mutationFn: () => api(account.id).post<AccountPlan>('/plan/cancel/undo'),
    onSuccess: (next) => qc.setQueryData(myPlanKey(account.id), next),
  });
  if (!s || s.ended_at) return null;
  const c = s.cancellation;
  return (
    <Panel title={t('plan.cancel.title')} testId="plan-cancel-panel">
      <div className="flex flex-col gap-3 p-3.5">
        {c ? (
          <Notice tone="info">
            <span data-testid="plan-cancel-state">
              {t(`plan.cancel.done.${c.case}`, {
                date: date(s.period_end),
                refund: formatCurrency(c.refund, c.currency),
              })}
            </span>
          </Notice>
        ) : (
          <p className="text-sm text-fg-2">{t('plan.cancel.hint')}</p>
        )}
        {undo.isError ? <Notice tone="error">{errorMessage(undo.error)}</Notice> : null}
        <span className="flex flex-wrap gap-2">
          {c?.resumable ? (
            <Button
              variant="secondary"
              busy={undo.isPending}
              onClick={() => undo.mutate()}
              data-testid="plan-cancel-undo"
            >
              {t('plan.cancel.undo')}
            </Button>
          ) : null}
          {!c && !s.cancel_at_period_end ? (
            <Button variant="danger-outline" onClick={() => setOpen(true)} data-testid="plan-cancel-open">
              {t('plan.cancel.button')}
            </Button>
          ) : null}
        </span>
      </div>
      {open ? <CancelDialog account={account} onClose={() => setOpen(false)} /> : null}
    </Panel>
  );
};

const CancelDialog = ({ account, onClose }: { account: MyAccount; onClose: () => void }) => {
  const qc = useQueryClient();
  const preview = useQuery({
    queryKey: [...myPlanKey(account.id), 'cancel'],
    queryFn: () => api(account.id).get<PlanCancelPreview>('/plan/cancel'),
    staleTime: 0,
  });
  const [reason, setReason] = useState('');
  const confirm = useMutation({
    mutationFn: () =>
      api(account.id).post<AccountPlan>('/plan/cancel', {
        expected_refund: preview.data?.refund ?? 0,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      }),
    onSuccess: async (next) => {
      qc.setQueryData(myPlanKey(account.id), next);
      await qc.invalidateQueries({ queryKey: myPlanKey(account.id) });
      onClose();
    },
    // The numbers moved (a month started meanwhile): show the new ones.
    onError: () => void preview.refetch(),
  });
  const p = preview.data;
  const cur = (v: number) => formatCurrency(v, p?.currency ?? 'ILS');
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('plan.cancel.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('plan.cancel.keep')}
          </Button>
          <Button
            variant="danger"
            busy={confirm.isPending}
            disabled={!p?.available}
            onClick={() => confirm.mutate()}
            data-testid="plan-cancel-confirm"
          >
            {t('plan.cancel.confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 whitespace-normal" data-testid="plan-cancel-dialog">
        {preview.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
        {preview.isError ? <Notice tone="error">{errorMessage(preview.error)}</Notice> : null}
        {p && !p.available ? <Notice>{t(`plan.cancel.unavailable.${p.reason ?? 'no_subscription'}`)}</Notice> : null}
        {p?.available && p.case ? (
          <>
            <p className="text-sm text-fg" data-testid="plan-cancel-case" data-case={p.case}>
              {t(`plan.cancel.case.${p.case}`, {
                ends: date(p.ends_at),
                refund: cur(p.refund),
                fee: cur(p.fee),
              })}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-[12px] bg-surface-3 p-3 text-[0.8125rem]">
              <dt className="text-muted">{t('plan.cancel.paid')}</dt>
              <dd className="tabular-nums">{cur(p.paid)}</dd>
              {p.months_used !== null ? (
                <>
                  <dt className="text-muted">{t('plan.cancel.used')}</dt>
                  <dd className="tabular-nums" data-testid="plan-cancel-used">
                    {p.monthly_price !== null
                      ? t('plan.cancel.usedAt', { n: p.months_used, price: cur(p.monthly_price) })
                      : t('plan.cancel.usedShare', { n: p.months_used })}
                  </dd>
                </>
              ) : null}
              {p.fee > 0 ? (
                <>
                  <dt className="text-muted">{t('plan.cancel.fee')}</dt>
                  <dd className="tabular-nums">{cur(p.fee)}</dd>
                </>
              ) : null}
              <dt className="font-semibold text-fg">{t('plan.cancel.refund')}</dt>
              <dd className="tabular-nums font-semibold text-fg" data-testid="plan-cancel-refund">
                {cur(p.refund)}
              </dd>
              <dt className="text-muted">{t('plan.cancel.ends')}</dt>
              <dd>{date(p.ends_at)}</dd>
            </dl>
            {p.refund > 0 && !p.automatic_refund ? (
              <p className="text-xs text-muted">{t('plan.cancel.manualRefund')}</p>
            ) : null}
            {p.case === 'yearly_no_refund' || p.case === 'period_end' ? (
              <p className="text-xs text-muted" data-testid="plan-cancel-delete-hint">
                {t('plan.cancel.deleteHint')}{' '}
                <a href={`/a/${account.slug}/admin/general`} className="text-primary underline underline-offset-2">
                  {t('plan.cancel.deleteLink')}
                </a>
              </p>
            ) : null}
            <Field label={t('plan.cancel.reason')}>
              <Input
                value={reason}
                maxLength={1000}
                onChange={(e) => setReason(e.target.value)}
                data-testid="plan-cancel-reason"
              />
            </Field>
            {p.terms ? (
              <a
                href={legalHref(p.terms.slug)}
                target="_blank"
                rel="noopener"
                className="text-xs text-primary underline underline-offset-2"
              >
                {p.terms.title[document.documentElement.lang === 'en' ? 'en' : 'he']}
              </a>
            ) : null}
          </>
        ) : null}
        {confirm.isError ? (
          <Notice tone="error">
            <span data-testid="plan-cancel-error">{errorMessage(confirm.error)}</span>
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
};
