// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountRole } from '@bines/shared';
import type { Auth } from './auth/auth';
import type { Db } from './db/client';
import type { Env } from './env';
import type { Mailer } from '@bines/server-mail';
import type { AiClientFactory } from '@bines/server-ai';
import type { SecretBox } from './lib/secrets';
import type { Logger } from './lib/logger';
import type { EventBus } from './lib/realtime';
import type { SmsSender } from './lib/sms';
import type { FileStorage } from './lib/storage';
import type { AccountRow } from './modules/accounts/accounts.repo';

/** Everything a service needs; built once in index.ts (or per test) and closed over by the routers. */
export type AppDeps = {
  env: Env;
  logger: Logger;
  db: Db;
  auth: Auth;
  mailer: Mailer;
  sms: SmsSender;
  storage: FileStorage;
  /** Committed events (LISTEN/NOTIFY) for the SSE hub. */
  bus: EventBus;
  /** AI clients per connection (D26); tests inject a fake — no test spends money. */
  aiClient: AiClientFactory;
  /** Secrets at rest (AI connection keys). */
  secrets: SecretBox;
  /** False when no mail transport is configured (email off); absent = on (tests inject a mailer). */
  emailEnabled?: boolean;
};

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  isPlatformOwner: boolean;
  locale: string;
  /** Their own IANA zone, or null — never chosen: they follow the account's (`settings.locale.timezone`). */
  timezone: string | null;
  /** A service token's identity (06 §1.2): no profile of its own — it reads in the account's region (A3). */
  isService?: boolean;
  /** M8 ד12: the person signs in with a second factor (Better Auth twoFactor). */
  twoFactorEnabled?: boolean;
  /** How this session was made (password / magic_link / google / microsoft; null = unknown). Cookie sessions only. */
  signInMethod?: string | null;
  /** S-72: the organisation of a provider sign-in (Google `hd` / Microsoft `tid`); null = none. Cookie sessions only. */
  signInOrg?: string | null;
};

/** Resolved per request from X-Account-Id + an active membership (D12). */
export type AccountContext = {
  account: AccountRow;
  accountId: string;
  role: AccountRole;
  membershipId: string;
  /** An API token limited to some boards (06 §1.2): only these (and their sub-boards) exist for the request. */
  boardLimit?: string[] | null;
  /**
   * The scopes of the API token / MCP connection behind the request (null = a signed-in person). Routes check them;
   * a service that reads more than its route names (an AI column reading updates, S-64) checks them too.
   */
  tokenScopes?: string[] | null;
  /**
   * In the account by remote support access, not a membership: acts as an admin, reads only in
   * `view` mode; `membershipId` is then the grant's id.
   */
  support?: SupportAccess | null;
  /**
   * the request is an extension's own server: it manages webhooks on its boards (only to its own
   * origins, only its own webhooks) without being the board's owner.
   */
  extServer?: { installationId: string; userId: string; origins: string[] } | null;
};

/** An active support grant used by this request. */
export type SupportAccess = {
  grantId: string;
  mode: 'view' | 'edit';
  expiresAt: Date;
  /** Approved from a support ticket: its id and number go into the audit rows and the banner. */
  ticketId?: string | null;
  ticketNumber?: number | null;
};

export type RequestMeta = { ip: string | null; userAgent: string | null; requestId: string };

/**
 * Who a service acts for (every service's first argument, 06 §1.1): the request's account context and signed-in
 * user, and the request id for the activity / audit log. Routes build it with `actorOf(c)` (middleware/auth.ts); a
 * service that needs more (a session id, a token, an automation run) extends it — never re-declares it.
 */
export type Actor = {
  ctx: AccountContext;
  user: SessionUser;
  requestId?: string;
  /**
   * The request's sign-in / token: a two-factor step-up (a board's delete-with-code) reads them. Only
   * a person's request has them — the AI, agents, MCP and background runs never.
   */
  sessionId?: string | null;
  token?: TokenAuth | null;
};
/** A request authenticated by an API token (06 §1.2): bound to one account, limited to its scopes. */
export type TokenAuth = {
  id: string;
  accountId: string;
  scopes: string[];
  ratePerMinute: number;
  boardIds: string[] | null;
  /** An extension's token (D27 ת2): its installation; guests only where the admin allowed them. */
  ext?: {
    installationId: string;
    key: string;
    allowGuests: boolean;
    feature?: string;
    /** its own server (not a page) — the origins its manifest lists (where its webhooks may go). */
    server?: { origins: string[] };
  };
};

export type AppEnv = {
  Variables: {
    requestId: string;
    /** The real client address (lib/client-ip.ts, S-10); null when it cannot be told. */
    clientIp: string | null;
    user: SessionUser | null;
    /** The Better Auth session's id (cookie sign-ins only; unset for tokens). */
    sessionId?: string | null;
    token: TokenAuth | null;
    account: AccountContext;
    /** The owner console's Support section: who opened it — the platform owner or a support role. */
    supportRole?: 'owner' | 'agent' | 'lead';
    /** The database, set by `loadSession` for guards built without deps (`requirePlatformOwner`, S-77). */
    db?: Db;
  };
};
