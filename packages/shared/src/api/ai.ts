// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { patchOf } from '../account/settings';
import { AI_IMAGE_PRICE_KEY_RE, AI_IMAGE_QUALITY_RE, AI_IMAGE_SIZE_RE, AI_PROVIDERS } from '../ai/models';

/** What a model can do (AI providers): tools, images, JSON output, streaming, input context. */
export const aiCapabilitiesSchema = z.object({
  tools: z.boolean(),
  vision: z.boolean(),
  json: z.boolean(),
  streaming: z.boolean(),
  max_context: z.number().int().nullable(),
  /** Makes images (AI images): the "images" badge; the image tool / action / AI column output need it. */
  image_generation: z.boolean(),
});

/** An image size (`1024x1024`, `auto`) and quality (`high`, `hd`, `auto`) — any the provider takes (AI images). */
export const aiImageSizeSchema = z.string().trim().regex(AI_IMAGE_SIZE_RE, 'ai_image_size_invalid');
export const aiImageQualitySchema = z.string().trim().regex(AI_IMAGE_QUALITY_RE, 'ai_image_quality_invalid');
/** At most this many images per call (a code cap; the account's `images.max_images` is the setting under it). */
export const AI_IMAGES_MAX_PER_CALL = 4;
/** At most this many AI image runs of one account side by side (`images.concurrency`). */
export const AI_IMAGES_MAX_CONCURRENCY = 4;

/**
 * AI images: the connection + model that make images for the "generate image" tool (assistant, agents
 * MCP) and the automation action when it names none, and the default size / quality — all chosen by an admin in
 * Administration → AI. Nothing generates until a connection with an image model is chosen.
 */
export const aiImagesSettingsSchema = z.object({
  connection_id: z.string().max(26).nullable().default(null),
  model: z.string().max(80).nullable().default(null),
  size: aiImageSizeSchema.default('1024x1024'),
  quality: aiImageQualitySchema.default('auto'),
  /** Images one call may ask for. */
  max_images: z.number().int().min(1).max(AI_IMAGES_MAX_PER_CALL).default(1),
  /**
   * AI image column runs made at the same time in the account (the images queue): each run makes its
   * designs one after the other; at most this many runs go side by side (1 = one image at a time — the safest for a
   * provider's rate limit).
   */
  concurrency: z.number().int().min(1).max(AI_IMAGES_MAX_CONCURRENCY).default(1),
});
export type AiImagesSettings = z.infer<typeof aiImagesSettingsSchema>;

/** The longest recording the account allows (`voice.max_seconds`), and its bounds. */
export const VOICE_MAX_SECONDS_LIMIT = 3600;

/**
 * Voice in updates, Administration → AI → "Voice and transcription": recording a voice message in the
 * update composer (a normal audio file, played in place) and turning it into text with a speech-to-text connection
 * the admin picks (Soniox, OpenAI, an OpenAI-compatible server) — no connection is assumed. Transcription is an AI
 * cost: AI on, the plan and the budget apply, and it lands in AI usage.
 */
export const aiVoiceSettingsSchema = z.object({
  /** The microphone button in the update composer. Costs nothing (no AI). */
  recording: z.boolean().default(true),
  /** A recording stops by itself after this long. */
  max_seconds: z.number().int().min(10).max(VOICE_MAX_SECONDS_LIMIT).default(600),
  /** Speech to text — off until an admin turns it on and picks a connection. */
  transcription: z.boolean().default(false),
  connection_id: z.string().max(26).nullable().default(null),
  /** null = the connection's newest speech-to-text model. */
  model: z.string().max(80).nullable().default(null),
  /** A language hint (ISO 639-1, e.g. `he`); null = the provider detects it. */
  language: z
    .string()
    .regex(/^[a-z]{2,3}$/, 'voice_language_invalid')
    .nullable()
    .default(null),
  /**
   * When a recording is transcribed: false = on request (the default — "transcribe" under the player
   * nothing is charged until someone asks); true = automatically, its text going into the update being written.
   */
  auto: z.boolean().default(false),
});
export type AiVoiceSettings = z.infer<typeof aiVoiceSettingsSchema>;

