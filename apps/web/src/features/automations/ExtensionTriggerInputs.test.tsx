// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionTriggerBlock } from '@bines/shared';
import { ExtensionTriggerInputs } from './ExtensionBlockFields';
import { extensionTriggerDraft } from '../extensions/ExtensionAutomationBuilder';

/**
 * an extension trigger's own fields in the builder (e.g. which button the automation listens to)
 * prefilled and locked when its page opened the builder (`openAutomationBuilder({ config: { inputs } })`).
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const block: ExtensionTriggerBlock = {
  block: 'meta.conversation_button',
  extension_name: 'Meta',
  icon: null,
  name: 'כפתור',
  name_en: null,
  description: null,
  payload_fields: [],
  inputs: [
    { key: 'button', label: 'כפתור', label_en: null, type: 'text', placeholder: null },
    { key: 'note', label: 'הערה', label_en: null, type: 'text', placeholder: null },
  ],
};

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const field = (key: string) => host.querySelector<HTMLInputElement>(`[data-testid="auto-ext-trigger-input-${key}"]`)!;

describe('extension trigger inputs', () => {
  it('the page’s prefilled values go into the draft', () => {
    expect(extensionTriggerDraft('meta.conversation_button', { inputs: { button: 'b-7' } }).trigger).toEqual({
      type: 'extension_trigger',
      block: 'meta.conversation_button',
      with_item: false,
      inputs: { button: 'b-7' },
    });
    // None given: no inputs stored (the automation hears every fire, as before).
    expect(extensionTriggerDraft('meta.conversation_button').trigger).not.toHaveProperty('inputs');
  });

  it('shows the fields; a locked one is read-only; typing in another sets it, clearing removes it', () => {
    const onChange = vi.fn();
    act(() =>
      root.render(
        createElement(ExtensionTriggerInputs, {
          block,
          value: { button: 'b-7' },
          locked: ['button'],
          issues: [],
          onChange,
        }),
      ),
    );
    expect(field('button').value).toBe('b-7');
    expect(field('button').readOnly).toBe(true);
    expect(field('note').readOnly).toBe(false);
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setValue.call(field('note'), 'x');
      field('note').dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith({ button: 'b-7', note: 'x' });
  });

  it('a trigger without inputs shows nothing', () => {
    act(() =>
      root.render(
        createElement(ExtensionTriggerInputs, {
          block: { ...block, inputs: [] },
          value: {},
          issues: [],
          onChange: () => undefined,
        }),
      ),
    );
    expect(host.querySelector('[data-testid="auto-ext-trigger-inputs"]')).toBeNull();
  });
});
