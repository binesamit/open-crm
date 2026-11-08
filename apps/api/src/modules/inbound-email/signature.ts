// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signatures the way the mail provider sends them (Resend signs through Svix): headers `svix-id`,
 * `svix-timestamp` (unix seconds) and `svix-signature` (`v1,<base64>` entries, space-separated, several while a secret
 * rotates); the signed text is `<id>.<timestamp>.<raw body>`, HMAC-SHA256 with the secret's bytes (`whsec_<base64>`).
 */
export const SIGNATURE_TOLERANCE_S = 5 * 60;

const keyOf = (secret: string) => Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');

/** The `v1,<base64>` signature of a body (tests build valid webhooks with it). */
export const signWebhook = (secret: string, id: string, timestamp: number, body: string) =>
  `v1,${createHmac('sha256', keyOf(secret)).update(`${id}.${timestamp}.${body}`).digest('base64')}`;

/**
 * True only for a body signed with `secret`, sent within the tolerance (a replayed old call is refused). No secret,
 * a missing header or a malformed one = false: an unsigned call is never accepted.
 */
export const verifyWebhook = (
  secret: string | undefined,
  headers: { id?: string; timestamp?: string; signature?: string },
  body: string,
  now = new Date(),
) => {
  if (!secret || !headers.id || !headers.timestamp || !headers.signature) return false;
  if (!/^\d{1,12}$/.test(headers.timestamp)) return false;
  const ts = Number(headers.timestamp);
  if (Math.abs(now.getTime() / 1000 - ts) > SIGNATURE_TOLERANCE_S) return false;
  const expected = Buffer.from(signWebhook(secret, headers.id, ts, body).slice(3), 'base64');
  return headers.signature
    .split(' ')
    .filter((s) => s.startsWith('v1,'))
    .some((s) => {
      const got = Buffer.from(s.slice(3), 'base64');
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
};
