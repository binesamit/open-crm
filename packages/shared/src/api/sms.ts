// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { SMS_MAX_LENGTH, SMS_SEND_POLICIES, smsTemplateSchema } from '../account/settings';
import { updateEntrySchema } from './updates';

/**
 * SMS from an item: the number of a phone column, through the account's SMS provider (TextMe
 * Israeli mobiles only), logged as an update on the item (source `sms`).
 */

/** POST /items/{id}/sms — `template_id` (one of the account's templates, filled from the item) or `text` (as is). */
export const sendItemSmsSchema = z
  .object({
    /** The phone column (its key) whose number gets the message. */
    column_id: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    template_id: z.string().max(40).optional(),
    text: z.string().trim().min(1).max(SMS_MAX_LENGTH).optional(),
    /** Only resolve the number and the text (template filled in), send nothing. */
    dry_run: z.boolean().optional(),
  })
  .refine((b) => !!b.template_id !== !!b.text, { message: 'template_or_text', path: ['text'] });
export type SendItemSms = z.infer<typeof sendItemSmsSchema>;

export const sendItemSmsResultSchema = z.object({
  /** false on a dry run. */
  sent: z.boolean(),
  /** The number it goes to, E.164. */
  to: z.string(),
  /** The message as sent (a template filled in). */
  text: z.string(),
  /** How many SMS parts the text takes (what it costs). */
  segments: z.number().int(),
  provider_message_id: z.string().nullable(),
  /** The update logged on the item; null on a dry run. */
  update: updateEntrySchema.nullable(),
});
export type SendItemSmsResult = z.infer<typeof sendItemSmsResultSchema>;

/** Why this person may not send SMS now (null = they may). */
export const SMS_DENIED_REASONS = ['guest', 'disabled', 'admins_only', 'members_only', 'not_configured'] as const;
export type SmsDeniedReason = (typeof SMS_DENIED_REASONS)[number];

/** GET /sms/status — what the SMS dialog needs: may I send, the account's templates, budgets and usage. */
export const smsStatusSchema = z.object({
  can_send: z.boolean(),
  reason: z.enum(SMS_DENIED_REASONS).nullable(),
  /** Provider keys and a sender id are set (else every send fails with `sms_not_configured`). */
  provider_ready: z.boolean(),
  send_policy: z.enum(SMS_SEND_POLICIES),
  templates: z.array(smsTemplateSchema),
  limits: z.object({ per_user_per_hour: z.number().int(), per_account_per_day: z.number().int() }),
  usage: z.object({ user_last_hour: z.number().int(), account_last_day: z.number().int() }),
  max_length: z.number().int(),
  /** The account's country (`locale.country`) — the last fallback for numbers without a country code. */
  account_country: z.string(),
});
export type SmsStatus = z.infer<typeof smsStatusSchema>;

// GSM 03.38 basic set + the extension table (each extension character counts as two).
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXT = '^{}\\[~]|€\f';

/**
 * SMS parts a text takes: GSM-7 texts 160 per part (153 when split), anything else (Hebrew, emoji) is UCS-2 —
 * 70 per part (67 when split). 0 for an empty text.
 */
export const smsSegments = (text: string): number => {
  if (!text) return 0;
  let gsm = true;
  let units = 0;
  for (const ch of text) {
    if (GSM_BASIC.includes(ch)) units += 1;
    else if (GSM_EXT.includes(ch)) units += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (!gsm) {
    // UTF-16 code units (an emoji takes two).
    units = text.length;
    return units <= 70 ? 1 : Math.ceil(units / 67);
  }
  return units <= 160 ? 1 : Math.ceil(units / 153);
};
