// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import type { AiModel, AiPrice, AiProvider, AiUsage, ProviderModel } from '@bines/shared';

/**
 * The provider-neutral shape every adapter speaks. It is Anthropic's message shape — the platform's
 * first provider and what agents, the assistant, AI columns and the flows builder already build — and each other
 * adapter maps it onto its provider's API and the answer back (text, tool calls, stop reason, usage).
 */
export type AiConnectionSecret = {
  provider: AiProvider;
  apiKey: string;
  /** OpenAI-compatible servers: where the API answers (`…/v1`). */
  baseUrl?: string | null;
  /** Private / local addresses allowed for this call (the owner's "allow local AI endpoints"); off by default. */
  allowPrivate?: boolean;
};

export type AiCompletionRequest = {
  model: string;
  /** A string, or blocks — the agents put a `cache_control` breakpoint on the last block of their fixed prefix. */
  system?: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Client tools (agents): the fixed tool list, in a deterministic order (it is part of the cached prefix). */
  tools?: Anthropic.Tool[];
  /**
   * Agent mode (מ6): adaptive thinking where the model takes it, automatic caching of the growing conversation
   * (top-level `cache_control`), and the server-side refusal fallback (`fallbacks: "default"`) where offered.
   */
  agentic?: boolean;
  /** Streams the answer's text as it is written (when the client can stream; else once, at the end). */
  onText?: (delta: string) => void;
  /** false = the model cannot stream: the text is handed to `onText` once, at the end. */
  stream?: boolean;
  /**
   * What the model takes, for a model the static catalogue does not know (read from the provider's live list,
   * Fix: ). Catalogue models use the catalogue.
   */
  supports?: AiModel['supports'];
  /** The price to cost the call with (the connection's override, else the price table); none = 0 (unknown). */
  price?: AiPrice | null;
};

export type AiCompletion = {
  model: string;
  text: string;
  /** `end_turn`, `max_tokens`, `tool_use`, `refusal` … — always checked before the text is trusted. */
  stopReason: string | null;
  usage: AiUsage;
  /** USD, from the real usage and the price given (0 when none). */
  costUsd: number;
  content: Anthropic.ContentBlock[];
};

/**
 * A picture the model starts from (image to image): the bytes the api read from its own storage
 * (never a link), a raster type (`AI_INPUT_IMAGE_MIMES`) and at most `MAX_AI_IMAGE_BYTES`.
 */
export type AiInputImage = { mime: string; data: Uint8Array; name?: string | null };

/** One image call (AI images): size / quality are passed as given (`auto` = the provider's default). */
export type AiImageRequest = {
  model: string;
  prompt: string;
  size?: string | null;
  quality?: string | null;
  /** How many images (the caller caps it). */
  n?: number;
  /**
   * Pictures to edit / start from, within the model's `inputImageLimit`: OpenAI answers them at
   * `/images/edits`, Gemini's image models take them as parts next to the text; a model that cannot start from a
   * picture (Imagen, DALL·E 3) throws `ai_model_no_image_edit`.
   */
  images?: AiInputImage[];
};

/** An image the provider made — the bytes, never a link (an adapter downloads its provider's own result URLs). */
export type AiImage = { mime: string; data: Uint8Array; revisedPrompt?: string | null };

export type AiImageResult = {
  model: string;
  images: AiImage[];
  /** Tokens, when the provider bills images by tokens (gpt-image); null = it said nothing. */
  usage: AiUsage | null;
};

export type AiClient = {
  provider: AiProvider;
  complete: (req: AiCompletionRequest) => Promise<AiCompletion>;
  /** A cheap call that proves the key works (lists the models); never throws. */
  test: () => Promise<{ ok: boolean; error: string | null }>;
  /**
   * The provider's models right now (Fix: ), newest first — throws when the provider cannot be read (the
   * caller falls back to the catalogue and the connection's hand-added models). Optional for a provider without one.
   */
  listModels?: () => Promise<ProviderModel[]>;
  /**
   * Makes images (AI images) — only on providers that can (OpenAI, OpenAI-compatible, Gemini). A provider's safety
   * refusal throws `AiContentPolicyError`; other errors as `complete`.
   */
  generateImage?: (req: AiImageRequest) => Promise<AiImageResult>;
  /**
   * Speech to text: only on providers that can (OpenAI, OpenAI-compatible servers with a Whisper-style
   * endpoint, Soniox).
   */
  transcribe?: (req: AiTranscribeRequest) => Promise<AiTranscription>;
  /** The provider's speech-to-text models, newest first (the account picks one, or the first is used). */
  listTranscriptionModels?: () => Promise<{ id: string; display_name: string }[]>;
};

/** One recording to turn into text. */
export type AiTranscribeRequest = {
  model: string;
  audio: Uint8Array;
  fileName: string;
  mime: string;
  /** A language hint (ISO 639-1, e.g. `he`); null = the provider detects it. */
  language?: string | null;
};

export type AiTranscription = {
  text: string;
  model: string;
  /** How long the recording is, when the provider says (a per-minute price uses it). */
  durationSeconds: number | null;
  /** Tokens, when the provider bills by them (gpt-4o-transcribe). */
  usage: AiUsage | null;
};

export type AiClientFactory = (conn: AiConnectionSecret) => AiClient;

/** The part of `fetch` the adapters use — injectable, so tests never reach a provider and the api can guard SSRF. */
export type FetchLike = (
  url: string,
  /** A JSON text, or raw bytes (a multipart upload — image edits). */
  init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal },
) => Promise<Response>;
