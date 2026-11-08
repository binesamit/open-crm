// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { expect, type Page } from '@playwright/test';

/**
 * Two-factor authentication in E2E (secret columns, secret updates): the TOTP is computed here from the otpauth:// URI
 * (as in sec2.spec.ts), and a teammate turns 2FA on in the profile.
 */
const PASSWORD = 'a-very-good-password'; // helpers.newTeammate

const base32 = (s: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};

export const totp = (uri: string) => {
  const secret = base32(new URL(uri).searchParams.get('secret')!);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
};

/** Profile → כניסה ואבטחה: turn 2FA on (as sec2.spec.ts); returns the otpauth URI. */
export const enrol = async (mate: Page) => {
  await mate.goto('/a/demo/profile?tab=security');
  await mate.getByTestId('two-factor-enable').click();
  await mate.getByTestId('two-factor-password').fill(PASSWORD);
  await mate.getByTestId('two-factor-start').click();
  const uri = (await mate.getByTestId('two-factor-secret').getAttribute('data-uri'))!;
  await mate.getByTestId('two-factor-code').fill(totp(uri));
  await mate.getByTestId('two-factor-verify').click();
  await mate.getByTestId('two-factor-backup-done').click();
  await expect(mate.getByTestId('profile-two-factor')).toHaveAttribute('data-enabled', 'true');
  return uri;
};
