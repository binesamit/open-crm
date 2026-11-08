// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { MAX_RICH_JSON, richDocSchema } from '../rich';
import { updateEmailMetaSchema, updateEmailReplyMetaSchema } from './inbound-email';

/** A client's question from an interactive document (`updates.meta.document`). */
export type UpdateDocumentMeta = {
  doc_id: string;
  doc_name: string;
  section_title: string;
  name: string;
  section_id?: string;
};
export const updateDocumentMetaOf = (meta: unknown): UpdateDocumentMeta | null => {
  const d = (meta as { document?: Partial<UpdateDocumentMeta> } | null)?.document;
  return d && typeof d.doc_id === 'string'
    ? {
        doc_id: d.doc_id,
        doc_name: String(d.doc_name ?? ''),
        section_title: String(d.section_title ?? ''),
        name: String(d.name ?? ''),
        ...(typeof d.section_id === 'string' ? { section_id: d.section_id } : {}),
      }
    : null;
};

/** Updates (item conversation) and activity DTOs — 06-API §2.13, §2.19. */
export const updateAuthorSchema = z.object({ id: z.string(), name: z.string() }).nullable();

/** "Seen by": the device classes a view is counted under (from the request headers, never the client's say). */
export const UPDATE_VIEW_DEVICES = ['desktop', 'mobile', 'tablet'] as const;
export const updateViewDeviceSchema = z.enum(UPDATE_VIEW_DEVICES);
export type UpdateViewDevice = z.infer<typeof updateViewDeviceSchema>;

/** One person who saw an update or reply: every device they saw it on, and when they last did. */
export const updateViewerSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Short-lived link to the profile photo, or null (the app then shows initials). */
  avatar_url: z.string().nullable(),
  devices: z.array(
    z.object({
      device: updateViewDeviceSchema,
      /** "Chrome · Windows" — browser and OS only, '' when unknown. */
      user_agent: z.string(),
      last_seen_at: z.string(),
    }),
  ),
  last_seen_at: z.string(),
});
export type UpdateViewer = z.infer<typeof updateViewerSchema>;

/** At most this many viewers ride on an update; `count` has them all (GET /updates/{id}/views lists every one). */
export const SEEN_PREVIEW_LIMIT = 20;
export const updateSeenSchema = z.object({ count: z.number().int(), users: z.array(updateViewerSchema) });
export type UpdateSeen = z.infer<typeof updateSeenSchema>;

/** POST /updates/views: what became visible on screen (the client batches every few seconds). */
export const markUpdateViewsSchema = z.object({ update_ids: z.array(z.string().max(26)).min(1).max(100) });
export const markUpdateViewsResultSchema = z.object({ ok: z.literal(true), recorded: z.number().int() });
export const updateViewsSchema = z.object({ data: z.array(updateViewerSchema) });

const updateBase = z.object({
  id: z.string(),
  item_id: z.string(),
  body_html: z.string(),
  body_text: z.string(),
  author: updateAuthorSchema,
  created_at: z.string(),
  edited_at: z.string().nullable(),
  mentions: z.array(z.string()),
  likes: z.object({ count: z.number(), me: z.boolean() }),
  /** Every reaction with its count and whether I gave it (👍 = `like`, also in `likes`). */
  reactions: z.array(z.object({ reaction: z.string(), count: z.number(), me: z.boolean() })),
  /** The editor document for rich updates (to edit them); null for plain-text ones. */
  body_json: z.record(z.string(), z.unknown()).nullable(),
  files: z.array(z.object({ id: z.string(), name: z.string(), size: z.number(), mime: z.string() })),
  /**
   * Who saw it (newest first, the author left out); null when the account turned "show who viewed updates" off
   * or for guests. Optional: older answers and other endpoints leave it out.
   */
  seen: updateSeenSchema.nullable().optional(),
  /** Where it came from: typed in the app (`user`), an email, an automation, the API, a form, or an SMS sent from the item. */
  source: z.enum(['user', 'email', 'automation', 'api', 'form', 'sms', 'document']).optional(),
  /** An SMS sent from the item (source `sms`): to which number (E.164) and from which phone column. */
  sms: z.object({ to: z.string(), column_id: z.string().nullable() }).nullable().optional(),
  /** An update that came in by email (source `email`): the sender and the subject. */
  email: updateEmailMetaSchema.nullable().optional(),
  /** A reply sent by email from the item to whoever emailed it (source `email`). */
  email_reply: updateEmailReplyMetaSchema.nullable().optional(),
  /**
   * A question or reply the client wrote on an interactive document's page (source `document`): the
   * client's name, the document and the section asked about. Such an update has no author.
   */
  document: z
    .object({
      doc_id: z.string(),
      doc_name: z.string(),
      section_title: z.string(),
      name: z.string(),
      section_id: z.string().optional(),
    })
    .nullable()
    .optional(),
  /**
   * A secret update: its text is encrypted — `body_html` / `body_text` are empty and `body_json` null
   * here; POST /updates/{id}/reveal gives the text once, after a fresh two-factor code. Replies to it are secret too.
   */
  secret: z.boolean().optional(),
});
/** Replies nest (a reply to a reply) down to this depth; a deeper reply joins its parent's level. */
export const MAX_REPLY_DEPTH = 5;
/** A reply: every reply of a thread comes in one list, in thread order, with the update/reply it answers. */
export const replySchema = updateBase.extend({ parent_update_id: z.string() });
/** One update or reply on its own (what posting, replying or editing returns); null parent = a top update. */
export const updateEntrySchema = updateBase.extend({ parent_update_id: z.string().nullable() });
export const updateSchema = updateBase.extend({ replies: z.array(replySchema), pinned: z.boolean() });
export type UpdateDto = z.infer<typeof updateSchema>;

