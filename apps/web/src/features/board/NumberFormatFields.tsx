// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { currencySymbol, t, type MessageKey } from '@bines/shared';
import { Card, Field, Segmented, Switch } from '@bines/ui';
import { useAccountDetail } from '../admin/account-settings';
import { PickerButton } from './toolbar/parts';

const CURRENCIES = ['₪', '$', '€', '£', '¥'] as const;
type Format = 'none' | 'currency' | 'percent' | 'custom';
type Unit = { symbol: string; direction: 'left' | 'right' };

/**
 * How a number is shown (03 §2.4): plain, currency, percent or a custom unit; decimals;
 * 1,000s — the numbers column's settings, and a formula's number result (03 §2.18). Returns the column's settings
 * with the chosen format, and the controls (with a live preview through `preview`).
 */
export const useNumberFormatFields = ({
  accountId,
  settings,
  preview,
}: {
  accountId: string;
  settings: Record<string, unknown>;
  preview: (settings: Record<string, unknown>) => string;
}): { settings: Record<string, unknown>; body: ReactNode } => {
  // The account's currency (Administration → כללי) is what "currency" starts with.
  const accountCurrency = currencySymbol(useAccountDetail({ id: accountId }).data?.settings.locale.currency ?? 'ILS');
  const unit = settings.unit as Unit | undefined;
  const initial: Format = !unit?.symbol
    ? 'none'
    : unit.symbol === '%'
      ? 'percent'
      : (CURRENCIES as readonly string[]).includes(unit.symbol)
        ? 'currency'
        : 'custom';
  const [format, setFormat] = useState<Format>(initial);
  const [currency, setCurrency] = useState(initial === 'currency' ? unit!.symbol : accountCurrency);
  const [custom, setCustom] = useState(initial === 'custom' ? unit!.symbol : '');
  const [direction, setDirection] = useState<Unit['direction']>(unit?.direction ?? 'left');
  const [precision, setPrecision] = useState<number>(Number(settings.precision ?? -1));
  const [thousands, setThousands] = useState(!!settings.thousands);

  const nextUnit: Unit | undefined =
    format === 'currency'
      ? { symbol: currency, direction }
      : format === 'percent'
        ? { symbol: '%', direction: 'right' }
        : format === 'custom' && custom.trim()
          ? { symbol: custom.trim().slice(0, 8), direction }
          : undefined;
  const { unit: _old, ...rest } = settings;
  void _old;
  const next: Record<string, unknown> = { ...rest, precision, thousands, ...(nextUnit ? { unit: nextUnit } : {}) };

  const decimals = (
    <Field label={t('numbers.decimals')}>
      <PickerButton
        testId="numbers-decimals"
        menuLabel={t('numbers.decimals')}
        placeholder={t('numbers.decimals.auto')}
        label={precision < 0 ? t('numbers.decimals.auto') : String(precision)}
        className="h-9 w-full"
        items={[-1, 0, 1, 2, 3, 4].map((p) => ({
          label: p < 0 ? t('numbers.decimals.auto') : String(p),
          checked: p === precision,
          onSelect: () => setPrecision(p),
        }))}
      />
    </Field>
  );

  const body = (
    <>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-fg-2">{t('numbers.format')}</span>
        <Segmented<Format>
          testId="numbers-format"
          label={t('numbers.format')}
          className="self-start"
          value={format}
          onChange={setFormat}
          options={(['none', 'currency', 'percent', 'custom'] as const).map((f) => ({
            value: f,
            label: t(`numbers.format.${f}` as MessageKey),
            testId: `numbers-format-${f}`,
          }))}
        />
      </div>
      {format === 'currency' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('numbers.currency')}>
            <PickerButton
              testId="numbers-currency"
              menuLabel={t('numbers.currency')}
              placeholder="₪"
              label={currency}
              className="h-9 w-full"
              items={CURRENCIES.map((c) => ({ label: c, checked: c === currency, onSelect: () => setCurrency(c) }))}
            />
          </Field>
          {decimals}
        </div>
      ) : null}
      {/* The direction belongs to a custom unit (a currency keeps its own side). */}
      {format === 'custom' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('numbers.symbol')}>
            <input
              value={custom}
              maxLength={8}
              data-testid="numbers-symbol"
              onChange={(e) => setCustom(e.target.value)}
              className="h-9 w-full rounded-[10px] border border-line-strong bg-surface px-3 text-sm focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
            />
          </Field>
          <Field label={t('numbers.direction')}>
            <PickerButton
              testId="numbers-direction"
              menuLabel={t('numbers.direction')}
              placeholder=""
              label={t(`numbers.direction.${direction}` as MessageKey)}
              className="h-9 w-full"
              items={(['left', 'right'] as const).map((d) => ({
                label: t(`numbers.direction.${d}` as MessageKey),
                checked: d === direction,
                onSelect: () => setDirection(d),
              }))}
            />
          </Field>
        </div>
      ) : null}
      {format !== 'currency' ? decimals : null}
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span>{t('numbers.thousands')}</span>
        <Switch checked={thousands} onChange={setThousands} />
      </label>
      <Card soft className="flex items-center justify-between gap-3">
        <span className="text-muted">{t('numbers.preview')}</span>
        <span
          className="font-display text-[1.1875rem] font-extrabold text-heading tabular-nums"
          dir="ltr"
          data-testid="numbers-preview"
        >
          {preview(next)}
        </span>
      </Card>
    </>
  );
  return { settings: next, body };
};
