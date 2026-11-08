// SPDX-License-Identifier: AGPL-3.0-only
import type { TokenScope } from '@bines/shared';

/**
 * Which scope a token needs for a request (06 §1.3), by path and method: GET/HEAD read, anything else writes.
 * `null` = never with a token (token management, the owner console, account switching). First match wins,
 * so the specific families (updates, automations, time) come before the generic item / board ones; anything
 * unknown needs `admin`.
 */
type Rule = [RegExp, TokenScope | 'any' | null, TokenScope | 'any' | null];

const RULES: Rule[] = [
  // Token management and the n8n / Make set-up page that goes with it.
  [/^\/auth\/(tokens|service-tokens|integrations)/, null, null],
  [/^\/platform\//, null, null],
  [/^\/me\/(accounts|last-account|invitations)/, null, null],
  // The phone app (PWA): registering a phone for push and the app's config — a person's session only.
  [/^\/(me\/push-subscriptions|pwa)(\/|$)/, null, null],
  // The OAuth consent screen and the connected AI apps: a person's session only (מ5).
  [/^\/(oauth-requests|mcp-connections)(\/|$)/, null, null],
  // Extensions (D27): installing, consenting and minting an extension's token — a person's session only.
  [/^\/extensions(\/|$)/, null, null],
  // An extension's own storage and uploads (D27 ת5): its token only (the routes refuse anything else).
  [/^\/ext\/storage(\/|$)/, 'any', 'any'],
  [/^\/ext\/files(\/|$)/, 'boards:read', 'items:write'],
  // its server asks who a token of its own pages belongs to (the route takes a server token only).
  [/^\/ext\/introspect$/, 'any', 'any'],
  // the count beside one of its sidebar pages — its token only (the route refuses anything else).
  [/^\/ext\/app-pages\/[^/]+\/badge$/, 'any', 'any'],
  // which automations use one of its own triggers — its page reads, never writes.
  [/^\/ext\/automations$/, 'boards:read', null],
  // Outbound MCP servers (מ10): registering one, its credentials and its tools — a person's session only.
  [/^\/mcp-servers(\/|$)/, null, null],
  // External automation platforms: their keys and flows — a person's session only (AI apps use the
  // flows_* tools, which run as the person with the same checks).
  [/^\/flow-connections(\/|$)/, null, null],
  // The AI assistant panel (מ12) spends the account's AI budget in a person's chat: a session only.
  [/^\/ai\/assistant(\/|$)/, null, null],
  // AI columns (מ11): reading their state is a board read; running them writes items.
  [/^\/(ai-columns|boards\/[^/]+\/ai-columns)(\/|$)/, 'boards:read', 'items:write'],
  // Taking over someone's sign-in (EXT security review follow-up): a recovery link or a 2FA reset for a member is
  // a person's session only — a leaked admin token must never be able to sign in as another member.
  [/^\/users\/[^/]+\/(recovery-link|reset-2fa)$/, null, null],
  [/^\/platform\/accounts\/[^/]+\/recovery-link$/, null, null],
  // Remote support access: letting support in is a person's decision, never a token's.
  [/^\/support-access(\/|$)/, null, null],
  // Support tickets: opening a ticket and letting support in from it — a person's session only.
  [/^\/support(\/|$)/, null, null],
  // Plans: "My plan" is the admins' page; a billing webhook carries its provider's signature, no token
  // the offered plans (plan-lock) are for a signed-in person.
  [/^\/(plan|plans|billing)(\/|$)/, null, null],
  // Errors hub: the account's Health page and the browser's error reports — a person's session only.
  [/^\/(account-health|client-errors)(\/|$)/, null, null],
  // the full account export and the account's deletion — an admin's session only (a leaked token
  // must never take all the data out or delete the account).
  [/^\/(account-export|account-deletion)(\/|$)/, null, null],
  [/^\/auth\/me$/, 'any', null],
  // Secret columns: revealing (and its copy event) needs `secrets:read`, which no other scope
  // includes; the two-factor step-up is a person's session only; the reveal log is the admins'.
  [/^\/items\/[^/]+\/cells\/[^/]+\/secret\/(reveal|copy)$/, 'secrets:read', 'secrets:read'],
  // Secret updates: the same — reveal / copy need `secrets:read`; the settings (the account's default
  // a board's override) guard the text, so changing them is a person's session only (with a fresh code).
  [/^\/updates\/[^/]+\/(reveal|secret-copy)$/, 'secrets:read', 'secrets:read'],
  [/^\/secrets\/update-settings$/, null, null],
  [/^\/boards\/[^/]+\/secret-updates$/, 'boards:read', null],
  [/^\/secrets\/(status|verify)$/, null, null],
  [/^\/secrets\/log$/, 'admin', null],
  // Reads sent as POST (a query body).
  [
    /\/items\/(query|count|search|find)$|^\/boards\/[^/]+\/(export|chart|widget-data|widget-items)$|^\/dashboards\/[^/]+\/widgets\/[^/]+\/items$/,
    'boards:read',
    'boards:read',
  ],
  // Maps (M8 ד10): the map config and address lookups are reads; the settings are the account's.
  [/^\/geo\//, 'boards:read', 'admin'],
  [/^\/(automations|automation-templates|boards\/[^/]+\/automations)/, 'automations:read', 'automations:write'],
  // Scenarios (phase 3) are automations drawn as a graph: the same scopes.
  [/^\/(scenarios|boards\/[^/]+\/scenarios)(\/|$)/, 'automations:read', 'automations:write'],
  // AI agents: running one (and stopping its run) is its own scope, so a no-code tool can start an agent
  // without managing agents; creating, changing, deleting, approvals, undo and knowledge are agents:write.
  [/^\/agents\/[^/]+\/runs$/, 'agents:read', 'agents:run'],
  [/^\/agents\/runs\/[^/]+\/cancel$/, 'agents:read', 'agents:run'],
  [/^\/agents(\/|$)/, 'agents:read', 'agents:write'],
  [/^\/(webhooks|hooks|boards\/[^/]+\/webhooks)/, 'webhooks', 'webhooks'],
  [/^\/(updates|items\/[^/]+\/updates)/, 'updates:read', 'updates:write'],
  // SMS from an item is posted to the item's updates; the status is a read of the same family.
  [/^\/(sms\/status$|items\/[^/]+\/sms$)/, 'updates:read', 'updates:write'],
  [/^\/me\/(notifications|inbox)/, 'notifications:read', 'notifications:write'],
  [/^\/search/, 'search', 'search'],
  [/^\/(users|invitations)/, 'users:read', 'users:write'],
  [/^\/teams/, 'users:read', 'teams:write'],
  // Item templates: applying one writes items; saving / editing one changes the board's setup.
  [/^\/item-templates\/[^/]+\/apply$/, 'boards:read', 'items:write'],
  [
    /^\/(item-templates|boards\/[^/]+\/item-templates|items\/[^/]+\/save-as-template)(\/|$)/,
    'boards:read',
    'boards:write',
  ],
  // Interactive documents: templates, an item's documents and signature certificates.
  [/^\/(idoc-templates|idocs|signatures)(\/|$)/, 'boards:read', 'items:write'],
  [/^\/(items|files|time|me\/work|me\/time|activity|trash|archive|tags)/, 'boards:read', 'items:write'],
  [/^\/boards\/[^/]+\/(items|events|activity)/, 'boards:read', 'items:write'],
  // Docs (M8) are workspace objects like boards.
  [/^\/(docs|doc-comments|doc-comment-threads|me\/favorite-docs)/, 'boards:read', 'boards:write'],
  // My favourites (Fix: ): boards, docs and dashboards.
  [/^\/me\/favorites$/, 'boards:read', 'boards:write'],
  // Board viewers (r18boardviews): reading the list is a board read; reporting an open is the app's (a session only).
  [/^\/boards\/[^/]+\/viewers$/, 'boards:read', null],
  [/^\/(boards|workspaces|folders|views|templates)/, 'boards:read', 'boards:write'],
  [/^\/me\/events/, 'boards:read', null],
];

export type ScopeNeed = { scope: TokenScope | 'any' } | { forbidden: true };

export const requiredScope = (method: string, path: string): ScopeNeed => {
  const read = method === 'GET' || method === 'HEAD';
  for (const [re, r, w] of RULES) {
    if (!re.test(path)) continue;
    const s = read ? r : w;
    return s ? { scope: s } : { forbidden: true };
  }
  return { scope: 'admin' };
};
