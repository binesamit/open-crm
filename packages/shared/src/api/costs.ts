// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Platform costs (owner console → "Costs"): what running the platform costs — servers, file storage
 * AI, email, SMS — collected every day from cost sources the owner connects in the UI, priced from a unit-price
 * table the owner edits, shown in the owner's currency. Nothing about a provider, a price or a currency is fixed for
 * an installation: an adapter only knows how to read a provider's usage; the owner chooses what to connect and what
 * each unit costs (an adapter may suggest the provider's list price, which the owner accepts or changes).
 */

/** How a source is read. `internal` = what the platform measures itself; the others call out with the owner's key. */
export const COST_ADAPTERS = ['internal', 'railway', 'cloudflare_r2', 'http_json', 'recurring'] as const;
export type CostAdapter = (typeof COST_ADAPTERS)[number];

/** Units a quantity is counted in (labels in i18n `costs.unit.*`). */
export const COST_UNITS = [
  'call',
  'email',
  'segment',
  'message',
  'search',
  'run',
  'gb_month',
  'gb',
  'gb_minute',
  'vcpu_minute',
  'operation',
  'day',
  'amount',
] as const;
export type CostUnit = (typeof COST_UNITS)[number];

/** A metric key: `area.what` — `railway.cpu`, `email_sent`, `r2.class_a`. */
export const COST_METRIC_RE = /^[a-z][a-z0-9_.]{0,59}$/;
export const costMetricSchema = z.string().regex(COST_METRIC_RE);
export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .describe('ISO 4217 currency code');

/**
 * A metric an adapter reports. `direct`: the source reports money (AI spend, a fixed fee) — not priced from the
 * table. `suggested`: the provider's published list price at the time the adapter was written — offered to the owner
 * as a starting point (a "use suggested price" button), never applied on its own.
 */
export type CostMetricDef = {
  key: string;
  unit: CostUnit;
  direct?: boolean;
  suggested?: { price: number; currency: string; free_per_month?: number; source_url: string };
};

/** A setting of an adapter, rendered by the generic source form (labels in i18n `costs.field.*`). */
export type CostFieldDef = {
  key: string;
  kind: 'text' | 'url' | 'number' | 'currency' | 'date' | 'select';
  required?: boolean;
  options?: readonly string[];
  /** Shown as the field's placeholder (an example, not a default). */
  example?: string;
};

export type CostAdapterDef = {
  key: CostAdapter;
  /** The source needs a key (stored sealed, never shown again). */
  secret: boolean;
  /** Days before today it can read again (0 = only today — a source that reports a running total). */
  backfill: boolean;
  fields: readonly CostFieldDef[];
  metrics: readonly CostMetricDef[];
  /** Where the owner makes a read-only key (shown in the step-by-step help). */
  key_url?: string;
  /** Only one source of this adapter (the platform's own measurements). */
  single?: boolean;
};

const RAILWAY_PRICING = 'https://docs.railway.com/reference/pricing/plans';
const R2_PRICING = 'https://developers.cloudflare.com/r2/pricing/';

export const COST_ADAPTER_DEFS: Record<CostAdapter, CostAdapterDef> = {
  internal: {
    key: 'internal',
    secret: false,
    backfill: true,
    single: true,
    // AI on an account's own key is the account's spend, not the platform's: `platform` keeps only the platform's key.
    fields: [{ key: 'ai_scope', kind: 'select', options: ['all', 'platform'] }],
    metrics: [
      { key: 'ai', unit: 'call', direct: true },
      { key: 'email_sent', unit: 'email' },
      { key: 'sms_segments', unit: 'segment' },
      { key: 'web_search_calls', unit: 'search' },
      { key: 'storage', unit: 'gb_month' },
      { key: 'automation_runs', unit: 'run' },
    ],
  },
  railway: {
    key: 'railway',
    secret: true,
    backfill: true,
    key_url: 'https://railway.com/account/tokens',
    fields: [{ key: 'project_id', kind: 'text', required: true, example: 'a1b2c3d4-…' }],
    metrics: [
      {
        key: 'railway.cpu',
        unit: 'vcpu_minute',
        suggested: { price: 0.000463, currency: 'USD', source_url: RAILWAY_PRICING },
      },
      {
        key: 'railway.memory',
        unit: 'gb_minute',
        suggested: { price: 0.000231, currency: 'USD', source_url: RAILWAY_PRICING },
      },
      {
        key: 'railway.volume',
        unit: 'gb_minute',
        suggested: { price: 0.0000035, currency: 'USD', source_url: RAILWAY_PRICING },
      },
      { key: 'railway.backup', unit: 'gb_minute' },
      {
        key: 'railway.egress',
        unit: 'gb',
        suggested: { price: 0.05, currency: 'USD', source_url: RAILWAY_PRICING },
      },
    ],
  },
  cloudflare_r2: {
    key: 'cloudflare_r2',
    secret: true,
    backfill: true,
    key_url: 'https://dash.cloudflare.com/profile/api-tokens',
    fields: [
      { key: 'account_id', kind: 'text', required: true, example: '0123abcd…' },
      { key: 'bucket', kind: 'text' },
    ],
    metrics: [
      {
        key: 'r2.storage',
        unit: 'gb_month',
        suggested: { price: 0.015, currency: 'USD', free_per_month: 10, source_url: R2_PRICING },
      },
      {
        key: 'r2.class_a',
        unit: 'operation',
        suggested: { price: 0.0000045, currency: 'USD', free_per_month: 1_000_000, source_url: R2_PRICING },
      },
      {
        key: 'r2.class_b',
        unit: 'operation',
        suggested: { price: 0.00000036, currency: 'USD', free_per_month: 10_000_000, source_url: R2_PRICING },
      },
    ],
  },
  http_json: {
    key: 'http_json',
    secret: true,
    backfill: false,
    fields: [
      { key: 'url', kind: 'url', required: true, example: 'https://api.example.com/v1/usage' },
      { key: 'auth_header', kind: 'text', example: 'Authorization' },
      { key: 'auth_prefix', kind: 'text', example: 'Bearer ' },
      { key: 'amount_path', kind: 'text', required: true, example: 'data.total_usd' },
      { key: 'amount_mode', kind: 'select', required: true, options: ['month_to_date', 'day'] },
      { key: 'currency', kind: 'currency', required: true, example: 'USD' },
    ],
    metrics: [{ key: 'http_json', unit: 'amount', direct: true }],
  },
  recurring: {
    key: 'recurring',
    secret: false,
    backfill: true,
    fields: [
      { key: 'amount', kind: 'number', required: true, example: '20' },
      { key: 'currency', kind: 'currency', required: true, example: 'USD' },
      { key: 'period', kind: 'select', required: true, options: ['month', 'year'] },
      { key: 'starts_on', kind: 'date' },
      { key: 'ends_on', kind: 'date' },
    ],
    metrics: [{ key: 'recurring', unit: 'day', direct: true }],
  },
};

/** Every metric any adapter reports (the price table's metric picker). */
export const costMetricDefs = (): CostMetricDef[] => Object.values(COST_ADAPTER_DEFS).flatMap((d) => [...d.metrics]);
export const costMetricDef = (key: string) => costMetricDefs().find((m) => m.key === key);

// ---------------------------------------------------------------- sources

const configValue = z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]);
export const costSourceConfigSchema = z.record(z.string().regex(/^[a-z_]{1,40}$/), configValue);
export type CostSourceConfig = z.infer<typeof costSourceConfigSchema>;

