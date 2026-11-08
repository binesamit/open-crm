// SPDX-License-Identifier: AGPL-3.0-only
import {
  AI_STYLE_COUNT_DEFAULT,
  type AiFidelity,
  type AiPhotoMode,
  AppError,
  type AutomationRun,
  type CardFieldsPerRow,
  cardFieldsPerRowOf,
  cardSubitemsOf,
  type CardTabType,
  cellFromText,
  createDashboardSchema,
  createWidgetSchema,
  updateDashboardSchema,
  createDocSchema,
  createFolderSchema,
  createViewSchema,
  createWorkspaceSchema,
  type FlowDraft,
  type FlowEdit,
  type GroupColor,
  itemCardSettingsSchema,
  proposeMapping,
  querySchema,
  richTasks,
  type RichNode,
  resolveCardTabs,
  type TextPerson,
  type toolFilterSchema,
  updateWidgetSchema,
  type WorkSection,
} from '@bines/shared';
import type { z } from 'zod';
import type { AppDeps } from '../../../types';
import { IDOC_TOOL_RUNNERS } from '../../idocs/idocs.tools';
import { helpArticleForAi, searchHelpForAi, tourForAi } from '../../help/help.ai-tools';
import { missingFeatures } from '../../billing/entitlements';
import { ITEM_TEMPLATE_TOOL_RUNNERS } from '../../item-templates/item-templates.tools';
import { actorRegion } from '../../accounts/region';
import { loadAiSettings } from '../ai.service';
import {
  generateImageOnItem,
  listSourceImages,
  listStyleExamples,
  loadSourceFile,
  resolveFidelityBase,
  type SourceImageRef,
} from '../images.service';
import { undoBatch, undoEvent } from '../../activity/undo.service';
import { archiveBoard as archiveBoardSvc, archiveItem as archiveItemSvc } from '../../archive/archive.service';
import {
  createAutomation as createAutomationSvc,
  getAutomation,
  listAutomations as listAutomationsSvc,
  listBoardRuns,
  listRuns,
  redactRecipe,
  redactTitle,
  testAutomation as testAutomationSvc,
  updateAutomation,
} from '../../automations/automations.service';
import {
  createBoard as createBoardSvc,
  createColumn as createColumnSvc,
  createFolder as createFolderSvc,
  createGroup as createGroupSvc,
  createWorkspace as createWorkspaceSvc,
  deleteBoard as deleteBoardSvc,
  deleteColumn as deleteColumnSvc,
  deleteGroup as deleteGroupSvc,
  getBoard as getBoardSvc,
  updateBoard as updateBoardSvc,
  listTemplates,
  listVisibleWorkspaces,
  reorderColumn,
  reorderGroup,
  updateColumn as updateColumnSvc,
  updateGroup as updateGroupSvc,
  workspaceTree,
} from '../../boards/boards.service';
import { toolGetDoc, toolSearchDocs } from '../../docs/docs.ai';
import {
  createDashboard as createDashboardSvc,
  createWidget,
  dashboardColumns,
  deleteDashboard as deleteDashboardSvc,
  deleteWidget,
  duplicateDashboard as duplicateDashboardSvc,
  getDashboard as getDashboardSvc,
  getWidget,
  saveLayout,
  updateDashboard as updateDashboardSvc,
  updateWidget,
  workspaceDashboardEntities,
} from '../../dashboards/dashboards.service';
import { createDoc as createDocSvc } from '../../docs/docs.service';
import { aiEditFile } from '../../files/files.ai-edit';
import { addCellLink } from '../../files/files.links';
import { attachFromUrl, getFile } from '../../files/files.service';
import { createView as createViewSvc } from '../../views/views.service';
import {
  toolFlowsExplainFailure,
  toolFlowsGet,
  toolFlowsRerun,
  toolFlowsSetActive,
  toolFlowsUpdateDraft,
} from '../../flows/flows.ai';
import { toolFlowsDraftCreate, toolFlowsList, toolFlowsRuns } from '../../flows/flows.service';
import { moveItemToBoard as moveItemToBoardSvc } from '../../items/move.service';
import { moveItemInTree } from '../../items/hierarchy.service';
import { myWork as myWorkSvc } from '../../mywork/mywork.service';
import {
  type Actor,
  createItem as createItemSvc,
  deleteItem as deleteItemSvc,
  getItem as getItemSvc,
  loadItem,
  moveItemToGroup,
  updateItem as updateItemSvc,
} from '../../items/items.service';
import { queryItems as queryItemsSvc } from '../../items/query.service';
import { createSubitem } from '../../items/subitems.service';
import { searchEverything } from '../../search/search.service';
import { listTeams } from '../../teams/teams.service';
import { addEntry, listEntries } from '../../time/time.service';
import {
  createUpdate as createUpdateSvc,
  itemActivity as itemActivitySvc,
  listUpdates as listUpdatesSvc,
  replyToUpdate,
  setUpdateTask as setUpdateTaskSvc,
} from '../../updates/updates.service';
import { replyByEmail } from '../../inbound-email/inbound.reply';
import { selectCells } from '../../items/columns-param';
import { listMembers } from '../../users/users.service';

/**
 * TOOL_RUNNERS (the planning notes "AGENTS-MCP" §3.2): every registry tool (`@bines/shared` AI_TOOLS) implemented over the
 * existing services — the same pattern as the automation engine's RUNNERS. A runner never touches a repository:
 * the services check `can()`, view_items, column restrictions and a token's board limit, so a tool can never see or
 * change more than its user (rule 1). `deps.db` is the call's transaction for write tools (see mcp.server.ts).
 */
export type ToolContext = {
  deps: AppDeps;
  actor: Actor;
  /** The token's scopes (whoami). */
  scopes: string[];
  /** The batch every write of this call joins (one tool call = one undoable action). */
  batchId: string | null;
};
/**
 * a tool is not the person — a board's delete-with-code is never passed by the AI or MCP, whatever
 * code the person typed for their own session (no sign-in / token on the actor).
 */
const noPerson = (a: Actor): Actor => ({ ...a, sessionId: null, token: null });

// Inputs are validated against the tool's zod schema before a runner is called.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolRunner = (c: ToolContext, input: any) => Promise<unknown>;

type CellDto = { value: unknown; text: string | null };
type Position = 'top' | 'bottom' | { after_id: string } | { before_id: string };
/** The item card as get_board / update_item_card show it: every tab in order, with the defaults. */
const cardOut = (card: unknown) => ({
  tabs: resolveCardTabs(card),
  fields_per_row: cardFieldsPerRowOf(card),
  subitems: cardSubitemsOf(card),
});

