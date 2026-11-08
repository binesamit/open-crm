// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { changedSettings, viewSettingsSchema, type ViewPrefs, type ViewSettings } from '@bines/shared';
import type { View, ViewMutations } from './views-api';

/**
 * The three layers of view state (15-VIEWS §1): the saved view, my personal prefs, and an unsaved draft.
 * `effective = merge(view.settings, prefs, draft)`; the draft lives per view in sessionStorage (survives a
 * refresh, not another user or tab) and expires after 24 hours (15 §2). Personal keys (widths, collapsed
 * groups, wrap) never enter the draft — they save to prefs on their own (15 §9.5).
 */
const DAY = 24 * 60 * 60 * 1000;
const storageKey = (boardId: string, viewId: string) => `bos.draft.${boardId}.${viewId}`;

/** A draft remembers the view revision it started from: a newer one means someone else saved the view meanwhile. */
type Draft = { settings: ViewSettings; revision: number | null };

const readDraft = (boardId: string, viewId: string, now: number): Draft | null => {
  try {
    const raw = sessionStorage.getItem(storageKey(boardId, viewId));
    if (!raw) return null;
    const { at, settings, revision } = JSON.parse(raw) as { at: number; settings: unknown; revision?: number };
    if (now - at > DAY) return null;
    const parsed = viewSettingsSchema.safeParse(settings);
    return parsed.success ? { settings: parsed.data, revision: revision ?? null } : null;
  } catch {
    return null;
  }
};

const writeDraft = (boardId: string, viewId: string, draft: Draft | null) => {
  try {
    if (draft) sessionStorage.setItem(storageKey(boardId, viewId), JSON.stringify({ at: Date.now(), ...draft }));
    else sessionStorage.removeItem(storageKey(boardId, viewId));
  } catch {
    // storage unavailable (private mode): the draft just doesn't survive a refresh
  }
};

/**
 * Product decision (round 11): the board's search text belongs to the board, not to a view — it stays when switching between
 * the board's views (table, kanban, calendar…) for this tab's session, and only the X / Esc / clearing the field
 * empties it. It never enters a view's draft or saved settings (D20: views change only with "save").
 * `null` = not touched in this session (a view's own saved search, if any, applies).
 */
const searchKey = (boardId: string) => `bos.search.${boardId}`;
const readSearch = (boardId: string): string | null => {
  try {
    return sessionStorage.getItem(searchKey(boardId));
  } catch {
    return null;
  }
};
const writeSearch = (boardId: string, value: string) => {
  try {
    sessionStorage.setItem(searchKey(boardId), value);
  } catch {
    // storage unavailable: the search still stays across views in memory
  }
};

const withPrefs = (base: ViewSettings, prefs: ViewPrefs): ViewSettings => ({
  ...base,
  column_widths: { ...base.column_widths, ...prefs.column_widths },
  collapsed_groups: prefs.collapsed_groups ?? base.collapsed_groups,
  wrap_text: prefs.wrap_text ?? base.wrap_text,
});

