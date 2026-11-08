// SPDX-License-Identifier: AGPL-3.0-only
import { randomBytes } from 'node:crypto';
import {
  AppError,
  inboundAddress,
  type InboundAddressDto,
  type InboundEmailSettings,
  type InboundKind,
  INBOUND_LIMITS,
  type InboundLimits,
  inboundLimitsOf,
  type InboundSkipReason,
  INBOUND_TOKEN_LENGTH,
  type Locale,
  mailDomainOf,
  mailHtmlToText,
  newId,
  parseInboundAddress,
  parseMailbox,
  type RichNode,
  stripQuotedReply,
  type UpdateEmailMeta,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { ipBucket } from '../../lib/client-ip';
import { enqueueJob } from '../../lib/jobs';
import { RateLimiter } from '../../lib/rate-limit';
import { accountLocale, st } from '../../lib/i18n';
import type { AppDeps, Actor } from '../../types';
import { findAccountById, findMembership } from '../accounts/accounts.repo';
import { loadSettings } from '../accounts/accounts.service';
import { accountClosed } from '../billing/entitlements';
import { assertBoard, loadBoardAccess } from '../boards/boards.access';
import { insertAsset, markUploaded } from '../files/files.repo';
import { isServerFileMime, safeName } from '../files/files.service';
import { createItem, loadItem } from '../items/items.service';
import { loadPlatformSettings } from '../platform/platform-settings';
import { assertCanComment, createEmailUpdate } from '../updates/updates.service';
import { findUserById } from '../users/users.repo';
import {
  disableAddress,
  findAddressById,
  findAddressByToken,
  findInboundEmail,
  findLiveAddress,
  findVerifiedMemberByEmail,
  finishInboundEmail,
  insertAddress,
  type InboundAddressRow,
  logInboundEmail,
  recentCount,
  setMessageId,
} from './inbound.repo';
import { type MailImage, mailHtmlToDoc, mailTextToDoc } from './mail-html';
import { inboundProvider, type ReceivedAttachment, type ReceivedEmail } from './provider';
import { verifyWebhook } from './signature';

/**
 * Incoming email (01-ARCHITECTURE §8): an item's address turns mail into an update on it, a board's
 * address into a new item. The provider's webhook only says a message arrived (signed — never taken unsigned); the
 * message is fetched and written by a job, so a slow download never holds the webhook.
 */
export const INBOUND_TASK = 'inbound_email.process';

type Deps = Pick<AppDeps, 'db' | 'storage' | 'env' | 'logger'>;

const newToken = () => {
  const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return [...randomBytes(INBOUND_TOKEN_LENGTH)].map((b) => abc[b % abc.length]).join('');
};

/** The platform's inbound domain (owner console → Emails), or null: incoming email is off on this platform. */
export const inboundDomain = async (db: Db) => (await loadPlatformSettings(db)).email.inbound_domain ?? null;

// ---------------------------------------------------------------- addresses (the app)

/**
 * Who may see / create / rotate an address: an item's — whoever may comment on it (mail there is written with their
 * rights when the sender is outside the account); a board's — whoever may create items on it.
 */
const assertMayUse = async (db: Db, a: Actor, kind: InboundKind, targetId: string) => {
  if (kind === 'item') {
    await loadItem(db, a, targetId);
    await assertCanComment(db, a);
  } else {
    assertBoard(await loadBoardAccess(db, a.ctx, a.user, targetId), 'item.create');
  }
};

const dto = async (
  db: Db,
  a: Actor,
  kind: InboundKind,
  row: InboundAddressRow | undefined | null,
): Promise<InboundAddressDto> => {
  const domain = await inboundDomain(db);
  const enabled = (await loadSettings(db, a.ctx.accountId)).inbound_email.enabled;
  const off = !domain ? 'platform' : !enabled ? 'account' : null;
  return {
    kind,
    address: !off && row ? inboundAddress(kind, row.token, domain!) : null,
    off,
    created_at: row ? row.createdAt.toISOString() : null,
  };
};

export const getAddress = async (db: Db, a: Actor, kind: InboundKind, targetId: string) => {
  await assertMayUse(db, a, kind, targetId);
  return dto(db, a, kind, await findLiveAddress(db, a.ctx.accountId, kind, targetId));
};

/** Refused while incoming email is off — an address that works nowhere is not handed out. */
const assertOn = async (db: Db, a: Actor) => {
  if (!(await inboundDomain(db))) throw new AppError('forbidden', 'inbound_email_off_platform');
  if (!(await loadSettings(db, a.ctx.accountId)).inbound_email.enabled)
    throw new AppError('forbidden', 'inbound_email_off_account');
};

const create = async (db: Db, a: Actor, kind: InboundKind, targetId: string) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await insertAddress(db, {
      id: newId(),
      accountId: a.ctx.accountId,
      kind,
      itemId: kind === 'item' ? targetId : null,
      boardId: kind === 'board' ? targetId : null,
      token: newToken(),
      createdBy: a.user.id,
    });
    if (row) return row;
    // Someone made it at the same moment: theirs is the address.
    const live = await findLiveAddress(db, a.ctx.accountId, kind, targetId);
    if (live) return live;
  }
  throw new AppError('conflict', 'inbound_address_busy');
};

