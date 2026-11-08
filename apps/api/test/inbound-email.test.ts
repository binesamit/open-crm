// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, desc, eq, like } from 'drizzle-orm';
import { memoryMailer } from '@bines/server-mail';
import { INBOUND_LIMITS, newId, parseInboundAddress, stripQuotedReply } from '@bines/shared';
import { dispatchNotification } from '../../worker/src/notifications';
import type { SqlClient } from '../../worker/src/repositories/trash.repo';
import { inboundEmails, notifications, users } from '../src/db/schema';
import {
  setInboundProviderForTests,
  type ReceivedAttachment,
  type ReceivedEmail,
} from '../src/modules/inbound-email/provider';
import { signWebhook } from '../src/modules/inbound-email/signature';
import type * as Outbound from '../src/lib/outbound';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

// Images from the web: one fake public host serves them; every other URL goes through the real guard.
const fetched = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('../src/lib/outbound', async (importOriginal) => {
  const actual = await importOriginal<typeof Outbound>();
  return {
    ...actual,
    outboundDownload: async (url: string, opts: Parameters<typeof actual.outboundDownload>[1]) => {
      const u = new URL(url);
      if (u.hostname !== 'img.news.test') return actual.outboundDownload(url, opts);
      fetched.urls.push(url);
      if (u.pathname.endsWith('.svg'))
        return { url, mime: 'image/svg+xml', fileName: null, body: Buffer.from('<svg onload="x()"/>') };
      return { url, mime: 'image/png', fileName: null, body: Buffer.from('PNGDATA') };
    },
  };
});

/** Incoming email: item / board addresses, the signed provider webhook, the job's rules. */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SECRET = `whsec_${Buffer.from('inbound-test-signing-secret').toString('base64')}`;
const DOMAIN = 'in.platform.test';

let t: TestContext;
let owner: string;
let admin: string;
let acmeId: string;
let boardId: string;
let itemId: string;
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

/** The fake provider's mailbox: what each received email id holds. */
const mails = new Map<string, ReceivedEmail & { files?: (ReceivedAttachment & { bytes: Buffer })[] }>();
const AUTH_OK = { spf: 'pass', dkim: 'pass', dmarc: 'pass' };
let seq = 0;
/** The provider's link to an original message (.eml), and what it holds. */
const RAW_URL = 'https://files.provider.test/raw';
const RAW = Buffer.from('From: dana@client.test\r\nSubject: Long\r\n\r\nbody');

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

/** POSTs a webhook to the inbound endpoint, signed (or not). */
const hook = (payload: unknown, opts: { secret?: string | null; at?: number } = {}) => {
  const raw = JSON.stringify(payload);
  const id = `msg_${++seq}`;
  const ts = opts.at ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.secret !== null) {
    headers['svix-id'] = id;
    headers['svix-timestamp'] = String(ts);
    headers['svix-signature'] = signWebhook(opts.secret ?? SECRET, id, ts, raw);
  }
  return t.app.request('/api/v1/hooks/email/resend', { method: 'POST', headers, body: raw });
};

/** A message arrives: stored at the fake provider, announced by a signed webhook (processed inline in tests). */
const deliver = async (
  to: string | string[],
  m: Partial<ReceivedEmail> & { files?: (ReceivedAttachment & { bytes: Buffer })[] } = {},
) => {
  const id = `em_${++seq}`;
  const recipients = Array.isArray(to) ? to : [to];
  mails.set(id, {
    id,
    from: m.from ?? 'Dana Client <dana@client.test>',
    to: recipients,
    subject: m.subject === undefined ? 'Re: the proposal' : m.subject,
    text: m.text === undefined ? 'Looks good, go ahead.' : m.text,
    html: m.html ?? null,
    message_id: m.message_id === undefined ? `<${id}@client.test>` : m.message_id,
    headers: m.headers ?? {},
    authentication: m.authentication === undefined ? AUTH_OK : m.authentication,
    files: m.files,
    raw_url: m.raw_url ?? null,
  });
  const res = await hook({
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: { email_id: id, from: m.from ?? 'dana@client.test', to: recipients, cc: [], received_for: [] },
  });
  return { id, res };
};
const logOf = async (providerId: string) =>
  t.db.select().from(inboundEmails).where(eq(inboundEmails.providerEmailId, providerId));
const updatesOf = async (cookie: string, item: string) =>
  (await body(await as(cookie).get(`/items/${item}/updates`))).data;

