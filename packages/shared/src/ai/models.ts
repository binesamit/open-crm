// SPDX-License-Identifier: AGPL-3.0-only
/**
 * AI providers, models, capabilities and prices (the planning notes "AGENTS-MCP" §3.2, D26; product items "AI to any
 * provider" and "dynamic AI prices"). Prices are DATA: the platform owner's price table (owner console →
 * "AI prices", table `ai_prices`, seeded by a migration) and each connection's own overrides — never a table in code.
 * Costs are always computed from a response's real `usage` (never estimated).
 */
export const AI_PROVIDERS = ['anthropic', 'openai', 'gemini', 'openai_compatible', 'soniox'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * How a provider is connected: whether the connection needs a base URL (an OpenAI-compatible server — Mistral, Groq,
 * OpenRouter, DeepSeek, a local Ollama / LM Studio) and whether a key is required (a local server may need none).
 * Whether the provider has a live model list is answered by trying it (`GET /models`); a connection can always add
 * models by hand.
 */
export const AI_PROVIDER_INFO: Record<
  AiProvider,
  {
    baseUrl: boolean;
    keyRequired: boolean;
    /** Chat models (agents, assistant, AI columns, images): false = a speech-only provider (Soniox). */
    chat: boolean;
    /** Speech to text (recordings in updates). */
    transcription: boolean;
  }
> = {
  anthropic: { baseUrl: false, keyRequired: true, chat: true, transcription: false },
  openai: { baseUrl: false, keyRequired: true, chat: true, transcription: true },
  gemini: { baseUrl: false, keyRequired: true, chat: true, transcription: false },
  openai_compatible: { baseUrl: true, keyRequired: false, chat: true, transcription: true },
  soniox: { baseUrl: false, keyRequired: true, chat: false, transcription: true },
};

/** The providers with chat models — what the connection pickers of chat features offer. */
export const isChatProvider = (p: AiProvider) => AI_PROVIDER_INFO[p]?.chat !== false;
/** The providers that turn speech into text. */
export const isTranscriptionProvider = (p: AiProvider) => AI_PROVIDER_INFO[p]?.transcription === true;
export const AI_CHAT_PROVIDERS = AI_PROVIDERS.filter(isChatProvider);

/**
 * Known OpenAI-compatible servers (OpenRouter): one click in the connection dialog fills the base
 * URL (and the name, when empty). Suggestions only — the field stays free for any other server; nothing else
 * depends on them (the model list is still read from the server's own `GET /models`).
 */
export const AI_COMPATIBLE_PRESETS: readonly { id: string; name: string; baseUrl: string; keyRequired: boolean }[] = [
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyRequired: true },
  { id: 'groq', name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyRequired: true },
  { id: 'mistral', name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyRequired: true },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyRequired: true },
  { id: 'together', name: 'Together AI', baseUrl: 'https://api.together.xyz/v1', keyRequired: true },
  { id: 'ollama', name: 'Ollama', baseUrl: 'http://localhost:11434/v1', keyRequired: false },
];

/**
 * What a model can do. Features that need tools (agents, assistant writes, the flows AI builder, MCP-style tools)
 * refuse a model without `tools`; the UI marks every limited capability. `max_context` = input tokens (null = unknown).
 */
export type AiCapabilities = {
  tools: boolean;
  vision: boolean;
  json: boolean;
  streaming: boolean;
  max_context: number | null;
  /**
   * Makes images (AI images): the "generate image" tool and automation action and AI columns with image
   * output refuse a model without it. Not a "limited" badge — a text model is not limited for lacking it; the UI
   * shows an "images" badge on the models that have it.
   */
  image_generation: boolean;
};
export const AI_CAPABILITY_FLAGS = ['tools', 'vision', 'json', 'streaming'] as const;

/**
 * Image models by name — the providers' lists do not say which models make images: OpenAI's `gpt-image-*` /
 * `dall-e-*`, Gemini's `…-image…` models and Imagen. Only the starting guess: an admin corrects any model (or marks
 * one of an OpenAI-compatible server) in the connection's model capabilities.
 */
