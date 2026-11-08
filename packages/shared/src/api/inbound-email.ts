// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { RichRenderOptions } from '../rich';

/**
 * Incoming email: every item and board can have an address under the platform's inbound domain
 * (`item-<token>@in.example.com`, `board-<token>@in.example.com`). Mail to an item's address becomes an update on it;
 * mail to a board's address becomes a new item there. The token is random (not derived from the id), so an address
 * cannot be guessed; rotating it retires the old one for good.
 */
export const INBOUND_KINDS = ['item', 'board'] as const;
export type InboundKind = (typeof INBOUND_KINDS)[number];

/** 24 characters of [a-z0-9]: about 124 bits. */
export const INBOUND_TOKEN_LENGTH = 24;
const TOKEN_RE = new RegExp(`^[a-z0-9]{${INBOUND_TOKEN_LENGTH}}$`);

/** The address of an item or a board: `item-<token>@<domain>`. */
export const inboundAddress = (kind: InboundKind, token: string, domain: string) => `${kind}-${token}@${domain}`;

/**
 * `item-<token>@<domain>` → its kind and token, or null when the address is not one of ours (another domain, another
 * shape). Case-insensitive; a `+tag` after the token is ignored.
 */
export const parseInboundAddress = (address: string, domain: string): { kind: InboundKind; token: string } | null => {
  const at = address.trim().toLowerCase().lastIndexOf('@');
  if (at < 1) return null;
  const local = address.trim().toLowerCase().slice(0, at);
  const host = address
    .trim()
    .toLowerCase()
    .slice(at + 1);
  if (host !== domain.toLowerCase()) return null;
  const m = /^(item|board)-([a-z0-9]+)(?:\+.*)?$/.exec(local);
  if (!m || !TOKEN_RE.test(m[2]!)) return null;
  return { kind: m[1] as InboundKind, token: m[2]! };
};

/** `"Dana Levi" <dana@example.com>` / `dana@example.com` → the address (lower-case) and the display name, if any. */
export const parseMailbox = (raw: string): { email: string; name: string | null } | null => {
  const text = raw.trim();
  const angled = /^(.*)<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/.exec(text);
  const email = (angled ? angled[2]! : text).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const name = angled
    ? angled[1]!
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim()
    : '';
  return { email, name: name && name.toLowerCase() !== email ? name.slice(0, 120) : null };
};

/** The domain of an address (`dana@Mail.Example.com` → `mail.example.com`). */
export const mailDomainOf = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/**
 * Lines that start the quoted history of a reply: "On … wrote:", "בתאריך … נכתב:", Outlook's "-----Original
 * Message-----" and its "From: …" header block, and the "________________" rule Outlook puts above it.
 */
const QUOTE_HEADERS: RegExp[] = [
  /^\s*On\b.{0,200}\bwrote:\s*$/i,
  // No \b around Hebrew: JavaScript's word boundary knows only [A-Za-z0-9_].
  /^\s*בתאריך\s.{0,200}(נכתב|כתב|כתבה)\s*:\s*$/,
  /^\s*-{2,}\s*(Original Message|Forwarded message|הודעה מקורית|הודעה שהועברה)\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/,
  /^\s*(From|מאת)\s*:\s.+$/i,
];

/**
 * The new part of a reply: the text above the first quote header or the first block of `>` lines; trailing blank
 * lines and a trailing "--" signature separator are dropped too. A message that is only quotes (a plain forward) is
 * kept whole, so nothing someone sent on purpose is lost.
 */
export const stripQuotedReply = (text: string): string => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // A "From:" line counts only when it opens a header block (a "Sent:/To:/Subject:" line follows).
    if (/^\s*(From|מאת)\s*:/i.test(line)) {
      const next = lines.slice(i + 1, i + 4).join('\n');
      if (!/^\s*(Sent|Date|To|Subject|נשלח|תאריך|אל|נושא)\s*:/im.test(next)) continue;
    }
    if (QUOTE_HEADERS.some((re) => re.test(line)) || /^\s*>/.test(line)) {
      end = i;
      break;
    }
  }
  const kept = lines.slice(0, end);
  const sig = kept.findIndex((l) => /^--\s?$/.test(l));
  const body = (sig >= 0 ? kept.slice(0, sig) : kept).join('\n').trim();
  return body || text.trim();
};

/**
 * HTML mail → plain text for an update: block ends become line breaks, scripts / styles / comments go, the common
 * entities are decoded. Only text comes out (the update is built from it), so no markup of the sender's survives.
 */