beforeAll(async () => {
  t = await createTestContext({ env: { RESEND_INBOUND_SECRET: SECRET } });
  setInboundProviderForTests({
    getEmail: async (id) => {
      const m = mails.get(id);
      if (!m) throw new Error('unknown_email');
      return m;
    },
    listAttachments: async (id) => mails.get(id)?.files ?? [],
    download: async (url) => {
      if (url === RAW_URL) return RAW;
      for (const m of mails.values()) for (const f of m.files ?? []) if (f.download_url === url) return f.bytes;
      throw new Error('unknown_file');
    },
  });
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
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
  // Sign-up by invitation link: the address is the invitation's — verified.
  await t.db.update(users).set({ emailVerified: true }).where(eq(users.email, 'admin@acme.test'));
  const wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Deals', workspace_id: wsId }))).id;
  itemId = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Website project' }))).id;
});
afterAll(async () => {
  setInboundProviderForTests(null);
  await t.close();
});

describe('quoted history', () => {
  it('keeps only the new part of a reply; a message that is only quotes stays whole', () => {
    expect(stripQuotedReply('Approved.\n\nOn Tue, 14 Oct 2026 at 10:00, Dana <a@b.test> wrote:\n> old text')).toBe(
      'Approved.',
    );
    expect(stripQuotedReply('מאושר\n\nבתאריך יום ג׳, 14 באוק׳ 2026, דנה כתבה:\n> ישן')).toBe('מאושר');
    expect(stripQuotedReply('Fine\n\nFrom: Dana\nSent: Tuesday\nTo: Dana\nSubject: x\n\nold')).toBe('Fine');
    expect(stripQuotedReply('Thanks\n-- \nDana, CEO')).toBe('Thanks');
    expect(stripQuotedReply('> only a quote')).toBe('> only a quote');
    // "From:" inside a sentence is not a header block.
    expect(stripQuotedReply('From: the team, with thanks')).toBe('From: the team, with thanks');
  });
});

describe('addresses', () => {
  it('is off until the platform has an inbound domain, then on in every account unless the account turns it off', async () => {
    const res = await body(await as(admin).get(`/items/${itemId}/email-address`));
    expect(res).toMatchObject({ kind: 'item', address: null, off: 'platform' });
    expect((await as(admin).post(`/items/${itemId}/email-address`, {})).status).toBe(403);

    expect((await t.api(owner).patch('/platform/settings', { email: { inbound_domain: DOMAIN } })).status).toBe(200);
    expect((await body(await as(admin).get(`/items/${itemId}/email-address`))).off).toBeNull();

    expect((await as(admin).patch('/accounts/me', { settings: { inbound_email: { enabled: false } } })).status).toBe(
      200,
    );
    expect((await body(await as(admin).get(`/items/${itemId}/email-address`))).off).toBe('account');
    expect((await as(admin).post(`/items/${itemId}/email-address`, {})).status).toBe(403);
    expect((await as(admin).patch('/accounts/me', { settings: { inbound_email: { enabled: true } } })).status).toBe(
      200,
    );
  });

  it('makes one random address per item on first use; rotating retires the old one', async () => {
    const made = await body(await as(admin).post(`/items/${itemId}/email-address`, {}));
    expect(made.off).toBeNull();
    expect(parseInboundAddress(made.address, DOMAIN)).toMatchObject({ kind: 'item' });
    expect(made.address).toMatch(new RegExp(`^item-[a-z0-9]{24}@${DOMAIN.replace(/\./g, '\\.')}$`));
    // Idempotent.
    expect((await body(await as(admin).post(`/items/${itemId}/email-address`, {}))).address).toBe(made.address);
    expect((await body(await as(admin).get(`/items/${itemId}/email-address`))).address).toBe(made.address);

    const rotated = await body(await as(admin).post(`/items/${itemId}/email-address/rotate`, {}));
    expect(rotated.address).not.toBe(made.address);
    // Mail to the old address is dropped — with the same answer as any other (nothing says the token existed).
    const { id, res } = await deliver(made.address);
    expect(await body(res)).toEqual({ received: true });
    expect(await logOf(id)).toEqual([]);
    const unknown = await deliver(`item-${'z'.repeat(24)}@${DOMAIN}`);
    expect(await body(unknown.res)).toEqual({ received: true });
  });

  it('a stranger to the board cannot read or make its address', async () => {
    await as(admin).post('/users/invite', { emails: ['guest@acme.test'], role: 'member' });
    const other = await join('guest@acme.test');
    const ws2 = (await body(await as(admin).post('/workspaces', { name: 'Private', kind: 'closed' }))).id;
    const secretBoard = (
      await body(await as(admin).post('/boards', { name: 'HR', workspace_id: ws2, kind: 'private' }))
    ).id;
    const res = await as(other).get(`/boards/${secretBoard}/email-address`);
    expect([403, 404]).toContain(res.status);
  });
});