export const isImageModelId = (provider: AiProvider, modelId: string) =>
  provider === 'openai'
    ? /^(gpt-image|chatgpt-image|dall-e)/i.test(modelId)
    : provider === 'gemini'
      ? /^imagen|-image(-|$)/i.test(modelId)
      : false;

/** Models that only make images (no chat): Imagen, gpt-image, DALL·E. */
const imageOnly = (provider: AiProvider, modelId: string) =>
  isImageModelId(provider, modelId) && !(provider === 'gemini' && /^gemini/i.test(modelId));

/**
 * A provider's defaults, before what its live list says and what an admin set on the connection. An unknown
 * OpenAI-compatible server is assumed to take tools and stream (most do); an admin corrects a model that does not.
 */
export const defaultCapabilities = (provider: AiProvider, modelId: string): AiCapabilities => {
  const base: AiCapabilities = {
    tools: true,
    vision: true,
    json: true,
    streaming: true,
    max_context: null,
    image_generation: false,
  };
  if (imageOnly(provider, modelId))
    return { ...base, tools: false, vision: false, json: false, streaming: false, image_generation: true };
  // Gemini's image models answer in text and images, without tool calls.
  if (isImageModelId(provider, modelId)) return { ...base, tools: false, image_generation: true };
  if (provider === 'openai_compatible') return { ...base, vision: false };
  if (provider === 'gemini' && /gemma/i.test(modelId)) return { ...base, tools: false };
  return base;
};

/** Defaults ← the live list's answer ← the connection's own corrections (each only for what it says). */
export const mergeCapabilities = (
  provider: AiProvider,
  modelId: string,
  ...layers: (Partial<AiCapabilities> | null | undefined)[]
): AiCapabilities => {
  const out = defaultCapabilities(provider, modelId);
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer) as [keyof AiCapabilities, unknown][]) {
      if (v === undefined) continue;
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
};

/**
 * Anthropic's known models — only the Anthropic adapter's own defaults: the offline fallback of its model list (when
 * Anthropic cannot be read) and what its requests may ask of them. Never a default elsewhere: every provider's
 * pickers and default model come from the connection's live list. Prices live in the price table.
 */
export type AiModel = {
  id: string;
  provider: AiProvider;
  name: { he: string; en: string };
  /** The adapter's first choice when Anthropic's live list cannot be read (D26). */
  default?: boolean;
  /**
   * What the request may ask of the model (agents, מ6): adaptive thinking + `output_config.effort`, and the
   * server-side refusal fallback (`fallbacks: "default"`). Older models take neither.
   */
  supports?: { adaptiveThinking?: boolean; effort?: boolean; fallbacks?: boolean };
};

const CURRENT = { adaptiveThinking: true, effort: true, fallbacks: true };

export const AI_MODELS: readonly AiModel[] = [
  {
    id: 'claude-opus-5-5',
    provider: 'anthropic',
    name: { he: 'Claude Opus 5.5 — הכי חכם', en: 'Claude Opus 5.5 — most capable' },
    default: true,
    supports: CURRENT,
  },
  {
    id: 'claude-sonnet-5-5',
    provider: 'anthropic',
    name: { he: 'Claude Sonnet 5.5 — מהיר וזול', en: 'Claude Sonnet 5.5 — fast and cheaper' },
    supports: CURRENT,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    name: { he: 'Claude Haiku 4.5 — הכי זול', en: 'Claude Haiku 4.5 — cheapest' },
  },
];

export const aiModel = (id: string): AiModel | undefined => AI_MODELS.find((m) => m.id === id);

/** Token counts as a provider reports them (Anthropic's names; other providers are mapped onto them). */
export type AiUsage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

/**
 * USD per 1M tokens; image models (AI images) also per image: `perImage` = every image, `imagePrices` = by size and /
 * or quality (`1024x1024/high`, `1024x1024`, `high` — the most specific key that matches wins).
 */
export type AiPrice = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  perImage?: number | null;
  imagePrices?: Record<string, number> | null;
};

/**
 * A price an admin set on a connection (Fix: ): USD per 1M input / output tokens, and optionally cache reads /
 * writes. Cache prices not given cost as much as input (no discount is assumed).
 */
