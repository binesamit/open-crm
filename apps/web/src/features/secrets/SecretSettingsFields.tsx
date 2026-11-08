// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  SECRET_LIMITS,
  type SecretKind,
  type SecretRevealMode,
  type SecretSettings,
  type SecretUpdateSettings,
  t,
} from '@bines/shared';
import { Button, Field, Input, Segmented, Switch } from '@bines/ui';
import { useMembers } from '../board/board-api';
import { CheckRow } from '../board/toolbar/parts';
import { Panel } from '../admin/admin-parts';

/**
 * The settings that guard secrets — shared by a secret column and secret updates
 * who may reveal, how long a value shows, how long a fresh code counts, copy, a code before a change, the admins'
 * alert; plus `multiline` (a column) or `enabled` (secret updates). Numbers are typed as text (no browser spinner).
 */
export type SecretFields = {
  mode: SecretRevealMode;
  people: string[];
  seconds: string;
  minutes: string;
  copy: boolean;
  changeCode: boolean;
  threshold: string;
  /** A column only. */
  multiline?: boolean;
  /** A column only: a text or a check box, and whether a check box shows without a code. */
  kind?: SecretKind;
  checkboxVisible?: boolean;
  /** Secret updates only. */
  enabled?: boolean;
};

export const fieldsOf = (s: SecretSettings | SecretUpdateSettings): SecretFields => ({
  mode: s.reveal_mode,
  people: s.reveal_user_ids,
  seconds: String(s.reveal_seconds),
  minutes: String(s.verify_minutes),
  copy: s.copy_allowed,
  changeCode: s.change_requires_code,
  threshold: String(s.alert_threshold),
  // The settings schemas are loose: read the two kind-specific flags as booleans.
  ...('multiline' in s ? { multiline: (s as SecretSettings).multiline === true } : {}),
  ...('multiline' in s
    ? {
        kind: (s as SecretSettings).kind === 'checkbox' ? ('checkbox' as const) : ('text' as const),
        checkboxVisible: (s as SecretSettings).checkbox_visible === true,
      }
    : {}),
  ...('enabled' in s ? { enabled: (s as SecretUpdateSettings).enabled !== false } : {}),
});

const within = (v: string, l: { min: number; max: number }) =>
  Number.isInteger(Number(v)) && v.trim() !== '' && Number(v) >= l.min && Number(v) <= l.max;

export const fieldsValid = (f: SecretFields) =>
  within(f.seconds, SECRET_LIMITS.revealSeconds) &&
  within(f.minutes, SECRET_LIMITS.verifyMinutes) &&
  within(f.threshold, SECRET_LIMITS.alertThreshold) &&
  (f.mode === 'board_members' || f.people.length > 0);

/** The stored shape (the caller adds what else it keeps). */
export const settingsOfFields = (f: SecretFields) => ({
  reveal_mode: f.mode,
  reveal_user_ids: f.mode === 'people' ? f.people : [],
  reveal_seconds: Number(f.seconds),
  verify_minutes: Number(f.minutes),
  copy_allowed: f.copy,
  change_requires_code: f.changeCode,
  alert_threshold: Number(f.threshold),
  ...(f.multiline !== undefined ? { multiline: f.kind === 'checkbox' ? false : f.multiline } : {}),
  ...(f.kind !== undefined ? { kind: f.kind, checkbox_visible: f.kind === 'checkbox' && !!f.checkboxVisible } : {}),
  ...(f.enabled !== undefined ? { enabled: f.enabled } : {}),
});

/** A whole number inside the setting's limits, typed as text (no browser spinner). */
const NumberField = ({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  testId,
  disabled,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  testId: string;
  disabled?: boolean;
}) => {
  const n = Number(value);
  const bad = value.trim() === '' || !Number.isInteger(n) || n < min || n > max;
  return (
    <Field label={label} hint={bad ? t('secret.settings.range', { min, max }) : hint}>
      <Input
        value={value}
        inputMode="numeric"
        dir="ltr"
        className="w-28"
        aria-invalid={bad}
        disabled={disabled}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, '').slice(0, 5))}
      />
    </Field>
  );
};

/**
 * how long a fresh code counts, up to 12 hours — typed in minutes or hours (the unit is only how it is
 * typed; `value` is always minutes). Hours are whole hours; a value that is not whole hours shows in minutes.
 */
