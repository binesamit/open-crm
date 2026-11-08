// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_LEGAL_SLUGS } from '@bines/shared';
import { legalDocuments } from '../src/db/schema';
import { LEGAL_DEFAULTS } from '../src/modules/legal/legal.defaults';
import { resetLegalSeed } from '../src/modules/legal/legal.service';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Legal documents: default drafts are seeded + published once; public pages render them with the
 * operator's details from platform settings (never literals); the owner edits a draft and publishes versions; people
 * accept the current version when joining (and again after an update); nobody else reaches the console.
 */
let t: TestContext;
let owner: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const anon = () => t.api('');
/** The defaults seeded as drafts (the owner fills and publishes them): accessibility, DPA and 's five. */
const DRAFTS: readonly string[] = [
  'accessibility',
  'dpa',
  'subscription',
  'sla',
  'developer-terms',
  'security',
  'copyright',
];

const join = async (email: string, accepted?: { slug: string; version: number }[]) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  const res = await t
    .api(cookie)
    .post('/invitations/accept', { token, ...(accepted ? { accepted_legal: accepted } : {}) });
  expect(res.status).toBe(200);
  return cookie;
};

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
  ).account.id;
});
afterAll(() => t.close());

describe('public legal pages', () => {
  it('lists the default documents, published as version 1, without signing in', async () => {
    const res = await anon().get('/legal');
    expect(res.status).toBe(200);
    const list = (await body(res)).data as Json[];
    // The accessibility statement (its coordinator) and the DPA (legal review) start as drafts — the owner publishes them.
    expect(list.map((d) => d.slug)).toEqual(DEFAULT_LEGAL_SLUGS.filter((s) => !DRAFTS.includes(s)));
    expect(list.every((d) => d.version === 1)).toBe(true);
    expect(list.filter((d) => d.requires_consent).map((d) => d.slug)).toEqual(['terms', 'privacy']);
    // joining shows "by joining you agree …" unless the owner asks for a checkbox
    expect((await body(await anon().get('/legal'))).consent_checkbox).toBe(false);
    await t.api(owner).patch('/platform/settings', { legal: { consent_checkbox: true } });
    expect((await body(await anon().get('/legal'))).consent_checkbox).toBe(true);
    await t.api(owner).patch('/platform/settings', { legal: { consent_checkbox: null } });
  });

  it('renders a document per language, marked as a draft, with visible markers for missing operator details', async () => {
    const he = await body(await anon().get('/legal/privacy?locale=he'));
    expect(he.title).toBe('מדיניות פרטיות');
    expect(he.html).toContain('טיוטה לבדיקת עורך דין');
    expect(he.html).toContain('[company_legal_name]');
    expect(he.html).not.toMatch(/\{\{/);
    expect(he.headings.length).toBeGreaterThan(3);
    const en = await body(await anon().get('/legal/privacy?locale=en'));
    expect(en.title).toBe('Privacy Policy');
    expect(en.html).toContain('Draft for legal review');
    expect(en.documents).toHaveLength(DEFAULT_LEGAL_SLUGS.length - DRAFTS.length); // all but the drafts
  });

  it("fills the operator's details from platform settings", async () => {
    const r = await t.api(owner).patch('/platform/settings', {
      product_name: 'Acme Cloud',
      legal: { company_legal_name: 'Example Ltd', privacy_email: 'privacy@example.test' },
    });
    expect(r.status).toBe(200);
    const en = await body(await anon().get('/legal/privacy?locale=en'));
    expect(en.html).toContain('Example Ltd');
    expect(en.html).toContain('privacy@example.test');
    expect(en.html).toContain('Acme Cloud');
    expect(en.html).not.toContain('[company_legal_name]');
  });

  // No country is assumed: the governing law and the courts are the operator's settings, a visible marker until set.
  it('takes the governing law and the courts from the settings, never a built-in country', async () => {
    const before = await body(await anon().get('/legal/terms?locale=en'));
    expect(before.html).toContain('[governing_law]');
    expect(before.html).toContain('[courts_location]');
    expect(before.html).not.toMatch(/State of Israel|Tel Aviv/);
    const r = await t.api(owner).patch('/platform/settings', {
      legal: { governing_law: 'England and Wales', courts_location: 'London' },
    });
    expect(r.status).toBe(200);
    const after = await body(await anon().get('/legal/terms?locale=en'));
    expect(after.html).toContain('governed by the laws of England and Wales');
    expect(after.html).toContain('competent courts in London');
    // the copyright policy's counter-notice (a draft, not published by default) uses the same placeholder
    const copyright = LEGAL_DEFAULTS.find((d) => d.slug === 'copyright')!.texts.body;
    for (const text of [copyright.he, copyright.en]) {
      expect(text).toContain('{{courts_location}}');
      expect(text).not.toMatch(/בישראל;|courts in Israel/);
    }
    await t.api(owner).patch('/platform/settings', { legal: { governing_law: null, courts_location: null } });
  });

  // the accessibility statement (Israeli Standard 5568) is a default document, seeded as a DRAFT — nothing
  // public shows it until the owner fills the coordinator and publishes it; a platform seeded before it gets the draft.
  it('ships an accessibility statement as a draft; published by the owner, it shows the coordinator', async () => {
    expect((await anon().get('/legal/accessibility?locale=he')).status).toBe(404);
    expect(((await body(await anon().get('/legal'))).data as { slug: string }[]).map((d) => d.slug)).not.toContain(
      'accessibility',
    );
    const r = await t.api(owner).patch('/platform/settings', {
      legal: {
        accessibility_coordinator: 'Dana Cohen',
        accessibility_phone: '03-0000000',
        accessibility_email: 'access@example.test',
      },
    });
    expect(r.status).toBe(200);
    expect((await t.api(owner).post('/platform/legal/accessibility/publish')).status).toBe(200);
    const he = await body(await anon().get('/legal/accessibility?locale=he'));
    expect(he.title).toBe('הצהרת נגישות');
    expect(he.html).toContain('5568');
    const en = await body(await anon().get('/legal/accessibility?locale=en'));
    expect(en.title).toBe('Accessibility Statement');
    for (const v of ['Dana Cohen', '03-0000000', 'access@example.test']) expect(en.html).toContain(v);
    expect(en.html).not.toContain('[accessibility_');
    await t.api(owner).patch('/platform/settings', {
      legal: { accessibility_coordinator: null, accessibility_phone: null, accessibility_email: null },
    });

    // A platform seeded before the statement existed: the next start adds it as a draft and keeps the rest.
    const terms = (await t.db.select().from(legalDocuments).where(eq(legalDocuments.slug, 'terms')))[0]!;
    await t.db.delete(legalDocuments).where(eq(legalDocuments.slug, 'accessibility'));
    resetLegalSeed(t.db);
    const list = (await body(await anon().get('/legal'))).data as { slug: string }[];
    expect(list.map((d) => d.slug)).not.toContain('accessibility');
    const added = (await t.db.select().from(legalDocuments).where(eq(legalDocuments.slug, 'accessibility')))[0]!;
    expect(added.publishedVersion).toBeNull();
    const termsAfter = (await t.db.select().from(legalDocuments).where(eq(legalDocuments.slug, 'terms')))[0]!;
    expect(termsAfter.id).toBe(terms.id);
  });

  // Privacy: the DPA is a draft for legal review — added to an existing platform, it never goes public.
  it('adds the DPA to an existing platform as an unpublished draft', async () => {
    await t.db.delete(legalDocuments).where(eq(legalDocuments.slug, 'dpa'));
    resetLegalSeed(t.db);
    const list = (await body(await anon().get('/legal'))).data as { slug: string }[];
    expect(list.map((d) => d.slug)).not.toContain('dpa');
    const added = (await t.db.select().from(legalDocuments).where(eq(legalDocuments.slug, 'dpa')))[0]!;
    expect(added.publishedVersion).toBeNull();
    expect((added.draft as { title: { en: string } }).title.en).toBe('Data Processing Addendum (DPA)');
    expect((await anon().get('/legal/dpa?locale=en')).status).toBe(404);
  });

  it('never renders raw HTML or unsafe links from a document', async () => {
    await t.api(owner).patch('/platform/legal/cookies', {
      draft: { body: { en: '<script>alert(1)</script>\n\n[x](javascript:alert(1)) [ok](/legal/terms)' } },
    });
    await t.api(owner).post('/platform/legal/cookies/publish');
    const en = await body(await anon().get('/legal/cookies?locale=en'));
    expect(en.html).not.toContain('<script>');
    expect(en.html).not.toContain('javascript:');
    expect(en.html).toContain('href="/legal/terms"');
  });

  it('404s an unknown document', async () => {
    expect((await anon().get('/legal/nope')).status).toBe(404);
  });
});

describe('owner console', () => {
  it('is the owner’s only (404 to others)', async () => {
    const admin = await join('admin@acme.test');
    expect((await t.api(admin).get('/platform/legal')).status).toBe(404);
    expect((await t.api(admin).patch('/platform/legal/terms', { requires_consent: false })).status).toBe(404);
    expect((await anon().get('/platform/legal')).status).toBe(401);
  });

  it('edits a draft without changing the public page, then publishes a new version', async () => {
    const before = await body(await anon().get('/legal/terms?locale=he'));
    const d = await body(
      await t.api(owner).patch('/platform/legal/terms', { draft: { body: { he: '## סעיף חדש\n\nנוסח מעודכן.' } } }),
    );
    expect(d.draft_changed).toBe(true);
    expect((await body(await anon().get('/legal/terms?locale=he'))).html).toBe(before.html);
    const pub = await body(await t.api(owner).post('/platform/legal/terms/publish'));
    expect(pub.published_version).toBe(2);
    expect(pub.draft_changed).toBe(false);
    const after = await body(await anon().get('/legal/terms?locale=he'));
    expect(after.version).toBe(2);
    expect(after.html).toContain('נוסח מעודכן');
    const versions = (await body(await t.api(owner).get('/platform/legal/terms/versions'))).data as Json[];
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    // an older version: the owner may view it, the public always gets the current one
    expect((await body(await t.api(owner).get('/legal/terms?locale=he&version=1'))).version).toBe(1);
    expect((await body(await anon().get('/legal/terms?locale=he&version=1'))).version).toBe(2);
  });

  it('restores an older version into the draft', async () => {
    const r = await body(await t.api(owner).post('/platform/legal/terms/versions/1/restore'));
    expect(r.draft_changed).toBe(true);
    expect(r.draft.body.he).toContain('טיוטה לבדיקת עורך דין');
  });

  it('refuses to publish a document missing a language, and adds new documents', async () => {
    const created = await body(
      await t
        .api(owner)
        .post('/platform/legal', { slug: 'nda', title: { he: 'הסכם סודיות', en: 'Non-disclosure agreement' } }),
    );
    expect(created.published_version).toBeNull();
    expect((await t.api(owner).post('/platform/legal/nda/publish')).status).toBe(400);
    expect((await t.api(owner).post('/platform/legal', { slug: 'nda', title: { he: 'x', en: 'x' } })).status).toBe(409);
    await t.api(owner).patch('/platform/legal/nda', { draft: { body: { he: 'טקסט', en: 'Text' } } });
    expect((await body(await t.api(owner).post('/platform/legal/nda/publish'))).published_version).toBe(1);
    expect((await anon().get('/legal/nda?locale=en')).status).toBe(200);
    // an added document can be deleted; a built-in one cannot
    expect((await t.api(owner).del('/platform/legal/terms')).status).toBe(409);
    expect((await t.api(owner).del('/platform/legal/nda')).status).toBe(200);
    expect((await anon().get('/legal/nda?locale=en')).status).toBe(404);
  });
});

describe('consent', () => {
  it('does not ask people who were here before the first version (they are asked from the next one)', async () => {
    // the owner signed in before anything read the documents (version 1 was published after they joined)
    const pending = (await body(await t.api(owner).get('/me/legal'))).pending as Json[];
    expect(pending.map((p) => p.slug)).toEqual(['terms']); // terms is at version 2 by now; privacy still at 1
  });

  it('someone who joined after a version agreed to it by joining; a later version asks again', async () => {
    const adminCookie = (await t.signInWithMagicLink('admin@acme.test')).cookie!;
    // admin@acme joined (without sending acceptances) under terms v1 / privacy v1; terms v2 came later
    const pending = (await body(await t.api(adminCookie).get('/me/legal'))).pending as Json[];
    expect(pending.map((p) => p.slug)).toEqual(['terms']);
  });

  it('records the versions accepted when joining; an update asks again', async () => {
    const list = (await body(await anon().get('/legal'))).data as Json[];
    const current = list.filter((d) => d.requires_consent).map((d) => ({ slug: d.slug, version: d.version }));
    // the admin invites Bob, who agrees on the sign-up screen
    const adminCookie = (await t.signInWithMagicLink('admin@acme.test')).cookie!;
    await t.api(adminCookie, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
    const bob = await join('bob@acme.test', current);
    expect((await body(await t.api(bob).get('/me/legal'))).pending).toEqual([]);
    const consents = (await body(await t.api(owner).get('/platform/legal'))).data as Json[];
    expect(consents.find((d) => d.slug === 'privacy')!.consents).toBeGreaterThanOrEqual(1);

    // the owner publishes a new privacy version: Bob is asked again, only for it
    await t.api(owner).patch('/platform/legal/privacy', { draft: { body: { en: 'Updated privacy text.' } } });
    const v = (await body(await t.api(owner).post('/platform/legal/privacy/publish'))).published_version as number;
    const pending = (await body(await t.api(bob).get('/me/legal'))).pending as Json[];
    expect(pending.map((p) => p.slug)).toEqual(['privacy']);
    // a stale version is refused; the current one clears the prompt
    expect(
      (await t.api(bob).post('/me/legal/accept', { accepted: [{ slug: 'privacy', version: v - 1 }] })).status,
    ).toBe(400);
    const done = await body(await t.api(bob).post('/me/legal/accept', { accepted: [{ slug: 'privacy', version: v }] }));
    expect(done.pending).toEqual([]);
  });
});

describe('agreements for accounts and subscriptions', () => {
  it('a minor version asks nobody again; a material one does', async () => {
    const bob = (await t.signInWithMagicLink('bob@acme.test')).cookie!;
    expect((await body(await t.api(bob).get('/me/legal'))).pending).toEqual([]);
    await t.api(owner).patch('/platform/legal/privacy', { draft: { body: { en: 'Fixed a typo.' } } });
    const minor = await t.api(owner).post('/platform/legal/privacy/publish', { material: false });
    expect(minor.status).toBe(200);
    expect((await body(await t.api(bob).get('/me/legal'))).pending).toEqual([]);
    const versions = (await body(await t.api(owner).get('/platform/legal/privacy/versions'))).data as Json[];
    expect(versions[0]!.material).toBe(false);
    expect(versions[1]!.material).toBe(true);
    await t.api(owner).patch('/platform/legal/privacy', { draft: { body: { en: 'A real change.' } } });
    await t.api(owner).post('/platform/legal/privacy/publish', { material: true });
    expect(((await body(await t.api(bob).get('/me/legal'))).pending as Json[]).map((p) => p.slug)).toEqual(['privacy']);
  });

  it('ships the subscription terms as a purchase document (a draft) filled with the billing settings', async () => {
    const docs = (await body(await t.api(owner).get('/platform/legal'))).data as Json[];
    const sub = docs.find((d) => d.slug === 'subscription')!;
    expect(sub.published_version).toBeNull();
    expect(sub.purchase_consent).toBe(true);
    expect(sub.requires_consent).toBe(false);
    for (const slug of ['sla', 'developer-terms', 'security', 'copyright'])
      expect(docs.find((d) => d.slug === slug)?.published_version).toBeNull();
    expect((await t.api(owner).post('/platform/legal/subscription/publish')).status).toBe(200);
    const list = (await body(await anon().get('/legal'))).data as Json[];
    expect(list.find((d) => d.slug === 'subscription')?.purchase_consent).toBe(true);
    // joining never asks for it
    const bob = (await t.signInWithMagicLink('bob@acme.test')).cookie!;
    expect(((await body(await t.api(bob).get('/me/legal'))).pending as Json[]).map((p) => p.slug)).not.toContain(
      'subscription',
    );
    await t.api(owner).patch('/platform/billing-settings', { cooling_off_days: 21, cancel_fee_pct: 4 });
    const en = await body(await anon().get('/legal/subscription?locale=en'));
    expect(en.html).toContain('21');
    expect(en.html).not.toContain('{{cooling_off_days}}');
    expect(en.html).not.toContain('[cooling_off_days]');
    await t.api(owner).patch('/platform/billing-settings', { cooling_off_days: 14, cancel_fee_pct: 5 });
  });

  it('the terms reserve plan changes (prices, features, limits) after the notice the owner sets', async () => {
    expect((await body(await t.api(owner).get('/platform/billing-settings'))).change_notice_days).toBe(30);
    expect((await t.api(owner).patch('/platform/billing-settings', { change_notice_days: 0 })).status).toBe(400);
    await t.api(owner).patch('/platform/billing-settings', { change_notice_days: 45 });
    const en = await body(await anon().get('/legal/terms?locale=en'));
    expect(en.html).toContain('limits on API calls, storage');
    expect(en.html).toContain('at least 45 days before it takes effect');
    expect(en.html).not.toContain('[change_notice_days]');
    // An earlier test rewrote the Hebrew draft; the shipped Hebrew says the same with the placeholder.
    const heTerms = LEGAL_DEFAULTS.find((d) => d.slug === 'terms')!.texts.body.he;
    expect(heTerms).toContain('נפח אחסון');
    expect(heTerms).toContain('{{change_notice_days}} ימים לפחות');
    await t.api(owner).patch('/platform/billing-settings', { change_notice_days: 30 });
  });

  it('exports who accepted what (owner only), formula-safe CSV', async () => {
    const res = await t.api(owner).get('/platform/legal/consents.csv?slug=privacy');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const csv = await res.text();
    expect(csv).toContain('document,version,accepted_at,context,email,name,ip,user_agent');
    expect(csv).toContain('bob@acme.test');
    expect(csv).not.toContain('\nterms,');
    const admin = (await t.signInWithMagicLink('admin@acme.test')).cookie!;
    expect((await t.api(admin).get('/platform/legal/consents.csv')).status).toBe(404);
  });

  it('offers the marketing box only when the owner wrote its label; the profile keeps and withdraws it', async () => {
    expect((await body(await anon().get('/legal'))).marketing_opt_in).toBeNull();
    await t.api(owner).patch('/platform/settings', { legal: { marketing_opt_in: { he: 'אשמח לקבל עדכונים' } } });
    expect((await body(await anon().get('/legal'))).marketing_opt_in).toEqual({
      he: 'אשמח לקבל עדכונים',
      en: 'אשמח לקבל עדכונים',
    });
    const bob = (await t.signInWithMagicLink('bob@acme.test')).cookie!;
    expect((await body(await t.api(bob, acmeId).get('/users/me'))).marketing_opt_in).toBe(false);
    expect((await body(await t.api(bob, acmeId).patch('/users/me', { marketing_opt_in: true }))).marketing_opt_in).toBe(
      true,
    );
    expect(await (await t.api(owner).get('/platform/legal/marketing.csv')).text()).toContain('bob@acme.test');
    await t.api(bob, acmeId).patch('/users/me', { marketing_opt_in: false });
    expect(await (await t.api(owner).get('/platform/legal/marketing.csv')).text()).not.toContain('bob@acme.test');
  });
});
