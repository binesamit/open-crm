// SPDX-License-Identifier: AGPL-3.0-only
import { requiredScope } from '../../lib/scopes';

/**
 * Which operations the public API reference shows. The rule is the API's own: an operation is public when an API
 * token may call it (`lib/scopes.ts` — token management, the owner console, account switching, the OAuth consent
 * screen, installing extensions and the in-app AI chat are a person's session only). On top of that, the web app's
 * own plumbing that a token could reach but no integration needs (sign-in and invitation screens) and the
 * extension-token routes (documented in the extensions SDK, not here) stay out.
 */
const INTERNAL: RegExp[] = [
  // The owner console (D12) — also refused to tokens; listed so it never leaks if a scope rule changes.
  /^\/platform(\/|$)/,
  // Sign-in screens: login options, password reset, one-time sign-in links, invitation links.
  /^\/auth\/(config|forgot-password|recovery)(\/|$)/,
  /^\/invitations\//,
  /^\/me\/(password|security)$/,
  // Extension frames and servers call these with their own token (EXTENSIONS-GUIDE), not an API token.
  /^\/ext\//,
  /^\/automations\/triggers\//,
  // An image link inside the account's emails (no token; nothing for an integration).
  /^\/public\/email-logo\//,
  // The phone app's manifest, icons and kill switch (browsers fetch them; nothing for an integration).
  /^\/public\/pwa(\/|$)/,
  // The platform's public address for the web app's copied links (M11; nothing for an integration).
  /^\/public\/address$/,
  // Self sign-up (D32): the sign-up screens' own calls, nothing for an integration.
  /^\/public\/signup\//,
  // The license server's registration / key-check endpoints (licensing): installations call them, not integrations.
  /^\/public\/(installations|licenses)\//,
  // Legal documents still to accept: the person's own prompt, nothing for an integration.
  /^\/me\/legal(\/|$)/,
  // The installation guide inside the app: public as a page at /api/docs/guide, nothing to integrate.
  /^\/guides(\/|$)/,
  // Incoming email: the mail provider's signed notice — the provider calls it, never an integration.
  /^\/hooks\/email\//,
  // "How to start?": the start screen's own calls after sign-up, nothing for an integration.
  /^\/onboarding(\/|$)/,
  // "First steps": a person's own checklist in the app, nothing for an integration.
  /^\/me\/first-steps(\/|$)/,
];

/** Public operations that take no API token at all (a liveness probe; an inbound hook carries its own secret). */
export const NO_TOKEN: RegExp[] = [
  /^\/health$/,
  /^\/hooks\/in\//,
  /^\/public\/forms\//,
  /^\/help\//,
  /^\/legal(\/|$)/,
  // The pricing page's data: a website shows the plans from it.
  /^\/public\/pricing$/,
];

/** `'none'` = no token; null = any valid token; else the scope. */
export type ScopeLabel = string | null;

/** The token scope an operation needs, or `false` when it is not public. */
export const publicScope = (method: string, path: string): ScopeLabel | false => {
  if (INTERNAL.some((re) => re.test(path))) return false;
  if (NO_TOKEN.some((re) => re.test(path))) return 'none';
  // Path templates (`/items/{id}`) → a concrete-looking path for the scope rules.
  const concrete = path.replace(/\{[^}]+\}/g, 'x');
  const need = requiredScope(method.toUpperCase(), concrete);
  if ('forbidden' in need) return false;
  return need.scope === 'any' ? null : need.scope;
};
