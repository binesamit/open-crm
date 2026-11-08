// SPDX-License-Identifier: AGPL-3.0-only
import Anthropic from '@anthropic-ai/sdk';
import { type AiModel, type AiUsage, aiCost, aiModel, newestFirst, type ProviderModel } from '@bines/shared';
import { safeAiError } from './errors';
import type { AiClient, AiCompletionRequest, AiConnectionSecret } from './types';

/**
 * Anthropic, with its official SDK (D26). The client is injectable so tests never spend money
 * (`createAiClient(conn, { anthropic: fake })`).
 */
export type AnthropicLike = {
  messages: {
    create: (
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ) => Promise<Anthropic.Message>;
    /** Streaming (the assistant panel, מ12): text deltas as they come, then the whole message. Optional in fakes. */
    stream?: (
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: Anthropic.RequestOptions,
    ) => {
      on: (event: 'text', cb: (delta: string) => void) => unknown;
      finalMessage: () => Promise<Anthropic.Message>;
    };
  };
  models: {
    list: (params?: Anthropic.ModelListParams, options?: Anthropic.RequestOptions) => PromiseLike<unknown>;
  };
};

/** The beta header of the scalar `fallbacks: "default"` form (claude-api skill, 2026-09). */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** The request body for one call — pure, so the agent tests can check exactly what is sent. */
export const buildParams = (req: AiCompletionRequest): Anthropic.MessageCreateParamsNonStreaming => {
  const supports = req.supports ?? aiModel(req.model)?.supports ?? {};
  const params: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens ?? 16000,
    messages: req.messages,
  };
  if (req.system) params.system = req.system;
  if (req.tools?.length) {
    params.tools = req.tools;
    params.tool_choice = { type: 'auto' };
  }
  if (req.effort && supports.effort !== false && (!req.agentic || supports.effort)) {
    params.output_config = { effort: req.effort };
  }
  if (req.agentic) {
    if (supports.adaptiveThinking) params.thinking = { type: 'adaptive' };
    // Caches the conversation so far (the last cacheable block); the system's own breakpoint keeps tools + system.
    params.cache_control = { type: 'ephemeral' };
    if (supports.fallbacks) params.fallbacks = 'default';
  }
  return params as unknown as Anthropic.MessageCreateParamsNonStreaming;
};

export const createAnthropicClient = (conn: AiConnectionSecret, injected?: AnthropicLike): AiClient => {
  const client: AnthropicLike = injected ?? new Anthropic({ apiKey: conn.apiKey, maxRetries: 2 });
  return {
    provider: conn.provider,
    complete: async (req) => {
      const params = buildParams(req);
      const fallbacks = (params as unknown as { fallbacks?: unknown }).fallbacks !== undefined;
      const options = fallbacks ? { headers: { 'anthropic-beta': FALLBACK_BETA } } : undefined;
      let res: Anthropic.Message;
      if (req.onText && req.stream !== false && client.messages.stream) {
        const stream = client.messages.stream(params, options);
        stream.on('text', req.onText);
        res = await stream.finalMessage();
      } else {
        res = await client.messages.create(params, options);
        if (req.onText && res.stop_reason !== 'refusal') {
          const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
          if (text) req.onText(text);
        }
      }
      const usage: AiUsage = {
        input_tokens: res.usage.input_tokens,
        output_tokens: res.usage.output_tokens,
        cache_read_input_tokens: res.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: res.usage.cache_creation_input_tokens ?? 0,
      };
      const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
      return {
        model: res.model,
        text: res.stop_reason === 'refusal' ? '' : text,
        stopReason: res.stop_reason,
        usage,
        costUsd: aiCost(usage, req.price),
        content: res.content,
      };
    },
    test: async () => {
      try {
        await client.models.list({ limit: 1 });
        return { ok: true, error: null };
      } catch (err) {
        return { ok: false, error: safeAiError(err) };
      }
    },
    listModels: async () => {
      const out: ProviderModel[] = [];
      let after: string | undefined;
      // Anthropic pages the list (`has_more` / `last_id`); a few pages are far more than it has.
      for (let page = 0; page < 5; page += 1) {
        // Never slow a page down for long: one try, a short timeout (the catalogue stands in on failure).
        const res = (await client.models.list(
          { limit: 1000, ...(after ? { after_id: after } : {}) },
          { maxRetries: 0, timeout: 8000 },
        )) as {
          data?: Partial<Anthropic.ModelInfo>[];
          has_more?: boolean;
          last_id?: string | null;
        };
        for (const m of res.data ?? []) {
          if (typeof m.id !== 'string' || !m.id) continue;
          const capabilities: NonNullable<ProviderModel['capabilities']> = {};
          if (m.capabilities) {
            capabilities.vision = !!m.capabilities.image_input?.supported;
            capabilities.json = !!m.capabilities.structured_outputs?.supported;
          }
          if (typeof m.max_input_tokens === 'number') capabilities.max_context = m.max_input_tokens;
          out.push({
            id: m.id,
            display_name: m.display_name || m.id,
            created_at: m.created_at ?? null,
            supports: m.capabilities ? supportsOf(m.capabilities) : undefined,
            ...(Object.keys(capabilities).length ? { capabilities } : {}),
          });
        }
        if (!res.has_more || !res.last_id) break;
        after = res.last_id;
      }
      return newestFirst(out);
    },
  };
};

/** What a live model takes (its `capabilities`): adaptive thinking and effort; the refusal fallback is not listed. */
const supportsOf = (c: Anthropic.ModelCapabilities): AiModel['supports'] => ({
  adaptiveThinking: !!c.thinking?.types?.adaptive?.supported,
  effort: !!c.effort?.supported,
  fallbacks: false,
});