export const costSourceInputSchema = z.object({
  adapter: z.enum(COST_ADAPTERS),
  name: z.string().trim().max(80).nullable().optional(),
  enabled: z.boolean().default(true),
  config: costSourceConfigSchema.default({}),
  /** Write-only. Empty string on a patch = remove the key. */
  secret: z.string().max(4000).optional(),
  /** A monthly budget for this source, in the display currency (null = none). */
  budget_monthly: z.number().min(0).max(1e9).nullable().optional(),
});
export type CostSourceInput = z.input<typeof costSourceInputSchema>;
/** No defaults: a patch changes only what it names. */
export const costSourcePatchSchema = z
  .object({
    name: z.string().trim().max(80).nullable(),
    enabled: z.boolean(),
    config: costSourceConfigSchema,
    secret: z.string().max(4000),
    budget_monthly: z.number().min(0).max(1e9).nullable(),
  })
  .partial();
export type CostSourcePatch = z.input<typeof costSourcePatchSchema>;

export const costSourceSchema = z.object({
  id: z.string(),
  adapter: z.enum(COST_ADAPTERS),
  name: z.string().nullable(),
  enabled: z.boolean(),
  config: costSourceConfigSchema,
  secret_set: z.boolean(),
  secret_hint: z.string().nullable(),
  budget_monthly: z.number().nullable(),
  last_sync_at: z.string().nullable(),
  last_sync_ok: z.boolean().nullable(),
  last_error: z.string().nullable(),
  /** A sync is queued or running. */
  syncing: z.boolean(),
  created_at: z.string(),
});
export type CostSource = z.infer<typeof costSourceSchema>;
export const costSourceListSchema = z.object({ data: z.array(costSourceSchema) });

