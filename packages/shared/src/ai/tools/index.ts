// SPDX-License-Identifier: AGPL-3.0-only
import { scopeAllows } from '../../api/tokens';
import {
  addFileLink,
  attachFileFromUrl,
  automationRuns,
  createAutomation,
  createUpdate,
  getFileLink,
  itemActivity,
  listAutomations,
  listFiles,
  listTimeEntries,
  listUpdates,
  logTime,
  myWork,
  replyUpdate,
  replyByEmail,
  search,
  setAutomationActive,
  setUpdateTask,
  testAutomation,
  undo,
} from './collaboration';
import {
  addDashboardWidget,
  deleteDashboard,
  duplicateDashboard,
  duplicateDashboardWidget,
  getDashboard,
  listDashboards,
  removeDashboardWidget,
  setDashboardLayout,
  updateDashboard,
  updateDashboardWidget,
} from './dashboards';
import { getDoc, searchDocs } from './docs';
import { getHelpArticle, searchHelp, showMe } from './help';
import {
  createIdoc,
  getIdoc,
  getIdocEvents,
  getIdocLink,
  getIdocSignature,
  getIdocPdf,
  listIdocTemplates,
  listItemIdocs,
  sendIdoc,
  setIdocLink,
} from './idocs';
import {
  applyItemTemplate,
  createItemTemplate,
  deleteItemTemplate,
  getItemTemplate,
  listItemTemplates,
  updateItemTemplate,
} from './item-templates';
import { editFileImage, generateImage } from './images';
import {
  flowsDraftCreate,
  flowsExplainFailure,
  flowsGet,
  flowsList,
  flowsRerun,
  flowsRuns,
  flowsSetActive,
  flowsUpdateDraft,
} from './flows';
import {
  archiveItem,
  createItem,
  deleteItem,
  getItem,
  moveItem,
  moveItemInHierarchy,
  moveItemToBoard,
  queryItems,
  updateItem,
} from './items';
import {
  archiveBoard,
  createBoard,
  createColumn,
  createDashboard,
  createDoc,
  createFolder,
  createGroup,
  createView,
  createWorkspace,
  deleteBoard,
  deleteColumn,
  deleteGroup,
  getBoard,
  moveBoard,
  listPeople,
  listWorkspaces,
  searchBoards,
  updateColumn,
  updateGroup,
  updateItemCard,
  whoami,
} from './structure';
import type { AiToolDef } from './types';
import type { Locale } from '../../i18n';
import { aiToolLabel } from './label';

export {
  defineTool,
  MAX_TOOL_PAGE,
  MAX_TOOL_RESULT_BYTES,
  type AiToolDef,
  type ToolAnnotations,
  type ToolFamily,
  type ToolRisk,
} from './types';
export { toolFilterSchema } from './items';
export { asSensitive, EXTERNAL_PLATFORM_TOOLS, OUTBOUND_ACTION_TYPES, recipeSendsOut } from './risk';
export { SEARCH_KNOWLEDGE, searchKnowledge } from './knowledge';
export { READ_WEB_PAGE, readWebPage, WEB_SEARCH, WEB_TOOL_NAMES, webSearch } from './web';
export { aiToolLabel } from './label';

/**
 * The tool registry (the planning notes "AGENTS-MCP" §3.2): one list for the MCP server and the agents, in a fixed order
 * (the 2026-07-28 MCP spec asks for a deterministic tools/list — it is also what keeps a model's prompt cache warm).
 * Adding a tool: define it in its family file, add it here, add its runner in apps/api/src/modules/ai/tools/runners.ts
 * (a test fails while a tool has no runner).
 */
