// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  COST_ADAPTER_DEFS,
  type CostAccounts,
  type CostAdapter,
  type CostPrice,
  type CostPriceInput,
  costPriceInputSchema,
  type CostPricePatch,
  costPricePatchSchema,
  type CostSettings,
  type CostSettingsPatch,
  costSettingsPatchSchema,
  type CostSettingsResponse,
  readCostSettingsValue,
  type CostSource,
  type CostSourceInput,
  costSourceInputSchema,
  type CostSourcePatch,
  costSourcePatchSchema,
  type CostSummary,
  type CostSyncInput,
  type CostTestResult,
  newId,
} from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import type { Db } from '../../db/client';
import type { CostPriceRow } from '../../db/schema';
import { enqueueJob, jobKeyLive } from '../../lib/jobs';
import { outboundRequest, allowPrivateOutbound } from '../../lib/outbound';
import { keyHint } from '../../lib/secrets';
import { st } from '../../lib/i18n';
import type { AppDeps, SessionUser } from '../../types';
import { readSettingsRow, writeSettingsRow } from '../license/license.repo';
import { platformMailBrand } from '../platform/mail-brand';
import { appLink } from '../platform/public-address';
import { ADAPTERS, canBackfill, type CostRecord, type CostRequest, monthToDateShare } from './adapters';
import {
  addDays,
  allocate,
  dayRange,
  daysInMonth,
  monthForecast,
  numberFrom,
  priceEntries,
  type PriceRule,
  round2,
} from './costs.math';
import {
  accountsWithPlans,
  amountBefore,
  currenciesInUse,
  deletePriceRow,
  entriesBetween,
  findPriceRow,
  findSourceRow,
  insertPriceRow,
  insertSourceRow,
  listPriceRows,
  listSourceRows,
  monthsWithMetric,
  ownerEmails,
  quantityRows,
  ratesFor,
  replaceEntries,
  saveRates,
  type CostSourceRow,
  updatePriceRow,
  updateSourceRow,
  writeCosts,
} from './costs.repo';

/**
 * Platform costs (owner console → Costs): the cost sources, the unit-price table, the settings, the
 * daily sync and the reports. Platform owner only (the routes check it). Everything an installation chooses — which
 * providers, keys, prices, currency, hour, budgets — is data the owner edits; nothing here names a provider's
 * account or a price.
 */
type Deps = Pick<AppDeps, 'db' | 'secrets' | 'logger' | 'env'>;

export const SETTINGS_ROW = 'costs';
const STATE_ROW = 'costs_state';
export const COST_SYNC_TASK = 'costs.sync';
export const COST_TICK_TASK = 'costs.tick';
const SYNC_STALE_MS = 30 * 60_000;

export const today = (now = new Date()) => now.toISOString().slice(0, 10);

// ---------------------------------------------------------------- outbound calls (replaced in tests)

const defaultRequest =
  (env: Deps['env']): CostRequest =>
  (url, init) =>
    outboundRequest(url, {
      ...init,
      timeoutMs: 30_000,
      maxBytes: 4 * 1024 * 1024,
      allowPrivate: allowPrivateOutbound(env, { inTests: false }),
    });
let testRequest: CostRequest | null = null;
/** Tests answer every provider call (no test ever calls Railway, Cloudflare or a rates service). */
export const setCostRequestForTests = (f: CostRequest | null) => {
  testRequest = f;
};
const requestOf = (deps: Deps) => testRequest ?? defaultRequest(deps.env);

// ---------------------------------------------------------------- settings

export const readCostSettings = async (db: Db): Promise<CostSettings> =>
  readCostSettingsValue(await readSettingsRow(db, SETTINGS_ROW));

type CostState = {
  last_auto_day?: string;
  fx_updated_at?: string;
  /** Alert key → when it was sent (a budget once a month, a spike once a day, a failing source once a day). */
  alerts?: Record<string, string>;
};
const readState = async (db: Db) => ((await readSettingsRow(db, STATE_ROW)) ?? {}) as CostState;
const writeState = (db: Db, state: CostState) => writeSettingsRow(db, STATE_ROW, state, null);

export const getCostSettings = async (deps: Pick<Deps, 'db'>): Promise<CostSettingsResponse> => {
  const settings = await readCostSettings(deps.db);
  const rates = await rateTable(deps.db, settings);
  const now = today();
  const current: Record<string, number> = {};
  for (const c of rates.currencies()) {
    const r = rates.rate(c, now);
    if (r !== null) current[c] = r;
  }
  return { ...settings, fx_rates: current, fx_updated_at: (await readState(deps.db)).fx_updated_at ?? null };
};

