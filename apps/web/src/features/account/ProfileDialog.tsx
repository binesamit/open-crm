// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { LANGUAGE_NAMES, t, type Profile } from '@bines/shared';
import { Button, Calendar, Field, Input, Notice, Picker, Segmented, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { applyLocale } from '../../lib/locale';
import { applyUserRegion } from '../../lib/region';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { Popover } from '../board/cells/Popover';
import { useAccountDetail } from '../admin/account-settings';
import { timeZones, zoneLabel } from '../../lib/timezones';
import { useMarketingOffered } from '../legal/legal-links';
import { ExtensionUserPages } from '../extensions/ExtensionSlots';

export const profileKey = (accountId: string) => ['account', accountId, 'profile'] as const;

/**
 * My profile (GET /users/me), read through the current account: my own fields (the same everywhere) and who I am
 * in this account (job title, department, phone — per account since Fix: ).
 */
export const useMyProfile = (accountId: string) =>
  useQuery({
    queryKey: profileKey(accountId),
    queryFn: () => api(accountId).get<Profile>('/users/me'),
    staleTime: 60_000,
  });

const LOCALES = [
  { value: 'he', label: LANGUAGE_NAMES.he },
  { value: 'en', label: LANGUAGE_NAMES.en },
] as const;

/** The Picker value of "לפי החשבון" (no zone of my own — `timezone: null`). */
const FOLLOW_ACCOUNT = '';

/** "1990-05-17" → "17/05/1990". */
const showDate = (iso: string | null) => (iso ? iso.split('-').reverse().join('/') : '');

/** "17/05/1990", "17.5.1990" or "1990-05-17" → "1990-05-17"; '' → null; anything else → undefined (invalid). */
const parseDate = (text: string): string | null | undefined => {
  const v = text.trim();
  if (!v) return null;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(v);
  const [y, m, d] = iso ? [iso[1], iso[2], iso[3]] : dmy ? [dmy[3], dmy[2], dmy[1]] : [];
  if (!y || !m || !d) return undefined;
  const out = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const check = new Date(`${out}T00:00:00Z`);
  return !Number.isNaN(check.getTime()) && check.getUTCDate() === Number(d) ? out : undefined;
};

/** Like `Field`, for controls made of several buttons (a `<label>` would click the first of them). */
const Group = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="space-y-1.5">
    <span className="block text-xs font-semibold text-fg-2">{label}</span>
    {children}
  </div>
);

/**
 * "הפרופיל שלי" → פרופיל (fix2, fix5): my details — name, birthday, language and time zone, the same in every
 * account — and "פרטים בחשבון זה" (Fix: ): job title, department and phone, which differ per account (a
 * manager in one, a consultant in another). Edited in place on the profile page; one "שמירה" saves both.
 */
export const ProfileForm = ({ accountId }: { accountId: string }) => {
  const profile = useMyProfile(accountId);
  if (profile.isError) return <Notice tone="error">{errorMessage(profile.error)}</Notice>;
  if (!profile.data) return <SkeletonRows rows={5} label={t('app.loading')} />;
  return (
    <>
      <ProfileFields accountId={accountId} profile={profile.data} />
      <ExtensionUserPages accountId={accountId} />
    </>
  );
};

