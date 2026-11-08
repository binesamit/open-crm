// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Knowledge-center articles on support replies: the console's picker lists only published articles
 * the ticket's customer may read; a reply keeps the article ids (the card follows the article's current title and
 * drops out when the article is unpublished); the customer sees the cards, the email lists title + link; nothing
 * unpublished, deleted or unknown can be attached.
 */
let t: TestContext;
let owner: string;
let admin: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const con = (cookie: string) => t.api(cookie);
const as = (cookie: string) => t.api(cookie, acmeId);
const doc = (...paras: string[]) => ({
  type: 'doc',
  content: paras.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
});

const write = async (input: Json, publish = true) => {
  const res = await con(owner).post('/platform/support/help/articles', input);
  const a = await body(res);
  expect(res.status, JSON.stringify(a)).toBe(201);
  if (publish) expect((await con(owner).post(`/platform/support/help/articles/${a.id}/publish`)).status).toBe(200);
  return a;
};

let ticketId: string;
let statusArticle: Json;
let membersArticle: Json;
let draft: Json;

beforeAll(async () => {
  t = await createTestContext();
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
  ).account.id as string;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });

  statusArticle = await write({
    title: 'Adding a status column',
    locale: 'en',
    visibility: 'public',
    excerpt: 'Open the column menu and choose Status.',
    content: doc('Open the column menu on the board and choose Status. Labels are edited in the settings.'),
  });
  membersArticle = await write({
    title: 'Inviting teammates',
    locale: 'en',
    visibility: 'signed_in',
    content: doc('Admins invite teammates from the people page.'),
  });
  draft = await write({ title: 'Unfinished status draft', locale: 'en', content: doc('status draft') }, false);

  const res = await as(admin).post('/support/tickets', {
    subject: 'How do I add a status column?',
    description: 'I cannot find it',
  });
  expect(res.status).toBe(201);
  ticketId = (await body(res)).id;
});
afterAll(() => t.close());

describe('the "attach an article" picker', () => {
  it('lists only published articles the customer may read, searched by words', async () => {
    const all = await body(await con(owner).get(`/platform/support/tickets/${ticketId}/articles`));
    expect(all.enabled).toBe(true);
    const ids = (all.data as Json[]).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([statusArticle.id, membersArticle.id]));
    expect(ids).not.toContain(draft.id);

    const found = await body(await con(owner).get(`/platform/support/tickets/${ticketId}/articles?q=status`));
    expect((found.data as Json[]).map((a) => a.id)).toEqual([statusArticle.id]);
    expect(found.data[0]).toMatchObject({
      title: 'Adding a status column',
      excerpt: 'Open the column menu and choose Status.',
      locale: 'en',
    });
    expect(found.data[0].url).toContain('/help?article=');
  });

  it('is the support console’s only (404 to a member) and 404 for an unknown ticket', async () => {
    expect((await con(admin).get(`/platform/support/tickets/${ticketId}/articles`)).status).toBe(404);
    expect((await con(owner).get('/platform/support/tickets/01NOPE0000000000000000000/articles')).status).toBe(404);
  });
});

describe('a reply with an article', () => {
  it('stores the reference, shows the customer a card and emails title + link', async () => {
    const sent = t.mailer.sent.length;
    const res = await con(owner).post(`/platform/support/tickets/${ticketId}/messages`, {
      body: 'This article explains it',
      visibility: 'public',
      article_ids: [statusArticle.id],
    });
    expect(res.status).toBe(200);
    const staffView = await body(res);
    const reply = (staffView.messages as Json[]).find((m) => m.kind === 'staff')!;
    expect(reply.articles).toEqual([
      expect.objectContaining({ id: statusArticle.id, title: 'Adding a status column' }),
    ]);
    expect((staffView.events as Json[]).some((e) => e.type === 'articles')).toBe(true);

    const mine = await body(await as(admin).get(`/support/tickets/${ticketId}`));
    const card = (mine.messages as Json[]).find((m) => m.kind === 'staff')!.articles[0];
    expect(card).toMatchObject({ id: statusArticle.id, title: 'Adding a status column' });
    expect(card.excerpt).toBe('Open the column menu and choose Status.');

    const mail = t.mailer.sent.slice(sent).find((m) => m.to === 'admin@acme.test')!;
    expect(mail).toBeDefined();
    expect(mail.text).toContain('Adding a status column');
    expect(mail.text).toContain(card.url);
    expect(mail.html).toContain('Adding a status column');
  });

  it('an article alone is a reply; the card follows the article’s current title', async () => {
    const res = await con(owner).post(`/platform/support/tickets/${ticketId}/messages`, {
      visibility: 'public',
      article_ids: [membersArticle.id],
    });
    expect(res.status).toBe(200);
    // The article is renamed and published again: the card shows the new title (only the id was kept).
    await con(owner).patch(`/platform/support/help/articles/${membersArticle.id}`, { title: 'Inviting your team' });
    await con(owner).post(`/platform/support/help/articles/${membersArticle.id}/publish`);
    const mine = await body(await as(admin).get(`/support/tickets/${ticketId}`));
    const cards = (mine.messages as Json[]).flatMap((m) => m.articles as Json[]);
    expect(cards.find((a) => a.id === membersArticle.id)?.title).toBe('Inviting your team');
  });

  it('an unpublished article drops out of the customer’s view', async () => {
    await con(owner).post(`/platform/support/help/articles/${membersArticle.id}/unpublish`);
    const mine = await body(await as(admin).get(`/support/tickets/${ticketId}`));
    const cards = (mine.messages as Json[]).flatMap((m) => m.articles as Json[]);
    expect(cards.map((a) => a.id)).toEqual([statusArticle.id]);
    await con(owner).post(`/platform/support/help/articles/${membersArticle.id}/publish`);
  });

  it('refuses drafts and unknown ids (422), too many articles and an empty reply (400)', async () => {
    const post = (input: Json) => con(owner).post(`/platform/support/tickets/${ticketId}/messages`, input);
    const drafted = await post({ body: 'x', article_ids: [draft.id] });
    expect(drafted.status).toBe(422);
    expect((await body(drafted)).error.message).toBe('ticket_article_unavailable');
    expect((await post({ body: 'x', article_ids: ['01NOPE0000000000000000000'] })).status).toBe(422);
    expect((await post({ body: 'x', article_ids: Array(6).fill(statusArticle.id) })).status).toBe(400);
    expect((await post({ body: '  ' })).status).toBe(400);
  });

  it('nothing is attachable while the knowledge center is off', async () => {
    await con(owner).patch('/platform/support/help/settings', { enabled: false });
    const list = await body(await con(owner).get(`/platform/support/tickets/${ticketId}/articles`));
    expect(list).toEqual({ enabled: false, data: [] });
    expect(
      (
        await con(owner).post(`/platform/support/tickets/${ticketId}/messages`, {
          body: 'x',
          article_ids: [statusArticle.id],
        })
      ).status,
    ).toBe(422);
    await con(owner).patch('/platform/support/help/settings', { enabled: true });
  });
});
