// SPDX-License-Identifier: AGPL-3.0-only
import { itemCardSettingsSchema } from '../views/card';
import { z } from 'zod';
import { groupColorInputSchema, groupColorKeySchema } from '../colors';
import { BOARD_ACTIONS } from '../permissions/board';
import { mirrorSourceSchema } from '../columns/defs/computed';
import { popupSubitemsWriteSchema } from '../workflows/status-workflow';

/** DTOs for workspaces, folders, boards, groups, columns, items and cells (06-API §2.4–2.11). */

const groupColor = groupColorKeySchema;
/** Input also takes a legacy (pre-F9) key and reads it as ours. */
const groupColorIn = groupColorInputSchema;
export const boardKindSchema = z.enum(['main', 'shareable', 'private']);
export const permissionSetSchema = z.enum(['edit_everything', 'edit_content', 'edit_assigned', 'view_comment']);

/** Relative placement for lexorank positions. */
export const positionSchema = z
  .union([z.object({ after_id: z.string() }), z.object({ before_id: z.string() }), z.enum(['top', 'bottom'])])
  .optional();

// ---- workspaces & folders ----
export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(['open', 'closed']),
  position: z.string(),
});
export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(['open', 'closed']).default('open'),
});

export const updateWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(['open', 'closed']).optional(),
});

export const folderSchema = z.object({
  id: z.string(),
  workspace_id: z.string(),
  parent_folder_id: z.string().nullable(),
  name: z.string(),
  color: z.string().nullable(),
  position: z.string(),
});
export const createFolderSchema = z.object({
  workspace_id: z.string(),
  parent_folder_id: z.string().nullable().optional(),
  name: z.string().trim().min(1).max(120),
  color: z.string().max(32).optional(),
});
export const updateFolderSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  color: z.string().max(32).nullable().optional(),
  /**
   * Move the folder — with its sub-folders and boards — to another workspace's root (fix8: "אפשרות להעביר
   * בורדים בין ווארקספייס"). Its creator or an admin, who may create there and manage every board in it.
   */
  workspace_id: z.string().optional(),
  /**
   * Prod (sidebar drag): into another folder of the same workspace (`null` = the root), with all that is in
   * it — never into itself or a folder inside it, at most three levels deep.
   */
  parent_folder_id: z.string().nullable().optional(),
  /** Before / after a board, doc, dashboard or folder of the folder it ends up in (they share one order). */
  position: z.union([z.object({ after_id: z.string() }), z.object({ before_id: z.string() })]).optional(),
});

export const boardSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: boardKindSchema,
  workspace_id: z.string(),
  folder_id: z.string().nullable(),
  position: z.string(),
  item_terminology: z.string(),
});
export type BoardSummary = z.infer<typeof boardSummarySchema>;

/**
 * What a workspace holds (M8 ד0): boards, and next to them — in the same folders, in one order — docs (ד1) and
 * dashboards (ד4). Every kind is a row of the sidebar with a name, a place and the viewer's rights.
 */
export const WORKSPACE_ENTITY_TYPES = ['board', 'doc', 'dashboard'] as const;
export type WorkspaceEntityType = (typeof WORKSPACE_ENTITY_TYPES)[number];
/** A workspace object other than a board (those keep their own `boards` list). */
export const workspaceEntitySchema = z.object({
  type: z.enum(['doc', 'dashboard']),
  id: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  kind: boardKindSchema,
  folder_id: z.string().nullable(),
  position: z.string(),
  can_update: z.boolean(),
  can_delete: z.boolean(),
  /** A doc's open comment threads (M8 ד3) — the count next to it in the sidebar. */
  open_threads: z.number().int().optional(),
});
export type WorkspaceEntity = z.infer<typeof workspaceEntitySchema>;

