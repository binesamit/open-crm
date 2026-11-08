// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { updateViewDeviceSchema } from './updates';

/**
 * r18boardviews: who opened a board and how long ago — the board's "seen by".
 * One entry per person; opening the board again within BOARD_VIEW_THROTTLE_MS changes nothing.
 */
export const BOARD_VIEW_THROTTLE_MS = 5 * 60_000;
/** The header shows this many faces; the rest are "+N". */
export const BOARD_VIEWERS_FACES = 3;
export const BOARD_VIEWERS_PAGE = 50;

export const boardViewerSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Short-lived link to the profile photo, or null (the app then shows initials). */
  avatar_url: z.string().nullable(),
  /** When they last opened the board (moves at most once per BOARD_VIEW_THROTTLE_MS). */
  last_viewed_at: z.string(),
  first_viewed_at: z.string(),
  /** How many times they opened it (opens closer than BOARD_VIEW_THROTTLE_MS count once). */
  view_count: z.number().int(),
  /** The device of the latest open, from the request headers. */
  device: updateViewDeviceSchema,
  /** "Chrome · Windows" — browser and OS only, '' when unknown. */
  user_agent: z.string(),
});
export type BoardViewer = z.infer<typeof boardViewerSchema>;

export const boardViewersQuerySchema = z.object({
  /** Page size (default BOARD_VIEWERS_PAGE). */
  limit: z.coerce.number().int().min(1).max(100).optional(),
  /** `next_cursor` of the previous page. */
  cursor: z.string().max(64).optional(),
});

export const boardViewersSchema = z.object({
  data: z.array(boardViewerSchema),
  /** Everyone who viewed the board (that this reader may see). */
  total: z.number().int(),
  next_cursor: z.string().nullable(),
  /** false when the account turned "show who viewed boards" off — then nothing is recorded or listed. */
  enabled: z.boolean(),
  /** "recent" = opened in the last this-many hours (the account's setting, 24 by default). */
  recent_hours: z.number().int(),
  /** How many of `total` opened the board within `recent_hours` (the header's faces and count). */
  recent_total: z.number().int(),
});
export type BoardViewers = z.infer<typeof boardViewersSchema>;

export const markBoardViewResultSchema = z.object({
  ok: z.literal(true),
  /** false when the open was inside the throttle window or the account turned the list off. */
  recorded: z.boolean(),
});