/** The address of an item / a board — made on first use (idempotent). */
export const ensureAddress = async (db: Db, a: Actor, kind: InboundKind, targetId: string) => {
  await assertMayUse(db, a, kind, targetId);
  await assertOn(db, a);
  const live = await findLiveAddress(db, a.ctx.accountId, kind, targetId);
  return dto(db, a, kind, live ?? (await create(db, a, kind, targetId)));
};

/**
 * The item's address for a reply sent from it, made on first use as `writer` — the member whose
 * rights the customer's answer is written with (like an address someone opened by hand). Null while incoming email
 * is off.
 */
export const itemReplyAddress = async (db: Db, writer: Actor, itemId: string) => {
  const domain = await inboundDomain(db);
  if (!domain || !(await loadSettings(db, writer.ctx.accountId)).inbound_email.enabled) return null;
  const row =
    (await findLiveAddress(db, writer.ctx.accountId, 'item', itemId)) ?? (await create(db, writer, 'item', itemId));
  return inboundAddress('item', row.token, domain);
};

/** A new address; the old one stops working at once and for good (mail to it is dropped). */
export const rotateAddress = async (db: Db, a: Actor, kind: InboundKind, targetId: string) => {
  await assertMayUse(db, a, kind, targetId);
  await assertOn(db, a);
  const live = await findLiveAddress(db, a.ctx.accountId, kind, targetId);
  if (live) await disableAddress(db, live.id);
  return dto(db, a, kind, await create(db, a, kind, targetId));
};

/** No address any more (until someone asks for one again — then a new one). */
export const removeAddress = async (db: Db, a: Actor, kind: InboundKind, targetId: string) => {
  await assertMayUse(db, a, kind, targetId);
  const live = await findLiveAddress(db, a.ctx.accountId, kind, targetId);
  if (live) await disableAddress(db, live.id);
  return dto(db, a, kind, null);
};

// ---------------------------------------------------------------- the webhook

