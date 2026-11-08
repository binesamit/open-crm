// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Maps and addresses (M8 ד10, D25): the location column, the Map view and the account's map settings. Tiles are
 * free OpenFreeMap by default and swappable per account (a MapLibre style URL — MapTiler, Protomaps …) without
 * code; addresses become coordinates in a queue (Nominatim, one request a second), or through Google with the
 * account's own key, which also completes addresses while typing.
 */

/** The longest origin: "https://" + a 253-character host + ":65535" (S-31: it goes into every page's CSP). */
export const MAP_ORIGIN_MAX = 270;

/** An https origin the map may load from ("https://api.maptiler.com"). */
export const mapOriginSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(MAP_ORIGIN_MAX)
  .regex(/^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/, 'https origin');

export const AUTOCOMPLETE_MODES = ['auto', 'photon', 'google', 'off'] as const;
export const AUTOCOMPLETE_PROVIDERS = ['photon', 'google'] as const;
export type AutocompleteProvider = (typeof AUTOCOMPLETE_PROVIDERS)[number];

/** `account_settings.settings.maps` — readable by every member (the map needs it); the Google key lives apart. */
export const mapSettingsSchema = z.object({
  /** A MapLibre style JSON URL; null = the server's default (OpenFreeMap). */
  style_url: z
    .url({ protocol: /^https$/ })
    .max(500)
    .nullable()
    .default(null),
  /** More origins the style loads tiles / glyphs / sprites from (they join the page's CSP). */
  extra_origins: z.array(mapOriginSchema).max(10).default([]),
  /** `auto`: Google with the account's key, else Nominatim; `off`: no geocoding (addresses stay text). */
  geocoder: z.enum(['auto', 'off']).default('auto'),
  /**
   * Fix: — address completion while typing: `auto` = Google with the account's key, else Photon (free,
   * OpenStreetMap data by komoot — Nominatim's policy forbids completion); `photon` / `google` force one; `off`.
   */
  autocomplete: z.enum(AUTOCOMPLETE_MODES).default('auto'),
});
export type MapSettings = z.infer<typeof mapSettingsSchema>;

export const geoConfigSchema = z.object({
  style_url: z.string(),
  /** Addresses complete while typing (Photon, or Google with the account's key). */
  autocomplete: z.boolean(),
  /** Who completes addresses (null = nobody); the list shows the provider's attribution. */
  autocomplete_provider: z.enum(AUTOCOMPLETE_PROVIDERS).nullable(),
  /** Addresses get coordinates (the queue runs). */
  geocoding: z.boolean(),
  settings: mapSettingsSchema,
  /** Admins only: the saved key's last characters, or null. */
  google_key_hint: z.string().nullable(),
});
export type GeoConfig = z.infer<typeof geoConfigSchema>;

export const updateGeoSettingsSchema = z.object({
  style_url: mapSettingsSchema.shape.style_url.unwrap().optional(),
  extra_origins: z.array(mapOriginSchema).max(10).optional(),
  geocoder: z.enum(['auto', 'off']).optional(),
  autocomplete: z.enum(AUTOCOMPLETE_MODES).optional(),
  /** A new Google Maps Platform key (Places + Geocoding), or null to remove it. Never sent back. */
  google_key: z.string().trim().min(10).max(200).nullable().optional(),
});
export type UpdateGeoSettings = z.infer<typeof updateGeoSettingsSchema>;

/**
 * One completion. Photon answers with the place itself (address + coordinates): the cell takes it as is; a Google
 * suggestion has only an id, resolved by `GET /geo/places/:id`.
 */
export const placeSuggestionSchema = z.object({
  place_id: z.string(),
  text: z.string(),
  address: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  country_code: z.string().length(2).optional(),
});
export const placeSchema = z.object({
  address: z.string(),
  lat: z.number(),
  lng: z.number(),
  place_id: z.string().optional(),
  country_code: z.string().length(2).optional(),
});
export type PlaceSuggestion = z.infer<typeof placeSuggestionSchema>;
export type Place = z.infer<typeof placeSchema>;

/** The address key of the geocoding cache: trimmed, single spaces, lower case. */
export const geocodeKey = (address: string) => address.trim().replace(/\s+/g, ' ').toLocaleLowerCase().slice(0, 500);
