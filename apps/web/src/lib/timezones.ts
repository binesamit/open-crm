// SPDX-License-Identifier: AGPL-3.0-only
/** Time zone lists for the profile and the account's region settings (A3). */

/** Every IANA zone the browser knows, the current one first if it is missing. */
export const timeZones = (current: string | null) => {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf('timeZone');
  } catch {
    all = [];
  }
  return !current || all.includes(current) ? all : [current, ...all];
};

/** "America/New_York" → "America/New York". */
export const zoneLabel = (zone: string) => zone.replace(/_/g, ' ');
