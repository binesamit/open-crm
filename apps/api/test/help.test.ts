// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiClientFactory, AiCompletionRequest } from '@bines/server-ai';
import { helpRouteOf } from '@bines/shared';
import { aiUsage, supportTickets } from '../src/db/schema';
import { scrubPii, stripAccountEmbeds } from '../src/modules/help/help.content';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * The knowledge center (stages 1–6): articles in the owner console (drafts, versions, publish
 * languages, account embeds stripped), who may write / publish, Hebrew-aware search, suggestions by screen and while
 * typing, the help assistant (no tools, only published articles, citations, "not found"; the plan gate, the platform
 * connection with its per-account cap, an account's own connection), the metrics and "turn a ticket into an article".
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let agent: string;
let lead: string;
let otherAdmin: string;
let acmeId: string;
let otherId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

/** The mocked provider: answers from the articles it was given, citing [A1]; "NOT_FOUND" for the unknown. */
const calls: { req: AiCompletionRequest; key: string }[] = [];
const aiClient: AiClientFactory = (conn) => ({
  provider: conn.provider,
  test: async () => ({ ok: true, error: null }),
  complete: async (req) => {
    calls.push({ req, key: conn.apiKey });
    const msg = req.messages[0]!.content as string;
    const text = /quantum/i.test(msg)
      ? 'NOT_FOUND'
      : 'Open the column menu and choose Status [A1]. Labels are edited in the column settings [A1].';
    const usage = { input_tokens: 2000, output_tokens: 100 };
    return { model: req.model, text, stopReason: 'end_turn', usage, costUsd: 0.01, content: [] };
  },
});

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string, accountId = acmeId) => t.api(cookie, accountId);
const con = (cookie: string) => t.api(cookie);
const doc = (...paras: string[]) => ({
  type: 'doc',
  content: paras.map((p) => ({ type: 'paragraph', content: [{ type: 'text', text: p }] })),
});

const write = async (cookie: string, input: Json) => {
  const res = await con(cookie).post('/platform/support/help/articles', input);
  const json = await body(res);
  expect(res.status, JSON.stringify(json)).toBe(201);
  return json;
};
const publish = async (id: string, cookie = lead) => {
  const res = await con(cookie).post(`/platform/support/help/articles/${id}/publish`);
  expect(res.status).toBe(200);
  return body(res);
};
const search = async (q: string, cookie = bob, extra = '') =>
  (await body(await as(cookie).get(`/support/help/search?q=${encodeURIComponent(q)}${extra}`))).data as Json[];

let statusArticle: Json;
let labelsArticle: Json;

beforeAll(async () => {
  t = await createTestContext({ aiClient });
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme Widgets', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'admin@other.test');
  await mk('Helpers', 'helpers', 'agent@support.test');
  admin = await join('admin@acme.test');
  otherAdmin = await join('admin@other.test');
  agent = await join('agent@support.test');
  await as(agent, (await body(await t.api(agent).get('/me/accounts'))).data[0].id).post('/users/invite', {
    emails: ['lead@support.test'],
    role: 'member',
  });
  lead = await join('lead@support.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  await con(owner).post('/platform/support/staff', { email: 'agent@support.test', role: 'agent' });
  await con(owner).post('/platform/support/staff', { email: 'lead@support.test', role: 'lead' });
});
afterAll(() => t.close());

describe('content helpers', () => {
  it('strips account-only embeds and keeps their visible text', () => {
    const out = stripAccountEmbeds({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Ask ' },
            { type: 'mention', attrs: { id: 'u1', label: 'Dana' } },
            { type: 'entityLink', attrs: { kind: 'item', id: 'i1', label: 'Lead 7' } },
          ],
        },
        { type: 'itemEmbed', attrs: { item_id: 'x' } },
        { type: 'boardEmbed', attrs: { board_id: 'y' } },
        { type: 'callout', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tip' }] }] },
      ],
    })!;
    const json = JSON.stringify(out);
    expect(json).not.toContain('mention');
    expect(json).not.toContain('itemEmbed');
    expect(json).not.toContain('boardEmbed');
    expect(json).toContain('Dana');
    expect(json).toContain('Lead 7');
    expect(json).toContain('Tip');
  });

  it('maps app paths to screens', () => {
    expect(helpRouteOf('/a/acme/b/01ABC')).toBe('board');
    expect(helpRouteOf('/a/acme/automations')).toBe('automations');
    expect(helpRouteOf('/a/acme')).toBe('home');
  });

  it('scrubs personal details', () => {
    const out = scrubPii(
      'Hi, I am Dana Levi (dana@acme.test, 054-1234567) from Acme Widgets. See https://app.test/a/acme/b/01HZX4T9V4M6P8Q2R3S5T7V9WX id 01HZX4T9V4M6P8Q2R3S5T7V9WX card 123456789',
      { names: ['Dana Levi'], account: ['Acme Widgets', 'acme'] },
    );
    for (const leaked of ['Dana', 'Levi', 'dana@acme.test', '054-1234567', 'Acme', 'https://', '01HZX4', '123456789'])
      expect(out).not.toContain(leaked);
    expect(out).toContain('[email]');
    expect(out).toContain('[phone]');
    expect(out).toContain('[name]');
    expect(out).toContain('[account]');
  });
});

