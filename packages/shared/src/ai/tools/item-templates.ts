// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import {
  ITEM_TEMPLATE_NAME_MAX,
  ITEM_TEMPLATE_VARS_MAX,
  itemTemplateAnswerSchema,
  itemTemplateVariableSchema,
} from '../../api/item-templates';
import { answer, defineTool, id } from './types';

/**
 * Item templates: an item with its subitems at every depth — values, dates in working days after a
 * date variable, people, text with {variable} fields, updates and files — saved on a board and applied as a new item
 * or as subitems under an item. The same service and rights as the app: reading needs the board, making / changing /
 * deleting a template needs rights to change the board's structure, applying one needs to create items.
 */

const TREE_GUIDE = [
  'A node: {id, name, cells, updates, children}. cells by column key (the board columns at the top, the subitems',
  'columns below), each one of: {kind: value, value (as the column stores it)} | {kind: date, var (a date variable),',
  'from (working days after it), to (a timeline end), time} | {kind: var, var (a person / text / date variable)} |',
  '{kind: text, text (with {variable} fields)} | {kind: files, files: [{asset_id, name}]}.',
  'updates: [{text (with {variable} fields), pinned, files}]. Names may hold {variable} fields.',
  'Variables: [{key (a-z, 0-9, _), label, type: text|date|person, required, default (text, or "today")}].',
].join(' ');

/** The tree as a plain object (MCP tool schemas may not refer to themselves); the server checks it in full. */
const treeInput = z
  .record(z.string(), z.unknown())
  .describe('The template tree: {id, name, cells, updates, children: [nodes like it]} (see the tool description)');

const summary = answer({
  id: z.string(),
  board_id: z.string(),
  name: z.string(),
  category: z.string(),
  nodes: z.number(),
  depth: z.number(),
  version: z.number(),
  variables: z.array(answer({ key: z.string(), label: z.string(), type: z.string(), required: z.boolean() })),
});

export const listItemTemplates = defineTool({
  name: 'list_item_templates',
  title: 'List item templates',
  description:
    "A board's item templates: name, category, how many items (an item and its subitems) and how deep, and the variables applying one asks for. Read one with get_item_template; apply one with apply_item_template.",
  family: 'item_templates',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ board_id: id('Board') }),
  output: answer({ templates: z.array(summary) }),
});

export const getItemTemplate = defineTool({
  name: 'get_item_template',
  title: 'Read an item template',
  description: `One item template with its whole tree and variables. ${TREE_GUIDE}`,
  family: 'item_templates',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ template_id: id('Item template') }),
  output: summary.extend({ root: z.unknown() }),
});

export const createItemTemplate = defineTool({
  name: 'create_item_template',
  title: 'Make an item template',
  description:
    'Makes an item template on a board: from an existing item (item_id: the item and its subitems at every depth, its values, updates and files; dates become working days after a "start" variable, its owner and name become variables) or from a tree you describe (board_id + root). ' +
    TREE_GUIDE,
  family: 'item_templates',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    name: z.string().trim().min(1).max(ITEM_TEMPLATE_NAME_MAX),
    category: z.string().trim().max(60).optional(),
    item_id: id('Item').optional().describe('Save this item (and its subitems) as the template'),
    with_updates: z.boolean().optional().describe('With item_id: keep its updates (default true)'),
    with_files: z.boolean().optional().describe('With item_id: keep its files (default true)'),
    board_id: id('Board').optional().describe('With root: the board the template belongs to'),
    root: treeInput.optional().describe('The tree, when not saving an item'),
    variables: z.array(itemTemplateVariableSchema).max(ITEM_TEMPLATE_VARS_MAX).optional(),
  }),
  output: summary,
});

export const updateItemTemplate = defineTool({
  name: 'update_item_template',
  title: 'Change an item template',
  description: `Renames an item template or replaces its tree / variables (read it first with get_item_template; a new tree is a new version; items made before keep what they got). ${TREE_GUIDE}`,
  family: 'item_templates',
  scope: 'boards:write',
  risk: 'write',
  annotations: { idempotentHint: true },
  input: z.object({
    template_id: id('Item template'),
    name: z.string().trim().min(1).max(ITEM_TEMPLATE_NAME_MAX).optional(),
    category: z.string().trim().max(60).optional(),
    root: treeInput.optional(),
    variables: z.array(itemTemplateVariableSchema).max(ITEM_TEMPLATE_VARS_MAX).optional(),
  }),
  output: summary,
});

export const applyItemTemplate = defineTool({
  name: 'apply_item_template',
  title: 'Apply an item template',
  description:
    "Makes items from an item template: a new item with all its subitems (in group_id, or the first group), or — with parent_item_id — the template's subitems under that item (its empty cells take the template values). Pass the template's variables (see list_item_templates): text, a date YYYY-MM-DD, or user ids for a person. One call = one undoable action.",
  family: 'item_templates',
  scope: 'items:write',
  risk: 'write',
  input: z.object({
    template_id: id('Item template'),
    group_id: id('Group').optional(),
    parent_item_id: id('Item').optional(),
    variables: z.record(z.string(), itemTemplateAnswerSchema).optional(),
  }),
  output: answer({ item_id: z.string(), created: z.number(), skipped: z.array(z.unknown()) }),
});

export const deleteItemTemplate = defineTool({
  name: 'delete_item_template',
  title: 'Delete an item template',
  description:
    'Deletes an item template (out of every menu; items made from it stay). It can be undone. Always ask the user first.',
  family: 'item_templates',
  scope: 'boards:write',
  risk: 'sensitive',
  annotations: { destructiveHint: true },
  input: z.object({ template_id: id('Item template') }),
  output: answer({ ok: z.boolean(), id: z.string() }),
});
