// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { DOC_ACTIONS, DOC_LEVELS } from '../permissions/doc';
import { richDocSchema, richNodeSchema } from '../rich';
import { boardKindSchema, positionSchema } from './boards';

/**
 * Docs (M8 ד1, D25): a doc lives in a workspace next to the boards (sidebar, folders, favourites, trash), is edited
 * together live (Yjs over `/api/v1/collab`) and is permissioned like a board — main / private / shareable, with
 * owner / editor / commenter / viewer invitations.
 */
export const docLevelSchema = z.enum(DOC_LEVELS);
export const DOC_NAME_MAX = 255;

export const docSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  kind: boardKindSchema,
  workspace_id: z.string(),
  folder_id: z.string().nullable(),
  position: z.string(),
});
export type DocSummary = z.infer<typeof docSummarySchema>;

export const docSettingsSchema = z
  .object({
    /** Full page width instead of the reading column. */
    full_width: z.boolean().optional(),
  })
  .loose();
export type DocSettings = z.infer<typeof docSettingsSchema>;

export const docDetailSchema = docSummarySchema
  .extend({
    settings: docSettingsSchema,
    revision: z.number().int(),
    capabilities: z.record(z.enum(DOC_ACTIONS), z.boolean()),
    created_at: z.string(),
    created_by: z.object({ id: z.string(), name: z.string() }).nullable(),
    updated_at: z.string(),
    updated_by: z.object({ id: z.string(), name: z.string() }).nullable(),
    /** The Hocuspocus document name to open (`<account_id>:<doc_id>`). */
    collab_name: z.string(),
    /** Where it lives: the sidebar, or an item's doc cell (ד2) — then it has the item's permissions. */
    host: z.enum(['workspace', 'cell']),
    cell: z
      .object({ board_id: z.string(), item_id: z.string(), item_name: z.string(), column_key: z.string() })
      .nullable(),
    /** Open comment threads (ד3). */
    open_threads: z.number().int(),
  })
  .meta({ id: 'Doc' });
export type DocDetail = z.infer<typeof docDetailSchema>;

export const createDocSchema = z.object({
  name: z.string().trim().min(1).max(DOC_NAME_MAX).optional(),
  folder_id: z.string().nullable().optional(),
  kind: boardKindSchema.default('main'),
});

export const updateDocSchema = z.object({
  name: z.string().trim().min(1).max(DOC_NAME_MAX).optional(),
  icon: z.string().max(16).nullable().optional(),
  /** Main / private / shareable — the doc's owners and admins. */
  kind: boardKindSchema.optional(),
  /** A folder of its workspace, or null for the root. */
  folder_id: z.string().nullable().optional(),
  /** Another workspace (its root, unless `folder_id` is one of its folders) — owners and admins. */
  workspace_id: z.string().optional(),
  /** Among the boards and docs of its (new) folder — sidebar drag. */
  position: positionSchema,
  settings: docSettingsSchema.optional(),
});

export const duplicateDocSchema = z.object({ name: z.string().trim().min(1).max(DOC_NAME_MAX).optional() });

/** GET /docs/:id/content — the doc without a WebSocket (guests on a phone, previews, export). */
export const docContentSchema = z
  .object({
    id: z.string(),
    revision: z.number().int(),
    content: richNodeSchema.nullable(),
    text: z.string(),
    updated_at: z.string(),
  })
  .meta({ id: 'DocContent' });
export type DocContent = z.infer<typeof docContentSchema>;

export const docMemberSchema = z.object({
  type: z.enum(['user', 'team']),
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  level: docLevelSchema,
});
export type DocMember = z.infer<typeof docMemberSchema>;
export const docMembersSchema = z.object({ data: z.array(docMemberSchema) }).meta({ id: 'DocMembers' });
export type DocMembers = z.infer<typeof docMembersSchema>;
/** PUT /docs/:id/members — the whole list; a doc always keeps an owner. */
export const setDocMembersSchema = z.object({
  members: z
    .array(z.object({ type: z.enum(['user', 'team']), id: z.string().min(1).max(26), level: docLevelSchema }))
    .max(500),
});

/** POST /docs/:id/collab-token — for a client that cannot send the session cookie on the WebSocket. */
export const collabTokenSchema = z.object({ token: z.string(), expires_at: z.string() });

