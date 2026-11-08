// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * The person's own erasure request (privacy — GDPR art. 17; Israel Privacy Law §14). In an account the
 * request is recorded and the account's admins carry it out ("deactivate → delete details"); with no account the
 * details are deleted at once.
 */
export const erasureRequestBodySchema = z.object({
  /** The person's own email address, typed again — a deliberate act, not a mis-click. */
  confirm_email: z.string().trim().min(1).max(320),
});
export type ErasureRequestBody = z.infer<typeof erasureRequestBodySchema>;

export const erasureRequestResultSchema = z.object({
  /** `requested` = recorded in each account, admins told; `erased` = no account held the person, details deleted. */
  status: z.enum(['requested', 'erased']),
  accounts: z.array(z.string()),
});
export type ErasureRequestResult = z.infer<typeof erasureRequestResultSchema>;

export const myErasureRequestSchema = z.object({
  pending: z.boolean(),
  /** The accounts the request is pending in. */
  accounts: z.array(z.string()),
  /** Whether the person belongs to any account (no account = asking erases at once). */
  has_accounts: z.boolean(),
});
export type MyErasureRequest = z.infer<typeof myErasureRequestSchema>;
