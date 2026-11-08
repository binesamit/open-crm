// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { t, tDynamic, type MyAccount, type PlanOffer, type PublicPlan } from '@bines/shared';
import { Button, Field, Input, Notice } from '@bines/ui';
import { api, errorMessage, type Me } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { TEXTAREA } from '../support/NewTicketDialog';
import { useTicketOptions } from '../support/support-api';
import { useProfile } from './use-profile';

/** While closed, the screen asks again now and then: when the owner reopens the account, the app comes back by itself. */
export const CLOSED_REFETCH_MS = 30_000;

export const offerKey = ['plans', 'public'] as const;

/** "₪49" in the reader's language; the plan's currency as the owner set it. */
export const priceText = (amount: number, currency: string) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
};

/** A feature's label: the owner's, else the app's own (`plan.feature.<key>`), else the key. */
const featureText = (f: PublicPlan['features'][number]) => {
  if (f.label) return f.label;
  const own = tDynamic(`plan.feature.${f.key}`);
  return own === `plan.feature.${f.key}` ? f.key : own;
};

/**
 * The keys of a screen that cannot be dismissed (the closed account, the account scheduled for deletion): Esc does
 * nothing, Tab cycles inside the panel.
 */
export const lockedPanelKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
  const panel = e.currentTarget;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusables = Array.from(
    panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select, [tabindex]:not([tabindex="-1"])',
    ),
  );
  if (!focusables.length) return;
  const first = focusables[0]!;
  const last = focusables.at(-1)!;
  if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
};

/** The way "contact us" goes: the owner's link, a support ticket from here, the upgrade link, or words only. */
export type ContactWay = { kind: 'url'; url: string } | { kind: 'ticket' } | { kind: 'none'; text: string | null };

export const contactWayOf = (offer: PlanOffer | undefined, ticketsOpen: boolean): ContactWay => {
  if (offer?.contact_url) return { kind: 'url', url: offer.contact_url };
  if (ticketsOpen) return { kind: 'ticket' };
  if (offer?.upgrade.url) return { kind: 'url', url: offer.upgrade.url };
  return { kind: 'none', text: offer?.upgrade.text ?? null };
};

/** A link to a web page opens in a new tab; `mailto:` opens the mail app. */
const linkProps = (url: string) =>
  /^mailto:/i.test(url) ? { href: url } : { href: url, target: '_blank', rel: 'noopener noreferrer' };

const PlanCard = ({ plan, onChoose }: { plan: PublicPlan; onChoose: () => void }) => (
  <li
    className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"
    data-testid={`closed-plan-${plan.id}`}
  >
    <div className="space-y-1">
      <h3 className="text-base font-bold text-fg">{plan.name}</h3>
      {plan.description ? <p className="text-sm text-fg-2">{plan.description}</p> : null}
    </div>
    <div className="space-y-0.5">
      <p className="text-lg font-bold text-fg">
        {t('closed.perMonth', { price: priceText(plan.price_monthly, plan.currency) })}
        {plan.pricing === 'per_seat' ? <span className="text-sm font-normal"> · {t('closed.perSeat')}</span> : null}
      </p>
      {plan.price_yearly > 0 ? (
        <p className="text-sm text-fg-2">
          {t('closed.perYear', { price: priceText(plan.price_yearly, plan.currency) })}
        </p>
      ) : null}
      <p className="text-xs text-muted">
        {t(plan.vat_included ? 'closed.vatIncluded' : 'closed.vatExcluded')}
        {plan.trial_days > 0 ? ` · ${t('closed.trialDays', { n: plan.trial_days })}` : ''}
      </p>
    </div>
    {plan.features.length ? (
      <ul className="space-y-1 text-sm text-fg-2" aria-label={t('closed.planFeatures')}>
        {plan.features.map((f) => (
          <li key={f.key} className="flex items-center gap-1.5">
            <Icon name="check" size={14} className="shrink-0 text-ok" />
            <span>{featureText(f)}</span>
          </li>
        ))}
      </ul>
    ) : null}
    <Button className="mt-auto" onClick={onChoose} data-testid={`closed-choose-${plan.id}`}>
      {t('closed.choose')}
    </Button>
  </li>
);