describe('permissions: only the owner and support staff author; customers read published only', () => {
  it('customers and strangers never reach the console', async () => {
    expect((await con(bob).get('/platform/support/help/config')).status).toBe(404);
    expect((await con(admin).post('/platform/support/help/articles', { title: 'x' })).status).toBe(404);
  });

  it('agents write, leads publish (the defaults); the owner may change who may', async () => {
    const cfg = await body(await con(agent).get('/platform/support/help/config'));
    expect(cfg).toMatchObject({ role: 'agent', may_write: true, may_publish: false, may_configure: false });
    const a = await write(agent, { title: 'Draft by an agent', content: doc('body') });
    expect((await con(agent).post(`/platform/support/help/articles/${a.id}/publish`)).status).toBe(403);
    expect((await con(agent).patch('/platform/support/help/settings', { enabled: true })).status).toBe(403);
    // The owner lets agents publish, then takes it back.
    expect(
      (await con(owner).patch('/platform/support/help/settings', { publish_roles: ['agent', 'lead'] })).status,
    ).toBe(200);
    expect((await con(agent).post(`/platform/support/help/articles/${a.id}/publish`)).status).toBe(200);
    await con(owner).patch('/platform/support/help/settings', { publish_roles: ['lead'] });
    await con(owner).patch('/platform/support/help/settings', { write_roles: ['lead'] });
    expect((await con(agent).post('/platform/support/help/articles', { title: 'nope' })).status).toBe(403);
    await con(owner).patch('/platform/support/help/settings', { write_roles: ['agent', 'lead'] });
    expect((await con(lead).post(`/platform/support/help/articles/${a.id}/unpublish`)).status).toBe(200);
    expect((await con(lead).del(`/platform/support/help/articles/${a.id}`)).status).toBe(200);
  });
});

