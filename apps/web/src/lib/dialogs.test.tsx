// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { choiceDialog, DialogHost } from './dialogs';

/** The choice confirmation (deleting a folder with boards): the first option is the default. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
beforeEach(() => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  act(() => {
    root = createRoot(host);
    root.render(createElement(DialogHost));
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const $ = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const ask = () =>
  choiceDialog({
    title: 'Delete?',
    danger: true,
    options: [
      { value: 'root', label: 'To the root', testId: 'opt-root' },
      { value: 'trash', label: 'With it', testId: 'opt-trash' },
    ],
  });

describe('choiceDialog', () => {
  it('confirms the first option by default', async () => {
    let answer: Promise<string | null> = Promise.resolve(null);
    await act(async () => {
      answer = ask();
    });
    expect($('choice-dialog')).not.toBeNull();
    expect($('opt-root')!.querySelector('input')!.checked).toBe(true);
    await act(async () => $('choice-dialog-confirm')!.click());
    expect(await answer).toBe('root');
    expect($('choice-dialog')).toBeNull();
  });

  it('returns the option picked, or null when cancelled', async () => {
    let answer: Promise<string | null> = Promise.resolve(null);
    await act(async () => {
      answer = ask();
    });
    await act(async () => $('opt-trash')!.querySelector('input')!.click());
    await act(async () => $('choice-dialog-confirm')!.click());
    expect(await answer).toBe('trash');

    await act(async () => {
      answer = ask();
    });
    const cancel = [...document.querySelectorAll('button')].find((b) => b.textContent === 'ביטול')!;
    await act(async () => cancel.click());
    expect(await answer).toBeNull();
  });
});