export type AiPriceOverride = { input: number; output: number; cache_read?: number; cache_write?: number };
export const priceFromOverride = (o: AiPriceOverride): AiPrice => ({
  input: o.input,
  output: o.output,
  cacheRead: o.cache_read ?? o.input,
  cacheWrite: o.cache_write ?? o.input,
});

/**
 * One row of the platform's price table (owner console → AI prices): a provider (or `*` = any) and a model — an
 * exact id, or a pattern with `*` wildcards (`gpt-5*`, `*-mini`). Cache prices null = as much as input.
 */
export type AiPriceRule = {
  provider: string;
  model: string;
  input: number;
  output: number;
  cache_read: number | null;
  cache_write: number | null;
  /** USD per image (image models); null / absent = priced by tokens only. */
  per_image?: number | null;
  /** USD per image by size / quality (`1024x1024/high`, `1024x1024`, `high`). */
  image_prices?: Record<string, number> | null;
};

const globRe = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split('*')
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
    'i',
  );

/** Whether a price-table model pattern matches a model id (exact ids match only themselves, case-insensitively). */
export const priceRuleMatches = (pattern: string, modelId: string) =>
  pattern.includes('*') ? globRe(pattern).test(modelId) : pattern.toLowerCase() === modelId.toLowerCase();

const ruleToPrice = (r: AiPriceRule): AiPrice => ({
  input: r.input,
  output: r.output,
  cacheRead: r.cache_read ?? r.input,
  cacheWrite: r.cache_write ?? r.input,
  perImage: r.per_image ?? null,
  imagePrices: r.image_prices ?? null,
});

/** `provider` = the price the provider's own model list gives (OpenRouter lists one per model). */
export type AiPriceSource = 'override' | 'table' | 'provider';

/**
 * The price of a model. Precedence: the connection's override → the owner's table, exact model id (this provider
 * before `*`) → the table's patterns (the most specific — longest — pattern first; this provider before `*`) → the
 * price on the provider's own model list (`listed`,: OpenRouter prices every model) → null = "מחיר לא
 * ידוע" (a call is then recorded at 0 and flagged until a price is set).
 */
export const resolveAiPrice = (
  provider: string,
  modelId: string,
  overrides: Record<string, AiPriceOverride> | null | undefined,
  table: readonly AiPriceRule[],
  listed?: ProviderPrice | null,
): { price: AiPrice; source: AiPriceSource; rule: string | null } | null => {
  const o = overrides?.[modelId];
  if (o) return { price: priceFromOverride(o), source: 'override', rule: null };
  const forProvider = table.filter((r) => r.provider === provider || r.provider === '*');
  const rank = (r: AiPriceRule) => (r.provider === provider ? 0 : 1);
  const exact = forProvider
    .filter((r) => !r.model.includes('*') && priceRuleMatches(r.model, modelId))
    .sort((a, b) => rank(a) - rank(b))[0];
  if (exact) return { price: ruleToPrice(exact), source: 'table', rule: exact.model };
  const pattern = forProvider
    .filter((r) => r.model.includes('*') && priceRuleMatches(r.model, modelId))
    .sort((a, b) => b.model.replace(/\*/g, '').length - a.model.replace(/\*/g, '').length || rank(a) - rank(b))[0];
  if (pattern) return { price: ruleToPrice(pattern), source: 'table', rule: pattern.model };
  return listed
    ? {
        price: {
          input: listed.input,
          output: listed.output,
          cacheRead: listed.cache_read ?? listed.input,
          cacheWrite: listed.cache_write ?? listed.input,
        },
        source: 'provider',
        rule: null,
      }
    : null;
};

/** A price as a provider's model list gives it: USD per 1M tokens (cache prices when it lists them). */
export type ProviderPrice = { input: number; output: number; cache_read?: number | null; cache_write?: number | null };

/**
 * A model as the provider lists it right now (Fix: , "models from the provider's site, not from code"):
 * id, display name, release date, what the request may ask of it and what it can do (as far as the list says).
 */