/** What everyone in the account needs to know about voice (the composer and the players) — no ids, no keys. */
export const voiceSettingsViewSchema = z.object({
  recording: z.boolean(),
  max_seconds: z.number().int(),
  /** Transcription can run now: on, AI on, a connection chosen, and this person's role may use it. */
  transcription: z.boolean(),
  auto: z.boolean(),
});
export type VoiceSettingsView = z.infer<typeof voiceSettingsViewSchema>;

/** A transcription's answer (`stored`: it was kept on the file — every transcription is). */
export const transcriptionSchema = z.object({
  text: z.string(),
  model: z.string(),
  cost_usd: z.number(),
  /** An existing transcript came back (no new run, nothing charged). */
  reused: z.boolean().optional(),
});
export type Transcription = z.infer<typeof transcriptionSchema>;

/** POST /files/{id}/transcribe: `force` runs it again even when the file has a transcript (charged again). */
export const transcribeFileSchema = z.object({ force: z.boolean().optional() });

/**
 * GET /files/{id}/transcript: a file's kept transcript, or `transcript: null`. `can_edit`: this person
 * may edit what holds the file (the update's author / the cell's editors), so may correct the text.
 */
export const fileTranscriptSchema = z.object({
  transcript: z
    .object({
      text: z.string(),
      model: z.string().nullable(),
      created_at: z.string(),
      edited_at: z.string().nullable(),
    })
    .nullable(),
  can_edit: z.boolean(),
});
export type FileTranscript = z.infer<typeof fileTranscriptSchema>;

/** PATCH /files/{id}/transcript: the corrected text (empty = remove the transcript). */
export const editTranscriptSchema = z.object({ text: z.string().max(100_000) });

/**
 * A model an admin added to a connection by hand (a provider without a model list), or a listed model whose
 * capabilities the admin corrected (e.g. a local model without tool calling).
 */
export const aiManualModelSchema = z.object({
  id: z.string().trim().min(1).max(80),
  display_name: z.string().trim().max(80).optional(),
  capabilities: aiCapabilitiesSchema
    .extend({ max_context: z.number().int().min(1).max(100_000_000).nullable() })
    .partial()
    .optional(),
});
export type AiManualModel = z.infer<typeof aiManualModelSchema>;

/** A base URL of an OpenAI-compatible server (`https://api.groq.com/openai/v1`, `http://localhost:11434/v1`). */
export const aiBaseUrlSchema = z.url({ protocol: /^https?$/ }).max(500);

/**
 * AI and MCP (the planning notes "AGENTS-MCP", D26). `account_settings.settings.ai`: AI off by default in a new account;
 * the MCP server on (it costs nothing — the model runs on the user's own Claude / ChatGPT / Cursor) for admins and
 * members (§11 q6: not viewers, never guests); agents created by admins (q5); sensitive MCP tools (delete) allowed
 * by default because a delete goes to the trash and can be undone.
 */
