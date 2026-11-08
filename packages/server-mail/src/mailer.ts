// SPDX-License-Identifier: AGPL-3.0-only
import nodemailer from 'nodemailer';

/** What the mailer reads from the environment (API and worker alike). */
export type MailEnv = {
  /** Force one transport: `resend` | `smtp` | `mailpit` | `none`. Unset = picked from what is configured (mailTransport). */
  EMAIL_TRANSPORT?: string;
  RESEND_API_KEY?: string;
  /** Plain SMTP (any server: Postfix, SES, Postmark, Gmail, ...). SMTP_HOST set = the SMTP transport. */
  SMTP_HOST?: string;
  /** Default 587 (STARTTLS), or 465 when SMTP_SECURE=true. */
  SMTP_PORT?: string | number;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  /** `true` = TLS from the first byte (port 465). Default: true only on port 465; others upgrade with STARTTLS. */
  SMTP_SECURE?: string | boolean;
  /** Without TLS from the first byte, STARTTLS must succeed (default true; false only for a trusted relay). */
  SMTP_REQUIRE_TLS?: string | boolean;
  EMAIL_FROM?: string;
  RESEND_FROM?: string;
  MAILPIT_URL?: string;
  /** Staging: only these recipients get email — comma list of addresses or `@domain`s. Unset = everyone. */
  MAIL_ALLOWLIST?: string;
};

/** The one logging call the mailer makes (pino in the API, graphile's logger in the worker). */
export type MailLogger = {
  error: (obj: Record<string, unknown>, msg: string) => void;
  /** Optional: told once which transport is in use (or that email is off). */
  info?: (obj: Record<string, unknown>, msg: string) => void;
};

export type EmailMessage = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** The From display name (the account's / platform's sender name); the address always comes from the env. */
  fromName?: string;
  replyTo?: string;
  /** A reply to a message: its Message-ID, so the reader's mail app threads it. */
  inReplyTo?: string;
};

/** In-Reply-To / References for a reply: one Message-ID in angle brackets (no line breaks — header-safe). */
export const threadHeaders = (m: Pick<EmailMessage, 'inReplyTo'>): Record<string, string> => {
  const id = m.inReplyTo?.replace(/[\s<>]+/g, '');
  return id ? { 'In-Reply-To': `<${id}>`, References: `<${id}>` } : {};
};

export interface Mailer {
  send(message: EmailMessage): Promise<void>;
}

/** Production: Resend REST API (no SDK needed). */
const resendMailer = (apiKey: string, sender: Sender): Mailer => ({
  async send(message) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: fromHeader(sender, message.fromName),
        to: [message.to],
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        ...(message.inReplyTo ? { headers: threadHeaders(message) } : {}),
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    if (!res.ok) throw new Error(`resend: ${res.status} ${await res.text()}`);
  },
});

