// SPDX-License-Identifier: AGPL-3.0-only
import {
  addDays,
  countryName,
  type DateEnv,
  formatDate,
  type GroupDateUnit,
  type IsoDate,
  type MessageKey,
  relativeBucketDate,
  type RelativeBucket,
  t,
  whenBucketDate,
  type WhenBucket,
} from '@bines/shared';

/**
 * Grouping by a date: a bucket's title and a day inside it. Keys come from the shared engine
 * `when` buckets (overdue, today …), the past in detail (last week …), or a period key: a day `2026-10-13`, a week
 * by its first day `2026-10-11`, a month `2026-10`, a quarter `2026-Q4`, a year `2026`.
 */
const lang = () => (typeof document !== 'undefined' && document.documentElement.lang) || 'he';

/** A "by country" bucket's title (a phone's or an address's country — ק2) in the reader's language. */
export const groupCountryName = (code: string) => countryName(code, lang());
const shortDay = (iso: IsoDate) => formatDate(iso, { year: 'never' });

export const dateGroupLabel = (key: string, unit: GroupDateUnit = 'when'): string => {
  switch (unit) {
    case 'when':
      return t(`dateBucket.${key}` as MessageKey);
    case 'day':
      return formatDate(key);
    case 'week':
      return `${shortDay(key)} – ${shortDay(addDays(key, 6))}`;
    case 'month':
      return new Intl.DateTimeFormat(lang(), { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${key}-01T00:00:00Z`),
      );
    case 'quarter':
      return t('group.quarter', { quarter: key.slice(6), year: key.slice(0, 4) });
    case 'year':
      return key;
  }
};

/** The first day of a period key (`2026-Q4` → 2026-10-01). */
const periodStart = (key: string, unit: Exclude<GroupDateUnit, 'when'>): IsoDate => {
  switch (unit) {
    case 'day':
    case 'week':
      return key;
    case 'month':
      return `${key}-01`;
    case 'quarter':
      return `${key.slice(0, 4)}-${String((Number(key.slice(6)) - 1) * 3 + 1).padStart(2, '0')}-01`;
    case 'year':
      return `${key}-01-01`;
  }
};

/**
 * The day a new item (or one dragged in) gets in a date bucket: inside a `when` bucket (null when it is empty right
 * now, e.g. "this week" on its last day), else the first day of the period.
 */
export const dateGroupDay = (
  key: string,
  env: DateEnv,
  g: { unit?: GroupDateUnit; pastDetail?: boolean } = {},
): IsoDate | null => {
  const unit = g.unit ?? 'when';
  if (unit !== 'when') return periodStart(key, unit);
  return g.pastDetail ? relativeBucketDate(key as RelativeBucket, env) : whenBucketDate(key as WhenBucket, env);
};