export const updateCostSettings = async (deps: Deps, owner: SessionUser, raw: CostSettingsPatch) => {
  const patch = costSettingsPatchSchema.parse(raw);
  const before = await readCostSettings(deps.db);
  const next = readCostSettingsValue({ ...before, ...patch });
  await writeSettingsRow(deps.db, SETTINGS_ROW, next, owner.id);
  // A new currency or rate source → today's rates now, so the screen converts at once.
  if (next.display_currency !== before.display_currency || next.fx_source !== before.fx_source)
    await refreshRates(deps).catch((err) => deps.logger.warn({ err }, 'costs: rates refresh failed'));
  deps.logger.info({ owner: owner.id, fields: Object.keys(patch) }, 'cost settings updated');
  return getCostSettings(deps);
};

// ---------------------------------------------------------------- sources

const syncKey = (id?: string) => `${COST_SYNC_TASK}:${id ?? 'all'}`;

const sourceDto = (r: CostSourceRow, syncing: boolean): CostSource => ({
  id: r.id,
  adapter: r.adapter as CostAdapter,
  name: r.name,
  enabled: r.enabled,
  config: (r.config ?? {}) as CostSource['config'],
  secret_set: !!r.secretSealed,
  secret_hint: r.secretHint,
  budget_monthly: r.budgetMonthly,
  last_sync_at: r.lastSyncAt?.toISOString() ?? null,
  last_sync_ok: r.lastSyncOk,
  last_error: r.lastError,
  syncing,
  created_at: r.createdAt.toISOString(),
});

/** The platform's own measurements are always a source (made on first use). */
const ensureInternal = async (db: Db) => {
  const rows = await listSourceRows(db);
  if (rows.some((r) => r.adapter === 'internal')) return rows;
  await insertSourceRow(db, { id: newId(), adapter: 'internal', config: { ai_scope: 'all' } });
  return listSourceRows(db);
};

export const listCostSources = async (deps: Pick<Deps, 'db'>) => {
  const rows = await ensureInternal(deps.db);
  const all = await jobKeyLive(deps.db, syncKey(), SYNC_STALE_MS);
  return {
    data: await Promise.all(
      rows.map(async (r) => sourceDto(r, all || (await jobKeyLive(deps.db, syncKey(r.id), SYNC_STALE_MS)))),
    ),
  };
};

/** Only the adapter's own settings are kept; required ones must be there. */
const cleanConfig = (adapter: CostAdapter, config: Record<string, unknown>) => {
  const out: Record<string, string | number | boolean | null> = {};
  for (const f of COST_ADAPTER_DEFS[adapter].fields) {
    const v = config[f.key];
    if (v === undefined || v === null || v === '') {
      if (f.required) throw new AppError('invalid_value', 'cost_source_missing_field', { field: f.key });
      continue;
    }
    if (f.kind === 'number') {
      const n = numberFrom(v);
      if (n === null) throw new AppError('invalid_value', 'cost_source_bad_field', { field: f.key });
      out[f.key] = n;
    } else if (f.kind === 'select') {
      if (!f.options?.includes(String(v)))
        throw new AppError('invalid_value', 'cost_source_bad_field', { field: f.key });
      out[f.key] = String(v);
    } else if (f.kind === 'currency') {
      const c = String(v).trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(c)) throw new AppError('invalid_value', 'cost_source_bad_field', { field: f.key });
      out[f.key] = c;
    } else if (f.kind === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v)))
        throw new AppError('invalid_value', 'cost_source_bad_field', { field: f.key });
      out[f.key] = String(v);
    } else if (f.kind === 'url') {
      let url: URL;
      try {
        url = new URL(String(v));
      } catch {
        throw new AppError('invalid_value', 'cost_source_bad_field', { field: f.key });
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        throw new AppError('invalid_value', 'cost_source_bad_field', { field: f.key });
      out[f.key] = url.toString();
    } else out[f.key] = String(v).trim();
  }
  return out;
};