/** The "contact us" form: a support ticket to the platform from inside the closed account. */
const ContactForm = ({ account, initial, onBack }: { account: MyAccount; initial: string; onBack: () => void }) => {
  const [subject, setSubject] = useState(t('closed.defaultSubject', { name: account.name }));
  const [message, setMessage] = useState(initial);
  const send = useMutation({
    mutationFn: () =>
      api(account.id).post('/support/tickets', { subject: subject.trim(), description: message.trim() }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (subject.trim() && message.trim()) send.mutate();
  };
  if (send.isSuccess)
    return (
      <div className="space-y-3">
        <Notice tone="success">
          <span data-testid="closed-contact-sent">{t('closed.sent')}</span>
        </Notice>
        <Button variant="secondary" onClick={onBack}>
          {t('closed.cancel')}
        </Button>
      </div>
    );
  return (
    <form className="space-y-3" onSubmit={submit} data-testid="closed-contact-form">
      <h2 className="text-base font-bold text-fg">{t('closed.contactTitle')}</h2>
      <Field label={t('closed.subject')}>
        <Input value={subject} maxLength={200} onChange={(e) => setSubject(e.target.value)} />
      </Field>
      <Field label={t('closed.message')}>
        <textarea
          className={TEXTAREA}
          value={message}
          maxLength={10_000}
          onChange={(e) => setMessage(e.target.value)}
          data-testid="closed-contact-message"
        />
      </Field>
      {send.isError ? <Notice tone="error">{errorMessage(send.error)}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={send.isPending || !subject.trim() || !message.trim()}>
          {t('closed.send')}
        </Button>
        <Button type="button" variant="secondary" onClick={onBack}>
          {t('closed.cancel')}
        </Button>
      </div>
    </form>
  );
};

/**
 * The closed account (plan-lock): one full-screen panel instead of the whole app — no shell, no page
 * behind it, nothing of the account rendered or fetched. It cannot be dismissed (no close button, no Esc, no click
 * outside; focus stays inside it), and removing it from the page shows nothing either: every request of the account
 * is refused by the server (403 `account_closed`). It shows the account's name and why it is closed (the owner's
 * message, else the platform's text, else the app's own), the offered plans with "choose", "contact us", the person's
 * other accounts and sign-out. Every text and link comes from the owner (billing settings); the app has defaults.
 */
export const AccountClosedScreen = ({ me, account: initial }: { me: Me; account: MyAccount }) => {
  const { list, switchTo, signOut } = useProfile(me, initial);
  // The account as /me/accounts holds it now (the owner's message may change while the screen is open).
  const account = list.find((a) => a.id === initial.id) ?? initial;
  const offer = useQuery({
    queryKey: offerKey,
    queryFn: () => api().get<PlanOffer>('/plans/public'),
    staleTime: 60_000,
  });
  const tickets = useTicketOptions(account.id, account.role !== 'guest');
  const ticketsOpen = !!tickets.data?.enabled && !!tickets.data?.may_open;
  const way = contactWayOf(offer.data, ticketsOpen);
  const [contact, setContact] = useState<string | null>(null);
  const others = list.filter((a) => a.id !== account.id);
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);

  // Focus starts inside and never leaves (Tab cycles); Esc does nothing.
  useEffect(() => {
    panel.current?.focus();
  }, []);
  const reason = account.plan_status_message || offer.data?.closed_text || t('closed.defaultText');
  const plans = offer.data?.data ?? [];
  const choose = (plan: PublicPlan) => {
    if (way.kind === 'url') window.open(way.url, /^mailto:/i.test(way.url) ? '_self' : '_blank', 'noopener');
    else setContact(t('closed.choosePrefill', { plan: plan.name, name: account.name }));
  };

  return (
    <div
      ref={panel}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={lockedPanelKeys}
      data-testid="account-closed"
      className="fixed inset-0 z-system overflow-y-auto bg-shell outline-none"
    >
      <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col gap-6 px-4 py-10">
        <header className="space-y-3 text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-danger-soft text-danger">
            <Icon name="lock" size={22} />
          </span>
          <h1 id={titleId} className="text-2xl font-bold text-fg" data-testid="account-closed-title">
            {t('closed.title', { name: account.name })}
          </h1>
          <p className="mx-auto max-w-2xl text-base whitespace-pre-line text-fg-2" data-testid="account-closed-reason">
            {reason}
          </p>
        </header>

        {contact !== null && way.kind === 'ticket' ? (
          <section className="app-panel mx-auto w-full max-w-xl p-5">
            <ContactForm account={account} initial={contact} onBack={() => setContact(null)} />
          </section>
        ) : (
          <>
            <section aria-labelledby={`${titleId}-plans`} className="space-y-3">
              <h2 id={`${titleId}-plans`} className="text-lg font-bold text-fg">
                {t('closed.plans')}
              </h2>
              {plans.length ? (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="closed-plans">
                  {plans.map((p) => (
                    <PlanCard key={p.id} plan={p} onChoose={() => choose(p)} />
                  ))}
                </ul>
              ) : offer.isSuccess ? (
                <p className="text-sm text-fg-2">{t('closed.noPlans')}</p>
              ) : null}
            </section>
            {way.kind === 'none' ? (
              <Notice tone="info">
                <span data-testid="closed-no-contact">{way.text || t('closed.noContact')}</span>
              </Notice>
            ) : null}
          </>
        )}

        <footer className="flex flex-wrap items-center justify-center gap-2 border-t border-line pt-5">
          {way.kind === 'url' ? (
            <a
              {...linkProps(way.url)}
              data-testid="closed-contact"
              className="inline-flex h-9 items-center gap-2 rounded-[10px] bg-primary px-4 text-sm font-semibold text-on-primary hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
            >
              <Icon name="mail" size={15} />
              {t('closed.contact')}
            </a>
          ) : way.kind === 'ticket' && contact === null ? (
            <Button onClick={() => setContact('')} data-testid="closed-contact">
              <Icon name="mail" size={15} />
              {t('closed.contact')}
            </Button>
          ) : null}
          {others.length ? (
            <details className="relative" data-testid="closed-switch">
              <summary className="inline-flex h-9 cursor-pointer list-none items-center gap-2 rounded-[10px] border border-line-strong px-4 text-sm font-semibold text-fg hover:bg-hover">
                <Icon name="building" size={15} />
                {t('closed.switch')}
              </summary>
              <ul className="absolute inset-x-0 bottom-full z-10 mb-1 min-w-56 rounded-xl border border-line bg-surface p-1 shadow-lg">
                {others.map((a) => (
                  <li key={a.id}>
                    <button
                      type="button"
                      onClick={() => void switchTo(a)}
                      data-testid={`closed-switch-${a.slug}`}
                      className="w-full rounded-lg px-3 py-2 text-start text-sm text-fg hover:bg-hover"
                    >
                      {a.name}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <Button variant="secondary" onClick={() => void signOut()} data-testid="closed-sign-out">
            <Icon name="logout" size={15} />
            {t('closed.signOut')}
          </Button>
        </footer>
      </div>
    </div>
  );
};
