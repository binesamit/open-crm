// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  canHideNavSlot,
  cleanAccountNav,
  cleanNavPlacement,
  NAV_PRESET_SIDE,
  NAV_SLOTS,
  type NavLayout,
  type NavPlace,
  type NavSlot,
  type NavLayoutResponse,
  type SetAccountNav,
  type SetMyNav,
} from '@bines/shared';
import { api } from './api';

/**
 * where the shell's places sit on the desktop (sidebar / top bar) — GET /me/nav per account. This
 * device keeps a copy of the layout in effect so the shell paints in the right shape before the server answers (no
 * jump from the sidebar to the top bar on every load).
 */
const key = (accountId: string) => `bines:nav:${accountId}`;

export const navKey = (accountId: string) => ['account', accountId, 'nav'] as const;

const readCached = (accountId: string): NavLayoutResponse | undefined => {
  try {
    const raw = JSON.parse(localStorage.getItem(key(accountId)) ?? 'null') as Partial<NavLayoutResponse> | null;
    if (!raw?.layout) return undefined;
    const layout: NavLayout = Object.fromEntries(
      NAV_SLOTS.map((s) => {
        const p = raw.layout?.[s];
        return [s, p === 'top' || (p === 'hidden' && canHideNavSlot(s)) ? p : 'side'];
      }),
    ) as Record<NavSlot, NavPlace>;
    // The extensions' pages keep their places in the first paint too.
    const apps = cleanNavPlacement({ apps: raw.layout.apps }).apps;
    if (apps) layout.apps = apps;
    return {
      layout,
      mine: raw.mine ? cleanNavPlacement(raw.mine) : null,
      account: cleanAccountNav(raw.account),
    };
  } catch {
    return undefined;
  }
};

const writeCached = (accountId: string, r: NavLayoutResponse) => {
  try {
    if (NAV_SLOTS.every((s) => r.layout[s] === 'side') && !r.mine && !r.account.locked)
      localStorage.removeItem(key(accountId));
    else localStorage.setItem(key(accountId), JSON.stringify(r));
  } catch {
    // Private mode / blocked storage: the server copy is the source anyway.
  }
};

const fallback: NavLayoutResponse = { layout: NAV_PRESET_SIDE, mine: null, account: { placement: {}, locked: false } };

/** The layout in effect for me in this account, my own placement and the account's default. */
export const useNavLayout = (accountId: string) => {
  const q = useQuery({
    queryKey: navKey(accountId),
    queryFn: async () => {
      const r = await api(accountId).get<NavLayoutResponse>('/me/nav');
      writeCached(accountId, r);
      return r;
    },
    initialData: () => readCached(accountId),
    // The cached copy is only a first paint: always ask the server once.
    initialDataUpdatedAt: 0,
    staleTime: 5 * 60_000,
  });
  return { ...(q.data ?? fallback), loaded: q.isFetched };
};

/** PUT /me/nav — my own placement, or null = follow the account. */
export const useSetMyNav = (accountId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetMyNav) => api(accountId).put<NavLayoutResponse>('/me/nav', body),
    onSuccess: (r) => {
      writeCached(accountId, r);
      qc.setQueryData(navKey(accountId), r);
    },
  });
};

/** PUT /accounts/me/nav (admins) — the account's default and lock. */
export const useSetAccountNav = (accountId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetAccountNav) => api(accountId).put<NavLayoutResponse>('/accounts/me/nav', body),
    onSuccess: (r) => {
      writeCached(accountId, r);
      qc.setQueryData(navKey(accountId), r);
    },
  });
};
