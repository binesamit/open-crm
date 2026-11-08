// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@bines/shared';
import { ConsoleTwoFactorSetting } from './PlatformSecurityCard';

/**
 * Prod / S-77: owner console → Platform settings → Security — "two-factor sign-in for the owner console"
 * off by default and "recommended"; it cannot be switched on by someone without 2FA (says why); saves on change.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
const onChange = vi.fn();

const render = (on: boolean, myTwoFactor: boolean, busy = false) =>
  act(() => {
    root!.render(createElement(ConsoleTwoFactorSetting, { on, myTwoFactor, busy, onChange }));
  });
const $ = (id: string) => host.querySelector<HTMLInputElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  onChange.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('ConsoleTwoFactorSetting', () => {
  it('off: recommended; with my 2FA on it turns on', () => {
    render(false, true);
    expect($('owner-console-2fa')!.checked).toBe(false);
    expect($('owner-console-2fa-recommended')).not.toBeNull();
    expect($('owner-console-2fa-needs-yours')).toBeNull();
    act(() => $('owner-console-2fa')!.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('cannot be turned on without my own 2FA, and says so', () => {
    render(false, false);
    expect($('owner-console-2fa')!.disabled).toBe(true);
    expect($('owner-console-2fa-needs-yours')).not.toBeNull();
  });

  it('on: no "recommended" chip; it can be turned off', () => {
    render(true, true);
    expect($('owner-console-2fa')!.checked).toBe(true);
    expect($('owner-console-2fa-recommended')).toBeNull();
    act(() => $('owner-console-2fa')!.click());
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('is disabled while saving', () => {
    render(false, true, true);
    expect($('owner-console-2fa')!.disabled).toBe(true);
  });

  it('has its texts in Hebrew and English', () => {
    for (const key of [
      'owner.security.title',
      'owner.security.recommended',
      'owner.security.hint',
      'owner.security.consoleTwoFactor',
      'owner.security.needsYours',
      'sec2.console.title',
      'sec2.console.subtitle',
      'error.console_two_factor_required',
      'error.console_two_factor_needs_yours',
    ] as const) {
      expect(t(key, undefined, 'he')).not.toBe(key);
      expect(t(key, undefined, 'en')).not.toBe(t(key, undefined, 'he'));
    }
  });
});
