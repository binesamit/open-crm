// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type Blueprint,
  cellFromText,
  columnTypes,
  GROUP_PALETTE,
  type onboardingBuildSchema,
  parseWidgetSettings,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { updateWorkspaceRow } from '../boards/boards.repo';
import { assertWithinLimit, hasFeature } from '../billing/entitlements';
import { createDashboard, createWidget } from '../dashboards/dashboards.service';
import { installRecipes, installStarterKit } from '../extensions/packs';
import type { TemplateSnapshot } from '../boards/templates';
import { accountLocale, st } from '../../lib/i18n';
import { emptyFirstWorkspace } from './onboarding.repo';

/**
 * A blueprint (what "Build with AI" proposes) → native board templates of a kit, built by the same
 * code as a starter kit (`installStarterKit`), then its dashboard through the dashboard service. Pure parts first.
 */

type Board = Blueprint['boards'][number];
type Column = Board['columns'][number];

/** A column key from its type and place (unique on the board, `[a-z][a-z0-9_]*`). */
const keyOf = (c: Column, i: number) => `${c.type}_${i + 1}`;

const labelSettings = (c: Column) => {
  const labels = (c.labels ?? []).filter((l, i, all) => all.indexOf(l) === i);
  if (c.type === 'status') {
    if (!labels.length) return undefined;
    return {
      labels: labels.map((label, i) => ({
        id: i,
        label,
        color: GROUP_PALETTE[i % GROUP_PALETTE.length]!,
        index: i,
        // A status's last label is "done" (the blueprint's rule).
        ...(i === labels.length - 1 && labels.length > 1 ? { is_done: true } : {}),
      })),
    };
  }
  if (c.type === 'dropdown') return { labels: labels.map((label, i) => ({ id: i, label })) };
  return undefined;
};

/** One board of the blueprint as a native template snapshot (`templateSnapshotSchema`). */
export const boardSnapshot = (
  b: Board,
  opts: { keys: Set<string>; sample: boolean; nameTitle: string },
): TemplateSnapshot => {
  const groups = b.groups.map((g, i) => ({
    id: `g${i + 1}`,
    title: g.title,
    color: GROUP_PALETTE[i % GROUP_PALETTE.length]!,
  }));
  const columns: TemplateSnapshot['columns'] = [
    { id: 'name', title: b.item_name ?? opts.nameTitle, type: 'name', settings: {} },
  ];
  const byTitle = new Map<string, { key: string; type: string; settings: Record<string, unknown> }>();
  b.columns.forEach((c, i) => {
    const def = columnTypes.get(c.type);
    if (!def) return;
    let settings: Record<string, unknown> = {
      ...(def.defaultSettings as Record<string, unknown>),
      ...labelSettings(c),
    };
    if (c.type === 'board_relation') {
      // Only to a board this blueprint makes (and that was not left out).
      if (!c.link_to || !opts.keys.has(c.link_to)) return;
      settings = { board_ids: [], board_refs: [`@${c.link_to}`], allow_multiple: true };
    }
    const key = keyOf(c, i);
    columns.push({ id: key, title: c.title, type: c.type, settings });
    byTitle.set(c.title.trim().toLocaleLowerCase(), { key, type: c.type, settings });
  });
  const groupId = (title?: string) =>
    groups.find((g) => title && g.title.trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase())?.id ??
    groups[0]!.id;
  const items = opts.sample
    ? (b.items ?? []).map((it) => {
        const cells: Record<string, unknown> = {};
        for (const [title, text] of Object.entries(it.values ?? {})) {
          const col = byTitle.get(title.trim().toLocaleLowerCase());
          // People, files and links to items need real people / files / items: not from text.
          if (!col || ['people', 'file', 'board_relation'].includes(col.type)) continue;
          const value = cellFromText(col.type, text, col.settings);
          if (value !== undefined && value !== null) cells[col.key] = value;
        }
        return { group_id: groupId(it.group), name: it.name, cells, subitems: [] };
      })
    : [];
  return {
    native: true,
    format_version: 2,
    key: b.key,
    name: b.name,
    board_kind: 'public',
    hierarchy_type: 'classic',
    item_terminology: 'item',
    subitem_columns: [],
    groups,
    columns,
    add_columns: [],
    items,
    permissions: { set: 'edit_everything', restrict_column_editing: {}, restrict_column_view: {} },
    views: (b.views ?? []).flatMap((v): TemplateSnapshot['views'] => {
      const col = v.column ? byTitle.get(v.column.trim().toLocaleLowerCase()) : undefined;
      const fits = (...types: string[]) => (col && types.includes(col.type) ? col.key : undefined);
      if (v.type === 'kanban') {
        const lanes = fits('status');
        return lanes ? [{ name: v.name, type: 'kanban' as const, settings: { kanban: { column_id: lanes } } }] : [];
      }
      if (v.type === 'calendar' || v.type === 'timeline') {
        const date = fits('date', 'timeline');
        return date ? [{ name: v.name, type: v.type, settings: { [v.type]: { date_column_id: date } } }] : [];
      }
      return [{ name: v.name, type: 'cards' as const, settings: {} }];
    }),
  };
};

