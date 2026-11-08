// SPDX-License-Identifier: AGPL-3.0-only
import type { Place, PlaceSuggestion } from '@bines/shared';
import type { Env } from '../../env';

/**
 * Address → coordinates (M8 ד10). Nominatim (OpenStreetMap) without a key — at most one request a second for the
 * whole process and an identifying User-Agent, as its usage policy asks; only from the queue, never while typing
 * (its policy forbids autocomplete). With the account's Google key: Google Geocoding, and Places for completion.
 */
export type GeoHit = { lat: number; lng: number; country_code?: string };
export type Geocoder = { provider: string; geocode: (address: string, language?: string) => Promise<GeoHit | null> };

type GeoEnv = Pick<
  Env,
  | 'GEOCODER_URL'
  | 'GEOCODER_EMAIL'
  | 'GEOCODER_MIN_INTERVAL_MS'
  | 'WEB_ORIGIN'
  | 'GOOGLE_PLACES_URL'
  | 'GOOGLE_GEOCODE_URL'
>;

const TIMEOUT_MS = 10_000;

/** One shared slot per process: every Nominatim call waits for the previous one plus the interval. */
let nextSlot = 0;
const throttle = async (gapMs: number, now: () => number = Date.now) => {
  const at = Math.max(now(), nextSlot);
  nextSlot = at + gapMs;
  const wait = at - now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
};
/** Tests: start from a free slot. */
export const resetGeocoderThrottle = () => {
  nextSlot = 0;
};

const getJson = async (url: string, init: RequestInit = {}) => {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status === 429 || res.status >= 500) throw new Error(`geocoder ${res.status}`);
  if (!res.ok) return null;
  return (await res.json()) as unknown;
};

const userAgent = (env: GeoEnv) =>
  `BinesOS/1.0 (+${env.WEB_ORIGIN}${env.GEOCODER_EMAIL ? `; ${env.GEOCODER_EMAIL}` : ''})`;

export const nominatimGeocoder = (env: GeoEnv): Geocoder => ({
  provider: 'nominatim',
  geocode: async (address, language = 'he') => {
    await throttle(env.GEOCODER_MIN_INTERVAL_MS);
    const url = new URL('/search', env.GEOCODER_URL);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '1');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('q', address);
    if (env.GEOCODER_EMAIL) url.searchParams.set('email', env.GEOCODER_EMAIL);
    const body = await getJson(url.toString(), {
      headers: { 'User-Agent': userAgent(env), 'Accept-Language': language, Accept: 'application/json' },
    });
    const hit = Array.isArray(body) ? (body[0] as Record<string, unknown> | undefined) : undefined;
    const lat = Number(hit?.lat);
    const lng = Number(hit?.lon);
    if (!hit || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const cc = String((hit.address as { country_code?: string } | undefined)?.country_code ?? '').toUpperCase();
    return { lat, lng, ...(cc.length === 2 ? { country_code: cc } : {}) };
  },
});

const countryOf = (components: unknown): string | undefined => {
  const list = Array.isArray(components)
    ? (components as { types?: string[]; short_name?: string; shortText?: string }[])
    : [];
  const c = list.find((x) => x.types?.includes('country'));
  const code = (c?.short_name ?? c?.shortText ?? '').toUpperCase();
  return code.length === 2 ? code : undefined;
};

export const googleGeocoder = (env: GeoEnv, key: string): Geocoder => ({
  provider: 'google',
  geocode: async (address, language = 'he') => {
    const url = new URL('/maps/api/geocode/json', env.GOOGLE_GEOCODE_URL);
    url.searchParams.set('address', address);
    url.searchParams.set('language', language);
    url.searchParams.set('key', key);
    const body = (await getJson(url.toString())) as {
      status?: string;
      results?: { geometry?: { location?: { lat: number; lng: number } }; address_components?: unknown }[];
    } | null;
    if (body?.status === 'OVER_QUERY_LIMIT') throw new Error('geocoder over limit');
    const r = body?.results?.[0];
    const loc = r?.geometry?.location;
    if (!loc || !Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) return null;
    const cc = countryOf(r?.address_components);
    return { lat: loc.lat, lng: loc.lng, ...(cc ? { country_code: cc } : {}) };
  },
});

/** Google Places (New) completion while typing — only with the account's key. */
export const googleAutocomplete = async (
  env: GeoEnv,
  key: string,
  input: string,
  language = 'he',
): Promise<PlaceSuggestion[]> => {
  const body = (await getJson(new URL('/v1/places:autocomplete', env.GOOGLE_PLACES_URL).toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
    body: JSON.stringify({ input, languageCode: language }),
  })) as { suggestions?: { placePrediction?: { placeId?: string; text?: { text?: string } } }[] } | null;
  return (body?.suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is { placeId: string; text: { text: string } } => !!p?.placeId && !!p.text?.text)
    .slice(0, 8)
    .map((p) => ({ place_id: p.placeId, text: p.text.text }));
};

