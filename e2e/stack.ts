// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Where this E2E run's stack lives — every spec and helper takes its addresses from here, never a
 * literal port. Defaults are the usual local dev stack; `pnpm e2e:stacks` (run-stacks.mjs) runs several stacks side by
 * side and points each Playwright run at its own through these variables:
 *
 * - E2E_WEB_URL     the web app (Playwright's baseURL and the Origin of API calls) — default http://localhost:5173
 * - E2E_API_URL     the API itself, for the few specs that call it directly — default http://localhost:3000
 * - E2E_MAILPIT_URL the mail catcher's HTTP API (sign-in links) — default http://localhost:8025
 * - E2E_GEO_URL     the stand-in geocoder / map style (fake-geo.mjs) — default http://127.0.0.1:3999
 * - E2E_FAKE_MAIL_URL the stand-in mail provider's receiving API (fake-mail-provider.mjs) — default
 *                   http://127.0.0.1:3998
 * - E2E_STACK       a name for this stack (run-stacks.mjs sets s1, s2 …): keeps machine-wide locks per stack
 */
const url = (name: string, fallback: string) => (process.env[name] || fallback).replace(/\/+$/, '');

export const WEB_URL = url('E2E_WEB_URL', 'http://localhost:5173');
export const API_URL = url('E2E_API_URL', 'http://localhost:3000');
export const MAILPIT_URL = url('E2E_MAILPIT_URL', 'http://localhost:8025');
export const GEO_URL = url('E2E_GEO_URL', 'http://127.0.0.1:3999');
export const FAKE_MAIL_URL = url('E2E_FAKE_MAIL_URL', 'http://127.0.0.1:3998');
/** The incoming-mail webhook's signing secret of this run (test-only; the API gets it as RESEND_INBOUND_SECRET). */
export const INBOUND_SECRET = `whsec_${Buffer.from('bines-e2e-inbound-secret').toString('base64')}`;
export const STACK = process.env.E2E_STACK ?? '';

/** The port of an address (its explicit one, else the scheme's default). */
export const portOf = (address: string) => {
  const u = new URL(address);
  return u.port || (u.protocol === 'https:' ? '443' : '80');
};
