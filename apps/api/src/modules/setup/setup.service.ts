// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, normalizeOrigin, type SetupOwner } from '@bines/shared';
import { INVITE_TOKEN_HEADER } from '../../auth/auth';
import { platformPasswordMin } from '../../auth/password-policy';
import { ensureFirstAccount, firstAccountFromEnv } from '../../db/bootstrap';
import { RESOLVED_IP_HEADER } from '../../lib/client-ip';
import { newSecretToken, sha256 } from '../../lib/tokens';
import type { AppDeps, RequestMeta, SessionUser } from '../../types';
import { findPendingInvitationForAccountEmail, rotateInvitationToken } from '../invitations/invitations.repo';
import { acceptInvitationByToken } from '../invitations/invitations.service';
import { updatePlatformSettings } from '../platform/platform-settings';
import { publicAddress } from '../platform/public-address';
import { findUserById, markPlatformOwner, updateUserProfile } from '../users/users.repo';
import { anyUserExists, claimSetup, finishSetup, releaseSetup } from './setup.repo';

/**
 * First-run setup (one-minute install: `docker run`, open the address, create the owner). Open only while the
 * installation has no user at all; one request wins (setup.repo `claimSetup`), every later one gets 409 setup_done.
 * Nothing new is trusted: the owner is created by the same doors as any first admin — the first account and its
 * admin invitation (db/bootstrap), a password sign-up with that invitation's token (Better Auth, the password rules),
 * then the invitation is accepted. The response carries the new session cookie.
 *
 * When SEED_ADMIN_EMAIL is set the installation already named its owner: only that address may be used here.
 */

/** Once someone exists, the answer never changes again — no query per sign-in screen after that. */
const done = new WeakSet<object>();

export const setupRequired = async (deps: Pick<AppDeps, 'db'>) => {
  if (done.has(deps.db)) return false;
  if (await anyUserExists(deps.db)) {
    done.add(deps.db);
    return false;
  }
  return true;
};

export const setupStatus = async (deps: Pick<AppDeps, 'db' | 'emailEnabled'>) => ({
  required: await setupRequired(deps),
  email_enabled: deps.emailEnabled !== false,
  password_min_length: await platformPasswordMin(deps.db),
});

/**
 * The address the owner opened the setup at, when the install did not name one (AUTO_PUBLIC_ADDRESS, standalone mode
 * without WEB_ORIGIN): only a same-origin request counts (its Origin is the host it was sent to).
 */
const openedAt = (where: { origin?: string; host?: string }) => {
  const origin = where.origin ? normalizeOrigin(where.origin) : null;
  return origin && where.host && new URL(origin).host === where.host.toLowerCase() ? origin : null;
};

export const createOwner = async (
  deps: AppDeps,
  input: SetupOwner,
  meta: RequestMeta,
  where: { origin?: string; host?: string } = {},
) => {
  const email = input.email.trim().toLowerCase();
  const configured = deps.env.SEED_ADMIN_EMAIL?.toLowerCase();
  if (!(await setupRequired(deps))) throw new AppError('setup_done', 'setup_done');
  if (configured && configured !== email) throw new AppError('forbidden', 'setup_email_mismatch');
  const min = await platformPasswordMin(deps.db);
  if (input.password.length < min) throw new AppError('invalid_value', 'password_min_length', { min_length: min });

  if (!(await claimSetup(deps.db, email))) throw new AppError('setup_done', 'setup_done');
  let userId: string | undefined;
  try {
    // A request that lost the race between the check above and the claim: the claim is single, the check is not.
    if (await anyUserExists(deps.db)) throw new AppError('setup_done', 'setup_done');
    const { account } = await ensureFirstAccount(deps.db, { ownerEmail: email, firstAccount: firstAccountFromEnv() });
    if (!account) throw new AppError('conflict', 'no_account');
    const invitation = await findPendingInvitationForAccountEmail(deps.db, account.id, email);
    if (!invitation) throw new AppError('conflict', 'no_invitation');
    // The invitation gets a token only this request knows, valid a few minutes.
    const token = newSecretToken();
    await rotateInvitationToken(deps.db, invitation.id, sha256(token), new Date(Date.now() + 10 * 60 * 1000));

    const headers = new Headers({ [INVITE_TOKEN_HEADER]: token });
    if (meta.ip) headers.set(RESOLVED_IP_HEADER, meta.ip);
    if (meta.userAgent) headers.set('user-agent', meta.userAgent);
    const signUp = await deps.auth.api.signUpEmail({
      body: { email, password: input.password, name: input.name },
      headers,
      asResponse: true,
    });
    if (!signUp.ok) {
      const body = (await signUp.json().catch(() => ({}))) as { code?: string; message?: string };
      if (body.code === 'PASSWORD_TOO_SHORT' || body.message === 'password_min_length')
        throw new AppError('invalid_value', 'password_min_length', { min_length: min });
      throw new AppError('bad_request', 'setup_failed');
    }
    const user = (await signUp.clone().json()) as { user?: { id?: string } };
    userId = user.user?.id;
    const row = userId ? await findUserById(deps.db, userId) : undefined;
    if (!row) throw new AppError('bad_request', 'setup_failed');

    await markPlatformOwner(deps.db, row.id);
    if (input.locale) await updateUserProfile(deps.db, row.id, { locale: input.locale });
    const owner: SessionUser = {
      id: row.id,
      email: row.email,
      name: row.name,
      emailVerified: true,
      isPlatformOwner: true,
      locale: input.locale ?? row.locale ?? 'he',
      timezone: row.timezone ?? null,
    };
    const joined = await acceptInvitationByToken(deps.db, owner, token, meta);
    // White-label name, and the address links are built on (only when the install left it to the setup).
    const address = deps.env.AUTO_PUBLIC_ADDRESS ? openedAt(where) : null;
    const moveAddress = !!address && address !== (await publicAddress(deps)).web;
    if (input.product_name || moveAddress)
      await updatePlatformSettings(deps, owner, {
        ...(input.product_name ? { product_name: input.product_name } : {}),
        ...(moveAddress ? { public_address: { web_origin: address } } : {}),
      });
    await finishSetup(deps.db, row.id);
    deps.logger.info({ user: row.id, account: joined.id }, 'first-run setup: owner account created');
    return { cookies: signUp.headers.getSetCookie(), account: joined };
  } catch (err) {
    // Nobody was created: the setup is free again. Once a user exists it stays closed whatever failed after.
    if (!userId && !(await anyUserExists(deps.db))) await releaseSetup(deps.db);
    throw err;
  }
};