/** The sidebar tree carries what the viewer may do, so menus only offer allowed actions (14 §0). */
export const workspaceTreeSchema = z.object({
  workspace: workspaceSchema.extend({
    can_edit: z.boolean(),
    can_delete: z.boolean(),
    can_create: z.boolean().describe('folders, boards and docs'),
  }),
  folders: z.array(folderSchema.extend({ can_edit: z.boolean() })),
  boards: z.array(boardSummarySchema.extend({ can_update: z.boolean(), can_delete: z.boolean() })),
  /** Docs (and later dashboards) I can see, in the same folders; ordered with the boards by `position`. */
  entities: z.array(workspaceEntitySchema),
});
export type WorkspaceTree = z.infer<typeof workspaceTreeSchema>;

// ---- boards ----
export const columnSchema = z.object({
  id: z.string().describe('column key, e.g. status_mm6x5rvw'),
  type: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  settings: z.record(z.string(), z.unknown()),
  width: z.number(),
  position: z.string(),
  read_only: z.boolean(),
  restricted_edit: z.boolean(),
  /** D28: the id of a background type conversion running on the column (edits wait), else null. */
  converting: z.string().nullable().optional(),
  /** A mirror: its source column's type and number display (its footer summaries). */
  mirror_source: mirrorSourceSchema.nullable().optional(),
});
export type Column = z.infer<typeof columnSchema>;

export const groupSchema = z.object({
  id: z.string(),
  title: z.string(),
  color: groupColor,
  position: z.string(),
});
export type Group = z.infer<typeof groupSchema>;

/**
 * who a column drag on the board's default table moves the columns for — `shared` (the board's own
 * order, for everyone; needs `column.reorder`) or `personal` (each person's own order on the default table).
 */
export const MAIN_TABLE_COLUMN_ORDERS = ['shared', 'personal'] as const;
export const mainTableColumnOrderSchema = z.enum(MAIN_TABLE_COLUMN_ORDERS);
export type MainTableColumnOrder = z.infer<typeof mainTableColumnOrderSchema>;

export const boardDetailSchema = boardSummarySchema.extend({
  description: z.string().nullable(),
  permission_set: permissionSetSchema,
  hierarchy_depth_max: z.number(),
  revision: z.number(),
  columns: z.array(columnSchema),
  groups: z.array(groupSchema),
  capabilities: z.record(z.enum(BOARD_ACTIONS), z.boolean()),
  created_at: z.string(),
  /** On a sub-board (D14): the board its items are subitems of. */
  parent_board_id: z.string().nullable(),
  /** The board's sub-board (D14), once it has subitems. */
  subitems_board_id: z.string().nullable(),
  /** Set while the board is in the archive (it opens with a "restore" banner). */
  archived_at: z.string().nullable(),
  /** Item card tabs (N19) as saved for the board; `resolveCardTabs` gives the full list. */
  card: itemCardSettingsSchema,
  /** Column order on the default table: the board's (`shared`) or each person's (`personal`). */
  main_table_column_order: mainTableColumnOrderSchema,
  /**
   * Set on a template's working board (fix3, "עריכת התבנית"): the template it edits. Such a board is a draft —
   * hidden from the sidebar, search, My Work and favourites, opened from the templates page only.
   */
  template_edit: z.object({ key: z.string(), name: z.string(), with_items: z.boolean() }).nullable(),
});
export type BoardDetail = z.infer<typeof boardDetailSchema>;

/** POST /boards/:id/duplicate (07 §4.1): structure only, + items, or + items and updates. */
export const duplicateBoardSchema = z.object({
  mode: z.enum(['structure', 'items', 'items_updates']).default('structure'),
  name: z.string().trim().min(1).max(255).optional(),
  folder_id: z.string().nullable().optional(),
  /** Into another Workspace (its root, unless `folder_id` is one of its folders). */
  workspace_id: z.string().optional(),
  keep_subscribers: z.boolean().default(false),
});
/** POST /boards/:id/save-as-template (07 §4.3): the structure as a template of this account. */
export const saveAsTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  description: z.string().max(2000).nullable().optional(),
  /** Also the items (up to 500, with their values and subitems): a board from it starts with them. */
  with_items: z.boolean().default(false),
  /** Save over this template (edit a template: fix a board made from it, save it back). */
  replace_key: z.string().optional(),
});

/** PATCH /templates/:key — rename or redescribe one of the account's templates. */
export const updateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(2000).nullable().optional(),
});

