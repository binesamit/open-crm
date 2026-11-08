// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { updateSeenSchema } from './updates';

/**
 * Search everything (07 §9.1, 01 §6) and the Inbox (07 §9.3). Search is trigram `ILIKE` over item names, cell
 * text, update text, board names and people; every hit is filtered by board access and item visibility.
 */
export const SEARCH_MIN = 2;
/** Hits per kind in the palette. */
export const SEARCH_LIMIT = 8;
/** Recent searches kept per user and account (on the server, so they follow me between devices). */
export const SEARCH_RECENT_MAX = 8;
export const searchRecentSchema = z.object({ data: z.array(z.string()) }).meta({ id: 'SearchRecent' });
export const addSearchRecentSchema = z.object({ q: z.string().trim().min(1).max(200) });
/** The Inbox goes back this far (07 §9.3). */
export const INBOX_MONTHS = 6;

const boardRef = z.object({ id: z.string(), name: z.string() });

export const searchResultSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        /** The board to open it on (the parent board for a subitem, D14). */
        board: boardRef,
        group: z.object({ title: z.string(), color: z.string() }).nullable(),
        /** Where the text matched when it was not the name: the cell's text. */
        matched: z.string().nullable(),
        /** Only with "include archive": the item is archived. */
        archived: z.boolean(),
      }),
    ),
    boards: z.array(boardRef.extend({ workspace: z.string().nullable() })),
    updates: z.array(
      z.object({
        id: z.string(),
        item: z.object({ id: z.string(), name: z.string() }),
        board: boardRef,
        author: z.string().nullable(),
        excerpt: z.string(),
        created_at: z.string(),
      }),
    ),
    people: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() })),
    /** Account tags (03 §3.1); `#name` searches items by tag only. Not for guests. */
    tags: z.array(z.object({ id: z.string(), name: z.string(), color: z.string() })),
    /** Files by name: in a file column or attached to an update, on items I may see. */
    files: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        item: z.object({ id: z.string(), name: z.string() }),
        board: boardRef,
        /** Attached to an update (opens the item's updates). */
        in_update: z.boolean(),
      }),
    ),
    /** Docs (M8) by name or text, that I may open; `excerpt` = the text around the match when the name did not. */
    docs: z.array(
      z.object({ id: z.string(), name: z.string(), workspace: z.string().nullable(), excerpt: z.string().nullable() }),
    ),
    /** Dashboards by name that I may open (guests: the shareable ones shared with them). */
    dashboards: z.array(z.object({ id: z.string(), name: z.string(), workspace: z.string().nullable() })).default([]),
  })
  .meta({ id: 'SearchResult' });
export type SearchResult = z.infer<typeof searchResultSchema>;

export const inboxEntrySchema = z
  .object({
    id: z.string(),
    /** Set on a reply: the update it answers (replying again goes there). */
    parent_update_id: z.string().nullable(),
    item: z.object({ id: z.string(), name: z.string() }),
    board: boardRef,
    author: z.object({ id: z.string(), name: z.string() }).nullable(),
    body_html: z.string(),
    /** Names of the files attached to it (an update may be files only). */
    file_names: z.array(z.string()),
    created_at: z.string(),
    /** I am mentioned in it. */
    mention: z.boolean(),
    /** I marked it read (V) or it predates my "mark all read". */
    read: z.boolean(),
    /** Who saw it (r16seen) — null when the account turned it off, and for guests. */
    seen: updateSeenSchema.nullable().optional(),
  })
  .meta({ id: 'InboxEntry' });
export type InboxEntry = z.infer<typeof inboxEntrySchema>;

export const inboxSchema = z
  .object({ data: z.array(inboxEntrySchema), next_cursor: z.string().nullable() })
  .meta({ id: 'Inbox' });
export type Inbox = z.infer<typeof inboxSchema>;

export const inboxReadSchema = z
  .union([z.object({ ids: z.array(z.string()).min(1).max(200) }), z.object({ all: z.literal(true) })])
  .meta({ id: 'MarkInboxRead' });

export const inboxCountSchema = z.object({ unread: z.number().int() }).meta({ id: 'InboxCount' });
