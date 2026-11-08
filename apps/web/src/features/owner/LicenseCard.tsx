// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getLocale, type InstallGuideSection, licenseBanner, type LicenseStatus, t } from '@bines/shared';
import { Badge, Button, Card, Dialog, Field, Notice, SkeletonRows } from '@bines/ui';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { licensingKeys, useLicenseStatus, useLicensingSettings } from '../licensing/licensing-api';
import { RegistrationForm } from '../licensing/RegistrationForm';

const TONE = {
  none: 'neutral',
  valid: 'ok',
  expiring: 'warn',
  grace: 'danger',
  expired: 'warn',
  revoked: 'danger',
  invalid: 'danger',
} as const;
const BANNER_TONE = { expiring: 'warn', grace: 'error', expired: 'warn', revoked: 'error', seats: 'warn' } as const;
const MAX_FILE_BYTES = 20_000;

/**
 * A link to a section of the installation guide: the owner console's Guides section — in place when
 * the console handles it (`onGuide`), else as an address.
 */
const GuideLink = ({
  section,
  onGuide,
  testId,
  children,
}: {
  section: InstallGuideSection;
  onGuide?: (section: InstallGuideSection) => void;
  testId: string;
  children: ReactNode;
}) => (
  <a
    href={`/owner?section=guides&guide=install&anchor=${section}`}
    data-testid={testId}
    className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
    onClick={(e) => {
      if (!onGuide || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      onGuide(section);
    }}
  >
    <Icon name="book" size={13} />
    {children}
  </a>
);

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(getLocale()) : null);
const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(getLocale()) : null);

/**
 * Owner console → the installation's license key (docs/LICENSING.md): the plan, seats (used / allowed — above it a
 * warning, never a block), expiry and grace, with a banner from 30 days before the end, through the grace period, and
 * after. Paste or upload a key, remove it, "Get a free key" (the registration questionnaire, or — offline — a link to
 * register from another browser and paste the key here), and the optional online check (revoked? renewed?).
 * After the grace period only the key's licensed features turn off; no data is touched.
 */
