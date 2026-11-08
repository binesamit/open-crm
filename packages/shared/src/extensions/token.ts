// SPDX-License-Identifier: AGPL-3.0-only
/**
 * An extension's token (ת2, MARKETPLACE §4.3): `bos_ext_<payload>.<signature>`, minted for one user × one
 * installation × one board × one feature, valid for minutes. It reaches the extension's iframe by postMessage
 * (never in a URL) and is checked again on every request against the installation as it is now (disabled,
 * uninstalled, killed, fewer scopes or boards → refused at once).
 */
export const EXT_TOKEN_PREFIX = 'bos_ext_';
export const isExtensionToken = (s: string) => s.startsWith(EXT_TOKEN_PREFIX);

/** Minutes a token lives; the SDK asks the host for a fresh one before it runs out. */
export const EXT_TOKEN_TTL_MINUTES = 10;

/**
 * What an extension token may call at all (on top of its scopes and the user's own rights): reading and writing
 * board content. Never tokens, extensions, the owner console, account administration, AI or agents.
 */
const EXT_PATHS: RegExp[] = [
  /^\/auth\/me$/,
  /^\/boards(\/|$)/,
  /^\/items(\/|$)/,
  /^\/updates(\/|$)/,
  /^\/users(\/|$)/,
  /^\/teams(\/|$)/,
  /^\/search(\/|$)/,
  /^\/tags(\/|$)/,
  // The extension's own storage and uploads (ת5) — keyed by its installation, never anyone else's.
  /^\/ext\/(storage|files)(\/|$)/,
  // its server asks who a token of its own pages belongs to.
  /^\/ext\/introspect$/,
  // the count beside one of its own sidebar pages.
  /^\/ext\/app-pages\/[^/]+\/badge$/,
  // which automations use one of its own triggers (read only).
  /^\/ext\/automations$/,
];
/**
 * Paths under the allowed families that are not board content (EXT-RT1, docs/EXTENSIONS-SECURITY-REVIEW.md): an
 * extension never changes who may see a board (permissions, members, teams, invitations, ownership claims, column
 * restrictions), never reaches automations / webhooks / AI columns / exports, and never makes or edits templates.
 */
const EXT_DENIED: RegExp[] = [
  /^\/boards\/[^/]+\/(permissions|members|teams|invite|claim|webhooks|automations|ai-columns|export|save-as-template|template-draft)(\/|$)/,
  /^\/boards\/[^/]+\/columns\/[^/]+\/restriction(\/|$)/,
];

/**
 * Families an extension may only **read** (EXT-RT1): people and teams are account administration — inviting,
 * changing a role, deactivating, a recovery link (an account takeover), 2FA resets, ownership transfers, the people
 * export, team membership (which opens boards) and the user's own profile are never for an extension. Of `/users`
 * only the member list and the user's own profile are readable.
 */
const EXT_READ_ONLY: RegExp[] = [/^\/users(\/|$)/, /^\/teams(\/|$)/, /^\/auth\/me$/, /^\/ext\/automations$/];
const EXT_USERS_READABLE = /^\/users(\/me)?$/;

/**
 * May an extension token (or an extension server's token) call `method path` at all? On top of this: the scopes, the
 * boards, and the user's own rights. Without `method` only the path is checked (reads).
 */
/**
 * an extension's own server (never its pages) manages webhooks on its boards — the way it hears about
 * changes (the API keeps them to its own origins and its own webhooks).
 */
const EXT_SERVER_WEBHOOKS: RegExp[] = [
  /^\/boards\/[^/]+\/webhooks$/,
  /^\/webhooks\/[^/]+(\/(deliveries|test|rotate-secret))?$/,
];

export const extensionPathAllowed = (path: string, method = 'GET', opts: { server?: boolean } = {}) => {
  if (opts.server && EXT_SERVER_WEBHOOKS.some((re) => re.test(path))) return true;
  if (!EXT_PATHS.some((re) => re.test(path)) || EXT_DENIED.some((re) => re.test(path))) return false;
  const read = method === 'GET' || method === 'HEAD';
  if (EXT_READ_ONLY.some((re) => re.test(path)) && !read) return false;
  if (/^\/users(\/|$)/.test(path) && !EXT_USERS_READABLE.test(path)) return false;
  return true;
};

/**
 * Fields of `PATCH /boards/:id` an extension may not change (EXT-RT1): the board type and permission set decide who
 * sees it, and moving it to another workspace changes its audience too.
 */
export const EXT_BOARD_PATCH_DENIED = ['kind', 'permission_set', 'workspace_id'] as const;

/**
 * An extension's own storage (ת5, `/ext/storage`): key → JSON per installation (shared by its users) or per
 * installation × user. Limits per installation, all its users together.
 */
export const EXT_STORAGE_SCOPES = ['installation', 'user'] as const;
export type ExtStorageScope = (typeof EXT_STORAGE_SCOPES)[number];
export const EXT_STORAGE_VALUE_MAX_BYTES = 64 * 1024;
export const EXT_STORAGE_QUOTA_BYTES = 1024 * 1024;
export const EXT_STORAGE_MAX_KEYS = 1000;
/** A storage key: letters, digits and `._:-`, up to 200. */
export const EXT_STORAGE_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** `files.upload` of the SDK (ת5, `POST /ext/files`): one file at most this big (under the API's 5 MB body cap). */
export const EXT_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Signed calls between the platform and an extension's server (ת4): `X-Bines-Signature: sha256=<hex HMAC-SHA256 of
 * "<timestamp>.<body>">` with the installation's signing secret, `X-Bines-Timestamp` in milliseconds. A call older
 * (or newer) than this is refused, and so is the same signature twice (replay).
 */
export const EXT_SIGNATURE_TOLERANCE_SECONDS = 300;

/** postMessage protocol tag + version (packages/ext-sdk speaks the same). */
export const EXT_PROTOCOL = 'bines-ext';
export const EXT_PROTOCOL_VERSION = 1;