export const costSyncInputSchema = z.object({
  source_id: z.string().min(1).max(26).optional(),
  /** Days back to read again (sources that can). */
  days: z.number().int().min(1).max(90).optional(),
});
export type CostSyncInput = z.infer<typeof costSyncInputSchema>;

export const costTestResultSchema = z.object({
  ok: z.boolean(),
  /** What a read of yesterday found (metric → quantity), to show the connection works. */
  sample: z.record(z.string(), z.number()).optional(),
  error: z.string().optional(),
});
export type CostTestResult = z.infer<typeof costTestResultSchema>;

// ---------------------------------------------------------------- unit prices

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const costPriceInputSchema = z.object({
  metric: costMetricSchema,
  /** A service name of the source (a Railway service, a bucket) or `*` for all. */
  service: z.string().trim().min(1).max(120).default('*'),
  price: z.number().min(0).max(1e9),
  currency: currencySchema,
  /** Units free every calendar month (a provider's free tier), counted across all sources and services. */
  free_per_month: z.number().min(0).max(1e15).default(0),
  effective_from: isoDay,
  note: z.string().trim().max(255).nullable().optional(),
});
export type CostPriceInput = z.input<typeof costPriceInputSchema>;
/** No defaults: a patch changes only what it names. */
export const costPricePatchSchema = z
  .object({
    metric: costMetricSchema,
    service: z.string().trim().min(1).max(120),
    price: z.number().min(0).max(1e9),
    currency: currencySchema,
    free_per_month: z.number().min(0).max(1e15),
    effective_from: isoDay,
    note: z.string().trim().max(255).nullable(),
  })
  .partial();
export type CostPricePatch = z.input<typeof costPricePatchSchema>;

export const costPriceSchema = z.object({
  id: z.string(),
  metric: z.string(),
  service: z.string(),
  price: z.number(),
  currency: z.string(),
  free_per_month: z.number(),
  effective_from: z.string(),
  note: z.string().nullable(),
  updated_at: z.string(),
});
export type CostPrice = z.infer<typeof costPriceSchema>;
export const costPriceListSchema = z.object({ data: z.array(costPriceSchema) });

// ---------------------------------------------------------------- settings

export const COST_FX_SOURCES = ['boi', 'frankfurter', 'manual'] as const;
export type CostFxSource = (typeof COST_FX_SOURCES)[number];
export const COST_ALLOCATIONS = ['usage', 'equal', 'seats'] as const;
export type CostAllocation = (typeof COST_ALLOCATIONS)[number];

/** The settings' fields (no defaults: a patch names only what it changes — zod applies a default inside `.partial()`). */
const costSettingsFields = z.object({
  display_currency: currencySchema,
  /** Where exchange rates come from: Bank of Israel (to ILS), Frankfurter (ECB rates, any pair) or the owner's own. */
  fx_source: z.enum(COST_FX_SOURCES),
  /** Manual rates: 1 unit of the currency = this many display-currency units. */
  fx_manual: z.record(currencySchema, z.number().positive().max(1e6)),
  /** The daily sync's hour, UTC (0–23). */
  sync_hour: z.number().int().min(0).max(23),
  /** Days the daily sync reads again (a provider may correct its last days). */
  sync_days: z.number().int().min(1).max(30),
  /** Days a newly connected source reads back at once (what the provider keeps). */
  backfill_days: z.number().int().min(1).max(90),
  /** How shared costs (servers, storage, fees) are split between accounts. */
  allocation: z.enum(COST_ALLOCATIONS),
  /** The whole platform's monthly budget in the display currency (null = none). */
  budget_monthly: z.number().min(0).max(1e9).nullable(),
  /** A day costing more than this many times the week before's daily average is a spike (null = no spike alerts). */
  spike_factor: z.number().min(1.1).max(100).nullable(),
  /** …and more than this amount (display currency), so small days never alert. */
  spike_min: z.number().min(0).max(1e9),
  alerts: z.boolean(),
  /** Platform owners get the alerts; plus these addresses. */
  alert_emails: z.array(z.email().max(254)).max(20),
});
export type CostSettings = z.infer<typeof costSettingsFields>;