type Widget = NonNullable<Blueprint['dashboard']>['widgets'][number];
type ColRef = { type: string; title: string };

/** A widget of the blueprint's dashboard as dashboard widget settings; null = it cannot be made (a missing column). */
export const widgetSettings = (
  w: Widget,
  boards: { key: string; id: string; columns: ColRef[] }[],
): Record<string, unknown> | null => {
  const board = w.board ? boards.find((b) => b.key === w.board) : undefined;
  if (w.board && !board) return null;
  const pool = board ? board.columns : boards.flatMap((b) => b.columns);
  const col = w.column
    ? pool.find((c) => c.title.trim().toLocaleLowerCase() === w.column!.trim().toLocaleLowerCase())
    : undefined;
  const ref = col ? { type: col.type, title: col.title } : null;
  const fits = (...types: string[]) => !!ref && types.includes(ref.type);
  const base = { board_ids: board ? [board.id] : [] };
  const raw = (() => {
    switch (w.type) {
      case 'numbers':
        return { ...base, measure: fits('numbers') ? { fn: 'sum', column: ref } : { fn: 'count', column: null } };
      case 'chart':
        return {
          ...base,
          chart_type: w.chart_type ?? 'bar',
          x: fits('status', 'dropdown', 'people', 'date') ? { kind: 'column', column: ref } : { kind: 'group' },
        };
      case 'battery':
        return fits('status') ? { ...base, column: ref } : null;
      case 'table':
        return { ...base };
      case 'calendar':
      case 'timeline':
        return fits('date', 'timeline') ? { ...base, date_column: ref } : null;
      case 'workload':
        return fits('people') ? { ...base, people_column: ref } : null;
    }
  })();
  if (!raw) return null;
  try {
    return parseWidgetSettings(w.type, raw);
  } catch {
    return null;
  }
};

/** A column's key on a blueprint board, by its title (the same `keyOf` the board's snapshot used). */
const keyByTitle = (b: Board, title: string, types?: string[]) => {
  const i = b.columns.findIndex(
    (c) =>
      c.title.trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase() && (!types || types.includes(c.type)),
  );
  return i >= 0 ? keyOf(b.columns[i]!, i) : null;
};

type Automation = NonNullable<Blueprint['automations']>[number];

/**
 * The blueprint's automations as pack recipes (made switched off, D21): triggers and actions over the board's own
 * column keys. One whose column is not on its board is left out (an issue code says which).
 */
export const blueprintRecipes = (bp: Blueprint, boards: Board[], issues: string[]) =>
  (bp.automations ?? []).flatMap((au: Automation, i) => {
    const b = boards.find((x) => x.key === au.board);
    if (!b) return [];
    const miss = () => {
      issues.push(`automation_skipped:${i + 1}`);
      return [];
    };
    let trigger: Record<string, unknown>;
    if (au.when.type === 'item_created') trigger = { type: 'item_created' };
    else if (au.when.type === 'status_changed') {
      const column = keyByTitle(b, au.when.column, ['status']);
      if (!column) return miss();
      trigger = { type: 'status_changed', column, labels: [au.when.to] };
    } else {
      const column = keyByTitle(b, au.when.column, ['date', 'timeline']);
      if (!column) return miss();
      trigger = { type: 'date_arrived', column, offset_days: 0, time: '09:00' };
    }
    let action: Record<string, unknown>;
    if (au.then.type === 'notify') {
      const owners = au.then.who.trim().toLocaleLowerCase() === 'owners';
      const people = owners ? null : keyByTitle(b, au.then.who, ['people']);
      if (!owners && !people) return miss();
      action = {
        type: 'notify',
        to: owners ? '@board_owners' : `column:${people}`,
        message: `${au.title}: {item.name}`,
      };
    } else if (au.then.type === 'set_status') {
      const column = keyByTitle(b, au.then.column, ['status']);
      if (!column) return miss();
      action = { type: 'set_status', column, label: au.then.label };
    } else {
      const column = keyByTitle(b, au.then.column, ['people']);
      if (!column) return miss();
      action = { type: 'assign', column, who: '@creator', mode: 'add' };
    }
    return [
      { key: `ai${i + 1}`, board: b.key, title: au.title, recipe: { trigger, conditions: [], actions: [action] } },
    ];
  });