/** At most this many files on one update or reply (posting, and adding more while editing). */
export const MAX_UPDATE_FILES = 20;

/**
 * Either `doc` — the rich editor's ProseMirror JSON, rendered by the server through an allowlist (rich.ts) —
 * or `body`, plain text with mentions as `[@Name](user:<id>)` (API clients, email-to-board).
 * Fix: an update may be only attached files — the text (body/doc) may then be left out or empty.
 * Text and files both empty is refused (here, and by the service for an empty doc).
 */
export const createUpdateSchema = z
  .object({
    // r17reply: generous here; text over MAX_RICH_TEXT is refused by the service as `update_too_long` (with the limit).
    body: z.string().trim().max(MAX_RICH_JSON).optional(),
    doc: richDocSchema.optional(),
    /** Uploaded files (POST /files/presign → PUT → /complete) to attach. */
    file_ids: z.array(z.string()).max(MAX_UPDATE_FILES).optional(),
    /**
     * A secret update: the text is stored encrypted and shown only after a fresh two-factor code.
     * Needs 2FA on and secret updates allowed on the board; no files. A reply in a secret thread is always secret.
     */
    secret: z.boolean().optional(),
  })
  .refine((v) => !(v.body !== undefined && v.doc), 'send either body or doc')
  .refine((v) => !!v.body || !!v.doc || !!v.file_ids?.length, 'send text or files');

/**
 * PATCH /updates/{id} (f9-updedit): editing an update or reply under the same conditions as posting
 * one — new text (`body` / `doc`; left out = the text stays), `file_ids` to attach (uploaded by the editor, as on
 * create) and `remove_file_ids` to take off. The update keeps at most MAX_UPDATE_FILES files; text and files may
 * not both end up empty (the service checks the result).
 */
export const editUpdateSchema = z
  .object({
    body: z.string().trim().max(MAX_RICH_JSON).optional(),
    doc: richDocSchema.optional(),
    file_ids: z.array(z.string()).max(MAX_UPDATE_FILES).optional(),
    remove_file_ids: z.array(z.string()).max(MAX_UPDATE_FILES).optional(),
  })
  .refine((v) => !(v.body !== undefined && v.doc), 'send either body or doc')
  .refine(
    (v) => v.body !== undefined || !!v.doc || !!v.file_ids?.length || !!v.remove_file_ids?.length,
    'send text or file changes',
  );

/** The emoji set for reactions (stored as keys; the UI maps them to glyphs). */
export const REACTIONS = ['like', 'heart', 'laugh', 'party', 'wow', 'sad'] as const;
export const REACTION_EMOJI: Record<(typeof REACTIONS)[number], string> = {
  like: '👍',
  heart: '❤️',
  laugh: '😂',
  party: '🎉',
  wow: '😮',
  sad: '😢',
};
export const reactionParamSchema = z.object({ id: z.string(), reaction: z.enum(REACTIONS) });

