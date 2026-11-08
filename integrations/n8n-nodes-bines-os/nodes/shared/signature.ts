// SPDX-License-Identifier: MIT
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { MAX_SIGNATURE_AGE_MS } from './constants';

/**
 * Deliveries are signed `X-Bines-Signature: sha256=HMAC-SHA256(secret, timestamp + "." + raw body)` with the
 * subscription's secret; `X-Bines-Timestamp` is milliseconds since the epoch.
 */
export const signature = (secret: string, timestamp: string, rawBody: string) =>
  `sha256=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')}`;

export type SignatureCheck = { ok: true } | { ok: false; reason: 'missing' | 'mismatch' | 'expired' };

export const verifySignature = (
  secret: string,
  timestamp: string | undefined,
  rawBody: string,
  given: string | undefined,
  now = Date.now(),
): SignatureCheck => {
  if (!timestamp || !given) return { ok: false, reason: 'missing' };
  const expected = signature(secret, timestamp, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'mismatch' };
  const age = Math.abs(now - Number(timestamp));
  if (!Number.isFinite(age) || age > MAX_SIGNATURE_AGE_MS) return { ok: false, reason: 'expired' };
  return { ok: true };
};

/** A fresh signing secret for a subscription (the API accepts 16–128 characters). */
export const newSecret = () => randomBytes(24).toString('hex');
