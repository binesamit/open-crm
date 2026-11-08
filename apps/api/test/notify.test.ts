// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emailSender, fromHeader } from '@bines/server-mail';
import { t as i18n, type MessageKey } from '@bines/shared';
import { normalizeIsraeliMobile, SMS_SENDER_NOT_CONFIGURED, textmeSender } from '../src/lib/sms';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

describe('normalizeIsraeliMobile', () => {
  it.each([
    ['052-1234567', '0521234567'],
    ['+972 52 123 4567', '0521234567'],
    ['972521234567', '0521234567'],
    ['521234567', '0521234567'],
  ])('%s → %s', (input, out) => expect(normalizeIsraeliMobile(input)).toBe(out));

  it.each(['03-1234567', '12345', '+1 415 555 0100'])('rejects %s', (input) => {
    expect(normalizeIsraeliMobile(input)).toBeNull();
  });
});

describe('TextMe sender without a sender id', () => {
  it('refuses loudly (error log + clear error), never falls back to a brand name', async () => {
    const errors: unknown[][] = [];
    const logger = { error: (...a: unknown[]) => errors.push(a) } as unknown as Parameters<typeof textmeSender>[1];
    const sender = textmeSender({ apiKey: 'k', username: 'u', senderId: undefined }, logger);
    await expect(sender.send({ to: '0521234567', text: 'x', senderId: '  ' })).rejects.toThrow(
      SMS_SENDER_NOT_CONFIGURED,
    );
    expect(String(errors[0]?.[1])).toContain('Platform settings');
  });
});

describe('emailSender / fromHeader', () => {
  it('takes the address from the env and the name from the message (no brand in code)', () => {
    expect(emailSender({ RESEND_FROM: 'office@example.com' })).toEqual({ address: 'office@example.com', name: null });
    expect(emailSender({ EMAIL_FROM: 'X <x@y.z>', RESEND_FROM: 'a@b.c' })).toEqual({ address: 'x@y.z', name: 'X' });
    expect(emailSender({})).toEqual({ address: null, name: null });
    const sender = emailSender({ EMAIL_FROM: 'Env Name <x@y.z>' });
    expect(fromHeader(sender, 'Acme Ltd')).toBe('"Acme Ltd" <x@y.z>');
    expect(fromHeader(sender)).toBe('"Env Name" <x@y.z>');
    // A header can never be broken by a name: quotes, brackets and line breaks are dropped.
    expect(fromHeader(sender, 'Evil"\r\nBcc: x@evil <a>')).toBe('"Evil Bcc: x@evil  a" <x@y.z>');
  });
});

describe('POST /platform/diagnostics/notify', () => {
  let t: TestContext;
  let owner: string;
  beforeAll(async () => {
    t = await createTestContext();
    owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  });
  afterAll(() => t.close());

  it('sends a test SMS and email for the owner only', async () => {
    expect((await t.api(owner).post('/platform/diagnostics/notify', { channel: 'sms', to: '0521234567' })).status).toBe(
      200,
    );
    expect(t.sms.sent).toEqual([expect.objectContaining({ to: '0521234567' })]);
    expect((await t.api(owner).post('/platform/diagnostics/notify', { channel: 'email', to: 'x@y.test' })).status).toBe(
      200,
    );
    expect(t.lastMailTo('x@y.test').subject).toBe(
      i18n('mail.diagnostic.subject' as MessageKey, { product: i18n('app.name') }, 'he'),
    );
    expect(
      (await t.api(undefined).post('/platform/diagnostics/notify', { channel: 'sms', to: '0521234567' })).status,
    ).toBe(401);
  });
});
