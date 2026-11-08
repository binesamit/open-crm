// SPDX-License-Identifier: AGPL-3.0-only
import type { HelpCategory, HelpHit, HelpLocale, MyAccount } from '@bines/shared';
import { isIconName, type IconName } from '../../lib/icons';
import { useHelpOptions } from './help-api';
import { useTicketOptions } from './support-api';

/**
 * The in-app knowledge center page (`/a/<slug>/help`): the pure parts (the URL's search, category
 * names, icons and counts, "see also") and who may see it — shared by the page, the "?" menu and the navigation.
 */

/** `?article=<slug or id>` opens one article, `?category=<id>` a category's list (the article wins). */
export type KbSearch = { article?: string; category?: string };

export const parseKbSearch = (s: Record<string, unknown>): KbSearch => {
  const pick = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : undefined);
  const article = pick(s.article);
  const category = pick(s.category);
  return { ...(article ? { article } : {}), ...(category ? { category } : {}) };
};

/** A category's name in the reader's language (the English name when there is one). */
export const categoryLabel = (c: Pick<HelpCategory, 'name' | 'name_en'>, locale: HelpLocale | undefined) =>
  locale === 'en' && c.name_en ? c.name_en : c.name;

/**
 * A category's icon as the console's writer typed it: one of the app's icons by name, else the text itself (an
 * emoji or a letter, at most two characters), else none (the page shows its default).
 */
export const categoryIcon = (
  icon: string | null | undefined,
): { kind: 'icon'; name: IconName } | { kind: 'text'; text: string } | null => {
  const v = icon?.trim();
  if (!v) return null;
  if (isIconName(v)) return { kind: 'icon', name: v };
  const chars = Array.from(v);
  return chars.length <= 2 ? { kind: 'text', text: v } : null;
};

/** The categories worth a card: not archived and holding at least one article this person may read. */
export const visibleCategories = (categories: HelpCategory[], counts: Record<string, number> | undefined) =>
  categories.filter((c) => !c.archived && (counts?.[c.id] ?? 0) > 0);

/** "See also": the category's other articles (never the one being read, by id or slug), at most `limit`. */
export const relatedOf = (hits: HelpHit[], current: { id?: string; slug?: string }, limit = 5) =>
  hits.filter((h) => h.id !== current.id && h.slug !== current.slug).slice(0, limit);

/** Guests and accounts opened by a support grant have no help (the server refuses them too). */
export const helpHiddenFor = (account: Pick<MyAccount, 'role' | 'support'>) =>
  account.role === 'guest' || !!account.support;

/**
 * What this person may use: the knowledge center (`helpOn`, the platform's setting) and opening a ticket
 * (`mayOpen`, the account's and the platform's). `none` = neither is offered (the "?" button is not shown).
 */
export const useHelpAccess = (account: MyAccount) => {
  const hidden = helpHiddenFor(account);
  const tickets = useTicketOptions(account.id, !hidden);
  const help = useHelpOptions(account.id, !hidden);
  const helpOn = !!help.data?.enabled;
  return {
    hidden,
    help,
    tickets,
    helpOn,
    mayOpen: tickets.data?.may_open ?? false,
    none: hidden || (!!tickets.data && !tickets.data.enabled && !helpOn),
  };
};