export const AI_TOOLS: readonly AiToolDef[] = [
  whoami,
  // Product knowledge: the help center, read first for any how-to question.
  searchHelp,
  getHelpArticle,
  showMe,
  listPeople,
  listWorkspaces,
  searchBoards,
  getBoard,
  createBoard,
  createGroup,
  updateGroup,
  createColumn,
  updateColumn,
  // The item card's tabs.
  updateItemCard,
  createWorkspace,
  createFolder,
  moveBoard,
  createView,
  createDashboard,
  // Dashboard widgets.
  listDashboards,
  getDashboard,
  addDashboardWidget,
  updateDashboardWidget,
  removeDashboardWidget,
  // Editing a dashboard itself.
  updateDashboard,
  setDashboardLayout,
  duplicateDashboardWidget,
  duplicateDashboard,
  deleteDashboard,
  createDoc,
  archiveBoard,
  deleteBoard,
  deleteGroup,
  deleteColumn,
  queryItems,
  getItem,
  createItem,
  updateItem,
  moveItem,
  moveItemToBoard,
  moveItemInHierarchy,
  archiveItem,
  deleteItem,
  listUpdates,
  createUpdate,
  replyUpdate,
  // Check boxes in an update.
  setUpdateTask,
  replyByEmail,
  listFiles,
  getFileLink,
  attachFileFromUrl,
  addFileLink,
  generateImage,
  editFileImage,
  search,
  myWork,
  searchDocs,
  getDoc,
  // Interactive documents.
  listIdocTemplates,
  listItemIdocs,
  getIdoc,
  createIdoc,
  sendIdoc,
  getIdocLink,
  setIdocLink,
  getIdocEvents,
  getIdocSignature,
  getIdocPdf,
  // Item templates.
  listItemTemplates,
  getItemTemplate,
  createItemTemplate,
  updateItemTemplate,
  applyItemTemplate,
  deleteItemTemplate,
  listAutomations,
  createAutomation,
  setAutomationActive,
  testAutomation,
  automationRuns,
  listTimeEntries,
  logTime,
  itemActivity,
  undo,
  flowsList,
  flowsRuns,
  flowsDraftCreate,
  flowsGet,
  flowsExplainFailure,
  flowsSetActive,
  flowsRerun,
  flowsUpdateDraft,
] as unknown as readonly AiToolDef[];

export const AI_TOOL_NAMES = AI_TOOLS.map((t) => t.name);

export const aiTool = (name: string): AiToolDef | undefined => AI_TOOLS.find((t) => t.name === name);

/** Longest title first, so a title that starts another one never wins. */
const BY_TITLE = [...AI_TOOLS].sort((a, b) => b.title.length - a.title.length);

/**
 * r27: a stored preview line ("Update item: "Dana" · "Leads" · Status: Won" — `plainDescription` / the approval
 * preview, written once in English for every reader) with the tool's title in the reader's language. Text that does
 * not start with a tool title comes back unchanged.
 */
export const localizeToolPreview = (text: string, locale?: Locale): string => {
  for (const tool of BY_TITLE) {
    if (text === tool.title) return aiToolLabel(tool.name, tool.title, locale);
    if (text.startsWith(`${tool.title}: `))
      return `${aiToolLabel(tool.name, tool.title, locale)}${text.slice(tool.title.length)}`;
  }
  return text;
};

/** May a token with these scopes call the tool? (`admin` allows everything; a write scope implies its read.) */
export const toolAllowed = (tool: Pick<AiToolDef, 'scope'>, scopes: readonly string[]) =>
  tool.scope === 'any' || scopeAllows(scopes, tool.scope);

/**
 * The tools a connection may see: its scopes, minus write tools for a read-only role (viewers), minus sensitive
 * tools when the account blocks them. Order stays the registry's.
 */
export const toolsFor = (opts: { scopes: readonly string[]; readOnly?: boolean; sensitive?: 'allow' | 'block' }) =>
  AI_TOOLS.filter(
    (t) =>
      toolAllowed(t, opts.scopes) &&
      !(opts.readOnly && t.risk !== 'read') &&
      !(opts.sensitive === 'block' && t.risk === 'sensitive'),
  );
