// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * One shape for "who agreed to what, when and from where" (signatures, agreed with the legal
 * agreements work): a signed interactive document stores it whole; a platform user's acceptance of a legal
 * document maps onto it (`verified_by: 'session'`, `signer.user_id` set). Server time only, never the browser's.
 */
export const CONSENT_VERIFIED_BY = ['session', 'email_code', 'sms_code', 'none'] as const;
export type ConsentVerifiedBy = (typeof CONSENT_VERIFIED_BY)[number];

export const consentEvidenceSchema = z.object({
  /** Server time (ISO). */
  at: z.string().max(40),
  ip: z.string().max(64).nullable(),
  user_agent: z.string().max(300).nullable(),
  signer: z.object({
    name: z.string().max(200),
    email: z.string().max(320).nullable().optional(),
    role: z.string().max(200).nullable().optional(),
    user_id: z.string().max(26).nullable().optional(),
  }),
  /** How the signer's identity was checked before signing. */
  verified_by: z.enum(CONSENT_VERIFIED_BY),
  /** What was agreed to: a document of some kind, its version and (when it has one) the SHA-256 of its content. */
  document: z.object({
    kind: z.string().max(40),
    id: z.string().max(64),
    version: z.number().int(),
    sha256: z.string().max(64).nullable().optional(),
  }),
  /** Each box shown, its wording and whether it was ticked. */
  consents: z.array(z.object({ key: z.string().max(64), text: z.string().max(2000), checked: z.boolean() })).max(20),
});
export type ConsentEvidence = z.infer<typeof consentEvidenceSchema>;
