// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  computeIdocTotals,
  dirOf,
  effectiveSelection,
  formatIdocMoney,
  idocRowTotal,
  idocTotalLookup,
  isEmptyIdocSection,
  markdownToDocHtml,
  mergedIdocSummary,
  mergeIdocText,
  type IdocLinesSection,
  type IdocSectionOf,
  type IdocTotals,
  type Locale,
  type PublicIdoc,
  type PublicIdocInput,
  type PublicIdocQuestion,
  type PublicIdocRow,
  type PublicIdocSection,
} from '@bines/shared';
import { ApiError } from '@bines/sdk';
import { Button, cn, Input } from '@bines/ui';
import { Icon } from '../../../lib/icons';
import { it, type KeysUnder } from '../idocs-api';
import { SignaturePad } from './SignaturePad';
import { headerOf, themeVars } from './theme-vars';

/**
 * One interactive document, drawn from what the server resolved (`PublicIdoc`): every section kind, the live totals
 * (the same `computeIdocTotals` as the server), questions and signing. With `actions` it talks to the server (the
 * public page); without, every tick stays local (the builder's preview). Canvas part 1 is the spec.
 */

export type DocActions = {
  select: (sectionId: string, row: string, patch: { selected?: boolean; qty?: number }) => Promise<PublicIdocRow[]>;
  /** Select (true) / clear (false) every row of a free-choice section. */
  selectAll?: (sectionId: string, all: boolean) => Promise<PublicIdocRow[]>;
  inputs: (sectionId: string, values: Record<string, string | number | boolean | null>) => Promise<void>;
  ask: (sectionId: string | null, text: string, name?: string) => Promise<PublicIdoc>;
  sign: (
    sectionId: string,
    x: { name: string; role?: string; consents: string[]; drawing?: string; typed?: boolean },
  ) => Promise<{ name: string; role: string | null; at: string }>;
  /** Download the document as PDF (the public page). */
  pdf?: () => Promise<void>;
};

type Of<K extends PublicIdocSection['kind']> = IdocSectionOf<K> & { data: PublicIdocSection['data'] };

const money = (n: number, currency: string, lang: Locale) => formatIdocMoney(n, currency, lang);

const Html = ({
  md,
  totals,
  lang,
  className,
}: {
  md: string;
  totals: IdocTotals;
  lang: Locale;
  className?: string;
}) => {
  const html = useMemo(
    () => markdownToDocHtml(mergeIdocText(md, idocTotalLookup(totals, lang))).html,
    [md, totals, lang],
  );
  return md.trim() ? (
    <div
      className={cn('rich-content text-[0.9375rem] leading-7 text-fg-2', className)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  ) : null;
};

const SectionTitle = ({ title, askLabel, onAsk }: { title: string; askLabel?: string; onAsk?: () => void }) =>
  title || onAsk ? (
    <div className="flex items-center gap-3">
      {title ? (
        <h2
          className="font-[family-name:var(--font-display)] text-lg font-semibold text-heading"
          style={{ textWrap: 'balance' }}
        >
          {title}
        </h2>
      ) : null}
      {onAsk ? (
        <button
          type="button"
          onClick={onAsk}
          data-testid="idoc-ask-section"
          className="ms-auto shrink-0 rounded-full bg-info-soft px-2.5 py-0.5 text-xs text-info-fg hover:brightness-95"
        >
          {askLabel}
        </button>
      ) : null}
    </div>
  ) : null;

const FieldsGrid = ({ fields, dark }: { fields: { label: string; value: string }[]; dark?: boolean }) =>
  fields.length ? (
    <dl className="grid grid-cols-[repeat(auto-fit,minmax(130px,1fr))] gap-x-5 gap-y-2.5 text-sm">
      {fields.map((f, i) => (
        <div key={i} className="min-w-0">
          <dt className={cn('text-[0.72rem]', dark ? 'opacity-80' : 'text-muted')}>{f.label}</dt>
          <dd className={cn('break-words', dark ? '' : 'text-fg')}>{f.value || '—'}</dd>
        </div>
      ))}
    </dl>
  ) : null;

type DocCtx = {
  doc: PublicIdoc;
  lang: Locale;
  T: (key: KeysUnder<'idoc.'>, vars?: Record<string, string | number>) => string;
  M: (n: number) => string;
  totals: IdocTotals;
  rows: Record<string, PublicIdocRow[]>;
  locked: boolean;
  actions?: DocActions;
  choose: (s: Of<'lines'>, key: string, patch: { selected?: boolean; qty?: number }) => Promise<void>;
  chooseAll: (s: Of<'lines'>, all: boolean) => Promise<void>;
  busyRow: string | null;
  canAsk: (s: PublicIdocSection) => boolean;
  ask: (sectionId: string) => () => void;
  askFor: string | null;
  setAskFor: (id: string | null) => void;
  composer: React.RefObject<HTMLTextAreaElement>;
  questions: PublicIdocQuestion[];
  setQuestions: (q: PublicIdocQuestion[]) => void;
  signed: PublicIdoc['signed'];
  setSigned: (s: PublicIdoc['signed']) => void;
  setError: (e: string | null) => void;
  fileUrl: (url: string) => string;
  linesSections: Of<'lines'>[];
};
const Ctx = createContext<DocCtx | null>(null);

/** Dark ink on a light brand colour, white on a dark one (relative luminance, WCAG). Empty = the shell (dark). */
export const inkOn = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '#ffffff';
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const l = 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#13221f';
};

/** A section with nothing to show the client (no rows, no text, no files…) is left out of the page. */
/** The page hides empty sections (shared with the PDF). */
export const isEmptySection = isEmptyIdocSection;
const useDoc = () => useContext(Ctx)!;