/** POST /items/:id/duplicate (07 §4.2): the copy goes right below; subitems come along, updates on request. */
export const duplicateItemSchema = z.object({ with_updates: z.boolean().default(false) });
/** POST /boards/:id/groups/:gid/duplicate: a copy right below, with its items unless `with_items: false`. */
export const duplicateGroupSchema = z.object({ with_items: z.boolean().default(true) });

/** POST /items/:id/subitems (D14): a subitem of that item, on the board's sub-board (created on first use). */
export const createSubitemSchema = z.object({
  /** Optional (and ignored) when the sub-board computes names. */
  name: z.string().trim().min(1).max(255).optional(),
  cells: z.record(z.string(), z.unknown()).optional(),
  /**
   * Column values as plain input, keyed by column id (integrations): a status by its label, people by email or
   * name, dates as `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM`, several values comma-separated — converted to each column's
   * stored value (a JSON object is taken as is). Empty values are skipped; merged over `cells`.
   */
  values: z.record(z.string(), z.unknown()).optional(),
  /** Among the parent's subitems ("add below" a subitem); default: last. */
  position: positionSchema,
});

/** Reorders a subitem among its siblings (drag in the subitems table). */
export const reorderSubitemSchema = z.object({
  position: z.union([
    z.object({ after_id: z.string() }),
    z.object({ before_id: z.string() }),
    z.enum(['top', 'bottom']),
  ]),
});

export const createBoardSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  workspace_id: z.string(),
  folder_id: z.string().nullable().optional(),
  kind: boardKindSchema.default('main'),
  /** Built-in template key (seed/templates) — omitted = empty board with one group and the name column. */
  template_key: z.string().max(64).optional(),
});

/** A board's description (fix3: a full description, shown clamped to one line in the header). */
export const BOARD_DESCRIPTION_MAX = 5000;

export const updateBoardSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(BOARD_DESCRIPTION_MAX).nullable().optional(),
  item_terminology: z.string().trim().min(1).max(40).optional(),
  permission_set: permissionSetSchema.optional(),
  /** Change board type: main / private / shareable — owners and admins (05 §4). */
  kind: boardKindSchema.optional(),
  /** Move within the workspace: a folder id, or null for the workspace root (14 §6 "העבר ל"). */
  folder_id: z.string().nullable().optional(),
  /**
   * Move to another workspace (fix8): its root, unless `folder_id` is one of its folders. Needs management rights
   * on the board (owner / admin) and the right to create boards there; the board keeps its own permissions.
   */
  workspace_id: z.string().optional(),
  /**
   * Place among the boards of its folder (the target folder when `folder_id` is given, else its own) — sidebar
   * drag (fix3). Same permission as moving it between folders.
   */
  position: positionSchema,
  /** Item card tabs (N19): which tabs, their names, order and fields — needs `board.update`. */
  card: itemCardSettingsSchema.optional(),
  /** Column order on the default table: shared / personal — needs `board.update`. */
  main_table_column_order: mainTableColumnOrderSchema.optional(),
});

export const templateSummarySchema = z.object({
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  folder: z.string().nullable(),
  /** Saved in this account (not built in). */
  account: z.boolean(),
  /** May rename / delete it: its creator or an admin. */
  can_edit: z.boolean(),
  /** Items a board from it starts with. */
  item_count: z.number().int(),
  /** My open working board of this template ("טיוטה פתוחה", fix3), if any. */
  draft_board_id: z.string().nullable(),
});

// ---- groups ----
export const createGroupSchema = z.object({
  title: z.string().trim().min(1).max(255),
  color: groupColorIn.optional(),
  position: positionSchema,
});
export const updateGroupSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  color: groupColorIn.optional(),
});
export const reorderSchema = z.object({ position: positionSchema });

// ---- columns ----
export const createColumnSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9_]{0,19}$/)
    .optional(),
  title: z.string().trim().min(1).max(255),
  type: z.string(),
  description: z.string().max(1000).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  width: z.number().int().min(60).max(800).optional(),
  after_column_id: z.string().optional(),
  /** Insert before this column (14 §4 "add column right/left"); never before the name column. */
  before_column_id: z.string().optional(),
});
export const updateColumnSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  width: z.number().int().min(60).max(800).optional(),
});

