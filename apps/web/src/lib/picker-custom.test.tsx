// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Picker } from '@bines/ui';

/**
 * (OpenRouter models): the shared picker shows its options' groups as headings, and with `custom` a value
 * typed in its search that is no option can be chosen as is ("use …") — the AI connection's model picker.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});

const OPTIONS = [
  { value: 'openai/a', label: 'A', group: 'OpenAI', testId: 'opt' },
  { value: 'openai/b', label: 'B', group: 'OpenAI', testId: 'opt' },
  { value: 'anthropic/c', label: 'C', group: 'Anthropic', testId: 'opt' },
];

const render = (value: string, onChange: (v: string) => void, custom = true) =>
  act(() =>
    root.render(
      createElement(Picker<string>, {
        value,
        options: OPTIONS,
        onChange,
        label: 'Model',
        testId: 'picker',
        ...(custom ? { custom: { label: (q: string) => (q.includes(' ') ? null : `Use ${q}`), testId: 'typed' } } : {}),
      }),
    ),
  );

const open = () => act(() => document.querySelector<HTMLButtonElement>('[data-testid="picker"]')!.click());
const search = () => document.querySelector<HTMLInputElement>('[role="menu"] input')!;
const type = (text: string) =>
  act(() => {
    const input = search();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('Picker: groups and typed values', () => {
  it('shows each group once as a heading above its options', () => {
    render('', () => {});
    open();
    const text = document.querySelector('[role="menu"]')!.textContent ?? '';
    expect(text.indexOf('OpenAI')).toBeLessThan(text.indexOf('A'));
    expect(text.indexOf('Anthropic')).toBeGreaterThan(text.indexOf('B'));
    expect(text.match(/OpenAI/g)).toHaveLength(1);
  });

  it('offers a typed value that is no option, and chooses it as is', () => {
    const onChange = vi.fn();
    render('', onChange);
    open();
    // A custom picker always has its search field, however short the list.
    expect(search()).toBeTruthy();
    type('meta/llama-4');
    const row = document.querySelector<HTMLButtonElement>('[data-testid="typed"]');
    expect(row?.textContent).toContain('Use meta/llama-4');
    act(() => row!.click());
    expect(onChange).toHaveBeenCalledWith('meta/llama-4');
  });

  it('no typed row for an exact option, or when the label refuses the text', () => {
    render('', () => {});
    open();
    type('openai/a');
    expect(document.querySelector('[data-testid="typed"]')).toBeNull();
    type('two words');
    expect(document.querySelector('[data-testid="typed"]')).toBeNull();
  });

  it('shows a typed value the options do not have in the field', () => {
    render('meta/llama-4', () => {});
    expect(document.querySelector('[data-testid="picker"]')!.textContent).toContain('meta/llama-4');
  });
});
