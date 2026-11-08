// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Product decision ("decide in the profile and in the account what sits in the sidebar and what in the top
 * bar; everything can stay in the sidebar like now"): where each of the shell's general places shows on the desktop.
 * The workspace tree and the profile menu always stay in the sidebar, so they are not slots. The phone layout is
 * not affected.
 *
 * Stored as `nav` in the account's settings (the admins' default, with `locked` = members can't change it) and in
 * the member's own settings in that account (`account_members.settings.nav`, merged in, never replacing the object).
 */
export const NAV_SLOTS = [
  'account',
  'home',
  'my_work',
  'inbox',
  'automations',
  'flows',
  'agents',
  'search',
  'assistant',
  'help',
  'bell',
] as const;
export type NavSlot = (typeof NAV_SLOTS)[number];

/** The general destinations among the slots (links); the rest are the account's mark and the tools. */
export const NAV_LINK_SLOTS = ['home', 'my_work', 'inbox', 'automations', 'flows', 'agents'] as const;

/** `hidden` ("not everyone cares about automations, flows…"): not in either bar, nor the phone's menu. */
export const NAV_PLACES = ['side', 'top', 'hidden'] as const;
export type NavPlace = (typeof NAV_PLACES)[number];

/** The account's mark is also the way home, so it is never hidden. */
export const canHideNavSlot = (s: NavSlot) => s !== 'account';

const placeSchema = z.enum(NAV_PLACES);

/**
 * an extension's page in the sidebar (`app_page`) is placed like the other destinations, by
 * `<extension key>.<feature key>`. One not placed shows in the sidebar.
 */
export const NAV_APP_KEY_RE = /^[a-z][a-z0-9-]{1,47}\.[a-z][a-z0-9_-]{0,39}$/;
/** At most this many extension pages placed (one person never has more). */
export const NAV_APPS_MAX = 50;
const appPlacementSchema = z
  .record(z.string().regex(NAV_APP_KEY_RE), placeSchema)
  .refine((r) => Object.keys(r).length <= NAV_APPS_MAX, 'too_many_apps');

const slotShape = Object.fromEntries(NAV_SLOTS.map((s) => [s, placeSchema.optional()])) as Record<
  NavSlot,
  z.ZodOptional<typeof placeSchema>
>;

/** A placement: any subset of the slots (a slot left out falls back — see `resolveNavLayout`), and extension pages. */
export const navPlacementSchema = z.object({ ...slotShape, apps: appPlacementSchema.optional() });
export type NavPlacement = z.infer<typeof navPlacementSchema>;
/** Every slot placed; extension pages placed only where someone chose (else the sidebar — `appNavPlace`). */
export type NavLayout = Record<NavSlot, NavPlace> & { apps?: Record<string, NavPlace> };

/** Where an extension's page sits (`<extension key>.<feature key>`): as placed, else the sidebar. */
export const appNavPlace = (l: Pick<NavLayout, 'apps'>, key: string): NavPlace => l.apps?.[key] ?? 'side';

/** Everything in the sidebar — the default, as it was before the top bar. */
export const NAV_PRESET_SIDE: NavLayout = Object.fromEntries(NAV_SLOTS.map((s) => [s, 'side'])) as Record<
  NavSlot,
  NavPlace
>;
/** "Navigation on top": every slot in the top bar (the canvas's option א). */
export const NAV_PRESET_TOP: NavLayout = Object.fromEntries(NAV_SLOTS.map((s) => [s, 'top'])) as Record<
  NavSlot,
  NavPlace
>;

export type NavPreset = 'side' | 'top' | 'custom';

/** Which quick preset a full layout matches. */
export const navPresetOf = (l: NavLayout): NavPreset =>
  NAV_SLOTS.every((s) => l[s] === 'side') ? 'side' : NAV_SLOTS.every((s) => l[s] === 'top') ? 'top' : 'custom';

/** The account's default (`account_settings.settings.nav`). */
export const accountNavSchema = z.object({
  placement: navPlacementSchema.default({}),
  /** Members follow the account's layout and can't choose their own. */
  locked: z.boolean().default(false),
});
export type AccountNav = z.infer<typeof accountNavSchema>;

/** Stored extension-page places: known places of well-formed keys, at most `NAV_APPS_MAX`; none = undefined. */
const cleanAppPlacement = (v: unknown): Record<string, NavPlace> | undefined => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, NavPlace> = {};
  for (const [k, p] of Object.entries(v as Record<string, unknown>).slice(0, NAV_APPS_MAX))
    if (NAV_APP_KEY_RE.test(k) && (p === 'side' || p === 'top' || p === 'hidden')) out[k] = p;
  return Object.keys(out).length ? out : undefined;
};

/** A stored (untrusted) placement: unknown slots and values are dropped. */
export const cleanNavPlacement = (v: unknown): NavPlacement => {
  const out: NavPlacement = {};
  if (!v || typeof v !== 'object') return out;
  for (const s of NAV_SLOTS) {
    const p = (v as Record<string, unknown>)[s];
    if (p === 'side' || p === 'top' || (p === 'hidden' && canHideNavSlot(s))) out[s] = p;
  }
  const apps = cleanAppPlacement((v as Record<string, unknown>).apps);
  if (apps) out.apps = apps;
  return out;
};

/** A stored (untrusted) account default. */
export const cleanAccountNav = (v: unknown): AccountNav => {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return { placement: cleanNavPlacement(o.placement), locked: o.locked === true };
};

/**
 * The layout in effect: the member's own placement (unless the account locked it) → the account's default → the
 * sidebar. `mine` = null means "follow the account".
 */
export const resolveNavLayout = (mine: NavPlacement | null, account: AccountNav): NavLayout => {
  const own = account.locked ? null : mine;
  const layout: NavLayout = Object.fromEntries(
    NAV_SLOTS.map((s) => [s, own?.[s] ?? account.placement[s] ?? 'side']),
  ) as Record<NavSlot, NavPlace>;
  const apps = { ...account.placement.apps, ...own?.apps };
  if (Object.keys(apps).length) layout.apps = apps;
  return layout;
};

/** GET / PUT /me/nav. */
export const navLayoutResponseSchema = z.object({
  /** The layout in effect for me in this account. */
  layout: z.object({
    ...(Object.fromEntries(NAV_SLOTS.map((s) => [s, placeSchema])) as Record<NavSlot, typeof placeSchema>),
    apps: z.record(z.string(), placeSchema).optional(),
  }),
  /** My own placement, or null = I follow the account's default. */
  mine: navPlacementSchema.nullable(),
  /** The account's default and whether it is locked. */
  account: accountNavSchema,
});
export type NavLayoutResponse = { layout: NavLayout; mine: NavPlacement | null; account: AccountNav };

/** PUT /me/nav — my own placement, or null = follow the account again. */
export const setMyNavSchema = z.object({ placement: navPlacementSchema.nullable() });
export type SetMyNav = z.infer<typeof setMyNavSchema>;

/** PUT /accounts/me/nav (admins) — the account's default. */
export const setAccountNavSchema = z.object({
  placement: navPlacementSchema,
  locked: z.boolean(),
});
export type SetAccountNav = z.infer<typeof setAccountNavSchema>;
