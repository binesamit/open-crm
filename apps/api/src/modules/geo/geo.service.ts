// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import {
  AppError,
  accountSettingsSchema,
  geocodeKey,
  mapSettingsSchema,
  type AutocompleteProvider,
  type GeoConfig,
  type MapSettings,
  type UpdateGeoSettings,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { keyHint } from '../../lib/secrets';
import { recordEvent } from '../activity/activity.repo';
import { recordAudit } from '../audit/audit.repo';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import type { Actor } from '../items/items.service';
import type { AppDeps, RequestMeta } from '../../types';
import {
  googleAutocomplete,
  googleGeocoder,
  googlePlace,
  nominatimGeocoder,
  photonAutocomplete,
  type Geocoder,
} from './geocoder';
import { RateLimiter } from '../../lib/rate-limit';
import {
  findAccountGeo,
  findCached,
  findCell,
  pendingLocationCells,
  saveCached,
  saveGoogleKey,
  setCellGeo,
} from './geo.repo';
import { forgetMapOrigins } from './geo.csp';
import { assertAccountAdmin, isAccountAdmin } from '../../lib/account-admin';

type Deps = Pick<AppDeps, 'db' | 'env' | 'secrets' | 'logger'>;

const mapsOf = async (db: Db, accountId: string): Promise<MapSettings> =>
  accountSettingsSchema.parse(await getAccountSettings(db, accountId)).maps;

const googleKeyOf = async (deps: Pick<Deps, 'db' | 'secrets'>, accountId: string): Promise<string | null> => {
  const row = await findAccountGeo(deps.db, accountId);
  if (!row?.googleKey) return null;
  try {
    return deps.secrets.open(row.googleKey);
  } catch {
    return null; // sealed with another SECRETS_KEY: the admin enters it again
  }
};

/**
 * Who completes addresses (Fix: ): Google with the account's key (`auto` / `google`), else Photon (`auto` /
 * `photon`); `off` — nobody. Nominatim never does (its usage policy forbids completion).
 */
export const autocompleteProvider = (settings: MapSettings, hasKey: boolean): AutocompleteProvider | null => {
  switch (settings.autocomplete) {
    case 'off':
      return null;
    case 'google':
      return hasKey ? 'google' : null;
    case 'photon':
      return 'photon';
    default:
      return hasKey ? 'google' : 'photon';
  }
};

/** GET /geo/config — what the map and the location cell need (every member). */
export const geoConfig = async (deps: Deps, a: Actor): Promise<GeoConfig> => {
  const settings = await mapsOf(deps.db, a.ctx.accountId);
  const row = await findAccountGeo(deps.db, a.ctx.accountId);
  const hasKey = !!row?.googleKey;
  const provider = autocompleteProvider(settings, hasKey);
  return {
    style_url: settings.style_url ?? deps.env.MAP_STYLE_URL,
    autocomplete: provider !== null,
    autocomplete_provider: provider,
    geocoding: settings.geocoder !== 'off',
    settings,
    google_key_hint: isAccountAdmin(a.ctx) ? (row?.googleKeyHint ?? null) : null,
  };
};

/** PUT /geo/settings (admins): tiles, extra origins, geocoder, and the write-only Google key. */
export const updateGeoSettings = async (deps: Deps, a: Actor, input: UpdateGeoSettings, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx, { reason: 'account.update' });
  await deps.db.transaction(async (tx) => {
    const current = accountSettingsSchema.parse(await getAccountSettings(tx, a.ctx.accountId));
    const maps = mapSettingsSchema.parse({
      ...current.maps,
      ...(input.style_url !== undefined ? { style_url: input.style_url } : {}),
      ...(input.extra_origins ? { extra_origins: [...new Set(input.extra_origins)] } : {}),
      ...(input.geocoder ? { geocoder: input.geocoder } : {}),
      ...(input.autocomplete ? { autocomplete: input.autocomplete } : {}),
    });
    await upsertAccountSettings(tx, a.ctx.accountId, { ...current, maps }, a.user.id);
    if (input.google_key !== undefined)
      await saveGoogleKey(
        tx,
        a.ctx.accountId,
        input.google_key ? deps.secrets.seal(input.google_key) : null,
        input.google_key ? keyHint(input.google_key) : null,
        a.user.id,
      );
    // What changed — never the key itself.
    const after = { maps, ...(input.google_key !== undefined ? { google_key_set: !!input.google_key } : {}) };
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'account.updated',
      actorId: a.user.id,
      requestId: a.requestId ?? meta.requestId,
      before: { maps: current.maps },
      after,
    });
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'account.updated',
      targetType: 'account',
      targetId: a.ctx.accountId,
      payload: { fields: ['maps', ...(input.google_key !== undefined ? ['google_key'] : [])] },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  forgetMapOrigins();
  return geoConfig(deps, a);
};

const languageOf = (a: Actor) => (a.user.locale === 'en' ? 'en' : 'he');

/** Completions per user a minute (the client waits for a pause in typing; this is the backstop). */
const completionLimiter = new RateLimiter(60, 60_000);
/** Place details per user a minute (one per chosen suggestion; S-33). */
const placeLimiter = new RateLimiter(60, 60_000);

/**
 * GET /geo/autocomplete — address completion while typing: Google with the account's key, else Photon (fix round
 * 10); empty when off, for fewer than 3 characters, over the per-user rate, or when the provider fails.
 */
