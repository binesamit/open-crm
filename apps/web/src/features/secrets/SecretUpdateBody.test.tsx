// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@bines/sdk';
import { t } from '@bines/shared';
import type * as ApiModule from '../../lib/api';

/**
 * a secret update in the thread is a locked card; Show asks for a fresh code when the server wants one
 * (the step-up dialog, never a browser prompt), then shows the text with a countdown; without 2FA it says how to turn
 * it on; Hide puts it away. These render the real card with the real step-up hook.
 */
const post = vi.fn();
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof ApiModule>()),
  api: () => ({ post, get: vi.fn() }),
}));
vi.mock('@tanstack/react-router', () => ({ Link: () => null }));

const { SecretUpdateBody } = await import('./SecretUpdateBody');
const { useSecretStepUp } = await import('./step-up');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REVEALED = {
  body_html: '<p>Wifi: S3cr3t</p>',
  body_text: 'Wifi: S3cr3t',
  body_json: null,
  reveal_seconds: 30,
  copy_allowed: true,
};
const stepUpError = () =>
  new ApiError(403, { code: 'secret_step_up_required', message: 'x', request_id: 'r' } as never);

const Harness = ({ onEdit }: { onEdit?: () => void }) => {
  const stepUp = useSecretStepUp({ id: 'acc', slug: 'acme' });
  return createElement(
    'div',
    null,
    createElement(SecretUpdateBody, { accountId: 'acc', updateId: 'u1', run: stepUp.run, onEdit }),
    stepUp.dialog,
  );
};

let root: Root | null = null;
beforeEach(() => {
  post.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});
const render = (onEdit?: () => void) => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
    root.render(createElement(Harness, { onEdit }));
  });
};
const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement | null) => {
  expect(el).not.toBeNull();
  await act(async () => el!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
};
const typeCode = async (value: string) => {
  const input = $('secret-stepup-input') as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('SecretUpdateBody', () => {
  it('locked until shown; a fresh code is asked for, then the text shows with a countdown; Hide locks it again', async () => {
    render();
    expect($('secret-update')?.dataset.state).toBe('locked');
    expect(document.body.textContent).toContain(t('secretUpdates.locked'));
    expect(document.body.textContent).not.toContain('S3cr3t');

    post.mockImplementation((path: string) =>
      path === '/secrets/verify'
        ? Promise.resolve({ two_factor_enabled: true, verified_at: 'now' })
        : post.mock.calls.filter((c) => c[0] === '/updates/u1/reveal').length === 1
          ? Promise.reject(stepUpError())
          : Promise.resolve(REVEALED),
    );
    await click($('secret-update-reveal'));
    expect($('secret-stepup-code')).not.toBeNull();
    await typeCode('123456');
    await click($('secret-stepup-submit'));
    expect(post).toHaveBeenCalledWith('/secrets/verify', { code: '123456' });
    expect($('secret-update')?.dataset.state).toBe('revealed');
    expect($('secret-update-text')?.textContent).toBe('Wifi: S3cr3t');
    expect($('secret-update-countdown')?.textContent).toBe(t('secretUpdates.hidesIn', { n: 30 }));
    expect($('secret-stepup-code')).toBeNull();

    await click($('secret-update-hide'));
    expect($('secret-update')?.dataset.state).toBe('locked');
    expect(document.body.textContent).not.toContain('S3cr3t');
  });

  it('cancelling the code leaves it locked; without 2FA the dialog says how to turn it on', async () => {
    render();
    post.mockRejectedValue(stepUpError());
    await click($('secret-update-reveal'));
    await click($('secret-stepup-cancel'));
    expect($('secret-update')?.dataset.state).toBe('locked');
    expect(post).toHaveBeenCalledTimes(1);

    post.mockRejectedValue(
      new ApiError(403, { code: 'secret_two_factor_required', message: 'x', request_id: 'r' } as never),
    );
    await click($('secret-update-reveal'));
    expect($('secret-stepup-no2fa')?.textContent).toContain(t('secretUpdates.no2fa.hint'));
  });

  it('its author edits from the revealed card (the text goes to the editor and leaves the card)', async () => {
    const onEdit = vi.fn();
    render(onEdit);
    post.mockResolvedValue(REVEALED);
    await click($('secret-update-reveal'));
    await click($('secret-update-edit'));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ body_text: 'Wifi: S3cr3t' }));
    expect($('secret-update')?.dataset.state).toBe('locked');
  });
});