export const createCostSource = async (deps: Deps, owner: SessionUser, raw: CostSourceInput) => {
  const input = costSourceInputSchema.parse(raw);
  const def = COST_ADAPTER_DEFS[input.adapter];
  if (def.single) throw new AppError('conflict', 'cost_source_single');
  const config = cleanConfig(input.adapter, input.config);
  if (def.secret && !input.secret?.trim()) throw new AppError('invalid_value', 'cost_source_missing_key');
  const row = await insertSourceRow(deps.db, {
    id: newId(),
    adapter: input.adapter,
    name: input.name?.trim() || null,
    enabled: input.enabled,
    config,
    ...(def.secret && input.secret?.trim()
      ? { secretSealed: deps.secrets.seal(input.secret.trim()), secretHint: keyHint(input.secret.trim()) }
      : {}),
    budgetMonthly: input.budget_monthly ?? null,
    createdBy: owner.id,
  });
  deps.logger.info({ owner: owner.id, source: row.id, adapter: row.adapter }, 'cost source added');
  // A new source reads its past days at once (what it can).
  const settings = await readCostSettings(deps.db);
  await requestCostSync(deps, { source_id: row.id, days: settings.backfill_days });
  return sourceDto(row, true);
};

export const updateCostSource = async (deps: Deps, owner: SessionUser, id: string, raw: CostSourcePatch) => {
  const input = costSourcePatchSchema.parse(raw);
  const current = await findSourceRow(deps.db, id);
  if (!current) throw new AppError('not_found', 'Cost source not found');
  const adapter = current.adapter as CostAdapter;
  const secret = input.secret?.trim();
  const row = await updateSourceRow(deps.db, id, {
    ...(input.name !== undefined ? { name: input.name?.trim() || null } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.config !== undefined ? { config: cleanConfig(adapter, input.config) } : {}),
    ...(input.budget_monthly !== undefined ? { budgetMonthly: input.budget_monthly } : {}),
    ...(input.secret !== undefined && COST_ADAPTER_DEFS[adapter].secret
      ? secret
        ? { secretSealed: deps.secrets.seal(secret), secretHint: keyHint(secret) }
        : { secretSealed: null, secretHint: null }
      : {}),
  });
  deps.logger.info({ owner: owner.id, source: id, fields: Object.keys(input) }, 'cost source updated');
  return sourceDto(row!, await jobKeyLive(deps.db, syncKey(id), SYNC_STALE_MS));
};

/** Soft delete: its days leave the reports (kept, so restoring a mistake by hand stays possible). */
export const deleteCostSource = async (deps: Deps, owner: SessionUser, id: string) => {
  const current = await findSourceRow(deps.db, id);
  if (!current) throw new AppError('not_found', 'Cost source not found');
  if (COST_ADAPTER_DEFS[current.adapter as CostAdapter]?.single) throw new AppError('conflict', 'cost_source_single');
  await updateSourceRow(deps.db, id, { deletedAt: new Date(), enabled: false });
  deps.logger.info({ owner: owner.id, source: id }, 'cost source removed');
  return { ok: true as const };
};

const secretOf = (deps: Deps, row: CostSourceRow) => (row.secretSealed ? deps.secrets.open(row.secretSealed) : null);

/** Reads yesterday (today for a source that cannot go back) and says what it found — nothing is stored. */
export const testCostSource = async (deps: Deps, id: string): Promise<CostTestResult> => {
  const row = await findSourceRow(deps.db, id);
  if (!row) throw new AppError('not_found', 'Cost source not found');
  const adapter = row.adapter as CostAdapter;
  const now = today();
  const day = canBackfill(adapter) ? addDays(now, -1) : now;
  try {
    const records = await ADAPTERS[adapter]({
      db: deps.db,
      config: (row.config ?? {}) as Record<string, unknown>,
      secret: secretOf(deps, row),
      from: day,
      to: day,
      today: now,
      request: requestOf(deps),
    });
    const sample: Record<string, number> = {};
    for (const r of records) sample[r.metric] = round2((sample[r.metric] ?? 0) + (r.amount ?? r.quantity));
    return { ok: true, sample };
  } catch (err) {
    return { ok: false, error: errorText(err) };
  }
};

/** What the owner reads about a failure: the reason code and what the provider said (never the key). */
const errorText = (err: unknown) =>
  err instanceof AppError
    ? JSON.stringify({ reason: err.message, details: err.details ?? {} })
    : JSON.stringify({
        reason: 'cost_source_failed',
        details: { message: String((err as Error)?.message ?? err).slice(0, 200) },
      });

// ---------------------------------------------------------------- sync