/** PUT /updates/{id}/tasks/{index}: one check box of an update, counted from 0 in document order. */
export const updateTaskParamSchema = z.object({ id: z.string(), index: z.coerce.number().int().min(0).max(10_000) });
export const updateTaskSchema = z.object({ checked: z.boolean() });

export const activityEntrySchema = z.object({
  id: z.string(),
  type: z.string(),
  actor: updateAuthorSchema,
  column_id: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  created_at: z.string(),
  item_id: z.string().nullable(),
  item_name: z.string().nullable(),
  /** One action on many items (07 §6) shows as one row: how many events it holds (1 = a single one). */
  batch_id: z.string().nullable(),
  count: z.number().int(),
  /** The viewer may undo it now (their action or they are an admin, within 7 days, not undone yet). */
  undoable: z.boolean(),
  undone: z.boolean(),
  /** This row is itself an undo (of another row). */
  is_undo: z.boolean(),
  /**
   * Done by an AI app over MCP (AGENTS-MCP מ4): `{client}` = the connection's name ("Claude Code"); or by an
   * extension (D27 ת2): `kind: 'app'`, `{client}` = the extension's name; or by a public form submission (M11):
   * `kind: 'form'`, `{client}` = the form's title.
   */
  via: z
    .object({ kind: z.enum(['mcp', 'app', 'form']), client: z.string().nullable() })
    .nullable()
    .optional(),
  /** a board owner or admin made this status move past the workflow on purpose. */
  workflow_override: z.boolean().optional(),
});
export type ActivityEntry = z.infer<typeof activityEntrySchema>;

/** `actor_id` value for events nobody did by hand (an automation, the system). */
export const ACTIVITY_SYSTEM_ACTOR = 'system';

/** GET /boards/:id/activity — paging and filters (all optional, combined with AND). */
export const boardActivityQuerySchema = z.object({
  /** An event id to page past (`next_before` of the previous page). */
  before: z.string().max(64).optional(),
  /** Who did it: a user id, or `system` for automations and the system. */
  actor_id: z.string().max(64).optional(),
  /** The column key the event is about (cell changes). */
  column: z.string().max(64).optional(),
  /** Event types, comma-separated (`cell.changed,item.renamed`). */
  type: z.string().max(500).optional(),
  /** Inclusive days (YYYY-MM-DD, UTC). */
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  /** Free text: the item's name, the person's name, or a value before / after. */
  q: z.string().trim().max(200).optional(),
});
export type BoardActivityQuery = z.infer<typeof boardActivityQuerySchema>;

const MENTION_RE = /\[@([^\]]{1,120})\]\(user:([0-9A-HJKMNP-TV-Z]{26})\)/g;

export const mentionedUserIds = (body: string): string[] => [
  ...new Set([...body.matchAll(MENTION_RE)].map((m) => m[2]!)),
];

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Plain text → safe HTML: everything escaped, then mentions → chips, http(s) URLs → links, newlines → <br>.
 * The only HTML in an update is what this function produces.
 */
export const renderUpdateBody = (body: string): { html: string; text: string } => {
  const parts: string[] = [];
  let last = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    parts.push(linkify(escapeHtml(body.slice(last, m.index))));
    parts.push(`<span class="mention" data-user-id="${m[2]}">@${escapeHtml(m[1]!)}</span>`);
    last = m.index! + m[0].length;
  }
  parts.push(linkify(escapeHtml(body.slice(last))));
  return {
    html: parts.join('').replace(/\r?\n/g, '<br>'),
    text: body.replace(MENTION_RE, '@$1'),
  };
};

/**
 * The stored body as shown (Fix: , at read time — no data migration): a body whose line breaks never became
 * markup (an older or externally written row: raw newlines in the HTML, or HTML without them while the plain text
 * has them) gets its breaks back. Rich bodies (paragraphs / <br>) are returned untouched.
 */
export const displayUpdateHtml = (html: string, text: string): string => {
  if (/<(p|br|li|h[23]|pre|blockquote)\b/i.test(html)) return html;
  if (/\n/.test(html)) return html.replace(/\r?\n/g, '<br>');
  // No mention chips to lose: the plain text renders to the same HTML, with its line breaks.
  if (/\n/.test(text) && !html.includes('class="mention"')) return renderUpdateBody(text).html;
  return html;
};

const linkify = (escaped: string) =>
  escaped.replace(
    /https?:\/\/[^\s<]+/g,
    (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`,
  );
