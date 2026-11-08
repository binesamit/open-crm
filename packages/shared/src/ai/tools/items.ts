// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { FILTER_OPERATORS } from '../../query/filter';
import { answer, cellsInput, cursor, defineTool, id, limit, okAnswer, position } from './types';

/**
 * Items (§4 "פריטים" + "רגיש"): the 13-FILTERS query model, cursor paging and field selection; writes through the
 * item services with the user's rights. The filter is the query model two levels deep (no recursive $ref in the
 * JSON schema — older MCP clients choke on it); the runner parses it with the real `querySchema`.
 */
const rule = z.object({
  column_id: z.string().min(1).max(64).describe('Column id, or __group__ / __name__ / __created_at__'),
  operator: z.enum(FILTER_OPERATORS),
  values: z
    .array(z.unknown())
    .max(200)
    .optional()
    .describe('Status / dropdown: label ids or texts; people: user ids or "me"; dates: YYYY-MM-DD'),
});
const group = z.object({
  kind: z.literal('group'),
  operator: z.enum(['and', 'or']),
  rules: z.array(rule).max(50),
});
export const toolFilterSchema = z
  .object({
    operator: z.enum(['and', 'or']).default('and'),
    rules: z.array(z.union([group, rule])).max(50),
  })
  .describe('Filter rules (AND / OR, one nested level)');

const itemAnswer = answer({
  id: z.string(),
  name: z.string(),
  board_id: z.string(),
  cells: z.record(z.string(), z.unknown()),
});

export const queryItems = defineTool({
  name: 'query_items',
  title: 'Query items',
  description:
    'Items of a board matching a filter / text search, sorted, one page at a time (next_cursor). Each item has its cells keyed by column id ({text, value}). Use get_board first to learn the column ids and labels. Pass `columns` to return only some cells.',
  family: 'items',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({
    board_id: id('Board'),
    filter: toolFilterSchema.optional(),
    search: z.string().max(200).optional().describe('Free text over the name and every cell'),
    sort: z
      .array(z.object({ column_id: z.string().max(64), direction: z.enum(['asc', 'desc']).default('asc') }))
      .max(5)
      .optional(),
    scope: z.enum(['all', 'parents', 'subitems']).default('parents'),
    columns: z.array(z.string().max(64)).max(50).optional().describe('Only these column ids in `cells`'),
    limit: limit(25),
    cursor,
  }),
  output: answer({ items: z.array(itemAnswer), total: z.number(), next_cursor: z.string().nullable() }),
});

export const getItem = defineTool({
  name: 'get_item',
  title: 'Item details',
  description:
    'One item: every visible cell, its group, its subitems (ids and names) and how many updates it has. Use it when the user points at one item; list_updates for its conversation, item_activity for its history.',
  family: 'items',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ item_id: id('Item') }),
  output: itemAnswer,
});

export const createItem = defineTool({
  name: 'create_item',
  title: 'Create item',
  description:
    'Creates an item on a board (in a group, or the first group), optionally with cell values. To create a subitem pass parent_item_id instead of board_id.',
  family: 'items',
  scope: 'items:write',
  risk: 'write',
  input: z.object({
    board_id: id('Board').optional(),
    parent_item_id: id('Parent item').optional().describe('Creates a subitem under this item'),
    name: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .optional()
      .describe('Required unless the board computes item names from columns (then it is ignored)'),
    group_id: id('Group').optional(),
    cells: cellsInput.optional(),
    position,
  }),
  output: itemAnswer,
});

export const updateItem = defineTool({
  name: 'update_item',
  title: 'Update item',
  description:
    'Renames an item and / or sets cell values (see cells). One call = one undoable action. On a board that computes item names from columns, change those columns instead (a rename answers item_name_computed).',
  family: 'items',
  scope: 'items:write',
  risk: 'write',
  annotations: { idempotentHint: true },
  input: z.object({
    item_id: id('Item'),
    name: z.string().trim().min(1).max(255).optional(),
    cells: cellsInput.optional(),
  }),
  output: itemAnswer,
});

export const moveItem = defineTool({
  name: 'move_item',
  title: 'Move item to a group',
  description: 'Moves a top-level item to another group of its board (or reorders it inside its group).',
  family: 'items',
  scope: 'items:write',
  risk: 'write',
  input: z.object({ item_id: id('Item'), group_id: id('Group'), position }),
  output: itemAnswer,
});

export const moveItemToBoard = defineTool({
  name: 'move_item_to_board',
  title: 'Move item to another board',
  description:
    'Moves a top-level item (with its subitems, updates and history) to another board, into a group there (default: its first group). Cells follow `mapping` {source column id: target column id | null}; omitted = matched automatically by type and title. Cells with no target column are dropped (undo restores them). Ask the user first.',
  family: 'items',
  scope: 'items:write',
  risk: 'sensitive',
  input: z.object({
    item_id: id('Item'),
    board_id: id('Target board'),
    group_id: id('Target group').optional(),
    mapping: z
      .record(z.string(), z.string().nullable())
      .optional()
      .describe('Source column id → target column id, or null to leave the value behind'),
  }),
  output: answer({ ok: z.boolean(), item_id: z.string(), board_id: z.string(), dropped: z.number() }),
});

export const moveItemInHierarchy = defineTool({
  name: 'move_item_in_hierarchy',
  title: 'Move item in the hierarchy',
  description:
    'Moves an item or subitem inside the hierarchy of its board: under another item or subitem of the same board (`parent_item_id`; an item becomes a subitem, its cells mapped onto the subitem columns by type and title), or one level up (`level_up`: a sub-subitem under its grandparent, a subitem to an item of the board). Its own subitems come along; the hierarchy depth of the board is kept. Give exactly one of parent_item_id / level_up.',
  family: 'items',
  scope: 'items:write',
  risk: 'write',
  input: z.object({
    item_id: id('Item or subitem'),
    parent_item_id: id('New parent (an item or subitem of the same board)').optional(),
    level_up: z.boolean().optional().describe('true: one level up instead of a new parent'),
  }),
  output: answer({ ok: z.boolean(), item_id: z.string(), dropped: z.number() }),
});

export const archiveItem = defineTool({
  name: 'archive_item',
  title: 'Archive item',
  description: 'Archives an item (it leaves the board; it can be restored from the archive).',
  family: 'items',
  scope: 'items:write',
  risk: 'write',
  input: z.object({ item_id: id('Item') }),
  output: okAnswer,
});

export const deleteItem = defineTool({
  name: 'delete_item',
  title: 'Delete item (to trash)',
  description: 'Deletes an item and its subitems to the trash (restorable for 30 days). Ask the user first.',
  family: 'items',
  scope: 'items:write',
  risk: 'sensitive',
  input: z.object({ item_id: id('Item') }),
  output: okAnswer,
});
