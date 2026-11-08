// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { GROUP_PALETTE } from '../../colors';
import { columnTypes } from '../../columns';
import { CARD_TAB_TYPES, cardFieldsPerRowSchema } from '../../views/card';
import { VIEW_TYPES } from '../../views/settings';
import { answer, defineTool, id, limit, okAnswer } from './types';

/** Context and structure: who am I, the people, workspaces and boards (§4 table, rows "הקשר" + "מבנה"). */

export const whoami = defineTool({
  name: 'whoami',
  title: 'Who am I',
  description:
    "The signed-in user, the account and the role this connection acts with, the token scopes, and what the account's plan does not include (missing_features: say so instead of explaining a feature the account cannot use). Call first when unsure what you may do.",
  family: 'context',
  scope: 'any',
  risk: 'read',
  input: z.object({}),
  output: answer({
    user: answer({ id: z.string(), name: z.string(), email: z.string() }),
    account: answer({ id: z.string(), name: z.string() }),
    role: z.string(),
    scopes: z.array(z.string()),
    missing_features: z.array(z.string()),
  }),
});

export const listPeople = defineTool({
  name: 'list_people',
  title: 'List people and teams',
  description:
    'Active people and teams of the account (ids, names, emails). Use the ids for people columns and mentions.',
  family: 'context',
  scope: 'users:read',
  risk: 'read',
  input: z.object({
    query: z.string().max(100).optional().describe('Part of a name or email'),
    limit: limit(50),
  }),
  output: answer({ people: z.array(answer({ id: z.string(), name: z.string() })), teams: z.array(answer({})) }),
});

export const listWorkspaces = defineTool({
  name: 'list_workspaces',
  title: 'List workspaces and boards',
  description:
    'Workspaces the user can see, each with its folders and the boards in it (ids and names) — the map of the account. Use it to orient yourself or find where to create something; search_boards is quicker for one board by name.',
  family: 'structure',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({}),
  output: answer({ workspaces: z.array(answer({ id: z.string(), name: z.string(), boards: z.array(answer({})) })) }),
});

export const searchBoards = defineTool({
  name: 'search_boards',
  title: 'Find boards by name',
  description:
    'Boards whose name contains the text (only boards this connection may read): the fastest way to find a board the user names ("the leads board"). Then get_board for its columns and groups.',
  family: 'structure',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ query: z.string().trim().min(1).max(100), limit: limit(20) }),
  output: answer({ boards: z.array(answer({ id: z.string(), name: z.string() })) }),
});

export const getBoard = defineTool({
  name: 'get_board',
  title: 'Board structure',
  description:
    "A board's columns (id, type, title, labels / settings), groups and subitems board — what you need before reading or writing items — and its item card (card: the card's tabs in order, fields per row, how subitems show). Hidden columns are left out.",
  family: 'structure',
  scope: 'boards:read',
  risk: 'read',
  input: z.object({ board_id: id('Board') }),
  output: answer({ id: z.string(), name: z.string(), columns: z.array(answer({})), groups: z.array(answer({})) }),
});

// ---- structure writes (§4 "מבנה": create_board, create_group, update_group, create_column, update_column) ----

const groupColor = z.enum(GROUP_PALETTE).describe('A group colour key of the palette');
const anchoredPosition = (what: string) =>
  z
    .union([z.enum(['top', 'bottom']), z.object({ after_id: z.string() }), z.object({ before_id: z.string() })])
    .optional()
    .describe(`'top', 'bottom' or {after_id} / {before_id} of another ${what} of the board`);
const columnAnswer = answer({ id: z.string(), title: z.string(), type: z.string() });
const groupAnswer = answer({ id: z.string(), title: z.string(), color: z.string() });

export const createBoard = defineTool({
  name: 'create_board',
  title: 'Create a board',
  description:
    'Creates a board in a workspace (optionally in one of its folders): blank (one group and the name column) or from a board template by template_key. An unknown template_key returns the available templates (key + name). Returns the new board with its groups and columns.',
  family: 'structure',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    workspace_id: id('Workspace'),
    folder_id: id('Folder').optional(),
    name: z.string().trim().min(1).max(255).optional(),
    kind: z
      .enum(['main', 'shareable', 'private'])
      .default('main')
      .describe('main: the workspace sees it; private: only its subscribers; shareable: guests may be invited'),
    template_key: z.string().max(64).optional().describe('A board template key; omit for a blank board'),
  }),
  output: answer({
    id: z.string(),
    name: z.string(),
    groups: z.array(groupAnswer),
    columns: z.array(columnAnswer),
  }),
});