describe('articles: CRUD, versions, publish, languages', () => {
  it('a draft is invisible to readers until published; versions track the working copy', async () => {
    const cats = await body(
      await con(lead).post('/platform/support/help/categories', { name: 'בורדים', name_en: 'Boards', icon: 'board' }),
    );
    const boards = (cats.categories as Json[]).find((c) => c.name === 'בורדים')!;
    statusArticle = await write(agent, {
      title: 'איך מוסיפים עמודת סטטוס',
      locale: 'he',
      category_id: boards.id,
      tags: ['עמודות', 'בורד'],
      visibility: 'public',
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'פותחים את תפריט העמודה בבורד ובוחרים סטטוס. ' },
              { type: 'mention', attrs: { id: 'x', label: 'רונית' } },
            ],
          },
          { type: 'itemEmbed', attrs: { item_id: 'secret' } },
        ],
      },
    });
    expect(statusArticle).toMatchObject({ status: 'draft', version: 1, slug: 'איך-מוסיפים-עמודת-סטטוס' });
    expect(JSON.stringify(statusArticle.content)).not.toContain('itemEmbed');
    expect(JSON.stringify(statusArticle.content)).not.toContain('"mention"');
    expect(await search('סטטוס')).toEqual([]);
    expect((await as(bob).get(`/support/help/articles/${statusArticle.id}`)).status).toBe(404);

    await publish(statusArticle.id);
    expect((await search('סטטוס')).map((h) => h.id)).toEqual([statusArticle.id]);

    // An edit makes a new version; readers keep seeing the published one until "publish".
    const edited = await body(
      await con(agent).patch(`/platform/support/help/articles/${statusArticle.id}`, {
        title: 'איך מוסיפים עמודת סטטוס לבורד',
        content: doc('פותחים את תפריט העמודה ובוחרים סטטוס. התוויות נערכות בהגדרות העמודה.'),
      }),
    );
    expect(edited).toMatchObject({ version: 2, published_version: 1, unpublished_changes: true });
    const view = await body(await as(bob).get(`/support/help/articles/${statusArticle.id}`));
    expect(view.title).toBe('איך מוסיפים עמודת סטטוס');
    expect(view.html).not.toContain('התוויות');
    // Metadata alone is no new version.
    const meta = await body(
      await con(agent).patch(`/platform/support/help/articles/${statusArticle.id}`, {
        tags: ['עמודות', 'בורד', 'סטטוס'],
      }),
    );
    expect(meta.version).toBe(2);
    await publish(statusArticle.id);
    const versions = (await body(await con(agent).get(`/platform/support/help/articles/${statusArticle.id}/versions`)))
      .data as Json[];
    expect(versions.map((v) => `${v.kind}:${v.version}`).sort()).toEqual(
      ['publish:1', 'publish:2', 'save:1', 'save:2'].sort(),
    );
    // Restore version 1 → version 3 (a new working copy), published stays v2.
    const v1 = versions.find((v) => v.kind === 'save' && v.version === 1)!;
    const restored = await body(
      await con(agent).post(`/platform/support/help/articles/${statusArticle.id}/versions/${v1.id}/restore`),
    );
    expect(restored).toMatchObject({ version: 3, title: 'איך מוסיפים עמודת סטטוס', published_version: 2 });
    await con(agent).patch(`/platform/support/help/articles/${statusArticle.id}`, {
      title: 'איך מוסיפים עמודת סטטוס לבורד',
      content: doc('פותחים את תפריט העמודה ובוחרים סטטוס. התוויות נערכות בהגדרות העמודה.'),
    });
    statusArticle = await publish(statusArticle.id);
  });

  it('an English translation joins the same group; slugs are unique per language', async () => {
    const en = await write(agent, {
      title: 'How to add a status column',
      locale: 'en',
      translation_of: statusArticle.id,
      visibility: 'public',
      content: doc('Open the column menu on the board and choose Status.'),
    });
    expect(en.group_id).toBe(statusArticle.group_id);
    expect(en.translations).toEqual([{ id: statusArticle.id, locale: 'he', title: 'איך מוסיפים עמודת סטטוס לבורד' }]);
    expect(
      (
        await con(agent).post('/platform/support/help/articles', {
          title: 'again',
          locale: 'en',
          translation_of: statusArticle.id,
        })
      ).status,
    ).toBe(409);
    const clash = await con(agent).post('/platform/support/help/articles', {
      title: 'x',
      locale: 'en',
      slug: en.slug,
    });
    expect(clash.status).toBe(409);
    await publish(en.id);
    const view = await body(await as(bob).get(`/support/help/articles/${statusArticle.id}`));
    expect(view.translations).toEqual([{ slug: en.slug, locale: 'en', title: 'How to add a status column' }]);
  });
});