export const googlePlace = async (
  env: GeoEnv,
  key: string,
  placeId: string,
  language = 'he',
): Promise<Place | null> => {
  const url = new URL(`/v1/places/${encodeURIComponent(placeId)}`, env.GOOGLE_PLACES_URL);
  url.searchParams.set('languageCode', language);
  const body = (await getJson(url.toString(), {
    headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'id,formattedAddress,location,addressComponents' },
  })) as {
    id?: string;
    formattedAddress?: string;
    location?: { latitude: number; longitude: number };
    addressComponents?: unknown;
  } | null;
  if (!body?.location || !body.formattedAddress) return null;
  const cc = countryOf(body.addressComponents);
  return {
    address: body.formattedAddress.slice(0, 500),
    lat: body.location.latitude,
    lng: body.location.longitude,
    place_id: body.id ?? placeId,
    ...(cc ? { country_code: cc } : {}),
  };
};

// ---- Photon (Fix: ): free address completion over OpenStreetMap data ----

export type PhotonEnv = Pick<Env, 'PHOTON_URL' | 'PHOTON_MIN_INTERVAL_MS' | 'WEB_ORIGIN' | 'GEOCODER_EMAIL'>;

/** Photon's own slot: completions never wait behind the Nominatim queue (and the other way round). */
let photonSlot = 0;
const photonThrottle = async (gapMs: number) => {
  const now = Date.now();
  const at = Math.max(now, photonSlot);
  photonSlot = at + gapMs;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
};
/** Recent answers (normalised query + language): typing back and forth asks the server once. */
const PHOTON_CACHE_MAX = 500;
const PHOTON_CACHE_MS = 10 * 60_000;
const photonCache = new Map<string, { at: number; data: PlaceSuggestion[] }>();
/** Tests: a clean slate. */
export const resetPhoton = () => {
  photonSlot = 0;
  photonCache.clear();
};

type PhotonFeature = {
  geometry?: { coordinates?: [number, number] };
  properties?: Record<string, unknown>;
};

/** One line of address from Photon's parts: "name, street 12, city, country" without repeats. */
export const photonAddress = (p: Record<string, unknown>): string => {
  const str = (k: string) => (typeof p[k] === 'string' ? (p[k] as string).trim() : '');
  const street = [str('street'), str('housenumber')].filter(Boolean).join(' ');
  const place = str('city') || str('town') || str('village') || str('locality') || str('district') || str('county');
  const parts: string[] = [];
  // A street's own feature is named after the street: "Herzl, Herzl 1" reads as "Herzl 1".
  const name = str('name') === str('street') ? '' : str('name');
  for (const part of [name, street, place, str('state'), str('country')])
    if (part && !parts.some((x) => x.toLocaleLowerCase() === part.toLocaleLowerCase())) parts.push(part);
  return parts.join(', ');
};

/**
 * Completion with Photon (komoot): the places come with their coordinates, so choosing one needs no second
 * request. Called from the server only (no browser CSP entry, one identified client), throttled per process and
 * cached; Hebrew asks for the local names (`default`), which in Israel are Hebrew.
 */
export const photonAutocomplete = async (
  env: PhotonEnv,
  input: string,
  language = 'he',
): Promise<PlaceSuggestion[]> => {
  const lang = language === 'en' ? 'en' : 'default';
  const cacheKey = `${lang}:${input.trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`;
  const hit = photonCache.get(cacheKey);
  if (hit && Date.now() - hit.at < PHOTON_CACHE_MS) return hit.data;
  await photonThrottle(env.PHOTON_MIN_INTERVAL_MS);
  const url = new URL('/api/', env.PHOTON_URL);
  url.searchParams.set('q', input);
  url.searchParams.set('limit', '8');
  url.searchParams.set('lang', lang);
  const body = (await getJson(url.toString(), {
    headers: { 'User-Agent': `BinesOS/1.0 (+${env.WEB_ORIGIN}${env.GEOCODER_EMAIL ? `; ${env.GEOCODER_EMAIL}` : ''})` },
  })) as { features?: PhotonFeature[] } | null;
  const seen = new Set<string>();
  const data: PlaceSuggestion[] = [];
  for (const f of body?.features ?? []) {
    const [lng, lat] = f.geometry?.coordinates ?? [];
    const p = f.properties ?? {};
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const address = photonAddress(p).slice(0, 500);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const cc = String(p.countrycode ?? '').toUpperCase();
    data.push({
      place_id: `photon:${String(p.osm_type ?? '')}${String(p.osm_id ?? `${lat},${lng}`)}`.slice(0, 300),
      text: address,
      address,
      lat,
      lng,
      ...(cc.length === 2 ? { country_code: cc } : {}),
    });
  }
  if (photonCache.size >= PHOTON_CACHE_MAX) photonCache.delete(photonCache.keys().next().value!);
  photonCache.set(cacheKey, { at: Date.now(), data });
  return data;
};
