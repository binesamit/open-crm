// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultPlatformSettings, t } from '@bines/shared';
import { PurgeConsoleDeletedSetting } from './PlatformSettings';

/**
 * owner console → Platform settings → account deletion — "also purge accounts deleted from the
 * console": a switch, off by default, with a hint that it erases data for good.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
const onChange = vi.fn();

const render = (on: boolean) =>
  act(() => {
    root!.render(createElement(PurgeConsoleDeletedSetting, { on, onChange }));
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

describe('PurgeConsoleDeletedSetting', () => {
  it('is off by default in the platform settings', () => {
    expect(defaultPlatformSettings().account_deletion.purge_console_deleted).toBe(false);
  });

  it('off: a switch (not a native checkbox look) with its label and hint; turns on', () => {
    render(false);
    const sw = $('owner-purge-console-deleted')!;
    expect(sw.getAttribute('role')).toBe('switch');
    expect(sw.checked).toBe(false);
    expect(host.textContent).toContain(t('owner.platform.purgeConsoleDeleted'));
    expect($('owner-purge-console-deleted-hint')!.textContent).toBe(t('owner.platform.purgeConsoleDeletedHint'));
    act(() => sw.click());
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('on: turns off', () => {
    render(true);
    expect($('owner-purge-console-deleted')!.checked).toBe(true);
    act(() => $('owner-purge-console-deleted')!.click());
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('has its texts in Hebrew and English', () => {
    for (const key of ['owner.platform.purgeConsoleDeleted', 'owner.platform.purgeConsoleDeletedHint'] as const) {
      expect(t(key, undefined, 'he')).not.toBe(key);
      expect(t(key, undefined, 'en')).not.toBe(t(key, undefined, 'he'));
    }
  });
});