describe('search and suggestions', () => {
  it('understands Hebrew prefixes ("לבורד" finds "בורד", "בעמודה" finds "עמודה")', async () => {
    labelsArticle = await write(agent, {
      title: 'שינוי צבע של תווית',
      tags: ['תוויות'],
      content: doc('כדי לשנות צבע לתווית לוחצים על העמודה ובוחרים עריכת תוויות.'),
    });
    await publish(labelsArticle.id);
    expect((await search('לבורד')).map((h) => h.id)).toContain(statusArticle.id);
    expect((await search('בעמודה')).map((h) => h.id)).toEqual(
      expect.arrayContaining([statusArticle.id, labelsArticle.id]),
    );
    // Title weighs more than body: "תווית" in a title ranks first.
    expect((await search('תווית'))[0]!.id).toBe(labelsArticle.id);
    // English in English.
    expect((await search('status column', bob, '&locale=en'))[0]!.locale).toBe('en');
  });

  it('suggests by screen (route → tags) and while typing (no search recorded)', async () => {
    expect(
      (
        await con(lead).patch('/platform/support/help/settings', {
          route_tags: [{ route: 'board', tags: ['בורד'] }],
          flow: { max_suggestions: 2 },
        })
      ).status,
    ).toBe(200);
    const forBoard = (await body(await as(bob).get('/support/help/search?route=board'))).data as Json[];
    expect(forBoard.map((h) => h.id)).toEqual([statusArticle.id]);
    expect((await body(await as(bob).get('/support/help/search?route=automations'))).data).toEqual([]);
    const before = await body(await con(lead).get('/platform/support/help/metrics'));
    const typing = (
      await body(await as(bob).get(`/support/help/search?mode=typing&q=${encodeURIComponent('עמודת סטטוס לא נשמרת')}`))
    ).data as Json[];
    expect(typing.length).toBeGreaterThan(0);
    expect(typing.length).toBeLessThanOrEqual(2);
    const after = await body(await con(lead).get('/platform/support/help/metrics'));
    expect(after.searches).toBe(before.searches);
    const options = await body(await as(bob).get('/support/help/options'));
    expect(options).toMatchObject({ enabled: true, show_articles: true, max_suggestions: 2 });
    // The ticket form's hook is on now.
    expect((await body(await as(bob).get('/support/tickets/options'))).suggest_articles).toBe(true);
  });

  it('the public help center shows only articles for everyone; drafts never', async () => {
    const anon = t.api(undefined);
    expect((await anon.get('/help/center')).status).toBe(200);
    const pub = (await body(await anon.get(`/help/articles?q=${encodeURIComponent('תווית')}`))).data as Json[];
    expect(pub.map((h) => h.id)).not.toContain(labelsArticle.id); // signed_in only
    expect((await anon.get(`/help/articles/${labelsArticle.slug}`)).status).toBe(404);
    const ok = await body(await anon.get(`/help/articles/${encodeURIComponent(statusArticle.slug)}`));
    expect(ok.title).toBe('איך מוסיפים עמודת סטטוס לבורד');
    expect(ok.html).toContain('<p>');
    await con(lead).patch('/platform/support/help/settings', { public_enabled: false });
    expect((await anon.get('/help/center')).status).toBe(404);
    await con(lead).patch('/platform/support/help/settings', { public_enabled: true });
  });

  it("article links use the help center's address when set, else the app's (decision a)", async () => {
    const slug = encodeURIComponent(labelsArticle.slug);
    const hit = (await search('תווית')).find((h) => h.id === labelsArticle.id)!;
    expect(hit.url).toBe(`${t.deps.env.WEB_ORIGIN}/help?article=${slug}`);
    await con(lead).patch('/platform/support/help/settings', { base_url: 'https://help.example.test/' });
    const moved = (await search('תווית')).find((h) => h.id === labelsArticle.id)!;
    expect(moved.url).toBe(`https://help.example.test/help?article=${slug}`);
    const view = await body(await as(bob).get(`/support/help/articles/${labelsArticle.id}`));
    expect(view.url).toBe(moved.url);
    await con(lead).patch('/platform/support/help/settings', { base_url: null });
  });

  it("the options count each category's published articles (the knowledge center page's cards)", async () => {
    const res = await con(lead).post('/platform/support/help/categories', { name: 'הגדרות חשבון', icon: 'board' });
    expect(res.status).toBe(200);
    const cat = ((await body(res)).categories as Json[]).find((c) => c.name === 'הגדרות חשבון')!;
    const a = await write(agent, { title: 'מאמר בקטגוריה', category_id: cat.id, content: doc('תוכן') });
    await publish(a.id);
    // A draft in the same category is not counted.
    await write(agent, { title: 'טיוטה בקטגוריה', category_id: cat.id, content: doc('טיוטה') });
    const options = await body(await as(bob).get('/support/help/options'));
    expect(options.category_counts[cat.id]).toBe(1);
    const list = (await body(await as(bob).get(`/support/help/search?category_id=${cat.id}`))).data as Json[];
    expect(list.map((h) => h.id)).toEqual([a.id]);
  });

  it('guests and support sessions get no help panel', async () => {
    expect((await as(bob, otherId).get('/support/help/options')).status).toBe(404);
  });
});