type ColumnOut = { id: string; title: string; type: string; description?: string | null; settings: unknown };
const columnOut = (col: ColumnOut) => ({
  id: col.id,
  title: col.title,
  type: col.type,
  description: col.description ?? null,
  settings: col.settings,
});
/** File download links from `getFile` live 15 minutes (`DOWNLOAD_TTL` in lib/storage.ts). */
const FILE_LINK_TTL_S = 15 * 60;
type ItemDto = Awaited<ReturnType<typeof getItemSvc>>;

const page = <T>(rows: T[], limit: number, cursor?: string) => {
  let offset = 0;
  if (cursor) {
    offset = Number(Buffer.from(cursor, 'base64url').toString());
    if (!Number.isInteger(offset) || offset < 0) throw new AppError('invalid_query', 'Invalid cursor');
  }
  const slice = rows.slice(offset, offset + limit);
  const next = offset + slice.length;
  return { slice, next_cursor: next < rows.length ? Buffer.from(String(next)).toString('base64url') : null };
};

/** An item as the model reads it: ids + name + cells `{text, value}` (empty cells left out). */
const compactItem = (i: ItemDto, columns?: string[]) => {
  const cells: Record<string, CellDto> = {};
  for (const [k, v] of Object.entries(selectCells(i.cells as Record<string, CellDto>, columns)))
    cells[k] = { text: v.text, value: v.value };
  return {
    id: i.id,
    name: i.name,
    board_id: i.board_id,
    group_id: i.group_id,
    parent_item_id: i.parent_item_id,
    key: i.key,
    cells,
    updated_at: i.updated_at,
  };
};

/**
 * An AI's update text: Markdown → a formatted update, unless the account turned that off (Administration → AI ו-MCP,
 * `format_markdown`; sync-ai).
 */
const updateText = async (c: ToolContext, text: string) =>
  (await loadAiSettings(c.deps.db, c.actor.ctx.accountId)).format_markdown ? { markdown: text } : { body: text };

/** The account's people and teams as `cellFromText` reads them (people columns by name or email). */
const textPeople = async (c: ToolContext): Promise<TextPerson[]> => {
  const [members, teams] = await Promise.all([
    listMembers(c.deps, c.actor.ctx, c.actor.user),
    listTeams(c.deps.db, c.actor),
  ]);
  return [
    ...members
      .filter((m) => m.status === 'active')
      .map((m) => ({ id: m.user_id, kind: 'person' as const, name: m.name, email: m.email })),
    ...teams.map((t) => ({ id: t.id, kind: 'team' as const, name: t.name })),
  ];
};

/**
 * Cells from the model: a string for a non-text column is read as text for that type ("Done", "2026-10-05",
 * "Dana") — `cellFromText`, the paste rules. Anything else goes to the service as the column's JSON value, where
 * `parseCellValue` validates it. An unreadable text names what the column accepts so the model can fix it.
 */
const resolveCells = async (c: ToolContext, boardId: string, cells: Record<string, unknown> | undefined) => {
  if (!cells || !Object.keys(cells).length) return cells;
  const board = await getBoardSvc(c.deps.db, c.actor, boardId);
  const byId = new Map(board.columns.map((col) => [col.id, col]));
  let people: TextPerson[] | null = null;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(cells)) {
    const col = byId.get(key);
    if (!col) {
      throw new AppError('unknown_column', `column_not_found: "${key}"`, {
        columns: board.columns.map((x) => ({ id: x.id, title: x.title, type: x.type })),
      });
    }
    if (typeof raw !== 'string' || col.type === 'text') {
      out[key] = raw;
      continue;
    }
    if (col.type === 'people' && !people) people = await textPeople(c);
    // "10/10/2026 14:00" is wall-clock time in the actor's zone (stored as UTC), as typed in a cell.
    const opts = col.type === 'date' ? { region: await actorRegion(c.deps.db, c.actor) } : {};
    const value = cellFromText(col.type, raw, col.settings, people ?? [], opts);
    if (value === undefined) {
      const labels = ((col.settings as { labels?: { label: string }[] }).labels ?? []).map((l) => l.label);
      throw new AppError('invalid_value', `Cannot read "${raw}" for column "${col.title}" (${col.type})`, {
        column_id: key,
        type: col.type,
        ...(labels.length ? { labels } : {}),
      });
    }
    out[key] = value;
  }
  return out;
};

/**
 * Automation secrets never reach a model (plan §8 "אין סודות בהקשר", AI-RT8): an inbound hook's secret, an
 * outgoing webhook's signing secret, header values and full URL are masked in every tool answer — even for a
 * person who may manage the automation (in the app they see them; a model they talk to does not).
 */
const aiRecipe = (recipe: unknown) => redactRecipe(recipe as Parameters<typeof redactRecipe>[0]);
const aiRendered = (type: string, rendered: unknown) => {
  if (type !== 'webhook' || !rendered || typeof rendered !== 'object') return rendered;
  const masked = aiRecipe({ trigger: { type: 'item_created' }, actions: [{ ...rendered, type }] }).actions[0]!;
  const { type: _t, ...rest } = masked as Record<string, unknown>;
  return rest;
};

type ToolFilter = z.infer<typeof toolFilterSchema>;
const toQueryFilter = (f: ToolFilter | undefined) => {
  if (!f) return undefined;
  const rule = (r: { column_id: string; operator: string; values?: unknown[] }) => ({
    kind: 'rule',
    column_id: r.column_id,
    operator: r.operator,
    values: r.values ?? [],
  });
  return {
    kind: 'group',
    operator: f.operator,
    negate: false,
    rules: f.rules.map((r) =>
      'kind' in r && r.kind === 'group'
        ? { kind: 'group', operator: r.operator, negate: false, rules: r.rules.map(rule) }
        : rule(r as { column_id: string; operator: string; values?: unknown[] }),
    ),
  };
};

/** An update's check boxes, only when it has some — set_update_task ticks them by index. */
const tasksOf = (json: unknown) => {
  const tasks = json ? richTasks(json as RichNode) : [];
  return tasks.length ? { tasks } : {};
};

