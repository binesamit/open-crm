// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { breachDeadline } from '@bines/shared';
import { remindIncidents } from '../src/modules/platform/security-incidents';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Privacy, phase A: the security incident register (GDPR art. 33; the data-security regulations)
 * platform owner only, a 72-hour authority deadline for personal data breaches, one reminder to the owners.
 */
let t: TestContext;
let owner: string;
let member: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const HOUR = 3_600_000;

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  await t.api(owner).post('/platform/accounts', {
    name: 'Acme',
    slug: 'acme',
    first_admin_email: 'admin@acme.test',
    template_set: 'empty',
  });
  const token = t.inviteTokenFor('admin@acme.test');
  member = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(member).post('/invitations/accept', { token });
});
afterAll(() => t.close());

describe('breachDeadline', () => {
  it('72 hours after detection for a personal data breach; overdue only without a notice', () => {
    const detected = '2030-01-01T00:00:00.000Z';
    const base = { personal_data: true, detected_at: detected, authority_notified_at: null };
    expect(breachDeadline(base, new Date('2030-01-03T00:00:00Z'))).toEqual({
      due: '2030-01-04T00:00:00.000Z',
      overdue: false,
    });
    expect(breachDeadline(base, new Date('2030-01-04T01:00:00Z')).overdue).toBe(true);
    expect(
      breachDeadline({ ...base, authority_notified_at: '2030-01-02T00:00:00Z' }, new Date('2030-01-05T00:00:00Z'))
        .overdue,
    ).toBe(false);
    expect(breachDeadline({ ...base, personal_data: false })).toEqual({ due: null, overdue: false });
  });
});

describe('the register', () => {
  it('is the platform owner’s only', async () => {
    expect((await t.api(member).get('/platform/security-incidents')).status).toBe(404);
    expect((await t.api('').get('/platform/security-incidents')).status).toBe(401);
  });

  it('records, lists, updates and deletes; a breach shows its deadline', async () => {
    const detected = new Date(Date.now() - 80 * HOUR).toISOString();
    const res = await t.api(owner).post('/platform/security-incidents', {
      title: 'Leaked export link',
      severity: 'high',
      personal_data: true,
      detected_at: detected,
      account_ids: ['01HZZZZZZZZZZZZZZZZZZZZZZZ'],
      people_affected: 40,
      data_categories: 'names, emails',
    });
    expect(res.status).toBe(201);
    const created = await body(res);
    expect(created).toMatchObject({ status: 'open', severity: 'high', personal_data: true, overdue: true });
    expect(Date.parse(created.authority_due_at) - Date.parse(detected)).toBe(72 * HOUR);

    const list = (await body(await t.api(owner).get('/platform/security-incidents'))).data as Json[];
    expect(list.map((i) => i.title)).toContain('Leaked export link');

    const notified = new Date().toISOString();
    const upd = await body(
      await t.api(owner).patch(`/platform/security-incidents/${created.id}`, {
        status: 'contained',
        authority_notified_at: notified,
        authority_reference: 'PPA-123',
        measures: 'Link revoked, keys rotated',
      }),
    );
    expect(upd).toMatchObject({ status: 'contained', overdue: false, authority_reference: 'PPA-123' });

    expect((await t.api(owner).post('/platform/security-incidents', { title: '', severity: 'low' })).status).toBe(400);
    expect((await t.api(owner).del(`/platform/security-incidents/${created.id}`)).status).toBe(200);
    expect((await t.api(owner).del(`/platform/security-incidents/${created.id}`)).status).toBe(404);
  });

  it('reminds the owners once when a breach nears its deadline with no notice', async () => {
    const created = await body(
      await t.api(owner).post('/platform/security-incidents', {
        title: 'Misdirected email',
        severity: 'medium',
        personal_data: true,
        detected_at: new Date(Date.now() - 50 * HOUR).toISOString(),
      }),
    );
    // A non-breach and a fresh breach are not reminded.
    await t.api(owner).post('/platform/security-incidents', {
      title: 'Port scan',
      severity: 'low',
      detected_at: new Date(Date.now() - 100 * HOUR).toISOString(),
    });
    await t.api(owner).post('/platform/security-incidents', {
      title: 'Fresh breach',
      severity: 'high',
      personal_data: true,
      detected_at: new Date(Date.now() - 2 * HOUR).toISOString(),
    });
    const before = t.mailer.sent.length;
    expect(await remindIncidents(t.deps)).toBe(1);
    const mails = t.mailer.sent.slice(before);
    expect(mails.length).toBeGreaterThanOrEqual(1);
    expect(mails.every((m) => m.to === OWNER_EMAIL)).toBe(true);
    expect(mails[0]!.subject).toContain('Misdirected email');
    expect(await remindIncidents(t.deps)).toBe(0);
    await t.api(owner).del(`/platform/security-incidents/${created.id}`);
  });
});
