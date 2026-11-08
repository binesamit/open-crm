// SPDX-License-Identifier: AGPL-3.0-only
import type { EventEmitter as NodeEventEmitter } from 'node:events';
import { AppError } from '@bines/shared';
import { createAiClient } from '@bines/server-ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { aiFetch, assertAiBaseUrl } from '../src/modules/ai/ai-fetch';

/**
 * AI providers: the transport of OpenAI / Gemini / OpenAI-compatible connections goes through the
 * outbound SSRF guard — a base URL inside the network (loopback, private, metadata, a local name, a name that
 * rebinds) is refused unless the platform owner allowed local AI endpoints; redirects are never followed. DNS and
 * the socket are faked (the same harness as ai-redteam-ssrf): no test leaves the machine.
 */
const net = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as { EventEmitter: typeof NodeEventEmitter };
  const state = {
    /** What the check-time resolver answers (dns/promises). */
    checked: {} as Record<string, string[]>,
    /** What the dial-time resolver answers (dns.lookup inside the socket) — defaults to `checked`. */
    dialled: {} as Record<string, string[]>,
    responses: {} as Record<string, { status: number; headers?: Record<string, string>; body?: string }>,
    connects: [] as string[],
  };
  type Cb = (res: unknown) => void;
  type Lookup = (h: string, o: object, cb: (err: Error | null, address?: string) => void) => void;
  const request = (url: URL, opts: { lookup?: Lookup }, cb: Cb) => {
    const req = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
    req.write = () => true;
    req.destroy = (e?: Error) => {
      if (e) req.emit('error', e);
      req.emit('close');
    };
    req.end = () => {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const dial = (address: string) => {
        state.connects.push(`${host}@${address}`);
        const r = state.responses[url.href] ?? { status: 404 };
        const res = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
        res.statusCode = r.status;
        res.headers = r.headers ?? {};
        res.destroy = () => res.emit('close');
        cb(res);
        queueMicrotask(() => {
          if (r.body) res.emit('data', Buffer.from(r.body));
          res.emit('end');
        });
      };
      if (opts.lookup) opts.lookup(host, {}, (err, address) => (err ? req.emit('error', err) : dial(address!)));
      else dial(host);
    };
    return req;
  };
  const family = (a: string) => (a.includes(':') ? 6 : 4);
  return { state, request, family };
});

vi.mock('node:http', () => ({ request: net.request }));
vi.mock('node:https', () => ({ request: net.request }));
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => {
    const list = net.state.checked[host];
    if (!list) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return list.map((address) => ({ address, family: net.family(address) }));
  },
}));
vi.mock('node:dns', () => ({
  lookup: (host: string, _o: object, cb: (e: Error | null, a: { address: string; family: number }[]) => void) => {
    const list = net.state.dialled[host] ?? net.state.checked[host] ?? [];
    cb(
      null,
      list.map((address) => ({ address, family: net.family(address) })),
    );
  },
}));

const PUBLIC = '93.184.216.34';

beforeEach(() => {
  net.state.checked = {};
  net.state.dialled = {};
  net.state.responses = {};
  net.state.connects = [];
});

const ok = (body: unknown) => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const init = { method: 'GET', headers: {} };
const rejectsWith = async (p: Promise<unknown>, message: string) => {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, message).toBeInstanceOf(AppError);
  expect((err as AppError).message).toBe(message);
};

describe('AI transport — the outbound guard', () => {
  it('reaches a public provider and streams its answer', async () => {
    net.state.checked['api.groq.example'] = [PUBLIC];
    net.state.responses['https://api.groq.example/openai/v1/models'] = ok({ data: [{ id: 'llama-3.3-70b' }] });
    const res = await aiFetch(false)('https://api.groq.example/openai/v1/models', init);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 'llama-3.3-70b' }] });
    expect(net.state.connects).toEqual([`api.groq.example@${PUBLIC}`]);
  });

  it('refuses loopback, private, metadata and local names unless the owner allows local endpoints', async () => {
    net.state.checked['ollama.internal'] = ['10.0.0.5'];
    net.state.checked['sneaky.example'] = ['169.254.169.254'];
    for (const url of [
      'http://127.0.0.1:11434/v1/models',
      'http://localhost:1234/v1/models',
      'http://[::1]:11434/v1/models',
      'http://169.254.169.254/latest/meta-data',
      'http://ollama.internal/v1/models',
      'http://sneaky.example/v1/models',
    ])
      await rejectsWith(aiFetch(false)(url, init), 'ai_base_url_private');
    expect(net.state.connects).toEqual([]);
    // The owner's "allow local AI endpoints": a self-hosted server on the private network is reachable.
    net.state.responses['http://127.0.0.1:11434/v1/models'] = ok({ data: [] });
    expect((await aiFetch(true)('http://127.0.0.1:11434/v1/models', init)).status).toBe(200);
  });

  it('refuses DNS rebinding: public when checked, private when dialled', async () => {
    net.state.checked['rebind.example'] = [PUBLIC];
    net.state.dialled['rebind.example'] = ['127.0.0.1'];
    await rejectsWith(aiFetch(false)('https://rebind.example/v1/chat/completions', init), 'ai_base_url_private');
  });

  it('never follows a redirect (a 3xx is the answer)', async () => {
    net.state.checked['redirect.example'] = [PUBLIC];
    net.state.responses['https://redirect.example/v1/models'] = {
      status: 302,
      headers: { location: 'http://169.254.169.254/' },
    };
    const res = await aiFetch(false)('https://redirect.example/v1/models', init);
    expect(res.status).toBe(302);
    expect(net.state.connects).toEqual([`redirect.example@${PUBLIC}`]);
  });

  it('checks a base URL when it is saved: scheme, credentials, private address, unknown name', async () => {
    net.state.checked['api.mistral.example'] = [PUBLIC];
    await expect(assertAiBaseUrl('https://api.mistral.example/v1', false)).resolves.toBeUndefined();
    await rejectsWith(assertAiBaseUrl('ftp://api.mistral.example/v1', false), 'ai_base_url_invalid');
    await rejectsWith(assertAiBaseUrl('https://user:pw@api.mistral.example/v1', false), 'ai_base_url_invalid');
    await rejectsWith(assertAiBaseUrl('http://192.168.1.20:1234/v1', false), 'ai_base_url_private');
    await rejectsWith(assertAiBaseUrl('https://nowhere.example/v1', false), 'ai_base_url_unreachable');
    await expect(assertAiBaseUrl('http://192.168.1.20:1234/v1', true)).resolves.toBeUndefined();
  });

  it('an OpenAI-compatible connection pointed inside the network fails its call (and lists nothing)', async () => {
    const ai = createAiClient(
      { provider: 'openai_compatible', apiKey: '', baseUrl: 'http://127.0.0.1:11434/v1' },
      { fetch: aiFetch(false) },
    );
    await rejectsWith(
      ai.complete({ model: 'llama3.1', messages: [{ role: 'user', content: 'hi' }] }),
      'ai_base_url_private',
    );
    expect(await ai.test()).toEqual({ ok: false, error: 'ai_base_url_private' });
    expect(net.state.connects).toEqual([]);
  });
});
