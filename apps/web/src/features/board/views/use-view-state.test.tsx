// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { viewSettingsSchema, type View } from '@bines/shared';
import { useViewState, type ViewState } from './use-view-state';
import type { ViewMutations } from './views-api';

/**
 * Prod "hide all from the hide-columns button doesn't work": the hide panel's "hide all" / "show all" set
 * the board's hidden columns and then the subitems' hidden columns — two `update`s in one click. Each one started from
 * the draft on screen, so the second dropped the first. These drive the real hook the way the panel does.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view = (settings: Record<string, unknown> = {}): View =>
  ({
    id: 'V1',
    board_id: 'B1',
    type: 'table',
    name: 'Main',
    revision: 1,
    settings: viewSettingsSchema.parse(settings),
    prefs: {},
  }) as unknown as View;
const mutations = {
  prefs: { mutate: () => {} },
  patchPrefs: () => {},
  prefsOnLeave: () => {},
} as unknown as ViewMutations;

let root: Root | null = null;
let state: ViewState;
const Probe = ({ v, out }: { v: View; out: (s: ViewState) => void }) => {
  const s = useViewState('B1', v, mutations);
  useEffect(() => {
    out(s);
  });
  return null;
};
const mount = (v: View) => {
  const host = document.createElement('div');
  root = createRoot(host);
  act(() =>
    root!.render(
      createElement(Probe, {
        v,
        out: (s) => {
          state = s;
        },
      }),
    ),
  );
};

const MAIN = ['status', 'owner', 'date'];
const SUB = ['s_status', 's_date'];
/** What the hide panel does on "hide all" / "show all": both lists in the same click. */
const hideAll = () =>
  act(() => {
    state.update((s) => ({ ...s, hidden_columns: MAIN }));
    state.update((s) => ({ ...s, subitems_hidden_columns: SUB }));
  });
const showAll = () =>
  act(() => {
    state.update((s) => ({ ...s, hidden_columns: [] }));
    state.update((s) => ({ ...s, subitems_hidden_columns: [] }));
  });

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe('hide panel — hide all / show all (useViewState.update)', () => {
  it('"hide all" hides the board columns and the subitem columns together, as an unsaved change', () => {
    mount(view());
    hideAll();
    expect(state.effective.hidden_columns).toEqual(MAIN);
    expect(state.effective.subitems_hidden_columns).toEqual(SUB);
    expect(state.dirty).toBe(true);
    expect(state.changes.sort()).toEqual(['hidden_columns', 'subitems_hidden_columns']);
  });

  it('"show all" reverses it — back to the saved view, no unsaved dot', () => {
    mount(view());
    hideAll();
    showAll();
    expect(state.effective.hidden_columns).toEqual([]);
    expect(state.effective.subitems_hidden_columns).toEqual([]);
    expect(state.dirty).toBe(false);
  });

  it('"show all" on a saved view that hides columns shows both lists (a draft over the saved view)', () => {
    mount(view({ hidden_columns: ['owner'], subitems_hidden_columns: ['s_date'] }));
    showAll();
    expect(state.effective.hidden_columns).toEqual([]);
    expect(state.effective.subitems_hidden_columns).toEqual([]);
    expect(state.changes.sort()).toEqual(['hidden_columns', 'subitems_hidden_columns']);
  });

  it('sequential updates compose on top of an existing draft too', () => {
    mount(view());
    act(() => state.update((s) => ({ ...s, hidden_columns: ['owner'] })));
    act(() => {
      state.update((s) => ({ ...s, hidden_columns: [...s.hidden_columns, 'date'] }));
      state.update((s) => ({ ...s, hidden_columns: [...s.hidden_columns, 'status'] }));
    });
    expect(state.effective.hidden_columns).toEqual(['owner', 'date', 'status']);
  });

  it('resetting the draft is seen by the next update', () => {
    mount(view());
    hideAll();
    act(() => {
      state.reset();
      state.update((s) => ({ ...s, hidden_columns: ['date'] }));
    });
    expect(state.effective.hidden_columns).toEqual(['date']);
    expect(state.effective.subitems_hidden_columns).toEqual([]);
  });
});
