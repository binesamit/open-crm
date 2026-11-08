// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_REQUEST_BYTES } from '../src/app';
import { assertPublicUrl, isPrivateIp, outboundRequest } from '../src/lib/outbound';
import { isInlineSafeMime } from '../src/lib/storage';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** Security review (docs/SECURITY-REVIEW.md): regression tests for the fixed findings. */
/** A fixture, not a credential (built at run time so secret scanners do not flag the line). */
const INBOUND_SECRET = ['inbound', 'secret', 'fixture', '0123'].join('-');
let t: TestContext;
let admin: string;
let bob: string; // member
let carol: string; // viewer
let g1: string; // guest
let acmeId: string;
let boardId: string;
let portalId: string;
let server: Server;
let port: number;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await as(admin).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  await as(admin).post('/users/invite', { emails: ['g1@client.test'], role: 'guest' });
  bob = await join('bob@acme.test');
  carol = await join('carol@acme.test');
  g1 = await join('g1@client.test');
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  portalId = (await body(await as(admin).post('/boards', { name: 'Portal', workspace_id: wsId, kind: 'shareable' })))
    .id;
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  const g1Id = users.find((u) => u.email === 'g1@client.test')!.user_id;
  await as(admin).put(`/boards/${portalId}/members/${g1Id}`, {});

  // A local endpoint that answers with a redirect to an internal address.
  server = createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await t.close();
});

describe('S-01 outbound calls (SSRF)', () => {
  it('treats loopback, private, link-local, CGNAT, NAT64 and IPv4-mapped IPv6 as private', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1', // how the URL parser writes [::ffff:127.0.0.1]
      '::ffff:a9fe:a9fe', // 169.254.169.254
      '64:ff9b::a9fe:a9fe',
      'not-an-ip',
    ])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])
      expect(isPrivateIp(ip), ip).toBe(false);
  });

  it('refuses private targets in URLs, including the IPv4-mapped IPv6 form and credentials in the URL', async () => {
    await expect(assertPublicUrl('http://[::ffff:127.0.0.1]:8080/')).rejects.toThrow('webhook_url_private');
    await expect(assertPublicUrl('http://[::ffff:169.254.169.254]/')).rejects.toThrow('webhook_url_private');
    await expect(assertPublicUrl('http://localhost/x')).rejects.toThrow('webhook_url_private');
    await expect(assertPublicUrl('http://2130706433/')).rejects.toThrow('webhook_url_private'); // 127.0.0.1
    await expect(assertPublicUrl('https://user:pw@example.com/')).rejects.toThrow('webhook_url_invalid');
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow('webhook_url_invalid');
  });

  it('never dials a private address when private targets are not allowed', async () => {
    await expect(
      outboundRequest(`http://127.0.0.1:${port}/`, { method: 'POST', body: '{}', timeoutMs: 2000 }),
    ).rejects.toThrow('webhook_url_private');
  });

  it('does not follow redirects (a 3xx is the answer)', async () => {
    const res = await outboundRequest(`http://127.0.0.1:${port}/redirect`, {
      method: 'POST',
      body: '{}',
      timeoutMs: 2000,
      allowPrivate: true,
    });
    expect(res.status).toBe(302);
    expect(res.ok).toBe(false);
  });
});