/** A new installation's settings: shekels from the Bank of Israel, the sync at 03:00 UTC, alerts on. */
export const COST_SETTINGS_DEFAULTS: CostSettings = {
  display_currency: 'ILS',
  fx_source: 'boi',
  fx_manual: {},
  sync_hour: 3,
  sync_days: 3,
  backfill_days: 30,
  allocation: 'usage',
  budget_monthly: null,
  spike_factor: 2,
  spike_min: 10,
  alerts: true,
  alert_emails: [],
};

/** Stored settings over the defaults (a field stored with a bad value falls back to its default). */
export const readCostSettingsValue = (stored: unknown): CostSettings => {
  const raw = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
  const out: Record<string, unknown> = { ...COST_SETTINGS_DEFAULTS };
  for (const [k, field] of Object.entries(costSettingsFields.shape)) {
    const v = (field as z.ZodType).safeParse(raw[k]);
    if (k in raw && v.success) out[k] = v.data;
  }
  return out as CostSettings;
};

export const costSettingsSchema = costSettingsFields;
export const costSettingsPatchSchema = costSettingsFields.partial();
export type CostSettingsPatch = z.input<typeof costSettingsPatchSchema>;

export const costSettingsResponseSchema = costSettingsSchema.extend({
  /** The rates in use now: currency → display-currency units per 1 (from the chosen source). */
  fx_rates: z.record(z.string(), z.number()),
  fx_updated_at: z.string().nullable(),
});
export type CostSettingsResponse = z.infer<typeof costSettingsResponseSchema>;

// ---------------------------------------------------------------- reports

export const costRangeQuerySchema = z.object({ from: isoDay, to: isoDay });
export type CostRangeQuery = z.infer<typeof costRangeQuerySchema>;

const money = z.number();

export const costSummarySchema = z.object({
  currency: z.string(),
  from: z.string(),
  to: z.string(),
  total: money,
  /** The same number of days just before `from`. */
  previous_total: money,
  /** This calendar month so far, and the month's forecast (the last 7 days' daily average for the days left). */
  month_to_date: money,
  month_forecast: money,
  budget_monthly: z.number().nullable(),
  days: z.array(z.object({ day: z.string(), by_source: z.record(z.string(), money), total: money })),
  sources: z.array(
    z.object({
      id: z.string(),
      adapter: z.enum(COST_ADAPTERS),
      name: z.string().nullable(),
      total: money,
      month_to_date: money,
      month_forecast: money,
      budget_monthly: z.number().nullable(),
    }),
  ),
  services: z.array(
    z.object({
      source_id: z.string(),
      service: z.string(),
      metric: z.string(),
      unit: z.string(),
      quantity: z.number(),
      total: money,
      /** Quantities with no price in the table (their cost shows as 0). */
      unpriced: z.boolean(),
    }),
  ),
  /** Currencies with no exchange rate (amounts in them are left out of the totals). */
  missing_rates: z.array(z.string()),
});
export type CostSummary = z.infer<typeof costSummarySchema>;

export const costAccountsSchema = z.object({
  currency: z.string(),
  from: z.string(),
  to: z.string(),
  allocation: z.enum(COST_ALLOCATIONS),
  /** Costs no account caused directly (servers, storage, fees), split by `allocation`. */
  shared_total: money,
  data: z.array(
    z.object({
      account_id: z.string(),
      name: z.string(),
      direct: money,
      shared: money,
      total: money,
      /** What the account's plan charges for the same days (null = no paid plan). */
      revenue: z.number().nullable(),
      margin: z.number().nullable(),
      plan: z.string().nullable(),
    }),
  ),
});
export type CostAccounts = z.infer<typeof costAccountsSchema>;