export const useViewState = (boardId: string, view: View | undefined, mutations: ViewMutations) => {
  // Drafts touched in this tab; views not in the map read theirs from storage (null = no draft).
  const [drafts, setDrafts] = useState<Record<string, Draft | null>>({});
  const [openedAt] = useState(() => Date.now());
  const entry = view ? (view.id in drafts ? drafts[view.id]! : readDraft(boardId, view.id, openedAt)) : null;
  const draft = entry?.settings ?? null;

  /**
   * Prod ("hide all doesn't work"): the drafts as last written, ahead of the next render. Two `update`s in
   * one handler (the hide panel's "hide all" sets the board's and the subitems' hidden columns) each started from the
   * draft on screen, so the second dropped the first. `update` now starts from the latest written draft.
   */
  const latest = useRef<Record<string, Draft | null>>({});
  const putDraft = useCallback(
    (viewId: string, next: Draft | null) => {
      latest.current[viewId] = next;
      setDrafts((d) => ({ ...d, [viewId]: next }));
      writeDraft(boardId, viewId, next);
    },
    [boardId],
  );
  /** A new draft starts from the revision on screen; an edited one keeps its starting revision. */
  const setDraft = useCallback(
    (viewId: string, next: ViewSettings | null) =>
      putDraft(viewId, next && view ? { settings: next, revision: entry?.revision ?? view.revision } : null),
    [putDraft, view, entry],
  );

  /** Applies a change to the draft; a change back to the saved settings clears it. */
  const update = useCallback(
    (fn: (s: ViewSettings) => ViewSettings) => {
      if (!view) return;
      const current = view.id in latest.current ? (latest.current[view.id]?.settings ?? null) : draft;
      const next = fn(current ?? view.settings);
      setDraft(view.id, changedSettings(view.settings, next).length ? next : null);
    },
    [view, draft, setDraft],
  );

  // The board's search (above): per board, kept in memory and in this tab's sessionStorage.
  const [searches, setSearches] = useState<Record<string, string | null>>({});
  const search = boardId in searches ? searches[boardId]! : readSearch(boardId);
  const setSearch = useCallback(
    (value: string) => {
      const v = value.trim();
      setSearches((m) => ({ ...m, [boardId]: v }));
      writeSearch(boardId, v);
    },
    [boardId],
  );

  const changes = useMemo(() => (view && draft ? changedSettings(view.settings, draft) : []), [view, draft]);
  const effective = useMemo(() => {
    const base = view ? withPrefs(draft ?? view.settings, view.prefs) : viewSettingsSchema.parse({});
    return search === null ? base : { ...base, query: { ...base.query, search: search || undefined } };
  }, [view, draft, search]);

  // Personal prefs: applied to the cache at once, saved to the server after a short pause (or at once).
  const pending = useRef<{ viewId: string; prefs: ViewPrefs } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Owner fix 2: prefs sent but not yet answered. The server's answer replaces the view in the cache — a change made
   * while a save was on its way would flip back (a group opened again) — so newer changes go back on top of it.
   */
  const unconfirmed = useRef<{ viewId: string; prefs: ViewPrefs } | null>(null);
  const seq = useRef(0);
  // The latest mutations without making `flush` change on every render (its cleanup sends what is pending).
  const live = useRef(mutations);
  useEffect(() => {
    live.current = mutations;
  });
  const flush = useCallback(() => {
    const mutations = live.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const sent = pending.current;
    pending.current = null;
    if (!sent) return;
    const n = ++seq.current;
    unconfirmed.current = {
      viewId: sent.viewId,
      prefs: { ...(unconfirmed.current?.viewId === sent.viewId ? unconfirmed.current.prefs : {}), ...sent.prefs },
    };
    mutations.prefs.mutate(sent, {
      onSettled: () => {
        const newer = n !== seq.current;
        if (!newer) unconfirmed.current = null;
        const keep = {
          ...(newer && unconfirmed.current?.viewId === sent.viewId ? unconfirmed.current.prefs : {}),
          ...(pending.current?.viewId === sent.viewId ? pending.current.prefs : {}),
        };
        if (Object.keys(keep).length) live.current.patchPrefs(sent.viewId, keep);
      },
    });
  }, []);
  useEffect(() => flush, [flush]);
  // Leaving or reloading the page right after a change still sends it.
  useEffect(() => {
    // A normal request is cancelled when the page unloads — this one is sent with `keepalive`.
    const leave = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const sent = pending.current;
      pending.current = null;
      if (sent) live.current.prefsOnLeave(sent);
    };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, []);
  const setPrefs = useCallback(
    (prefs: ViewPrefs, opts?: { now?: boolean }) => {
      if (!view) return;
      mutations.patchPrefs(view.id, prefs);
      pending.current = {
        viewId: view.id,
        prefs: { ...(pending.current?.viewId === view.id ? pending.current.prefs : {}), ...prefs },
      };
      if (timer.current) clearTimeout(timer.current);
      if (opts?.now) flush();
      else timer.current = setTimeout(flush, 600);
    },
    [view, mutations, flush],
  );

  return {
    effective,
    /** Unsaved changes ("query.filter", "hidden_columns", …); empty = the view as saved. */
    changes,
    dirty: changes.length > 0,
    update,
    setPrefs,
    /** The board's search text ('' = cleared, null = untouched this session) — never part of the draft. */
    search,
    setSearch,
    /** `settings` without the board search: the search a view saves is the one in its own draft / saved settings. */
    withoutSearch: (settings: ViewSettings): ViewSettings =>
      search === null || !view
        ? settings
        : { ...settings, query: { ...settings.query, search: (draft ?? view.settings).query.search } },
    /** Drops the draft (15 §2 "reset"). */
    reset: () => view && setDraft(view.id, null),
    /** After a successful save the saved view is the truth again. */
    clear: (viewId: string) => setDraft(viewId, null),
    /** Starts a view from a shared link: the query from `?q=` as a draft over it (15 §2). */
    seed: (viewId: string, settings: ViewSettings) => setDraft(viewId, settings),
    draft,
    /** The view was saved by someone else after my draft started (M4: the live refetch shows it). */
    outdated: !!view && entry?.revision != null && entry.revision !== view.revision,
    /** Keep my draft over the newer saved view. */
    keepMine: () => view && entry && putDraft(view.id, { ...entry, revision: view.revision }),
  };
};

export type ViewState = ReturnType<typeof useViewState>;