/** Queues a sync (one source or all) for the worker; without a worker (tests) it runs now. */
export const requestCostSync = async (deps: Deps, input: CostSyncInput) => {
  if (input.source_id && !(await findSourceRow(deps.db, input.source_id)))
    throw new AppError('not_found', 'Cost source not found');
  const queued = await enqueueJob(
    deps.db,
    COST_SYNC_TASK,
    { ...input },
    { jobKey: syncKey(input.source_id), maxAttempts: 1 },
  );
  if (!queued) await runCostSync(deps, input);
  return { ok: true as const, queued };
};

/** One source, days [from, to]: read, replace its rows, reprice the months touched, record how it went. */
export const syncSource = async (deps: Deps, row: CostSourceRow, days: number, now = new Date()) => {
  const adapter = row.adapter as CostAdapter;
  const to = today(now);
  const from = canBackfill(adapter) ? addDays(to, -(days - 1)) : to;
  try {
    let records: CostRecord[] = await ADAPTERS[adapter]({
      db: deps.db,
      config: (row.config ?? {}) as Record<string, unknown>,
      secret: secretOf(deps, row),
      from,
      to,
      today: to,
      request: requestOf(deps),
    });
    // A month-to-date source: today holds what grew since the month's earlier days.
    if (adapter === 'http_json' && (row.config as Record<string, unknown>)?.amount_mode === 'month_to_date') {
      const earlier = await amountBefore(deps.db, row.id, `${to.slice(0, 7)}-01`, to);
      records = records.map((r) => ({ ...r, amount: monthToDateShare(r.amount ?? 0, earlier) }));
    }
    await replaceEntries(deps.db, row.id, from, to, records);
    await repriceRange(deps.db, from, to);
    await updateSourceRow(deps.db, row.id, { lastSyncAt: now, lastSyncOk: true, lastError: null });
    return { ok: true, rows: records.length };
  } catch (err) {
    deps.logger.warn({ err, source: row.id, adapter }, 'costs: source sync failed');
    await updateSourceRow(deps.db, row.id, { lastSyncAt: now, lastSyncOk: false, lastError: errorText(err) });
    return { ok: false, rows: 0 };
  }
};

/** The job: one source or every enabled one, then the day's exchange rates. */
export const runCostSync = async (deps: Deps, input: CostSyncInput, now = new Date()) => {
  const settings = await readCostSettings(deps.db);
  const days = input.days ?? settings.sync_days;
  const rows = input.source_id
    ? [await findSourceRow(deps.db, input.source_id)].filter((r): r is CostSourceRow => !!r)
    : (await ensureInternal(deps.db)).filter((r) => r.enabled);
  const results = [];
  for (const row of rows) results.push(await syncSource(deps, row, days, now));
  await refreshRates(deps, now).catch((err) => deps.logger.warn({ err }, 'costs: rates refresh failed'));
  return results;
};

/**
 * Hourly: at the owner's hour (UTC), once a day — every source, the rates, then the alerts. Tests pass `now`.
 */
export const costTick = async (deps: Deps & Pick<AppDeps, 'mailer'>, now = new Date()) => {
  const settings = await readCostSettings(deps.db);
  const state = await readState(deps.db);
  const day = today(now);
  if (now.getUTCHours() < settings.sync_hour || state.last_auto_day === day) return false;
  await writeState(deps.db, { ...state, last_auto_day: day });
  await runCostSync(deps, {}, now);
  if (settings.alerts) await sendCostAlerts(deps, now);
  return true;
};

// ---------------------------------------------------------------- pricing

const ruleOf = (r: CostPriceRow): PriceRule => ({
  id: r.id,
  metric: r.metric,
  service: r.service,
  price: r.price,
  currency: r.currency,
  freePerMonth: r.freePerMonth,
  effectiveFrom: r.effectiveFrom,
});

/** Recomputes the cost of every quantity in the whole months of [from, to] (free units count from the 1st). */
export const repriceRange = async (db: Db, from: string, to: string, metrics?: string[]) => {
  const start = `${from.slice(0, 7)}-01`;
  const end = `${to.slice(0, 7)}-${String(daysInMonth(to)).padStart(2, '0')}`;
  const rows = await quantityRows(db, start, end, metrics);
  if (!rows.length) return;
  const rules = (await listPriceRows(db)).map(ruleOf);
  const keyOf = (r: (typeof rows)[number]) => `${r.sourceId}|${r.day}|${r.metric}|${r.service}|${r.accountRef}`;
  const priced = priceEntries(
    rows.map((r) => ({ key: keyOf(r), day: r.day, metric: r.metric, service: r.service, quantity: r.quantity })),
    rules,
  );
  await writeCosts(
    db,
    rows.map((r) => {
      const p = priced.get(keyOf(r))!;
      return {
        source_id: r.sourceId,
        day: r.day,
        metric: r.metric,
        service: r.service,
        account_ref: r.accountRef,
        cost: p.cost,
        currency: p.currency,
      };
    }),
  );
};

