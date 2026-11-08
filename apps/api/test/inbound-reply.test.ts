// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { aiTool, needsApproval, parseInboundAddress } from '@bines/shared';
import { threadHeaders } from '@bines/server-mail';
import type { Db } from '../src/db/client';
import { inboundEmails, users } from '../src/db/schema';
import { TOOL_RUNNERS } from '../src/modules/ai/tools/runners';
import { memberActor } from '../src/modules/inbound-email/inbound.service';
import { setInboundProviderForTests, type ReceivedEmail } from '../src/modules/inbound-email/provider';
import { signWebhook } from '../src/modules/inbound-email/signature';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Reply by email: an answer from the item to whoever emailed it — only them, threaded under their
 * message, with the item's address as Reply-To so their answer lands on the same item; kept as the item's update.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const SECRET = `whsec_${Buffer.from('inbound-reply-signing-secret').toString('base64')}`;
const DOMAIN = 'in.platform.test';

let t: TestContext;
let db: Db;
let owner: string;
let admin: string;
let adminId: string;
let acmeId: string;
let boardId: string;
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const mails = new Map<string, ReceivedEmail>();
let seq = 0;

const deliver = async (to: string, m: { subject?: string; text?: string; from?: string } = {}) => {
  const id = `em_${++seq}`;
  mails.set(id, {
    id,
    from: m.from ?? 'Dana Client <dana@client.test>',
    to: [to],
    subject: m.subject ?? 'Help with my order',
    text: m.text ?? 'Where is my order?',
    html: null,
    message_id: `<${id}@client.test>`,
    headers: {},
    authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    raw_url: null,
  });
  const raw = JSON.stringify({
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: { email_id: id, from: 'dana@client.test', to: [to], cc: [], received_for: [] },
  });
  const ts = Math.floor(Date.now() / 1000);
  await t.app.request('/api/v1/hooks/email/resend', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': `msg_${id}`,
      'svix-timestamp': String(ts),
      'svix-signature': signWebhook(SECRET, `msg_${id}`, ts, raw),
    },
    body: raw,
  });
  return (await db.select().from(inboundEmails).where(eq(inboundEmails.providerEmailId, id)))[0]!;
};
const reply = async (itemId: string, input: Json) =>
  TOOL_RUNNERS.reply_by_email!(
    { deps: t.deps, actor: (await memberActor(db, acmeId, adminId, 'test'))!, scopes: [], batchId: null },
    { item_id: itemId, ...input },
  ) as Promise<Json>;

beforeAll(async () => {
  t = await createTestContext({ env: { RESEND_INBOUND_SECRET: SECRET } });
  db = t.db as unknown as Db;
  setInboundProviderForTests({
    getEmail: async (id) => mails.get(id)!,
    listAttachments: async () => [],
    download: async () => Buffer.from(''),
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
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  await db.update(users).set({ emailVerified: true }).where(eq(users.email, 'admin@acme.test'));
  adminId = (await db.select().from(users).where(eq(users.email, 'admin@acme.test')))[0]!.id;
  await t.api(owner).patch('/platform/settings', { email: { inbound_domain: DOMAIN } });
  // Anyone may email the account's addresses (the account's own setting).
  await as(admin).patch('/accounts/me', { settings: { inbound_email: { enabled: true, senders: 'anyone' } } });
  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Support', workspace_id: ws }))).id;
});
afterAll(async () => {
  setInboundProviderForTests(null);
  await t.close();
});

describe('reply by email', () => {
  it('a learner agent waits for a person; an autonomous one sends unless marked "with approval"', () => {
    const tool = aiTool('reply_by_email')!;
    expect(needsApproval(tool, { approval_mode: 'learner', approval_tools: [] })).toBe(true);
    expect(needsApproval(tool, { approval_mode: 'autonomous', approval_tools: [] })).toBe(false);
    expect(needsApproval(tool, { approval_mode: 'autonomous', approval_tools: ['reply_by_email'] })).toBe(true);
  });

  it('answers the sender only, threaded, Reply-To the item; their answer comes back to the same item', async () => {
    const boardAddress = (await body(await as(admin).post(`/boards/${boardId}/email-address`, {}))).address;
    const first = await deliver(boardAddress);
    expect(first.status).toBe('done');
    const itemId = first.itemId!;

    const sentBefore = t.mailer.sent.length;
    const out = await reply(itemId, { text: 'It ships tomorrow.' });
    expect(out).toMatchObject({ to: 'dana@client.test', subject: 'Re: Help with my order' });
    const mail = t.mailer.sent.slice(sentBefore).find((m) => m.to === 'dana@client.test')!;
    expect(mail.text).toContain('It ships tomorrow.');
    expect(mail.inReplyTo).toBe(first.messageId);
    expect(threadHeaders(mail)).toEqual({
      'In-Reply-To': `<em_1@client.test>`,
      References: `<em_1@client.test>`,
    });
    expect(parseInboundAddress(mail.replyTo!, DOMAIN)).toMatchObject({ kind: 'item' });

    // Kept as the item's update, by who sent it, saying to whom.
    const updates = (await body(await as(admin).get(`/items/${itemId}/updates`))).data as Json[];
    const sent = updates.find((u) => u.email_reply);
    expect(sent).toMatchObject({
      body_text: 'It ships tomorrow.',
      email_reply: { to: 'dana@client.test', subject: 'Re: Help with my order' },
      author: { id: adminId },
    });

    // The customer answers the reply: the item's address — the same item, no new one.
    const second = await deliver(mail.replyTo!, { subject: 'Re: Help with my order', text: 'Thanks!' });
    expect(second).toMatchObject({ status: 'done', itemId });
    const again = (await body(await as(admin).get(`/items/${itemId}/updates`))).data as Json[];
    expect(again.some((u) => u.body_text.includes('Thanks!'))).toBe(true);

    // A second reply answers the newest message (threaded under it), to the same Reply-To.
    await reply(itemId, { text: 'You are welcome.' });
    const last = t.mailer.sent[t.mailer.sent.length - 1]!;
    expect(last).toMatchObject({ to: 'dana@client.test', inReplyTo: second.messageId, replyTo: mail.replyTo });
  });

  it('nobody to answer on an item no email came to', async () => {
    const plain = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Internal' }))).id;
    await expect(reply(plain, { text: 'Hi' })).rejects.toMatchObject({
      code: 'invalid_value',
      message: 'reply_no_email',
    });
  });
});
