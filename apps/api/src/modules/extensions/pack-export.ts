// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type ExtensionManifest, extensionManifestSchema, type Recipe } from '@bines/shared';
import { redactRecipe, redactTitle } from '../automations/automations.service';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { loadBoardAccess } from '../boards/boards.access';
import { boardSnapshot } from '../boards/board-copy.service';
import { automationsOfBoards } from './extensions.repo';
import { getAutomationTemplate } from '../automations/templates.service';
import { assertAccountAdmin } from '../../lib/account-admin';
import { EXTENSION_ADMINS } from './extensions.service';

/**
 * "Save as pack" (D27 ת1, MARKETPLACE §6): boards of this account → one data pack (a manifest): each board as a
 * native template (no items), a starter kit that makes them all in one workspace, and — optionally — their
 * automations as recipes (they load inactive). Nothing is written here; importing = installing the manifest in
 * another account (Administration → Extensions → paste).
 */
export const exportPack = async (
  db: Db,
  a: Actor,
  input: {
    key: string;
    name: string;
    board_ids: string[];
    include_automations: boolean;
    automation_template_ids?: string[];
  },
): Promise<ExtensionManifest> => {
  assertAccountAdmin(a.ctx, EXTENSION_ADMINS);
  const ids = [...new Set(input.board_ids)];
  const prefix = input.key.replace(/-/g, '_').slice(0, 30);
  const templates: Record<string, unknown>[] = [];
  const keyOfBoard = new Map(ids.map((id, i) => [id, `${prefix}_${i + 1}`]));
  // Relation columns between the pack's boards link the boards the kit makes (r19relfilter: with their filters).
  const refs = new Map(ids.map((id) => [id, `@${keyOfBoard.get(id)!}`]));
  for (const id of ids) {
    const access = await loadBoardAccess(db, a.ctx, a.user, id);
    if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
    templates.push(await boardSnapshot(db, a, access, { key: keyOfBoard.get(id)!, name: access.board.name, refs }));
  }
  const recipes = input.include_automations
    ? (await automationsOfBoards(db, a.ctx.accountId, ids)).map((r, i) => ({
        key: `r${i + 1}`,
        board: keyOfBoard.get(r.boardId!)!,
        // EXT-RT4: a pack is a file people pass around — webhook URLs, headers and signing secrets stay here
        // (masked like for a reader who may not manage the automation; it loads inactive and is filled in again).
        title: redactTitle(r.title),
        recipe: redactRecipe(r.recipe as unknown as Recipe) as unknown as Record<string, unknown>,
      }))
    : [];
  // Account automation templates (their recipes already hold no secrets: a webhook URL is a blank).
  const automationTemplates = [];
  for (const [i, id] of [...new Set(input.automation_template_ids ?? [])].entries()) {
    const t = await getAutomationTemplate(db, { ...a, requestId: a.requestId ?? '' }, id);
    automationTemplates.push({
      key: `t${i + 1}`,
      name: t.name,
      description: t.description,
      category: t.category,
      recipe: t.recipe,
      slots: t.slots,
    });
  }
  return extensionManifestSchema.parse({
    manifest_version: 1,
    id: input.key,
    name: input.name,
    version: '1.0.0',
    publisher: { name: a.ctx.account.name },
    permissions: [],
    origins: [],
    features: [],
    data: {
      board_templates: templates,
      starter_kit: {
        workspace_name: input.name,
        folders: [],
        boards: templates.map((t) => ({ template: t.key as string })),
      },
      automation_recipes: recipes,
      automation_templates: automationTemplates,
    },
  });
};