export type ProviderModel = {
  id: string;
  display_name: string;
  /** ISO date-time of the release (the provider's `created_at`), or null when unknown. */
  created_at: string | null;
  supports?: AiModel['supports'];
  capabilities?: Partial<AiCapabilities>;
  /** The price the list gives (OpenRouter), the last fallback of `resolveAiPrice`. */
  price?: ProviderPrice;
};

/** Newest first (by release date; unknown dates last), then by id — a stable order for every picker. */
export const newestFirst = <T extends { id: string; created_at: string | null }>(models: T[]): T[] =>
  [...models].sort((a, b) => {
    const at = a.created_at ? Date.parse(a.created_at) || 0 : 0;
    const bt = b.created_at ? Date.parse(b.created_at) || 0 : 0;
    return bt - at || a.id.localeCompare(b.id);
  });

/**
 * The version a model's name carries (`gemini-2.5-pro` → 2.5, `claude-opus-4-5` → 4.5, `gpt-4o` → 4, `llama3.1:8b` →
 * 3.1); 0 when none. Orders a list the provider gives without release dates (Gemini) — newest family first.
 */
export const modelVersion = (id: string): number => {
  const name = id.slice(id.lastIndexOf('/') + 1).toLowerCase();
  const m = /(?:^|[^\d.])(\d{1,2})(?:[.-](\d)(?!\d))?(?!\d)/.exec(name);
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) : 0;
};

/** How capable a model looks by its name (lower = more): flagship → (unmarked) → small → tiny. */
export const modelTier = (id: string): number => {
  const s = id.toLowerCase();
  const word = (w: string) => new RegExp(`(^|[-_.:/ ])(${w})([-_.:/ ]|$)`).test(s);
  if (word('nano|tiny|lite|1b|3b|7b|8b')) return 3;
  if (word('mini|small|haiku|flash|instant')) return 2;
  if (word('opus|pro|ultra|large|max')) return 0;
  return 1;
};

/** A preview / experimental model (offered after the stable one of the same family and date). */
export const isPreviewModel = (id: string) =>
  /(^|[-_.:/])(preview|exp|experimental|beta|alpha)([-_.:/]|\d|$)/i.test(id);

/**
 * The order of every model picker (product decision: "dynamic like Claude, for every provider"): models that call
 * tools first, then other text models, image-only models last; within each, the newest first — by the provider's
 * release date when it gives one (by day, so a family released together stays together), else by the version in the
 * name — then the most capable tier, stable before preview, and the id.
 */
export const rankModels = <
  T extends { id: string; created_at: string | null; capabilities?: Partial<AiCapabilities> | null },
>(
  models: readonly T[],
): T[] => {
  const keyOf = (m: T) => {
    const t = m.created_at ? Date.parse(m.created_at) : NaN;
    const caps = m.capabilities ?? {};
    return {
      group: caps.tools === false ? (caps.image_generation ? 2 : 1) : 0,
      dated: Number.isFinite(t) ? 0 : 1,
      day: Number.isFinite(t) ? Math.floor(t / 86_400_000) : 0,
      version: modelVersion(m.id),
      tier: modelTier(m.id),
      preview: isPreviewModel(m.id) ? 1 : 0,
    };
  };
  const keys = new Map(models.map((m) => [m, keyOf(m)]));
  return [...models].sort((a, b) => {
    const x = keys.get(a)!;
    const y = keys.get(b)!;
    return (
      x.group - y.group ||
      x.dated - y.dated ||
      y.day - x.day ||
      y.version - x.version ||
      x.tier - y.tier ||
      x.preview - y.preview ||
      a.id.localeCompare(b.id)
    );
  });
};

/**
 * The model a connection uses when none is set on it (or by the caller): the first of the ranked list that fits —
 * calls tools (chat features) or makes images — a stable one before a preview. Null = the list has none.
 */
export const suggestModel = <T extends { id: string; capabilities: AiCapabilities }>(
  ranked: readonly T[],
  need: 'tools' | 'image' = 'tools',
): T | null => {
  const fits = ranked.filter((m) => (need === 'image' ? m.capabilities.image_generation : m.capabilities.tools));
  return fits.find((m) => !isPreviewModel(m.id)) ?? fits[0] ?? null;
};

