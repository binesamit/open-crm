// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '@bines/sdk';
import {
  answered,
  applicableQuestions,
  dirOf,
  FORM_HONEYPOT,
  getLocale,
  MAX_FORM_PARAMS,
  type FormAnswer,
  type Locale,
  type PublicForm,
} from '@bines/shared';
import { Button, Notice, SkeletonRows } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { fetchPublicForm, fetchRelationOptions, formKeys, submitPublicForm, uploadFormFile } from './forms-api';
import { FormFieldInput, ft, type UploadedFormFile } from './FormFields';
import { useTurnstile } from './turnstile';
import { LegalLinks } from '../legal/legal-links';

type Errors = Record<string, string>;

/** The link's query parameters (hidden questions may take their value from one; the server picks what it uses). */
const linkParams = (): Record<string, string> | undefined => {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(window.location.search)) {
    if (Object.keys(out).length >= MAX_FORM_PARAMS) break;
    if (k.length <= 40 && !(k in out)) out[k] = v.slice(0, 2000);
  }
  return Object.keys(out).length ? out : undefined;
};

/** The F4 frame of the public page: the green shell around one floating white panel, mobile-first. */
const Frame = ({ lang, children }: { lang: Locale; children: React.ReactNode }) => (
  <div
    dir={dirOf(lang)}
    lang={lang}
    className="min-h-dvh bg-[var(--shell)] px-4 py-6 sm:py-12"
    data-testid="public-form-page"
  >
    <main className="mx-auto w-full max-w-[680px] overflow-hidden rounded-[var(--radius-panel)] bg-surface shadow-[var(--shadow-panel)]">
      {children}
    </main>
    {/*: the platform's terms / privacy under every public form, in the form's language. */}
    <footer className="mx-auto mt-4 flex max-w-[680px] justify-center text-xs text-shell-muted">
      <LegalLinks locale={lang === 'en' ? 'en' : 'he'} testId="public-form-legal" />
    </footer>
  </div>
);

/**
 * `/f/:token` — a public form (M11), outside the app shell. Shows only what the form exposes (its questions, the
 * account's name and logo when allowed), in the form's language and direction; anti-spam: a honeypot field and,
 * when configured, Turnstile. Submitting creates an item on the board.
 */
export const PublicFormPage = ({ token }: { token: string }) => {
  const query = useQuery({
    queryKey: formKeys.public(token),
    queryFn: () => fetchPublicForm(token),
    retry: false,
    staleTime: Infinity,
  });
  if (query.isPending)
    return (
      <Frame lang={getLocale()}>
        <div className="p-6">
          <SkeletonRows rows={6} label="…" />
        </div>
      </Frame>
    );
  if (query.isError) return <Unavailable token={token} error={query.error} />;
  return <FormBody token={token} form={query.data} />;
};

const Unavailable = ({ token, error }: { token: string; error: unknown }) => {
  const lang = getLocale();
  const status = error instanceof ApiError ? error.status : 0;
  const code = error instanceof ApiError ? error.body.code : '';
  const title = error instanceof ApiError ? (error.body.details?.title as string | undefined) : undefined;
  return (
    <Frame lang={lang}>
      <div className="space-y-4 p-6 sm:p-8" data-testid="public-form-unavailable" data-reason={code || 'error'}>
        {title ? (
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold text-heading">{title}</h1>
        ) : null}
        {code === 'form_closed' ? (
          <Notice>{ft(lang, 'closed')}</Notice>
        ) : status === 402 || code === 'plan_feature_unavailable' ? (
          // The account's plan has no public forms: a calm "not available", never an error.
          <Notice>{ft(lang, 'planUnavailable')}</Notice>
        ) : status === 401 ? (
          <>
            <Notice>{ft(lang, 'signInRequired')}</Notice>
            <a
              href={`/login?redirect=${encodeURIComponent(`/f/${token}`)}`}
              className="inline-flex h-10 items-center rounded-[12px] bg-primary px-4 text-sm font-semibold text-on-primary"
            >
              {ft(lang, 'signIn')}
            </a>
          </>
        ) : status === 404 ? (
          <Notice tone="warn">{ft(lang, 'notFound')}</Notice>
        ) : (
          <Notice tone="error">{ft(lang, 'loadError')}</Notice>
        )}
      </div>
    </Frame>
  );
};

