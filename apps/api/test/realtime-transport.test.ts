// SPDX-License-Identifier: AGPL-3.0-only
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gzipJson } from '../src/middleware/compress';
import { closeAllStreams, HEARTBEAT_MS, MAX_STREAM_MS, RECONNECT_MS } from '../src/modules/realtime/realtime.routes';
import type { AppEnv } from '../src/types';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * SSE transport through Railway's HTTP/2 edge (prod 2026-10-07: `/me/events … net::ERR_HTTP2_PROTOCOL_ERROR`):
 * the right headers, never compressed, a ping well inside the idle timeout, a lifetime below the edge's 15-minute cap,
 * a `retry:` hint, and a clean end on shutdown.
 */
let t: TestContext;
let admin: string;
let acmeId: string;

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const res = await t.api(owner).post('/platform/accounts', {
    name: 'Acme',
    slug: 'acme',
    first_admin_email: 'admin@acme.test',
    template_set: 'empty',
  });
  acmeId = ((await res.json()) as { account: { id: string } }).account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
});
afterAll(() => t.close());

const readUntil = async (reader: ReadableStreamDefaultReader<Uint8Array>, pred: (text: string) => boolean) => {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + 5000;
  while (!pred(text) && Date.now() < deadline) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
};

describe('SSE transport', () => {
  it('ping and lifetime fit inside the edge proxy limits', () => {
    // Railway: closed after 5 minutes without data; no HTTP request lives longer than 15 minutes.
    expect(HEARTBEAT_MS).toBeLessThanOrEqual(15_000);
    expect(MAX_STREAM_MS).toBeLessThan(15 * 60_000);
    expect(MAX_STREAM_MS).toBeGreaterThan(HEARTBEAT_MS);
  });

  it('answers with stream headers, uncompressed, with a retry hint — and ends cleanly on shutdown', async () => {
    const res = await t.app.request(`/api/v1/me/events?account_id=${acmeId}`, {
      headers: { origin: WEB_ORIGIN, cookie: admin, 'accept-encoding': 'gzip, deflate, br' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-length')).toBeNull();
    // HTTP/1-only headers are forbidden on HTTP/2 (the browser's side of the edge).
    expect(res.headers.get('connection')).toBeNull();
    expect(res.headers.get('transfer-encoding')).toBeNull();
    const reader = res.body!.getReader();
    const first = await readUntil(reader, (s) => s.includes('"ready"'));
    expect(first).toContain(`retry: ${RECONNECT_MS}`);
    // A deploy: every open stream ends cleanly (the body finishes) instead of being cut mid-flight.
    await closeAllStreams();
    const deadline = Date.now() + 5000;
    let done = false;
    while (!done && Date.now() < deadline) done = (await reader.read()).done;
    expect(done).toBe(true);
  });

  it('the gzip middleware never touches an event stream', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', gzipJson());
    const big = `data: ${'x'.repeat(20_000)}\n\n`;
    app.get('/s', () => new Response(big, { headers: { 'content-type': 'text/event-stream' } }));
    app.get('/j', (c) => c.json({ x: 'y'.repeat(20_000) }));
    const s = await app.request('/s', { headers: { 'accept-encoding': 'gzip' } });
    expect(s.headers.get('content-encoding')).toBeNull();
    expect(await s.text()).toBe(big);
    // JSON of the same size is gzipped (the middleware works).
    const j = await app.request('/j', { headers: { 'accept-encoding': 'gzip' } });
    expect(j.headers.get('content-encoding')).toBe('gzip');
  });
});
