// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Custom senders need the platform owner's approval (S-46 — an account must not send as someone else): the email
 * sender name, the Reply-To and the SMS sender id an account admin sets wait as a request until the owner approves
 * or rejects it (owner console → Platform settings → "sender names require approval", on by default). Meanwhile the
 * account keeps sending as before (its approved value, else the default: the account's name / the platform's SMS
 * sender). The account's own name as the sender never needs approval; clearing a value never does either.
 */
export const SENDER_KINDS = ['email_sender_name', 'email_reply_to', 'sms_sender_id'] as const;
export type SenderKind = (typeof SENDER_KINDS)[number];
export const SENDER_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type SenderRequestStatus = (typeof SENDER_REQUEST_STATUSES)[number];

/** May this value be used without the owner's approval? Only the account's own name (sender name / SMS sender). */
export const senderValueExempt = (kind: SenderKind, value: string, accountName: string) =>
  kind !== 'email_reply_to' && value.trim().toLowerCase() === accountName.trim().toLowerCase();

export const senderRequestSchema = z
  .object({
    id: z.string(),
    account_id: z.string(),
    /** Owner console only: the account's name. */
    account_name: z.string().nullable().optional(),
    kind: z.enum(SENDER_KINDS),
    value: z.string(),
    status: z.enum(SENDER_REQUEST_STATUSES),
    /** The owner's reason (a rejection always has one). */
    reason: z.string().nullable(),
    requested_by_name: z.string().nullable(),
    decided_by_name: z.string().nullable(),
    created_at: z.string(),
    decided_at: z.string().nullable(),
  })
  .meta({ id: 'SenderRequest' });
export type SenderRequest = z.infer<typeof senderRequestSchema>;

/** GET /accounts/me/sender-requests: whether approval is required, and the latest request of each kind. */
export const accountSenderStatusSchema = z
  .object({
    require_approval: z.boolean(),
    data: z.array(senderRequestSchema),
  })
  .meta({ id: 'AccountSenderStatus' });
export type AccountSenderStatus = z.infer<typeof accountSenderStatusSchema>;

export const senderRequestsQuerySchema = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
});

export const approveSenderRequestSchema = z.object({ reason: z.string().trim().max(500).optional() });
export const rejectSenderRequestSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export type RejectSenderRequest = z.infer<typeof rejectSenderRequestSchema>;