describe('S-02 automation secrets are hidden from readers who cannot manage', () => {
  it('a viewer sees the recipe without the inbound secret, signing secret, header values or hook path', async () => {
    const res = await as(admin).post(`/boards/${boardId}/automations`, {
      title: 'Inbound → Make',
      recipe: {
        trigger: { type: 'webhook_in', secret: INBOUND_SECRET },
        actions: [
          {
            type: 'webhook',
            url: 'https://hook.eu1.make.com/abcdefsecretpath',
            headers: { Authorization: 'Bearer third-party-token' },
            secret: 'signing-secret',
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const id = (await body(res)).id as string;

    const mine = await body(await as(admin).get(`/automations/${id}`));
    expect(mine.recipe.trigger.secret).toBe(INBOUND_SECRET);
    expect(mine.recipe.actions[0].headers.Authorization).toBe('Bearer third-party-token');

    for (const reader of [carol, bob]) {
      const list = await body(await as(reader).get(`/boards/${boardId}/automations`));
      const a = list.data.find((x: Json) => x.id === id);
      expect(a.can_manage).toBe(false);
      const text = JSON.stringify(a.recipe);
      expect(text).not.toContain('inbound-secret');
      expect(text).not.toContain('third-party-token');
      expect(text).not.toContain('signing-secret');
      expect(text).not.toContain('abcdefsecretpath');
      expect(a.recipe.actions[0].url).toMatch(/^https:\/\/hook\.eu1\.make\.com\//);
    }
  });
});

describe('S-03 guests never manage automations or invite (05 §2)', () => {
  it('on an edit-everything shareable board a guest edits items but cannot add automations or invite', async () => {
    const item = await as(g1).post(`/boards/${portalId}/items`, { name: 'בקשה' });
    expect(item.status).toBe(201);
    const auto = await as(g1).post(`/boards/${portalId}/automations`, {
      recipe: {
        trigger: { type: 'item_created' },
        actions: [{ type: 'webhook', url: 'https://example.com/x' }],
      },
    });
    expect(auto.status).toBe(403);
    const invite = await as(g1).post(`/boards/${portalId}/invite`, { emails: ['bob@acme.test'] });
    expect(invite.status).toBe(403);
  });
});

describe('S-04 activity never shows a view-restricted column', () => {
  it('a member without access gets no events of that column; the admin does', async () => {
    const col = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'שכר', type: 'text' }))).id;
    const restricted = await as(admin).put(`/boards/${boardId}/columns/${col}/restriction`, {
      kind: 'view',
      users: [],
      teams: [],
    });
    expect(restricted.status).toBe(200);
    const item = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'עובד' }));
    expect((await as(admin).put(`/items/${item.id}/cells/${col}`, { value: 'סוד 12345' })).status).toBe(200);

    const adminLog = await body(await as(admin).get(`/items/${item.id}/activity`));
    expect(JSON.stringify(adminLog)).toContain('12345');
    const bobItem = await as(bob).get(`/items/${item.id}/activity`);
    expect(bobItem.status).toBe(200);
    expect(JSON.stringify(await body(bobItem))).not.toContain('12345');
    const bobBoard = await body(await as(bob).get(`/boards/${boardId}/activity`));
    expect(JSON.stringify(bobBoard)).not.toContain('12345');
    expect(bobBoard.data.some((r: Json) => r.column_id === col)).toBe(false);
  });
});

describe('S-05 response security headers', () => {
  it('API answers carry nosniff, no framing, a referrer policy and a deny-all CSP', async () => {
    const res = await t.app.request('/api/v1/health');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
  });
});

describe('S-09 request body limit', () => {
  it('a body over the limit is refused with 413 before it is parsed', async () => {
    const big = JSON.stringify({ name: 'x'.repeat(MAX_REQUEST_BYTES + 10) });
    const res = await as(admin).post(`/boards/${boardId}/items`, JSON.parse(big));
    expect(res.status).toBe(413);
    expect((await body(res)).error.code).toBe('payload_too_large');
  });
});

describe('S-06 CSV export neutralises formulas', () => {
  it('an item named like a formula is exported as text', async () => {
    await as(admin).post(`/boards/${boardId}/items`, { name: '=HYPERLINK("http://evil.test","x")' });
    const res = await as(admin).post(`/boards/${boardId}/export`, { format: 'csv' });
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.test"",""x"")"`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
  });
});

describe('S-07 files open in place only when the type cannot run code', () => {
  it('HTML, SVG and XML are always attachments', () => {
    for (const m of [
      'image/png',
      'image/jpeg',
      'application/pdf',
      'video/mp4',
      'audio/mpeg',
      'text/plain; charset=utf-8',
    ])
      expect(isInlineSafeMime(m), m).toBe(true);
    for (const m of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'text/xml', 'application/javascript', ''])
      expect(isInlineSafeMime(m), m).toBe(false);
  });
});