describe('the help assistant', () => {
  const model = 'claude-haiku-4-5';
  const ask = (q: string, cookie = bob, account = acmeId) =>
    as(cookie, account).post('/support/help/ask', { question: q });

  it('is off until the platform connection is configured', async () => {
    const opts = await body(await as(bob).get('/support/help/options'));
    expect(opts).toMatchObject({ assistant: false, assistant_off_reason: 'not_configured' });
    expect((await ask('how do I add a status column?')).status).toBe(403);
    // Turning it on without a key is refused.
    expect((await con(lead).patch('/platform/support/help/settings', { ai: { enabled: true } })).status).toBe(422);
    const res = await con(lead).patch('/platform/support/help/settings', {
      ai: { enabled: true, provider: 'anthropic', api_key: 'sk-platform-key-123456', model, default_cap_usd: 5 },
    });
    const s = await body(res);
    expect(res.status).toBe(200);
    expect(s.ai).toMatchObject({ has_key: true, key_hint: expect.any(String), model });
    expect(JSON.stringify(s)).not.toContain('sk-platform-key');
    expect(s.ai.key_enc).toBeUndefined();
    expect((await body(await con(lead).post('/platform/support/help/ai/test'))).ok).toBe(true);
  });

  it('answers only from published articles, with citations, and no tools — on the platform connection', async () => {
    calls.length = 0;
    const res = await ask('איך מוסיפים עמודת סטטוס לבורד?');
    const answer = await body(res);
    expect(res.status, JSON.stringify(answer)).toBe(200);
    expect(answer.found).toBe(true);
    expect(answer.answer).toContain('Open the column menu');
    expect(answer.answer).not.toContain('[A1]');
    expect(answer.citations).toEqual([
      {
        id: statusArticle.id,
        slug: statusArticle.slug,
        title: expect.any(String),
        url: `${t.deps.env.WEB_ORIGIN}/help?article=${encodeURIComponent(statusArticle.slug)}`,
      },
    ]);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.key).toBe('sk-platform-key-123456');
    expect(call.req.tools).toBeUndefined();
    expect(String(call.req.system)).toContain('ONLY');
    expect(String(call.req.messages[0]!.content)).toContain('[A1]');
    // Drafts never reach the model.
    const draft = await write(agent, { title: 'סוד טיוטה', content: doc('עמודת סטטוס סודית בטיוטה') });
    calls.length = 0;
    await ask('עמודת סטטוס');
    expect(String(calls[0]!.req.messages[0]!.content)).not.toContain('סודית');
    await con(lead).del(`/platform/support/help/articles/${draft.id}`);
    // Usage: source help on the platform connection, not the account's spend.
    const rows = await t.db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.accountId, acmeId), eq(aiUsage.source, 'help')));
    expect(rows.length).toBe(1);
    expect(rows[0]!.calls).toBe(2);
    await as(admin).patch('/ai/settings', { enabled: true });
    const report = await body(await as(admin).get('/ai/usage'));
    expect(report.rows.filter((r: Json) => r.source === 'help')).toEqual([]);
  });

  it("the account admin's help-assistant switch; the general AI switch gates only the own connection (decision b)", async () => {
    // The account's general AI off (its default, or set explicitly) keeps the platform-paid assistant on.
    await as(admin).patch('/ai/settings', { enabled: false });
    expect((await body(await as(bob).get('/support/help/options'))).assistant).toBe(true);
    // Members cannot switch it; the admin can — then no assistant, even on the platform's connection.
    expect((await as(bob).patch('/support/help/ai-settings', { allowed: false })).status).toBe(403);
    const off = await body(await as(admin).patch('/support/help/ai-settings', { allowed: false }));
    expect(off).toMatchObject({ allowed: false, source: 'platform' });
    expect(await body(await as(bob).get('/support/help/options'))).toMatchObject({
      assistant: false,
      assistant_off_reason: 'account_off',
    });
    calls.length = 0;
    const res = await ask('איך מוסיפים עמודת סטטוס לבורד?');
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('help_ai_unavailable');
    expect(calls).toHaveLength(0);
    expect((await body(await as(admin).patch('/support/help/ai-settings', { allowed: true }))).allowed).toBe(true);
    expect((await body(await as(bob).get('/support/help/options'))).assistant).toBe(true);
    await as(admin).patch('/ai/settings', { enabled: true });
  });

  it('says "not found" when the articles do not answer (and when nothing matches, without a model call)', async () => {
    calls.length = 0;
    const none = await body(await ask('zxqv blorp'));
    expect(none).toEqual({ found: false, answer: null, citations: [] });
    expect(calls).toHaveLength(0);
    const nf = await body(await ask('quantum status column'));
    expect(nf.found).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('the cap: per account per month, set by the owner; then the panel goes to the form', async () => {
    const r1 = await body(await con(lead).patch(`/platform/support/help/accounts/${acmeId}/ai`, { cap_usd: 0.000001 }));
    expect(r1.effective_cap_usd).toBe(0.000001);
    expect(r1.used_usd).toBeGreaterThan(0);
    await con(lead).patch('/platform/support/help/settings', { ai: { cap_message: 'Monthly help limit reached' } });
    const opts = await body(await as(bob).get('/support/help/options'));
    expect(opts).toMatchObject({
      assistant: false,
      assistant_off_reason: 'cap_reached',
      cap_message: 'Monthly help limit reached',
    });
    const res = await ask('עמודת סטטוס');
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('help_ai_cap_reached');
    await con(lead).patch(`/platform/support/help/accounts/${acmeId}/ai`, { cap_usd: null });
    expect((await body(await as(bob).get('/support/help/options'))).assistant).toBe(true);
  });

  it('the plan gate: an account whose plan lacks AI never sees the assistant', async () => {
    const plan = await body(
      await t.api(owner).post('/platform/plans', { name: 'No AI', version: { features: ['guests'] } }),
    );
    expect(
      (await t.api(owner).put(`/platform/accounts/${otherId}/subscription`, { plan_version_id: plan.versions[0].id }))
        .status,
    ).toBe(200);
    const opts = await body(await as(otherAdmin, otherId).get('/support/help/options'));
    expect(opts).toMatchObject({ assistant: false, assistant_off_reason: 'plan' });
    const res = await ask('עמודת סטטוס', otherAdmin, otherId);
    expect(res.status).toBe(402);
    // Articles still work.
    expect(
      (await body(await as(otherAdmin, otherId).get(`/support/help/search?q=${encodeURIComponent('סטטוס')}`))).data
        .length,
    ).toBeGreaterThan(0);
  });

  it("the account's own connection: chosen by its admin, used and paid by the account", async () => {
    // Members cannot change it.
    expect((await as(bob).patch('/support/help/ai-settings', { source: 'own' })).status).toBe(403);
    const conn = await body(
      await as(admin).post('/ai/connections', { name: 'Ours', provider: 'anthropic', api_key: 'sk-acme-own-key-999' }),
    );
    expect(conn.id).toBeTruthy();
    // Own needs a connection.
    expect((await as(admin).patch('/support/help/ai-settings', { source: 'own' })).status).toBe(422);
    const set = await body(
      await as(admin).patch('/support/help/ai-settings', { source: 'own', connection_id: conn.id }),
    );
    expect(set).toMatchObject({ source: 'own', connection_id: conn.id, own_allowed: true });
    calls.length = 0;
    const answer = await body(await ask('איך מוסיפים עמודת סטטוס?'));
    expect(answer.found).toBe(true);
    expect(calls[0]!.key).toBe('sk-acme-own-key-999');
    const own = await t.db
      .select()
      .from(aiUsage)
      .where(and(eq(aiUsage.accountId, acmeId), eq(aiUsage.source, 'help'), eq(aiUsage.connectionId, conn.id)));
    expect(own).toHaveLength(1);
    const report = await body(await as(admin).get('/ai/usage'));
    expect(report.rows.filter((r: Json) => r.source === 'help').map((r: Json) => r.connection_id)).toEqual([conn.id]);
    // The account's AI switched off → own mode is off too.
    await as(admin).patch('/ai/settings', { enabled: false });
    expect((await body(await as(bob).get('/support/help/options'))).assistant_off_reason).toBe('ai_disabled');
    await as(admin).patch('/ai/settings', { enabled: true });
    // The owner disallows own connections → back to the platform's; and may lock an account to a source.
    await con(lead).patch('/platform/support/help/settings', { ai: { own_connection_allowed: false } });
    calls.length = 0;
    await ask('איך מוסיפים עמודת סטטוס?');
    expect(calls[0]!.key).toBe('sk-platform-key-123456');
    expect((await as(admin).patch('/support/help/ai-settings', { source: 'own' })).status).toBe(403);
    await con(owner).patch(`/platform/support/help/accounts/${acmeId}/ai`, { source: 'own', locked: true });
    calls.length = 0;
    await ask('איך מוסיפים עמודת סטטוס?');
    expect(calls[0]!.key).toBe('sk-acme-own-key-999');
    expect((await as(admin).patch('/support/help/ai-settings', { source: 'platform' })).status).toBe(403);
    await con(owner).patch(`/platform/support/help/accounts/${acmeId}/ai`, { source: 'platform', locked: false });
    await con(lead).patch('/platform/support/help/settings', { ai: { own_connection_allowed: true } });
  });
});

