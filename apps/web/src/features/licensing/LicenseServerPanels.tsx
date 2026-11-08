// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EDITION_FEATURES,
  EDITION_SUPPORT,
  formatDate,
  getLocale,
  type Installation,
  type IsoDate,
  type IssuedLicense,
  type IssueLicense,
  LICENSE_PLANS,
  LICENSE_TERM_DAYS,
  LICENSED_FEATURE_KEYS,
  type LicensePlan,
  type LicenseServerStatus,
  REGISTRATION_SIZES,
  REGISTRATION_USE_CASES,
  t,
} from '@bines/shared';
import {
  Badge,
  Button,
  Calendar,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  Segmented,
  SkeletonRows,
} from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog, promptDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { Popover } from '../board/cells/Popover';
import { TD, TH, TR } from '../trash/TrashPage';
import { downloadPlatformFile, licensingKeys, useLicenseServer } from './licensing-api';

/**
 * The license server's owner screens (docs/LICENSING.md, part B): the signing key (any installation becomes a
 * license server by creating one here; or the env `LICENSE_SIGNING_KEY`), "Installations" (who registered — filter,
 * CSV) and "Licenses" (issue, renew +1 year, change plan, revoke, copy, email). Without a signing key the lists say
 * "not a license server yet".
 */
const NotAServer = ({ testId }: { testId: string }) => (
  <div data-testid={`${testId}-off`}>
    <Notice tone="info">{t('licensing.server.off')}</Notice>
  </div>
);

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(getLocale()) : '—');
const STATE_TONE = { valid: 'ok', expiring: 'warn', grace: 'danger', expired: 'neutral', revoked: 'danger' } as const;

// ---------------------------------------------------------------- the signing key

const copyText = async (text: string, done: string) => {
  try {
    await navigator.clipboard.writeText(text);
    showToast({ message: done });
  } catch {
    showToast({ message: t('licensing.licenses.copyFailed'), tone: 'error' });
  }
};

/**
 * "License server": off — an explanation and "Create a signing key" (an Ed25519 key made and kept here); on — the
 * key's fingerprint, its public half (PEM, to copy), where it comes from, and — for a key made here — "Remove the
 * signing key" behind a confirmation (keys it signed stop verifying on the installations that trust it).
 */
