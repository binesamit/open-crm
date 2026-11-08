// SPDX-License-Identifier: AGPL-3.0-only
import { DEFAULT_STARTER, newId, templateSetSchema, type TemplateSet } from '@bines/shared';
import type { Db } from './client';
import {
  countAllAccounts,
  findMembership,
  findOldestLiveAccount,
  type AccountRow,
} from '../modules/accounts/accounts.repo';
import { provisionAccount } from '../modules/accounts/accounts.service';
import { repairTemplateColumns, seedBuiltinTemplates } from '../modules/boards/templates';
import { packsDir, seedCatalogPacks } from '../modules/extensions/packs';
import {
  findPendingInvitationForAccountEmail,
  insertInvitation,
  rotateInvitationToken,
} from '../modules/invitations/invitations.repo';
import { invitationUrl } from '../modules/invitations/invitations.service';
import { findUserIdByEmail } from '../modules/users/users.repo';
import { newSecretToken, sha256 } from '../lib/tokens';

/** The first account, made only on an empty system. Everything after that is done in the owner console. */
export type FirstAccount = { name: string; slug: string; templateSet: TemplateSet };

/** `SEED_ACCOUNT_NAME` / `SEED_ACCOUNT_SLUG` / `SEED_TEMPLATE_SET` — read once, at first boot only. */
export const firstAccountFromEnv = (source: NodeJS.ProcessEnv = process.env): FirstAccount => ({
  name: source.SEED_ACCOUNT_NAME?.trim() || 'Main',
  slug: source.SEED_ACCOUNT_SLUG?.trim().toLowerCase() || 'main',
  // The starter kit (D27 ת1): a catalog pack key, `empty`, or the catalog's default kit.
  templateSet: templateSetSchema.parse(source.SEED_TEMPLATE_SET?.trim() || DEFAULT_STARTER),
});

export type BootstrapResult = {
  templates: number;
  account: AccountRow | null;
  createdAccount: boolean;
  invitedOwner: boolean;
  repairedColumns: number;
};

/**
 * Idempotent bootstrap (`pnpm db:seed`, and on every deploy after migrate):
 * 1. upsert the built-in board templates (global, by key);
 * 2. on an empty system only (no account at all, deleted ones included) create the first account with its kit.
 *    It is never looked up by slug or name: renaming it in the owner console must not make the next deploy
 *    create a second one (ANSWERS §6 א.1). Afterwards "the first account" = the oldest account still alive;
 * 3. a pending admin invitation to that account for the platform owner, unless they are already a member there
 *    or already invited. No email is sent; it is accepted from the account picker.
 */
export const bootstrap = async (
  db: Db,
  opts: { ownerEmail: string; templatesDir: string; firstAccount: FirstAccount; packsDir?: string | null },
): Promise<BootstrapResult> => {
  const { templates, repairedColumns } = await seedCatalog(db, opts);
  return { templates, repairedColumns, ...(await ensureFirstAccount(db, opts)) };
};

/** Steps 1 (and the template column repair): the built-in templates and the catalog packs, upserted by key. */
export const seedCatalog = async (db: Db, opts: { templatesDir: string; packsDir?: string | null }) => {
  const templates = await seedBuiltinTemplates(db, opts.templatesDir);
  // The extensions catalog's data packs (D27 ת1) — starter kits among them — upserted by key like the templates.
  await seedCatalogPacks(db, opts.packsDir ?? packsDir());
  const repairedColumns = await repairTemplateColumns(db);
  return { templates, repairedColumns };
};

/**
 * Steps 2 and 3: the first account on an empty system, and the owner's pending admin invitation to it. Also the
 * first-run setup's (modules/setup), which then takes that invitation with the password the owner chose.
 */
export const ensureFirstAccount = async (db: Db, opts: { ownerEmail: string; firstAccount: FirstAccount }) => {
  let account: AccountRow | undefined;
  let createdAccount = false;
  if ((await countAllAccounts(db)) === 0) {
    account = await db.transaction((tx) => provisionAccount(tx, { ...opts.firstAccount, createdBy: null }));
    createdAccount = true;
  } else {
    account = await findOldestLiveAccount(db);
  }
  let invitedOwner = false;
  // Every account deleted: nothing to invite to — and nothing is re-created behind the owner's back.
  if (account) {
    const ownerEmail = opts.ownerEmail.toLowerCase();
    const ownerId = await findUserIdByEmail(db, ownerEmail);
    const isMember = ownerId ? !!(await findMembership(db, account.id, ownerId)) : false;
    if (!isMember && !(await findPendingInvitationForAccountEmail(db, account.id, ownerEmail))) {
      await insertInvitation(db, {
        id: newId(),
        accountId: account.id,
        email: ownerEmail,
        role: 'admin',
        // The first admin (S-51, support.access ownerMayJoin): taken only while the account has nobody in it.
        payload: { first_admin: true },
        tokenHash: sha256(newSecretToken()), // accepted from the account picker by verified email, not by link
        expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      });
      invitedOwner = true;
    }
  }
  return { account: account ?? null, createdAccount, invitedOwner };
};

export type FirstAdminLink =
  | { status: 'link'; url: string; accountSlug: string }
  | { status: 'member'; accountSlug: string }
  | { status: 'no_account' }
  | { status: 'no_invitation' };

const FIRST_ADMIN_LINK_DAYS = 7;

/**
 * Self-hosting without email (open-source ק3): the platform owner's first way in. Gives the pending admin invitation
 * of the first account (made by `bootstrap`) a fresh link — `/invite/<token>`, where they set a password — and
 * returns it for the operator's terminal (`node dist/first-admin-link.js`). Any earlier link of that invitation stops
 * working. Nothing is made when the owner is already a member (they sign in as usual) or when there is no invitation.
 */
export const firstAdminLink = async (db: Db, opts: { ownerEmail: string; origin: string }): Promise<FirstAdminLink> => {
  const account = await findOldestLiveAccount(db);
  if (!account) return { status: 'no_account' };
  const ownerEmail = opts.ownerEmail.toLowerCase();
  const ownerId = await findUserIdByEmail(db, ownerEmail);
  if (ownerId && (await findMembership(db, account.id, ownerId)))
    return { status: 'member', accountSlug: account.slug };
  const invitation = await findPendingInvitationForAccountEmail(db, account.id, ownerEmail);
  if (!invitation) return { status: 'no_invitation' };
  const token = newSecretToken();
  await rotateInvitationToken(
    db,
    invitation.id,
    sha256(token),
    new Date(Date.now() + FIRST_ADMIN_LINK_DAYS * 24 * 60 * 60 * 1000),
  );
  return { status: 'link', url: invitationUrl(opts.origin.replace(/\/+$/, ''), token), accountSlug: account.slug };
};
