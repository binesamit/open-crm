// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** Interface languages a user may pick (the UI ships these). */
export const PROFILE_LOCALES = ['he', 'en'] as const;

const validTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/**
 * My profile (fix2): who I am to my colleagues. Name, birthday, language, time zone and photo are mine — the same
 * in every account; job title, department and phone are per account (Fix: a manager in one account, a
 * consultant in another) — those of the account the request is in (`account`).
 */
export const profileSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    /** Job title — in this account. */
    title: z.string().nullable(),
    /** Work phone — in this account. */
    phone: z.string().nullable(),
    /** Department / team (free text) — in this account. */
    department: z.string().nullable(),
    /** The account the per-account fields above belong to. */
    account: z.object({ id: z.string(), name: z.string() }).optional(),
    /** YYYY-MM-DD, or null. */
    birthday: z.string().nullable(),
    locale: z.string(),
    /** IANA zone, or null — never chosen: the member follows the account's timezone. */
    timezone: z.string().nullable(),
    avatar_url: z.string().nullable(),
    /** Agreed to the platform's marketing email; withdrawn from the profile at any time. */
    marketing_opt_in: z.boolean(),
  })
  .meta({ id: 'Profile' });
export type Profile = z.infer<typeof profileSchema>;

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** PATCH /users/me — any subset; an empty text (or null) clears the field. */
export const updateProfileSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    title: optionalText(120),
    phone: z
      .string()
      .trim()
      .max(32)
      .regex(/^[+\d][\d\s\-().]*$|^$/, 'invalid_phone')
      .nullable()
      .optional(),
    department: optionalText(120),
    birthday: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'invalid_date')
      .nullable()
      .optional(),
    locale: z.enum(PROFILE_LOCALES).optional(),
    /** null = follow the account's timezone ("לפי החשבון"). */
    timezone: z.string().min(1).max(64).refine(validTimeZone, 'invalid_timezone').nullable().optional(),
    marketing_opt_in: z.boolean().optional(),
  })
  .meta({ id: 'UpdateProfile' });
export type UpdateProfile = z.infer<typeof updateProfileSchema>;

/**
 * Favourites (Fix: "docs and dashboards in the favourites too"): boards, docs and dashboards in ONE
 * list, mine, per account, in my order (the sidebar's "מועדפים"). What I can no longer open is left out.
 */
export const FAVORITE_TYPES = ['board', 'doc', 'dashboard'] as const;
export type FavoriteType = (typeof FAVORITE_TYPES)[number];
export const FAVORITES_MAX = 100;
export const favoriteSchema = z.object({
  type: z.enum(FAVORITE_TYPES),
  id: z.string(),
  name: z.string(),
  workspace_id: z.string(),
  /** A doc's emoji, when it has one. */
  icon: z.string().nullable().optional(),
});
export type Favorite = z.infer<typeof favoriteSchema>;
export const favoritesSchema = z.object({ data: z.array(favoriteSchema) }).meta({ id: 'Favorites' });
export type Favorites = z.infer<typeof favoritesSchema>;
export const setFavoritesSchema = z
  .object({
    items: z.array(z.object({ type: z.enum(FAVORITE_TYPES), id: z.string().min(1).max(26) })).max(FAVORITES_MAX),
  })
  .meta({ id: 'SetFavorites' });

/** Favourite boards (fix2): mine, per account, in my order. Boards I can no longer open are left out. */
export const FAVORITE_BOARDS_MAX = 50;
export const favoriteBoardSchema = z.object({
  id: z.string(),
  name: z.string(),
  workspace_id: z.string(),
});
export const favoriteBoardsSchema = z.object({ data: z.array(favoriteBoardSchema) }).meta({ id: 'FavoriteBoards' });
export type FavoriteBoards = z.infer<typeof favoriteBoardsSchema>;
export const setFavoriteBoardsSchema = z
  .object({ board_ids: z.array(z.string().min(1).max(26)).max(FAVORITE_BOARDS_MAX) })
  .meta({ id: 'SetFavoriteBoards' });