/** How many boards a blueprint makes (the plan check), without the boards left out. */
export const blueprintBoards = (bp: Blueprint, skip: string[]) => bp.boards.filter((b) => !skip.includes(b.key));

/**
 * POST /onboarding/build — the whole blueprint in one transaction: the boards (into the account's empty first
 * workspace when there is one, else a new workspace), then the dashboard over them. Within the plan's board limit.
 */
export const buildBlueprint = async (db: Db, a: Actor, input: z.infer<typeof onboardingBuildSchema>) => {
  const bp = input.blueprint;
  const boards = blueprintBoards(bp, input.skip_boards);
  if (!boards.length) throw new AppError('invalid_value', 'no_boards');
  // Every board is checked against the plan before anything is made (each insert checks again).
  await assertWithinLimit(db, a.ctx.accountId, 'boards', boards.length);
  const lang = await accountLocale(db, a.ctx.accountId);
  const keys = new Set(boards.map((b) => b.key));
  const nameTitle = st('server.nameColumn', undefined, lang);
  const snapshots = boards.map((b) => boardSnapshot(b, { keys, sample: input.sample_data, nameTitle }));
  const folders = [...new Set((bp.folders ?? []).concat(boards.flatMap((b) => (b.folder ? [b.folder] : []))))];
  const issues: string[] = [];
  const recipes = blueprintRecipes(bp, boards, issues);
  return db.transaction(async (tx) => {
    const empty = await emptyFirstWorkspace(tx, a.ctx.accountId);
    if (empty) await updateWorkspaceRow(tx, empty.id, { name: bp.workspace_name });
    const c = { accountId: a.ctx.accountId, actorId: a.user.id, requestId: a.requestId ?? null };
    const data = {
      board_templates: snapshots as never[],
      starter_kit: {
        default: false,
        workspace_name: bp.workspace_name,
        folders: [...new Set([...folders, ...(bp.docs ?? []).flatMap((d) => (d.folder ? [d.folder] : []))])],
        boards: boards.map((b) => ({ template: b.key, ...(b.folder ? { folder: b.folder } : {}) })),
        dashboards: [],
        // The blueprint's docs are a kit's docs (Markdown).
        docs: (bp.docs ?? []).map((d) => ({ name: d.name, folder: d.folder, markdown: d.markdown })),
      },
      automation_recipes: recipes,
      agent_templates: [],
      automation_templates: [],
    };
    const kit = await installStarterKit(
      tx,
      c,
      data,
      { workspaceId: empty?.id, workspaceName: bp.workspace_name },
      issues,
    );
    // The automations, switched off: the person reviews and switches each on.
    const automationIds = Object.values(await installRecipes(tx, c, data, { kit }, issues));
    const boardIds = boards.map((b) => kit.boards[b.key]).filter((x): x is string => !!x);
    let dashboardId: string | null = null;
    if (bp.dashboard && boardIds.length) {
      if (!(await hasFeature(tx, a.ctx.accountId, 'dashboards'))) issues.push('dashboard_not_in_plan');
      else {
        const d = await createDashboard(tx, a, kit.workspace_id, {
          name: bp.dashboard.name,
          kind: 'main',
          board_ids: boardIds,
        });
        dashboardId = d.id;
        const refs = boards.map((b) => ({
          key: b.key,
          id: kit.boards[b.key]!,
          columns: b.columns.map((c) => ({ type: c.type, title: c.title })),
        }));
        for (const w of bp.dashboard.widgets) {
          const settings = widgetSettings(w, refs);
          if (!settings) {
            issues.push(`widget_skipped:${w.type}`);
            continue;
          }
          await createWidget(tx, a, d.id, { type: w.type, title: w.title, settings });
        }
      }
    }
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'onboarding.built',
      actorId: a.user.id,
      requestId: a.requestId ?? null,
      after: { workspace_id: kit.workspace_id, board_ids: boardIds, dashboard_id: dashboardId, via: 'ai' },
    });
    return {
      workspace_id: kit.workspace_id,
      board_ids: boardIds,
      dashboard_id: dashboardId,
      doc_ids: kit.doc_ids ?? [],
      automation_ids: automationIds,
      issues,
    };
  });
};