describe('metrics and "did this help?"', () => {
  it('counts helpful yes/no, deflections, tickets after help and zero-result searches', async () => {
    const before = await body(await con(lead).get('/platform/support/help/metrics?days=7'));
    await as(bob).post(`/support/help/articles/${statusArticle.id}/feedback`, { helpful: true });
    await as(bob).post(`/support/help/articles/${statusArticle.id}/feedback`, { helpful: false });
    await as(bob).post(`/support/help/articles/${labelsArticle.id}/feedback`, { helpful: true });
    // One vote per person per article (decision c): voting again keeps one vote, the latest.
    await as(bob).post(`/support/help/articles/${labelsArticle.id}/feedback`, { helpful: true });
    await as(admin).post(`/support/help/articles/${statusArticle.id}/feedback`, { helpful: true });
    await as(bob).post('/support/help/events', { kind: 'deflected', article_id: statusArticle.id });
    await as(bob).post('/support/help/events', { kind: 'deflected' });
    await as(bob).post('/support/help/events', { kind: 'ticket_opened', query: 'status' });
    await search('מילהשאיננה בשוםמקום');
    await search('מילהשאיננה בשוםמקום');
    const m = await body(await con(agent).get('/platform/support/help/metrics?days=7'));
    // bob: status yes → no (the no replaces the yes), labels yes twice (one vote); admin: status yes.
    expect(m.helpful_yes - before.helpful_yes).toBe(2);
    expect(m.helpful_no - before.helpful_no).toBe(1);
    expect(m.deflected - before.deflected).toBe(2);
    expect(m.tickets_opened - before.tickets_opened).toBe(1);
    expect(m.deflection_rate).toBeCloseTo(m.deflected / (m.deflected + m.tickets_opened), 3);
    expect(m.zero_result_queries).toEqual(expect.arrayContaining([{ query: 'מילהשאיננה בשוםמקום', count: 2 }]));
    expect(m.ai_answers).toBeGreaterThan(0);
    expect(m.ai_not_found).toBeGreaterThan(0);
    const row = (m.articles as Json[]).find((a) => a.id === statusArticle.id)!;
    expect(row).toMatchObject({ helpful_yes: 1, helpful_no: 1 });
    expect((m.articles as Json[]).find((a) => a.id === labelsArticle.id)).toMatchObject({
      helpful_yes: 1,
      helpful_no: 0,
    });
    expect(row.views).toBeGreaterThan(0);
    const summary = (
      (await body(await con(agent).get('/platform/support/help/articles?status=published'))).data as Json[]
    ).find((a) => a.id === statusArticle.id)!;
    expect(summary).toMatchObject({ helpful_yes: 1, helpful_no: 1 });
  });
});

