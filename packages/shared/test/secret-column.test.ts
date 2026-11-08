// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  ADMIN_ONLY_SCOPES,
  columnTypes,
  conversionSupport,
  deriveValues,
  EXTENSION_SCOPES,
  formQuestionAllowed,
  formVisibleOnly,
  ownWriter,
  parseCellValue,
  scopeAllows,
  SECRET_CHECKED,
  SECRET_UNCHECKED,
  secretMarkerOf,
  secretSettingsOf,
  secretSettingsSchema,
  secretValueFor,
  webhookEventsOf,
} from '../src';

/** Secret columns: the registry entry carries no value, only a "has a value" marker. */
const def = columnTypes.get('secret')!;
const marker = { set: true as const, updated_at: '2026-10-08T10:00:00.000Z', updated_by: 'U1' };

describe('secret column type', () => {
  it('defaults are settings, all of them in the UI', () => {
    expect(secretSettingsOf(undefined)).toEqual({
      reveal_mode: 'board_members',
      reveal_user_ids: [],
      reveal_seconds: 30,
      verify_minutes: 15,
      copy_allowed: true,
      change_requires_code: true,
      multiline: false,
      kind: 'text',
      checkbox_visible: false,
      alert_threshold: 10,
    });
    // one line unless the column asks for long text.
    expect(secretSettingsOf({ multiline: true }).multiline).toBe(true);
    // Columns made before the setting existed get it on (replace / clear asks for a fresh code).
    expect(secretSettingsOf({ copy_allowed: false }).change_requires_code).toBe(true);
    expect(secretSettingsOf({ change_requires_code: false }).change_requires_code).toBe(false);
    expect(secretSettingsSchema.safeParse({ reveal_seconds: 2 }).success).toBe(false);
    // a fresh code may count up to 12 hours (the account may lower it).
    expect(secretSettingsSchema.safeParse({ verify_minutes: 720 }).success).toBe(true);
    expect(secretSettingsSchema.safeParse({ verify_minutes: 721 }).success).toBe(false);
    expect(secretSettingsSchema.safeParse({ alert_threshold: 0 }).success).toBe(true);
  });

  it('the cell is a marker: no text, no formula value, no copy by duplicate / PUT /cells', () => {
    expect(def.engine).toBe('secret');
    expect(ownWriter(def)).toBe(true);
    const d = deriveValues(def, def.defaultSettings, marker);
    expect(d.textValue).toBeNull();
    expect(d.numberValue).toBe(1);
    expect(def.toFormula?.(marker, def.defaultSettings, {})).toBeNull();
    // A plain string is not a cell value of this type.
    expect(parseCellValue(def, {}, 'hunter2').ok).toBe(false);
  });

  it('conversions, extensions and webhooks leave it out; a form asks for it', () => {
    expect(formQuestionAllowed('secret')).toBe(true);
    expect(formVisibleOnly('secret')).toBe(true);
    expect(conversionSupport('secret', 'text').ok).toBe(false);
    expect(conversionSupport('text', 'secret').ok).toBe(false);
    expect((EXTENSION_SCOPES as string[]).includes('secrets:read')).toBe(false);
    expect(webhookEventsOf({ type: 'secret.changed', sub: false } as never)).toEqual([]);
  });

  it('secrets:read is never implied (admin neither) and only admins give it', () => {
    expect(scopeAllows(['admin'], 'secrets:read')).toBe(false);
    expect(scopeAllows(['boards:write', 'items:write'], 'secrets:read')).toBe(false);
    expect(scopeAllows(['secrets:read'], 'secrets:read')).toBe(true);
    expect(ADMIN_ONLY_SCOPES).toContain('secrets:read');
  });
});

describe('a check box secret', () => {
  const box = secretSettingsOf({ kind: 'checkbox' });
  const shown = secretSettingsOf({ kind: 'checkbox', checkbox_visible: true });

  it('stores "1" / "0" from the words people use, nothing else', () => {
    for (const w of ['1', 'true', 'כן', '✓', 'V', ' yes ']) expect(secretValueFor(box, w)).toBe(SECRET_CHECKED);
    for (const w of ['0', 'false', 'לא', 'no', 'off']) expect(secretValueFor(box, w)).toBe(SECRET_UNCHECKED);
    expect(secretValueFor(box, 'maybe')).toBeNull();
    // A text column keeps the value as typed.
    expect(secretValueFor(secretSettingsOf({}), ' hunter2 ')).toBe(' hunter2 ');
  });

  it('the marker says whether it is checked only when the column shows it', () => {
    const at = new Date('2026-10-27T10:00:00.000Z');
    expect(secretMarkerOf(box, SECRET_CHECKED, 'U1', at)).toEqual({
      set: true,
      updated_at: at.toISOString(),
      updated_by: 'U1',
    });
    expect(secretMarkerOf(shown, SECRET_CHECKED, 'U1', at).checked).toBe(true);
    expect(secretMarkerOf(shown, SECRET_UNCHECKED, 'U1', at).checked).toBe(false);
    expect(secretMarkerOf(secretSettingsOf({ checkbox_visible: true }), 'x', 'U1', at).checked).toBeUndefined();
  });
});
