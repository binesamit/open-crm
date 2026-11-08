// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type SecretSettings, secretSettingsOf } from '@bines/shared';
import type { Db } from '../../db/client';
import type { AccountContext, RequestMeta, SessionUser, TokenAuth } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import { twoFactorEnabledOf } from '../admin/two-factor.repo';
import { cachedSecurity } from '../admin/two-factor.service';
import { findGrant } from './secrets.repo';

/**
 * Who asks for a secret step-up. A person's session carries `sessionId`; a personal API token carries `token`. Every
 * other caller (the AI assistant, agents, MCP, automations) has neither and can never pass the step-up.
 */
export type StepUpActor = {
  ctx: AccountContext;
  user: Pick<SessionUser, 'id'>;
  sessionId?: string | null;
  token?: TokenAuth | null;
};

/**
 * The two-factor step-up of a reveal, a copy, a replace / clear (with `change_requires_code`) and any change to a
 * secret column's settings: 2FA on, and a fresh code in this session within the column's `verify_minutes` — or an
 * API token with the explicit `secrets:read` scope. Someone without 2FA can never pass it.
 */
export const assertFreshCode = async (db: Db, a: StepUpActor, settings: Pick<SecretSettings, 'verify_minutes'>) => {
  if (!(await twoFactorEnabledOf(db, a.user.id))) throw new AppError('secret_two_factor_required');
  if (a.token) {
    // Tokens are not interactive: the explicit scope stands in for the code (an extension's token never).
    if (a.token.ext || !a.token.scopes.includes('secrets:read'))
      throw new AppError('insufficient_scope', 'This token lacks the "secrets:read" scope', {
        required: 'secrets:read',
      });
    return;
  }
  const minutes = await verifyMinutesOf(db, a.ctx.accountId, settings.verify_minutes);
  const grant = a.sessionId ? await findGrant(db, a.user.id, a.sessionId) : undefined;
  if (!grant || Date.now() - grant.verifiedAt.getTime() > minutes * 60_000)
    throw new AppError('secret_step_up_required', 'A fresh two-factor code is needed', { verify_minutes: minutes });
};

/**
 * how long a fresh code counts — the column's / board's own window, never longer than the account's
 * ceiling (security settings, `secret_max_verify_minutes`, 12 hours unless an admin lowered it).
 */
export const verifyMinutesOf = async (db: Db, accountId: string, own: number) =>
  Math.min(own, (await cachedSecurity(db, accountId)).secret_max_verify_minutes);

/** Setting keys whose value differs (every default filled in on both sides). */
export const changedSecretSettings = (before: unknown, after: unknown): string[] => {
  const a = secretSettingsOf(before) as Record<string, unknown>;
  const b = secretSettingsOf(after) as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  );
};

/**
 * a secret column's settings (who reveals, the code before a replace, copy, times, alerts) guard its
 * values — so changing any of them takes the same fresh two-factor code as a reveal, on top of the column rights
 * (`column.update`). Checked against the stored settings (a new `verify_minutes` never shortens its own check).
 * Renaming, the description and the width are not settings and need no code. Support access never changes them.
 */
export const assertMayChangeSecretSettings = async (db: Db, a: StepUpActor, storedSettings: unknown) => {
  if (a.ctx.support) throw new AppError('forbidden', 'secret_not_for_support');
  await assertFreshCode(db, a, secretSettingsOf(storedSettings));
};

/** The admins' secret log (`secret.settings`): who changed which secret column's settings, and which keys. */
export const auditSecretSettings = (
  db: Db,
  a: StepUpActor & { meta?: RequestMeta },
  column: { id: string; key: string; title: string; boardId: string },
  changed: string[],
) =>
  recordAudit(db, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action: 'secret.settings',
    targetType: 'user',
    targetId: a.user.id,
    payload: {
      board_id: column.boardId,
      column_id: column.id,
      column_key: column.key,
      column_title: column.title,
      via: a.token ? 'token' : 'session',
      changed,
    },
    ip: a.meta?.ip ?? null,
    userAgent: a.meta?.userAgent ?? null,
  });
