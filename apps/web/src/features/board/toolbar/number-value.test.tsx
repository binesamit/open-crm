// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NumberValue } from './DateRuleValue';

/**
 * Audit 2026-10-10, web #2/#3: a rule's number input kept the text of the rule that used to sit in its place
 * (rules keyed by index, removal positional) — the input showed 5 while the filter said 10.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | null = null;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
});
const render = (value: unknown, onChange = vi.fn()) => {
  root ??= createRoot(host);
  act(() => root!.render(createElement(NumberValue, { value, onChange })));
  return host.querySelector('input')!;
};

describe('NumberValue', () => {
  it('follows the rule it shows when the value changes from outside, and keeps a draft that means the same', () => {
    const onChange = vi.fn();
    const input = render(5, onChange);
    expect(input.value).toBe('5');
    // The rule above was removed: this element now shows the rule with 10.
    render(10, onChange);
    expect(input.value).toBe('10');
    // Typing "10." still means 10: the draft stays as typed while the rule holds 10.
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '10.');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith(10);
    render(10, onChange);
    expect(input.value).toBe('10.');
    // Cleared from outside.
    render(null, onChange);
    expect(input.value).toBe('');
  });
});
