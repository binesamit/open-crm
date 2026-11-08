// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type ExtIntrospection } from '@bines/shared';
import type { AppDeps, AppEnv } from '../../types';
import { verifyExtToken } from './ext-token';
import { userBasics } from './extensions.repo';

/**
 * who a page token belongs to, for the installation's own server — so a member's own page (e.g.
 * "connect my calendar") can hand its token to the server, and the server links what it does to that member.
 * Only a server token may ask, and only about tokens of its own installation (anything else reads as inactive).
 */
export const introspectExtToken = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  asker: AppEnv['Variables']['token'],
  raw: string,
): Promise<ExtIntrospection> => {
  if (!asker?.id.startsWith('extsrv:') || !asker.ext) throw new AppError('forbidden', 'extension_server_only');
  const claims = verifyExtToken(deps.env, raw);
  // An automation's run token (`r`) is the automation owner's, not someone on a page.
  if (!claims || claims.i !== asker.ext.installationId || claims.a !== asker.accountId || claims.r)
    return { active: false };
  const user = await userBasics(deps.db, claims.u);
  if (!user || user.isService) return { active: false };
  return {
    active: true,
    user: { id: user.id, name: user.name, email: user.email },
    account_id: claims.a,
    feature: claims.f,
    expires_at: new Date(claims.e * 1000).toISOString(),
  };
};
