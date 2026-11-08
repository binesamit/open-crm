// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type SignupMissing,
  type SignupSettings,
  type SignupSettingsResponse,
  signupSettingsSchema,
  type UpdateSignupSettings,
  TRIAL_EMAIL_KINDS,
  type TrialEmails,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { AppDeps, SessionUser } from '../../types';
import { insertPlatformAudit } from '../account-deletion/account-deletion.repo';
import { listPublicPlans } from '../billing/plans.service';
import { platformCaptchaAnyKeys } from '../captcha/captcha.service';
import { resolveStarterKit } from '../extensions/packs';
import { requiredLegal } from '../legal/legal.service';
import { loadSignupSettings, saveSignupSettings, SIGNUP_ROW } from './signup.store';

type ReadyDeps = Pick<AppDeps, 'db' | 'emailEnabled'>;

/** The default plan when it is offered (public, not archived, with a current version), else null. */
export const offeredPlans = async (db: Db) => (await listPublicPlans(db)).data;

/**
 * What still stands between the switch and sign-up working (SIGNUP_MISSING, in its order). Read when the owner turns
 * it on (refused while anything is missing), on the console card, and on every public call — a key removed or email
 * turned off later closes sign-up at once ("not available right now") without touching the switch.
 */
export const signupMissing = async (deps: ReadyDeps, s: SignupSettings): Promise<SignupMissing[]> => {
  const { db } = deps;
  const missing: SignupMissing[] = [];
  if (deps.emailEnabled === false) missing.push('email');
  if (s.require_captcha && !(await platformCaptchaAnyKeys(db))) missing.push('captcha');
  const plans = await offeredPlans(db);
  // A plan is for new accounts; `domain_join` only lets people into existing ones (ה7).
  if (s.mode === 'open' && (!s.default_plan_id || !plans.some((p) => p.id === s.default_plan_id)))
    missing.push('default_plan');
  if (!s.methods.length) missing.push('methods');
  if (!(await requiredLegal(db)).length) missing.push('legal');
  return missing;
};

export const signupSettingsDto = async (deps: ReadyDeps, s: SignupSettings): Promise<SignupSettingsResponse> => {
  const missing = await signupMissing(deps, s);
  return { settings: s, ready: missing.length === 0, missing, open: s.enabled && missing.length === 0 };
};

/** GET /platform/signup-settings (platform owner). */
export const getSignupSettings = async (deps: ReadyDeps) => signupSettingsDto(deps, await loadSignupSettings(deps.db));

const uniq = (list: string[]) => [...new Set(list)];

/**
 * PATCH /platform/signup-settings (platform owner): only what is sent changes. Turning the switch on while anything
 * is missing is refused (422 `signup_not_ready`, details.missing); turning it off always works. Logged in the
 * platform's audit with the fields that moved.
 */
/** The trial emails patched field by field (an email's texts per language too): what is not sent stays. */
const mergeTrialEmails = (current: TrialEmails, patch: NonNullable<UpdateSignupSettings['emails']>): TrialEmails => {
  const out = { ...current };
  for (const kind of TRIAL_EMAIL_KINDS) {
    const p = patch[kind];
    if (!p) continue;
    const cur = current[kind];
    out[kind] = {
      ...cur,
      ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
      ...(p.days !== undefined && cur.days !== null ? { days: p.days } : {}),
      he: { ...cur.he, ...p.he },
      en: { ...cur.en, ...p.en },
    } as never;
  }
  return out;
};

export const updateSignupSettings = async (
  deps: ReadyDeps & Pick<AppDeps, 'logger'>,
  owner: SessionUser,
  patch: UpdateSignupSettings,
) => {
  const current = await loadSignupSettings(deps.db);
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next = signupSettingsSchema.parse({
    ...current,
    ...defined,
    ...(patch.methods ? { methods: uniq(patch.methods) } : {}),
    ...(patch.disposable_domains ? { disposable_domains: uniq(patch.disposable_domains) } : {}),
    ...(patch.domain_allow ? { domain_allow: uniq(patch.domain_allow) } : {}),
    ...(patch.domain_block ? { domain_block: uniq(patch.domain_block) } : {}),
    ...(patch.emails ? { emails: mergeTrialEmails(current.emails, patch.emails) } : {}),
    ...(patch.onboarding ? { onboarding: { ...current.onboarding, ...patch.onboarding } } : {}),
  });
  // An unknown kit is refused here (422 unknown_starter_kit), not when the first person signs up.
  if (patch.starter_kit) await resolveStarterKit(deps.db, patch.starter_kit);
  if (next.enabled) {
    const missing = await signupMissing(deps, next);
    if (missing.length) throw new AppError('signup_not_ready', 'Self sign-up cannot be turned on yet', { missing });
  }
  await saveSignupSettings(deps.db, owner.id, next);
  const fields = Object.keys(defined);
  await insertPlatformAudit(deps.db, {
    action: 'signup.settings_changed',
    targetType: 'platform',
    targetId: SIGNUP_ROW,
    actorId: owner.id,
    payload: { fields, enabled: next.enabled },
  });
  deps.logger.info({ owner: owner.id, fields }, 'signup settings updated');
  return signupSettingsDto(deps, next);
};