/**
 * PUT /boards/:id/columns/:key/two-way (03 §2.16). `enabled: false` makes both columns one-way (links stay).
 * Enabling pairs with `partner_column_id` (a relation column on the target board that links back here), or
 * creates the partner there titled `partner_title` (default: this board's name).
 */
export const setTwoWaySchema = z.object({
  enabled: z.boolean(),
  partner_column_id: z.string().optional(),
  partner_title: z.string().trim().min(1).max(255).optional(),
});
export const twoWayResultSchema = z.object({
  column: columnSchema,
  partner: z.object({ board_id: z.string(), column: columnSchema }).nullable(),
  /** Reverse links added when the pair was made (existing links on either side). */
  backfilled: z.number(),
});
/** A board's item numbering (item_id column, 03 §2.19): `next_seq` is what the next new item gets. */
export const itemSequenceSchema = z.object({
  prefix: z.string(),
  padding: z.number().int(),
  next_seq: z.number().int(),
  /** The highest number given on the board (null: none yet); `next_seq` must stay above it. */
  max_seq: z.number().int().nullable(),
});
export type ItemSequence = z.infer<typeof itemSequenceSchema>;
export const itemSequenceOutSchema = z.object({ sequence: itemSequenceSchema.nullable() });
export const updateItemSequenceSchema = z.object({ next_seq: z.number().int().min(1).max(2_000_000_000) });

// ---- items & cells ----
export const cellSchema = z.object({
  value: z.unknown(),
  text: z.string().nullable(),
  /**
   * Relation / dependency cells: the linked items' names, aligned with `value.item_ids` (only items the reader may
   * see). Use it instead of splitting `text` — a name may contain ", ".
   */
  names: z.array(z.string()).optional(),
});
export type Cell = z.infer<typeof cellSchema>;

export const itemSchema = z.object({
  id: z.string(),
  board_id: z.string(),
  group_id: z.string().nullable(),
  parent_item_id: z.string().nullable(),
  depth: z.number(),
  name: z.string(),
  /** the name is computed by the server from columns (the board's name source) — not editable. */
  name_computed: z.boolean().optional(),
  /** The board's name source mode: free (typed), column or template. */
  name_source: z.enum(['free', 'column', 'template']).optional(),
  position: z.string(),
  key: z.string().nullable(),
  cells: z.record(z.string(), cellSchema),
  created_at: z.string(),
  created_by: z.string().nullable(),
  updated_at: z.string(),
  /** Only with `?format=flat`: each cell's text keyed by column title (integrations map it without the schema). */
  column_values: z.record(z.string(), z.string().nullable()).optional(),
});
export type Item = z.infer<typeof itemSchema>;

/** `POST /boards/:id/items/query` (13-FILTERS §5): one page of matches in query order. */
export const itemsPageSchema = z.object({
  data: z.array(itemSchema),
  total: z.number().int(),
  next_cursor: z.string().nullable(),
});
export type ItemsPage = z.infer<typeof itemsPageSchema>;

export const createItemSchema = z.object({
  /** Required on a board with free names; optional (and ignored) where the board computes names. */
  name: z.string().trim().min(1).max(255).optional(),
  group_id: z.string().optional(),
  cells: z.record(z.string(), z.unknown()).optional(),
  /**
   * Column values as plain input, keyed by column id (integrations): a status by its label, people by email or
   * name, dates as `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM`, several values comma-separated — converted to each column's
   * stored value (a JSON object is taken as is). Empty values are skipped; merged over `cells`.
   */
  values: z.record(z.string(), z.unknown()).optional(),
  position: positionSchema,
});
export const updateItemSchema = z.object({
  /** A board with a computed name answers 409 `item_name_computed` when this differs from the current name. */
  name: z.string().trim().min(1).max(255).optional(),
  cells: z.record(z.string(), z.unknown()).optional(),
  /**
   * Column values as plain input, keyed by column id (integrations): a status by its label, people by email or
   * name, dates as `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM`, several values comma-separated — converted to each column's
   * stored value (a JSON object is taken as is). Empty values are skipped; merged over `cells`.
   */
  values: z.record(z.string(), z.unknown()).optional(),
  /** a board owner or admin makes a move the status workflow blocks, on purpose (logged). */
  workflow_override: z.boolean().optional(),
  /** phase 2: a popup's note — saved on the item as an update in the same write (plain text). */
  note: z.string().trim().max(5000).optional(),
  /** a popup's subitems — added and filled in before the move is checked, in the same write. */
  subitems: popupSubitemsWriteSchema.optional(),
});
export const setCellSchema = z.object({ value: z.unknown(), workflow_override: z.boolean().optional() });

