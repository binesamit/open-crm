// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '@bines/shared';
import { GuestsSection } from './AdminGuests';

/** the account switch "guests may change board structure" — off by default, saves on change. */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;
const onChange = vi.fn();

const render = (editStructure: boolean, busy = false) =>
  act(() => {
    root!.render(createElement(GuestsSection, { editStructure, busy, onChange }));
  });
const toggle = () => host.querySelector<HTMLInputElement>('[data-testid="admin-guests-edit-structure"]')!;

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

describe('GuestsSection', () => {
  it('shows the saved value and reports a change', () => {
    render(false);
    expect(toggle().checked).toBe(false);
    act(() => toggle().click());
    expect(onChange).toHaveBeenCalledWith(true);
    render(true);
    expect(toggle().checked).toBe(true);
  });

  it('is disabled while saving', () => {
    render(false, true);
    expect(toggle().disabled).toBe(true);
  });

  it('has its texts in Hebrew and English', () => {
    for (const key of ['admin.guests.title', 'admin.guests.editStructure', 'admin.guests.editStructureHint'] as const) {
      expect(t(key, undefined, 'he')).not.toBe(key);
      expect(t(key, undefined, 'en')).not.toBe(t(key, undefined, 'he'));
    }
  });
});
