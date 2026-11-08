// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AiCapabilities,
  type AiManualModel,
  type AiModelList,
  type AiModelOption,
  type AiPriceOverride,
  type AiPriceRule,
  type AiProvider,
  aiModel,
  AppError,
  catalogueModels,
  mergeCapabilities,
  type ProviderModel,
  rankModels,
  resolveAiPrice,
  suggestModel,
} from '@bines/shared';
import type { AiConnectionSecret } from '@bines/server-ai';
import type { Db } from '../../db/client';
import type { AppDeps } from '../../types';
import { loadPlatformSettings } from '../platform/platform-settings';
import type { AiConnectionRow } from './ai.repo';
import { loadPriceTable } from './prices.service';

/**
 * The models an AI connection may use (Fix: "models from the companies' own sites, not from code";
 * any provider): read live from the provider with the connection's key (Anthropic / OpenAI / an
 * OpenAI-compatible server `GET /models`, Gemini's models list), cached per connection for an hour, newest first,
 * plus the models an admin added by hand. When the provider cannot be read the last list it gave (else the known
 * catalogue — Anthropic only) and the hand-added models stand in — kept only a few minutes so it is asked again soon.
 * Order (every provider alike): tool-calling models first, newest first (release date, else the name's version), the
 * most capable tier first. The default model: the connection's own, else the first suitable model of that order.
 * Prices: the connection's override → the owner's price table → the provider list's own price (OpenRouter) → null
 * ("מחיר לא ידוע").
 * Capabilities: the provider's defaults ← what its list says ← the admin's corrections on the connection.
 */
type Deps = Pick<AppDeps, 'aiClient' | 'secrets'> & Partial<Pick<AppDeps, 'logger' | 'db'>>;

export const MODELS_TTL_MS = 60 * 60 * 1000;
const FALLBACK_TTL_MS = 5 * 60 * 1000;

type Entry = {
  at: number;
  stamp: string;
  source: 'live' | 'fallback';
  models: ProviderModel[];
  /** The provider's last live list (same key / server): what a failed read keeps showing instead of losing it. */
  lastLive?: ProviderModel[];
};
const cache = new Map<string, Entry>();

/** Tests: forget every cached list. */
export const clearModelCache = () => cache.clear();

/**
 * Forget one connection's list (sync-ai): when its key changes or it is removed, the next picker asks the provider
 * again instead of showing the old key's models for up to an hour.
 */
export const forgetModels = (connectionId: string) => cache.delete(connectionId);

/**
 * The price a connection's cached provider list gives a model (OpenRouter), without asking the provider: the usage
 * report and a fallback model's cost use it next to the override / the table. Null = not listed or not cached.
 */
export const cachedListedPrice = (connectionId: string, model: string) =>
  cache.get(connectionId)?.models.find((m) => m.id === model)?.price ?? null;

/** Tests: whether a connection's list is cached. */
export const hasCachedModels = (connectionId: string) => cache.has(connectionId);

type ConnLike = Pick<AiConnectionRow, 'id' | 'provider' | 'keyEnc'> & { baseUrl?: string | null };

/** A new key or server = a new list. */
const stampOf = (row: ConnLike) => `${row.keyEnc.slice(-24)}|${row.baseUrl ?? ''}`;

/** Whether the platform owner allows AI connections to any private / local address (default: no). */
export const allowLocalAi = async (db: Db | undefined) =>
  db ? (await loadPlatformSettings(db)).ai.allow_local_endpoints : false;

/**
 * Whether a connection's server may sit on a private / local address: the owner allowed every such address, or
 * named this origin in the owner console's list (audit 2026-10-10 #19). Without a base URL (a hosted provider)
 * nothing private is dialled.
 */
export const localAiAllowedFor = async (db: Db | undefined, baseUrl: string | null | undefined) => {
  if (!db) return false;
  const ai = (await loadPlatformSettings(db)).ai;
  if (ai.allow_local_endpoints) return true;
  if (!baseUrl) return false;
  try {
    return ai.local_endpoint_origins.includes(new URL(baseUrl).origin.toLowerCase());
  } catch {
    return false;
  }
};