export const DocView = ({
  doc,
  actions,
  fileUrl = (u) => u,
  testId = 'idoc-page',
  showEmpty = false,
  pick,
}: {
  doc: PublicIdoc;
  actions?: DocActions;
  fileUrl?: (url: string) => string;
  testId?: string;
  /** The builder's preview: empty sections stay, marked as hidden from the client. */
  showEmpty?: boolean;
  /** The builder's preview: a click on a section picks it for editing, as the section list does. */
  pick?: { selected: string | null; onSelect: (id: string) => void; label: (id: string) => string };
}) => {
  const lang = doc.language;
  const T = (key: KeysUnder<'idoc.'>, vars?: Record<string, string | number>) => it(lang, key, vars);
  const [rows, setRows] = useState<Record<string, PublicIdocRow[]>>(() =>
    Object.fromEntries(doc.sections.filter((s) => s.kind === 'lines').map((s) => [s.id, s.data.rows ?? []])),
  );
  const [questions, setQuestions] = useState<PublicIdocQuestion[]>(doc.questions);
  const [signed, setSigned] = useState(doc.signed);
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askFor, setAskFor] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const locked = doc.state !== 'open' || !!signed;
  const hasQuestions = doc.sections.some((s) => s.kind === 'questions');
  const signSection = doc.sections.find((s) => s.kind === 'signature');

  const linesSections = doc.sections.filter((s): s is Of<'lines'> => s.kind === 'lines');
  const totals = useMemo(
    () =>
      computeIdocTotals(
        linesSections.map((s) => ({ section: s as IdocLinesSection, rows: rows[s.id] ?? [] })),
        mergedIdocSummary(doc.sections),
        { vat_percent: doc.vat_percent, prices_include_vat: doc.prices_include_vat, currency: doc.currency },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, doc],
  );
  const M = (n: number) => money(n, doc.currency, lang);

  const ask = (sectionId: string) => () => {
    setAskFor(sectionId);
    composer.current?.focus();
    composer.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
  const canAsk = (s: PublicIdocSection) => hasQuestions && s.ask && doc.state !== 'expired' && doc.state !== 'revoked';

  /** Local choice rules for the preview (the server applies the same ones on the public page). */
  const localSelect = (s: Of<'lines'>, key: string, patch: { selected?: boolean; qty?: number }) => {
    const list = (rows[s.id] ?? []).map((r) => ({ ...r }));
    const row = list.find((r) => r.key === key)!;
    if (patch.selected !== undefined) {
      if (s.mode === 'single' && patch.selected) for (const r of list) r.selected = false;
      row.selected = patch.selected;
      if (patch.selected) for (const k of row.requires) list.find((r) => r.key === k)!.selected = true;
    }
    if (patch.qty !== undefined) row.qty = patch.qty;
    const eff = effectiveSelection(s.mode, list);
    return list.map((r) => ({ ...r, selected: s.mode === 'fixed' ? true : eff.has(r.key) }));
  };
  const choose = async (s: Of<'lines'>, key: string, patch: { selected?: boolean; qty?: number }) => {
    setError(null);
    const optimistic = localSelect(s, key, patch);
    setRows((p) => ({ ...p, [s.id]: optimistic }));
    if (!actions) return;
    setBusyRow(key);
    try {
      const fresh = await actions.select(s.id, key, patch);
      setRows((p) => ({ ...p, [s.id]: fresh }));
    } catch {
      setError(T('page.saveError'));
    } finally {
      setBusyRow(null);
    }
  };

  /** Select all / clear all: at once on the page, one call (one write, one log entry) on the server. */
  const chooseAll = async (s: Of<'lines'>, all: boolean) => {
    setError(null);
    const list = (rows[s.id] ?? []).map((r) => ({ ...r, selected: all }));
    const eff = effectiveSelection(s.mode, list);
    setRows((p) => ({ ...p, [s.id]: list.map((r) => ({ ...r, selected: eff.has(r.key) })) }));
    if (!actions?.selectAll) return;
    setBusyRow(ALL_ROWS);
    try {
      const fresh = await actions.selectAll(s.id, all);
      setRows((p) => ({ ...p, [s.id]: fresh }));
    } catch {
      setError(T('page.saveError'));
    } finally {
      setBusyRow(null);
    }
  };

  const renderSection = (s: PublicIdocSection): ReactNode => {
    switch (s.kind) {
      case 'header':
        return null; // drawn in the header band
      case 'text': {
        const x = s as Of<'text'>;
        const body = (
          <div className={cn('grid gap-5', x.body2 ? 'sm:grid-cols-2' : '')}>
            <Html md={x.body} totals={totals} lang={lang} />
            {x.body2 ? <Html md={x.body2} totals={totals} lang={lang} /> : null}
          </div>
        );
        const styled = (
          <div
            className={cn(
              x.style === 'callout' && 'rounded-[var(--radius)] bg-accent-soft p-4',
              x.style === 'quote' && 'border-s-2 border-line-strong ps-4 italic',
              x.style === 'muted' && 'text-sm text-muted',
              x.numbered &&
                '[&_.rich-content>p]:[counter-increment:clause] [&_.rich-content>p]:before:me-1.5 [&_.rich-content>p]:before:text-muted [&_.rich-content>p]:before:content-[counter(clause)"."]',
            )}
          >
            {body}
          </div>
        );
        return x.collapsible ? (
          <details open={!x.collapsed} className="group">
            <summary className="flex cursor-pointer list-none items-center gap-2 font-[family-name:var(--font-display)] text-lg font-semibold text-heading">
              <span
                aria-hidden
                className="text-muted transition-transform group-open:rotate-90 rtl:group-open:-rotate-90"
              >
                ›
              </span>
              {x.title}
            </summary>
            <div className="mt-3">{styled}</div>
          </details>
        ) : (
          <>
            <SectionTitle title={x.title} askLabel={T('page.askSection')} onAsk={canAsk(s) ? ask(s.id) : undefined} />
            {styled}
          </>
        );
      }
      case 'fields': {
        const x = s as Of<'fields'>;
        return (
          <>
            <SectionTitle title={x.title} askLabel={T('page.askSection')} onAsk={canAsk(s) ? ask(s.id) : undefined} />
            <FieldsGrid fields={x.data.fields ?? []} />
          </>
        );
      }
      case 'people': {
        const x = s as Of<'people'>;
        return (
          <>
            <SectionTitle title={x.title} />
            <div className="grid gap-3 sm:grid-cols-2">
              {(x.data.people ?? []).map((p, i) => (
                <div key={i} className="flex items-center gap-3 rounded-[var(--radius)] border border-line p-3">
                  {p.photo_url ? (
                    <img src={fileUrl(p.photo_url)} alt="" className="size-11 rounded-full object-cover" />
                  ) : (
                    <span className="grid size-11 place-items-center rounded-full bg-primary-soft text-heading">
                      {p.name.slice(0, 1)}
                    </span>
                  )}
                  <div className="min-w-0 text-sm">
                    <div className="text-heading">{p.name}</div>
                    {p.phone ? (
                      <div className="text-muted" dir="ltr">
                        {p.phone}
                      </div>
                    ) : null}
                    {p.email ? (
                      <div className="truncate text-muted" dir="ltr">
                        {p.email}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
            {x.note ? <p className="text-sm text-muted">{x.note}</p> : null}
          </>
        );
      }
      case 'lines':
        return <LinesSection s={s as Of<'lines'>} />;
      case 'table': {
        const x = s as Of<'table'>;
        return (
          <>
            <SectionTitle title={x.title} askLabel={T('page.askSection')} onAsk={canAsk(s) ? ask(s.id) : undefined} />
            <Html md={x.intro} totals={totals} lang={lang} />
            {/* Phones: each row is a card ("column: value"), so nothing scrolls sideways. */}
            <div className="grid gap-2 sm:hidden" data-testid="idoc-table-cards">
              {x.rows.map((r, i) => (
                <dl key={i} className="grid gap-1 rounded-[var(--radius-sm)] border border-line p-3 text-[0.875rem]">
                  {r.map((c, j) => (
                    <div key={j} className="grid min-w-0 grid-cols-[minmax(0,40%)_minmax(0,1fr)] gap-2">
                      <dt className="text-xs text-muted">{x.columns[j] || ''}</dt>
                      <dd className={cn('min-w-0', j === 0 && x.header_column && 'text-heading')}>{c}</dd>
                    </div>
                  ))}
                </dl>
              ))}
            </div>
            <div className="hidden sm:block">
              <table className="w-full table-fixed text-[0.875rem]">
                {x.columns.some(Boolean) ? (
                  <thead>
                    <tr>
                      {x.columns.map((c, i) => (
                        <th
                          key={i}
                          className="border-b border-line px-2 py-1.5 text-start text-xs font-normal text-muted"
                        >
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                ) : null}
                <tbody>
                  {x.rows.map((r, i) => (
                    <tr key={i}>
                      {r.map((c, j) => (
                        <td
                          key={j}
                          className={cn(
                            'border-b border-line px-2 py-2 align-top [overflow-wrap:anywhere]',
                            j === 0 && x.header_column && 'text-heading',
                          )}
                        >
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        );
      }
      case 'summary':
        return <SummarySection s={s as Of<'summary'>} />;
      case 'media':
        return <MediaSection s={s as Of<'media'>} />;
      case 'inputs':
        return <InputsSection s={s as Of<'inputs'>} />;
      case 'questions':
        return <QuestionsSection s={s as Of<'questions'>} />;
      case 'signature':
        return <SignatureSection s={s as Of<'signature'>} />;
      case 'cta': {
        const x = s as Of<'cta'>;
        const go = () => {
          if (x.action === 'url' && /^https?:\/\//.test(x.url)) window.open(x.url, '_blank', 'noopener,noreferrer');
          else
            document
              .getElementById(
                `sec-${x.action === 'sign' ? signSection?.id : doc.sections.find((q) => q.kind === 'questions')?.id}`,
              )
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
        return (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] bg-primary-soft px-4 py-3.5">
            <span className="text-[0.9375rem] text-heading">{x.text}</span>
            {x.button_label ? (
              <Button variant="primary" onClick={go} className="bg-accent text-on-accent">
                {x.button_label}
              </Button>
            ) : null}
          </div>
        );
      }
      case 'faq': {
        const x = s as Of<'faq'>;
        return (
          <>
            <SectionTitle title={x.title} />
            <div className="divide-y divide-line">
              {x.items.map((f, i) => (
                <details key={i} className="group py-2.5">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[0.9375rem] text-heading">
                    {f.q}
                    <span aria-hidden className="text-muted group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <p className="mt-2 text-sm leading-6 whitespace-pre-wrap text-fg-2">{f.a}</p>
                </details>
              ))}
            </div>
          </>
        );
      }
      case 'timeline': {
        const x = s as Of<'timeline'>;
        return (
          <>
            <SectionTitle title={x.title} askLabel={T('page.askSection')} onAsk={canAsk(s) ? ask(s.id) : undefined} />
            <ol className="relative space-y-3 border-s border-line-strong ps-5">
              {(x.data.dated ?? []).map((d, i) => (
                <li key={i} className="relative">
                  <span aria-hidden className="absolute -start-[1.6rem] top-1.5 size-2.5 rounded-full bg-primary" />
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-[0.9375rem] text-heading">{d.name}</span>
                    <span className="text-xs text-muted tabular-nums" dir="ltr">
                      {[d.start, d.end].filter(Boolean).join(' – ')}
                    </span>
                  </div>
                  {d.description ? <p className="text-sm text-muted">{d.description}</p> : null}
                </li>
              ))}
            </ol>
          </>
        );
      }
      case 'divider': {
        const x = s as Of<'divider'>;
        return x.style === 'space' ? <div className="h-4" /> : <hr className="border-line" />;
      }
      case 'toc': {
        const x = s as Of<'toc'>;
        const titled = doc.sections.filter(
          (q) => q.id !== s.id && 'title' in q && typeof q.title === 'string' && q.title,
        );
        return (
          <>
            <SectionTitle title={x.title} />
            <ol className="grid gap-1 text-sm sm:grid-cols-2">
              {titled.map((q) => (
                <li key={q.id}>
                  <a href={`#sec-${q.id}`} className="text-info-fg hover:underline">
                    {(q as { title: string }).title}
                  </a>
                </li>
              ))}
            </ol>
          </>
        );
      }
    }
  };

  const ctx: DocCtx = {
    doc,
    lang,
    T,
    M,
    totals,
    rows,
    locked,
    actions,
    choose,
    chooseAll,
    busyRow,
    canAsk,
    ask,
    askFor,
    setAskFor,
    composer,
    questions,
    setQuestions,
    signed,
    setSigned,
    setError,
    fileUrl,
    linesSections,
  };
  const header = doc.sections.find((s): s is Of<'header'> => s.kind === 'header');
  const summary = doc.sections.find((s): s is Of<'summary'> => s.kind === 'summary' && s.sticky);
  // In the builder each section is a click target; the picked one is outlined. The keyboard reaches the same pick
  // through a button that shows when focused (the section list stays the other way in).
  const pickable = (id: string, base: string) =>
    pick
      ? {
          'data-pick': id,
          'aria-current': pick.selected === id ? ('true' as const) : undefined,
          onClick: () => pick.onSelect(id),
          className: cn(
            base,
            'cursor-pointer outline-2 -outline-offset-2',
            pick.selected === id ? 'outline-primary' : 'outline-transparent hover:outline-line-strong',
          ),
        }
      : { className: base };
  const pickButton = (id: string) =>
    pick ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          pick.onSelect(id);
        }}
        className="sr-only rounded-[8px] bg-surface px-2 py-1 text-xs text-heading focus:not-sr-only focus:justify-self-start focus:outline-2 focus:outline-[var(--focus-ring)]"
        data-testid="idoc-pick-section"
      >
        {pick.label(id)}
      </button>
    ) : null;
  return (
    <Ctx.Provider value={ctx}>
      <div
        dir={dirOf(lang)}
        lang={lang}
        data-testid={testId}
        // the product owner: content wraps, never scrolls sideways — grid children may shrink, long words break.
        className="grid min-w-0 bg-surface text-fg [overflow-wrap:anywhere] [&>*]:min-w-0"
        // The document's look (account default for the audience, then its own): tokens redefined here only.
        style={doc.theme ? themeVars(doc.theme) : undefined}
      >
        <div
          {...(header
            ? pickable(header.id, 'grid gap-4 px-5 py-6 sm:px-7')
            : { className: 'grid gap-4 px-5 py-6 sm:px-7' })}
          // The brand colour is the account's choice: the text takes whichever ink stays readable on it (WCAG AA).
          style={{
            background: headerOf(doc.theme, doc.account.color) || 'var(--shell)',
            color: inkOn(headerOf(doc.theme, doc.account.color)),
          }}
        >
          {header ? pickButton(header.id) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5 font-[family-name:var(--font-display)] text-base">
              {doc.account.logo_url && header?.show_logo !== false ? (
                <img
                  src={fileUrl(doc.account.logo_url)}
                  alt=""
                  className="h-8 max-w-[120px] rounded-[8px] object-contain"
                />
              ) : null}
              {doc.account.name}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {doc.expires_at && doc.state === 'open' ? (
                <span className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs text-accent-fg">
                  {T('page.validUntil', {
                    date: new Date(doc.expires_at).toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-GB'),
                  })}
                </span>
              ) : null}
              {actions?.pdf ? <PdfLink lang={lang} download={actions.pdf} onError={setError} /> : null}
            </div>
          </div>
          {header?.data.cover_url ? (
            <img
              src={fileUrl(header.data.cover_url)}
              alt=""
              className="max-h-56 w-full rounded-[var(--radius)] object-cover"
            />
          ) : null}
          <div>
            <h1
              className="font-[family-name:var(--font-display)] text-[1.4rem] font-semibold"
              style={{ textWrap: 'balance', color: 'inherit' }}
            >
              {header?.title || doc.title}
            </h1>
            {header?.subtitle ? <p className="opacity-90">{header.subtitle}</p> : null}
          </div>
          {header ? <FieldsGrid fields={header.data.fields ?? []} dark /> : null}
        </div>
        {error ? <div className="bg-danger-soft px-5 py-2 text-sm text-danger-fg sm:px-7">{error}</div> : null}
        {doc.sections
          .filter((s) => s.kind !== 'header' && (showEmpty || !isEmptySection(s)))
          .map((s) => (
            <section
              key={s.id}
              id={`sec-${s.id}`}
              data-kind={s.kind}
              {...pickable(
                s.id,
                'grid min-w-0 scroll-mt-4 gap-3 border-b border-line px-5 py-5 last:border-b-0 sm:px-7 [&>*]:min-w-0',
              )}
            >
              {pickButton(s.id)}
              {renderSection(s)}
              {showEmpty && isEmptySection(s) ? <p className="text-xs text-muted">{T('page.emptyHidden')}</p> : null}
            </section>
          ))}
        {summary && signSection && !locked ? (
          <div
            className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-line-strong bg-surface px-5 py-2.5 sm:hidden"
            style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}
          >
            <div className="text-sm">
              <span className="block text-xs text-muted">
                {T('page.totalWithVat')}
                {totals.recurring ? ` · ${M(totals.recurring_total)} ${T('page.perMonth')}` : ''}
              </span>
              <span className="font-[family-name:var(--font-display)] text-base text-heading tabular-nums">
                {M(totals.grand_total)}
              </span>
            </div>
            <Button
              onClick={() => document.getElementById(`sec-${signSection.id}`)?.scrollIntoView({ behavior: 'smooth' })}
              className="bg-accent text-on-accent"
            >
              {T('page.toApprove')}
            </Button>
          </div>
        ) : null}
      </div>
    </Ctx.Provider>
  );
};

// ——— the PDF download (the public page) ———
const PdfLink = ({
  lang,
  download,
  onError,
}: {
  lang: Locale;
  download: () => Promise<void>;
  onError: (message: string | null) => void;
}) => {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    onError(null);
    try {
      await download();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      onError(it(lang, status === 413 ? 'pdf.tooLarge' : status === 429 ? 'pdf.busy' : 'pdf.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void go()}
      disabled={busy}
      aria-busy={busy}
      aria-label={it(lang, 'pdf.downloadLabel')}
      className="inline-flex items-center gap-1.5 rounded-full border border-current/40 px-2.5 py-0.5 text-xs hover:bg-white/10 disabled:opacity-60"
      data-testid="idoc-public-pdf"
    >
      <Icon name="download" size={13} />
      {it(lang, 'pdf.download')}
    </button>
  );
};

// ——— sections with their own state (module level: a re-render of the page never resets what the client typed) ———

// ——— lines ———
/** busyRow while a whole section is being selected / cleared. */
const ALL_ROWS = '*';

/** "Select all" over a free-choice section: ticked when every row is, mixed when some are (a native tri-state box). */
const SelectAll = ({ s, list, chosen }: { s: Of<'lines'>; list: PublicIdocRow[]; chosen: Set<string> }) => {
  const { T, chooseAll, busyRow } = useDoc();
  const n = list.filter((r) => chosen.has(r.key)).length;
  const all = n === list.length;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = n > 0 && !all;
  }, [n, all]);
  return (
    <label className="flex cursor-pointer items-center gap-3 border-b border-line pb-2 text-sm text-muted">
      <input
        ref={ref}
        type="checkbox"
        checked={all}
        aria-checked={n > 0 && !all ? 'mixed' : all}
        disabled={busyRow !== null}
        data-testid="idoc-select-all"
        onChange={() => void chooseAll(s, !all)}
        className="size-[18px] cursor-pointer accent-[var(--primary)] disabled:cursor-default"
      />
      <span>
        {T('page.selectAll')}
        <span className="ms-1.5 text-xs">{T('page.selectedOf', { n, total: list.length })}</span>
      </span>
    </label>
  );
};

const LinesSection = ({ s }: { s: Of<'lines'> }) => {
  const { lang, T, M, totals, rows, locked, choose, busyRow, canAsk, ask } = useDoc();
  const list = rows[s.id] ?? [];
  const chosen = effectiveSelection(s.mode, list);
  const canTick = !locked && s.client_can_select && s.mode !== 'fixed';
  const shown = locked && !s.show_unselected ? list.filter((r) => chosen.has(r.key)) : list;
  const per = s.recurring_period === 'year' ? T('page.perYear') : T('page.perMonth');
  return (
    <>
      <SectionTitle title={s.title} askLabel={T('page.askSection')} onAsk={canAsk(s) ? ask(s.id) : undefined} />
      <Html md={s.intro} totals={totals} lang={lang} className="text-sm" />
      {canTick && s.mode === 'multi' && s.select_all && list.length > 1 ? (
        <SelectAll s={s} list={list} chosen={chosen} />
      ) : null}
      <ul className="divide-y divide-line" data-testid="idoc-lines" data-section={s.id}>
        {shown.map((r) => {
          const on = chosen.has(r.key);
          const t = idocRowTotal(r);
          const blocked = !on && r.requires.some((k) => !chosen.has(k));
          return (
            <li
              key={r.key}
              data-testid="idoc-row"
              data-selected={on}
              className={cn(
                'grid grid-cols-[auto_1fr_auto] items-start gap-x-3 gap-y-1 py-3',
                !on && s.mode !== 'fixed' && 'text-muted',
              )}
            >
              <span className="pt-0.5">
                {s.mode === 'fixed' ? (
                  <span aria-hidden className="block size-[18px] text-center text-primary">
                    ✓
                  </span>
                ) : (
                  <input
                    type={s.mode === 'single' ? 'radio' : 'checkbox'}
                    name={`sec-${s.id}`}
                    checked={on}
                    disabled={!canTick || busyRow === r.key || busyRow === ALL_ROWS}
                    aria-label={r.name}
                    data-testid="idoc-row-check"
                    onChange={(e) => void choose(s, r.key, { selected: e.target.checked })}
                    className="size-[18px] cursor-pointer accent-[var(--primary)] disabled:cursor-default"
                  />
                )}
              </span>
              <div className="min-w-0">
                <div className={cn('text-[0.9375rem]', on || s.mode === 'fixed' ? 'text-fg' : '')}>{r.name}</div>
                {r.description ? (
                  <div className="text-[0.8125rem] whitespace-pre-wrap text-muted">{r.description}</div>
                ) : null}
                {r.requires_names.length ? (
                  <div className={cn('text-xs', blocked ? 'text-accent-fg' : 'text-muted')}>
                    {T('page.requires', { names: r.requires_names.join(', ') })}
                  </div>
                ) : null}
                {r.qty !== null && (s.client_can_change_qty || r.qty) ? (
                  <label className="mt-1 inline-flex items-center gap-2 text-xs text-muted">
                    {r.unit || T('page.qty')}
                    {s.client_can_change_qty && !locked ? (
                      <QtyInput
                        value={r.qty}
                        min={s.min_qty}
                        max={s.max_qty}
                        label={`${r.name} · ${r.unit || T('page.qty')}`}
                        onCommit={(q) => void choose(s, r.key, { qty: q })}
                      />
                    ) : (
                      <span className="text-fg tabular-nums">{r.qty}</span>
                    )}
                    {r.unit_price ? <span className="tabular-nums">× {M(r.unit_price)}</span> : null}
                    {r.recurring_unit_price ? (
                      <span className="tabular-nums">
                        × {M(r.recurring_unit_price)} {per}
                      </span>
                    ) : null}
                  </label>
                ) : null}
              </div>
              {s.show_prices ? (
                <div className="text-end text-[0.9375rem] whitespace-nowrap tabular-nums">
                  {t.one_time ? <div>{M(t.one_time)}</div> : null}
                  {t.recurring ? (
                    <div className={t.one_time ? 'text-xs text-muted' : ''}>
                      {M(t.recurring)} {per}
                    </div>
                  ) : null}
                  {!t.one_time && !t.recurring ? <div className="text-muted">—</div> : null}
                </div>
              ) : (
                <span />
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
};

// ——— summary ———
const SummarySection = ({ s }: { s: Of<'summary'> }) => {
  const { T, M, totals, canAsk, ask, linesSections } = useDoc();
  const t = totals;
  // Payment terms only (a second summary next to the main one): the schedule, no second total.
  if (!s.show_totals)
    return (
      <>
        <SectionTitle title={s.title} askLabel={T('page.askSection')} onAsk={canAsk(s) ? ask(s.id) : undefined} />
        <div className="grid gap-1.5 text-[0.9375rem]" data-testid="idoc-schedule">
          {t.schedule.map((p, i) => (
            <div key={i} className="flex justify-between gap-3 border-b border-line pb-1.5 last:border-b-0">
              <span>
                {p.label} · {p.percent}%
              </span>
              <span className="tabular-nums">{M(p.amount)}</span>
            </div>
          ))}
        </div>
      </>
    );
  return (
    <>
      <SectionTitle title={s.title} askLabel={T('page.askSection')} onAsk={canAsk(s) ? ask(s.id) : undefined} />
      <div
        className="grid gap-2 rounded-[var(--radius)] border border-line bg-surface-2 p-4 text-[0.9375rem]"
        data-testid="idoc-summary"
      >
        {t.sections
          .filter((x) => x.totals === 'main' && (x.one_time || x.recurring))
          .map((x) => {
            const sec = linesSections.find((l) => l.id === x.section_id)!;
            return x.one_time ? (
              <SummaryRow key={x.section_id} label={sec.title || T('page.items')} value={M(x.one_time)} />
            ) : null;
          })}
        {t.discount ? (
          <SummaryRow label={s.discount?.label || T('page.discount')} value={`− ${M(t.discount)}`} />
        ) : null}
        {s.show_vat ? (
          <>
            <SummaryRow label={T('page.beforeVat')} value={M(t.subtotal)} muted />
            <SummaryRow label={T('page.vat', { p: t.vat_percent })} value={M(t.vat)} muted />
          </>
        ) : null}
        <SummaryRow label={s.show_vat ? T('page.totalWithVat') : T('page.total')} value={M(t.grand_total)} strong />
        {s.show_recurring && t.recurring ? (
          <SummaryRow
            label={s.show_vat ? T('page.recurring') : T('page.recurringNet')}
            value={`${M(s.show_vat ? t.recurring_total : t.recurring)} ${T('page.perMonth')}`}
          />
        ) : null}
        {s.show_third_party && (t.third_party_one_time || t.third_party_recurring) ? (
          <SummaryRow
            label={T('page.thirdParty')}
            value={[
              t.third_party_one_time ? M(t.third_party_one_time) : '',
              t.third_party_recurring ? `${M(t.third_party_recurring)} ${T('page.perMonth')}` : '',
            ]
              .filter(Boolean)
              .join(' + ')}
            muted
          />
        ) : null}
        {t.schedule.length && s.schedule.length ? (
          <div className="mt-1 grid gap-1 border-t border-line pt-2 text-sm">
            {t.schedule.map((p, i) => (
              <div key={i} className="flex justify-between gap-3">
                <span>
                  {p.label} · {p.percent}%
                </span>
                <span className="tabular-nums">{M(p.amount)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
};

// ——— media ———
const MediaSection = ({ s }: { s: Of<'media'> }) => {
  const { T, fileUrl } = useDoc();
  const files = s.data.files ?? [];
  return (
    <>
      <SectionTitle title={s.title} />
      {s.mode === 'video' && /^https?:\/\//.test(s.url) ? (
        <a
          href={s.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-[var(--radius)] border border-line px-4 py-3 text-info-fg hover:bg-surface-2"
        >
          ▶ {T('page.watchVideo')}
        </a>
      ) : null}
      {s.mode === 'image' || s.mode === 'gallery' || s.mode === 'logos' ? (
        <div
          className={cn(
            'grid gap-3',
            s.mode === 'gallery' && 'grid-cols-2 sm:grid-cols-3',
            s.mode === 'logos' && 'grid-cols-3 items-center sm:grid-cols-5',
          )}
        >
          {files
            .filter((f) => f.mime.startsWith('image/'))
            .map((f) => (
              <img
                key={f.ref}
                src={fileUrl(f.url)}
                alt={f.name}
                loading="lazy"
                className={cn(
                  'w-full rounded-[var(--radius)] object-cover',
                  s.mode === 'logos' && 'max-h-12 object-contain opacity-80 grayscale',
                )}
              />
            ))}
        </div>
      ) : null}
      {s.mode === 'files' ? (
        <ul className="grid gap-1.5">
          {files.map((f) => (
            <li key={f.ref}>
              <a
                href={fileUrl(f.url)}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-sm text-info-fg hover:underline"
              >
                📎 {f.name}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {s.caption ? <p className="text-xs text-muted">{s.caption}</p> : null}
    </>
  );
};

// ——— inputs ———
const InputsSection = ({ s }: { s: Of<'inputs'> }) => {
  const { lang, T, totals, locked, actions, canAsk, ask } = useDoc();
  const [values, setValues] = useState<Record<string, PublicIdocInput['value']>>(() =>
    Object.fromEntries((s.data.inputs ?? []).map((i) => [i.id, i.value])),
  );
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const save = async () => {
    if (!actions) return setState('saved');
    setState('saving');
    try {
      await actions.inputs(s.id, values as Record<string, string | number | boolean | null>);
      setState('saved');
    } catch {
      setState('error');
    }
  };
  return (
    <>
      <SectionTitle title={s.title} askLabel={T('page.askSection')} onAsk={canAsk(s) ? ask(s.id) : undefined} />
      <Html md={s.intro} totals={totals} lang={lang} className="text-sm" />
      <div className="grid gap-3 sm:grid-cols-2">
        {(s.data.inputs ?? []).map((inp) => (
          <label
            key={inp.id}
            className={cn(
              'grid gap-1 text-sm',
              inp.kind === 'long_text' && 'sm:col-span-2',
              inp.kind === 'checkbox' && 'flex items-start gap-2 sm:col-span-2',
            )}
          >
            {inp.kind === 'checkbox' ? (
              <>
                <input
                  type="checkbox"
                  checked={values[inp.id] === true}
                  disabled={locked}
                  onChange={(e) => {
                    setValues((v) => ({ ...v, [inp.id]: e.target.checked }));
                    setState('idle');
                  }}
                  className="mt-0.5 size-4 accent-[var(--primary)]"
                />
                <span className="text-fg-2">
                  {inp.label}
                  {inp.required ? ' *' : ''}
                </span>
              </>
            ) : (
              <>
                <span className="text-xs text-muted">
                  {inp.label}
                  {inp.required ? ' *' : ''}
                </span>
                {inp.kind === 'long_text' ? (
                  <textarea
                    value={String(values[inp.id] ?? '')}
                    disabled={locked}
                    rows={3}
                    onChange={(e) => {
                      setValues((v) => ({ ...v, [inp.id]: e.target.value }));
                      setState('idle');
                    }}
                    className="w-full rounded-[10px] border border-[var(--control-line)] bg-surface px-2.5 py-2 text-sm text-fg focus:border-primary focus:outline-none"
                  />
                ) : (
                  <Input
                    value={String(values[inp.id] ?? '')}
                    disabled={locked}
                    type={
                      inp.kind === 'email'
                        ? 'email'
                        : inp.kind === 'phone'
                          ? 'tel'
                          : inp.kind === 'number'
                            ? 'text'
                            : inp.kind === 'link'
                              ? 'url'
                              : 'text'
                    }
                    inputMode={inp.kind === 'number' ? 'decimal' : undefined}
                    placeholder={inp.kind === 'date' ? 'YYYY-MM-DD' : undefined}
                    dir={
                      inp.kind === 'email' || inp.kind === 'phone' || inp.kind === 'link' || inp.kind === 'date'
                        ? 'ltr'
                        : undefined
                    }
                    onChange={(e) => {
                      setValues((v) => ({ ...v, [inp.id]: e.target.value }));
                      setState('idle');
                    }}
                  />
                )}
                {inp.help ? <span className="text-xs text-muted">{inp.help}</span> : null}
              </>
            )}
          </label>
        ))}
      </div>
      {!locked ? (
        <div className="flex items-center gap-3">
          <Button
            variant="secondary"
            size="sm"
            busy={state === 'saving'}
            onClick={() => void save()}
            data-testid="idoc-inputs-save"
          >
            {T('page.save')}
          </Button>
          {state === 'saved' ? <span className="text-xs text-ok-fg">{T('page.saved')}</span> : null}
          {state === 'error' ? <span className="text-xs text-danger-fg">{T('page.saveError')}</span> : null}
        </div>
      ) : null}
    </>
  );
};

// ——— questions ———
const QuestionsSection = ({ s }: { s: Of<'questions'> }) => {
  const { doc, lang, T, actions, askFor, setAskFor, composer, questions, setQuestions, setError } = useDoc();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const forTitle = askFor ? (doc.sections.find((x) => x.id === askFor) as { title?: string } | undefined)?.title : null;
  const send = async () => {
    if (!text.trim()) return;
    if (!actions) {
      setText('');
      return;
    }
    setBusy(true);
    try {
      const next = await actions.ask(askFor, text.trim());
      setQuestions(next.questions);
      setText('');
      setAskFor(null);
    } catch {
      setError(T('page.saveError'));
    } finally {
      setBusy(false);
    }
  };
  const closed = doc.state === 'expired' || doc.state === 'revoked';
  return (
    <>
      <SectionTitle title={s.title} />
      {s.intro ? <p className="text-sm text-muted">{s.intro}</p> : null}
      <div className="grid gap-2" data-testid="idoc-questions">
        {questions.map((q) => (
          <div key={q.id} className="grid gap-2">
            {q.section_title ? (
              <div className="text-[0.7rem] text-muted">{T('page.about', { title: q.section_title })}</div>
            ) : null}
            <Bubble from={q.from} name={q.name} text={q.text} at={q.at} lang={lang} />
            {q.replies.map((r, i) => (
              <Bubble key={i} {...r} lang={lang} />
            ))}
          </div>
        ))}
      </div>
      {!closed ? (
        <div className="grid gap-2">
          {forTitle ? (
            <div className="flex items-center gap-2 text-xs text-info-fg">
              {T('page.about', { title: forTitle })}
              <button
                type="button"
                aria-label={T('page.clear')}
                onClick={() => setAskFor(null)}
                className="text-muted hover:text-fg"
              >
                ✕
              </button>
            </div>
          ) : null}
          <div className="flex items-end gap-2">
            <textarea
              ref={composer}
              value={text}
              rows={2}
              placeholder={T('page.askPlaceholder')}
              aria-label={T('page.askPlaceholder')}
              onChange={(e) => setText(e.target.value)}
              data-testid="idoc-question-input"
              className="min-w-0 flex-1 resize-none rounded-[14px] border border-[var(--control-line)] bg-surface px-3 py-2 text-sm text-fg focus:border-primary focus:outline-none"
            />
            <Button
              variant="primary"
              busy={busy}
              onClick={() => void send()}
              disabled={!text.trim()}
              data-testid="idoc-question-send"
            >
              {T('page.send')}
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
};

// ——— signature ———
const SignatureSection = ({ s }: { s: Of<'signature'> }) => {
  const { lang, T, M, totals, locked, actions, signed, setSigned } = useDoc();
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [ticks, setTicks] = useState<Set<string>>(new Set());
  const [drawing, setDrawing] = useState('');
  // Typing the name instead of drawing (keyboard / screen reader / no pointer): accepted as the signature.
  const [typedSig, setTypedSig] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const approveMode = s.mode === 'approve';
  const missing =
    s.consents.some((c) => c.required && !ticks.has(c.key)) ||
    (!approveMode && name.trim().length < 2) ||
    (!approveMode && s.require_drawing && !drawing && !typedSig);
  const go = async () => {
    setProblem(null);
    if (missing) return setProblem(T('page.signMissing'));
    if (!actions) return setSigned({ name: name || '—', role: role || null, at: new Date().toISOString() });
    setBusy(true);
    try {
      setSigned(
        await actions.sign(s.id, {
          // Approve with no name typed: the server signs with the item's contact name.
          name: name.trim(),
          ...(role.trim() ? { role: role.trim() } : {}),
          consents: [...ticks],
          ...(drawing && !typedSig ? { drawing } : {}),
          ...(typedSig ? { typed: true } : {}),
        }),
      );
    } catch (e) {
      setProblem(
        (e as { body?: { message?: string } })?.body?.message === 'idoc_inputs_missing'
          ? T('page.inputsMissing')
          : T('page.signError'),
      );
    } finally {
      setBusy(false);
    }
  };
  if (signed)
    return (
      <>
        <SectionTitle title={s.title} />
        <div className="rounded-[var(--radius)] bg-ok-soft px-4 py-3 text-sm text-ok-fg" data-testid="idoc-signed">
          {T('page.signedBy', {
            name: signed.name,
            at: new Date(signed.at).toLocaleString(lang === 'he' ? 'he-IL' : 'en-GB', {
              dateStyle: 'short',
              timeStyle: 'short',
            }),
          })}
        </div>
        {s.data.sender_name ? (
          <p className="text-xs text-muted">{T('page.senderSigned', { name: s.data.sender_name })}</p>
        ) : null}
      </>
    );
  if (locked) return <SectionTitle title={s.title} />;
  const label = s.button_label || (approveMode ? T('page.approve') : T('page.approveSign'));
  return (
    <>
      <SectionTitle title={s.title} />
      <Html md={s.intro} totals={totals} lang={lang} className="text-sm" />
      <div className="grid gap-3 sm:grid-cols-2">
        {!approveMode || s.ask_role ? (
          <label className="grid gap-1 text-sm">
            <span className="text-xs text-muted">{T('page.fullName')}</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              data-testid="idoc-sign-name"
              autoComplete="name"
            />
          </label>
        ) : null}
        {s.ask_role ? (
          <label className="grid gap-1 text-sm">
            <span className="text-xs text-muted">{T('page.role')}</span>
            <Input value={role} onChange={(e) => setRole(e.target.value)} data-testid="idoc-sign-role" />
          </label>
        ) : null}
        {!approveMode ? (
          <div className="sm:col-span-2">
            {typedSig ? (
              <div
                className="grid h-28 place-items-center rounded-[var(--radius)] border border-dashed border-line-strong bg-surface-3 text-2xl text-heading italic"
                aria-live="polite"
                data-testid="idoc-typed-signature"
              >
                {name.trim() || T('page.typedEmpty')}
              </div>
            ) : (
              <SignaturePad
                value={drawing}
                onChange={setDrawing}
                label={T('page.padLabel')}
                clearLabel={T('page.clear')}
                hint={s.require_drawing ? T('page.padRequired') : T('page.padOptional')}
              />
            )}
            <button
              type="button"
              aria-pressed={typedSig}
              onClick={() => setTypedSig((v) => !v)}
              data-testid="idoc-typed-toggle"
              className="mt-1.5 text-xs text-info-fg underline-offset-2 hover:underline focus-visible:underline"
            >
              {typedSig ? T('page.drawInstead') : T('page.typeInstead')}
            </button>
          </div>
        ) : null}
        {s.consents.map((c) => (
          <label key={c.key} className="flex items-start gap-2.5 text-sm text-fg-2 sm:col-span-2">
            <input
              type="checkbox"
              checked={ticks.has(c.key)}
              onChange={(e) =>
                setTicks((p) => {
                  const n = new Set(p);
                  if (e.target.checked) n.add(c.key);
                  else n.delete(c.key);
                  return n;
                })
              }
              data-testid="idoc-consent"
              className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
            />
            <span>
              {c.text}
              {c.required ? ' *' : ''}
            </span>
          </label>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-[48ch] text-xs text-muted">{T('page.signNote')}</p>
        <Button
          size="lg"
          busy={busy}
          onClick={() => void go()}
          data-testid="idoc-sign"
          className="bg-accent text-on-accent hover:brightness-95"
        >
          {label}
          {totals.grand_total ? ` · ${M(totals.grand_total)}` : ''}
        </Button>
      </div>
      {problem ? <p className="text-sm text-danger-fg">{problem}</p> : null}
    </>
  );
};

const SummaryRow = ({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) => (
  <div
    className={cn(
      'flex items-baseline justify-between gap-3',
      strong && 'border-t border-line-strong pt-2.5 font-[family-name:var(--font-display)] text-lg text-heading',
      muted && 'text-muted',
    )}
  >
    <span>{label}</span>
    <span className="tabular-nums" data-testid={strong ? 'idoc-grand-total' : undefined}>
      {value}
    </span>
  </div>
);

const Bubble = ({
  from,
  name,
  text: body,
  at,
  lang,
}: {
  from: 'client' | 'team';
  name: string;
  text: string;
  at: string;
  lang: Locale;
}) => (
  <div
    className={cn(
      'max-w-[62ch] min-w-0 rounded-[14px] px-3.5 py-2.5 text-sm [overflow-wrap:anywhere]',
      from === 'client'
        ? 'justify-self-end rounded-ee-[4px] bg-info-soft text-info-fg'
        : 'rounded-es-[4px] bg-primary-soft text-fg',
    )}
  >
    <div className="whitespace-pre-wrap">{body}</div>
    <div className="mt-1 text-[0.7rem] text-muted">
      {name} ·{' '}
      {new Date(at).toLocaleString(lang === 'he' ? 'he-IL' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' })}
    </div>
  </div>
);

/** A quantity box that sends its value when the person stops typing or leaves it. */
const QtyInput = ({
  value,
  min,
  max,
  label,
  onCommit,
}: {
  value: number | null;
  min: number;
  max: number;
  label: string;
  onCommit: (q: number) => void;
}) => {
  const [text, setText] = useState(String(value ?? 0));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commit = (raw: string) => {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return;
    const q = Math.min(max, Math.max(min, n));
    if (q !== value) onCommit(q);
  };
  return (
    <input
      value={text}
      inputMode="numeric"
      aria-label={label}
      data-testid="idoc-row-qty"
      onChange={(e) => {
        const v = e.target.value.replace(/[^\d]/g, '').slice(0, 7);
        setText(v);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => commit(v), 500);
      }}
      onBlur={() => {
        if (timer.current) clearTimeout(timer.current);
        commit(text);
      }}
      className="h-7 w-16 rounded-[8px] border border-[var(--control-line)] bg-surface text-center text-sm text-fg tabular-nums focus:border-primary focus:outline-none"
    />
  );
};
