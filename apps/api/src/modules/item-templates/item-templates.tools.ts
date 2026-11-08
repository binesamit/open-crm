// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type ItemTemplateDto,
  type ItemTemplateSummary,
  itemTemplateNodeSchema,
  saveItemAsTemplateSchema,
} from '@bines/shared';
import type { ToolRunner } from '../ai/tools/runners';
import * as svc from './item-templates.service';

/**
 * The item-template tools of the AI registry (MCP, the assistant, agents): thin runners over the
 * same service as the app and the REST API (the board to read; its structure to make / change / delete; creating
 * items to apply). A tree sent by a model is checked in full here (the tool schema keeps it a plain object).
 */
const summary = (t: ItemTemplateSummary) => ({
  id: t.id,
  board_id: t.board_id,
  name: t.name,
  category: t.category,
  nodes: t.nodes,
  depth: t.depth,
  version: t.version,
  variables: t.variables.map((v) => ({ key: v.key, label: v.label, type: v.type, required: v.required })),
});

const treeOf = (root: unknown) => {
  const r = itemTemplateNodeSchema.safeParse(root);
  if (!r.success)
    throw new AppError('validation_failed', 'Invalid template tree', {
      issues: r.error.issues.slice(0, 10).map((i) => ({ path: i.path, message: i.message })),
    });
  return r.data;
};

export const ITEM_TEMPLATE_TOOL_RUNNERS: Record<string, ToolRunner> = {
  list_item_templates: async (c, input: { board_id: string }) => ({
    templates: (await svc.listItemTemplates(c.deps.db, c.actor, input.board_id)).data.map(summary),
  }),

  get_item_template: async (c, input: { template_id: string }) => {
    const t: ItemTemplateDto = await svc.getItemTemplate(c.deps.db, c.actor, input.template_id);
    return { ...summary(t), description: t.description, root: t.root };
  },

  create_item_template: async (
    c,
    input: {
      name: string;
      category?: string;
      item_id?: string;
      with_updates?: boolean;
      with_files?: boolean;
      board_id?: string;
      root?: unknown;
      variables?: unknown[];
    },
  ) => {
    if (!!input.item_id === !!input.root)
      throw new AppError('bad_request', 'Send item_id (save an item), or board_id with root (a tree)');
    if (input.item_id)
      return summary(
        await svc.saveItemAsTemplate(
          c.deps,
          c.actor,
          input.item_id,
          saveItemAsTemplateSchema.parse({
            name: input.name,
            category: input.category ?? '',
            ...(input.with_updates !== undefined ? { with_updates: input.with_updates } : {}),
            ...(input.with_files !== undefined ? { with_files: input.with_files } : {}),
          }),
        ),
      );
    if (!input.board_id) throw new AppError('bad_request', 'board_id is needed with root');
    return summary(
      await svc.createItemTemplate(c.deps.db, c.actor, input.board_id, {
        name: input.name,
        category: input.category ?? '',
        description: '',
        variables: (input.variables ?? []) as never,
        root: treeOf(input.root),
      }),
    );
  },

  update_item_template: async (
    c,
    input: { template_id: string; name?: string; category?: string; root?: unknown; variables?: unknown[] },
  ) =>
    summary(
      await svc.updateItemTemplate(c.deps.db, c.actor, input.template_id, {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...(input.root !== undefined ? { root: treeOf(input.root) } : {}),
        ...(input.variables !== undefined ? { variables: input.variables as never } : {}),
      }),
    ),

  apply_item_template: async (
    c,
    input: { template_id: string; group_id?: string; parent_item_id?: string; variables?: Record<string, unknown> },
  ) => {
    const r = await svc.applyItemTemplate(c.deps, c.actor, input.template_id, {
      ...(input.group_id ? { group_id: input.group_id } : {}),
      ...(input.parent_item_id ? { parent_item_id: input.parent_item_id } : {}),
      position: 'bottom',
      variables: (input.variables ?? {}) as never,
    });
    return { item_id: r.item_id, created: r.created, skipped: r.skipped };
  },

  delete_item_template: async (c, input: { template_id: string }) =>
    svc.deleteItemTemplate(c.deps.db, c.actor, input.template_id),
};