export const DOC_FAVORITES_MAX = 50;
export const favoriteDocSchema = z.object({ id: z.string(), name: z.string(), workspace_id: z.string() });
export const favoriteDocsSchema = z.object({ data: z.array(favoriteDocSchema) }).meta({ id: 'FavoriteDocs' });
export type FavoriteDocs = z.infer<typeof favoriteDocsSchema>;
export const setFavoriteDocsSchema = z
  .object({ doc_ids: z.array(z.string().min(1).max(26)).max(DOC_FAVORITES_MAX) })
  .meta({ id: 'SetFavoriteDocs' });

// ---- M8 ד2: a doc in a cell ----
/** POST /items/:id/cells/:col/doc — the cell's doc, made on first use (the item's editors). */
export const createCellDocSchema = z.object({ name: z.string().trim().min(1).max(DOC_NAME_MAX).optional() });
export const cellDocSchema = z.object({ doc: docDetailSchema, created: z.boolean() }).meta({ id: 'CellDoc' });

// ---- M8 ד3: versions ----
export const DOC_VERSION_LABEL_MAX = 120;
export const docVersionSchema = z
  .object({
    id: z.string(),
    label: z.string().nullable(),
    auto: z.boolean(),
    created_at: z.string(),
    created_by: z.object({ id: z.string(), name: z.string() }).nullable(),
  })
  .meta({ id: 'DocVersion' });
export type DocVersion = z.infer<typeof docVersionSchema>;
export const docVersionsSchema = z.object({ data: z.array(docVersionSchema) }).meta({ id: 'DocVersions' });
export type DocVersions = z.infer<typeof docVersionsSchema>;
export const docVersionContentSchema = docVersionSchema
  .extend({ content: richNodeSchema.nullable(), text: z.string() })
  .meta({ id: 'DocVersionContent' });
export type DocVersionContent = z.infer<typeof docVersionContentSchema>;
export const createDocVersionSchema = z.object({ label: z.string().trim().min(1).max(DOC_VERSION_LABEL_MAX) });

// ---- M8 ד3: comments ----
export const DOC_BLOCK_ID_MAX = 64;
export const docCommentSchema = z
  .object({
    id: z.string(),
    thread_id: z.string(),
    body: richNodeSchema,
    /** Rendered through the shared allowlist (rich.ts). */
    html: z.string(),
    text: z.string(),
    author: z.object({ id: z.string(), name: z.string() }).nullable(),
    created_at: z.string(),
    edited_at: z.string().nullable(),
    can_edit: z.boolean(),
  })
  .meta({ id: 'DocComment' });
export type DocComment = z.infer<typeof docCommentSchema>;
export const docThreadSchema = z
  .object({
    id: z.string(),
    block_id: z.string(),
    quote: z.string(),
    resolved_at: z.string().nullable(),
    resolved_by: z.object({ id: z.string(), name: z.string() }).nullable(),
    created_at: z.string(),
    comments: z.array(docCommentSchema),
  })
  .meta({ id: 'DocThread' });
export type DocThread = z.infer<typeof docThreadSchema>;
export const docThreadsSchema = z
  .object({ data: z.array(docThreadSchema), can_comment: z.boolean() })
  .meta({ id: 'DocThreads' });
export type DocThreads = z.infer<typeof docThreadsSchema>;
export const createDocThreadSchema = z.object({
  block_id: z.string().min(1).max(DOC_BLOCK_ID_MAX),
  quote: z.string().max(500).default(''),
  body: richDocSchema,
});
export const docCommentBodySchema = z.object({ body: richDocSchema });
export const resolveDocThreadSchema = z.object({ resolved: z.boolean() });

// ---- M8 ד3: export ----
export const DOC_EXPORT_FORMATS = ['html', 'md', 'pdf'] as const;
export type DocExportFormat = (typeof DOC_EXPORT_FORMATS)[number];

// ---- M8 ד3: invite by email (guests on a shareable doc) ----
export const inviteToDocSchema = z.object({
  emails: z.array(z.email().toLowerCase()).min(1).max(50),
  /** Someone new joins the account in this role; a guest only on a shareable doc. */
  role: z.enum(['member', 'guest']).default('guest'),
  level: docLevelSchema.default('viewer'),
  message: z.string().max(1000).optional(),
  /** false = no email to new people, only their invitation links to copy; default true. */
  send_email: z.boolean().optional(),
});
export const inviteToDocResultSchema = z.object({
  /** `url`: the new invitation's link, to copy and send another way. */
  invited: z.array(z.object({ email: z.string(), url: z.string().optional() })),
  added: z.array(z.object({ email: z.string(), user_id: z.string() })),
  errors: z.array(z.object({ email: z.string(), code: z.string() })),
});
export type InviteToDocResult = z.infer<typeof inviteToDocResultSchema>;
