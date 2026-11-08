// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The owner console's sections: a side nav like Administration's, one section per `?section=` value.
 * Kept apart from the console so the router can check the search param without loading the console.
 */
export const OWNER_SECTIONS = [
  'overview',
  'accounts',
  'signup-requests',
  'emergency',
  'deletions',
  'plans',
  'signup',
  'licensing',
  'ai-prices',
  'costs',
  'kits',
  'extensions',
  'guides',
  'legal',
  'general',
  'security',
  'email',
  'connections',
  'support',
  'errors',
  'incidents',
] as const;
export type OwnerSection = (typeof OWNER_SECTIONS)[number];

/** Support staff see only these; the platform owner sees every section. */
export const SUPPORT_SECTIONS: readonly OwnerSection[] = ['support', 'errors'];

export const isOwnerSection = (s: unknown): s is OwnerSection =>
  typeof s === 'string' && (OWNER_SECTIONS as readonly string[]).includes(s);

/** `?section=` as the router keeps it; `platform` (the old single page) opens the overview. */
export const sectionFromSearch = (s: unknown): OwnerSection | undefined =>
  isOwnerSection(s) ? s : s === 'platform' ? 'overview' : undefined;
