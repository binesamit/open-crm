// SPDX-License-Identifier: AGPL-3.0-only
import { t } from './i18n';
import { rangeDays } from './calendar';
import { formatDateTime, formatDayMonth, formatTime, getRegion, localDateOf, type Region } from './locale/format';

/**
 * "20 min ago" style times (N17, M7.6) for updates, the inbox, activity, trash and archive. Recent times are
 * relative; yesterday is "yesterday • 16:42"; within two weeks "3 days ago" / "a week ago"; older is a short
 * date. Days are counted in the region's timezone and the time follows its 12h/24h setting (A3). `now` is a
 * parameter so React renders stay pure (pass it from state). The exact time goes in a `title`.
 */
export const relativeTime = (iso: string, now: number, r: Region = getRegion()): string => {
  const at = new Date(iso);
  const locale = r.language;
  const min = Math.floor((now - at.getTime()) / 60_000);
  if (min < 1) return t('ago.now', undefined, locale);
  if (min < 60) return t('ago.minutes', { n: min }, locale);
  const days = rangeDays(localDateOf(at, r), localDateOf(now, r)) - 1;
  if (days <= 0) {
    const h = Math.floor(min / 60);
    return h === 1 ? t('ago.hour', undefined, locale) : t('ago.hours', { n: h }, locale);
  }
  if (days === 1) return t('ago.yesterday', { time: formatTime(at, r) }, locale);
  if (days === 2) return t('ago.two_days', undefined, locale);
  if (days < 7) return t('ago.days', { n: days }, locale);
  if (days < 14) return t('ago.week', undefined, locale);
  const sameYear = localDateOf(at, r).slice(0, 4) === localDateOf(now, r).slice(0, 4);
  return formatDayMonth(at, { year: !sameYear }, r);
};

/** The full date and time, for the `title` of a relative time — in the region's date and time format. */
export const exactTime = (iso: string, r: Region = getRegion()): string => formatDateTime(iso, {}, r);