export const VerifyWindowField = ({
  label,
  hint,
  value,
  onChange,
  testId,
  disabled,
  max = SECRET_LIMITS.verifyMinutes.max,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (minutes: string) => void;
  testId: string;
  disabled?: boolean;
  max?: number;
}) => {
  const n = Number(value);
  const [unit, setUnit] = useState<'minutes' | 'hours'>(() => (n >= 60 && n % 60 === 0 ? 'hours' : 'minutes'));
  const [hoursText, setHoursText] = useState(() => (n >= 60 && n % 60 === 0 ? String(n / 60) : ''));
  const min = SECRET_LIMITS.verifyMinutes.min;
  const bad = value.trim() === '' || !Number.isInteger(n) || n < min || n > max;
  const range =
    unit === 'hours'
      ? t('secret.settings.rangeHours', { max: Math.floor(max / 60) })
      : t('secret.settings.range', { min, max });
  const pickUnit = (next: string) => {
    const u = next === 'hours' ? 'hours' : 'minutes';
    setUnit(u);
    if (u === 'hours') {
      const h = Math.max(1, Math.round(n / 60) || 1);
      setHoursText(String(h));
      onChange(String(h * 60));
    }
  };
  return (
    <Field label={label} hint={bad ? range : hint}>
      <span className="flex items-center gap-2">
        <Input
          value={unit === 'hours' ? hoursText : value}
          inputMode="numeric"
          dir="ltr"
          className="w-20"
          aria-invalid={bad}
          disabled={disabled}
          data-testid={testId}
          onChange={(e) => {
            const digits = e.target.value.replace(/[^\d]/g, '').slice(0, 4);
            if (unit === 'hours') {
              setHoursText(digits);
              onChange(digits ? String(Number(digits) * 60) : '');
            } else onChange(digits);
          }}
        />
        <Segmented
          label={t('secret.settings.unit')}
          value={unit}
          testId={`${testId}-unit`}
          onChange={pickUnit}
          options={[
            { value: 'minutes', label: t('secret.settings.unit.minutes'), testId: `${testId}-unit-minutes` },
            { value: 'hours', label: t('secret.settings.unit.hours'), testId: `${testId}-unit-hours` },
          ]}
        />
      </span>
    </Field>
  );
};

