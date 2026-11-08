// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@bines/shared';
import type { AppDeps } from '../../types';
import { RateLimiter } from '../../lib/rate-limit';
import { twoFactorEnabledOf } from './two-factor.repo';

/** Five wrong codes per person in 15 minutes, then a wait (shared by every step that asks for one). */
const failures = new RateLimiter(5, 15 * 60_000);

/** Tests: forget the counted failures. */
export const resetFreshCodeFailures = () => failures.clear();

/**
 * A fresh two-factor code for one irreversible step (scheduling an account's deletion, the owner's
 * "delete now"): two-factor sign-in must be on (403 `step_up_two_factor_required` — no way around it), and the code is
 * checked like the sign-in step (Better Auth's verify-totp, on this session). Wrong → 422 `step_up_code_invalid`;
 * too many wrong ones → 429. Never with a token: the caller's route is a session's only.
 */
export const verifyFreshCode = async (
  deps: Pick<AppDeps, 'db' | 'auth'>,
  userId: string,
  code: string,
  headers: Headers,
) => {
  if (!(await twoFactorEnabledOf(deps.db, userId)))
    throw new AppError('step_up_two_factor_required', 'Turn on two-factor sign-in first');
  const wait = failures.peek(userId);
  if (wait) throw new AppError('rate_limited', 'Too many wrong codes', { retry_after: Math.ceil(wait / 1000) });
  let ok = false;
  try {
    await deps.auth.api.verifyTOTP({ body: { code }, headers });
    ok = true;
  } catch {
    ok = false;
  }
  if (!ok) {
    failures.hit(userId);
    throw new AppError('step_up_code_invalid', 'The code is not right');
  }
};