const updateDto = (u: Awaited<ReturnType<typeof listUpdatesSvc>>[number]) => ({
  id: u.id,
  item_id: u.item_id,
  author: u.author,
  text: u.body_text,
  ...tasksOf(u.body_json),
  created_at: u.created_at,
  files: u.files,
  replies: u.replies.map((r) => ({
    id: r.id,
    author: r.author,
    text: r.body_text,
    ...tasksOf(r.body_json),
    created_at: r.created_at,
  })),
});

/** The boards a connection may read, by workspace (sidebar order). */
const workspaceBoards = async (c: ToolContext) => {
  const out = [];
  for (const w of await listVisibleWorkspaces(c.deps.db, c.actor)) {
    const tree = await workspaceTree(c.deps.db, c.actor, w.id).catch(() => null);
    if (!tree) continue;
    out.push({
      id: w.id,
      name: w.name,
      folders: tree.folders.map((f) => ({ id: f.id, name: f.name, parent_folder_id: f.parent_folder_id })),
      boards: tree.boards.map((b) => ({ id: b.id, name: b.name, folder_id: b.folder_id, kind: b.kind })),
    });
  }
  return out;
};

export const TOOL_RUNNERS: Record<string, ToolRunner> = {
  whoami: async (c) => ({
    user: { id: c.actor.user.id, name: c.actor.user.name, email: c.actor.user.email },
    account: { id: c.actor.ctx.accountId, name: c.actor.ctx.account.name, slug: c.actor.ctx.account.slug },
    role: c.actor.ctx.role,
    scopes: c.scopes,
    board_limit: c.actor.ctx.boardLimit ?? null,
    // what the plan leaves out — say so rather than explain a feature the account cannot use.
    missing_features: await missingFeatures(c.deps.db, c.actor.ctx.accountId),
  }),

  search_help: (c, input: { query: string; limit: number }) =>
    searchHelpForAi(c.deps, c.actor, input.query, input.limit),
  get_help_article: (c, input: { article: string }) => helpArticleForAi(c.deps, c.actor, input.article),
  show_me: (c, input: { tour_id: string }) => tourForAi(c.deps, c.actor, input.tour_id),

  list_people: async (c, input: { query?: string; limit: number }) => {
    const q = input.query?.toLocaleLowerCase();
    const members = (await listMembers(c.deps, c.actor.ctx, c.actor.user))
      .filter((m) => m.status === 'active')
      .filter((m) => !q || m.name.toLocaleLowerCase().includes(q) || m.email.toLocaleLowerCase().includes(q))
      .slice(0, input.limit)
      .map((m) => ({ id: m.user_id, name: m.name, email: m.email, role: m.role, title: m.title ?? null }));
    const teams = (await listTeams(c.deps.db, c.actor))
      .filter((t) => !q || t.name.toLocaleLowerCase().includes(q))
      .map((t) => ({ id: t.id, name: t.name, member_ids: t.member_ids }));
    return { people: members, teams };
  },

  list_workspaces: async (c) => ({ workspaces: await workspaceBoards(c) }),

  search_boards: async (c, input: { query: string; limit: number }) => {
    const q = input.query.toLocaleLowerCase();
    const boards = (await workspaceBoards(c)).flatMap((w) =>
      w.boards
        .filter((b) => b.name.toLocaleLowerCase().includes(q))
        .map((b) => ({ ...b, workspace: { id: w.id, name: w.name } })),
    );
    return { boards: boards.slice(0, input.limit) };
  },

  get_board: async (c, input: { board_id: string }) => {
    const b = await getBoardSvc(c.deps.db, c.actor, input.board_id);
    return {
      id: b.id,
      name: b.name,
      description: b.description,
      kind: b.kind,
      item_terminology: b.item_terminology,
      parent_board_id: b.parent_board_id,
      subitems_board_id: b.subitems_board_id,
      columns: b.columns.map((col) => ({
        id: col.id,
        title: col.title,
        type: col.type,
        description: col.description,
        settings: col.settings,
        read_only: col.read_only || col.restricted_edit,
      })),
      groups: b.groups.map((g) => ({ id: g.id, title: g.title, color: g.color })),
      capabilities: b.capabilities,
      card: cardOut(b.card),
    };
  },

  create_board: async (
    c,
    input: {
      workspace_id: string;
      folder_id?: string;
      name?: string;
      kind: 'main' | 'shareable' | 'private';
      template_key?: string;
    },
  ) => {
    // A token limited to some boards may not widen itself with new ones (it could not even read them back).
    if (c.actor.ctx.boardLimit) throw new AppError('forbidden', 'board_limited_token');
    const workspaces = await listVisibleWorkspaces(c.deps.db, c.actor);
    if (!workspaces.some((w) => w.id === input.workspace_id)) throw new AppError('not_found', 'Workspace not found');
    if (input.template_key) {
      const templates = await listTemplates(c.deps.db, c.actor);
      if (!templates.some((t) => t.key === input.template_key))
        throw new AppError('not_found', `template_not_found: "${input.template_key}"`, {
          templates: templates.slice(0, 100).map((t) => ({ key: t.key, name: t.name })),
        });
    }
    const b = await createBoardSvc(c.deps.db, c.actor, {
      workspace_id: input.workspace_id,
      folder_id: input.folder_id,
      name: input.name,
      kind: input.kind,
      template_key: input.template_key,
    });
    return {
      id: b.id,
      name: b.name,
      kind: b.kind,
      workspace_id: b.workspace_id,
      folder_id: b.folder_id,
      subitems_board_id: b.subitems_board_id,
      groups: b.groups.map((g) => ({ id: g.id, title: g.title, color: g.color })),
      columns: b.columns.map((col) => ({ id: col.id, title: col.title, type: col.type })),
    };
  },

  create_group: async (c, input: { board_id: string; title: string; color?: GroupColor; position?: Position }) => {
    const g = await createGroupSvc(c.deps.db, c.actor, input.board_id, {
      title: input.title,
      color: input.color,
      position: input.position,
    });
    return { id: g.id, title: g.title, color: g.color, board_id: input.board_id };
  },

  update_group: async (
    c,
    input: { board_id: string; group_id: string; title?: string; color?: GroupColor; position?: Position },
  ) => {
    if (!input.title && !input.color && !input.position)
      throw new AppError('bad_request', 'Send a title, a color or a position');
    let g: { id: string; title: string; color: string } | undefined;
    if (input.title || input.color)
      g = await updateGroupSvc(c.deps.db, c.actor, input.board_id, input.group_id, {
        title: input.title,
        color: input.color,
      });
    if (input.position) g = await reorderGroup(c.deps.db, c.actor, input.board_id, input.group_id, input.position);
    return { id: g!.id, title: g!.title, color: g!.color, board_id: input.board_id };
  },

  create_column: async (
    c,
    input: {
      board_id: string;
      title: string;
      type: string;
      id?: string;
      description?: string;
      settings?: Record<string, unknown>;
      after_column_id?: string;
      before_column_id?: string;
    },
  ) => {
    const { board_id: boardId, ...rest } = input;
    // a column the assistant makes is a new one — the account's defaults fill what settings leave out.
    return columnOut(await createColumnSvc(c.deps.db, c.actor, boardId, rest, { fillNewDefaults: true }));
  },

  update_column: async (
    c,
    input: {
      board_id: string;
      column_id: string;
      title?: string;
      description?: string | null;
      settings?: Record<string, unknown>;
      position?: Position;
    },
  ) => {
    const { board_id: boardId, column_id: key, position, ...change } = input;
    const changing = Object.values(change).some((v) => v !== undefined);
    if (!changing && !position) throw new AppError('bad_request', 'Send a title, description, settings or position');
    let col: ColumnOut | undefined;
    if (changing) col = await updateColumnSvc(c.deps.db, c.actor, boardId, key, change);
    if (position) col = await reorderColumn(c.deps.db, c.actor, boardId, key, position);
    return columnOut(col!);
  },

  // the item card's tabs — merged over the saved card and saved through PATCH /boards' service.
  update_item_card: async (
    c,
    input: {
      board_id: string;
      tabs?: { id: string; type: CardTabType; title?: string; hidden?: boolean; columns?: string[] }[];
      fields_per_row?: CardFieldsPerRow;
      subitems?: { in_fields?: boolean; show_summary?: boolean; view_id?: string | null };
    },
  ) => {
    const { board_id: boardId, tabs, fields_per_row: perRow, subitems } = input;
    if (!tabs && perRow === undefined && !subitems) {
      throw new AppError('bad_request', 'Send tabs, fields_per_row or subitems');
    }
    const b = await getBoardSvc(c.deps.db, c.actor, boardId);
    if (tabs) {
      const keys = new Set(b.columns.map((col) => col.id));
      const unknown = tabs.flatMap((x) => (x.type === 'fields' ? (x.columns ?? []) : [])).filter((k) => !keys.has(k));
      if (unknown.length) throw new AppError('invalid_value', `Unknown column ids: ${unknown.join(', ')}`);
    }
    const current = b.card;
    const sub = subitems ? { ...cardSubitemsOf(current), ...subitems } : current.subitems;
    if (sub && 'view_id' in sub && sub.view_id === null) delete sub.view_id;
    const card = itemCardSettingsSchema.parse({
      tabs: tabs
        ? tabs.map((x) => ({
            id: x.id,
            type: x.type,
            hidden: x.type === 'updates' ? false : (x.hidden ?? false),
            ...(x.title?.trim() ? { title: x.title.trim() } : {}),
            ...((x.type === 'fields' || x.type === 'subitems') && x.columns ? { columns: x.columns } : {}),
          }))
        : current.tabs,
      ...(sub ? { subitems: sub } : {}),
      ...(perRow !== undefined
        ? { fields_per_row: perRow }
        : current.fields_per_row !== undefined
          ? { fields_per_row: current.fields_per_row }
          : {}),
    });
    const saved = await updateBoardSvc(c.deps.db, c.actor, boardId, { card });
    return { board_id: boardId, card: cardOut(saved.card) };
  },

  // --- more structure: each through the same service (and permission checks) as the UI ----
  create_workspace: async (c, input: { name: string; kind?: 'open' | 'closed' }) => {
    if (c.actor.ctx.boardLimit) throw new AppError('forbidden', 'board_limited_token');
    const w = await createWorkspaceSvc(c.deps.db, c.actor, createWorkspaceSchema.parse(input));
    return { id: w.id, name: w.name, kind: w.kind };
  },

  create_folder: async (c, input: { workspace_id: string; name: string; parent_folder_id?: string }) => {
    if (c.actor.ctx.boardLimit) throw new AppError('forbidden', 'board_limited_token');
    const f = await createFolderSvc(c.deps.db, c.actor, createFolderSchema.parse(input));
    return { id: f.id, name: f.name, workspace_id: f.workspace_id, parent_folder_id: f.parent_folder_id };
  },

  move_board: async (c, input: { board_id: string; folder_id: string | null }) => {
    const b = await updateBoardSvc(c.deps.db, c.actor, input.board_id, { folder_id: input.folder_id });
    return { id: b.id, name: b.name, folder_id: b.folder_id };
  },

  create_view: async (
    c,
    input: { board_id: string; name: string; type?: string; visibility?: string; settings?: Record<string, unknown> },
  ) => {
    const { board_id: boardId, ...rest } = input;
    const v = await createViewSvc(c.deps.db, c.actor, boardId, createViewSchema.parse(rest));
    return { id: v.id, name: v.name, type: v.type, board_id: boardId };
  },

  create_dashboard: async (
    c,
    input: { workspace_id: string; name?: string; folder_id?: string; kind?: string; board_ids?: string[] },
  ) => {
    const { workspace_id: workspaceId, ...rest } = input;
    const d = await createDashboardSvc(c.deps.db, c.actor, workspaceId, createDashboardSchema.parse(rest));
    return { id: d.id, name: d.name, workspace_id: workspaceId };
  },

  list_dashboards: async (c, input: { workspace_id?: string }) => {
    const workspaces = [];
    for (const w of await listVisibleWorkspaces(c.deps.db, c.actor)) {
      if (input.workspace_id && w.id !== input.workspace_id) continue;
      const dashboards = await workspaceDashboardEntities(c.deps.db, c.actor, w.id).catch(() => []);
      if (!dashboards.length && !input.workspace_id) continue;
      workspaces.push({
        id: w.id,
        name: w.name,
        dashboards: dashboards.map((d) => ({ id: d.id, name: d.name, folder_id: d.folder_id, kind: d.kind })),
      });
    }
    if (input.workspace_id && !workspaces.length) throw new AppError('not_found', 'Workspace not found');
    return { workspaces };
  },

  get_dashboard: async (c, input: { dashboard_id: string }) => {
    const d = await getDashboardSvc(c.deps.db, c.actor, input.dashboard_id);
    const cols = await dashboardColumns(c.deps.db, c.actor, input.dashboard_id);
    return {
      id: d.id,
      name: d.name,
      description: d.description,
      workspace_id: d.workspace_id,
      can_edit: d.capabilities['dashboard.edit'],
      boards: d.boards,
      widgets: d.widgets,
      columns: cols.columns.map((col) => ({
        type: col.type,
        title: col.title,
        ...(col.labels.length ? { labels: col.labels.map((l) => l.label) } : {}),
      })),
    };
  },

  add_dashboard_widget: async (
    c,
    input: {
      dashboard_id: string;
      type: string;
      title?: string;
      settings?: Record<string, unknown>;
      position?: unknown;
    },
  ) => {
    const { dashboard_id: dashboardId, ...rest } = input;
    const w = await createWidget(c.deps.db, c.actor, dashboardId, createWidgetSchema.parse(rest));
    return { ...w, dashboard_id: dashboardId };
  },

  update_dashboard_widget: async (
    c,
    input: { widget_id: string; title?: string; settings?: Record<string, unknown>; position?: unknown },
  ) => {
    const current = await getWidget(c.deps.db, c.actor, input.widget_id);
    if (input.title !== undefined || input.settings) {
      await updateWidget(
        c.deps.db,
        c.actor,
        input.widget_id,
        updateWidgetSchema.parse({
          title: input.title,
          // Merged: a model sends only what changes.
          settings: input.settings ? { ...current.settings, ...input.settings } : undefined,
        }),
      );
    }
    if (input.position)
      await saveLayout(c.deps.db, c.actor, current.dashboard_id, {
        widgets: [{ id: input.widget_id, position: input.position as typeof current.position }],
      });
    return getWidget(c.deps.db, c.actor, input.widget_id);
  },

  remove_dashboard_widget: async (c, input: { widget_id: string }) => {
    await deleteWidget(c.deps.db, c.actor, input.widget_id);
    return { ok: true };
  },

  update_dashboard: async (
    c,
    input: {
      dashboard_id: string;
      name?: string;
      description?: string;
      board_ids?: string[];
      filter?: { search?: string; person?: string };
      folder_id?: string | null;
      kind?: 'main' | 'private' | 'shareable';
    },
  ) => {
    const { dashboard_id: id, board_ids: boardIds, filter, ...rest } = input;
    const settings =
      boardIds || filter ? { ...(boardIds ? { board_ids: boardIds } : {}), ...(filter ? { filter } : {}) } : undefined;
    const d = await updateDashboardSvc(
      c.deps.db,
      c.actor,
      id,
      updateDashboardSchema.parse({ ...rest, ...(settings ? { settings } : {}) }),
    );
    return { id: d.id, name: d.name, kind: d.kind, board_ids: d.settings.board_ids, filter: d.settings.filter };
  },

  set_dashboard_layout: async (
    c,
    input: { dashboard_id: string; widgets: { widget_id: string; position: unknown }[] },
  ) => {
    const out = await saveLayout(c.deps.db, c.actor, input.dashboard_id, {
      widgets: input.widgets.map((w) => ({ id: w.widget_id, position: w.position as never })),
    });
    return { widgets: out.widgets };
  },

  duplicate_dashboard_widget: async (c, input: { widget_id: string; title?: string; position?: unknown }) => {
    const src = await getWidget(c.deps.db, c.actor, input.widget_id);
    const w = await createWidget(
      c.deps.db,
      c.actor,
      src.dashboard_id,
      createWidgetSchema.parse({
        type: src.type,
        title: input.title ?? src.title,
        settings: src.settings,
        ...(input.position ? { position: input.position } : {}),
      }),
    );
    return { ...w, dashboard_id: src.dashboard_id };
  },

  duplicate_dashboard: async (c, input: { dashboard_id: string; name?: string }) => {
    const d = await duplicateDashboardSvc(c.deps.db, c.actor, input.dashboard_id, { name: input.name });
    return { id: d.id, name: d.name };
  },

  delete_dashboard: async (c, input: { dashboard_id: string }) => {
    await deleteDashboardSvc(c.deps.db, c.actor, input.dashboard_id);
    return { ok: true };
  },

  create_doc: async (c, input: { workspace_id: string; name?: string; folder_id?: string; kind?: string }) => {
    const { workspace_id: workspaceId, ...rest } = input;
    const d = await createDocSvc(c.deps.db, c.actor, workspaceId, createDocSchema.parse(rest));
    return { id: d.id, name: d.name, workspace_id: workspaceId };
  },

  archive_board: async (c, input: { board_id: string }) => {
    await archiveBoardSvc(c.deps.db, c.actor, input.board_id);
    return { ok: true, archive: true };
  },

  delete_board: async (c, input: { board_id: string }) => {
    await deleteBoardSvc(c.deps.db, c.actor, input.board_id);
    return { ok: true, trash: true };
  },

  delete_group: async (c, input: { board_id: string; group_id: string }) => {
    await deleteGroupSvc(c.deps.db, noPerson(c.actor), input.board_id, input.group_id);
    return { ok: true, trash: true };
  },

  delete_column: async (c, input: { board_id: string; column_id: string }) => {
    await deleteColumnSvc(c.deps.db, c.actor, input.board_id, input.column_id);
    return { ok: true, trash: true };
  },

  query_items: async (
    c,
    input: {
      board_id: string;
      filter?: ToolFilter;
      search?: string;
      sort?: { column_id: string; direction: 'asc' | 'desc' }[];
      scope: 'all' | 'parents' | 'subitems';
      columns?: string[];
      limit: number;
      cursor?: string;
    },
  ) => {
    const parsed = querySchema.safeParse({
      filter: toQueryFilter(input.filter),
      search: input.search,
      sort: input.sort ?? [],
      scope: input.scope,
    });
    if (!parsed.success) {
      throw new AppError('invalid_query', 'Invalid filter', {
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }
    const res = await queryItemsSvc(c.deps.db, c.actor, input.board_id, parsed.data, {
      cursor: input.cursor,
      limit: input.limit,
    });
    return {
      items: res.data.map((i) => compactItem(i as ItemDto, input.columns)),
      total: res.total,
      next_cursor: res.next_cursor,
    };
  },

  get_item: async (c, input: { item_id: string }) => {
    const item = await getItemSvc(c.deps.db, c.actor, input.item_id);
    const board = await getBoardSvc(c.deps.db, c.actor, item.board_id);
    const updates = await listUpdatesSvc(c.deps.db, c.actor, item.id).catch(() => []);
    let subitems: { id: string; name: string }[] = [];
    const subBoardId = board.subitems_board_id ?? (board.parent_board_id ? board.id : null);
    if (subBoardId) {
      const sub = await queryItemsSvc(c.deps.db, c.actor, subBoardId, querySchema.parse({ scope: 'all' }), {
        limit: 500,
      }).catch(() => null);
      subitems = (sub?.data ?? []).filter((s) => s.parent_item_id === item.id).map((s) => ({ id: s.id, name: s.name }));
    }
    return {
      ...compactItem(item),
      group: board.groups.find((g) => g.id === item.group_id) ?? null,
      board: { id: board.id, name: board.name },
      subitems,
      updates_count: updates.length,
      created_at: item.created_at,
    };
  },

  create_item: async (
    c,
    input: {
      board_id?: string;
      parent_item_id?: string;
      name: string;
      group_id?: string;
      cells?: Record<string, unknown>;
      position?: 'top' | 'bottom' | { after_id: string } | { before_id: string };
    },
  ) => {
    if (!!input.board_id === !!input.parent_item_id)
      throw new AppError('bad_request', 'Send board_id, or parent_item_id for a subitem');
    if (input.parent_item_id) {
      const parent = await getItemSvc(c.deps.db, c.actor, input.parent_item_id);
      const board = await getBoardSvc(c.deps.db, c.actor, parent.board_id);
      const subBoard = board.parent_board_id ? board.id : board.subitems_board_id;
      const cells = subBoard ? await resolveCells(c, subBoard, input.cells) : input.cells;
      const created = await createSubitem(c.deps.db, c.actor, parent.id, {
        name: input.name,
        cells,
        position: input.position as never,
      });
      return compactItem(created as ItemDto);
    }
    const cells = await resolveCells(c, input.board_id!, input.cells);
    const created = await createItemSvc(c.deps.db, c.actor, input.board_id!, {
      name: input.name,
      group_id: input.group_id,
      cells,
      position: input.position as never,
    });
    return compactItem(created);
  },

  update_item: async (c, input: { item_id: string; name?: string; cells?: Record<string, unknown> }) => {
    if (!input.name && !input.cells) throw new AppError('bad_request', 'Send a name or cells');
    const item = await getItemSvc(c.deps.db, c.actor, input.item_id);
    const cells = await resolveCells(c, item.board_id, input.cells);
    const updated = await updateItemSvc(c.deps.db, c.actor, item.id, { name: input.name, cells });
    return compactItem(updated);
  },

  move_item: async (
    c,
    input: {
      item_id: string;
      group_id: string;
      position?: 'top' | 'bottom' | { after_id: string } | { before_id: string };
    },
  ) => compactItem(await moveItemToGroup(c.deps.db, c.actor, input.item_id, input.group_id, input.position)),

  move_item_to_board: async (
    c,
    input: { item_id: string; board_id: string; group_id?: string; mapping?: Record<string, string | null> },
  ) => {
    let mapping = input.mapping;
    if (!mapping) {
      // The mapping dialog's proposal over the columns this user sees on both boards (same type + title first).
      const item = await getItemSvc(c.deps.db, c.actor, input.item_id);
      const [from, to] = await Promise.all([
        getBoardSvc(c.deps.db, c.actor, item.board_id),
        getBoardSvc(c.deps.db, c.actor, input.board_id),
      ]);
      mapping = proposeMapping(from.columns, to.columns);
    }
    const r = await moveItemToBoardSvc(c.deps.db, c.actor, input.item_id, {
      board_id: input.board_id,
      group_id: input.group_id,
      mapping,
    });
    return { ok: true, item_id: input.item_id, board_id: input.board_id, dropped: r.dropped, event_id: r.event_id };
  },

  move_item_in_hierarchy: async (c, input: { item_id: string; parent_item_id?: string; level_up?: boolean }) => {
    if (!!input.parent_item_id === !!input.level_up) {
      throw new AppError('invalid_value', 'Give exactly one of parent_item_id / level_up');
    }
    const r = await moveItemInTree(
      c.deps.db,
      c.actor,
      input.item_id,
      input.parent_item_id ? { type: 'move_under', parent_item_id: input.parent_item_id } : { type: 'move_up' },
      c.batchId ?? undefined,
    );
    return { ok: true, item_id: input.item_id, dropped: r.dropped, event_id: r.event_id };
  },

  archive_item: async (c, input: { item_id: string }) => {
    await archiveItemSvc(c.deps.db, noPerson(c.actor), input.item_id);
    return { ok: true };
  },

  delete_item: async (c, input: { item_id: string }) => {
    await deleteItemSvc(c.deps.db, noPerson(c.actor), input.item_id);
    return { ok: true, trash: true };
  },

  list_updates: async (c, input: { item_id: string; limit: number; cursor?: string }) => {
    const all = await listUpdatesSvc(c.deps.db, c.actor, input.item_id);
    const { slice, next_cursor } = page(all, input.limit, input.cursor);
    return { updates: slice.map(updateDto), next_cursor };
  },

  create_update: async (c, input: { item_id: string; text: string }) => {
    const u = await createUpdateSvc(c.deps.db, c.actor, input.item_id, await updateText(c, input.text));
    return { id: u.id, item_id: u.item_id, text: u.body_text, created_at: u.created_at };
  },

  reply_update: async (c, input: { update_id: string; text: string }) => {
    const u = await replyToUpdate(c.deps.db, c.actor, input.update_id, await updateText(c, input.text));
    return { id: u.id, item_id: u.item_id, text: u.body_text, created_at: u.created_at };
  },

  set_update_task: async (c, input: { update_id: string; index: number; checked: boolean }) => {
    const u = await setUpdateTaskSvc(c.deps.db, c.actor, input.update_id, input.index, input.checked);
    return { id: u.id, item_id: u.item_id, ...tasksOf(u.body_json) };
  },
  reply_by_email: async (c, input: { item_id: string; text: string; update_id?: string }) =>
    replyByEmail(c.deps, c.actor, input.item_id, input),

  list_files: async (c, input: { item_id: string }) => {
    const item = await getItemSvc(c.deps.db, c.actor, input.item_id);
    const board = await getBoardSvc(c.deps.db, c.actor, item.board_id);
    const fileColumns = new Set(board.columns.filter((col) => col.type === 'file').map((col) => col.id));
    const files: {
      id: string;
      name: string;
      size?: number | null;
      mime?: string | null;
      version?: number;
      where: string;
    }[] = [];
    for (const [key, cell] of Object.entries(item.cells as Record<string, CellDto>)) {
      if (!fileColumns.has(key)) continue;
      const list =
        (
          cell.value as {
            files?: { id?: string; asset_id?: string; name?: string; size?: number; mime?: string; version?: number }[];
          } | null
        )?.files ?? [];
      for (const f of list) {
        const id = f.asset_id ?? f.id;
        // `version`: the file's current version; `get_file_link` with this id serves it.
        if (id)
          files.push({
            id,
            name: f.name ?? '',
            size: f.size ?? null,
            mime: f.mime ?? null,
            version: f.version ?? 1,
            where: `column:${key}`,
          });
      }
    }
    const updates = await listUpdatesSvc(c.deps.db, c.actor, item.id).catch(() => []);
    for (const u of updates)
      for (const entry of [u, ...u.replies])
        for (const f of entry.files) files.push({ ...f, where: `update:${entry.id}` });
    return { files };
  },

  get_file_link: async (c, input: { file_id: string }) => {
    const f = await getFile(c.deps, c.actor, input.file_id);
    return {
      id: f.id,
      name: f.name,
      size: f.size,
      mime: f.mime,
      download_url: f.download_url,
      expires_in_seconds: FILE_LINK_TTL_S,
    };
  },

  attach_file_from_url: async (c, input: { item_id: string; column_id: string; url: string; file_name?: string }) => {
    const f = await attachFromUrl(c.deps, c.actor, input.item_id, input.column_id, {
      url: input.url,
      name: input.file_name,
    });
    return { ...f, item_id: input.item_id, column_id: input.column_id };
  },

  add_file_link: async (c, input: { item_id: string; column_id: string; url: string; name?: string }) => {
    const link = await addCellLink(c.deps.db, c.actor, input.item_id, input.column_id, input);
    return { id: link.id, url: link.url, name: link.name, item_id: input.item_id, column_id: input.column_id };
  },

  generate_image: async (
    c,
    input: {
      item_id: string;
      prompt: string;
      column_id?: string;
      update_text?: string;
      size?: string;
      quality?: string;
      count: number;
      file_name?: string;
      source_file_id?: string;
      source_column_id?: string;
      source_column_ids?: string[];
      style_column_id?: string;
      style_filter?: ToolFilter;
      style_count?: number;
      photo_mode?: AiPhotoMode;
      fidelity?: AiFidelity;
      fidelity_base_column_id?: string;
    },
  ) => {
    // Image to image: a file the caller may read (as `get_file_link`), or the item's images in file
    // columns it may see — `source_column_id` its newest one, `source_column_ids` all of theirs in column order (the
    // newest the model takes) — read from storage on the server, never a link.
    const images = input.source_file_id ? [await loadSourceFile(c.deps, c.actor, input.source_file_id)] : [];
    const many = (input.source_column_ids ?? []).filter((k) => k !== input.source_column_id);
    const sources = input.source_file_id
      ? []
      : [
          ...(input.source_column_id
            ? await listSourceImages(c.deps, c.actor, input.item_id, [input.source_column_id], 1)
            : []),
          ...(many.length ? await listSourceImages(c.deps, c.actor, input.item_id, many, 'all') : []),
        ];
    if ((input.source_column_id || many.length) && !input.source_file_id && !sources.length)
      throw new AppError('unprocessable', 'ai_no_source_image', {
        column_id: input.source_column_id ?? many[0],
      });
    // Style examples (round 3): other items' newest images in that column (matching the filter), as the caller reads
    // them — the same helper as the AI column and the automation action.
    let examples: SourceImageRef[] = [];
    if (input.style_column_id) {
      const filter = querySchema.safeParse({ filter: toQueryFilter(input.style_filter) });
      if (!filter.success) throw new AppError('invalid_query', 'Invalid style_filter');
      const { item } = await loadItem(c.deps.db, c.actor, input.item_id);
      examples = await listStyleExamples(c.deps, c.actor, item, {
        column: input.style_column_id,
        filter: filter.data.filter ?? null,
        count: input.style_count ?? AI_STYLE_COUNT_DEFAULT,
      });
    }
    // Round 4: a locked base (the item's base column, else the newest style example; none = close, said back).
    const fid = await resolveFidelityBase(
      c.deps,
      c.actor,
      input.item_id,
      input.fidelity ?? 'free',
      input.fidelity_base_column_id,
      examples,
    );
    // The account's image connection / model (Administration → AI → images) — never the model's choice.
    const out = await generateImageOnItem(
      c.deps,
      c.actor,
      { itemId: input.item_id, columnKey: input.column_id ?? null, updateText: input.update_text ?? null },
      {
        prompt: input.prompt,
        size: input.size ?? null,
        quality: input.quality ?? null,
        count: input.count,
        fileName: input.file_name ?? null,
        ...(images.length ? { images } : {}),
        ...(sources.length ? { sources } : {}),
        ...(examples.length ? { examples } : {}),
        photoMode: input.photo_mode ?? 'together',
        fidelity: fid.fidelity,
        base: fid.base,
      },
    );
    return fid.note ? { ...out, note: fid.note } : out;
  },

  // "Ask the AI for a change": the same service as POST /files/{id}/ai-edit — the caller's rights on
  // the cell, the AI checks, the account's own image model; the guard in front of every tool call is the rate.
  edit_file_image: async (c, input: { file_id: string; instruction: string; version_id?: string }) => {
    const v = await aiEditFile(c.deps, c.actor, input.file_id, {
      instruction: input.instruction,
      versionId: input.version_id ?? null,
    });
    return {
      file_id: input.file_id,
      id: v.id,
      version: v.version,
      from_version: v.from_version,
      name: v.name,
      size: v.size,
      mime: v.mime,
      model: v.model,
      cost_usd: v.cost_usd,
    };
  },

  search: async (c, input: { query: string; include_archived: boolean }) => {
    const r = await searchEverything(c.deps.db, c.actor, input.query, { archived: input.include_archived });
    return r;
  },

  my_work: async (c, input: { sections?: WorkSection[]; limit: number }) => {
    const w = await myWorkSvc(c.deps.db, c.actor);
    const boards = new Map(w.boards.map((b) => [b.id, b]));
    const all = w.sections.filter((s) => !input.sections || input.sections.includes(s.key)).flatMap((s) => s.items);
    return {
      today: w.today,
      items: all.slice(0, input.limit).map((i) => {
        const b = boards.get(i.board_id);
        const text = (col: { id: string } | null | undefined) => (col ? (i.cells[col.id]?.text ?? null) : null);
        return {
          id: i.id,
          name: i.name,
          board_id: i.board_id,
          board_name: b?.name ?? null,
          parent: i.parent,
          group: i.group ? { id: i.group.id, title: i.group.title } : null,
          section: i.section,
          date: i.date,
          status: text(b?.status_column),
        };
      }),
      truncated: w.truncated || all.length > input.limit,
    };
  },

  search_docs: (c, input: { query: string; limit: number }) =>
    toolSearchDocs(c.deps.db, c.actor, input.query, input.limit),

  get_doc: (c, input: { doc_id: string }) => toolGetDoc(c.deps.db, c.actor, input.doc_id),

  list_automations: async (c, input: { board_id: string }) => {
    const { data } = await listAutomationsSvc(c.deps.db, c.actor, input.board_id);
    return {
      automations: data.map((a) => ({
        id: a.id,
        title: redactTitle(a.title),
        is_active: a.is_active,
        recipe: aiRecipe(a.recipe),
        deactivated_reason: a.deactivated_reason,
        last_run_at: a.last_run_at,
      })),
    };
  },

  create_automation: async (
    c,
    input: { board_id: string; title?: string; recipe: Record<string, unknown>; is_active: boolean },
  ) => {
    const a = await createAutomationSvc(c.deps.db, c.actor, input.board_id, {
      title: input.title,
      recipe: input.recipe,
      is_active: input.is_active,
    });
    return {
      id: a.id,
      title: redactTitle(a.title),
      is_active: a.is_active,
      recipe: aiRecipe(a.recipe),
      warnings: a.warnings,
    };
  },

  set_automation_active: async (c, input: { automation_id: string; is_active: boolean }) => {
    const current = await getAutomation(c.deps.db, c.actor, input.automation_id);
    if (current.is_active === input.is_active) return { id: current.id, is_active: current.is_active };
    const a = await updateAutomation(c.deps.db, c.actor, input.automation_id, { is_active: input.is_active }, null);
    return { id: a.id, is_active: a.is_active };
  },

  test_automation: async (c, input: { automation_id: string; item_id?: string }) => {
    // Always a dry run: conditions and rendered actions, nothing written (a real test run is not a tool).
    const r = await testAutomationSvc(c.deps, c.actor, input.automation_id, { item_id: input.item_id, dry_run: true });
    return { ...r, actions: r.actions.map((x) => ({ ...x, rendered: aiRendered(x.type, x.rendered) })) };
  },

  automation_runs: async (
    c,
    input: {
      automation_id?: string;
      board_id?: string;
      status?: AutomationRun['status'];
      item_id?: string;
      include_log: boolean;
      limit: number;
      cursor?: string;
    },
  ) => {
    const q = { status: input.status, item_id: input.item_id, limit: input.limit, before: input.cursor };
    const r = input.automation_id
      ? await listRuns(c.deps.db, c.actor, input.automation_id, q)
      : await listBoardRuns(c.deps.db, c.actor, input.board_id!, q);
    return {
      runs: r.data.map(({ log, ...run }) => (input.include_log ? { ...run, log } : run)),
      next_cursor: r.next,
    };
  },

  list_time_entries: async (c, input: { item_id: string; limit: number }) => ({
    entries: (await listEntries(c.deps.db, c.actor, input.item_id)).slice(0, input.limit),
  }),

  log_time: async (
    c,
    input: {
      item_id: string;
      column_id: string;
      started_at: string;
      ended_at?: string;
      duration_minutes?: number;
      note?: string;
    },
  ) => {
    if (!!input.ended_at === !!input.duration_minutes)
      throw new AppError('bad_request', 'Send ended_at or duration_minutes');
    return addEntry(c.deps.db, c.actor, input.item_id, {
      column_id: input.column_id,
      started_at: input.started_at,
      ended_at: input.ended_at,
      duration_s: input.duration_minutes ? input.duration_minutes * 60 : undefined,
      note: input.note,
    });
  },

  item_activity: async (c, input: { item_id: string; limit: number }) => ({
    events: (await itemActivitySvc(c.deps.db, c.actor, input.item_id)).slice(0, input.limit),
  }),

  undo: async (c, input: { batch_id?: string; event_id?: string }) => {
    const r = input.batch_id
      ? await undoBatch(c.deps.db, c.actor, input.batch_id)
      : await undoEvent(c.deps.db, c.actor, input.event_id!);
    return { ok: true, undone: r.undone };
  },

  // External flows: admins (and members of a connection opened to them) read; creating is the
  // sensitive write — it reaches the platform only after a person approved it, and the flow is created switched off.
  flows_list: (c, input: { connection_id?: string }) => toolFlowsList(c.deps, c.actor, input.connection_id),
  flows_runs: (c, input: { connection_id: string; flow_id?: string; status: 'error' | 'all'; limit: number }) =>
    toolFlowsRuns(c.deps, c.actor, input),
  flows_draft_create: (c, input: { connection_id: string; draft: FlowDraft }) =>
    toolFlowsDraftCreate(c.deps, c.actor, input),
  // Operating and editing: each write is sensitive (a person approves it first); an edit is saved
  // switched off unless the person said otherwise.
  flows_get: (c, input: { connection_id: string; flow_id: string }) => toolFlowsGet(c.deps, c.actor, input),
  flows_explain_failure: (c, input: { connection_id: string; flow_id?: string; run_id?: string }) =>
    toolFlowsExplainFailure(c.deps, c.actor, input),
  flows_set_active: (c, input: { connection_id: string; flow_id: string; active: boolean }) =>
    toolFlowsSetActive(c.deps, c.actor, input),
  flows_rerun: (c, input: { connection_id: string; run_id: string; flow_id?: string }) =>
    toolFlowsRerun(c.deps, c.actor, input),
  flows_update_draft: (c, input: { connection_id: string; flow_id: string; edits: FlowEdit[]; keep_active: boolean }) =>
    toolFlowsUpdateDraft(c.deps, c.actor, input), // Interactive documents: the same service as the app and the REST API.
  ...IDOC_TOOL_RUNNERS,
  ...ITEM_TEMPLATE_TOOL_RUNNERS,
};