describe('the webhook', () => {
  it('refuses unsigned, wrongly signed and stale calls', async () => {
    const payload = { type: 'email.received', data: { email_id: 'x', to: [] } };
    expect((await hook(payload, { secret: null })).status).toBe(401);
    expect((await hook(payload, { secret: `whsec_${Buffer.from('other').toString('base64')}` })).status).toBe(401);
    expect((await hook(payload, { at: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    // Signed, but another event: acknowledged, nothing queued.
    expect(await body(await hook({ type: 'email.sent', data: {} }))).toEqual({ received: true });
  });
});

describe('mail to an item', () => {
  let address: string;
  beforeAll(async () => {
    address = (await body(await as(admin).post(`/items/${itemId}/email-address`, {}))).address;
  });

  it('from outside the account: an update with no author, the sender shown, quotes stripped, files kept', async () => {
    const { id } = await deliver(address, {
      text: 'Approved, thanks!\n\nOn Mon, Dana wrote:\n> please approve',
      files: [
        {
          id: 'att1',
          filename: 'signed.pdf',
          content_type: 'application/pdf',
          content_disposition: 'attachment',
          content_id: null,
          size: 5,
          download_url: 'https://files.provider.test/att1',
          bytes: Buffer.from('%PDF-'),
        },
        {
          id: 'att2',
          filename: 'logo.png',
          content_type: 'image/png',
          content_disposition: 'inline',
          content_id: 'logo1',
          size: 3,
          download_url: 'https://files.provider.test/att2',
          bytes: Buffer.from('png'),
        },
        {
          id: 'att3',
          filename: 'run.html',
          content_type: 'text/html',
          content_disposition: 'attachment',
          content_id: null,
          size: 4,
          download_url: 'https://files.provider.test/att3',
          bytes: Buffer.from('<b/>'),
        },
      ],
    });
    expect((await logOf(id))[0]).toMatchObject({ status: 'done', fromEmail: 'dana@client.test' });
    const [u] = await updatesOf(admin, itemId);
    expect(u.source).toBe('email');
    expect(u.author).toBeNull();
    expect(u.email).toEqual({
      from: 'dana@client.test',
      name: 'Dana Client',
      subject: 'Re: the proposal',
      external: true,
      // What became of the files: the PDF attached, the HTML file skipped by its type.
      files: { attached: 1, skipped: [{ name: 'run.html', reason: 'type' }] },
    });
    expect(u.body_text).toContain('Approved, thanks!');
    expect(u.body_text).not.toContain('please approve');
    // The PDF is kept; the inline signature logo is not a file; HTML is not an allowed type (listed above).
    expect(u.files.map((f: Json) => f.name)).toEqual(['signed.pdf']);
    // The address's creator hears about it (they did not write it).
    const bell = await body(await as(admin).get('/me/notifications'));
    expect(bell.data.some((n: Json) => n.type === 'item_update' && n.actor === null)).toBe(true);
  });

  it('an HTML message shows formatted, with its body images kept as files and images from the web proxied', async () => {
    fetched.urls.length = 0;
    const big = Buffer.alloc(20 * 1024, 7);
    const tracking = 'https://links.email.news.test/CL0/https:%2F%2Fnews.test%2Fpost%2F1/1/0100019a2b3c4d5e';
    const { id } = await deliver(address, {
      subject: 'Weekly news',
      text: 'Weekly news [image: hero]',
      html: `<html><head><style>.x{}</style></head><body>
        <div style="display:none">preview line</div>
        <h1>This <b>week</b></h1>
        <p><img src="cid:hero@mail" alt="Hero" width="600"></p>
        <p>Read <a href="${tracking}">${tracking}</a></p>
        <img src="https://img.news.test/banner.png" alt="Banner">
        <img src="https://img.news.test/banner.png" alt="Again">
        <img src="https://img.news.test/open.gif" width="1" height="1">
        <img src="https://img.news.test/logo.svg">
        <p>Thanks<br><img src="cid:sig@mail" alt="sig"></p>
      </body></html>`,
      files: [
        {
          id: 'h1',
          filename: 'hero.png',
          content_type: 'image/png',
          content_disposition: 'inline',
          content_id: '<hero@mail>',
          size: big.length,
          download_url: 'https://files.provider.test/hero',
          bytes: big,
        },
        {
          id: 's1',
          filename: 'sig.png',
          content_type: 'image/png',
          content_disposition: 'inline',
          content_id: '<sig@mail>',
          size: 900,
          download_url: 'https://files.provider.test/sig',
          bytes: Buffer.alloc(900, 1),
        },
      ],
    });
    expect((await logOf(id))[0]!.status).toBe('done');
    const [u] = await updatesOf(admin, itemId);
    // Formatting kept, hidden text and styles gone, the long tracking link as a short label.
    expect(u.body_html).toContain('<strong>week</strong>');
    expect(u.body_text).not.toContain('preview line');
    expect(u.body_html).toContain('>קישור</a>');
    expect(u.body_html).toContain('href="https://links.email.news.test/CL0/');
    // The hero is a file of the update, shown in place; the small signature image is skipped (and listed).
    expect(u.files.map((f: Json) => f.name)).toEqual(['hero.png']);
    const heroId = u.files[0].id;
    expect(u.body_html).toContain(`data-image-ref="asset:${heroId}"`);
    expect(u.body_html).not.toContain('sig.png');
    expect(u.email.files).toEqual({ attached: 1, skipped: [{ name: 'sig.png', reason: 'small_image' }] });
    // The web image appears twice but is listed once; the tracking pixel is dropped; nothing was fetched yet.
    expect(u.body_html.match(/data-image-ref="remote:0"/g)).toHaveLength(2);
    expect(u.body_html).toContain('data-image-ref="remote:1"');
    expect(u.body_html).not.toContain('img.news.test');
    expect(fetched.urls).toEqual([]);

    // The images through the app: the stored one redirects to its link; the web one is passed on, not stored.
    const img = (ref: string, cookie = admin) =>
      t.app.request(`/api/v1/updates/${u.id}/email-images/${ref}?account_id=${acmeId}`, {
        headers: { cookie },
        redirect: 'manual',
      });
    const hero = await img(`asset:${heroId}`);
    expect(hero.status).toBe(302);
    expect(hero.headers.get('location')).toBeTruthy();
    const banner = await img('remote:0');
    expect(banner.status).toBe(200);
    expect(banner.headers.get('content-type')).toBe('image/png');
    expect(banner.headers.get('cache-control')).toBe('private, max-age=86400');
    expect(Buffer.from(await banner.arrayBuffer()).toString()).toBe('PNGDATA');
    expect(fetched.urls).toEqual(['https://img.news.test/banner.png']);
    // SVG is not passed on; an unknown index, a file not on this update and a bad ref get nothing.
    expect((await img('remote:1')).status).toBe(404);
    expect((await img('remote:7')).status).toBe(404);
    expect((await img('asset:01ZZZZZZZZZZZZZZZZZZZZZZZZ')).status).toBe(404);
    expect((await img('anything')).status).toBe(404);

    // The account turns images from the web off: not shown any more.
    await as(admin).patch('/accounts/me', { settings: { inbound_email: { remote_images: false } } });
    expect((await img('remote:0')).status).toBe(404);
    await as(admin).patch('/accounts/me', { settings: { inbound_email: { remote_images: true } } });
  });

  it("the account's settings: body images off, or a lower size threshold", async () => {
    const file = (cid: string, size: number) => ({
      id: cid,
      filename: `${cid}.png`,
      content_type: 'image/png',
      content_disposition: 'inline',
      content_id: `<${cid}>`,
      size,
      download_url: `https://files.provider.test/${cid}`,
      bytes: Buffer.alloc(size, 2),
    });
    await as(admin).patch('/accounts/me', { settings: { inbound_email: { body_images: false } } });
    await deliver(address, { html: '<p>Hi <img src="cid:a1"></p>', files: [file('a1', 50_000)] });
    let [u] = await updatesOf(admin, itemId);
    expect(u.files).toEqual([]);
    expect(u.email.files.skipped).toEqual([{ name: 'a1.png', reason: 'images_off' }]);
    await as(admin).patch('/accounts/me', {
      settings: { inbound_email: { body_images: true, body_image_min_kb: 0 } },
    });
    await deliver(address, { html: '<p>Hi <img src="cid:a2"></p>', files: [file('a2', 300)] });
    [u] = await updatesOf(admin, itemId);
    expect(u.files.map((f: Json) => f.name)).toEqual(['a2.png']);
    await as(admin).patch('/accounts/me', { settings: { inbound_email: { body_image_min_kb: 10 } } });
    const detail = await body(await as(admin).get('/accounts/me'));
    expect(detail.settings.inbound_email).toMatchObject({
      body_images: true,
      body_image_min_kb: 10,
      remote_images: true,
    });
  });

  it('a message too long to show whole: the start, a note, and the original attached as .eml', async () => {
    const para = `<p>${'word '.repeat(2000)}</p>`;
    await deliver(address, {
      html: para.repeat(Math.ceil(INBOUND_LIMITS.maxTextChars / 10_000) + 1),
      raw_url: RAW_URL,
      files: [],
    });
    const [u] = await updatesOf(admin, itemId);
    expect(u.email.cut).toBe(true);
    expect(u.body_text.length).toBeLessThan(INBOUND_LIMITS.maxTextChars + 1000);
    expect(u.body_text).toContain('message.eml');
    expect(u.files.map((f: Json) => [f.name, f.mime])).toEqual([['message.eml', 'message/rfc822']]);
    expect(u.email.files).toEqual({ attached: 1, skipped: [] });
  });

  it("the platform owner's limits of one message apply (empty = the defaults)", async () => {
    const big = (cid: string) => ({
      id: cid,
      filename: `${cid}.png`,
      content_type: 'image/png',
      content_disposition: 'inline',
      content_id: `<${cid}>`,
      size: 40_000,
      download_url: `https://files.provider.test/${cid}`,
      bytes: Buffer.alloc(40_000, 3),
    });
    const set = (email: Record<string, number | null>) => t.api(owner).patch('/platform/settings', { email });
    expect((await set({ inbound_max_body_images: 1, inbound_max_text_chars: 1_000 })).status).toBe(200);
    // Out of range: refused.
    expect((await set({ inbound_max_text_chars: 10 })).status).toBe(400);
    expect((await set({ inbound_max_remote_image_mb: 99 })).status).toBe(400);
    await deliver(address, {
      html: `<img src="cid:l1"><img src="cid:l2"><p>${'word '.repeat(400)}</p>`,
      raw_url: RAW_URL,
      files: [big('l1'), big('l2')],
    });
    const [u] = await updatesOf(admin, itemId);
    // One body image kept, the second over the limit; the text cut at 1,000 characters, the original attached.
    expect(u.email.cut).toBe(true);
    expect(u.email.files.skipped).toEqual([{ name: 'l2.png', reason: 'too_many' }]);
    expect(u.files.map((f: Json) => f.name).sort()).toEqual(['l1.png', 'message.eml']);
    expect(u.body_text.length).toBeLessThan(1_200);
    await set({ inbound_max_body_images: null, inbound_max_text_chars: null });
    await deliver(address, { html: `<p>short</p><img src="cid:l3"><img src="cid:l4">`, files: [big('l3'), big('l4')] });
    const [v] = await updatesOf(admin, itemId);
    expect(v.files.map((f: Json) => f.name).sort()).toEqual(['l3.png', 'l4.png']);
  });

  it("the item's notification emails answer to its address (Reply → an update)", async () => {
    const [n] = await t.db
      .select({ id: notifications.id })
      .from(notifications)
      .where(and(eq(notifications.itemId, itemId), eq(notifications.type, 'item_update')))
      .orderBy(desc(notifications.id))
      .limit(1);
    const mailer = memoryMailer();
    expect(
      await dispatchNotification(t.pg as unknown as SqlClient, { mailer, appUrl: 'https://app.test' }, n!.id),
    ).toBe('sent');
    expect(mailer.sent[0]!.replyTo).toBe(address);
  });

  it('from a verified member: written in their name', async () => {
    const { id } = await deliver(address, { from: 'Admin <ADMIN@acme.test>', text: 'Sent from my phone' });
    expect((await logOf(id))[0]!.status).toBe('done');
    const [u] = await updatesOf(admin, itemId);
    expect(u.author?.name).toBeTruthy();
    expect(u.email).toMatchObject({ from: 'admin@acme.test', external: false });
  });

  it('takes a message once: the same webhook again, or the same Message-ID again', async () => {
    const before = (await updatesOf(admin, itemId)).length;
    const first = await deliver(address, { message_id: '<same@client.test>' });
    expect((await logOf(first.id))[0]!.status).toBe('done');
    const again = await deliver(address, { message_id: '<same@client.test>' });
    expect((await logOf(again.id))[0]).toMatchObject({ status: 'rejected', reason: 'duplicate' });
    expect((await updatesOf(admin, itemId)).length).toBe(before + 1);
  });

  it('drops unauthenticated senders, auto-replies and our own mail coming back', async () => {
    const spoof = await deliver(address, { authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail' } });
    expect((await logOf(spoof.id))[0]).toMatchObject({ status: 'rejected', reason: 'unauthenticated_sender' });
    const none = await deliver(address, { authentication: null });
    expect((await logOf(none.id))[0]!.reason).toBe('unauthenticated_sender');
    const ooo = await deliver(address, { headers: { 'auto-submitted': 'auto-replied' } });
    expect((await logOf(ooo.id))[0]!.reason).toBe('automatic');
    const loop = await deliver(address, { from: `x <board-abc@${DOMAIN}>` });
    expect((await logOf(loop.id))[0]!.reason).toBe('loop');
  });

  it('follows the account policy: members only, or listed domains', async () => {
    await as(admin).patch('/accounts/me', { settings: { inbound_email: { senders: 'members' } } });
    const out = await deliver(address);
    expect((await logOf(out.id))[0]!.reason).toBe('sender_not_allowed');
    await as(admin).patch('/accounts/me', {
      settings: { inbound_email: { senders: 'domains', domains: ['client.test'] } },
    });
    expect((await logOf((await deliver(address)).id))[0]!.status).toBe('done');
    const other = await deliver(address, { from: 'eve@elsewhere.test' });
    expect((await logOf(other.id))[0]!.reason).toBe('sender_not_allowed');
    await as(admin).patch('/accounts/me', { settings: { inbound_email: { senders: 'anyone', domains: [] } } });
  });

  it('stops at the hourly limit of an address', async () => {
    const seed = await deliver(address);
    const [row] = await logOf(seed.id);
    await t.db.insert(inboundEmails).values(
      Array.from({ length: INBOUND_LIMITS.perAddressPerHour }, (_, i) => ({
        id: newId(),
        accountId: acmeId,
        addressId: row!.addressId,
        providerEmailId: `flood_${i}`,
        status: 'done',
      })),
    );
    const over = await deliver(address);
    expect((await logOf(over.id))[0]).toMatchObject({ status: 'rejected', reason: 'rate_limited' });
    await t.db.delete(inboundEmails).where(like(inboundEmails.providerEmailId, 'flood_%'));
  });

  it('nothing is taken while the account has it off', async () => {
    await as(admin).patch('/accounts/me', { settings: { inbound_email: { enabled: false } } });
    const off = await deliver(address);
    expect(await body(off.res)).toEqual({ received: true });
    expect(await logOf(off.id)).toEqual([]);
    await as(admin).patch('/accounts/me', { settings: { inbound_email: { enabled: true } } });
  });
});

describe('mail to a board', () => {
  it('becomes a new item named by the subject, with the message as its first update', async () => {
    const address = (await body(await as(admin).post(`/boards/${boardId}/email-address`, {}))).address;
    expect(address).toMatch(/^board-/);
    const { id } = await deliver(address, { subject: 'New request: landing page', text: 'Can you quote this?' });
    const [log] = await logOf(id);
    expect(log!.status).toBe('done');
    const item = await body(await as(admin).get(`/items/${log!.itemId}`));
    expect(item.name).toBe('New request: landing page');
    const [u] = await updatesOf(admin, log!.itemId!);
    expect(u.body_text).toContain('Can you quote this?');
    expect(u.email.external).toBe(true);
  });
});

describe('webhook abuse (runs last: it trips the per-address limiter)', () => {
  it('too many bad signatures from one address → 429, even for a good one', async () => {
    const payload = { type: 'email.sent', data: {} };
    for (let i = 0; i < 25; i++) await hook(payload, { secret: null });
    expect((await hook(payload)).status).toBe(429);
  });
});