export const createGroup = defineTool({
  name: 'create_group',
  title: 'Create a group',
  description:
    'Adds a group to a board (at the top unless position says otherwise), with a colour or the next free one.',
  family: 'structure',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    board_id: id('Board'),
    title: z.string().trim().min(1).max(255),
    color: groupColor.optional(),
    position: anchoredPosition('group'),
  }),
  output: groupAnswer,
});

export const updateGroup = defineTool({
  name: 'update_group',
  title: 'Update a group',
  description: 'Renames a group, changes its colour and / or moves it among the groups of its board.',
  family: 'structure',
  scope: 'boards:write',
  risk: 'write',
  annotations: { idempotentHint: true },
  input: z.object({
    board_id: id('Board'),
    group_id: id('Group'),
    title: z.string().trim().min(1).max(255).optional(),
    color: groupColor.optional(),
    position: anchoredPosition('group'),
  }),
  output: groupAnswer,
});

export const createColumn = defineTool({
  name: 'create_column',
  title: 'Create a column',
  description: `Adds a column to a board (last, or after / before another column). type is one of: ${columnTypes
    .creatable()
    .map((d) => d.type)
    .join(
      ', ',
    )}. settings is the type's JSON as get_board shows it (e.g. status labels [{id, label, color, index}]); omitted = the type's defaults; keys left out take the account's defaults for new columns (a numbers column shows a thousands separator unless settings say thousands: false). Invalid settings return issues to fix.`,
  family: 'structure',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    board_id: id('Board'),
    title: z.string().trim().min(1).max(255),
    type: z.string().min(1).max(40).describe('Column type'),
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,19}$/)
      .optional()
      .describe('Optional column id (lowercase, unique on the board); generated when omitted'),
    description: z.string().max(1000).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    after_column_id: z.string().max(64).optional(),
    before_column_id: z.string().max(64).optional(),
  }),
  output: columnAnswer,
});

export const updateColumn = defineTool({
  name: 'update_column',
  title: 'Update a column',
  description:
    'Renames a column, changes its description or settings (status / dropdown labels: send the whole labels list — labels still used by items are kept, deactivated) and / or moves it among the columns (the name column stays first).',
  family: 'structure',
  scope: 'boards:write',
  risk: 'write',
  annotations: { idempotentHint: true },
  input: z.object({
    board_id: id('Board'),
    column_id: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(1000).nullable().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    position: anchoredPosition('column'),
  }),
  output: columnAnswer,
});

/**
 * the item card's tabs from chat — what the card's "tabs" dialog sets (N19): their order, names
 * hidden or shown, the columns (and their order) of each "fields" tab and of the subitems tab, extra "fields" tabs,
 * fields per row and how subitems show. Same permission as the dialog (`board.update`); a subitems board holds its
 * subitems' card.
 */
export const updateItemCard = defineTool({
  name: 'update_item_card',
  title: "Update the item card's tabs",
  description:
    "Changes a board's item card (what every item's card shows; read the current one with get_board → card). tabs: the whole ordered list (it replaces the saved one): 'updates' always stays first and shown; hide a tab with hidden: true, rename it with title; a 'fields' tab shows the given column ids in that order (omitted = every column) — add more 'fields' tabs with new ids (e.g. fields_2), drop one by leaving it out. fields_per_row: 1, 2, 3 or 'auto'. subitems: in_fields (the subitems table under the main fields), show_summary, view_id (a saved view of the subitems board). For a subitem's card, pass the subitems board's id.",
  family: 'structure',
  scope: 'boards:write',
  risk: 'write',
  annotations: { idempotentHint: true },
  input: z.object({
    board_id: id('Board'),
    tabs: z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^[a-z][a-z0-9_]{0,23}$/)
            .describe("The tab's id: its type for the single tabs, any short id for an extra 'fields' tab"),
          type: z.enum(CARD_TAB_TYPES),
          title: z.string().trim().max(40).optional().describe("Shown name; omitted = the type's default name"),
          hidden: z.boolean().default(false),
          columns: z
            .array(z.string().max(64))
            .max(500)
            .optional()
            .describe("'fields' / 'subitems' tab: the column ids shown, in order"),
        }),
      )
      .max(20)
      .optional(),
    fields_per_row: cardFieldsPerRowSchema.optional(),
    subitems: z
      .object({
        in_fields: z.boolean().optional(),
        show_summary: z.boolean().optional(),
        view_id: z.string().max(64).nullable().optional().describe("null = no view (the card's own columns)"),
      })
      .optional(),
  }),
  output: answer({ board_id: z.string(), card: answer({}) }),
});

// --- more structure (the product owner approved): workspaces and folders, moving a board, views, dashboards and
// docs; archiving / deleting a board, a group or a column. Whatever removes something is sensitive (always waits for
// a person). Permissions and users stay with people: no tool for them.

