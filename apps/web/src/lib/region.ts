// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';
import { getRegion, regionKey, resolveRegion, setRegion, subscribeRegion, type CalendarConfig } from '@bines/shared';
/*
 * The runtime region (A3): the account's region settings (Administration → כללי) with the signed-in member's own
 * timezone on top (their profile). Every date, time and number in the UI is written through the shared formatters
 * (`@bines/shared` locale/format), which read this region — like `t` reads the UI language. A change re-mounts the
 * UI (see `App` in main.tsx), so nothing keeps an old format.
 */
type AccountLocale = Parameters<typeof resolveRegion>[0];
type UserRegion = { locale?: string | null; timezone?: string | null } | null;

let account: AccountLocale = null;
let user: UserRegion = null;
let calendar: CalendarConfig | null = null;

const apply = () => setRegion(resolveRegion(account, user, calendar));

/** The signed-in member's profile (GET /auth/me, or right after the profile is saved). */
export const applyUserRegion = (u: UserRegion) => {
  user = u;
  apply();
};

/**
 * The current account's `settings.locale` and its resolved calendar (Hebrew dates, holidays, working
 * days — `AccountDetail.calendar`), on entering an account and after an admin changes either.
 */
export const applyAccountRegion = (locale: AccountLocale, accountCalendar?: CalendarConfig | null) => {
  account = locale;
  calendar = accountCalendar ?? null;
  apply();
};

const currentKey = () => regionKey(getRegion());
/** A key of the region (without the language) — the root re-mounts when it changes. */
export const useRegionKey = (): string => useSyncExternalStore(subscribeRegion, currentKey, currentKey);