/** `kind`: a column's wording (values) or secret updates' (texts); `disabled`: read-only (no rights). */
export const SecretSettingsFields = ({
  accountId,
  value,
  onChange,
  kind,
  disabled,
  kindLocked,
}: {
  accountId: string;
  value: SecretFields;
  onChange: (next: SecretFields) => void;
  kind: 'column' | 'updates';
  disabled?: boolean;
  /** A column that holds values keeps its kind (text ↔ check box). */
  kindLocked?: boolean;
}) => {
  const members = (useMembers(accountId).data?.data ?? []).filter((m) => m.status === 'active' && !m.agent);
  const [query, setQuery] = useState('');
  const set = (patch: Partial<SecretFields>) => onChange({ ...value, ...patch });
  const shown = members.filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (id: string) =>
    set({ people: value.people.includes(id) ? value.people.filter((x) => x !== id) : [...value.people, id] });
  const updates = kind === 'updates';

  return (
    <fieldset className="flex flex-col gap-3.5" disabled={disabled}>
      {value.enabled !== undefined ? (
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={value.enabled} onChange={(v) => set({ enabled: v })} testId="secret-updates-enabled" />
            {t('secretUpdates.settings.enabled')}
          </label>
          <p className="text-xs text-muted">{t('secretUpdates.settings.enabledHint')}</p>
        </div>
      ) : null}
      <Field label={t('secret.settings.who')}>
        <Segmented
          label={t('secret.settings.who')}
          value={value.mode}
          testId="secret-reveal-mode"
          onChange={(v) => set({ mode: v as SecretRevealMode })}
          options={[
            { value: 'board_members', label: t('secret.settings.who.board'), testId: 'secret-mode-board' },
            { value: 'people', label: t('secret.settings.who.people'), testId: 'secret-mode-people' },
          ]}
        />
      </Field>
      <p className="-mt-2 text-xs text-muted">
        {updates ? t('secretUpdates.settings.whoHint') : t('secret.settings.whoHint')}
      </p>
      {value.mode === 'people' ? (
        <div className="flex flex-col gap-1.5" data-testid="secret-people">
          <Input
            value={query}
            placeholder={t('secret.settings.searchPeople')}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="secret-people-search"
          />
          <div className="max-h-48 overflow-y-auto rounded-[10px] border border-line p-1">
            {shown.map((m) => (
              <CheckRow key={m.user_id} checked={value.people.includes(m.user_id)} onToggle={() => toggle(m.user_id)}>
                <span className="truncate" data-testid={`secret-person-${m.user_id}`}>
                  {m.name || m.email}
                </span>
              </CheckRow>
            ))}
          </div>
          {value.people.length === 0 ? (
            <span className="text-xs text-danger-fg">{t('secret.settings.pickPeople')}</span>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <NumberField
          label={t('secret.settings.seconds')}
          hint={updates ? t('secretUpdates.settings.secondsHint') : t('secret.settings.secondsHint')}
          value={value.seconds}
          onChange={(v) => set({ seconds: v })}
          {...SECRET_LIMITS.revealSeconds}
          testId="secret-seconds"
          disabled={disabled}
        />
        <VerifyWindowField
          label={t('secret.settings.minutes')}
          hint={t('secret.settings.minutesHint')}
          value={value.minutes}
          onChange={(v) => set({ minutes: v })}
          testId="secret-minutes"
          disabled={disabled}
        />
      </div>
      {value.kind !== undefined ? (
        // what the secret holds — one line, several lines or a check box.
        <Field label={t('secret.settings.kind')} hint={kindLocked ? t('secret.settings.kindLocked') : undefined}>
          <Segmented
            label={t('secret.settings.kind')}
            value={value.kind === 'checkbox' ? 'checkbox' : value.multiline ? 'multiline' : 'text'}
            testId="secret-kind"
            onChange={(v) =>
              set(
                v === 'checkbox'
                  ? { kind: 'checkbox', multiline: false }
                  : { kind: 'text', multiline: v === 'multiline' },
              )
            }
            options={[
              {
                value: 'text',
                label: t('secret.settings.kind.text'),
                testId: 'secret-kind-text',
                disabled: disabled || kindLocked,
              },
              {
                value: 'multiline',
                label: t('secret.settings.kind.multiline'),
                testId: 'secret-multiline',
                disabled: disabled || kindLocked,
              },
              {
                value: 'checkbox',
                label: t('secret.settings.kind.checkbox'),
                testId: 'secret-kind-checkbox',
                disabled: disabled || kindLocked,
              },
            ]}
          />
        </Field>
      ) : null}
      {value.kind === 'checkbox' ? (
        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={!!value.checkboxVisible}
              onChange={(v) => set({ checkboxVisible: v })}
              testId="secret-checkbox-visible"
            />
            {t('secret.settings.checkboxVisible')}
          </label>
          <p className="text-xs text-muted">{t('secret.settings.checkboxVisibleHint')}</p>
        </div>
      ) : null}
      {value.kind !== 'checkbox' ? (
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={value.copy} onChange={(v) => set({ copy: v })} testId="secret-copy-allowed" />
          {t('secret.settings.copy')}
        </label>
      ) : null}
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={value.changeCode}
            onChange={(v) => set({ changeCode: v })}
            testId="secret-change-requires-code"
          />
          {updates
            ? t('secretUpdates.settings.changeCode')
            : value.kind === 'checkbox'
              ? t('secret.settings.changeCodeCheckbox')
              : t('secret.settings.changeCode')}
        </label>
        <p className="text-xs text-muted">
          {updates
            ? t('secretUpdates.settings.changeCodeHint')
            : value.kind === 'checkbox'
              ? t('secret.settings.changeCodeCheckboxHint')
              : t('secret.settings.changeCodeHint')}
        </p>
      </div>
      <NumberField
        label={t('secret.settings.alert')}
        hint={t('secret.settings.alertHint')}
        value={value.threshold}
        onChange={(v) => set({ threshold: v })}
        {...SECRET_LIMITS.alertThreshold}
        testId="secret-alert-threshold"
        disabled={disabled}
      />
    </fieldset>
  );
};

/**
 * Administration → אבטחה, the account's ceiling on how long a fresh code counts for secrets (columns
 * secret updates, a board's delete-with-code). A column or board may set less, never more.
 */
export const SecretPolicyPanel = ({
  saved,
  busy,
  onSave,
}: {
  saved: number;
  busy: boolean;
  onSave: (minutes: number) => void;
}) => {
  const [draft, setDraft] = useState(String(saved));
  const valid = within(draft, SECRET_LIMITS.verifyMinutes);
  const dirty = Number(draft) !== saved;
  return (
    <Panel title={t('secret.policy.title')} hint={t('secret.policy.hint')} testId="security-secret-policy">
      <form
        className="flex items-end gap-3 px-3.5 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && dirty) onSave(Number(draft));
        }}
      >
        <VerifyWindowField
          label={t('secret.policy.label')}
          value={draft}
          onChange={setDraft}
          testId="secret-policy-minutes"
        />
        <Button
          type="submit"
          variant="secondary"
          size="sm"
          disabled={busy || !valid || !dirty}
          data-testid="secret-policy-save"
        >
          {t('common.save')}
        </Button>
      </form>
    </Panel>
  );
};
