// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { t, type LegalAcceptance, type LegalDocSummary, type LegalList, type LegalLocale } from '@bines/shared';
import { api } from '../../lib/api';

/**
 * Legal documents in the web app: the published list (public), links to `/legal/<slug>`, and the sign-up
 * consent line. Everything comes from the API — which documents exist, their titles, which ones need consent.
 */

export const legalListKey = ['legal', 'list'] as const;

const legalListQuery = {
  queryKey: legalListKey,
  queryFn: () => api().get<LegalList>('/legal'),
  staleTime: 5 * 60_000,
  retry: false,
} as const;

/** The published documents (one request, shared by every link on the page). */
export const useLegalDocs = () => useQuery({ ...legalListQuery, select: (l: LegalList) => l.data });
/** The published documents and how joining asks for consent (a notice, or a checkbox — platform setting). */
export const useLegalList = () => useQuery(legalListQuery);

export const legalHref = (slug: string, locale?: LegalLocale) =>
  `/legal/${encodeURIComponent(slug)}${locale ? `?locale=${locale}` : ''}`;

/** The documents people must accept now (their current version) — what a sign-up screen sends with the join. */
export const requiredAcceptances = (docs: LegalDocSummary[] | undefined): LegalAcceptance[] =>
  (docs ?? []).filter((d) => d.requires_consent).map((d) => ({ slug: d.slug, version: d.version }));

/**
 * A row of links to the legal documents (sign-in screens, the public form footer). The documents that need consent
 * first (terms, privacy …), then "all documents". Renders nothing while loading or when there are none.
 */
export const LegalLinks = ({
  locale,
  className = '',
  testId = 'legal-links',
}: {
  locale?: LegalLocale;
  className?: string;
  testId?: string;
}) => {
  const docs = useLegalDocs().data;
  if (!docs?.length) return null;
  const lang: LegalLocale = locale ?? (document.documentElement.lang === 'en' ? 'en' : 'he');
  const main = docs.filter((d) => d.requires_consent);
  const shown = (main.length ? main : docs).slice(0, 3);
  // The accessibility statement is always one of them (the law asks for a conspicuous link).
  const statement = docs.find((d) => d.slug === 'accessibility');
  if (statement && !shown.includes(statement)) shown.push(statement);
  return (
    <span
      className={`inline-flex flex-wrap items-center justify-center gap-x-3 gap-y-1 ${className}`}
      data-testid={testId}
    >
      {shown.map((d) => (
        <a
          key={d.slug}
          href={legalHref(d.slug, locale)}
          target="_blank"
          rel="noopener"
          className="underline-offset-2 hover:underline"
          data-testid={`legal-link-${d.slug}`}
        >
          {d.title[lang]}
        </a>
      ))}
      {docs.length > shown.length ? (
        <a
          href={`/legal${locale ? `?locale=${locale}` : ''}`}
          target="_blank"
          rel="noopener"
          className="underline-offset-2 hover:underline"
        >
          {t('legal.all', undefined, lang)}
        </a>
      ) : null}
    </span>
  );
};

/**
 * The sign-up consent line for every document that requires consent: "by joining you agree to <terms>, <privacy>"
 * next to the button (default), or — when the owner asks for it — a checkbox that must be ticked first. Nothing to
 * accept = nothing shown.
 */
export const LegalConsentCheckbox = ({ checked, onChange }: { checked: boolean; onChange: (on: boolean) => void }) => {
  const list = useLegalList().data;
  const required = (list?.data ?? []).filter((d) => d.requires_consent);
  const lang: LegalLocale = document.documentElement.lang === 'en' ? 'en' : 'he';
  // The owner's privacy notice at sign-up (privacy), above the consent line.
  const text = list?.collection_notice?.[lang];
  const notice = text ? (
    <p className="text-xs whitespace-pre-line text-muted" data-testid="legal-collection-notice">
      {text}
    </p>
  ) : null;
  if (!required.length) return notice;
  const links = required.map((d, i) => (
    <span key={d.slug}>
      {i > 0 ? ', ' : null}
      <a href={legalHref(d.slug)} target="_blank" rel="noopener" className="text-primary underline underline-offset-2">
        {d.title[lang]}
      </a>
    </span>
  ));
  if (!list?.consent_checkbox)
    return (
      <>
        {notice}
        <p className="text-xs text-muted" data-testid="legal-consent">
          {t('legal.byJoining')} {links}
        </p>
      </>
    );
  return (
    <>
      {notice}
      <label className="flex items-start gap-2 text-sm text-fg-2" data-testid="legal-consent">
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          data-testid="legal-consent-checkbox"
        />
        <span>
          {t('legal.agreePrefix')} {links}
        </span>
      </label>
    </>
  );
};

/**
 * What joining sends and whether it may go ahead: with the notice, joining itself agrees (acceptances always sent);
 * with the checkbox, only once ticked. Nothing requiring consent = ok, nothing sent.
 */
export const useConsent = (checked: boolean): { ok: boolean; accepted: LegalAcceptance[] } => {
  const list = useLegalList();
  const required = requiredAcceptances(list.data?.data);
  if (list.isLoading) return { ok: false, accepted: [] };
  if (!required.length) return { ok: true, accepted: [] };
  if (!list.data?.consent_checkbox) return { ok: true, accepted: required };
  return { ok: checked, accepted: checked ? required : [] };
};

/**
 * The marketing box at sign-up (Israel Communications Law §30A): separate from the documents, never
 * ticked by default, shown only when the owner wrote its label.
 */
export const MarketingOptInCheckbox = ({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
}) => {
  const label = useLegalList().data?.marketing_opt_in;
  const lang: LegalLocale = document.documentElement.lang === 'en' ? 'en' : 'he';
  if (!label) return null;
  return (
    <label className="flex items-start gap-2 text-sm text-fg-2" data-testid="legal-marketing">
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="legal-marketing-checkbox"
      />
      <span>{label[lang]}</span>
    </label>
  );
};

/** Whether the marketing box is offered (what sign-up sends only then). */
export const useMarketingOffered = () => !!useLegalList().data?.marketing_opt_in;

/**
 * The purchase documents at checkout: always an explicit box — buying is a contract of its own (the
 * subscription terms: renewal, cancellation, refunds). Nothing to accept = nothing shown.
 */
export const PurchaseConsentCheckbox = ({
  docs,
  checked,
  onChange,
}: {
  docs: LegalDocSummary[];
  checked: boolean;
  onChange: (on: boolean) => void;
}) => {
  const lang: LegalLocale = document.documentElement.lang === 'en' ? 'en' : 'he';
  if (!docs.length) return null;
  return (
    <label className="flex items-start gap-2 text-sm text-fg-2" data-testid="plan-checkout-consent">
      <input
        type="checkbox"
        className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        data-testid="plan-checkout-consent-checkbox"
      />
      <span>
        {t('legal.agreePrefix')}{' '}
        {docs.map((d, i) => (
          <span key={d.slug}>
            {i > 0 ? ', ' : null}
            <a
              href={legalHref(d.slug)}
              target="_blank"
              rel="noopener"
              className="text-primary underline underline-offset-2"
            >
              {d.title[lang]}
            </a>
          </span>
        ))}
      </span>
    </label>
  );
};