const boardKind = z.enum(['main', 'shareable', 'private']);

export const createWorkspace = defineTool({
  name: 'create_workspace',
  title: 'Create a workspace',
  description:
    'Creates a workspace (open: everyone in the account sees it; closed: only its members). Returns its id for create_folder / create_board.',
  family: 'structure',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    name: z.string().trim().min(1).max(120),
    kind: z.enum(['open', 'closed']).default('open'),
  }),
  output: answer({ id: z.string(), name: z.string() }),
});

export const createFolder = defineTool({
  name: 'create_folder',
  title: 'Create a folder',
  description: 'Creates a folder in a workspace, or inside another folder of it (parent_folder_id).',
  family: 'structure',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    workspace_id: id('Workspace'),
    name: z.string().trim().min(1).max(120),
    parent_folder_id: id('Folder').optional(),
  }),
  output: answer({ id: z.string(), name: z.string(), workspace_id: z.string() }),
});

export const moveBoard = defineTool({
  name: 'move_board',
  title: 'Move a board to a folder',
  description:
    'Moves a board into a folder of its workspace, or to the workspace root (folder_id null). Needs the right to manage the board.',
  family: 'structure',
  scope: 'boards:write',
  risk: 'write',
  annotations: { idempotentHint: true },
  input: z.object({ board_id: id('Board'), folder_id: id('Folder').nullable() }),
  output: answer({ id: z.string(), folder_id: z.string().nullable() }),
});

export const createView = defineTool({
  name: 'create_view',
  title: 'Create a board view',
  description:
    "Adds a view to a board (type), shared with the board or private to the caller. settings: the view's JSON (filters, columns, grouping…); omitted = the type's defaults.",
  family: 'structure',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    board_id: id('Board'),
    name: z.string().trim().min(1).max(120),
    type: z.enum(VIEW_TYPES).default('table'),
    visibility: z.enum(['shared', 'private']).default('shared'),
    settings: z.record(z.string(), z.unknown()).optional(),
  }),
  output: answer({ id: z.string(), name: z.string(), type: z.string() }),
});

export const createDashboard = defineTool({
  name: 'create_dashboard',
  title: 'Create a dashboard',
  description: 'Creates a dashboard in a workspace (optionally in a folder), over the boards given (board_ids).',
  family: 'structure',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    workspace_id: id('Workspace'),
    name: z.string().trim().min(1).max(120).optional(),
    folder_id: id('Folder').optional(),
    kind: z.enum(['main', 'private']).default('main'),
    board_ids: z.array(id('Board')).max(50).optional(),
  }),
  output: answer({ id: z.string(), name: z.string() }),
});

export const createDoc = defineTool({
  name: 'create_doc',
  title: 'Create a doc',
  description: 'Creates an empty doc in a workspace (optionally in a folder). Returns its id.',
  family: 'structure',
  scope: 'boards:write',
  risk: 'write',
  input: z.object({
    workspace_id: id('Workspace'),
    name: z.string().trim().min(1).max(200).optional(),
    folder_id: id('Folder').optional(),
    kind: boardKind.default('main'),
  }),
  output: answer({ id: z.string(), name: z.string() }),
});

export const archiveBoard = defineTool({
  name: 'archive_board',
  title: 'Archive a board',
  description: 'Archives a board (it leaves the lists; restorable from the archive). Ask the user first.',
  family: 'structure',
  scope: 'boards:write',
  risk: 'sensitive',
  input: z.object({ board_id: id('Board') }),
  output: okAnswer,
});

export const deleteBoard = defineTool({
  name: 'delete_board',
  title: 'Delete a board (to trash)',
  description: 'Deletes a board with its items to the trash (restorable for 30 days). Ask the user first.',
  family: 'structure',
  scope: 'boards:write',
  risk: 'sensitive',
  input: z.object({ board_id: id('Board') }),
  output: okAnswer,
});

export const deleteGroup = defineTool({
  name: 'delete_group',
  title: 'Delete a group (to trash)',
  description: "Deletes a group and its items to the trash (restorable). A board's last group cannot be deleted.",
  family: 'structure',
  scope: 'boards:write',
  risk: 'sensitive',
  input: z.object({ board_id: id('Board'), group_id: id('Group') }),
  output: okAnswer,
});

export const deleteColumn = defineTool({
  name: 'delete_column',
  title: 'Delete a column (to trash)',
  description: 'Deletes a column and its values to the trash (restorable). The name column cannot be deleted.',
  family: 'structure',
  scope: 'boards:write',
  risk: 'sensitive',
  input: z.object({ board_id: id('Board'), column_id: z.string().min(1).max(64) }),
  output: okAnswer,
});
