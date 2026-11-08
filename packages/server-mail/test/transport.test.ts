// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  createMailer,
  type MailLogger,
  mailTransport,
  type SmtpOptions,
  smtpOptions,
  type SmtpTransport,
} from '../src/mailer';

const message = { to: 'dana@example.org', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

const recorder = () => {
  const errors: string[] = [];
  const infos: string[] = [];
  const logger: MailLogger = { error: (_o, m) => errors.push(m), info: (_o, m) => infos.push(m) };
  return { errors, infos, logger };
};

/** A fake nodemailer transport: records the options it was built with and every message. */
const fakeSmtp = () => {
  const built: SmtpOptions[] = [];
  const sent: Parameters<SmtpTransport['sendMail']>[0][] = [];
  const factory = (options: SmtpOptions): SmtpTransport => {
    built.push(options);
    return {
      sendMail: async (mail) => {
        sent.push(mail);
      },
    };
  };
  return { built, sent, factory };
};

describe('mailTransport (selection by env)', () => {
  it('nothing configured = none (email off)', () => {
    expect(mailTransport({})).toBe('none');
    expect(mailTransport({ SMTP_HOST: '  ' })).toBe('none');
  });

  it('Resend wins, then SMTP, then Mailpit', () => {
    expect(mailTransport({ RESEND_API_KEY: 'k', SMTP_HOST: 'smtp.example.org', MAILPIT_URL: 'http://m' })).toBe(
      'resend',
    );
    expect(mailTransport({ SMTP_HOST: 'smtp.example.org', MAILPIT_URL: 'http://m' })).toBe('smtp');
    expect(mailTransport({ MAILPIT_URL: 'http://m' })).toBe('mailpit');
  });

  it('EMAIL_TRANSPORT forces one; missing settings or an unknown value = none', () => {
    expect(mailTransport({ EMAIL_TRANSPORT: 'smtp', RESEND_API_KEY: 'k', SMTP_HOST: 'h' })).toBe('smtp');
    expect(mailTransport({ EMAIL_TRANSPORT: 'SMTP', SMTP_HOST: 'h' })).toBe('smtp');
    expect(mailTransport({ EMAIL_TRANSPORT: 'smtp', RESEND_API_KEY: 'k' })).toBe('none');
    expect(mailTransport({ EMAIL_TRANSPORT: 'none', RESEND_API_KEY: 'k' })).toBe('none');
    expect(mailTransport({ EMAIL_TRANSPORT: 'carrier-pigeon', SMTP_HOST: 'h' })).toBe('none');
  });
});

describe('smtpOptions', () => {
  it('defaults to 587 with STARTTLS, no auth', () => {
    expect(smtpOptions({ SMTP_HOST: ' smtp.example.org ' })).toEqual({
      host: 'smtp.example.org',
      port: 587,
      secure: false,
      requireTLS: true,
      tls: { minVersion: 'TLSv1.2' },
    });
  });

  it('S-75: STARTTLS is required, except a relay on this machine or an explicit opt-out', () => {
    expect(smtpOptions({ SMTP_HOST: 'smtp.example.org' }).requireTLS).toBe(true);
    expect(smtpOptions({ SMTP_HOST: 'localhost' }).requireTLS).toBe(false);
    expect(smtpOptions({ SMTP_HOST: '127.0.0.1', SMTP_REQUIRE_TLS: 'true' }).requireTLS).toBe(true);
    expect(smtpOptions({ SMTP_HOST: 'relay.lan', SMTP_REQUIRE_TLS: 'false' }).requireTLS).toBe(false);
    // TLS from the first byte: nothing to upgrade.
    expect(smtpOptions({ SMTP_HOST: 'h', SMTP_PORT: '465' }).requireTLS).toBe(false);
  });

  it('port 465 implies TLS; SMTP_SECURE=true alone picks 465', () => {
    expect(smtpOptions({ SMTP_HOST: 'h', SMTP_PORT: '465' })).toMatchObject({ port: 465, secure: true });
    expect(smtpOptions({ SMTP_HOST: 'h', SMTP_SECURE: 'true' })).toMatchObject({ port: 465, secure: true });
    expect(smtpOptions({ SMTP_HOST: 'h', SMTP_PORT: '2525', SMTP_SECURE: 'false' })).toMatchObject({
      port: 2525,
      secure: false,
    });
  });

  it('auth only when SMTP_USER is set', () => {
    expect(smtpOptions({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' }).auth).toEqual({ user: 'u', pass: 'p' });
    expect(smtpOptions({ SMTP_HOST: 'h', SMTP_PASS: 'p' }).auth).toBeUndefined();
  });
});

describe('createMailer with SMTP', () => {
  it('sends through the transport, From = env address + the message sender name', async () => {
    const smtp = fakeSmtp();
    const { infos, logger } = recorder();
    const mailer = createMailer(
      { SMTP_HOST: 'smtp.example.org', SMTP_PORT: '2525', EMAIL_FROM: 'noreply@example.org' },
      logger,
      { smtpTransport: smtp.factory },
    );
    await mailer.send({ ...message, fromName: 'Acme', replyTo: 'help@example.org' });
    expect(smtp.built).toEqual([
      { host: 'smtp.example.org', port: 2525, secure: false, requireTLS: true, tls: { minVersion: 'TLSv1.2' } },
    ]);
    expect(smtp.sent).toEqual([
      {
        from: '"Acme" <noreply@example.org>',
        to: 'dana@example.org',
        replyTo: 'help@example.org',
        subject: 'Hi',
        html: '<p>Hi</p>',
        text: 'Hi',
      },
    ]);
    expect(infos).toEqual(['email transport ready']);
  });

  it('a reply carries In-Reply-To / References (), cleaned of brackets and line breaks', async () => {
    const smtp = fakeSmtp();
    const mailer = createMailer({ SMTP_HOST: 'h', EMAIL_FROM: 'noreply@example.org' }, recorder().logger, {
      smtpTransport: smtp.factory,
    });
    await mailer.send({ ...message, inReplyTo: '<abc@client.test>\r\nBcc: x@y.z' });
    expect(smtp.sent[0]).toMatchObject({
      headers: { 'In-Reply-To': '<abc@client.testBcc:x@y.z>', References: '<abc@client.testBcc:x@y.z>' },
    });
    await mailer.send(message);
    expect(smtp.sent[1]).not.toHaveProperty('headers');
  });

  it('without EMAIL_FROM nothing is sent (logged), never a made-up address', async () => {
    const smtp = fakeSmtp();
    const { errors, infos, logger } = recorder();
    const mailer = createMailer({ SMTP_HOST: 'h' }, logger, { smtpTransport: smtp.factory });
    await expect(mailer.send(message)).rejects.toThrow('email_from_not_configured');
    expect(smtp.sent).toEqual([]);
    expect(infos[0]).toMatch(/EMAIL_FROM/);
    expect(errors[0]).toMatch(/EMAIL_FROM/);
  });
});

describe('createMailer with nothing configured', () => {
  it('builds without throwing, says once that email is off, and each send fails clearly', async () => {
    const { errors, infos, logger } = recorder();
    const mailer = createMailer({}, logger);
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatch(/email is off/);
    await expect(mailer.send(message)).rejects.toThrow('email_not_configured');
    expect(errors[0]).toMatch(/SMTP_HOST/);
  });

  it('an unknown EMAIL_TRANSPORT is logged as an error, not thrown', () => {
    const { errors, logger } = recorder();
    expect(() => createMailer({ EMAIL_TRANSPORT: 'fax', SMTP_HOST: 'h' }, logger)).not.toThrow();
    expect(errors[0]).toMatch(/EMAIL_TRANSPORT must be one of/);
  });
});