describe('turn a solved ticket into an article draft', () => {
  it('drafts from the question and the public answers, personal details removed, never published', async () => {
    const ticket = await body(
      await as(bob).post('/support/tickets', {
        subject: 'Status column for Acme Widgets does not save',
        description: 'Hi, I am bob (bob@acme.test, 050-7654321). Board https://x.test/a/acme/b/1 loses status.',
      }),
    );
    await con(agent).post(`/platform/support/tickets/${ticket.id}/messages`, {
      body: 'Internal: customer is on the big plan',
      visibility: 'internal',
    });
    await con(agent).post(`/platform/support/tickets/${ticket.id}/messages`, {
      body: 'Hi bob, open the column settings and save the labels again.',
    });
    // Not yet solved → refused.
    expect((await con(agent).post(`/platform/support/tickets/${ticket.id}/article`)).status).toBe(409);
    await con(agent).patch(`/platform/support/tickets/${ticket.id}`, { status: 'solved' });
    expect((await con(bob).post(`/platform/support/tickets/${ticket.id}/article`)).status).toBe(404);
    const res = await con(agent).post(`/platform/support/tickets/${ticket.id}/article`);
    const draft = await body(res);
    expect(res.status, JSON.stringify(draft)).toBe(201);
    expect(draft).toMatchObject({ status: 'draft', source_ticket_id: ticket.id, visibility: 'signed_in' });
    const all = JSON.stringify(draft);
    for (const leaked of ['bob@acme.test', '050-7654321', 'Acme', 'acme', 'https://', 'Internal', 'big plan'])
      expect(all).not.toContain(leaked);
    expect(all).not.toMatch(/\bbob\b/i);
    expect(all).toContain('save the labels again');
    expect(draft.title).toContain('[account]');
    // Nobody reads it until a person publishes it.
    expect((await as(bob).get(`/support/help/articles/${draft.id}`)).status).toBe(404);
    const drafted = (
      await t.db.execute<{ n: number }>(
        sql`select count(*)::int as n from support_ticket_events where ticket_id = ${ticket.id} and type = 'article_drafted'`,
      )
    ).rows;
    expect(drafted[0]?.n).toBe(1);
    expect((await t.db.select().from(supportTickets).where(eq(supportTickets.id, ticket.id)))[0]!.status).toBe(
      'solved',
    );
  });
});
