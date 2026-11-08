// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Cloudflare Turnstile (D22.5): checked on the server with the form's secret. Optional — a form without a site key
 * and secret skips it. An object, so tests replace `verify` instead of calling Cloudflare.
 */
export const TURNSTILE_ORIGIN = 'https://challenges.cloudflare.com';
const SITEVERIFY = `${TURNSTILE_ORIGIN}/turnstile/v0/siteverify`;

export const turnstile = {
  verify: async (secret: string, token: string, ip: string | null): Promise<boolean> => {
    try {
      const body = new URLSearchParams({ secret, response: token });
      if (ip) body.set('remoteip', ip);
      const res = await fetch(SITEVERIFY, { method: 'POST', body, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return false;
      return ((await res.json()) as { success?: unknown }).success === true;
    } catch {
      // Cloudflare unreachable: the submission is refused (the person can retry), never let through unchecked.
      return false;
    }
  },
};