/** What the client factory needs for a connection: its provider, key, server and the private-address switch. */
export const secretOf = async (
  deps: Pick<Deps, 'secrets' | 'db'>,
  row: Pick<AiConnectionRow, 'provider' | 'keyEnc'> & { baseUrl?: string | null },
): Promise<AiConnectionSecret> => ({
  provider: row.provider as AiProvider,
  apiKey: deps.secrets.open(row.keyEnc),
  baseUrl: row.baseUrl ?? null,
  allowPrivate: await localAiAllowedFor(deps.db, row.baseUrl),
});

/** Reads the provider's list with a key; an empty or failed read falls back to the catalogue. */
export const readProviderModels = async (
  deps: Deps,
  secret: AiConnectionSecret,
): Promise<Pick<Entry, 'source' | 'models'>> => {
  try {
    const client = deps.aiClient(secret);
    const live = client.listModels ? await client.listModels() : [];
    if (live.length) return { source: 'live', models: live };
  } catch (err) {
    deps.logger?.warn(
      { provider: secret.provider, err: err instanceof Error ? err.message : String(err) },
      'ai models: list failed',
    );
  }
  return { source: 'fallback', models: catalogueModels(secret.provider) };
};

/** The connection's models, from the hour-long cache unless `refresh`. */
export const connectionModels = async (
  deps: Deps,
  row: ConnLike,
  opts: { refresh?: boolean; now?: number } = {},
): Promise<Entry> => {
  const now = opts.now ?? Date.now();
  const stamp = stampOf(row);
  const hit = cache.get(row.id);
  if (
    hit &&
    !opts.refresh &&
    hit.stamp === stamp &&
    now - hit.at < (hit.source === 'live' ? MODELS_TTL_MS : FALLBACK_TTL_MS)
  )
    return hit;
  const read = await readProviderModels(deps, await secretOf(deps, row));
  // A provider that fails now does not make the models it listed a moment ago disappear (new models stay shown).
  const lastLive = hit?.stamp === stamp ? (hit.source === 'live' ? hit.models : hit.lastLive) : undefined;
  const entry: Entry =
    read.source === 'live' || !lastLive?.length
      ? { at: now, stamp, ...read }
      : { at: now, stamp, source: 'fallback', models: lastLive, lastLive };
  cache.set(row.id, entry);
  return entry;
};

/** Seeds the cache right after a connection is saved (its list was just read with the same key). */
export const rememberModels = (row: ConnLike, read: Pick<Entry, 'source' | 'models'>, now = Date.now()) =>
  cache.set(row.id, { at: now, stamp: stampOf(row), ...read });

export const overridesOf = (row: Pick<AiConnectionRow, 'priceOverrides'>): Record<string, AiPriceOverride> =>
  (row.priceOverrides ?? {}) as Record<string, AiPriceOverride>;

export const manualOf = (row: Pick<AiConnectionRow, 'manualModels'>): AiManualModel[] =>
  (row.manualModels ?? []) as AiManualModel[];

/** The provider's list ∪ the hand-added models (a hand-added entry of a listed model only corrects it). */
export const withManual = (
  entry: Pick<Entry, 'models'>,
  manual: AiManualModel[],
): (ProviderModel & { manual: boolean; corrections?: AiManualModel['capabilities'] })[] => {
  const byId = new Map(manual.map((m) => [m.id, m]));
  const listed = entry.models.map((m) => ({ ...m, manual: false, corrections: byId.get(m.id)?.capabilities }));
  const added = manual
    .filter((m) => !entry.models.some((x) => x.id === m.id))
    .map((m) => ({
      id: m.id,
      display_name: m.display_name || m.id,
      created_at: null,
      manual: true,
      corrections: m.capabilities,
    }));
  return [...listed, ...added];
};

export const capabilitiesOf = (
  provider: string,
  model: Pick<ProviderModel, 'id' | 'capabilities'> & { corrections?: AiManualModel['capabilities'] },
): AiCapabilities => mergeCapabilities(provider as AiProvider, model.id, model.capabilities, model.corrections);

/** The connection's models (listed ∪ by hand) with what each can do, in the pickers' order. */
export const rankedModels = (entry: Pick<Entry, 'models'>, row: Pick<AiConnectionRow, 'provider' | 'manualModels'>) =>
  rankModels(withManual(entry, manualOf(row)).map((m) => ({ ...m, capabilities: capabilitiesOf(row.provider, m) })));