export const MCP_ROLES = ['member', 'viewer'] as const;
export const aiSettingsSchema = z.object({
  /** AI features that cost money (agents, AI columns, assistant) — off until an admin turns them on. */
  enabled: z.boolean().default(false),
  /** The account's MCP server (`/mcp`). */
  mcp_enabled: z.boolean().default(true),
  /** Who besides admins may connect an AI app over MCP (perm.mcp). Guests never may. */
  mcp_roles: z.array(z.enum(MCP_ROLES)).max(2).default(['member']),
  /** Who may create agents (perm.agents). */
  agent_creators: z.enum(['admins', 'members']).default('admins'),
  /** A new agent answers when mentioned (its "mention" trigger starts on). Existing agents are not changed. */
  agent_mention_default: z.boolean().default(true),
  /** Sensitive MCP tools (deleting to the trash …): allowed or blocked. */
  mcp_sensitive: z.enum(['allow', 'block']).default('allow'),
  /** Monthly AI budget in USD for the account (null = no budget); an alert at `budget_alert_pct`. */
  monthly_budget_usd: z.number().min(0).max(1_000_000).nullable().default(null),
  budget_alert_pct: z.number().int().min(1).max(100).default(80),
  /**
   * Text that AI writes into updates (agents' replies, the assistant's and AI apps' updates over MCP) is read as
   * Markdown and stored formatted — headings, lists, tables, links (sync-ai). Off: stored as the plain text sent.
   */
  format_markdown: z.boolean().default(true),
  /**
   * Changes AI may make a minute (aiguard): each person / AI-app connection / agent, and the whole account — one
   * shared count for the MCP server, agents and the assistant's approved actions.
   */
  write_rate_per_minute: z.number().int().min(1).max(10_000).default(60),
  account_write_rate_per_minute: z.number().int().min(1).max(100_000).default(600),
  /** The AI assistant panel (מ12): its connection + model and limits — chosen here, never in code. */
  assistant: z
    .object({
      enabled: z.boolean().default(true),
      connection_id: z.string().max(26).nullable().default(null),
      model: z.string().max(80).nullable().default(null),
      /** Who may chat besides admins. Guests only when added here (they see only what they may see anyway). */
      roles: z
        .array(z.enum(['member', 'viewer', 'guest']))
        .max(3)
        .default(['member', 'viewer']),
      /** Model calls (reads included) one message may take, and dollars it may spend. */
      max_steps: z.number().int().min(1).max(30).default(8),
      max_usd_per_message: z.number().min(0.01).max(100).default(0.5),
      /** Messages a person may send a day (all boards). */
      daily_messages_per_user: z.number().int().min(1).max(10_000).default(100),
    })
    .default({
      enabled: true,
      connection_id: null,
      model: null,
      roles: ['member', 'viewer'],
      max_steps: 8,
      max_usd_per_message: 0.5,
      daily_messages_per_user: 100,
    }),
  images: aiImagesSettingsSchema.default({
    connection_id: null,
    model: null,
    size: '1024x1024',
    quality: 'auto',
    max_images: 1,
    concurrency: 1,
  }),
  voice: aiVoiceSettingsSchema.default({
    recording: true,
    max_seconds: 600,
    transcription: false,
    connection_id: null,
    model: null,
    language: null,
    auto: false,
  }),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;
export const updateAiSettingsSchema = patchOf(aiSettingsSchema);
export type UpdateAiSettings = z.infer<typeof updateAiSettingsSchema>;

/** An AI connection (D26): a provider + an encrypted key saved once per account; the key is never sent back. */
export const aiConnectionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    provider: z.enum(AI_PROVIDERS),
    /** The key's last 4 characters (`…AbCd`) — enough to recognise it, never to use it. */
    key_hint: z.string(),
    default_model: z.string().nullable(),
    /** The server of an OpenAI-compatible connection (null for the other providers). */
    base_url: z.string().nullable(),
    /** Models added by hand / capabilities corrected (see `aiManualModelSchema`). */
    manual_models: z.array(aiManualModelSchema),
    /** Prices an admin set per model (USD per 1M tokens) — for models the price table lacks, or to correct it. */
    price_overrides: z
      .record(
        z.string(),
        z.object({
          input: z.number(),
          output: z.number(),
          cache_read: z.number().optional(),
          cache_write: z.number().optional(),
        }),
      )
      .optional(),
    last_test: z.object({ ok: z.boolean(), at: z.string(), error: z.string().nullable() }).nullable(),
    last_used_at: z.string().nullable(),
    created_at: z.string(),
    created_by_name: z.string().nullable(),
  })
  .meta({ id: 'AiConnection' });