/** The known models in the provider-list shape — the offline fallback when the live list cannot be read. */
export const catalogueModels = (provider: AiProvider = 'anthropic'): ProviderModel[] =>
  AI_MODELS.filter((m) => m.provider === provider).map((m) => ({
    id: m.id,
    display_name: m.name.en.split(' — ')[0]!,
    created_at: null,
    supports: m.supports,
  }));

/** The cost of one call in USD, from its usage and its price; no price (unknown) costs 0 and is flagged by the caller. */
export const aiCost = (usage: AiUsage, price: AiPrice | null | undefined): number => {
  if (!price) return 0;
  const per = (tokens: number | null | undefined, p: number) => ((tokens ?? 0) * p) / 1_000_000;
  const usd =
    per(usage.input_tokens, price.input) +
    per(usage.output_tokens, price.output) +
    per(usage.cache_read_input_tokens, price.cacheRead) +
    per(usage.cache_creation_input_tokens, price.cacheWrite);
  // Stored as numeric(12,6): round to a millionth of a dollar.
  return Math.round(usd * 1_000_000) / 1_000_000;
};

/**
 * Suggested image sizes / qualities for the pickers (AI images). Not a closed list: any `WxH` / quality word the
 * provider takes is accepted; the provider refuses what its model does not (the error says so).
 */
export const AI_IMAGE_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536', '1792x1024', '1024x1792'] as const;
export const AI_IMAGE_QUALITIES = ['auto', 'low', 'medium', 'high', 'standard', 'hd'] as const;
export const AI_IMAGE_SIZE_RE = /^(auto|\d{2,5}x\d{2,5})$/;
export const AI_IMAGE_QUALITY_RE = /^[a-z]{1,16}$/;
/** A price-table key of a per-image price: `<size>/<quality>`, `<size>` or `<quality>`. */
export const AI_IMAGE_PRICE_KEY_RE = /^((auto|\d{2,5}x\d{2,5})(\/[a-z]{1,16})?|[a-z]{1,16})$/;

/** The price of one image of this size / quality: the most specific `imagePrices` key, else `perImage`; null = none. */
export const perImagePrice = (
  price: AiPrice | null | undefined,
  size: string | null | undefined,
  quality: string | null | undefined,
): number | null => {
  if (!price) return null;
  const table = price.imagePrices ?? {};
  const keys = [size && quality ? `${size}/${quality}` : null, size ?? null, quality ?? null];
  for (const k of keys) if (k && typeof table[k] === 'number') return table[k];
  return typeof price.perImage === 'number' ? price.perImage : null;
};

/**
 * The cost of an image call in USD: per image when the price has one (size / quality aware), else from the tokens
 * the provider reported (gpt-image bills tokens) — never both, so a price row prices images one way. No price = 0
 * (flagged by the caller, like any unpriced model).
 */
export const aiImageCost = (
  price: AiPrice | null | undefined,
  call: { size?: string | null; quality?: string | null; count: number },
  usage?: AiUsage | null,
): number => {
  if (!price) return 0;
  const each = perImagePrice(price, call.size, call.quality);
  const usd = each !== null ? each * call.count : usage ? aiCost(usage, price) : 0;
  return Math.round(usd * 1_000_000) / 1_000_000;
};

/**
 * The price of a transcription: a per-minute price when the price table or the connection has one (the
 * `minute` key among the per-unit prices), else the tokens the provider reports; 0 when neither is known.
 */
export const aiTranscriptionCost = (
  price: AiPrice | null | undefined,
  call: { durationSeconds: number | null; usage: AiUsage | null },
): number => {
  if (!price) return 0;
  const perMinute = price.imagePrices?.minute;
  const usd =
    typeof perMinute === 'number' && call.durationSeconds !== null
      ? (perMinute * call.durationSeconds) / 60
      : call.usage
        ? aiCost(call.usage, price)
        : 0;
  return Math.round(usd * 1_000_000) / 1_000_000;
};