/**
 * The model a call uses when none is chosen: the connection's default (for images: when it makes images), else the
 * first suitable model of the ranked list — never a model id fixed in code. Null = the list has none.
 */
export const defaultModelOf = (
  entry: Pick<Entry, 'models'>,
  row: Pick<AiConnectionRow, 'provider' | 'manualModels' | 'defaultModel'>,
  need: 'tools' | 'image' = 'tools',
): string | null => {
  const ranked = rankedModels(entry, row);
  if (row.defaultModel) {
    if (need === 'tools') return row.defaultModel;
    const own = ranked.find((m) => m.id === row.defaultModel);
    if (own?.capabilities.image_generation) return own.id;
  }
  return suggestModel(ranked, need)?.id ?? null;
};

/** The connection's default model, read from its (cached) list when it has none set. */
export const connectionDefaultModel = async (
  deps: Deps,
  row: AiConnectionRow,
  need: 'tools' | 'image' = 'tools',
): Promise<string | null> =>
  need === 'tools' && row.defaultModel
    ? row.defaultModel
    : defaultModelOf(await connectionModels(deps, row), row, need);

/**
 * The picker's options: every model with its price (or null = "מחיר לא ידוע" — never hidden), capabilities and the
 * default (the connection's, else the suggested one) marked, in the pickers' order.
 */
export const modelOptions = (
  entry: Pick<Entry, 'models'>,
  row: Pick<AiConnectionRow, 'priceOverrides' | 'defaultModel' | 'provider' | 'manualModels'>,
  table: readonly AiPriceRule[],
): AiModelOption[] => {
  const def = defaultModelOf(entry, row);
  return rankedModels(entry, row).map((m) => {
    const p = resolveAiPrice(row.provider, m.id, overridesOf(row), table, m.price);
    return {
      id: m.id,
      display_name: m.display_name,
      created_at: m.created_at,
      price: p ? { input: p.price.input, output: p.price.output } : null,
      price_source: p?.source ?? null,
      default: m.id === def,
      capabilities: m.capabilities,
      manual: m.manual,
    };
  });
};

export const modelList = (
  entry: Pick<Entry, 'models' | 'source' | 'at'>,
  row: Pick<AiConnectionRow, 'priceOverrides' | 'defaultModel' | 'provider' | 'manualModels'>,
  table: readonly AiPriceRule[],
): AiModelList => ({
  data: modelOptions(entry, row, table),
  source: entry.source,
  fetched_at: new Date(entry.at).toISOString(),
  default_model: defaultModelOf(entry, row),
  default_auto: !row.defaultModel,
});

/** A model the connection may be set to: on its (cached) list, or added by hand. */
export const assertListedModel = (
  entry: Pick<Entry, 'models'>,
  model: string | null | undefined,
  manual: AiManualModel[] = [],
) => {
  if (!model) return;
  if (!entry.models.some((m) => m.id === model) && !manual.some((m) => m.id === model))
    throw new AppError('invalid_value', 'unknown_model', { model });
};

/**
 * What a call needs to know of its model: listed (live, catalogue or by hand), what the request may ask of it, what
 * it can do, its price. A catalogue model is always callable (it was valid when chosen); anything else must be listed.
 */
export const modelForCall = async (deps: Deps & Pick<AppDeps, 'db'>, row: AiConnectionRow, model: string) => {
  const known = aiModel(model);
  if (known && known.provider !== row.provider) throw new AppError('invalid_value', 'unknown_model', { model });
  const entry = await connectionModels(deps, row);
  const listed = withManual(entry, manualOf(row)).find((m) => m.id === model);
  if (!known && !listed) throw new AppError('invalid_value', 'unknown_model', { model });
  const table = await loadPriceTable(deps.db);
  const price = resolveAiPrice(row.provider, model, overridesOf(row), table, listed?.price);
  return {
    supports: known ? undefined : listed?.supports,
    capabilities: capabilitiesOf(row.provider, listed ?? { id: model }),
    price: price?.price ?? null,
    table,
  };
};