export const LicenseServerCard = () => {
  const qc = useQueryClient();
  const server = useLicenseServer();
  const settle = (res: LicenseServerStatus, message: string) => {
    qc.setQueryData(licensingKeys.server, res);
    // The lists and the operations cards follow the key.
    void qc.invalidateQueries({ queryKey: ['platform', 'installations'] });
    void qc.invalidateQueries({ queryKey: licensingKeys.licenses });
    void qc.invalidateQueries({ queryKey: licensingKeys.ops });
    showToast({ message });
  };
  const create = useMutation({
    mutationFn: () => api().post<LicenseServerStatus>('/platform/license-server/key'),
    onSuccess: (res) => settle(res, t('licensing.server.created')),
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const remove = useMutation({
    mutationFn: () => api().delete<LicenseServerStatus>('/platform/license-server/key'),
    onSuccess: (res) => settle(res, t('licensing.server.removed')),
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const askRemove = async () => {
    const ok = await confirmDialog({
      title: t('licensing.server.removeTitle'),
      message: t('licensing.server.removeBody'),
      confirmLabel: t('licensing.server.remove'),
      danger: true,
    });
    if (ok) remove.mutate();
  };
  const s = server.data;
  return (
    <Card className="space-y-3" data-testid="license-server" data-enabled={s ? String(s.enabled) : undefined}>
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-fg">{t('licensing.server.title')}</h3>
        <p className="max-w-[640px] text-xs text-muted">
          {s?.enabled ? t('licensing.server.hint') : t('licensing.server.becomeHint')}
        </p>
      </div>
      {server.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {server.isError ? <Notice tone="error">{errorMessage(server.error)}</Notice> : null}
      {s && !s.enabled ? (
        <div>
          <Button size="sm" busy={create.isPending} onClick={() => create.mutate()} data-testid="license-server-create">
            <Icon name="key" size={14} />
            {t('licensing.server.create')}
          </Button>
        </div>
      ) : null}
      {s?.enabled ? (
        <div className="space-y-3">
          <div className="text-sm" data-testid="license-server-source" data-source={s.source}>
            <span className="text-muted">{t('licensing.server.source')}</span>{' '}
            <Badge tone="info">
              {t(s.source === 'env' ? 'licensing.server.source.env' : 'licensing.server.source.setting')}
            </Badge>
          </div>
          {s.source === 'env' ? <Notice tone="info">{t('licensing.server.envHint')}</Notice> : null}
          <div className="text-sm">
            <span className="text-muted">{t('licensing.server.fingerprint')}</span>{' '}
            <code dir="ltr" className="font-mono text-xs text-fg" data-testid="license-server-fingerprint">
              {s.fingerprint ?? '—'}
            </code>
          </div>
          <Field label={t('licensing.server.publicKey')} hint={t('licensing.server.publicKeyHint')}>
            <textarea
              readOnly
              dir="ltr"
              rows={5}
              value={s.public_key ?? ''}
              className="w-full rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-start font-mono text-xs text-fg-2"
              data-testid="license-server-public-key"
            />
          </Field>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={!s.public_key}
              onClick={() => void copyText(s.public_key ?? '', t('licensing.server.copied'))}
              data-testid="license-server-copy"
            >
              <Icon name="copy" size={14} />
              {t('licensing.server.copy')}
            </Button>
            {s.source === 'setting' ? (
              <Button
                size="sm"
                variant="danger-outline"
                busy={remove.isPending}
                onClick={() => void askRemove()}
                data-testid="license-server-remove"
              >
                {t('licensing.server.remove')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
};

// ---------------------------------------------------------------- installations

type Filters = { q: string; size: string; use_case: string; verified: string; marketing: string };
const EMPTY: Filters = { q: '', size: '', use_case: '', verified: '', marketing: '' };
const queryOf = (f: Filters) =>
  new URLSearchParams(Object.entries(f).filter(([, v]) => v.trim()) as [string, string][]).toString();

export const InstallationsPanel = () => {
  const server = useLicenseServer();
  const [f, setF] = useState<Filters>(EMPTY);
  const qs = queryOf(f);
  const list = useQuery({
    queryKey: licensingKeys.installations(qs),
    queryFn: () => api().get<{ data: Installation[] }>(`/platform/installations${qs ? `?${qs}` : ''}`),
    enabled: !!server.data?.enabled,
  });
  const set = (k: keyof Filters) => (v: string) => setF((cur) => ({ ...cur, [k]: v }));
  const rows = list.data?.data ?? [];
  const qc = useQueryClient();
  // An installation that lost its registration secret (older code did not keep it) registers again only once released.
  const release = useMutation({
    mutationFn: (id: string) => api().post<Installation>(`/platform/installations/${id}/release`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['platform', 'installations'] });
      showToast({ message: t('licensing.installations.released') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const askRelease = async (r: Installation) => {
    const ok = await confirmDialog({
      title: t('licensing.installations.releaseTitle'),
      message: t('licensing.installations.releaseBody', { company: r.company || r.email }),
      confirmLabel: t('licensing.installations.release'),
    });
    if (ok) release.mutate(r.id);
  };
  return (
    <Card className="space-y-3" data-testid="installations">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-fg">{t('licensing.installations.title')}</h3>
          <p className="max-w-[640px] text-xs text-muted">{t('licensing.installations.hint')}</p>
        </div>
        {server.data?.enabled ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void downloadPlatformFile(`/platform/installations.csv${qs ? `?${qs}` : ''}`, 'installations.csv').catch(
                (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' }),
              )
            }
            data-testid="installations-csv"
          >
            {t('licensing.installations.csv')}
          </Button>
        ) : null}
      </div>
      {server.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {server.data && !server.data.enabled ? <NotAServer testId="installations" /> : null}
      {server.data?.enabled ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={t('licensing.installations.search')}>
              <Input value={f.q} onChange={(e) => set('q')(e.target.value)} data-testid="installations-search" />
            </Field>
            <FilterSeg
              label={t('licensing.register.size')}
              value={f.size}
              onChange={set('size')}
              options={REGISTRATION_SIZES.map((v) => ({ value: v, label: v }))}
              testId="installations-size"
            />
            <FilterSeg
              label={t('licensing.register.useCase')}
              value={f.use_case}
              onChange={set('use_case')}
              options={REGISTRATION_USE_CASES.map((v) => ({ value: v, label: t(`licensing.useCase.${v}`) }))}
              testId="installations-use"
            />
            <FilterSeg
              label={t('licensing.installations.verified')}
              value={f.verified}
              onChange={set('verified')}
              options={[
                { value: 'yes', label: t('licensing.yes') },
                { value: 'no', label: t('licensing.no') },
              ]}
              testId="installations-verified"
            />
            <FilterSeg
              label={t('licensing.installations.marketing')}
              value={f.marketing}
              onChange={set('marketing')}
              options={[
                { value: 'yes', label: t('licensing.yes') },
                { value: 'no', label: t('licensing.no') },
              ]}
              testId="installations-marketing"
            />
          </div>
          {list.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
          {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
          {list.data && !rows.length ? (
            <EmptyState icon={<Icon name="building" size={28} />} title={t('licensing.installations.empty')} />
          ) : null}
          {rows.length ? (
            <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
              <table className="w-full min-w-[820px] border-collapse text-sm" data-testid="installations-table">
                <thead>
                  <tr>
                    <th className={TH}>{t('licensing.register.company')}</th>
                    <th className={TH}>{t('licensing.register.email')}</th>
                    <th className={TH}>{t('licensing.register.size')}</th>
                    <th className={TH}>{t('licensing.register.role')}</th>
                    <th className={TH}>{t('licensing.register.useCase')}</th>
                    <th className={TH}>{t('licensing.installations.version')}</th>
                    <th className={TH}>{t('licensing.installations.registered')}</th>
                    <th className={TH}>{t('licensing.installations.lastSeen')}</th>
                    <th className={TH}>
                      <span className="sr-only">{t('licensing.installations.release')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} className={TR} data-testid="installation-row" data-instance={r.instance_id}>
                      <td className={TD}>{r.company || '—'}</td>
                      <td className={TD} dir="ltr">
                        {r.email}{' '}
                        {r.email_verified ? null : <Badge tone="warn">{t('licensing.installations.unverified')}</Badge>}
                        {r.marketing_opt_in ? <Badge tone="info">{t('licensing.installations.optIn')}</Badge> : null}
                      </td>
                      <td className={TD} dir="ltr">
                        {r.size ?? '—'}
                      </td>
                      <td className={TD}>{r.role || '—'}</td>
                      <td className={TD}>{r.use_case ? t(`licensing.useCase.${r.use_case as 'crm'}`) : '—'}</td>
                      <td className={TD} dir="ltr">
                        {r.version ?? '—'}
                      </td>
                      <td className={TD}>{day(r.registered_at)}</td>
                      <td className={TD}>
                        {r.last_seen_at
                          ? t('licensing.installations.seen', {
                              date: day(r.last_seen_at),
                              users: r.active_users ?? 0,
                              boards: r.boards ?? 0,
                            })
                          : '—'}
                      </td>
                      <td className={TD}>
                        {r.secret_set ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={release.isPending}
                            onClick={() => void askRelease(r)}
                            data-testid="installation-release"
                          >
                            {t('licensing.installations.release')}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </Card>
  );
};

/** A filter of a few values with "all" (no native select). */
const FilterSeg = ({
  label,
  value,
  onChange,
  options,
  testId,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  testId: string;
}) => (
  <Field label={label}>
    <Segmented
      label={label}
      value={value}
      onChange={onChange}
      testId={testId}
      options={[{ value: '', label: t('licensing.all') }, ...options].map((o) => ({
        ...o,
        testId: `${testId}-${o.value || 'all'}`,
      }))}
    />
  </Field>
);

// ---------------------------------------------------------------- licenses

export const LicensesPanel = () => {
  const qc = useQueryClient();
  const server = useLicenseServer();
  const [issuing, setIssuing] = useState(false);
  const list = useQuery({
    queryKey: licensingKeys.licenses,
    queryFn: () => api().get<{ data: IssuedLicense[] }>('/platform/licenses'),
    enabled: !!server.data?.enabled,
  });
  const refresh = (message: string) => {
    void qc.invalidateQueries({ queryKey: licensingKeys.licenses });
    showToast({ message });
  };
  const act = useMutation({
    mutationFn: ({ id, action, body }: { id: string; action: string; body?: unknown }) =>
      api().post<IssuedLicense>(`/platform/licenses/${id}/${action}`, body ?? {}),
    onSuccess: (_res, v) => refresh(t(`licensing.licenses.done.${v.action as 'renew'}`)),
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const copy = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      showToast({ message: t('licensing.licenses.copied') });
    } catch {
      showToast({ message: t('licensing.licenses.copyFailed'), tone: 'error' });
    }
  };
  const revoke = async (l: IssuedLicense) => {
    const ok = await confirmDialog({
      title: t('licensing.licenses.revokeTitle'),
      message: t('licensing.licenses.revokeBody', { licensee: l.licensee }),
      confirmLabel: t('licensing.licenses.revoke'),
      danger: true,
    });
    if (ok) act.mutate({ id: l.id, action: 'revoke' });
  };
  const email = async (l: IssuedLicense) => {
    const to = await promptDialog({
      title: t('licensing.licenses.email'),
      label: t('licensing.register.email'),
      initial: l.email ?? '',
      type: 'email',
      confirmLabel: t('licensing.licenses.send'),
    });
    if (to?.trim()) act.mutate({ id: l.id, action: 'email', body: { to: to.trim() } });
  };
  const rows = list.data?.data ?? [];
  return (
    <Card className="space-y-3" data-testid="licenses">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-fg">{t('licensing.licenses.title')}</h3>
          <p className="max-w-[640px] text-xs text-muted">{t('licensing.licenses.hint')}</p>
        </div>
        {server.data?.enabled ? (
          <Button size="sm" onClick={() => setIssuing(true)} data-testid="licenses-issue">
            {t('licensing.licenses.issue')}
          </Button>
        ) : null}
      </div>
      {server.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {server.data && !server.data.enabled ? <NotAServer testId="licenses" /> : null}
      {server.data?.enabled ? (
        <>
          {list.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
          {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
          {list.data && !rows.length ? (
            <EmptyState icon={<Icon name="key" size={28} />} title={t('licensing.licenses.empty')} />
          ) : null}
          {rows.length ? (
            <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
              <table className="w-full min-w-[860px] border-collapse text-sm" data-testid="licenses-table">
                <thead>
                  <tr>
                    <th className={TH}>{t('owner.license.licensee')}</th>
                    <th className={TH}>{t('owner.license.plan')}</th>
                    <th className={TH}>{t('owner.license.seats')}</th>
                    <th className={TH}>{t('owner.license.expires')}</th>
                    <th className={TH}>{t('licensing.licenses.state')}</th>
                    <th className={TH} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((l) => (
                    <tr key={l.id} className={TR} data-testid="license-row" data-ref={l.ref} data-state={l.state}>
                      <td className={TD}>
                        <div>{l.licensee}</div>
                        <div className="text-xs text-muted" dir="ltr">
                          {l.instance_id ?? t('licensing.licenses.anyInstance')}
                        </div>
                      </td>
                      <td className={TD}>{t(`licensing.plan.${l.plan}`)}</td>
                      <td className={TD}>{l.seats ?? t('licensing.licenses.unlimited')}</td>
                      <td className={TD}>{l.expires ? day(l.expires) : t('owner.license.never')}</td>
                      <td className={TD}>
                        <div className="flex flex-wrap items-center gap-1">
                          <Badge tone={STATE_TONE[l.state]}>{t(`owner.license.state.${l.state}`)}</Badge>
                          {l.payment_provider ? (
                            <span data-testid="license-paid">
                              <Badge tone="info">{t('licensing.licenses.paid')}</Badge>
                            </span>
                          ) : null}
                          {/* Expiry reminders already sent for this expiry date. */}
                          {l.reminders.map((r) => (
                            <span
                              key={r.days}
                              title={t('licensing.licenses.reminderSentOn', { days: r.days, date: day(r.sent_at) })}
                              data-testid="license-reminder"
                              data-days={r.days}
                            >
                              <Badge tone="neutral">{t('licensing.licenses.reminderSent', { days: r.days })}</Badge>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className={TD}>
                        <div className="flex flex-wrap justify-end gap-1">
                          <Button size="sm" variant="ghost" onClick={() => void copy(l.key)} data-testid="license-copy">
                            {t('licensing.licenses.copy')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => void email(l)} data-testid="license-email">
                            {t('licensing.licenses.email')}
                          </Button>
                          {l.state !== 'revoked' ? (
                            <>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => act.mutate({ id: l.id, action: 'renew' })}
                                data-testid="license-renew"
                              >
                                {t('licensing.licenses.renew')}
                              </Button>
                              <ChangePlan
                                license={l}
                                onPick={(plan) => act.mutate({ id: l.id, action: 'plan', body: { plan } })}
                              />
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => void revoke(l)}
                                data-testid="license-revoke"
                              >
                                {t('licensing.licenses.revoke')}
                              </Button>
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
      {issuing ? (
        <IssueDialog
          onClose={() => setIssuing(false)}
          onIssued={() => {
            setIssuing(false);
            refresh(t('licensing.licenses.done.issue'));
          }}
        />
      ) : null}
    </Card>
  );
};

const ChangePlan = ({ license, onPick }: { license: IssuedLicense; onPick: (p: LicensePlan) => void }) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid="license-plan">
        {t('licensing.licenses.changePlan')}
      </Button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="flex flex-col gap-1 p-1" data-testid="license-plan-menu">
          {LICENSE_PLANS.filter((p) => p !== license.plan).map((p) => (
            <Button
              key={p}
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                onPick(p);
              }}
              data-testid={`license-plan-${p}`}
            >
              {t(`licensing.plan.${p}`)}
            </Button>
          ))}
        </div>
      </Popover>
    </span>
  );
};

const inAYear = () => new Date(Date.now() + LICENSE_TERM_DAYS * 86_400_000).toISOString().slice(0, 10);

const IssueDialog = ({ onClose, onIssued }: { onClose: () => void; onIssued: () => void }) => {
  const [plan, setPlan] = useState<LicensePlan>('business');
  const [features, setFeatures] = useState<string[]>([...EDITION_FEATURES.business]);
  const [licensee, setLicensee] = useState('');
  const [seats, setSeats] = useState('');
  const [expires, setExpires] = useState<string | null>(inAYear());
  const [instance, setInstance] = useState('');
  const [email, setEmail] = useState('');
  const [pickDate, setPickDate] = useState(false);
  const issue = useMutation({
    mutationFn: (body: IssueLicense) => api().post<IssuedLicense>('/platform/licenses', body),
    onSuccess: onIssued,
  });
  const choosePlan = (p: LicensePlan) => {
    setPlan(p);
    setFeatures([...EDITION_FEATURES[p]]);
    setExpires(p === 'registered' ? null : inAYear());
  };
  const toggle = (k: string) => setFeatures((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  const seatsNum = seats.trim() ? Number(seats) : null;
  const valid = licensee.trim() && (seatsNum === null || (Number.isInteger(seatsNum) && seatsNum > 0));
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('licensing.licenses.issue')}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('licensing.cancel')}
          </Button>
          <Button
            size="sm"
            busy={issue.isPending}
            disabled={!valid}
            onClick={() =>
              issue.mutate({
                plan,
                features,
                licensee: licensee.trim(),
                seats: seatsNum,
                expires: expires ? `${expires}T23:59:59Z` : null,
                instance_id: instance.trim() || null,
                support: EDITION_SUPPORT[plan],
                email: email.trim() || null,
              })
            }
            data-testid="issue-submit"
          >
            {t('licensing.licenses.issue')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3" data-testid="issue-dialog">
        <Field label={t('owner.license.plan')}>
          <Segmented
            label={t('owner.license.plan')}
            value={plan}
            onChange={choosePlan}
            testId="issue-plan"
            options={LICENSE_PLANS.map((p) => ({
              value: p,
              label: t(`licensing.plan.${p}`),
              testId: `issue-plan-${p}`,
            }))}
          />
        </Field>
        <Field label={t('owner.license.features')}>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5" dir="ltr" data-testid="issue-features">
            {LICENSED_FEATURE_KEYS.map((k) => (
              <label key={k} className="flex items-center gap-1.5 text-xs text-fg-2">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--primary)]"
                  checked={features.includes(k)}
                  onChange={() => toggle(k)}
                  data-testid={`issue-feature-${k}`}
                />
                {k}
              </label>
            ))}
          </div>
        </Field>
        <Field label={t('owner.license.licensee')}>
          <Input
            value={licensee}
            maxLength={200}
            onChange={(e) => setLicensee(e.target.value)}
            data-testid="issue-licensee"
          />
        </Field>
        <Field label={t('owner.license.seats')} hint={t('licensing.licenses.seatsHint')}>
          <Input
            inputMode="numeric"
            dir="ltr"
            value={seats}
            onChange={(e) => setSeats(e.target.value.replace(/[^\d]/g, ''))}
            data-testid="issue-seats"
          />
        </Field>
        <div className="relative space-y-1.5">
          <span className="text-xs font-semibold text-fg-2">{t('owner.license.expires')}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPickDate(true)}
              className="flex h-9 flex-1 items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 text-start text-sm text-fg hover:border-primary"
              data-testid="issue-expires"
            >
              <Icon name="calendar" size={15} className="shrink-0 text-muted" />
              <span className="flex-1 truncate">{expires ? formatDate(expires) : t('owner.license.never')}</span>
            </button>
            {expires ? (
              <Button size="sm" variant="ghost" onClick={() => setExpires(null)} data-testid="issue-never">
                {t('owner.license.never')}
              </Button>
            ) : null}
          </div>
          <Popover open={pickDate} onClose={() => setPickDate(false)}>
            <Calendar
              mode="single"
              value={(expires as IsoDate | null) ?? null}
              onChange={(v) => {
                setExpires(v);
                setPickDate(false);
              }}
            />
          </Popover>
        </div>
        <Field label={t('licensing.licenses.instance')} hint={t('licensing.licenses.instanceHint')}>
          <Input
            dir="ltr"
            value={instance}
            maxLength={64}
            onChange={(e) => setInstance(e.target.value)}
            data-testid="issue-instance"
          />
        </Field>
        <Field label={t('licensing.register.email')}>
          <Input
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            data-testid="issue-email"
          />
        </Field>
        {issue.isError ? <Notice tone="error">{errorMessage(issue.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};
