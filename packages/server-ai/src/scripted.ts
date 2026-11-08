// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { AiContentPolicyError } from './errors';
import { ProviderHttpError } from './http';
import type { AnthropicLike } from './index';
import type { ProviderModel } from '@bines/shared';
import type { AiImageRequest, AiImageResult } from './types';

/**
 * A scripted stand-in for the Anthropic API — tests and the E2E server only (`AI_FAKE=scripted`, refused in
 * production). It spends nothing and needs no key. The script is read from the run's first user message: every
 * line `TOOL <name> <json input>` becomes one tool call, one per turn, in order; then the turn ends with a short
 * text. Each answer carries an (empty) thinking block like the real adaptive-thinking models, so the agent loop's
 * "send the content back unchanged" path is exercised too.
 */
const LINE = /^TOOL\s+([a-z_]+)\s+(\{.*\})\s*$/;

const textOf = (content: Anthropic.MessageParam['content']) =>
  typeof content === 'string' ? content : content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');

/**
 * The message that carries the script: the latest user message with text (an agent's prompt — its later user
 * messages hold only tool results; a chat's latest question in the assistant panel, מ12).
 */
const scriptMessage = (messages: Anthropic.MessageParam[]) => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.role === 'user' && textOf(m.content).trim()) return i;
  }
  return -1;
};

/** `ANSWER <text>` anywhere in the script message: the final text (AI columns: the cell's value). */
const ANSWER = /ANSWER[:\s]+([^\n<]+)/;
export const scriptedAnswer = (messages: Anthropic.MessageParam[]) => {
  const i = scriptMessage(messages);
  return i < 0 ? null : (ANSWER.exec(textOf(messages[i]!.content))?.[1]?.trim() ?? null);
};

export const scriptedCalls = (messages: Anthropic.MessageParam[]) => {
  const i = scriptMessage(messages);
  if (i < 0) return [];
  return textOf(messages[i]!.content)
    .split(/\r?\n/)
    .flatMap((line) => {
      const m = LINE.exec(line.trim());
      if (!m) return [];
      try {
        return [{ name: m[1]!, input: JSON.parse(m[2]!) as Record<string, unknown> }];
      } catch {
        return [];
      }
    });
};

export const scriptedAnthropic = (): AnthropicLike => ({
  messages: {
    create: async (params) => {
      const start = scriptMessage(params.messages);
      const turns = params.messages.slice(start + 1).filter((m) => m.role === 'assistant').length;
      const calls = scriptedCalls(params.messages);
      const answer = scriptedAnswer(params.messages);
      const next = calls[turns];
      const thinking = { type: 'thinking', thinking: '', signature: `sig-${turns}` } as Anthropic.ThinkingBlock;
      const content: Anthropic.ContentBlock[] = next
        ? [
            thinking,
            {
              type: 'tool_use',
              id: `toolu_scripted_${turns}`,
              name: next.name,
              input: next.input,
            } as Anthropic.ToolUseBlock,
          ]
        : [thinking, { type: 'text', text: answer ?? `Done (${calls.length} actions).`, citations: null }];
      return {
        id: `msg_scripted_${turns}`,
        type: 'message',
        role: 'assistant',
        model: params.model,
        content,
        stop_reason: next ? 'tool_use' : 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 400,
          output_tokens: 60,
          cache_read_input_tokens: turns ? 3000 : 0,
          cache_creation_input_tokens: turns ? 0 : 3000,
        },
      } as unknown as Anthropic.Message;
    },
  },
  models: { list: async () => ({ data: [] }) },
});

/** A 1×1 transparent PNG — the scripted image. */
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * The scripted image maker (AI images; `AI_FAKE=scripted` and tests): `n` tiny PNGs, no network, no money. A prompt
 * with `BLOCKED` in it plays a provider's safety refusal; one with `RATE_LIMIT_ONCE` plays a busy provider the first
 * time that exact prompt comes (HTTP 429, `Retry-After: 1`) and answers the next time (the images
 * queue's retries).
 */
const rateLimitedOnce = new Set<string>();
export const scriptedImage = async (req: AiImageRequest): Promise<AiImageResult> => {
  if (/BLOCKED/.test(req.prompt)) throw new AiContentPolicyError('Your request was rejected by the safety system.');
  if (/RATE_LIMIT_ONCE/.test(req.prompt) && !rateLimitedOnce.has(req.prompt)) {
    rateLimitedOnce.add(req.prompt);
    throw new ProviderHttpError(429, 'Rate limit reached (scripted)', null, 1000);
  }
  const data = new Uint8Array(Buffer.from(TINY_PNG_BASE64, 'base64'));
  return {
    model: req.model,
    images: Array.from({ length: Math.max(1, req.n ?? 1) }, () => ({ mime: 'image/png', data, revisedPrompt: null })),
    usage: null,
  };
};

/**
 * The scripted stand-in's model list per provider (E2E, `AI_FAKE=scripted`): OpenAI and Gemini answer with a small
 * list of their own shape so every model picker shows that provider's models, not Claude's. Anthropic and an
 * OpenAI-compatible server list nothing (the catalogue / the hand-added models stand in, as before).
 */
export const scriptedModels = (provider: string): ProviderModel[] =>
  provider === 'openai'
    ? [
        { id: 'gpt-e2e-mini', display_name: 'gpt-e2e-mini', created_at: '2026-05-01T00:00:00.000Z' },
        { id: 'gpt-e2e', display_name: 'gpt-e2e', created_at: '2026-06-01T00:00:00.000Z' },
        { id: 'gpt-image-e2e', display_name: 'gpt-image-e2e', created_at: '2026-04-01T00:00:00.000Z' },
      ]
    : provider === 'gemini'
      ? [
          { id: 'gemini-1.5-flash-e2e', display_name: 'Gemini E2E 1.5 Flash', created_at: null },
          { id: 'gemini-3.0-pro-e2e', display_name: 'Gemini E2E 3.0 Pro', created_at: null },
        ]
      : [];