export const mailHtmlToText = (html: string): string =>
  html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre|table)\s*>/gi, '\n')
    .replace(/<blockquote\b[^>]*>/gi, '\n> ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d{1,6});/g, (_, n: string) => {
      const code = Number(n);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/**
 * GET /items/{id}/email-address and GET /boards/{id}/email-address (POST … creates it, POST …/rotate replaces it).
 * `address` is null while incoming email is off — `off` says where: the platform has no inbound domain, or the
 * account has not turned it on.
 */
export const inboundAddressSchema = z.object({
  kind: z.enum(INBOUND_KINDS),
  address: z.string().nullable(),
  off: z.enum(['platform', 'account']).nullable(),
  created_at: z.string().nullable(),
});
export type InboundAddressDto = z.infer<typeof inboundAddressSchema>;

/** Why a file of an incoming message was not attached — the update lists them. */
export const INBOUND_SKIP_REASONS = ['too_big', 'type', 'too_many', 'small_image', 'images_off', 'failed'] as const;
export type InboundSkipReason = (typeof INBOUND_SKIP_REASONS)[number];

/** An update that came in by email: who sent it, and whether the sender is outside the account. */
export const updateEmailMetaSchema = z.object({
  from: z.string(),
  name: z.string().nullable(),
  subject: z.string().nullable(),
  /** Not a verified member of the account: the update has no author and shows the sender's address. */
  external: z.boolean(),
  /**
   * what became of the message's files — how many were attached (attachments and kept body images
   * the original .eml included), and the ones skipped with the reason. Older updates have none.
   */
  files: z
    .object({
      attached: z.number().int(),
      skipped: z.array(z.object({ name: z.string(), reason: z.enum(INBOUND_SKIP_REASONS) })),
    })
    .optional(),
  /** The message was longer than the update keeps: the start is shown and the original is attached (.eml). */
  cut: z.boolean().optional(),
});
export type UpdateEmailMeta = z.infer<typeof updateEmailMetaSchema>;

/** A reply sent by email to whoever emailed the item: to whom, and the subject. */
export const updateEmailReplyMetaSchema = z.object({ to: z.string(), subject: z.string() });
export type UpdateEmailReplyMeta = z.infer<typeof updateEmailReplyMetaSchema>;

/** Reads `updates.meta.email_reply`, else null. */
export const updateEmailReplyMetaOf = (meta: unknown): UpdateEmailReplyMeta | null => {
  const parsed = updateEmailReplyMetaSchema.safeParse((meta as { email_reply?: unknown } | null)?.email_reply);
  return parsed.success ? parsed.data : null;
};

/** Reads `updates.meta.email` (stored by the inbound mail service), else null. */
export const updateEmailMetaOf = (meta: unknown): UpdateEmailMeta | null => {
  const parsed = updateEmailMetaSchema.safeParse((meta as { email?: unknown } | null)?.email);
  return parsed.success ? parsed.data : null;
};

/** Limits of one incoming message (attachments go through the file pipeline's type check as well). */
export const INBOUND_LIMITS = {
  /** Attachments per message; more are skipped and the update says so. */
  maxFiles: 10,
  /** Per attachment. */
  maxFileBytes: 25 * 1024 * 1024,
  /** All attachments of one message together. */
  maxTotalBytes: 50 * 1024 * 1024,
  /** Messages per address per hour, and per account per hour. */
  perAddressPerHour: 60,
  perAccountPerHour: 500,
  /**
   * The text kept from one message: past it the update shows the start, says so, and the original message is attached
   * as an.eml file.
   */
  maxTextChars: 50_000,
  /** Images inside the body kept as files, and images from the web shown, per message. */
  maxBodyImages: 40,
  maxRemoteImages: 60,
  /** One image from the web, shown through the app. */
  maxRemoteImageBytes: 5 * 1024 * 1024,
} as const;

/**
 * the limits of one incoming message the platform owner may change (owner console → platform settings
 * → email, beside the inbound domain); empty = INBOUND_LIMITS. `range`: the values accepted.
 */
export const INBOUND_LIMIT_FIELDS = {
  inbound_max_text_chars: { range: [1_000, 100_000], fallback: INBOUND_LIMITS.maxTextChars },
  inbound_max_body_images: { range: [0, 200], fallback: INBOUND_LIMITS.maxBodyImages },
  inbound_max_remote_images: { range: [0, 200], fallback: INBOUND_LIMITS.maxRemoteImages },
  inbound_max_remote_image_mb: { range: [1, 25], fallback: INBOUND_LIMITS.maxRemoteImageBytes / (1024 * 1024) },
} as const;
export type InboundLimitField = keyof typeof INBOUND_LIMIT_FIELDS;
export const INBOUND_LIMIT_KEYS = Object.keys(INBOUND_LIMIT_FIELDS) as InboundLimitField[];
export const inboundLimitSchema = (k: InboundLimitField) =>
  z.number().int().min(INBOUND_LIMIT_FIELDS[k].range[0]).max(INBOUND_LIMIT_FIELDS[k].range[1]);

/** The limits in effect: the platform's (stored email settings), else the defaults. */
export const inboundLimitsOf = (email: Partial<Record<InboundLimitField, number | null>> | null | undefined) => {
  const v = (k: InboundLimitField) => email?.[k] ?? INBOUND_LIMIT_FIELDS[k].fallback;
  return {
    maxTextChars: v('inbound_max_text_chars'),
    maxBodyImages: v('inbound_max_body_images'),
    maxRemoteImages: v('inbound_max_remote_images'),
    maxRemoteImageBytes: v('inbound_max_remote_image_mb') * 1024 * 1024,
  };
};
export type InboundLimits = ReturnType<typeof inboundLimitsOf>;

/** An image of an incoming email in an update's document: a file of the update, or the n-th image from the web. */
export const EMAIL_IMAGE_REF = /^(asset:[0-9A-HJKMNP-TV-Z]{26}|remote:\d{1,3})$/;
/** A transparent pixel: the image's place until the app loads it (the address is never in the stored HTML). */
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/**
 * how an update's document shows images — only email images (`EMAIL_IMAGE_REF`), as a placeholder the
 * app fills (`data-image-ref`): a file through its access check, an image from the web through the app's proxy.
 */
export const updateImageOptions: RichRenderOptions = {
  image: (attrs) => {
    const src = typeof attrs.src === 'string' ? attrs.src : '';
    if (!EMAIL_IMAGE_REF.test(src)) return null;
    const width = typeof attrs.width === 'number' ? attrs.width : null;
    return { src: PIXEL, alt: typeof attrs.alt === 'string' ? attrs.alt.slice(0, 300) : '', width, ref: src };
  },
};
