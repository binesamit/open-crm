// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button } from '@bines/ui';

/**
 * `Button` (@bines/ui) defaults to type="button". Inside a <form> a type-less button is a submit button, and Enter in a
 * field "clicks" the form's FIRST submit button — in the secret panel that was Cancel / Clear.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});
const render = (el: ReturnType<typeof createElement>) => {
  act(() => {
    root = createRoot(host);
    root.render(el);
  });
};
const $ = (testId: string) => host.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/** The browser's implicit submission (as in SecretCell.test.tsx): Enter clicks the form's first submit button. */
const pressEnter = async (input: HTMLInputElement) => {
  const form = input.form;
  let byDefault: HTMLButtonElement | undefined;
  let click: MouseEvent | null = null;
  await act(async () => {
    const key = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(key);
    if (key.defaultPrevented || !form) return;
    byDefault = [...form.querySelectorAll('button')].find((el) => el.type === 'submit');
    if (!byDefault || byDefault.disabled) return;
    // The click's listeners only (Element's dispatch, without happy-dom's own button activation)…
    click = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.getPrototypeOf(HTMLButtonElement.prototype).dispatchEvent.call(byDefault, click);
  });
  if (!form || byDefault?.disabled) return;
  await act(async () => {
    // …then the activation: submit, unless the click cancelled it or took the form out of the page.
    if ((click as MouseEvent | null)?.defaultPrevented || !form.isConnected) return;
    if (byDefault && !byDefault.isConnected) return;
    form.requestSubmit(byDefault);
  });
};

describe('Button type', () => {
  it('defaults to type="button"; an explicit type wins', () => {
    render(
      createElement(
        'div',
        null,
        createElement(Button, { 'data-testid': 'plain' } as never, 'a'),
        createElement(Button, { type: 'submit', 'data-testid': 'submit' } as never, 'b'),
        createElement(Button, { type: 'reset', 'data-testid': 'reset' } as never, 'c'),
      ),
    );
    expect(($('plain') as HTMLButtonElement).type).toBe('button');
    expect($('plain')?.getAttribute('type')).toBe('button');
    expect(($('submit') as HTMLButtonElement).type).toBe('submit');
    expect(($('reset') as HTMLButtonElement).type).toBe('reset');
  });

  it('Enter in a field submits through the Submit button — never through Cancel before it', async () => {
    const cancel = vi.fn();
    const submit = vi.fn((e: { preventDefault: () => void; nativeEvent: Event }) => {
      e.preventDefault();
      return (e.nativeEvent as SubmitEvent).submitter?.getAttribute('data-testid');
    });
    render(
      createElement(
        'form',
        { onSubmit: submit },
        createElement('input', { 'data-testid': 'field', defaultValue: 'x' }),
        createElement(Button, { onClick: cancel, 'data-testid': 'cancel' } as never, 'Cancel'),
        createElement(Button, { type: 'submit', 'data-testid': 'save' } as never, 'Save'),
      ),
    );
    await pressEnter($('field') as HTMLInputElement);
    expect(cancel).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.results[0]?.value).toBe('save');
  });
});