export type AiConnection = z.infer<typeof aiConnectionSchema>;

export const createAiConnectionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  provider: z.enum(AI_PROVIDERS).default('anthropic'),
  /** Required except for an OpenAI-compatible server that needs none (a local Ollama / LM Studio). */
  api_key: z.string().trim().max(400).default(''),
  /** OpenAI-compatible only: where the server answers (`…/v1`). Private addresses only when the owner allows them. */
  base_url: aiBaseUrlSchema.nullable().optional(),
  default_model: z.string().max(80).nullable().optional(),
  manual_models: z.array(aiManualModelSchema).max(200).optional(),
});
const priceOverrideSchema = z.object({
  input: z.number().min(0).max(10_000),
  output: z.number().min(0).max(10_000),
  cache_read: z.number().min(0).max(10_000).optional(),
  cache_write: z.number().min(0).max(10_000).optional(),
});
export const updateAiConnectionSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  /** Replaces the key (write-only). */
  api_key: z.string().trim().min(10).max(400).optional(),
  base_url: aiBaseUrlSchema.nullable().optional(),
  default_model: z.string().max(80).nullable().optional(),
  /** Replaces the connection's hand-added models / capability corrections. */
  manual_models: z.array(aiManualModelSchema).max(200).optional(),
  /**
   * Per-model prices (Fix: ): `{model: {input, output}}` sets one model's price, `{model: null}` removes it
   * (back to the known-price table, or "unknown").
   */
  price_overrides: z.record(z.string().min(1).max(80), priceOverrideSchema.nullable()).optional(),
});

/**
 * The models a connection may use (Fix: ): read live from the provider (Anthropic `GET /v1/models` with the
 * connection's key), cached for an hour per connection, newest first. `source: 'fallback'` = the provider could not
 * be read and the static catalogue stands in. `price: null` = "מחיר לא ידוע".
 */
export const aiModelOptionSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  created_at: z.string().nullable(),
  /** USD per 1M tokens, or null when unknown. */
  price: z.object({ input: z.number(), output: z.number() }).nullable(),
  /**
   * `override` = the connection's own price, `table` = the platform's price table, `provider` = the price on the
   * provider's own model list (OpenRouter), null = unknown.
   */
  price_source: z.enum(['override', 'table', 'provider']).nullable(),
  /** The connection's default model (the one it set, else the suggested one — see `default_auto`). */
  default: z.boolean(),
  /** What the model can do (defaults ← the provider's list ← the connection's corrections). */
  capabilities: aiCapabilitiesSchema,
  /** Added by hand on the connection (not on the provider's list). */
  manual: z.boolean(),
});
export type AiModelOption = z.infer<typeof aiModelOptionSchema>;
export const aiModelListSchema = z
  .object({
    data: z.array(aiModelOptionSchema),
    source: z.enum(['live', 'fallback']),
    fetched_at: z.string(),
    /**
     * The model a call uses when none is chosen: the connection's default, or — none set — the newest model of the
     * list that calls tools (`default_auto`). Null = the list is empty.
     */
    default_model: z.string().nullable(),
    default_auto: z.boolean(),
  })
  .meta({ id: 'AiModelList' });
export type AiModelList = z.infer<typeof aiModelListSchema>;
export const aiModelListQuerySchema = z.object({
  /** Read the provider again now instead of the hour-long cache. */
  refresh: z.enum(['true', 'false']).optional(),
});

/** Read a provider's models with a key before the connection is saved (the new-connection dialog's model picker). */
export const previewAiModelsSchema = createAiConnectionSchema.pick({
  provider: true,
  api_key: true,
  base_url: true,
  manual_models: true,
});

export const aiConnectionTestSchema = z.object({ ok: z.boolean(), error: z.string().nullable() });