const ProfileFields = ({ accountId, profile }: { accountId: string; profile: Profile }) => {
  const qc = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState(profile.name);
  const [title, setTitle] = useState(profile.title ?? '');
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [department, setDepartment] = useState(profile.department ?? '');
  const [birthday, setBirthday] = useState(showDate(profile.birthday));
  const [locale, setLocale] = useState(profile.locale);
  // '' = follow the account's timezone (null on the server, A3).
  const [timezone, setTimezone] = useState<string>(profile.timezone ?? FOLLOW_ACCOUNT);
  const accountZone = useAccountDetail({ id: accountId }).data?.settings.locale.timezone;
  const [calendar, setCalendar] = useState(false);
  // The platform's marketing email: shown when offered, or to withdraw an earlier yes.
  const [marketing, setMarketing] = useState(profile.marketing_opt_in);
  const marketingShown = useMarketingOffered() || profile.marketing_opt_in;
  const birthdayIso = parseDate(birthday);
  const save = useMutation({
    mutationFn: () =>
      api(accountId).patch<Profile>('/users/me', {
        // A user without a name yet (shown by e-mail) may save the other fields first.
        ...(name.trim() ? { name: name.trim() } : {}),
        title: title.trim() || null,
        phone: phone.trim() || null,
        department: department.trim() || null,
        birthday: birthdayIso ?? null,
        locale,
        timezone: timezone || null,
        ...(marketing !== profile.marketing_opt_in ? { marketing_opt_in: marketing } : {}),
      }),
    onSuccess: async (next) => {
      qc.setQueryData(profileKey(accountId), next);
      // The name shows in the shell (from `me`) and in people lists.
      await qc.refetchQueries({ queryKey: queryKeys.me, type: 'all' });
      await router.invalidate();
      await qc.invalidateQueries({ queryKey: queryKeys.members(accountId) });
      showToast({ message: t('profile.saved'), seconds: 3 });
      // The whole UI switches language now (fetchMe above already applied it; this covers a failed refetch).
      applyLocale(next.locale);
      applyUserRegion(next);
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (birthdayIso !== undefined && !save.isPending) save.mutate();
  };
  return (
    <form onSubmit={onSubmit} className="max-w-[640px] space-y-3" data-testid="profile-form">
      <h2 className="font-display text-base leading-snug font-bold text-heading">{t('profile.personal')}</h2>
      <p className="-mt-2 text-xs text-muted">{t('profile.personalHint')}</p>
      <Field label={t('profile.name')}>
        <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} data-testid="profile-name" />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label={t('profile.birthday')}
          hint={birthdayIso === undefined ? t('profile.birthdayInvalid') : undefined}
        >
          <span className="relative flex items-center gap-1.5">
            <Input
              value={birthday}
              placeholder="DD/MM/YYYY"
              dir="ltr"
              inputMode="numeric"
              onChange={(e) => setBirthday(e.target.value)}
              data-testid="profile-birthday"
              aria-invalid={birthdayIso === undefined || undefined}
              className="text-start"
            />
            <button
              type="button"
              aria-label={t('profile.birthdayPick')}
              title={t('profile.birthdayPick')}
              data-testid="profile-birthday-pick"
              onClick={() => setCalendar((v) => !v)}
              className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-line-strong text-fg-2 hover:bg-surface-2"
            >
              <Icon name="calendar" size={16} />
            </button>
            <Popover open={calendar} onClose={() => setCalendar(false)} align="end" className="p-2">
              <Calendar
                mode="single"
                value={birthdayIso ?? null}
                onChange={(v) => {
                  setBirthday(showDate(v));
                  setCalendar(false);
                }}
              />
            </Popover>
          </span>
        </Field>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Group label={t('profile.language')}>
          <Segmented
            label={t('profile.language')}
            value={locale}
            onChange={setLocale}
            className="flex w-full [&>button]:flex-1"
            options={LOCALES.map((l) => ({ value: l.value, label: l.label, testId: `profile-locale-${l.value}` }))}
          />
        </Group>
        <Group label={t('profile.timezone')}>
          <Picker<string>
            testId="profile-timezone"
            label={t('profile.timezone')}
            value={timezone}
            onChange={setTimezone}
            options={[
              {
                value: FOLLOW_ACCOUNT,
                label: t('profile.timezone.account', {
                  zone: accountZone ? zoneLabel(accountZone) : '…',
                }),
                keywords: accountZone,
                testId: 'profile-timezone-account',
              },
              ...timeZones(profile.timezone).map((z) => ({ value: z, label: zoneLabel(z) })),
            ]}
          />
        </Group>
      </div>
      {marketingShown ? (
        <div className="space-y-1">
          <Switch
            checked={marketing}
            onChange={setMarketing}
            label={t('profile.marketing')}
            testId="profile-marketing"
          />
          <p className="text-xs text-muted">{t('profile.marketingHint')}</p>
        </div>
      ) : null}
      <section
        role="group"
        aria-label={t('profile.inAccount')}
        data-testid="profile-account-section"
        data-account={profile.account?.id}
        className="space-y-3 border-t border-line pt-4"
      >
        <h2 className="font-display text-base leading-snug font-bold text-heading">
          {t('profile.inAccount')}
          {profile.account ? <span className="font-normal text-muted"> · {profile.account.name}</span> : null}
        </h2>
        <p className="-mt-2 text-xs text-muted">{t('profile.inAccountHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('profile.jobTitle')}>
            <Input
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="profile-title"
            />
          </Field>
          <Field label={t('profile.department')}>
            <Input
              value={department}
              maxLength={120}
              onChange={(e) => setDepartment(e.target.value)}
              data-testid="profile-department"
            />
          </Field>
          <Field label={t('profile.phone')}>
            <Input
              value={phone}
              maxLength={32}
              dir="ltr"
              inputMode="tel"
              autoComplete="tel"
              onChange={(e) => setPhone(e.target.value)}
              data-testid="profile-phone"
              className="text-start"
            />
          </Field>
        </div>
      </section>
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      <div className="flex justify-end pt-1">
        <Button type="submit" data-testid="profile-save" disabled={birthdayIso === undefined} busy={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
};