type WebhookHeaders = { id?: string; timestamp?: string; signature?: string };
type Json = Record<string, unknown>;
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * The webhook's one answer: the same for a known, retired or unknown address and for an account with incoming email
 * off — nothing says whether a token exists (what happened is on the message's row only).
 */
const RECEIVED = { received: true } as const;
/** Calls per client address per minute (the provider's bursts fit), and bad signatures per address per 10 minutes. */
const callsByIp = new RateLimiter(120, 60_000);
const failuresByIp = new RateLimiter(20, 10 * 60_000);

/** At most this many of our addresses are taken from one message (a mail to many items at once). */
const MAX_TARGETS = 10;

/**
 * POST /hooks/email/resend: a signed `email.received` → one queued message per address of ours in it. Unsigned, or
 * signed with another secret → 401 (nothing is read); per client address a rate limit and a failure limit (429). Other event types are acknowledged and ignored. Addresses of
 * accounts with incoming email off, retired addresses and strangers are skipped silently (no bounce is sent).
 */
export const receiveWebhook = async (
  deps: Deps,
  rawBody: string,
  headers: WebhookHeaders,
  clientIp: string | null = null,
  now = new Date(),
): Promise<typeof RECEIVED> => {
  const ip = ipBucket(clientIp);
  // Too many calls, or too many bad signatures, from one address: refused before anything is read.
  if (callsByIp.hit(ip) || failuresByIp.peek(ip)) throw new AppError('rate_limited', 'Too many requests');
  if (!verifyWebhook(deps.env.RESEND_INBOUND_SECRET, headers, rawBody, now)) {
    failuresByIp.hit(ip);
    throw new AppError('unauthenticated', 'invalid_signature');
  }
  let event: Json;
  try {
    event = JSON.parse(rawBody) as Json;
  } catch {
    throw new AppError('validation_failed', 'invalid_json');
  }
  if (event.type !== 'email.received') return RECEIVED;
  const data = (event.data && typeof event.data === 'object' ? event.data : {}) as Json;
  const emailId = typeof data.email_id === 'string' ? data.email_id.slice(0, 100) : '';
  if (!emailId) throw new AppError('validation_failed', 'missing_email_id');
  const domain = await inboundDomain(deps.db);
  if (!domain) return RECEIVED;
  // Every address the message was delivered to: To, Cc, and the envelope (`received_for`, which covers Bcc).
  const recipients = [...new Set([...strings(data.to), ...strings(data.cc), ...strings(data.received_for)])];
  const targets = recipients
    .map((r) => parseInboundAddress(parseMailbox(r)?.email ?? r, domain))
    .filter((x): x is NonNullable<typeof x> => !!x)
    .slice(0, MAX_TARGETS);
  const from = typeof data.from === 'string' ? (parseMailbox(data.from)?.email ?? '') : '';
  for (const t of targets) {
    const address = await findAddressByToken(deps.db, t.kind, t.token);
    if (!address) continue;
    if (!(await loadSettings(deps.db, address.accountId)).inbound_email.enabled) continue;
    const row = await logInboundEmail(deps.db, {
      id: newId(),
      accountId: address.accountId,
      addressId: address.id,
      providerEmailId: emailId,
      fromEmail: from.slice(0, 320),
    });
    if (!row) continue; // the provider sent this webhook before: taken already
    const onQueue = await enqueueJob(deps.db, INBOUND_TASK, { email_id: row.id }, { maxAttempts: 5 });
    // No job runner (tests, a bare install): the message is written right away.
    if (!onQueue) await processInboundEmail(deps, row.id);
  }
  return RECEIVED;
};

// ---------------------------------------------------------------- the job

/** Why a message was not written (kept on its row). */
class Reject extends Error {}
const reject = (reason: string): never => {
  throw new Reject(reason);
};

/** An actor for a member of the account (the sender, or the address's creator) — null when they cannot act there. */
export const memberActor = async (db: Db, accountId: string, userId: string | null, requestId: string) => {
  if (!userId) return null;
  const [account, membership, user] = await Promise.all([
    findAccountById(db, accountId),
    findMembership(db, accountId, userId),
    findUserById(db, userId),
  ]);
  if (!account || !user || membership?.status !== 'active') return null;
  const actor: Actor = {
    ctx: { account, accountId, role: membership.role, membershipId: membership.id },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: !!user.emailVerified,
      isPlatformOwner: false,
      locale: user.locale,
      timezone: user.timezone,
    },
    requestId,
  };
  return actor;
};

/** May this actor write there (an update on the item, or an item on the board)? */
const mayWrite = async (db: Db, a: Actor, address: InboundAddressRow) => {
  try {
    await assertMayUse(db, a, address.kind as InboundKind, (address.itemId ?? address.boardId)!);
    return true;
  } catch (err) {
    if (err instanceof AppError) return false;
    throw err;
  }
};