/** Local dev: Mailpit's HTTP send API (UI at http://localhost:8025). */
const mailpitMailer = (baseUrl: string, sender: Sender): Mailer => ({
  async send(message) {
    const res = await fetch(`${baseUrl}/api/v1/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        From: { Email: sender.address ?? 'noreply@localhost', Name: senderName(sender, message.fromName) },
        To: [{ Email: message.to }],
        ...(message.replyTo ? { ReplyTo: [{ Email: message.replyTo }] } : {}),
        ...(message.inReplyTo ? { Headers: threadHeaders(message) } : {}),
        Subject: message.subject,
        HTML: message.html,
        Text: message.text,
      }),
    });
    if (!res.ok) throw new Error(`mailpit: ${res.status} ${await res.text()}`);
  },
});

/** The SMTP connection settings from the environment (port 465 implies TLS; other ports upgrade with STARTTLS). */
export type SmtpOptions = {
  host: string;
  port: number;
  secure: boolean;
  /** S-75: STARTTLS is required (no silent fallback to cleartext) — except a relay on this machine, or opted out. */
  requireTLS: boolean;
  tls: { minVersion: 'TLSv1.2' };
  auth?: { user: string; pass: string };
};

const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i;

const truthy = (v: string | boolean | undefined) =>
  typeof v === 'boolean' ? v : /^(1|true|yes)$/i.test(v?.trim() ?? '');

export const smtpOptions = (env: MailEnv): SmtpOptions => {
  const explicitSecure = env.SMTP_SECURE !== undefined && String(env.SMTP_SECURE).trim() !== '';
  const port = Number(env.SMTP_PORT) || (explicitSecure && truthy(env.SMTP_SECURE) ? 465 : 587);
  const secure = explicitSecure ? truthy(env.SMTP_SECURE) : port === 465;
  const host = env.SMTP_HOST!.trim();
  const explicitRequire = env.SMTP_REQUIRE_TLS !== undefined && String(env.SMTP_REQUIRE_TLS).trim() !== '';
  const requireTLS = !secure && (explicitRequire ? truthy(env.SMTP_REQUIRE_TLS) : !LOCAL_HOST.test(host));
  return {
    host,
    port,
    secure,
    requireTLS,
    tls: { minVersion: 'TLSv1.2' },
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
  };
};

/** The one call the SMTP mailer makes on a transport — nodemailer's, or a fake in tests. */
export type SmtpTransport = {
  sendMail: (mail: {
    from: string;
    to: string;
    replyTo?: string;
    headers?: Record<string, string>;
    subject: string;
    html: string;
    text: string;
  }) => Promise<unknown>;
};
export type SmtpTransportFactory = (options: SmtpOptions) => SmtpTransport;

const nodemailerTransport: SmtpTransportFactory = (options) => nodemailer.createTransport(options);

/** Self-hosting: plain SMTP to any server (nodemailer). */
const smtpMailer = (options: SmtpOptions, sender: Sender, factory: SmtpTransportFactory): Mailer => {
  const transport = factory(options);
  return {
    async send(message) {
      await transport.sendMail({
        from: fromHeader(sender, message.fromName),
        to: message.to,
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        ...(message.inReplyTo ? { headers: threadHeaders(message) } : {}),
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
    },
  };
};

/** Nothing configured: refuse loudly instead of silently dropping (never log the body — it holds login links). */
const unconfiguredMailer = (logger: MailLogger): Mailer => ({
  async send(message) {
    logger.error(
      { to: message.to, subject: message.subject },
      'email not sent: no mail transport (set SMTP_HOST, RESEND_API_KEY or MAILPIT_URL)',
    );
    throw new Error('email_not_configured');
  },
});

/** Tests: keep messages in memory. */
export const memoryMailer = () => {
  const sent: EmailMessage[] = [];
  return {
    sent,
    async send(message: EmailMessage) {
      sent.push(message);
    },
  } satisfies Mailer & { sent: EmailMessage[] };
};

/** The sending address (and an optional default name) from EMAIL_FROM (`Name <addr>` or `addr`) or RESEND_FROM. */
export type Sender = { address: string | null; name: string | null };

const parseFrom = (raw: string): Sender => {
  const match = /^(.*)<(.+)>$/.exec(raw.trim());
  if (!match) return { address: raw.trim() || null, name: null };
  return { address: match[2]!.trim() || null, name: match[1]!.trim().replace(/^"|"$/g, '') || null };
};

/** EMAIL_FROM wins over RESEND_FROM; neither = no address (Resend then refuses to send, Mailpit uses a local one). */
export const emailSender = (env: Pick<MailEnv, 'EMAIL_FROM' | 'RESEND_FROM'>): Sender =>
  env.EMAIL_FROM
    ? parseFrom(env.EMAIL_FROM)
    : env.RESEND_FROM
      ? parseFrom(env.RESEND_FROM)
      : { address: null, name: null };

/** A display name safe in a From header (no quotes, angle brackets or line breaks). */
const cleanName = (name: string) => name.replace(/[\r\n"<>]+/g, ' ').trim();

/** The message's sender name (account / platform setting), else the env's, else none. */
const senderName = (sender: Sender, fromName?: string) => cleanName(fromName ?? sender.name ?? '');

/** `"Name" <addr>` — the address from the environment, the name from the message (the account's settings). */
export const fromHeader = (sender: Sender, fromName?: string): string => {
  const name = senderName(sender, fromName);
  return name ? `"${name}" <${sender.address}>` : `${sender.address}`;
};

/** Is `to` on the allowlist (`a@x.com, @y.com`)? Case-insensitive. */
export const mailAllowed = (allowlist: string, to: string): boolean => {
  const addr = to.trim().toLowerCase();
  return allowlist
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => (entry.startsWith('@') ? addr.endsWith(entry) : addr === entry));
};

/** Staging: a mail to anyone off the allowlist is logged (never its body) and skipped, so flows still succeed. */
const allowlisted = (inner: Mailer, allowlist: string, logger: MailLogger): Mailer => ({
  async send(message) {
    if (mailAllowed(allowlist, message.to)) return inner.send(message);
    logger.error({ to: message.to, subject: message.subject }, 'email skipped: recipient not on MAIL_ALLOWLIST');
  },
});

/** A transport that needs a sending address but has none: nothing is sent (logged loudly). */
const noAddressMailer = (logger: MailLogger): Mailer => ({
  async send(message) {
    logger.error({ to: message.to, subject: message.subject }, 'email not sent: set EMAIL_FROM (or RESEND_FROM)');
    throw new Error('email_from_not_configured');
  },
});

export type MailTransport = 'resend' | 'smtp' | 'mailpit' | 'none';
const TRANSPORTS: readonly MailTransport[] = ['resend', 'smtp', 'mailpit', 'none'];

/**
 * Which transport the environment selects: EMAIL_TRANSPORT when set (a transport whose settings are missing becomes
 * `none`, and so does an unknown value), else the first one configured — RESEND_API_KEY, then SMTP_HOST, then MAILPIT_URL — else `none` (email off).
 */
export const mailTransport = (env: MailEnv): MailTransport => {
  const configured: Record<MailTransport, boolean> = {
    resend: !!env.RESEND_API_KEY,
    smtp: !!env.SMTP_HOST?.trim(),
    mailpit: !!env.MAILPIT_URL,
    none: true,
  };
  const forced = env.EMAIL_TRANSPORT?.trim().toLowerCase();
  if (forced) {
    const pick = TRANSPORTS.find((t) => t === forced);
    return pick && configured[pick] ? pick : 'none';
  }
  return TRANSPORTS.find((t) => configured[t])!;
};

export const createMailer = (
  env: MailEnv,
  logger: MailLogger,
  deps: { smtpTransport?: SmtpTransportFactory } = {},
): Mailer => {
  const sender = emailSender(env);
  const transport = mailTransport(env);
  const needsAddress = transport === 'resend' || transport === 'smtp';
  const inner =
    needsAddress && !sender.address
      ? noAddressMailer(logger)
      : transport === 'resend'
        ? resendMailer(env.RESEND_API_KEY!, sender)
        : transport === 'smtp'
          ? smtpMailer(smtpOptions(env), sender, deps.smtpTransport ?? nodemailerTransport)
          : transport === 'mailpit'
            ? mailpitMailer(env.MAILPIT_URL!, sender)
            : unconfiguredMailer(logger);
  const forced = env.EMAIL_TRANSPORT?.trim().toLowerCase();
  if (forced && forced !== transport) {
    logger.error(
      { EMAIL_TRANSPORT: forced },
      TRANSPORTS.includes(forced as MailTransport)
        ? `email is off: EMAIL_TRANSPORT=${forced} but its settings are missing`
        : `email is off: EMAIL_TRANSPORT must be one of ${TRANSPORTS.join(' | ')}`,
    );
  } else if (transport === 'none') {
    logger.info?.(
      {},
      'email is off: no mail transport configured (set SMTP_HOST, RESEND_API_KEY or MAILPIT_URL); emails will not be sent',
    );
  } else if (needsAddress && !sender.address) {
    logger.info?.({ transport }, 'email is off: set EMAIL_FROM (the sending address)');
  } else {
    logger.info?.(
      transport === 'smtp' ? { transport, host: env.SMTP_HOST, port: smtpOptions(env).port } : { transport },
      'email transport ready',
    );
  }
  return env.MAIL_ALLOWLIST?.trim() ? allowlisted(inner, env.MAIL_ALLOWLIST, logger) : inner;
};