const FormBody = ({ token, form }: { token: string; form: PublicForm }) => {
  const lang = form.language;
  const [answers, setAnswers] = useState<Record<string, FormAnswer>>({});
  const [files, setFiles] = useState<Record<string, UploadedFormFile[]>>({});
  const [errors, setErrors] = useState<Errors>({});
  const [honeypot, setHoneypot] = useState('');
  const [done, setDone] = useState<{ message: string } | null>(null);
  const {
    ref: captchaRef,
    token: captchaToken,
    failed: captchaFailed,
    reset: resetCaptcha,
  } = useTurnstile(form.turnstile_site_key, lang);

  useEffect(() => {
    const before = document.title;
    document.title = form.title;
    return () => {
      document.title = before;
    };
  }, [form.title]);

  const shown = useMemo(() => applicableQuestions(form.questions, answers), [form.questions, answers]);

  const submit = useMutation({
    mutationFn: () => {
      const visible = new Set(shown.map((q) => q.id));
      return submitPublicForm(token, {
        answers: Object.fromEntries(Object.entries(answers).filter(([id]) => visible.has(id))),
        [FORM_HONEYPOT]: honeypot || undefined,
        turnstile_token: captchaToken ?? undefined,
        params: linkParams(),
      });
    },
    onSuccess: (res) => {
      if (res.redirect_url) {
        window.location.assign(res.redirect_url);
        return;
      }
      setDone({ message: res.message });
    },
    onError: (err) => {
      resetCaptcha();
      if (err instanceof ApiError && err.body.code === 'validation_failed') {
        const q = err.body.details?.questions as Errors | undefined;
        if (q) setErrors(q);
      }
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const next: Errors = {};
    for (const q of shown) if (q.required && !answered(answers[q.id])) next[q.id] = 'required';
    setErrors(next);
    if (Object.keys(next).length) {
      document.getElementById(`q-${Object.keys(next)[0]}`)?.focus();
      return;
    }
    submit.mutate();
  };

  const header = (
    <>
      {form.cover_url ? (
        <img src={form.cover_url} alt="" className="aspect-[3/1] w-full object-cover" data-testid="public-form-cover" />
      ) : null}
      <div className="space-y-3 px-5 pt-6 sm:px-8 sm:pt-8">
        {form.account ? (
          <div className="flex items-center gap-2 text-xs font-semibold text-muted" data-testid="public-form-brand">
            {form.account.logo_url ? (
              <img src={form.account.logo_url} alt="" className="size-6 rounded-[6px] object-contain" />
            ) : null}
            <span>{form.account.name}</span>
          </div>
        ) : null}
        {form.logo_url ? <img src={form.logo_url} alt="" className="max-h-16 max-w-[200px] object-contain" /> : null}
        <h1 className="font-[family-name:var(--font-display)] text-2xl font-extrabold text-heading sm:text-[1.75rem]">
          {form.title}
        </h1>
        {form.description ? <p className="whitespace-pre-line text-[0.9375rem] text-fg-2">{form.description}</p> : null}
      </div>
    </>
  );

  if (done)
    return (
      <Frame lang={lang}>
        {header}
        <div className="flex flex-col items-center gap-3 px-5 py-10 text-center sm:px-8" data-testid="public-form-done">
          <span className="grid size-12 place-items-center rounded-full bg-ok-soft text-ok-fg">
            <Icon name="check" size={24} strokeWidth={2.5} />
          </span>
          <p className="whitespace-pre-line text-lg font-semibold text-heading">{done.message || ft(lang, 'thanks')}</p>
        </div>
      </Frame>
    );

  const serverError =
    submit.error instanceof ApiError
      ? submit.error.body.code === 'rate_limited'
        ? ft(lang, 'error.rateLimited')
        : submit.error.body.code === 'captcha_failed' || submit.error.body.code === 'captcha_required'
          ? ft(lang, 'error.captcha')
          : submit.error.body.code === 'form_closed'
            ? ft(lang, 'closed')
            : submit.error.status === 402 || submit.error.body.code === 'plan_feature_unavailable'
              ? ft(lang, 'planUnavailable')
              : submit.error.body.code === 'validation_failed'
                ? submit.error.body.details?.link
                  ? ft(lang, 'error.link')
                  : ft(lang, 'error.fix')
                : ft(lang, 'error.submit')
      : submit.error
        ? ft(lang, 'error.submit')
        : null;

  return (
    <Frame lang={lang}>
      {header}
      <form onSubmit={onSubmit} noValidate className="space-y-6 px-5 py-6 sm:px-8 sm:py-8" data-testid="public-form">
        {shown.map((q) => {
          const err = errors[q.id];
          return (
            <div key={q.id} className="space-y-2" data-testid={`form-question-${q.id}`}>
              <label
                id={`q-${q.id}-label`}
                htmlFor={`q-${q.id}`}
                className="block text-[0.9375rem] font-semibold text-fg"
              >
                {q.label}
                {q.required ? (
                  <span className="text-danger-fg" aria-hidden>
                    {' '}
                    *
                  </span>
                ) : null}
              </label>
              {q.help ? (
                <p id={`q-${q.id}-help`} className="whitespace-pre-line text-xs text-muted">
                  {q.help}
                </p>
              ) : null}
              <FormFieldInput
                question={q}
                value={answers[q.id]}
                onChange={(v) => {
                  setAnswers((a) => ({ ...a, [q.id]: v }));
                  if (errors[q.id]) setErrors(({ [q.id]: _, ...rest }) => rest);
                }}
                lang={lang}
                invalid={!!err}
                upload={(file) => uploadFormFile(token, q.id, file)}
                relationOptions={(query) => fetchRelationOptions(token, q.id, query)}
                files={files[q.id]}
                onFiles={(list) => setFiles((f) => ({ ...f, [q.id]: list }))}
              />
              {err ? (
                <p className="text-xs font-semibold text-danger-fg" role="alert" data-testid={`form-error-${q.id}`}>
                  {ft(lang, `error.${err}`)}
                </p>
              ) : null}
            </div>
          );
        })}
        {/* Honeypot: off-screen, skipped by keyboard and screen readers; a person never fills it. */}
        <div aria-hidden className="pointer-events-none absolute -start-[10000px] size-px overflow-hidden">
          <label>
            {FORM_HONEYPOT}
            <input
              tabIndex={-1}
              autoComplete="off"
              name={FORM_HONEYPOT}
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
            />
          </label>
        </div>
        {form.turnstile_site_key ? <div ref={captchaRef} data-testid="public-form-captcha" /> : null}
        {captchaFailed ? <Notice tone="warn">{ft(lang, 'error.captchaLoad')}</Notice> : null}
        {serverError ? (
          <div
            data-testid="public-form-error"
            data-reason={
              submit.error instanceof ApiError
                ? submit.error.body.details?.link
                  ? 'link'
                  : submit.error.body.code
                : 'error'
            }
          >
            <Notice tone="error">{serverError}</Notice>
          </div>
        ) : null}
        {form.privacy_notice ? (
          <p className="text-xs whitespace-pre-line text-muted" dir="auto" data-testid="public-form-privacy">
            {form.privacy_notice}
          </p>
        ) : null}
        <Button
          type="submit"
          variant="accent"
          size="lg"
          className="w-full"
          busy={submit.isPending}
          disabled={!!form.turnstile_site_key && !captchaToken && !captchaFailed}
          data-testid="public-form-submit"
        >
          {form.submit_label || ft(lang, 'submit')}
        </Button>
      </form>
    </Frame>
  );
};
