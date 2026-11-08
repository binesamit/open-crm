// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type PlatformSettingsResponse, type PlatformSupportSettings, SUPPORT_HOURS_MAX, t } from '@bines/shared';
import { Button, Card, Field, Input, Segmented, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { durationLabel } from '../admin/SupportAccessPanel';

const KEY = ['platform', 'settings'] as const;
const INT = /^\d{1,4}$/;

/**
 * Owner console → Platform settings → Support access: the durations an account admin may grant, the
 * default and the longest one, the email to the admins when support enters, whether reads are audited too, the idle
 * time that starts a new session, the emergency recovery wait, and whether the platform owner is exempt from the
 * accounts' IP allowlists (default on).
 */
export const SupportSettingsCard = ({ data }: { data: PlatformSettingsResponse }) => {
  const qc = useQueryClient();
  const s = data.settings.support as PlatformSupportSettings;
  const [durations, setDurations] = useState<number[]>(s.durations_hours);
  const [def, setDef] = useState(s.default_duration_hours);
  const [max, setMax] = useState(s.max_duration_hours);
  const [email, setEmail] = useState(s.email_admins_on_entry);
  const [views, setViews] = useState(s.log_views);
  const [idle, setIdle] = useState(String(s.session_idle_minutes));
  const [delay, setDelay] = useState(String(s.emergency_delay_hours));
  const [exempt, setExempt] = useState(s.owner_ip_exempt);
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<'hours' | 'days'>('hours');

  const idleOk = INT.test(idle) && Number(idle) >= 5 && Number(idle) <= 1440;
  const delayOk = INT.test(delay) && Number(delay) >= 1 && Number(delay) <= 168;
  const ok = durations.length > 0 && idleOk && delayOk;
  const addHours = INT.test(amount) ? Number(amount) * (unit === 'days' ? 24 : 1) : 0;
  const add = (e: FormEvent) => {
    e.preventDefault();
    if (addHours < 1 || addHours > SUPPORT_HOURS_MAX || durations.length >= 12) return;
    setDurations((d) => [...new Set([...d, addHours])].sort((x, y) => x - y));
    setAmount('');
  };
  const remove = (h: number) => {
    const next = durations.filter((x) => x !== h);
    setDurations(next);
    if (def === h && next.length) setDef(next[0]!);
    if (max === h && next.length) setMax(next[next.length - 1]!);
  };
  const save = useMutation({
    mutationFn: () =>
      api().patch<PlatformSettingsResponse>('/platform/settings', {
        support: {
          durations_hours: durations,
          default_duration_hours: durations.includes(def) ? def : durations[0],
          max_duration_hours: durations.includes(max) ? max : durations[durations.length - 1],
          email_admins_on_entry: email,
          log_views: views,
          session_idle_minutes: Number(idle),
          emergency_delay_hours: Number(delay),
          owner_ip_exempt: exempt,
        },
      }),
    onSuccess: (res) => {
      qc.setQueryData(KEY, res);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const choices = durations.map((h) => ({ value: String(h), label: durationLabel(h), testId: `owner-support-h-${h}` }));

  return (
    <Card className="space-y-4">
      <div className="space-y-0.5" data-testid="owner-support-settings">
        <h3 className="text-sm font-semibold text-fg">{t('support.owner.title')}</h3>
        <p className="text-xs text-muted">{t('support.owner.hint')}</p>
      </div>
      <div className="space-y-2">
        <span className="text-xs font-semibold text-fg-2">{t('support.owner.durations')}</span>
        <div className="flex flex-wrap gap-1.5">
          {durations.map((h) => (
            <span
              key={h}
              data-testid="owner-support-duration"
              data-hours={h}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 ps-2.5 pe-1 text-xs font-semibold text-fg-2"
            >
              {durationLabel(h)}
              <button
                type="button"
                aria-label={t('support.owner.removeDuration', { label: durationLabel(h) })}
                disabled={durations.length <= 1}
                onClick={() => remove(h)}
                className="grid size-5 place-items-center rounded-full text-muted hover:bg-surface-3 hover:text-fg"
              >
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
        <form onSubmit={add} className="flex flex-wrap items-center gap-2">
          <Input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="numeric"
            dir="ltr"
            className="h-9 w-20 text-start"
            aria-label={t('support.owner.addDuration')}
            data-testid="owner-support-duration-input"
          />
          <Segmented
            label={t('support.owner.unit')}
            value={unit}
            onChange={setUnit}
            options={[
              { value: 'hours' as const, label: t('support.owner.unit.hours') },
              { value: 'days' as const, label: t('support.owner.unit.days') },
            ]}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={addHours < 1 || addHours > SUPPORT_HOURS_MAX}
            data-testid="owner-support-duration-add"
          >
            <Icon name="plus" size={14} />
            {t('support.owner.addDuration')}
          </Button>
        </form>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('support.owner.default')}>
          <Segmented
            label={t('support.owner.default')}
            value={String(durations.includes(def) ? def : durations[0])}
            onChange={(v) => setDef(Number(v))}
            options={choices}
            testId="owner-support-default"
          />
        </Field>
        <Field label={t('support.owner.max')} hint={t('support.owner.maxHint')}>
          <Segmented
            label={t('support.owner.max')}
            value={String(durations.includes(max) ? max : durations[durations.length - 1])}
            onChange={(v) => setMax(Number(v))}
            options={choices}
            testId="owner-support-max"
          />
        </Field>
        <Field label={t('support.owner.idle')} hint={t('support.owner.idleHint')}>
          <Input
            value={idle}
            onChange={(e) => setIdle(e.target.value)}
            inputMode="numeric"
            dir="ltr"
            className="text-start"
            data-testid="owner-support-idle"
          />
        </Field>
        <Field label={t('support.owner.delay')} hint={t('support.owner.delayHint')}>
          <Input
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
            inputMode="numeric"
            dir="ltr"
            className="text-start"
            data-testid="owner-support-delay"
          />
        </Field>
      </div>
      <div className="flex flex-col gap-3">
        <label className="flex items-center justify-between gap-3">
          <span className="space-y-0.5">
            <span className="block text-sm font-semibold text-fg">{t('support.owner.email')}</span>
            <span className="block text-xs text-muted">{t('support.owner.emailHint')}</span>
          </span>
          <Switch checked={email} onChange={setEmail} label={t('support.owner.email')} testId="owner-support-email" />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="space-y-0.5">
            <span className="block text-sm font-semibold text-fg">{t('support.owner.logViews')}</span>
            <span className="block text-xs text-muted">{t('support.owner.logViewsHint')}</span>
          </span>
          <Switch
            checked={views}
            onChange={setViews}
            label={t('support.owner.logViews')}
            testId="owner-support-views"
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="space-y-0.5">
            <span className="block text-sm font-semibold text-fg">{t('support.owner.ipExempt')}</span>
            <span className="block text-xs text-muted">{t('support.owner.ipExemptHint')}</span>
          </span>
          <Switch
            checked={exempt}
            onChange={setExempt}
            label={t('support.owner.ipExempt')}
            testId="owner-support-ip-exempt"
          />
        </label>
      </div>
      <div className="flex justify-end">
        <Button busy={save.isPending} disabled={!ok} onClick={() => save.mutate()} data-testid="owner-support-save">
          {t('common.save')}
        </Button>
      </div>
    </Card>
  );
};
