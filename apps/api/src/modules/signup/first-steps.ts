// SPDX-License-Identifier: AGPL-3.0-only
import type { FirstStepKey, FirstSteps } from '@bines/shared';
import type { AppDeps, SessionUser } from '../../types';
import { insertPlatformAudit } from '../account-deletion/account-deletion.repo';
import { requiredLegal } from '../legal/legal.service';
import { readSettingsRow, writeSettingsRow } from '../license/license.repo';
import { offeredPlans, signupMissing } from './signup.settings';
import { loadSignupSettings } from './signup.store';

/**
 * The owner console's "first steps" card (SIGNUP plan, decision 12). Every step is read from the real settings —
 * the same checks sign-up itself runs (`signupMissing`) — so it ticks itself as the owner sets things up. Closing the
 * card is the one thing stored: the `platform_settings` row `first_steps` ({dismissed_at, dismissed_by}).
 */
export const FIRST_STEPS_ROW = 'first_steps';

type Deps = Pick<AppDeps, 'db' | 'emailEnabled'>;

export const getFirstSteps = async (deps: Deps): Promise<FirstSteps> => {
  const { db } = deps;
  const settings = await loadSignupSettings(db);
  const [legal, plans, missing, row] = await Promise.all([
    requiredLegal(db),
    offeredPlans(db),
    signupMissing(deps, settings),
    readSettingsRow(db, FIRST_STEPS_ROW),
  ]);
  const done: Record<FirstStepKey, boolean> = {
    email: deps.emailEnabled !== false,
    legal: legal.length > 0,
    plan: plans.length > 0,
    signup: settings.enabled && missing.length === 0,
  };
  return {
    steps: (Object.keys(done) as FirstStepKey[]).map((key) => ({ key, done: done[key] })),
    dismissed: typeof row?.dismissed_at === 'string',
  };
};

/** POST /platform/first-steps/dismiss: the card stays closed (logged in the platform's audit). */
export const dismissFirstSteps = async (deps: Deps, owner: SessionUser): Promise<FirstSteps> => {
  await writeSettingsRow(
    deps.db,
    FIRST_STEPS_ROW,
    { dismissed_at: new Date().toISOString(), dismissed_by: owner.id },
    owner.id,
  );
  await insertPlatformAudit(deps.db, {
    action: 'first_steps.dismissed',
    targetType: 'platform',
    targetId: FIRST_STEPS_ROW,
    actorId: owner.id,
    payload: {},
  });
  return getFirstSteps(deps);
};
