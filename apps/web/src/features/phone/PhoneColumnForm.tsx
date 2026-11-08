// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState, type ReactNode } from 'react';
import {
  COUNTRY_CODES,
  countryName,
  flagEmoji,
  getRegion,
  PHONE_ACTIONS,
  phoneColumnConfig,
  t,
  type PhoneAction,
} from '@bines/shared';
import { Button, cn, Field, Picker, Switch } from '@bines/ui';
import type { BoardDetail, Column } from '../board/board-api';
import { buildPhoneSettings, moveAction, telegramColumnCandidates } from './phone-logic';

const NONE = '__none__';

/**
 * Settings of a phone column (03 §2.11): the on/off switch of the click actions, which actions the
 * menu shows and in what order, the default action (long press / Ctrl+click), the country of numbers typed without
 * a code, and the text column holding the person's Telegram username. Everything per column, nothing hard-coded.
 */
export const PhoneColumnForm = ({
  board,
  column,
  busy,
  onSave,
  shell,
}: {
  board: BoardDetail;
  column: Column;
  busy: boolean;
  onSave: (settings: Record<string, unknown>) => Promise<unknown>;
  shell: (body: ReactNode, save: ReactNode) => ReactNode;
}) => {
  const cfg = phoneColumnConfig(column.settings);
  const [enabled, setEnabled] = useState(cfg.enabled);
  // Chosen actions first (in their order), then the rest — unchecked ones keep a place to be turned back on.
  const [order, setOrder] = useState<PhoneAction[]>(() => [
    ...cfg.actions,
    ...PHONE_ACTIONS.filter((a) => !cfg.actions.includes(a)),
  ]);
  const [on, setOn] = useState<Set<PhoneAction>>(() => new Set(cfg.actions));
  const [defaultAction, setDefaultAction] = useState<PhoneAction>(cfg.defaultAction);
  const [country, setCountry] = useState<string>(cfg.defaultCountry ?? NONE);
  const [telegram, setTelegram] = useState<string>(cfg.telegramUsernameColumn ?? NONE);
  const actions = order.filter((a) => on.has(a));
  const lang = getRegion().language;
  const countries = useMemo(
    () =>
      [...COUNTRY_CODES]
        .map((c) => ({ value: c, label: `${flagEmoji(c)} ${countryName(c, lang)}`, keywords: c }))
        .sort((a, b) => a.label.localeCompare(b.label, lang)),
    [lang],
  );
  const textColumns = telegramColumnCandidates(board.columns.filter((c) => c.id !== column.id));
  const toggle = (a: PhoneAction, value: boolean) =>
    setOn((prev) => {
      const next = new Set(prev);
      if (value) next.add(a);
      else if (next.size > 1) next.delete(a); // at least one action stays
      return next;
    });
  const shownDefault = actions.includes(defaultAction) ? defaultAction : actions[0]!;

  return shell(
    <div className="flex flex-col gap-3.5" data-testid="phone-settings">
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="min-w-0">
          <span className="block font-semibold text-fg">{t('phone.settings.enabled')}</span>
          <span className="block text-xs text-muted">{t('phone.settings.enabledHint')}</span>
        </span>
        <Switch checked={enabled} onChange={setEnabled} testId="phone-settings-enabled" />
      </label>
      <div
        className={cn('flex flex-col gap-3.5', !enabled && 'pointer-events-none opacity-50')}
        aria-disabled={!enabled}
      >
        <Field label={t('phone.settings.actions')} hint={t('phone.settings.actionsHint')}>
          <ul className="flex flex-col rounded-[10px] border border-line" data-testid="phone-settings-actions">
            {order.map((a, i) => (
              <li
                key={a}
                className="flex items-center gap-2 border-b border-line-soft px-2.5 py-1.5 last:border-b-0"
                data-action={a}
              >
                <Switch
                  checked={on.has(a)}
                  onChange={(v) => toggle(a, v)}
                  label={t(`phone.action.${a}`)}
                  testId={`phone-settings-action-${a}`}
                  disabled={!enabled}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{t(`phone.action.${a}`)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!enabled || i === 0}
                  aria-label={t('phone.settings.up')}
                  data-testid={`phone-settings-up-${a}`}
                  onClick={() => setOrder((o) => moveAction(o, a, -1))}
                >
                  ↑
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!enabled || i === order.length - 1}
                  aria-label={t('phone.settings.down')}
                  data-testid={`phone-settings-down-${a}`}
                  onClick={() => setOrder((o) => moveAction(o, a, 1))}
                >
                  ↓
                </Button>
              </li>
            ))}
          </ul>
        </Field>
        <Field label={t('phone.settings.defaultAction')} hint={t('phone.settings.defaultActionHint')}>
          <Picker
            value={shownDefault}
            label={t('phone.settings.defaultAction')}
            testId="phone-settings-default"
            onChange={setDefaultAction}
            options={actions.map((a) => ({
              value: a,
              label: t(`phone.action.${a}`),
              testId: `phone-settings-default-${a}`,
            }))}
          />
        </Field>
        <Field label={t('phone.settings.telegramColumn')} hint={t('phone.settings.telegramColumnHint')}>
          <Picker
            value={telegram}
            label={t('phone.settings.telegramColumn')}
            testId="phone-settings-telegram"
            onChange={setTelegram}
            options={[
              { value: NONE, label: t('phone.settings.none'), testId: 'phone-settings-telegram-none' },
              ...textColumns.map((c) => ({ value: c.id, label: c.title, testId: `phone-settings-telegram-${c.id}` })),
            ]}
          />
        </Field>
      </div>
      <Field label={t('phone.settings.country')} hint={t('phone.settings.countryHint')}>
        <Picker
          value={country}
          label={t('phone.settings.country')}
          testId="phone-settings-country"
          searchable
          onChange={setCountry}
          options={[{ value: NONE, label: t('phone.settings.countryAccount') }, ...countries]}
        />
      </Field>
    </div>,
    <Button
      busy={busy}
      data-testid="column-settings-save"
      onClick={() =>
        void onSave(
          buildPhoneSettings(column.settings, {
            enabled,
            actions,
            defaultAction: shownDefault,
            defaultCountry: country === NONE ? null : country,
            telegramColumn: telegram === NONE ? null : telegram,
          }),
        )
      }
    >
      {t('common.save')}
    </Button>,
  );
};
