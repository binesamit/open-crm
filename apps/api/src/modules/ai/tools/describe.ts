// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ActionDescription,
  aiTool,
  cellFromText,
  columnTypes,
  type DescRef,
  describeAction,
  descriptionCellKeys,
  descriptionRefs,
  type TextPerson,
} from '@bines/shared';
import type { Db } from '../../../db/client';
import { actorRegion } from '../../accounts/region';
import { findAutomation } from '../../automations/automations.repo';
import { redactTitle } from '../../automations/automations.service';
import { assertBoard, type BoardAccess, columnAllowed, loadBoardAccess } from '../../boards/boards.access';
import { findFolder, findSubBoard, findWorkspace, listColumns, listGroups } from '../../boards/boards.repo';
import { loadDashboardAccess } from '../../dashboards/dashboards.access';
import { findWidget } from '../../dashboards/dashboards.repo';
import { findAsset } from '../../files/files.repo';
import { describeFlowCallStatic, FLOW_WRITE_TOOLS } from '../../flows/flows.ai';
import { findItemTemplate } from '../../item-templates/item-templates.repo';
import { type Actor, loadItem } from '../../items/items.service';
import { findUpdate } from '../../updates/updates.repo';
import { listAccountMembers } from '../../users/users.repo';

/**
 * Names for "describe an action" (sync-ai; the pure part is `describeAction` in shared/ai/describe.ts). Every id is
 * resolved as the reader — `actor` — with their access: a board or item they may not see stays unnamed (null), a
 * column they may not see shows no value. One `DescribeCache` per request lets a list of approvals / steps share
 * the lookups.
 */
export type DescribeCache = Map<string, Promise<unknown>>;
export const describeCache = (): DescribeCache => new Map();

const memo = <T>(cache: DescribeCache, key: string, load: () => Promise<T>): Promise<T> => {
  let hit = cache.get(key) as Promise<T> | undefined;
  if (!hit) {
    hit = load().catch(() => null as T);
    cache.set(key, hit);
  }
  return hit;
};

const boardAccess = (db: Db, a: Actor, cache: DescribeCache, id: string) =>
  memo<BoardAccess | null>(cache, `access:${id}`, () => loadBoardAccess(db, a.ctx, a.user, id));

const itemOf = (db: Db, a: Actor, cache: DescribeCache, id: string) =>
  memo(cache, `item:${id}`, async () => (await loadItem(db, a, id)).item);

const peopleOf = (db: Db, a: Actor, cache: DescribeCache) =>
  memo(cache, 'people', async () => {
    const rows = await listAccountMembers(db, a.ctx.accountId);
    return rows.map((r) => ({ id: r.userId, kind: 'person' as const, name: r.name, email: r.email }));
  });

/** A dashboard the reader may open (its widgets are named only then). */
const dashboardOf = (db: Db, a: Actor, cache: DescribeCache, id: string) =>
  memo(cache, `dashboard:${id}`, async () => (await loadDashboardAccess(db, a.ctx, a.user, id)).dashboard);

const UPDATE_EXCERPT = 80;

const resolveName = async (db: Db, a: Actor, cache: DescribeCache, ref: DescRef, boardId: string | null) => {
  switch (ref.kind) {
    case 'board':
      return (await boardAccess(db, a, cache, ref.id))?.board.name ?? null;
    case 'item':
      return (await itemOf(db, a, cache, ref.id))?.name ?? null;
    case 'group': {
      if (!boardId || !(await boardAccess(db, a, cache, boardId))) return null;
      const groups = await memo(cache, `groups:${boardId}`, () => listGroups(db, boardId));
      return groups?.find((g) => g.id === ref.id)?.title ?? null;
    }
    case 'column': {
      if (!boardId || !(await boardAccess(db, a, cache, boardId))) return null;
      const cols = await memo(cache, `columns:${boardId}`, () => listColumns(db, boardId));
      return cols?.find((c) => c.key === ref.id)?.title ?? null;
    }
    case 'update': {
      const u = await memo(cache, `update:${ref.id}`, () => findUpdate(db, a.ctx.accountId, ref.id));
      // Visible only with its item.
      if (!u || !(await itemOf(db, a, cache, u.itemId))) return null;
      const text = (u.bodyText ?? '').replace(/\s+/g, ' ').trim();
      return text.length > UPDATE_EXCERPT ? `${text.slice(0, UPDATE_EXCERPT)}…` : text;
    }
    case 'automation': {
      const row = await memo(cache, `automation:${ref.id}`, () => findAutomation(db, a.ctx.accountId, ref.id));
      if (!row?.boardId || !(await boardAccess(db, a, cache, row.boardId))) return null;
      // As a reader who may not manage it sees it (a hook URL keeps only its origin, AI-RT8).
      return redactTitle(row.title);
    }
    case 'workspace':
      return (await memo(cache, `ws:${ref.id}`, () => findWorkspace(db, a.ctx.accountId, ref.id)))?.name ?? null;
    case 'folder':
      return (await memo(cache, `folder:${ref.id}`, () => findFolder(db, a.ctx.accountId, ref.id)))?.name ?? null;
    case 'file':
      return (await memo(cache, `file:${ref.id}`, () => findAsset(db, a.ctx.accountId, ref.id)))?.fileName ?? null;
    case 'user':
      return (await peopleOf(db, a, cache))?.find((p) => p.id === ref.id)?.name ?? null;
    case 'dashboard':
      return (await dashboardOf(db, a, cache, ref.id))?.name ?? null;
    case 'item_template': {
      // An item template of a board the reader may read.
      const t = await memo(cache, `item_template:${ref.id}`, () => findItemTemplate(db, a.ctx.accountId, ref.id, true));
      if (!t) return null;
      try {
        assertBoard(await loadBoardAccess(db, a.ctx, a.user, t.boardId), 'item.read');
      } catch {
        return null;
      }
      return t.name;
    }
    case 'widget': {
      const w = await memo(cache, `widget:${ref.id}`, () => findWidget(db, a.ctx.accountId, ref.id));
      if (!w || !(await dashboardOf(db, a, cache, w.dashboardId))) return null;
      return w.title || w.type;
    }
  }
};

