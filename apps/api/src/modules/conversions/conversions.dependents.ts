// SPDX-License-Identifier: AGPL-3.0-only
import {
  adaptViewSettings,
  adaptWidgetSettings,
  clearRuleMarks,
  columnTypes,
  conversionMark,
  type ConversionDependent,
  type ConvertedColumn,
  type FilterGroup,
  type FilterRule,
  formulaKindOf,
  formulaReads,
  MIRROR_SUBITEMS,
  recipeBreaks,
  recipeNames,
  recipeSchema,
  type RecipeBoard,
  viewChanged,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { type BoardRow, type ColumnRow, listColumns, listGroups } from '../boards/boards.repo';
import { notifyUsers } from '../notifications/notify';
import {
  accountColumnsOfTypes,
  boardAutomations,
  boardWebhooks,
  boardViews,
  findAutomation,
  findView,
  findWidget,
  formsOfBoard,
  importRefsOf,
  installationsMentioning,
  setAutomationActive,
  updateViewSettings,
  updateWidgetSettings,
  widgetsOfBoard,
} from './conversions.repo';

/**
 * What else uses a column whose type changes (D28, plan §6) — scanned for the preview (nothing written) and
 * applied by the conversion, which keeps the before-state (`UndoState`) so the undo puts it back: saved views'
 * rules are disabled and marked (never deleted), summaries the new type lacks reset, automations that no longer fit
 * are switched off (their owner is told), dashboard widgets follow the column or ask to choose again. Formulas,
 * mirrors, AI columns, other columns' settings, extensions, forms, webhooks and import mappings are reported.
 */
export type UndoState = {
  views: { id: string; before: Record<string, unknown>; revision: number }[];
  automations: string[];
  widgets: { id: string; before: Record<string, unknown>; updatedAt: string }[];
};

type Scan = {
  accountId: string;
  board: BoardRow;
  column: ColumnRow;
  to: { type: string; settings: Record<string, unknown> };
  conversionId: string;
  /** Write the changes (the conversion) or only report them (the preview). */
  apply: boolean;
  userId: string | null;
};

const REASON_PREFIX = 'column_type_changed:';

export const scanDependents = async (db: Db, s: Scan) => {
  const { board, column, apply } = s;
  const out: ConversionDependent[] = [];
  const undo: UndoState = { views: [], automations: [], widgets: [] };
  const add = (d: Omit<ConversionDependent, 'board_id'> & { board_id?: string | null }) =>
    out.push({ board_id: board.id, ...d });
  const c: ConvertedColumn = {
    key: column.key,
    title: column.title,
    from: { type: column.type, settings: column.settings },
    to: s.to,
  };
  const mark = conversionMark(s.conversionId);
  const quoted = `"${column.key}"`;

  // ---- this board's columns: formulas, AI columns, settings that name the column ----
  const boardColumns = await listColumns(db, board.id);
  const fromKind = formulaKindOf(column.type);
  const toKind = formulaKindOf(s.to.type);
  for (const other of boardColumns) {
    if (other.id === column.id) continue;
    const st = other.settings as Record<string, unknown>;
    if (other.type === 'formula') {
      if (!formulaReads(String(st.formula ?? ''), column.key)) continue;
      add({
        kind: 'formula',
        id: other.key,
        name: other.title,
        action: fromKind === toKind ? 'kept' : 'review',
        detail: fromKind === toKind ? 'formula_same' : 'formula_kind',
        info: { from: fromKind, to: toKind },
      });
    } else if (other.type === 'ai') {
      const inputs = (st.inputs as string[] | undefined) ?? [];
      const reads = inputs.includes(column.key) || String(st.instructions ?? '').includes(`{${column.title}}`);
      const writes = st.labels_from === column.key || st.write_to === column.key;
      if (writes) add({ kind: 'ai_column', id: other.key, name: other.title, action: 'review', detail: 'ai_labels' });
      else if (reads) add({ kind: 'ai_column', id: other.key, name: other.title, action: 'kept', detail: 'ai_rerun' });
    } else if (other.type !== 'mirror' && JSON.stringify(st).includes(quoted)) {
      add({ kind: 'column_setting', id: other.key, name: other.title, action: 'review', detail: 'column_setting' });
    }
  }

  // ---- mirrors on other boards (through a relation to this board, or the subitems of a parent board) ----
  const mirrors = await accountColumnsOfTypes(db, s.accountId, ['mirror']);
  const relations = await accountColumnsOfTypes(db, s.accountId, ['board_relation']);
  const toDef = columnTypes.get(s.to.type);
  for (const m of mirrors) {
    const st = m.settings as { relation_column_id?: string; source_column_id?: string; aggregate?: string };
    if (st.source_column_id !== column.key) continue;
    const viaSubitems = st.relation_column_id === MIRROR_SUBITEMS && board.parentBoardId === m.boardId;
    const rel = relations.find((r) => r.boardId === m.boardId && r.key === st.relation_column_id);
    const linked = ((rel?.settings as { board_ids?: string[] } | undefined)?.board_ids ?? []).includes(board.id);
    if (!viaSubitems && !linked) continue;
    const numeric = ['sum', 'avg', 'median', 'min', 'max'].includes(st.aggregate ?? 'sum');
    const lost = numeric && !toDef?.toNumber && !!columnTypes.get(column.type)?.toNumber;
    add({
      kind: 'mirror',
      id: m.key,
      name: `${m.boardName} · ${m.title}`,
      board_id: m.boardId,
      action: lost ? 'review' : 'kept',
      detail: lost ? 'mirror_numbers' : 'mirror_follows',
    });
  }

  // ---- saved views (and the parent board's, which name a sub-board column `sub:<key>`) ----
  const viewSets: [BoardRow['id'], string][] = [[board.id, column.key]];
  if (board.parentBoardId) viewSets.push([board.parentBoardId, `sub:${column.key}`]);
  for (const [boardId, id] of viewSets)
    for (const v of await boardViews(db, boardId)) {
      const impact = adaptViewSettings(v.settings as Record<string, unknown>, id, c, mark);
      if (viewChanged(impact)) {
        add({
          kind: 'view',
          id: v.id,
          name: v.name,
          board_id: boardId,
          action: impact.rules.disabled ? 'disabled' : 'updated',
          detail: 'view_rules',
          info: { ...impact.rules, summaries_reset: impact.summaries_reset },
        });
        if (apply) {
          await updateViewSettings(db, v.id, impact.settings);
          undo.views.push({ id: v.id, before: v.settings as Record<string, unknown>, revision: v.revision + 1 });
        }
      }
      if (impact.references.length)
        add({
          kind: 'view',
          id: v.id,
          name: v.name,
          board_id: boardId,
          action: 'review',
          detail: 'view_reference',
          info: { paths: impact.references },
        });
      else if ((impact.sorted || impact.grouped) && !viewChanged(impact))
        add({ kind: 'view', id: v.id, name: v.name, board_id: boardId, action: 'kept', detail: 'view_sort' });
    }

  // ---- automations of the board ----
  const groups = await listGroups(db, board.id);
  const recipeBoard = (cols: ColumnRow[]): RecipeBoard => ({
    columns: cols.map((x) => ({
      key: x.key,
      type: x.type,
      title: x.title,
      settings: x.settings as Record<string, unknown>,
    })),
    groups: groups.map((g) => ({ id: g.id, title: g.title })),
  });
  const before = recipeBoard(boardColumns);
  const after = recipeBoard(
    boardColumns.map((x) => (x.id === column.id ? { ...x, type: s.to.type, settings: s.to.settings } : x)),
  );
  for (const auto of await boardAutomations(db, board.id)) {
    if (!recipeNames(auto.recipe, column.key)) continue;
    const parsed = recipeSchema.safeParse(auto.recipe);
    if (!parsed.success) continue;
    const issues = recipeBreaks(parsed.data, before, after);
    if (!issues.length) {
      add({ kind: 'automation', id: auto.id, name: auto.title, action: 'kept', detail: 'recipe_ok' });
      continue;
    }
    if (!auto.isActive) {
      add({
        kind: 'automation',
        id: auto.id,
        name: auto.title,
        action: 'review',
        detail: 'recipe_breaks',
        info: { issues },
      });
      continue;
    }
    add({
      kind: 'automation',
      id: auto.id,
      name: auto.title,
      action: 'disabled',
      detail: 'recipe_breaks',
      info: { issues },
    });
    if (apply) {
      await setAutomationActive(db, auto.id, false, `${REASON_PREFIX}${column.key}:${column.type}>${s.to.type}`);
      undo.automations.push(auto.id);
      if (auto.ownerId)
        await notifyUsers(
          db,
          {
            accountId: s.accountId,
            type: 'automation',
            actorId: s.userId,
            boardIds: [board.id, board.parentBoardId],
            target: { boardId: board.id },
            payload: {
              excerpt: `${auto.title}: ${column.title} (${column.type} → ${s.to.type})`,
              automation_deactivated: { automation_id: auto.id, reason: 'column_type_changed' },
            },
          },
          [auto.ownerId],
        );
    }
  }

  // ---- dashboard widgets that read the board ----
  for (const w of await widgetsOfBoard(db, s.accountId, board.id)) {
    const res = adaptWidgetSettings(w.settings as Record<string, unknown>, board.id, c);
    if (!res.updated && !res.needsChoice) continue;
    add({
      kind: 'widget',
      id: w.id,
      name: `${w.dashboardName} · ${w.title || w.type}`,
      board_id: null,
      action: res.needsChoice ? 'review' : 'updated',
      detail: res.needsChoice ? 'widget_choose' : 'widget_follows',
    });
    if (apply) {
      await updateWidgetSettings(db, w.id, res.settings);
      const fresh = await findWidget(db, w.id);
      undo.widgets.push({
        id: w.id,
        before: w.settings as Record<string, unknown>,
        updatedAt: fresh!.updatedAt.toISOString(),
      });
    }
  }

  // ---- extensions, webhooks, forms, import mappings: reported for review ----
  for (const inst of await installationsMentioning(db, s.accountId, board.id)) {
    const text = JSON.stringify(inst.state ?? {});
    if (text.includes(quoted))
      add({ kind: 'extension', id: inst.id, name: inst.key, action: 'review', detail: 'extension_review' });
  }
  for (const h of await boardWebhooks(db, board.parentBoardId ?? board.id))
    if ((h.config as { column_id?: string }).column_id === column.key)
      add({ kind: 'webhook', id: h.id, name: h.eventType, action: 'kept', detail: 'webhook_follows' });
  for (const f of await formsOfBoard(db, board.id))
    if (JSON.stringify(f.questions ?? []).includes(quoted))
      add({ kind: 'form', id: f.id, name: f.title, action: 'kept', detail: 'form_follows' });
  for (const r of await importRefsOf(db, s.accountId, column.id))
    add({ kind: 'import', id: r.id, name: r.source, action: 'review', detail: 'import_mapping' });

  return { dependents: out, undo };
};

const clearMarksIn = (settings: Record<string, unknown>, mark: string) => {
  const next = structuredClone(settings);
  const query = next.query as { filter?: FilterGroup } | undefined;
  if (query?.filter) query.filter = clearRuleMarks(query.filter, mark);
  if (Array.isArray(next.coloring))
    next.coloring = (next.coloring as { rule: FilterRule }[]).map((r) => {
      if (r.rule?.disabled !== mark) return r;
      const { disabled: _drop, ...rule } = r.rule;
      return { ...r, rule };
    });
  return next;
};

/**
 * The undo of the dependents: a view nobody saved since gets its settings back as they were; one saved since gets
 * only this conversion's marks off its rules. Automations switched off by the conversion (and still off for that
 * reason) are switched on again; widgets nobody edited since get their settings back.
 */
export const restoreDependents = async (db: Db, state: UndoState | undefined, conversionId: string) => {
  if (!state) return;
  const mark = conversionMark(conversionId);
  for (const v of state.views) {
    const view = await findView(db, v.id);
    if (!view || view.deletedAt) continue;
    await updateViewSettings(
      db,
      v.id,
      view.revision === v.revision ? v.before : clearMarksIn(view.settings as Record<string, unknown>, mark),
    );
  }
  for (const id of state.automations) {
    const auto = await findAutomation(db, id);
    if (auto && !auto.isActive && auto.deactivatedReason?.startsWith(REASON_PREFIX))
      await setAutomationActive(db, id, true, null);
  }
  for (const w of state.widgets) {
    const widget = await findWidget(db, w.id);
    if (widget && !widget.deletedAt && widget.updatedAt.toISOString() === w.updatedAt)
      await updateWidgetSettings(db, w.id, w.before);
  }
};