export const LicenseCard = ({ onGuide }: { onGuide?: (section: InstallGuideSection) => void } = {}) => {
  const qc = useQueryClient();
  const status = useLicenseStatus();
  const settings = useLicensingSettings();
  const [key, setKey] = useState('');
  const [registering, setRegistering] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const done = (res: LicenseStatus, message?: string) => {
    qc.setQueryData(licensingKeys.license, res);
    // Gates read `license_features` from /me/accounts.
    void qc.invalidateQueries({ queryKey: queryKeys.myAccounts });
    if (message) showToast({ message });
  };
  const install = useMutation({
    mutationFn: (value: string) => api().put<LicenseStatus>('/platform/license', { key: value }),
    onSuccess: (res) => {
      setKey('');
      done(res, t('owner.license.installed'));
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const remove = useMutation({
    mutationFn: () => api().delete<LicenseStatus>('/platform/license'),
    onSuccess: (res) => done(res, t('owner.license.removed')),
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const check = useMutation({
    mutationFn: () => api().post<LicenseStatus>('/platform/license/check'),
    onSuccess: (res) => done(res, t('owner.license.checked')),
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) {
      showToast({ message: t('owner.license.fileTooBig'), tone: 'error' });
      return;
    }
    setKey((await f.text()).trim());
  };
  const onRemove = async () => {
    const ok = await confirmDialog({
      title: t('owner.license.removeTitle'),
      message: t('owner.license.removeBody'),
      confirmLabel: t('owner.license.remove'),
      danger: true,
    });
    if (ok) remove.mutate();
  };
  const s = status.data;
  const banner = s ? licenseBanner(s) : null;
  const inForce = s?.state === 'valid' || s?.state === 'expiring' || s?.state === 'grace';
  const canCheck = !!settings.data?.server_url && !settings.data.update_check_forced_off && !!s && s.state !== 'none';
  return (
    <Card className="space-y-3" data-testid="owner-license">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-fg">{t('owner.license.title')}</h3>
          <p className="max-w-[640px] text-xs text-muted">{t('owner.license.hint')}</p>
          <GuideLink section="activate" onGuide={onGuide} testId="owner-license-guide">
            {t('guides.license.how')}
          </GuideLink>
        </div>
        {s ? (
          <span data-testid="owner-license-state" data-state={s.state}>
            <Badge tone={TONE[s.state]}>{t(`owner.license.state.${s.state}`)}</Badge>
          </span>
        ) : null}
      </div>
      {status.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {status.isError ? <Notice tone="error">{errorMessage(status.error)}</Notice> : null}
      {s && banner ? (
        <div data-testid="owner-license-banner" data-banner={banner}>
          <Notice tone={BANNER_TONE[banner]}>
            {t(`owner.license.banner.${banner}`, {
              date: day(banner === 'grace' ? s.grace_ends : s.expires) ?? '',
              days: s.days_left ?? 0,
              used: s.seats_used,
              seats: s.seats ?? 0,
            })}{' '}
            {banner === 'seats' ? null : (
              <GuideLink section="renewal" onGuide={onGuide} testId="owner-license-guide-renewal">
                {t('guides.license.renewal')}
              </GuideLink>
            )}
          </Notice>
        </div>
      ) : null}
      {s && s.state !== 'none' ? (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="owner-license-details">
          <dt className="text-muted">{t('owner.license.plan')}</dt>
          <dd data-testid="owner-license-plan">
            {s.plan ? t(`licensing.plan.${s.plan}`) : t('owner.license.planCustom')}
          </dd>
          <dt className="text-muted">{t('owner.license.licensee')}</dt>
          <dd>{s.licensee ?? '—'}</dd>
          <dt className="text-muted">{t('owner.license.seats')}</dt>
          <dd data-testid="owner-license-seats">
            {s.seats === null
              ? t('owner.license.seatsUnlimited', { used: s.seats_used })
              : t('owner.license.seatsOf', { used: s.seats_used, seats: s.seats })}
          </dd>
          <dt className="text-muted">{t('owner.license.features')}</dt>
          <dd dir="ltr" className="text-start">
            {s.features.length ? s.features.join(', ') : t('owner.license.noFeatures')}
          </dd>
          <dt className="text-muted">{t('owner.license.expires')}</dt>
          <dd data-testid="owner-license-expires">{when(s.expires) ?? t('owner.license.never')}</dd>
          {s.expires ? (
            <>
              <dt className="text-muted">{t('owner.license.grace')}</dt>
              <dd>{t('owner.license.graceUntil', { days: s.grace_days ?? 14, date: day(s.grace_ends) ?? '' })}</dd>
            </>
          ) : null}
          {s.support ? (
            <>
              <dt className="text-muted">{t('owner.license.support')}</dt>
              <dd>{t(`licensing.support.${s.support}`)}</dd>
            </>
          ) : null}
          {s.installed_at ? (
            <>
              <dt className="text-muted">{t('owner.license.installedAt')}</dt>
              <dd>{when(s.installed_at)}</dd>
            </>
          ) : null}
          <dt className="text-muted">{t('owner.license.checkedAt')}</dt>
          <dd>{when(s.checked_at) ?? t('owner.license.neverChecked')}</dd>
          {s.problem ? (
            <>
              <dt className="text-muted">{t('owner.license.problem')}</dt>
              <dd data-testid="owner-license-problem">{t(`owner.license.problem.${s.problem}`)}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
      {s ? (
        <p className="text-xs text-muted" data-testid="owner-license-instance">
          {t('owner.license.instance')}{' '}
          <span dir="ltr" className="font-mono">
            {s.instance_id}
          </span>
        </p>
      ) : null}
      {s && !inForce ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="accent" onClick={() => setRegistering(true)} data-testid="owner-license-free">
            {t('owner.license.getFree')}
          </Button>
          <span className="text-xs text-muted">{t('owner.license.getFreeHint')}</span>
        </div>
      ) : null}
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) install.mutate(key.trim());
        }}
      >
        <Field label={t('owner.license.key')}>
          <textarea
            rows={3}
            dir="ltr"
            spellCheck={false}
            value={key}
            maxLength={MAX_FILE_BYTES}
            placeholder="lic1.…"
            onChange={(e) => setKey(e.target.value)}
            data-testid="owner-license-key"
            className="w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 font-mono text-xs text-fg placeholder:text-muted focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={file}
            type="file"
            accept=".lic,.txt,.key,text/plain"
            className="hidden"
            onChange={(e) => void onFile(e)}
            data-testid="owner-license-file"
          />
          <Button
            type="submit"
            size="sm"
            busy={install.isPending}
            disabled={!key.trim()}
            data-testid="owner-license-save"
          >
            {t('owner.license.install')}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => file.current?.click()}
            data-testid="owner-license-upload"
          >
            {t('owner.license.upload')}
          </Button>
          {canCheck ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              busy={check.isPending}
              onClick={() => check.mutate()}
              data-testid="owner-license-check"
            >
              {t('owner.license.check')}
            </Button>
          ) : null}
          {s && s.state !== 'none' ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              busy={remove.isPending}
              onClick={() => void onRemove()}
              data-testid="owner-license-remove"
            >
              {t('owner.license.remove')}
            </Button>
          ) : null}
        </div>
      </form>
      <Dialog open={registering} onClose={() => setRegistering(false)} title={t('owner.license.getFree')}>
        <RegistrationForm testId="owner-license-register" onDone={() => setRegistering(false)} />
      </Dialog>
    </Card>
  );
};