/** A paragraph of plain text (the subject line, a note). */
const para = (text: string): RichNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });

/** Auto-replies and bulk mail (vacation answers, mailing lists) are not conversation: dropped. */
const isAutomatic = (headers: Record<string, string>) =>
  (!!headers['auto-submitted'] && headers['auto-submitted'].toLowerCase() !== 'no') ||
  /^(bulk|junk|list|auto_reply)$/i.test(headers['precedence'] ?? '') ||
  !!headers['x-autoreply'] ||
  !!headers['x-autorespond'];

/** The provider's verdict: SPF or DKIM must pass, and DMARC must not fail. No verdict = not taken. */
const authenticated = (auth: { spf?: string; dkim?: string; dmarc?: string } | null) =>
  !!auth && auth.dmarc !== 'fail' && (auth.spf === 'pass' || auth.dkim === 'pass');

type Skipped = { name: string; reason: InboundSkipReason };

/**
 * Attachments worth keeping: real files (an image of the body is kept as the body's, a signature's inline image not
 * at all), allowed types, within the limits. The ones left out are listed with the reason.
 */
const pickAttachments = (list: ReceivedAttachment[], inBody: Set<string>) => {
  const kept: ReceivedAttachment[] = [];
  const skipped: Skipped[] = [];
  let total = 0;
  for (const f of list) {
    const cid = f.content_id ? cidKey(f.content_id) : null;
    if (cid && (inBody.has(cid) || (f.content_disposition ?? '').toLowerCase() === 'inline')) continue;
    const name = (f.filename || 'attachment').slice(0, 255);
    const reason: InboundSkipReason | null = !isServerFileMime(f.content_type)
      ? 'type'
      : f.size > INBOUND_LIMITS.maxFileBytes
        ? 'too_big'
        : kept.length >= INBOUND_LIMITS.maxFiles || total + f.size > INBOUND_LIMITS.maxTotalBytes
          ? 'too_many'
          : null;
    if (reason) {
      skipped.push({ name, reason });
      continue;
    }
    total += f.size;
    kept.push(f);
  }
  return { kept, skipped };
};

/** A Content-ID as the body names it (`cid:x`) and as the attachment carries it (`<x>`). */
const cidKey = (cid: string) => cid.trim().replace(/^</, '').replace(/>$/, '').toLowerCase();
/** Images of the body kept as files: the types a browser shows (no SVG: it can carry script). */
const BODY_IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/;

/** An image of the body waiting to be stored: an inline attachment, or data written into the HTML. */
type PendingImage = { key: string; name: string } & (
  { kind: 'attachment'; file: ReceivedAttachment } | { kind: 'data'; mime: string; body: Buffer }
);

/** Replaces each pending image (`pending:<key>`) with its stored file (`asset:<id>`), or drops it. */
const resolveImages = (blocks: RichNode[], stored: Map<string, string>): RichNode[] =>
  blocks.flatMap((b): RichNode[] => {
    if (b.type === 'image') {
      const src = String(b.attrs?.src ?? '');
      if (!src.startsWith('pending:')) return [b];
      const id = stored.get(src.slice('pending:'.length));
      return id ? [{ ...b, attrs: { ...b.attrs, src: `asset:${id}` } }] : [];
    }
    return b.content ? [{ ...b, content: resolveImages(b.content, stored) }] : [b];
  });

/**
 * The message → the update's blocks: its HTML when it has one (formatting, links, tables, images)
 * else its text; a reply without the quoted earlier message. The body's images (`cid:` attachments, embedded data)
 * become files to store — not when the account turned that off or the image is below its size threshold (a signature
 * logo, a spacer); images from the web are listed for the proxy (`remote:<n>`) and never stored; tracking pixels go.
 */