const repriceMetric = async (db: Db, metric: string) => {
  const months = (await monthsWithMetric(db, metric)).sort();
  if (!months.length) return;
  const last = months[months.length - 1]!;
  await repriceRange(db, `${months[0]}-01`, `${last}-${String(daysInMonth(`${last}-01`)).padStart(2, '0')}`, [metric]);
};

const priceDto = (r: CostPriceRow): CostPrice => ({
  id: r.id,
  metric: r.metric,
  service: r.service,
  price: r.price,
  currency: r.currency,
  free_per_month: r.freePerMonth,
  effective_from: r.effectiveFrom,
  note: r.note,
  updated_at: r.updatedAt.toISOString(),
});

export const listCostPrices = async (deps: Pick<Deps, 'db'>) => ({
  data: (await listPriceRows(deps.db)).map(priceDto),
});

export const createCostPrice = async (deps: Deps, owner: SessionUser, raw: CostPriceInput) => {
  const input = costPriceInputSchema.parse(raw);
  const [row] = await insertPriceRow(deps.db, {
    id: newId(),
    metric: input.metric,
    service: input.service,
    price: input.price,
    currency: input.currency.toUpperCase(),
    freePerMonth: input.free_per_month,
    effectiveFrom: input.effective_from,
    note: input.note ?? null,
    updatedBy: owner.id,
  });
  if (!row) throw new AppError('conflict', 'cost_price_exists', { metric: input.metric });
  await repriceMetric(deps.db, row.metric);
  deps.logger.info({ owner: owner.id, metric: row.metric }, 'cost price added');
  return priceDto(row);
};