/** The board an input's groups / columns / cells belong to: its board_id, else its item's (or sub-board's). */
const contextBoard = async (db: Db, a: Actor, cache: DescribeCache, input: Record<string, unknown>) => {
  if (typeof input.board_id === 'string') return input.board_id;
  if (typeof input.parent_item_id === 'string') {
    const parent = await itemOf(db, a, cache, input.parent_item_id);
    if (!parent) return null;
    // A subitem's cells live on the sub-board (D14).
    const sub = await memo(cache, `sub:${parent.boardId}`, () => findSubBoard(db, parent.boardId));
    return sub?.id ?? null;
  }
  if (typeof input.item_id === 'string') return (await itemOf(db, a, cache, input.item_id))?.boardId ?? null;
  return null;
};

/**
 * One tool call in words for the reader `a` (null when the input is not an object). Registry tools use their schema;
 * a remote MCP tool (מ10) is described from its input alone.
 */
export const describeToolCall = async (
  db: Db,
  a: Actor,
  toolName: string,
  input: unknown,
  cache: DescribeCache = describeCache(),
): Promise<ActionDescription | null> => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const data = input as Record<string, unknown>;
  // External flows: the connection by name and an edit line by line.
  if (FLOW_WRITE_TOOLS.has(toolName)) return describeFlowCallStatic(db, a, toolName, data);
  const def = aiTool(toolName);
  const boardId = await contextBoard(db, a, cache, data);
  const names = new Map<string, string | null>();
  for (const ref of descriptionRefs(data))
    names.set(`${ref.kind}:${ref.id}`, await resolveName(db, a, cache, ref, boardId));

  const cellKeys = descriptionCellKeys(data);
  type Cell = { title: string | null; text: string | null };
  const cells = new Map<string, Cell>();
  if (cellKeys.length && boardId) {
    const access = await boardAccess(db, a, cache, boardId);
    const cols = access ? await memo(cache, `columns:${boardId}`, () => listColumns(db, boardId)) : null;
    const region = await actorRegion(db, a);
    const people = (await peopleOf(db, a, cache)) ?? [];
    const userName = (id: string) => people.find((p) => p.id === id)?.name;
    const raw = Object.assign(
      {},
      ...Object.values(data).filter((v) => v && typeof v === 'object' && !Array.isArray(v)),
    ) as Record<string, unknown>;
    for (const key of cellKeys) {
      const col = cols?.find((c) => c.key === key);
      if (!col || !access) {
        cells.set(key, { title: null, text: null });
        continue;
      }
      if (!columnAllowed(access, col.restrictedView)) {
        cells.set(key, { title: col.title, text: '—' });
        continue;
      }
      const type = columnTypes.get(col.type);
      const value = raw[key];
      let text: string | null;
      if (value === null) text = null;
      else if (!type) text = typeof value === 'string' ? value : JSON.stringify(value);
      else {
        const settings = { ...(type.defaultSettings as object), ...(col.settings as object) };
        // The model may send text for any column ("Done", "2026-10-05", "Dana") — read it as the tool will.
        const parsedValue =
          typeof value === 'string' && col.type !== 'text'
            ? cellFromText(col.type, value, settings, people as TextPerson[], { region })
            : value;
        const ok = parsedValue !== undefined && type.valueSchema.safeParse(parsedValue).success;
        text = ok
          ? parsedValue === null
            ? null
            : type.toText(parsedValue, settings, { region, userName, locale: region.language }) || ''
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
      }
      cells.set(key, { title: col.title, text });
    }
  }

  const board = boardId ? ((await boardAccess(db, a, cache, boardId))?.board.name ?? null) : undefined;
  return describeAction(def ?? { name: toolName }, data, {
    ...(board !== undefined ? { board } : {}),
    name: (ref) => names.get(`${ref.kind}:${ref.id}`) ?? null,
    cell: (key) => cells.get(key),
  });
};
