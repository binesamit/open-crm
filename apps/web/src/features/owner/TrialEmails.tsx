// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { t, TRIAL_EMAIL_KINDS, type TrialEmailKind, type TrialEmails } from '@bines/shared';
import { Button, cn, Field, Input, Segmented, Switch } from '@bines/ui';

const textarea =
  'min-h-24 w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none focus:ring-3 focus:ring-[var(--accent-soft)]';

/** What PATCH /platform/signup-settings takes for `emails`: no `days` on the emails sent at the moment itself. */
export const trialEmailsPatch = (emails: TrialEmails) =>
  Object.fromEntries(
    TRIAL_EMAIL_KINDS.map((k) => {
      const { days, ...rest } = emails[k];
      return [k, days === null ? rest : { ...rest, days }];
    }),
  );

/** Days typed in a field: an integer 1–60, else NaN. */
const daysOf = (s: string) => {
  const n = Number(s.trim());
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : Number.NaN;
};

/**
 * Owner console → self sign-up → "מיילי ניסיון" (ה5): each of the five trial emails with its switch and days, and —
 * folded away — its own subject and text per language (empty = the built-in text).
 */
export const TrialEmailsSection = ({
  value,
  onChange,
  onValid,
}: {
  value: TrialEmails;
  onChange: (next: TrialEmails) => void;
  /** Whether every days field holds a valid number. */
  onValid: (ok: boolean) => void;
}) => {
  const [open, setOpen] = useState<TrialEmailKind | null>(null);
  const [lang, setLang] = useState<'he' | 'en'>('he');
  const [days, setDays] = useState<Record<TrialEmailKind, string>>(
    () =>
      Object.fromEntries(
        TRIAL_EMAIL_KINDS.map((k) => [k, value[k].days === null ? '' : String(value[k].days)]),
      ) as Record<TrialEmailKind, string>,
  );
  const patch = (k: TrialEmailKind, p: Partial<TrialEmails[TrialEmailKind]>) =>
    onChange({ ...value, [k]: { ...value[k], ...p } });
  const setText = (k: TrialEmailKind, field: 'subject' | 'body', text: string) =>
    patch(k, { [lang]: { ...value[k][lang], [field]: text.trim() ? text : null } });
  const typeDays = (k: TrialEmailKind, s: string) => {
    const next = { ...days, [k]: s };
    setDays(next);
    const n = daysOf(s);
    if (!Number.isNaN(n)) patch(k, { days: n });
    onValid(TRIAL_EMAIL_KINDS.every((x) => value[x].days === null || !Number.isNaN(daysOf(next[x]))));
  };

  return (
    <div className="flex flex-col gap-3 border-t border-line-soft pt-3.5" data-testid="signup-trial-emails">
      <h3 className="text-[0.8125rem] text-fg">{t('signup.emails.title')}</h3>
      <p className="max-w-[640px] text-xs leading-normal text-muted">{t('signup.emails.hint')}</p>
      <ul className="flex flex-col overflow-hidden rounded-[12px] border border-line">
        {TRIAL_EMAIL_KINDS.map((k) => {
          const e = value[k];
          const expanded = open === k;
          return (
            <li key={k} className="border-t border-line-soft first:border-t-0" data-testid={`signup-email-${k}`}>
              <div className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <label className="flex min-w-[14rem] flex-1 items-center gap-2 text-[0.78125rem] text-fg">
                  <Switch
                    checked={e.enabled}
                    onChange={(on) => patch(k, { enabled: on })}
                    testId={`signup-email-${k}-enabled`}
                  />
                  {t(`signup.emails.kind.${k}`)}
                </label>
                {e.days !== null ? (
                  <label className="flex items-center gap-2 text-xs text-fg-2">
                    <Input
                      inputMode="numeric"
                      dir="ltr"
                      aria-label={t(`signup.emails.days.${k}`)}
                      className={cn('h-8 w-16 text-end', Number.isNaN(daysOf(days[k])) && 'border-danger')}
                      value={days[k]}
                      onChange={(ev) => typeDays(k, ev.target.value)}
                      data-testid={`signup-email-${k}-days`}
                    />
                    {t(`signup.emails.days.${k}`)}
                  </label>
                ) : (
                  <span className="text-xs text-muted">{t(`signup.emails.when.${k}`)}</span>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : k)}
                  data-testid={`signup-email-${k}-text`}
                >
                  {t('signup.emails.ownText')}
                  {e.he.subject || e.he.body || e.en.subject || e.en.body ? ` · ${t('signup.emails.custom')}` : ''}
                </Button>
              </div>
              {expanded ? (
                <div className="flex flex-col gap-3 bg-surface-3 px-3 py-3">
                  <Segmented<'he' | 'en'>
                    label={t('signup.emails.language')}
                    value={lang}
                    onChange={setLang}
                    className="self-start"
                    options={[
                      { value: 'he', label: 'עברית', testId: `signup-email-${k}-he` },
                      { value: 'en', label: 'English', testId: `signup-email-${k}-en` },
                    ]}
                  />
                  <Field label={t('signup.emails.subject')}>
                    <Input
                      dir={lang === 'en' ? 'ltr' : 'rtl'}
                      placeholder={t(`signup.trial.${k}.subject`, undefined, lang)}
                      value={e[lang].subject ?? ''}
                      onChange={(ev) => setText(k, 'subject', ev.target.value)}
                      data-testid={`signup-email-${k}-subject`}
                    />
                  </Field>
                  <Field label={t('signup.emails.body')} hint={t('signup.emails.placeholders')}>
                    <textarea
                      dir={lang === 'en' ? 'ltr' : 'rtl'}
                      className={textarea}
                      placeholder={t(`signup.trial.${k}.body`, undefined, lang)}
                      value={e[lang].body ?? ''}
                      onChange={(ev) => setText(k, 'body', ev.target.value)}
                      data-testid={`signup-email-${k}-body`}
                    />
                  </Field>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