/** AI usage of a month (A5 tile): per connection × source × model, real cost from each call's usage. */
export const aiUsageSchema = z
  .object({
    month: z.string(),
    total_usd: z.number(),
    budget_usd: z.number().nullable(),
    rows: z.array(
      z.object({
        connection_id: z.string(),
        connection_name: z.string().nullable(),
        source: z.string(),
        model: z.string(),
        calls: z.number().int(),
        input_tokens: z.number().int(),
        output_tokens: z.number().int(),
        cost_usd: z.number(),
        /** false = the model has no price (connection or price table): its calls were recorded at 0. */
        price_known: z.boolean(),
      }),
    ),
    /** Models used this month that have no price — set one on the connection or ask the platform owner. */
    unpriced_models: z.array(
      z.object({ connection_id: z.string(), connection_name: z.string().nullable(), model: z.string() }),
    ),
  })
  .meta({ id: 'AiUsage' });
export type AiUsageReport = z.infer<typeof aiUsageSchema>;
export const aiUsageQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

/** What the "AI ו-MCP" page shows to anyone who may connect: the address, whether they may, and the tools. */
export const mcpInfoSchema = z
  .object({
    url: z.string(),
    enabled: z.boolean(),
    /** Whether the viewer's role may connect (perm.mcp). */
    allowed: z.boolean(),
    protocol_versions: z.array(z.string()),
    tools: z.array(
      z.object({
        name: z.string(),
        title: z.string(),
        family: z.string(),
        scope: z.string(),
        risk: z.enum(['read', 'write', 'sensitive']),
      }),
    ),
  })
  .meta({ id: 'McpInfo' });
export type McpInfo = z.infer<typeof mcpInfoSchema>;

/**
 * The platform's AI price table (owner console → "AI prices"): per provider (or `*` = any) + model id or
 * pattern (`*` wildcards), USD per 1M tokens. Cache prices null = as much as input.
 */
export const AI_PRICE_PROVIDERS = [...AI_PROVIDERS, '*'] as const;
const usdPerMillion = z.number().min(0).max(10_000);
const usdPerImage = z.number().min(0).max(1000);
export const aiPriceRowSchema = z
  .object({
    id: z.string(),
    provider: z.enum(AI_PRICE_PROVIDERS),
    model: z.string(),
    input: z.number(),
    output: z.number(),
    cache_read: z.number().nullable(),
    cache_write: z.number().nullable(),
    /** USD per image (image models) — null = priced by tokens only. */
    per_image: z.number().nullable(),
    /** USD per image by size / quality: `{"1024x1024/high": 0.17, "1536x1024": 0.06, "low": 0.01}`. */
    image_prices: z.record(z.string(), z.number()).nullable(),
    currency: z.literal('USD'),
    note: z.string().nullable(),
    updated_at: z.string(),
  })
  .meta({ id: 'AiPrice' });
export type AiPriceRow = z.infer<typeof aiPriceRowSchema>;
export const createAiPriceSchema = z.object({
  provider: z.enum(AI_PRICE_PROVIDERS),
  /** An exact model id, or a pattern with `*` (`gpt-5*`). */
  model: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._:/@*-]+$/, 'ai_price_model_invalid'),
  input: usdPerMillion,
  output: usdPerMillion,
  cache_read: usdPerMillion.nullable().optional(),
  cache_write: usdPerMillion.nullable().optional(),
  per_image: usdPerImage.nullable().optional(),
  image_prices: z
    .record(z.string().trim().regex(AI_IMAGE_PRICE_KEY_RE, 'ai_image_price_key_invalid'), usdPerImage)
    .refine((r) => Object.keys(r).length <= 30, 'ai_image_prices_too_many')
    .nullable()
    .optional(),
  note: z.string().trim().max(255).nullable().optional(),
});
export type CreateAiPrice = z.infer<typeof createAiPriceSchema>;
export const updateAiPriceSchema = createAiPriceSchema.partial();
export type UpdateAiPrice = z.infer<typeof updateAiPriceSchema>;