export const updateCostPrice = async (deps: Deps, owner: SessionUser, id: string, raw: CostPricePatch) => {
  const input = costPricePatchSchema.parse(raw);
  const current = await findPriceRow(deps.db, id);
  if (!current) throw new AppError('not_found', 'Cost price not found');
  let row: CostPriceRow | undefined;
  try {
    [row] = await updatePriceRow(deps.db, id, {
      ...(input.metric !== undefined ? { metric: input.metric } : {}),
      ...(input.service !== undefined ? { service: input.service } : {}),
      ...(input.price !== undefined ? { price: input.price } : {}),
      ...(input.currency !== undefined ? { currency: input.currency.toUpperCase() } : {}),
      ...(input.free_per_month !== undefined ? { freePerMonth: input.free_per_month } : {}),
      ...(input.effective_from !== undefined ? { effectiveFrom: input.effective_from } : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      updatedBy: owner.id,
    });
  } catch (err) {
    if ((err as { code?: string })?.code === '23505' || (err as { cause?: { code?: string } })?.cause?.code === '23505')
      throw new AppError('conflict', 'cost_price_exists', { metric: input.metric ?? current.metric });
    throw err;
  }
  await repriceMetric(deps.db, current.metric);
  if (row!.metric !== current.metric) await repriceMetric(deps.db, row!.metric);
  deps.logger.info({ owner: owner.id, id, fields: Object.keys(input) }, 'cost price updated');
  return priceDto(row!);
};

export const deleteCostPrice = async (deps: Deps, owner: SessionUser, id: string) => {
  const [row] = await deletePriceRow(deps.db, id);
  if (!row) throw new AppError('not_found', 'Cost price not found');
  await repriceMetric(deps.db, row.metric);
  deps.logger.info({ owner: owner.id, metric: row.metric }, 'cost price removed');
  return { ok: true as const };
};

// ---------------------------------------------------------------- exchange rates

/** Today's rates into the display currency from the chosen source (manual rates are read from the settings). */
export const refreshRates = async (deps: Deps, now = new Date()) => {
  const settings = await readCostSettings(deps.db);
  if (settings.fx_source === 'manual') return;
  const quote = settings.display_currency;
  const wanted = (await currenciesInUse(deps.db)).filter((c) => c !== quote);
  if (!wanted.length) return;
  const request = requestOf(deps);
  const rates: Record<string, number> = {};
  if (settings.fx_source === 'boi') {
    // Bank of Israel: shekels per unit of each currency; a non-shekel display currency is a cross rate.
    const res = await request('https://boi.org.il/PublicApi/GetExchangeRates', {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
    const list = (
      JSON.parse(res.body) as { exchangeRates?: { key: string; currentExchangeRate: number; unit: number }[] }
    ).exchangeRates;
    const ils = new Map((list ?? []).map((r) => [r.key, r.currentExchangeRate / (r.unit || 1)]));
    ils.set('ILS', 1);
    const q = ils.get(quote);
    if (!q) throw new AppError('unavailable', 'cost_fx_currency_unknown', { currency: quote });
    for (const c of wanted) {
      const v = ils.get(c);
      if (v) rates[c] = v / q;
    }
  } else {
    // Frankfurter (ECB reference rates): units of each currency per 1 display-currency unit.
    const res = await request(
      `https://api.frankfurter.dev/v1/latest?${new URLSearchParams({ base: quote, symbols: wanted.join(',') })}`,
      { method: 'GET', headers: { accept: 'application/json' } },
    );
    const body = JSON.parse(res.body) as { rates?: Record<string, number> };
    for (const [c, v] of Object.entries(body.rates ?? {})) if (v > 0) rates[c] = 1 / v;
  }
  await saveRates(deps.db, today(now), quote, settings.fx_source, rates);
  await writeState(deps.db, { ...(await readState(deps.db)), fx_updated_at: now.toISOString() });
};

/** Converts into the display currency: the rate of that day, else the nearest earlier, else the earliest known. */
const rateTable = async (db: Db, settings: CostSettings) => {
  const quote = settings.display_currency;
  const byCurrency = new Map<string, { day: string; rate: number }[]>();
  if (settings.fx_source !== 'manual')
    for (const r of await ratesFor(db, quote)) {
      const list = byCurrency.get(r.currency) ?? [];
      list.push({ day: r.day, rate: r.rate });
      byCurrency.set(r.currency, list);
    }
  return {
    currencies: () => [...new Set([...byCurrency.keys(), ...Object.keys(settings.fx_manual)])],
    rate: (currency: string, day: string): number | null => {
      if (currency === quote) return 1;
      const list = byCurrency.get(currency);
      if (list?.length) {
        let pick = list[0]!;
        for (const r of list) if (r.day <= day) pick = r;
        return pick.rate;
      }
      return settings.fx_manual[currency] ?? null;
    },
  };
};

// ---------------------------------------------------------------- reports

const assertRange = (from: string, to: string) => {
  if (from > to || dayRange(from, to).length > 400) throw new AppError('invalid_value', 'cost_range_invalid');
};

/** The rows of [from, to] in the display currency (rows in a currency with no rate are left out and listed). */
const loadConverted = async (db: Db, from: string, to: string) => {
  const settings = await readCostSettings(db);
  const rates = await rateTable(db, settings);
  const missing = new Set<string>();
  const rows = (await entriesBetween(db, from, to)).map((r) => {
    let money = 0;
    if (r.currency && r.cost) {
      const rate = rates.rate(r.currency, r.day);
      if (rate === null) missing.add(r.currency);
      else money = r.cost * rate;
    }
    return { ...r, money };
  });
  return { settings, rows, missing: [...missing].sort() };
};

const sumBy = <T>(rows: T[], key: (r: T) => string, value: (r: T) => number) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + value(r));
  return m;
};

export const costSummary = async (deps: Pick<Deps, 'db'>, from: string, to: string, now = new Date()) => {
  assertRange(from, to);
  const day = today(now);
  const span = dayRange(from, to).length;
  const prevFrom = addDays(from, -span);
  const monthStart = `${day.slice(0, 7)}-01`;
  const loadFrom = [prevFrom, monthStart, addDays(day, -7)].sort()[0]!;
  const loadTo = to > day ? to : day;
  const { settings, rows, missing } = await loadConverted(deps.db, loadFrom, loadTo);
  const inRange = rows.filter((r) => r.day >= from && r.day <= to);
  const sources = await listSourceRows(deps.db);

  const perDay = new Map<string, { day: string; by_source: Record<string, number>; total: number }>();
  for (const d of dayRange(from, to)) perDay.set(d, { day: d, by_source: {}, total: 0 });
  for (const r of inRange) {
    const d = perDay.get(r.day)!;
    d.by_source[r.sourceId] = round2((d.by_source[r.sourceId] ?? 0) + r.money);
    d.total = round2(d.total + r.money);
  }
  const allByDay = sumBy(
    rows,
    (r) => r.day,
    (r) => r.money,
  );
  const services = new Map<string, CostSummary['services'][number]>();
  for (const r of inRange) {
    const k = `${r.sourceId}|${r.service}|${r.metric}`;
    const s = services.get(k) ?? {
      source_id: r.sourceId,
      service: r.service,
      metric: r.metric,
      unit: r.unit,
      quantity: 0,
      total: 0,
      unpriced: false,
    };
    s.quantity += r.quantity;
    s.total += r.money;
    s.unpriced ||= !!r.unpriced;
    services.set(k, s);
  }
  const monthRows = rows.filter((r) => r.day >= monthStart && r.day <= day);
  const summary: CostSummary = {
    currency: settings.display_currency,
    from,
    to,
    total: round2(inRange.reduce((s, r) => s + r.money, 0)),
    previous_total: round2(rows.filter((r) => r.day >= prevFrom && r.day < from).reduce((s, r) => s + r.money, 0)),
    month_to_date: round2(monthRows.reduce((s, r) => s + r.money, 0)),
    month_forecast: monthForecast(allByDay, day),
    budget_monthly: settings.budget_monthly,
    days: [...perDay.values()],
    sources: sources.map((s) => {
      const mine = rows.filter((r) => r.sourceId === s.id);
      return {
        id: s.id,
        adapter: s.adapter as CostAdapter,
        name: s.name,
        total: round2(mine.filter((r) => r.day >= from && r.day <= to).reduce((a, r) => a + r.money, 0)),
        month_to_date: round2(mine.filter((r) => r.day >= monthStart && r.day <= day).reduce((a, r) => a + r.money, 0)),
        month_forecast: monthForecast(
          sumBy(
            mine,
            (r) => r.day,
            (r) => r.money,
          ),
          day,
        ),
        budget_monthly: s.budgetMonthly,
      };
    }),
    services: [...services.values()]
      .map((s) => ({ ...s, quantity: Math.round(s.quantity * 1000) / 1000, total: round2(s.total) }))
      .sort((a, b) => b.total - a.total || b.quantity - a.quantity),
    missing_rates: missing,
  };
  return summary;
};

/** Revenue per day of an account's plan, in the display currency (null = no paying plan). */
const dailyRevenue = (
  a: Awaited<ReturnType<typeof accountsWithPlans>>[number],
  rate: (currency: string) => number | null,
) => {
  if (!a.status || (a.status !== 'active' && a.status !== 'past_due') || !a.currency) return null;
  const minor = a.interval === 'year' ? (a.yearly ?? 0) / 12 : (a.monthly ?? 0);
  if (!(minor > 0)) return null;
  const seats = a.pricing === 'per_seat' ? Math.max(a.subSeats ?? a.seats, 1) : 1;
  const r = rate(a.currency);
  return r === null ? null : (((minor / 100) * seats * 12) / 365) * r;
};

export const costAccounts = async (deps: Pick<Deps, 'db'>, from: string, to: string): Promise<CostAccounts> => {
  assertRange(from, to);
  const { settings, rows } = await loadConverted(deps.db, from, to);
  const rates = await rateTable(deps.db, settings);
  const direct = sumBy(
    rows.filter((r) => r.accountRef),
    (r) => r.accountRef,
    (r) => r.money,
  );
  const shared = rows.filter((r) => !r.accountRef).reduce((s, r) => s + r.money, 0);
  const list = await accountsWithPlans(deps.db);
  const split = allocate(
    shared,
    list.map((a) => ({ id: a.id, direct: direct.get(a.id) ?? 0, seats: a.seats })),
    settings.allocation,
  );
  const days = dayRange(from, to).length;
  return {
    currency: settings.display_currency,
    from,
    to,
    allocation: settings.allocation,
    shared_total: round2(shared),
    data: list
      .map((a) => {
        const own = round2(direct.get(a.id) ?? 0);
        const part = split.get(a.id) ?? 0;
        const total = round2(own + part);
        const perDay = dailyRevenue(a, (c) => rates.rate(c, to));
        const revenue = perDay === null ? null : round2(perDay * days);
        return {
          account_id: a.id,
          name: a.name,
          direct: own,
          shared: part,
          total,
          revenue,
          margin: revenue === null ? null : round2(revenue - total),
          plan: a.planName ?? null,
        };
      })
      .sort((x, y) => y.total - x.total),
  };
};

// ---------------------------------------------------------------- alerts

const money = (n: number, currency: string, locale: string) => {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency, maximumFractionDigits: 2 }).format(n);
  } catch {
    return `${round2(n)} ${currency}`;
  }
};

