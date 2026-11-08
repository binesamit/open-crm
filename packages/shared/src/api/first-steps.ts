// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * The owner console's "first steps" card (SIGNUP plan, decision 12): what a new installation still needs before it
 * can bring people in — each step done or not, read from the real settings (nothing is ticked by hand). The card
 * disappears once every step is done or when the platform owner closes it (`platform_settings` row `first_steps`).
 * - `email`: outbound email (SMTP / Resend) is configured;
 * - `legal`: a published legal document asks for consent (terms, privacy);
 * - `plan`: a public plan is offered (not archived, with a current version);
 * - `signup`: self sign-up is switched on and ready.
 */
export const FIRST_STEP_KEYS = ['email', 'legal', 'plan', 'signup'] as const;
export type FirstStepKey = (typeof FIRST_STEP_KEYS)[number];

/** GET /platform/first-steps · POST /platform/first-steps/dismiss. */
export const firstStepsSchema = z
  .object({
    steps: z.array(z.object({ key: z.enum(FIRST_STEP_KEYS), done: z.boolean() })),
    /** The platform owner closed the card. */
    dismissed: z.boolean(),
  })
  .meta({ id: 'FirstSteps' });
export type FirstSteps = z.infer<typeof firstStepsSchema>;
