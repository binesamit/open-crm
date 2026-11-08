// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  COST_ALLOCATIONS,
  COST_FX_SOURCES,
  type CostSettings as Settings,
  type CostSettingsPatch,
  type CostSettingsResponse,
  formatDateTime,
  formatNumber,
  t,
  tDynamic,
} from '@bines/shared';
import { Button, Card, Field, Input, Notice, Picker, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { showToast } from '../../../lib/toast';
import { COSTS_KEY, keys, useCostSettings } from './costs-api';

const pad = (n: number) => String(n).padStart(2, '0');
/** The UTC hour as the owner's own clock reads it ("06:00"). */
const localHour = (utcHour: number) => {
  const d = new Date();
  d.setUTCHours(utcHour, 0, 0, 0);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const num = (v: string) => (v.trim() === '' ? null : Number(v));

const Form = ({ settings }: { settings: CostSettingsResponse }) => {
  const qc = useQueryClient();
  const [v, setV] = useState<Settings>(() => {
    const { fx_rates: _rates, fx_updated_at: _at, ...own } = settings;
    return own;
  });
  const [emails, setEmails] = useState(settings.alert_emails.join(', '));
  const [budget, setBudget] = useState(settings.budget_monthly === null ? '' : String(settings.budget_monthly));
  const [spike, setSpike] = useState(settings.spike_factor === null ? '' : String(settings.spike_factor));
  const [newRate, setNewRate] = useState({ currency: '', rate: '' });
  const set = (p: Partial<Settings>) => setV({ ...v, ...p });
  const save = useMutation({
    mutationFn: () => {
      const body: CostSettingsPatch = {
        ...v,
        budget_monthly: num(budget),
        spike_factor: num(spike),
        alert_emails: emails
          .split(/[,\s]+/)
          .map((e) => e.trim())
          .filter(Boolean),
      };
      return api().patch<CostSettingsResponse>('/platform/costs/settings', body);
    },
    onSuccess: async (next) => {
      qc.setQueryData(keys.settings, next);
      await qc.invalidateQueries({ queryKey: COSTS_KEY });
      showToast({ message: t('costs.settings.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const rates = Object.entries(v.fx_source === 'manual' ? v.fx_manual : settings.fx_rates);
  return (
    <div className="space-y-3" data-testid="cost-settings">
      <Card className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('costs.settings.currency')} hint={t('costs.settings.currencyHint')}>
            <Input
              value={v.display_currency}
              dir="ltr"
              className="text-start"
              onChange={(e) => set({ display_currency: e.target.value.toUpperCase().slice(0, 3) })}
              data-testid="cost-settings-currency"
            />
          </Field>
          <Field label={t('costs.settings.fxSource')}>
            <Picker
              value={v.fx_source}
              label={t('costs.settings.fxSource')}
              onChange={(fx_source) => set({ fx_source })}
              options={COST_FX_SOURCES.map((s) => ({
                value: s,
                label: tDynamic(`costs.settings.fx.${s}`),
                testId: `cost-settings-fx-${s}`,
              }))}
              testId="cost-settings-fx"
            />
          </Field>
        </div>
        <div className="space-y-1.5">
          <div className="text-xs text-muted">{t('costs.settings.fxRates')}</div>
          {rates.length ? (
            <ul className="space-y-1 text-sm" data-testid="cost-settings-rates">
              {rates.map(([c, r]) => (
                <li key={c} className="flex items-center gap-2">
                  <bdi dir="ltr">
                    {t('costs.settings.fxRate', {
                      currency: c,
                      rate: formatNumber(r, { maximumSignificantDigits: 6 }),
                      display: v.display_currency,
                    })}
                  </bdi>
                  {v.fx_source === 'manual' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        const next = { ...v.fx_manual };
                        delete next[c];
                        set({ fx_manual: next });
                      }}
                    >
                      ✕
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">{t('costs.settings.fxNone')}</p>
          )}
          {v.fx_source !== 'manual' && settings.fx_updated_at ? (
            <p className="text-xs text-muted">
              {t('costs.settings.fxUpdated', { when: formatDateTime(settings.fx_updated_at) })}
            </p>
          ) : null}
          {v.fx_source === 'manual' ? (
            <div className="flex flex-wrap items-end gap-2">
              <Input
                value={newRate.currency}
                placeholder="USD"
                dir="ltr"
                className="w-24 text-start"
                onChange={(e) => setNewRate({ ...newRate, currency: e.target.value.toUpperCase().slice(0, 3) })}
                data-testid="cost-settings-rate-currency"
              />
              <Input
                value={newRate.rate}
                inputMode="decimal"
                dir="ltr"
                className="w-28 text-start"
                onChange={(e) => setNewRate({ ...newRate, rate: e.target.value.replace(/[^\d.]/g, '') })}
                data-testid="cost-settings-rate-value"
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={!/^[A-Z]{3}$/.test(newRate.currency) || !(Number(newRate.rate) > 0)}
                onClick={() => {
                  set({ fx_manual: { ...v.fx_manual, [newRate.currency]: Number(newRate.rate) } });
                  setNewRate({ currency: '', rate: '' });
                }}
                data-testid="cost-settings-rate-add"
              >
                {t('costs.settings.fxAdd')}
              </Button>
            </div>
          ) : null}
        </div>
      </Card>

      <Card className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('costs.settings.syncHour')}>
            <Picker
              value={String(v.sync_hour)}
              label={t('costs.settings.syncHour')}
              onChange={(h) => set({ sync_hour: Number(h) })}
              options={Array.from({ length: 24 }, (_, h) => ({
                value: String(h),
                label: t('costs.settings.utc', { time: localHour(h) }),
              }))}
              testId="cost-settings-hour"
            />
          </Field>
          <Field label={t('costs.settings.syncDays')} hint={t('costs.settings.syncDaysHint')}>
            <Picker
              value={String(v.sync_days)}
              label={t('costs.settings.syncDays')}
              onChange={(d) => set({ sync_days: Number(d) })}
              options={[1, 2, 3, 5, 7, 14, 30].map((d) => ({ value: String(d), label: String(d) }))}
            />
          </Field>
          <Field label={t('costs.settings.backfillDays')}>
            <Picker
              value={String(v.backfill_days)}
              label={t('costs.settings.backfillDays')}
              onChange={(d) => set({ backfill_days: Number(d) })}
              options={[7, 14, 30, 60, 90].map((d) => ({ value: String(d), label: String(d) }))}
            />
          </Field>
        </div>
        <Field label={t('costs.settings.allocation')}>
          <Picker
            value={v.allocation}
            label={t('costs.settings.allocation')}
            onChange={(allocation) => set({ allocation })}
            options={COST_ALLOCATIONS.map((a) => ({ value: a, label: tDynamic(`costs.accounts.method.${a}`) }))}
            testId="cost-settings-allocation"
          />
        </Field>
      </Card>

      <Card className="space-y-3">
        <Field label={t('costs.settings.budget')} hint={t('costs.settings.budgetHint')}>
          <Input
            value={budget}
            inputMode="decimal"
            dir="ltr"
            className="max-w-[200px] text-start"
            onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))}
            data-testid="cost-settings-budget"
          />
        </Field>
        <Switch
          checked={v.alerts}
          onChange={(alerts) => set({ alerts })}
          label={t('costs.settings.alerts')}
          testId="cost-settings-alerts"
        />
        <p className="text-xs text-muted">{t('costs.settings.alertsHint')}</p>
        {v.alerts ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('costs.settings.spikeFactor')} hint={t('costs.settings.spikeFactorHint')}>
                <Input
                  value={spike}
                  inputMode="decimal"
                  dir="ltr"
                  className="text-start"
                  onChange={(e) => setSpike(e.target.value.replace(/[^\d.]/g, ''))}
                  data-testid="cost-settings-spike"
                />
              </Field>
              <Field label={t('costs.settings.spikeMin')}>
                <Input
                  value={String(v.spike_min)}
                  inputMode="decimal"
                  dir="ltr"
                  className="text-start"
                  onChange={(e) => set({ spike_min: Number(e.target.value.replace(/[^\d.]/g, '') || 0) })}
                />
              </Field>
            </div>
            <Field label={t('costs.settings.alertEmails')} hint={t('costs.settings.alertEmailsHint')}>
              <Input
                value={emails}
                dir="ltr"
                className="text-start"
                onChange={(e) => setEmails(e.target.value)}
                data-testid="cost-settings-emails"
              />
            </Field>
          </>
        ) : null}
      </Card>
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      <Button
        onClick={() => save.mutate()}
        busy={save.isPending}
        disabled={!/^[A-Z]{3}$/.test(v.display_currency)}
        data-testid="cost-settings-save"
      >
        {t('costs.source.save')}
      </Button>
    </div>
  );
};

/** Costs → Settings: currency and rates, the daily sync, how shared costs are split, budgets and alerts. */
export const CostSettings = () => {
  const q = useCostSettings();
  if (q.isPending) return <SkeletonRows rows={4} label={t('app.loading')} />;
  if (q.isError) return <Notice tone="error">{errorMessage(q.error)}</Notice>;
  return <Form key={q.dataUpdatedAt} settings={q.data} />;
};