const messageBody = (
  mail: ReceivedEmail,
  attachments: ReceivedAttachment[],
  settings: InboundEmailSettings,
  locale: Locale,
  limits: InboundLimits,
) => {
  const byCid = new Map(attachments.filter((f) => f.content_id).map((f) => [cidKey(f.content_id!), f]));
  const inBody = new Set<string>();
  const pending: PendingImage[] = [];
  const remote: string[] = [];
  const skipped: Skipped[] = [];
  const minBytes = settings.body_image_min_kb * 1024;
  /** A body image to keep, or the reason it is not kept. */
  const keep = (name: string, mime: string, size: number): InboundSkipReason | null =>
    !settings.body_images
      ? 'images_off'
      : !BODY_IMAGE_MIME.test(mime)
        ? 'type'
        : size > INBOUND_LIMITS.maxFileBytes
          ? 'too_big'
          : size < minBytes
            ? 'small_image'
            : pending.length >= limits.maxBodyImages
              ? 'too_many'
              : null;
  const image = (img: MailImage) => {
    const src = img.src.trim();
    const shown = { alt: img.alt.slice(0, 300), width: img.width && img.width <= 4000 ? img.width : null };
    if (/^cid:/i.test(src)) {
      const key = cidKey(src.slice(4));
      const file = byCid.get(key);
      if (!file) return null;
      inBody.add(key);
      if (!pending.some((p) => p.key === key)) {
        const name = (file.filename || 'image').slice(0, 255);
        const reason = keep(name, file.content_type, file.size);
        if (reason) {
          // A small image of the body (a signature logo) is left out quietly, once.
          if (!skipped.some((s) => s.name === name && s.reason === reason)) skipped.push({ name, reason });
          return null;
        }
        pending.push({ key, name, kind: 'attachment', file });
      }
      return { src: `pending:${key}`, ...shown };
    }
    const data = /^data:(image\/[a-z+.-]+);base64,([a-z0-9+/=\s]+)$/i.exec(src);
    if (data) {
      const mime = data[1]!.toLowerCase();
      const body = Buffer.from(data[2]!.replace(/\s+/g, ''), 'base64');
      const name = `image-${pending.length + 1}.${mime.split('/')[1]!.replace('jpeg', 'jpg')}`;
      const reason = keep(name, mime, body.length);
      if (reason) {
        if (!skipped.some((s) => s.reason === reason && s.name.startsWith('image-'))) skipped.push({ name, reason });
        return null;
      }
      const key = `data${pending.length}`;
      pending.push({ key, name, kind: 'data', mime, body });
      return { src: `pending:${key}`, ...shown };
    }
    if (/^https?:\/\//i.test(src) && src.length <= 2000 && settings.remote_images) {
      // A tracking pixel shows nothing and only tells the sender the mail was read.
      if ((img.width !== null && img.width <= 3) || (img.height !== null && img.height <= 3)) return null;
      let n = remote.indexOf(src);
      if (n < 0) {
        if (remote.length >= limits.maxRemoteImages) return null;
        n = remote.push(src) - 1;
      }
      return { src: `remote:${n}`, ...shown };
    }
    return null;
  };
  const linkLabel = st('server.inbound.link', undefined, locale);
  const text = mail.text?.trim() ? mail.text : mail.html ? mailHtmlToText(mail.html) : '';
  const fresh = stripQuotedReply(text);
  // A reply (the text had a quoted earlier message): the HTML's quote goes too. A plain forward is kept whole.
  const isReply = fresh.length < text.trim().length;
  let body = mail.html
    ? mailHtmlToDoc(mail.html, { image, linkLabel, stripQuotes: isReply, maxChars: limits.maxTextChars })
    : null;
  if (!body?.blocks.length) {
    pending.length = 0;
    remote.length = 0;
    body = mailTextToDoc(fresh, { linkLabel, maxChars: limits.maxTextChars });
  }
  return { blocks: body.blocks, cut: body.cut, pending, remote, skipped, inBody };
};

