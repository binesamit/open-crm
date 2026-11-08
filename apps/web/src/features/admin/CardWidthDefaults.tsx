// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  type AccountDefaults,
  CARD_MAX_PCT_RANGE,
  CARD_MIN_PX_RANGE,
  CARD_WIDTH_DEFAULTS,
  CARD_WIDTH_PCT_RANGE,
  CARD_WIDTH_PRESETS,
  type CardWidthPreset,
  type UpdateAccount,
  t,
} from '@bines/shared';
import { Input, Segmented } from '@bines/ui';
import { Row } from './admin-parts';

type Patch = NonNullable<UpdateAccount['settings']>;
type Key = 'card_width_pct' | 'card_min_px' | 'card_max_pct';
const RANGE: Record<Key, { min: number; max: number }> = {
  card_width_pct: CARD_WIDTH_PCT_RANGE,
  card_min_px: CARD_MIN_PX_RANGE,
  card_max_pct: CARD_MAX_PCT_RANGE,
};
const PRESETS = Object.keys(CARD_WIDTH_PRESETS) as CardWidthPreset[];

/** A whole number within its range, saved on Enter / leaving the field (an invalid value goes back). */
const NumberSetting = ({
  field,
  value,
  unit,
  onSave,
}: {
  field: Key;
  value: number;
  unit: string;
  onSave: (n: number) => void;
}) => {
  const range = RANGE[field];
  const [draft, setDraft] = useState(String(value));
  const n = Number(draft);
  const valid = draft !== '' && Number.isInteger(n) && n >= range.min && n <= range.max;
  const commit = () => {
    if (valid && n !== value) onSave(n);
    else if (!valid) setDraft(String(value));
  };
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        inputMode="numeric"
        dir="ltr"
        className="h-8 w-[4.5rem] text-center"
        aria-label={t(`cardw.admin.${field}`)}
        aria-invalid={!valid || undefined}
        data-tip={t('cardw.admin.range', { min: range.min, max: range.max })}
        data-testid={`admin-${field.replaceAll('_', '-')}`}
      />
      {unit}
    </label>
  );
};

/**
 * F9 cardw — Administration → General → defaults: the item card's default width (a preset or any %), and how narrow
 * / wide a member may drag it. A member's own dragged width wins over the default (their ⋯ → "reset width").
 */
export const CardWidthDefaults = ({
  defaults,
  onSave,
}: {
  defaults: AccountDefaults;
  onSave: (s: Patch, done?: () => void) => void;
}) => {
  const pct = defaults.card_width_pct;
  const preset = PRESETS.find((p) => CARD_WIDTH_PRESETS[p] === pct);
  const save = (field: Key) => (n: number) => onSave({ defaults: { [field]: n } });
  const changed =
    pct !== CARD_WIDTH_DEFAULTS.card_width_pct ||
    defaults.card_min_px !== CARD_WIDTH_DEFAULTS.card_min_px ||
    defaults.card_max_pct !== CARD_WIDTH_DEFAULTS.card_max_pct;
  return (
    <>
      <Row label={t('cardw.admin.width')} hint={t('cardw.admin.widthHint')} testId="admin-card-width">
        <Segmented<CardWidthPreset | 'custom'>
          label={t('cardw.admin.width')}
          value={preset ?? 'custom'}
          onChange={(p) => p !== 'custom' && onSave({ defaults: { card_width_pct: CARD_WIDTH_PRESETS[p] } })}
          options={PRESETS.map((p) => ({
            value: p,
            label: t(`cardw.preset.${p}`),
            testId: `admin-card-width-${p}`,
          }))}
        />
        <NumberSetting key={`w${pct}`} field="card_width_pct" value={pct} unit="%" onSave={save('card_width_pct')} />
      </Row>
      <Row label={t('cardw.admin.limits')} hint={t('cardw.admin.limitsHint')} testId="admin-card-limits">
        <span className="text-xs text-muted">{t('cardw.admin.min')}</span>
        <NumberSetting
          key={`n${defaults.card_min_px}`}
          field="card_min_px"
          value={defaults.card_min_px}
          unit="px"
          onSave={save('card_min_px')}
        />
        <span className="text-xs text-muted">{t('cardw.admin.max')}</span>
        <NumberSetting
          key={`x${defaults.card_max_pct}`}
          field="card_max_pct"
          value={defaults.card_max_pct}
          unit="%"
          onSave={save('card_max_pct')}
        />
        {changed ? (
          <button
            type="button"
            onClick={() => onSave({ defaults: { ...CARD_WIDTH_DEFAULTS } })}
            className="ms-1 text-xs font-semibold text-heading underline underline-offset-2 hover:no-underline"
            data-testid="admin-card-width-reset"
          >
            {t('cardw.admin.reset')}
          </button>
        ) : null}
      </Row>
    </>
  );
};