export const autocomplete = async (deps: Deps, a: Actor, q: string) => {
  const settings = await mapsOf(deps.db, a.ctx.accountId);
  const key = await googleKeyOf(deps, a.ctx.accountId);
  const provider = autocompleteProvider(settings, !!key);
  const input = q.trim().slice(0, 200);
  if (!provider || input.length < 3) return [];
  if (completionLimiter.hit(`${a.ctx.accountId}:${a.user.id}`)) return [];
  try {
    return provider === 'google'
      ? await googleAutocomplete(deps.env, key!, input, languageOf(a))
      : await photonAutocomplete(deps.env, input, languageOf(a));
  } catch (err) {
    deps.logger.warn({ err: (err as Error).message, provider }, 'address autocomplete failed');
    return [];
  }
};

/** GET /geo/places/:id — a chosen suggestion with its coordinates. */
export const place = async (deps: Deps, a: Actor, placeId: string) => {
  // A Photon suggestion carries its coordinates; there is nothing to look up.
  if (placeId.startsWith('photon:')) throw new AppError('not_found', 'Place not found');
  const key = await googleKeyOf(deps, a.ctx.accountId);
  if (!key) throw new AppError('not_found', 'No geocoding key');
  // S-33: every call is a paid Google request on the account's key — the same per-user budget as completions.
  if (placeLimiter.hit(`${a.ctx.accountId}:${a.user.id}`)) throw new AppError('rate_limited', 'Too many requests');
  const p = await googlePlace(deps.env, key, placeId, languageOf(a)).catch(() => null);
  if (!p) throw new AppError('not_found', 'Place not found');
  return p;
};

// ---- the geocoding queue ----

export const GEOCODE_TASK = 'geo.geocode';
export const GEOCODE_SWEEP_TASK = 'geo.sweep';
export type GeocodeJob = { account_id: string; item_id: string; column_id: string; address: string };

/**
 * Queues a location cell for coordinates (from `writeCell`). One named queue (`geo`): graphile-worker runs its
 * jobs one at a time, so with the throttle Nominatim sees at most one request a second. The job key replaces a
 * pending job of the same cell (the newest address wins).
 */
export const queueGeocode = async (db: Db, job: GeocodeJob) => {
  const res = (await db.execute(sql`select to_regnamespace('graphile_worker') is not null as ok`)) as {
    rows: { ok: boolean }[];
  };
  if (!res.rows[0]?.ok) return false;
  await db.execute(
    sql`select graphile_worker.add_job(${GEOCODE_TASK}, ${JSON.stringify(job)}::json, queue_name => 'geo', max_attempts => 5, job_key => ${`geo:${job.item_id}:${job.column_id}`}, job_key_mode => 'replace')`,
  );
  return true;
};

/** The account's geocoder: Google with its key, else Nominatim; null when geocoding is off. */
export const geocoderFor = async (deps: Pick<Deps, 'db' | 'secrets' | 'env'>, accountId: string) => {
  const settings = await mapsOf(deps.db, accountId);
  if (settings.geocoder === 'off') return null;
  const key = await googleKeyOf(deps, accountId);
  return key ? googleGeocoder(deps.env, key) : nominatimGeocoder(deps.env);
};

/**
 * One job: the address from the cache, else from the geocoder (cached — found or not, so an address is asked
 * once); the cell gets lat / lng (or `geocode_failed`) only if it still holds that address, and one
 * `cell.geocoded` event refreshes the row on every screen (no automation listens to it).
 */
export const runGeocode = async (deps: Deps, job: GeocodeJob, geocoder?: Geocoder | null): Promise<string> => {
  const { db } = deps;
  const cell = await findCell(db, job.item_id, job.column_id);
  const value = cell?.value as { address?: string; lat?: number } | undefined;
  if (!cell || cell.accountId !== job.account_id || value?.address !== job.address || value.lat !== undefined)
    return 'stale';
  const key = geocodeKey(job.address);
  let hit = await findCached(db, job.account_id, key);
  if (!hit) {
    const g = geocoder === undefined ? await geocoderFor(deps, job.account_id) : geocoder;
    if (!g) return 'off';
    const found = await g.geocode(job.address); // a throw retries the job (graphile-worker backoff)
    await saveCached(db, {
      accountId: job.account_id,
      query: key,
      provider: g.provider,
      found: !!found,
      lat: found?.lat ?? null,
      lng: found?.lng ?? null,
      countryCode: found?.country_code ?? null,
    });
    hit = await findCached(db, job.account_id, key);
  }
  if (!hit) return 'stale';
  const patch =
    hit.found && hit.lat !== null && hit.lng !== null
      ? { lat: hit.lat, lng: hit.lng, ...(hit.countryCode ? { country_code: hit.countryCode } : {}) }
      : { geocode_failed: true };
  return db.transaction(async (tx) => {
    if (!(await setCellGeo(tx, job.item_id, job.column_id, job.address, patch))) return 'stale';
    await recordEvent(tx, {
      accountId: job.account_id,
      type: 'cell.geocoded',
      actorId: null,
      actorType: 'system',
      boardId: cell.boardId,
      itemId: job.item_id,
      columnId: job.column_id,
      after: { value: { ...value, ...patch } },
      meta: { found: 'lat' in patch },
    });
    return 'lat' in patch ? 'found' : 'not_found';
  });
};

/** Every few minutes: location cells written around the cell service (import, bulk) join the queue. */
export const sweepGeocodes = async (db: Db, limit = 200) => {
  let n = 0;
  for (const c of await pendingLocationCells(db, limit)) {
    if (
      await queueGeocode(db, {
        account_id: c.account_id,
        item_id: c.item_id,
        column_id: c.column_id,
        address: c.address,
      })
    )
      n++;
  }
  return n;
};
