// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import type { FetchLike } from './types';

/** A provider's HTTP error: only the status travels on (never the request, never the key). */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    readonly providerMessage: string | null,
    /** The provider's own error code (`content_policy_violation`, `moderation_blocked` …), when it sends one. */
    readonly providerCode: string | null = null,
    /** How long the provider asked to wait before trying again (`retry-after-ms` / `Retry-After`), when it said. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`provider_http_${status}`);
    this.name = 'ProviderHttpError';
  }
}

/**
 * The provider's own "try again after" (the images queue): `retry-after-ms` (OpenAI), else
 * `Retry-After` in seconds or as an HTTP date. null when absent or unreadable; never negative.
 */
export const retryAfterOf = (headers: Headers | undefined, now = Date.now()): number | null => {
  const ms = Number(headers?.get('retry-after-ms') ?? NaN);
  if (Number.isFinite(ms) && ms >= 0) return Math.round(ms);
  const raw = headers?.get('retry-after')?.trim();
  if (!raw) return null;
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw) * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
};

const providerError = async (res: Response): Promise<{ message: string | null; code: string | null }> => {
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | unknown };
    const err = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { message?: unknown; code?: unknown } };
    const body = err?.error && typeof err.error === 'object' ? err.error : null;
    return {
      message: typeof body?.message === 'string' ? body.message.slice(0, 300) : null,
      code: typeof body?.code === 'string' ? body.code.slice(0, 60) : null,
    };
  } catch {
    return { message: null, code: null };
  }
};

/** One call answered in JSON; a non-2xx answer throws `ProviderHttpError`. */
export const callJson = async <T>(
  fetchFn: FetchLike,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: unknown; raw?: Multipart; timeoutMs?: number },
): Promise<T> => {
  const res = await send(fetchFn, url, init);
  return (await res.json()) as T;
};

/** The raw answer of a call (streams read it as SSE); a non-2xx answer throws `ProviderHttpError`. */
export const send = async (
  fetchFn: FetchLike,
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: unknown;
    /** A body sent as is (a multipart upload — image edits) instead of JSON. */
    raw?: Multipart;
    timeoutMs?: number;
  },
): Promise<Response> => {
  const signal = init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined;
  const contentType = init.raw ? init.raw.contentType : init.body !== undefined ? 'application/json' : null;
  const res = await fetchFn(url, {
    method: init.method,
    headers: {
      accept: 'application/json',
      ...(contentType ? { 'content-type': contentType } : {}),
      ...init.headers,
    },
    ...(init.raw ? { body: init.raw.body } : init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    const err = await providerError(res);
    throw new ProviderHttpError(res.status, err.message, err.code, retryAfterOf(res.headers));
  }
  return res;
};

/** Server-sent events: each `data:` payload, parsed as JSON (`[DONE]` and broken lines skipped). */
export async function* sseEvents(res: Response): AsyncGenerator<unknown> {
  if (!res.body) {
    // A body-less answer (some test doubles): read it whole.
    yield* parseSse(await res.text());
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
      yield* parseSse(chunk);
    }
    if (done) break;
  }
  if (buffer.trim()) yield* parseSse(buffer);
}

function* parseSse(text: string): Generator<unknown> {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      yield JSON.parse(data);
    } catch {
      // a keep-alive or a broken line: skip it
    }
  }
}

/** A multipart/form-data body (image edits): the bytes and the content type with its boundary. */
export type Multipart = { body: Uint8Array; contentType: string };
/** A form field: text, or a file (its bytes, type and name). */
export type FormField = [name: string, value: string | { data: Uint8Array; mime: string; filename: string }];

/** Form fields → a multipart/form-data body (bytes, not FormData: the guarded transport sends and counts bytes). */
export const multipartBody = (
  fields: FormField[],
  boundary = `----bines${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`,
): Multipart => {
  const chunks: Uint8Array[] = [];
  const text = (s: string) => chunks.push(new Uint8Array(Buffer.from(s, 'utf8')));
  const quoted = (s: string) => s.replace(/["\r\n]/g, '_');
  for (const [name, value] of fields) {
    text(`--${boundary}\r\n`);
    if (typeof value === 'string') {
      text(`Content-Disposition: form-data; name="${quoted(name)}"\r\n\r\n${value}\r\n`);
      continue;
    }
    text(
      `Content-Disposition: form-data; name="${quoted(name)}"; filename="${quoted(value.filename)}"\r\n` +
        `Content-Type: ${value.mime}\r\n\r\n`,
    );
    chunks.push(value.data);
    text('\r\n');
  }
  text(`--${boundary}--\r\n`);
  return { body: new Uint8Array(Buffer.concat(chunks)), contentType: `multipart/form-data; boundary=${boundary}` };
};

/** The text of a system prompt (a string, or text blocks). */
export const systemText = (system: string | Anthropic.TextBlockParam[] | undefined) =>
  !system ? '' : typeof system === 'string' ? system : system.map((b) => b.text).join('\n\n');

/** A tool result's content as text (tools answer JSON text; images are not sent back as tool results). */
export const toolResultText = (content: Anthropic.ToolResultBlockParam['content']) =>
  typeof content === 'string'
    ? content
    : (content ?? []).flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');

/** Every tool call's id → its tool name (Gemini answers a tool call by the tool's name). */
export const toolNames = (messages: Anthropic.MessageParam[]) => {
  const out = new Map<string, string>();
  for (const m of messages)
    if (typeof m.content !== 'string') for (const b of m.content) if (b.type === 'tool_use') out.set(b.id, b.name);
  return out;
};

export const textBlock = (text: string) => ({ type: 'text', text, citations: null }) as Anthropic.TextBlock;

export const toolUseBlock = (id: string, name: string, input: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'tool_use', id, name, input: input ?? {}, ...extra }) as Anthropic.ToolUseBlock;

/** JSON arguments of a tool call; broken JSON = no arguments (the tool then answers with a validation error). */
export const parseArgs = (raw: unknown): Record<string, unknown> => {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** A base URL without its trailing slashes. */
export const trimBase = (url: string) => url.replace(/\/+$/, '');
