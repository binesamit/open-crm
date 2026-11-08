// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptchaKeys } from './CaptchaControls';

/**
 * The Turnstile keys: the site key saves on Enter / blur, the secret with its button. The saved site key comes back
 * from the server while the person may already be typing the secret — that secret stays (the fields used to remount
 * on every save and wiped it, so "save" stayed disabled).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
const onSiteKey = vi.fn();
const onSecret = vi.fn();

const render = (siteKey: string, secretSet = false) =>
  act(() => {
    root!.render(createElement(CaptchaKeys, { siteKey, secretSet, onSiteKey, onSecret, busy: false, testId: 'k' }));
  });
const el = <T extends HTMLElement>(id: string) => host.querySelector<T>(`[data-testid="${id}"]`)!;
const type = (input: HTMLInputElement, value: string) =>
  act(() => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

beforeEach(() => {
  onSiteKey.mockReset();
  onSecret.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});

describe('CaptchaKeys', () => {
  it('keeps a secret typed while the site key was saving, and shows the saved site key', () => {
    render('');
    type(el<HTMLInputElement>('k-site'), 'site-1');
    type(el<HTMLInputElement>('k-secret'), 'secret-1');
    // The site key's save returns.
    render('site-1');
    expect(el<HTMLInputElement>('k-site').value).toBe('site-1');
    expect(el<HTMLInputElement>('k-secret').value).toBe('secret-1');
    expect(el<HTMLButtonElement>('k-secret-save').disabled).toBe(false);
    act(() => el<HTMLButtonElement>('k-secret-save').click());
    expect(onSecret).toHaveBeenCalledWith('secret-1');
    expect(el<HTMLInputElement>('k-secret').value).toBe('');
  });

  it('a site key changed elsewhere replaces the field', () => {
    render('old');
    render('new');
    expect(el<HTMLInputElement>('k-site').value).toBe('new');
  });
});