/**
 * One queued message → an update (item address) or a new item with the message as its first update (board
 * address). Rejected messages keep their reason (`rate_limited`, `sender_not_allowed`, `unauthenticated_sender`,
 * `duplicate`, `automatic`, `loop`, `address_retired`, `incoming_off`, `no_writer`); a provider failure is thrown,
 * so the job runs again.
 */
export const processInboundEmail = async (deps: Deps, emailRowId: string) => {
  const { db } = deps;
  const row = await findInboundEmail(db, emailRowId);
  if (!row || row.status !== 'queued') return;
  try {
    const address = await findAddressById(db, row.addressId);
    if (!address || address.disabledAt) reject('address_retired');
    const addr = address!;
    if (await accountClosed(db, addr.accountId)) reject('account_closed');
    const domain = await inboundDomain(db);
    const settings = (await loadSettings(db, addr.accountId)).inbound_email;
    if (!domain || !settings.enabled) reject('incoming_off');
    const hourAgo = new Date(Date.now() - 60 * 60_000);
    if ((await recentCount(db, { addressId: addr.id }, hourAgo, row.id)) >= INBOUND_LIMITS.perAddressPerHour)
      reject('rate_limited');
    if ((await recentCount(db, { accountId: addr.accountId }, hourAgo, row.id)) >= INBOUND_LIMITS.perAccountPerHour)
      reject('rate_limited');

    const provider = inboundProvider(deps.env);
    if (!provider) throw new Error('inbound_provider_not_configured');
    const mail = await provider.getEmail(row.providerEmailId);
    const sender = parseMailbox(mail.headers['from'] ?? mail.from) ?? parseMailbox(mail.from);
    if (!sender) reject('no_sender');
    const from = sender!;
    if (mail.message_id && !(await setMessageId(db, row.id, mail.message_id.slice(0, 255)))) reject('duplicate');
    if (!authenticated(mail.authentication)) reject('unauthenticated_sender');
    if (isAutomatic(mail.headers)) reject('automatic');
    // Our own mail coming back (a notification forwarded to an item, a loop between two addresses): dropped.
    const ownSender = (deps.env.EMAIL_FROM || deps.env.RESEND_FROM || '').toLowerCase();
    if (mailDomainOf(from.email) === domain || (ownSender && ownSender.includes(from.email))) reject('loop');

    // Who writes it: a verified member who may write there, as themselves; anyone else as the address's creator,
    // and only if the account's policy lets them in.
    const requestId = `inbound:${row.id}`;
    const memberId = await findVerifiedMemberByEmail(db, addr.accountId, from.email);
    const member = memberId ? await memberActor(db, addr.accountId, memberId, requestId) : null;
    const asMember = member && (await mayWrite(db, member, addr)) ? member : null;
    if (!asMember) {
      const allowed =
        settings.senders === 'anyone' ||
        (settings.senders === 'domains' && settings.domains.includes(mailDomainOf(from.email)));
      if (!allowed) reject('sender_not_allowed');
    }
    const owner = asMember ?? (await memberActor(db, addr.accountId, addr.createdBy, requestId));
    if (!owner || (!asMember && !(await mayWrite(db, owner, addr)))) reject('no_writer');
    const actor = owner!;

    // The text: the new part of the message only, within the limit.
    const locale = await accountLocale(db, addr.accountId);
    const attachments = await provider.listAttachments(row.providerEmailId);
    // The platform's limits of one message (owner console; empty = the defaults).
    const limits = inboundLimitsOf((await loadPlatformSettings(db)).email);
    const { blocks, cut, pending, remote, skipped, inBody } = messageBody(mail, attachments, settings, locale, limits);
    const { kept, skipped: skippedFiles } = pickAttachments(attachments, inBody);
    skipped.push(...skippedFiles);
    const fileIds: string[] = [];
    for (const f of kept)
      fileIds.push(
        await storeAttachment(deps, actor, f, () => provider.download(f.download_url, INBOUND_LIMITS.maxFileBytes)),
      );
    // The body's images: kept as files of the update (shown in place); one that cannot be fetched is left out.
    const stored = new Map<string, string>();
    for (const p of pending) {
      try {
        const id =
          p.kind === 'attachment'
            ? await storeAttachment(deps, actor, p.file, () =>
                provider.download(p.file.download_url, INBOUND_LIMITS.maxFileBytes),
              )
            : await storeFile(deps, actor, p.name, p.mime, p.body);
        stored.set(p.key, id);
        fileIds.push(id);
      } catch (err) {
        deps.logger.warn({ inbound_email: row.id, err }, 'inbound email image not kept');
        skipped.push({ name: p.name, reason: 'failed' });
      }
    }
    // Too long: the start is shown, and the whole original message is attached (.eml).
    const notes: string[] = [];
    if (cut) {
      let original = false;
      if (mail.raw_url) {
        try {
          const body = await provider.download(mail.raw_url, INBOUND_LIMITS.maxFileBytes);
          fileIds.push(await storeFile(deps, actor, 'message.eml', 'message/rfc822', body));
          original = true;
        } catch (err) {
          deps.logger.warn({ inbound_email: row.id, err }, 'inbound email original not kept');
          skipped.push({ name: 'message.eml', reason: 'failed' });
        }
      }
      notes.push(st(original ? 'server.inbound.textCutOriginal' : 'server.inbound.textCut', undefined, locale));
    }

    const subject = mail.subject?.trim().slice(0, 300) || null;
    const meta: UpdateEmailMeta = {
      from: from.email,
      name: from.name,
      subject,
      external: !asMember,
      files: { attached: fileIds.length, skipped },
      ...(cut ? { cut: true } : {}),
    };
    const doc: RichNode = {
      type: 'doc',
      content: [...(subject ? [para(subject)] : []), ...resolveImages(blocks, stored), ...notes.map(para)],
    };
    let itemId = addr.itemId;
    if (addr.kind === 'board') {
      const item = await createItem(db, actor, addr.boardId!, {
        name: (subject ?? st('server.inbound.noSubject', { from: from.name ?? from.email }, locale)).slice(0, 255),
      });
      itemId = item.id;
    }
    // A subject alone on an item address would repeat what the badge shows: kept as the first line all the same,
    // since that is often the whole message ("approved").
    const update = await createEmailUpdate(db, actor, itemId!, { doc }, fileIds, meta, remote);
    await finishInboundEmail(db, row.id, { status: 'done', fromEmail: from.email, itemId, updateId: update.id });
  } catch (err) {
    if (err instanceof Reject) {
      await finishInboundEmail(db, row.id, { status: 'rejected', reason: err.message });
      deps.logger.info({ inbound_email: row.id, reason: err.message }, 'inbound email rejected');
      return;
    }
    if (err instanceof AppError) {
      // A permission / validation answer will not change on a retry.
      await finishInboundEmail(db, row.id, { status: 'failed', reason: err.code.slice(0, 40) });
      deps.logger.warn({ inbound_email: row.id, code: err.code }, 'inbound email failed');
      return;
    }
    throw err;
  }
};

/** An attachment → an uploaded file of the writer's (so the update may carry it), through the file type check. */
const storeAttachment = async (deps: Deps, a: Actor, f: ReceivedAttachment, fetchBody: () => Promise<Buffer>) =>
  storeFile(deps, a, (f.filename || 'attachment').slice(0, 255), f.content_type, await fetchBody());

/** Bytes of the message (an attachment, a body image, the original .eml) → an uploaded file of the writer's. */
const storeFile = async (deps: Deps, a: Actor, name: string, mime: string, body: Buffer) => {
  const id = newId();
  const key = `${a.ctx.accountId}/${id}/${safeName(name)}`;
  await insertAsset(deps.db, {
    id,
    accountId: a.ctx.accountId,
    ownerId: a.user.id,
    kind: 'file',
    storageKey: key,
    fileName: name,
    mime: mime,
    size: body.length,
    uploadStatus: 'pending',
  });
  await deps.storage.put(key, body, mime);
  await markUploaded(deps.db, id, body.length, mime);
  return id;
};