/** Batch actions (07 §6): one request, one `batch_id`; items the actor may not change are skipped and counted. */
export const BULK_MAX_ITEMS = 5000;
export const bulkItemsSchema = z.object({
  item_ids: z.array(z.string()).min(1).max(BULK_MAX_ITEMS),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('delete') }),
    z.object({ type: z.literal('archive') }),
    z.object({ type: z.literal('duplicate') }),
    z.object({
      type: z.literal('move_to_board'),
      board_id: z.string(),
      group_id: z.string().optional(),
      /** Source column id → target column id | null (07 §3.4.1). */
      mapping: z.record(z.string(), z.string().nullable()),
    }),
    z.object({ type: z.literal('move_to_group'), group_id: z.string() }),
    /** `value: null` clears the cell; an item the status workflow blocks is skipped. */
    z.object({
      type: z.literal('set_cell'),
      column_id: z.string(),
      value: z.unknown(),
      /** an owner or admin moves items past the status workflow on purpose (logged per item). */
      workflow_override: z.boolean().optional(),
    }),
    /**
     * a link added to / removed from a relation column on every item — each keeps its other links
     * (a picker toggle in one of several checked rows; `set_cell` would copy that row's whole list).
     */
    z.object({
      type: z.literal('change_links'),
      column_id: z.string(),
      add: z.array(z.string()).max(100).default([]),
      remove: z.array(z.string()).max(100).default([]),
    }),
    /** Date / timeline columns move by whole days (negative = earlier). */
    z.object({ type: z.literal('shift_dates'), column_id: z.string(), days: z.number().int().min(-3650).max(3650) }),
    /**
     * Hierarchy moves: under another item or subitem of the same board (its own subitems along
     * items of the board map their cells onto the sub-board by `mapping`, automatic when omitted) …
     */
    z.object({
      type: z.literal('move_under'),
      parent_item_id: z.string(),
      mapping: z.record(z.string(), z.string().nullable()).optional(),
    }),
    /** … or one level up: a sub-subitem under its grandparent, a subitem to an item of the board. */
    z.object({ type: z.literal('move_up') }),
  ]),
});
export type BulkItemsRequest = z.infer<typeof bulkItemsSchema>;
export const bulkResultSchema = z.object({
  ok: z.literal(true),
  batch_id: z.string(),
  /** The summary event: `POST /activity/:event_id/undo` undoes the whole batch. */
  event_id: z.string(),
  done: z.number().int(),
  skipped: z.number().int(),
  /** r19relfilter: relation links left out because the column's filter does not offer them (fill / paste). */
  links_dropped: z.number().int().optional(),
});
export type BulkResult = z.infer<typeof bulkResultSchema>;
export const moveItemToGroupSchema = z.object({
  group_id: z.string(),
  position: positionSchema,
  /**
   * Place between two items of the board, whatever their groups (Kanban / views ordered across groups):
   * the item's position goes between theirs. Wins over `position`.
   */
  between: z.object({ after_id: z.string().nullable(), before_id: z.string().nullable() }).optional(),
});

/** An item after an edit (rename, cell): `event_id` of that edit, so Ctrl+Z can undo it (07 §5.3). */
export const editedItemSchema = itemSchema.extend({
  event_id: z.string().nullable().optional(),
  /** Items a dependency moved with this edit (M8 ד7) — the client reloads them. */
  shifted_item_ids: z.array(z.string()).optional(),
});
export type EditedItem = z.infer<typeof editedItemSchema>;
