// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { secretSettingsSchema } from '../columns/defs/secret';

/**
 * Secret updates: an update or reply on an item / subitem whose text is encrypted like a secret
 * column's value — the thread shows only a locked card; the text comes back once, after a fresh two-factor code, for
 * a few seconds. The same engine as secret columns (modules/secrets): the account's data key, the reveal grant,
 * the audit `secret.*` and the admins' alert. Everything here is a setting (UI), never fixed in code:
 * - the account's default (Administration → Security → Secret updates);
 * - an optional override per board (its subitems follow it); null = the account's.
 * The fields are a secret column's (who reveals, seconds, minutes, copy, a code before edit / delete, the alert) plus
 * `enabled` (whether people may write secret updates there at all; existing ones stay readable).
 */
export const secretUpdateSettingsSchema = secretSettingsSchema
  .omit({ multiline: true, kind: true, checkbox_visible: true })
  .extend({
    enabled: z.boolean().default(true),
  });
export type SecretUpdateSettings = z.infer<typeof secretUpdateSettingsSchema>;

/** Stored settings with every default filled in (missing, old or partial included). */
export const secretUpdateSettingsOf = (settings: unknown): SecretUpdateSettings => {
  const parsed = secretUpdateSettingsSchema.safeParse(settings ?? {});
  return parsed.success ? parsed.data : secretUpdateSettingsSchema.parse({});
};

/** GET /boards/{id}/secret-updates: what counts on this board, and where it comes from. */
export const boardSecretUpdatesSchema = z.object({
  /** What applies here (the board's override, else the account's). */
  effective: secretUpdateSettingsSchema,
  /** The account's default. */
  account: secretUpdateSettingsSchema,
  /** This board's own override, or null (the account's applies). A subitems board answers its parent's. */
  board: secretUpdateSettingsSchema.nullable(),
  /** The viewer may change the board's override (board owners and admins). */
  can_manage: z.boolean(),
});
export type BoardSecretUpdates = z.infer<typeof boardSecretUpdatesSchema>;

/** PUT /boards/{id}/secret-updates: the board's override; null = back to the account's. */
export const putBoardSecretUpdatesSchema = z.object({ settings: secretUpdateSettingsSchema.nullable() });

/** GET / PUT /secrets/update-settings (admins): the account's default. */
export const accountSecretUpdatesSchema = z.object({ settings: secretUpdateSettingsSchema });

/** POST /updates/{id}/reveal: the update's text, once (never cached), with how long the app shows it. */
export const secretUpdateRevealSchema = z.object({
  body_html: z.string(),
  body_text: z.string(),
  /** The editor document (to edit it), or null for plain text. */
  body_json: z.record(z.string(), z.unknown()).nullable(),
  reveal_seconds: z.number().int(),
  copy_allowed: z.boolean(),
});
export type SecretUpdateReveal = z.infer<typeof secretUpdateRevealSchema>;
