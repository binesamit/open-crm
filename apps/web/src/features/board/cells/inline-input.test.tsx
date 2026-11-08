// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineInput } from './index';

/**
 * Audit 2026-10-10 web #9: Enter commits and the input unmounts; Chrome then fires `blur` on the removed element.
 * One edit = one commit, whichever of the two comes second.
 */
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = (onCommit: (v: string) => void, onCancel = () => undefined) =>
  act(() => root.render(createElement(InlineInput, { initial: 'a', onCommit, onCancel })));

describe('InlineInput', () => {
  it('Enter then blur commits once', async () => {
    const onCommit = vi.fn();
    await mount(onCommit);
    const input = host.querySelector('input')!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('a');
  });

  it('blur alone commits once; Escape cancels and a late blur commits nothing', async () => {
    const onCommit = vi.fn();
    await mount(onCommit);
    act(() => {
      host.querySelector('input')!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onCommit).toHaveBeenCalledTimes(1);

    const second = vi.fn();
    const onCancel = vi.fn();
    await mount(second, onCancel);
    const input = host.querySelector('input')!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });
});
