// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { costMetricDef, costMetricDefs, type CostPrice, type CostPriceInput, formatDate, t } from '@bines/shared';
import { Button, Calendar, cn, Dialog, EmptyState, Field, Input, Notice, Picker, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { confirmDialog } from '../../../lib/dialogs';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { Popover } from '../../board/cells/Popover';
import { TD, TH, TR } from '../../trash/TrashPage';
import {
  COSTS_KEY,
  metricLabel,
  metricUnit,
  quantity,
  serviceLabel,
  todayIso,
  unitLabel,
  unitPrice,
  useCostPrices,
  useCostSettings,
} from './costs-api';

const fail = (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' });
const METRIC_RE = /^[a-z][a-z0-9_.]{0,59}$/;

/** Metrics a price can be for: every adapter's quantities (money the source reports needs no price). */
const priceable = () => costMetricDefs().filter((m) => !m.direct);

const PriceDialog = ({
  price,
  metric: initialMetric,
  onClose,
}: {
  price: CostPrice | null;
  metric?: string;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const settings = useCostSettings();
  const [metric, setMetric] = useState(price?.metric ?? initialMetric ?? priceable()[0]!.key);
  const [service, setService] = useState(price?.service ?? '*');
  const [value, setValue] = useState(price ? String(price.price) : '');
  const [currency, setCurrency] = useState(price?.currency ?? settings.data?.display_currency ?? 'USD');
  const [free, setFree] = useState(price ? String(price.free_per_month) : '0');
  const [from, setFrom] = useState(price?.effective_from ?? todayIso().slice(0, 8) + '01');
  const [note, setNote] = useState(price?.note ?? '');
  const [calendar, setCalendar] = useState(false);
  const suggested = costMetricDef(metric)?.suggested;
  const save = useMutation({
    mutationFn: () => {
      const body: CostPriceInput = {
        metric,
        service: service.trim() || '*',
        price: Number(value),
        currency: currency.trim().toUpperCase(),
        free_per_month: Number(free || 0),
        effective_from: from,
        note: note.trim() || null,
      };
      return price
        ? api().patch<CostPrice>(`/platform/costs/prices/${price.id}`, body)
        : api().post<CostPrice>('/platform/costs/prices', body);
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: COSTS_KEY });
      showToast({ message: t('costs.settings.saved') });
      onClose();
    },
    onError: fail,
  });
  const valid =
    METRIC_RE.test(metric) &&
    value.trim() !== '' &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0 &&
    /^[A-Z]{3}$/.test(currency.trim().toUpperCase()) &&
    Number.isFinite(Number(free || 0));
  return (
    <Dialog
      open
      onClose={onClose}
      title={price ? t('costs.price.edit') : t('costs.price.add')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} busy={save.isPending} disabled={!valid} data-testid="cost-price-save">
            {t('costs.source.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="cost-price-dialog">
        <Field label={t('costs.price.metric')}>
          <Picker
            value={metric}
            label={t('costs.price.metric')}
            onChange={setMetric}
            options={priceable().map((m) => ({
              value: m.key,
              label: metricLabel(m.key),
              keywords: m.key,
              testId: `cost-price-metric-${m.key}`,
            }))}
            // A metric of a source added later (an extension's) can be typed as it is.
            custom={{ label: (q) => (METRIC_RE.test(q) ? q : null) }}
            valueLabel={metricLabel}
            testId="cost-price-metric"
          />
        </Field>
        {suggested ? (
          <Notice tone="info">
            <div data-testid="cost-price-suggested">
              <span className="block">
                {t('costs.price.suggested', {
                  // One left-to-right run in a right-to-left sentence: "0.000463 USD", never "USD 0.000463".
                  price: `\u2066${unitPrice(suggested.price)} ${suggested.currency}\u2069`,
                  unit: unitLabel(metricUnit(metric)),
                })}
                {suggested.free_per_month
                  ? ` · ${t('costs.price.suggestedFree', { free: quantity(suggested.free_per_month) })}`
                  : ''}
              </span>
              <span className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setValue(String(suggested.price));
                    setCurrency(suggested.currency);
                    setFree(String(suggested.free_per_month ?? 0));
                  }}
                  data-testid="cost-price-use-suggested"
                >
                  {t('costs.price.useSuggested')}
                </Button>
                <a
                  href={suggested.source_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-xs text-primary hover:underline"
                >
                  {t('costs.price.checkSource')}
                </a>
              </span>
            </div>
          </Notice>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t('costs.price.price')}
            hint={t('costs.price.perUnit', { unit: unitLabel(metricUnit(metric)) })}
          >
            <Input
              value={value}
              inputMode="decimal"
              dir="ltr"
              className="text-start"
              onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))}
              data-testid="cost-price-value"
            />
          </Field>
          <Field label={t('costs.price.currency')}>
            <Input
              value={currency}
              dir="ltr"
              className="text-start"
              onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
              data-testid="cost-price-currency"
            />
          </Field>
          <Field label={t('costs.price.free')}>
            <Input
              value={free}
              inputMode="decimal"
              dir="ltr"
              className="text-start"
              onChange={(e) => setFree(e.target.value.replace(/[^\d.]/g, ''))}
              data-testid="cost-price-free"
            />
          </Field>
          <Field label={t('costs.price.service')}>
            <Input
              value={service}
              dir="ltr"
              className="text-start"
              onChange={(e) => setService(e.target.value)}
              data-testid="cost-price-service"
            />
          </Field>
          <Field label={t('costs.price.from')}>
            <span className="relative">
              <button
                type="button"
                onClick={() => setCalendar((v) => !v)}
                data-testid="cost-price-from"
                className="flex h-9 min-w-[160px] items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-2.5 text-sm text-fg hover:bg-surface-2"
              >
                <Icon name="calendar" size={16} />
                {formatDate(from)}
              </button>
              <Popover open={calendar} onClose={() => setCalendar(false)} align="start" className="p-2">
                <Calendar
                  mode="single"
                  value={from as never}
                  onChange={(d) => {
                    if (d) setFrom(d);
                    setCalendar(false);
                  }}
                />
              </Popover>
            </span>
          </Field>
          <Field label={t('costs.price.note')}>
            <Input value={note} dir="auto" onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
};

/**
 * Costs → Prices: what each unit costs (per metric, a service or all, from a day on, with free units a month).
 * Changing one reprices the days it covers.
 */
export const CostPrices = ({ addFor, onAddClosed }: { addFor?: string | null; onAddClosed?: () => void }) => {
  const qc = useQueryClient();
  const list = useCostPrices();
  const [editing, setEditing] = useState<CostPrice | 'new' | null>(addFor ? 'new' : null);
  const remove = useMutation({
    mutationFn: (id: string) => api().delete(`/platform/costs/prices/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: COSTS_KEY }),
    onError: fail,
  });
  const close = () => {
    setEditing(null);
    onAddClosed?.();
  };
  const rows = list.data ?? [];
  return (
    <div className="space-y-2.5" data-testid="cost-prices">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="max-w-[640px] text-xs text-muted">{t('costs.price.hint')}</p>
        <Button size="sm" variant="accent" onClick={() => setEditing('new')} data-testid="cost-price-new">
          {t('costs.price.add')}
        </Button>
      </div>
      {list.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      {list.data && !rows.length ? <EmptyState title={t('costs.price.empty')} testId="cost-prices-empty" /> : null}
      {rows.length ? (
        <div className="overflow-x-auto rounded-[12px] border border-line bg-surface">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr>
                <th className={TH}>{t('costs.price.metric')}</th>
                <th className={TH}>{t('costs.services.service')}</th>
                <th className={TH}>{t('costs.price.price')}</th>
                <th className={TH}>{t('costs.price.free')}</th>
                <th className={TH}>{t('costs.price.from')}</th>
                <th className={TH} />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr key={p.id} className={TR} data-testid="cost-price-row" data-metric={p.metric}>
                  <td className={TD}>
                    {metricLabel(p.metric)}
                    {p.note ? <div className="text-xs text-muted">{p.note}</div> : null}
                  </td>
                  <td className={TD}>
                    <bdi>{p.service === '*' ? '*' : serviceLabel(p.service)}</bdi>
                  </td>
                  <td className={cn(TD, 'tabular-nums')}>
                    <bdi dir="ltr">
                      {unitPrice(p.price)} {p.currency}
                    </bdi>{' '}
                    <span className="text-xs text-muted">
                      {t('costs.price.perUnit', { unit: unitLabel(metricUnit(p.metric)) })}
                    </span>
                  </td>
                  <td className={cn(TD, 'tabular-nums')}>{p.free_per_month ? quantity(p.free_per_month) : '—'}</td>
                  <td className={TD}>{formatDate(p.effective_from)}</td>
                  <td className={cn(TD, 'whitespace-nowrap')}>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(p)} data-testid="cost-price-edit">
                      {t('costs.price.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void confirmDialog({
                          title: t('costs.price.deleteConfirm'),
                          confirmLabel: t('common.delete'),
                          danger: true,
                        }).then((ok) => ok && remove.mutate(p.id))
                      }
                      data-testid="cost-price-delete"
                    >
                      {t('common.delete')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {editing ? (
        <PriceDialog
          key={editing === 'new' ? `new-${addFor ?? ''}` : editing.id}
          price={editing === 'new' ? null : editing}
          metric={addFor ?? undefined}
          onClose={close}
        />
      ) : null}
    </div>
  );
};