/**
 * After the daily sync: a forecast over a budget (the platform's, a source's — once a month each), a spike (a day
 * costing `spike_factor` × the week before's average and more than `spike_min` — once a day), a source that failed
 * (once a day). Emails go to the platform owners and the extra addresses. Returns the alert keys sent.
 */
export const sendCostAlerts = async (deps: Deps & Pick<AppDeps, 'mailer'>, now = new Date()) => {
  const settings = await readCostSettings(deps.db);
  const day = today(now);
  const month = day.slice(0, 7);
  const summary = await costSummary(deps, addDays(day, -8), day, now);
  const cur = summary.currency;
  const due: { key: string; kind: 'budget' | 'spike' | 'failed'; vars: Record<string, string> }[] = [];
  const name = (s: { adapter: string; name: string | null }) => s.name ?? st(`costs.adapter.${s.adapter}`);

  if (settings.budget_monthly !== null && summary.month_forecast > settings.budget_monthly)
    due.push({
      key: `budget:all:${month}`,
      kind: 'budget',
      vars: {
        name: st('costs.alert.platform'),
        forecast: String(summary.month_forecast),
        budget: String(settings.budget_monthly),
      },
    });
  for (const s of summary.sources)
    if (s.budget_monthly !== null && s.month_forecast > s.budget_monthly)
      due.push({
        key: `budget:${s.id}:${month}`,
        kind: 'budget',
        vars: { name: name(s), forecast: String(s.month_forecast), budget: String(s.budget_monthly) },
      });
  if (settings.spike_factor !== null) {
    const yesterday = addDays(day, -1);
    const y = summary.days.find((d) => d.day === yesterday)?.total ?? 0;
    const week = summary.days.filter((d) => d.day < yesterday).slice(-7);
    const avg = week.reduce((s, d) => s + d.total, 0) / Math.max(week.length, 1);
    if (y > settings.spike_min && y > avg * settings.spike_factor)
      due.push({
        key: `spike:${yesterday}`,
        kind: 'spike',
        vars: { day: yesterday, amount: String(y), average: String(round2(avg)) },
      });
  }
  for (const s of await listSourceRows(deps.db))
    if (s.enabled && s.lastSyncOk === false)
      due.push({ key: `failed:${s.id}:${day}`, kind: 'failed', vars: { name: name(s) } });

  const state = await readState(deps.db);
  const sent = { ...(state.alerts ?? {}) };
  const fresh = due.filter((a) => !sent[a.key]);
  if (!fresh.length) return [];
  const to = [
    ...(await ownerEmails(deps.db)),
    ...settings.alert_emails.map((email) => ({ email, locale: null as string | null })),
  ];
  const url = await appLink(deps, '/owner?section=costs');
  for (const r of to) {
    try {
      const brand = await platformMailBrand(deps, r.locale);
      const l = brand.locale;
      const lines = fresh.map((a) => {
        const v = { ...a.vars };
        for (const k of ['forecast', 'budget', 'amount', 'average'] as const)
          if (v[k] !== undefined) v[k] = money(Number(v[k]), cur, l);
        return st(`costs.mail.${a.kind}`, v, l);
      });
      await deps.mailer.send(
        noticeEmail({
          to: r.email,
          brand,
          subject: st('costs.mail.subject', { product: brand.product }, l),
          title: st('costs.mail.title', {}, l),
          lines,
          cta: { label: st('costs.mail.cta', {}, l), url },
          reason: st('costs.mail.reason', { product: brand.product }, l),
        }),
      );
    } catch (err) {
      deps.logger.warn({ err }, 'costs: alert email failed');
    }
  }
  const stamp = now.toISOString();
  for (const a of fresh) sent[a.key] = stamp;
  // Keep two months of keys.
  const cutoff = addDays(day, -62);
  for (const [k, at] of Object.entries(sent)) if (at.slice(0, 10) < cutoff) delete sent[k];
  await writeState(deps.db, { ...(await readState(deps.db)), alerts: sent });
  return fresh.map((a) => a.key);
};
