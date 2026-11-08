// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  checkTransition,
  conditionLines,
  conditionParts,
  hasMessage,
  t,
  type ConditionFailure,
  type FilterGroup,
  type FilterRule,
  type MessageKey,
  type QueryEnv,
  popupRequired,
  evaluateConditions,
  statusWorkflowSchema,
  transitionSubitemsRule,
  workflowOn,
  type RichNode,
  type StatusWorkflow,
  type SubitemsTally,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { findSubBoard, listColumns, listGroups, type ColumnRow } from '../boards/boards.repo';
import { listTeamRows } from '../teams/teams.repo';
import { isOwnerOrAdmin, type BoardAccess } from '../boards/boards.access';
import { accountEnv, queryEnvOf } from '../automations/engine/context';
import { memberNames, type ItemRow } from './items.repo';
import type { Actor } from './items.service';
import { subitemsTally } from './popup-subitems';

/** The column's workflow when it is on; a broken one is treated as off rather than locking the column. */
export const columnWorkflow = (column: Pick<ColumnRow, 'type' | 'settings'>): StatusWorkflow | null => {
  if (column.type !== 'status') return null;
  const parsed = statusWorkflowSchema.safeParse((column.settings as { workflow?: unknown }).workflow);
  return parsed.success && workflowOn(parsed.data) ? parsed.data : null;
};

const labelOf = (v: unknown) => {
  const index = (v as { index?: unknown } | null)?.index;
  return typeof index === 'number' ? index : null;
};

/**
 * the status workflow at the one place every cell write passes. Undo puts an old value back and is not
 * checked; automations follow the workflow unless it says 'bypass'; an owner or admin may pass a blocked move with
 * `workflow_override` (kept in the event's meta). Blocked: 409 `workflow_blocked` with the reason.
 * Returns the meta to add to the event (the override, when used).
 */
export const assertWorkflowMove = async (
  tx: Db,
  a: Actor,
  access: BoardAccess,
  item: ItemRow,
  column: ColumnRow,
  before: unknown,
  after: unknown,
  meta: Record<string, unknown>,
  filled: (key: string) => Promise<boolean>,
  snapshot: () => Promise<{ item: Parameters<typeof evaluateConditions>[1]; columns: ColumnRow[] }>,
): Promise<Record<string, unknown>> => {
  const wf = columnWorkflow(column);
  if (!wf || meta.undo_of) return {};
  if (a.automation && wf.automations === 'bypass') return {};
  const from = labelOf(before);
  const to = labelOf(after);
  if (from === to) return {};
  // Required columns are read once each; conditions need the computed item, so it is loaded only when asked.
  const filledNow = new Map<string, boolean>();
  for (const t of wf.transitions)
    if (t.to === to)
      for (const k of [...(t.required ?? []), ...popupRequired(t.popup)])
        if (!filledNow.has(k)) filledNow.set(k, await filled(k));
  // the subitems each rule of a move to this label asks for, counted once per rule.
  const tallies = new Map<string, SubitemsTally>();
  for (const t of wf.transitions) {
    const rule = t.to === to ? transitionSubitemsRule(t) : null;
    const k = rule && JSON.stringify(rule);
    if (rule && k && !tallies.has(k)) tallies.set(k, await subitemsTally(tx, a, item, rule));
  }
  let snap: Awaited<ReturnType<typeof snapshot>> | null = null;
  const needsConditions = wf.transitions.some((t) => t.to === to && t.conditions);
  let env: Awaited<ReturnType<typeof queryEnvOf>> | null = null;
  if (needsConditions) {
    snap = await snapshot();
    env = await queryEnvOf(tx, a.ctx.accountId, snap.columns, await accountEnv(tx, a.ctx.accountId));
  }
  const result = checkTransition(wf, from, to, {
    userId: a.user.id,
    teamIds: access.teamIds,
    automation: !!a.automation,
    note: meta.workflow_note === true,
    filled: (k) => filledNow.get(k) ?? false,
    subitems: (rule) => tallies.get(JSON.stringify(rule)) ?? { complete: 0, incomplete: 0 },
    matches: (c) => {
      if (!snap || !env) return true;
      try {
        return evaluateConditions(c, snap.item, env).matched;
      } catch {
        // A rule on a column that is gone does not block the board.
        return true;
      }
    },
  });
  if (result.ok) return {};
  if (meta.workflow_override === true && wf.allow_override !== false && !a.automation && isOwnerOrAdmin(access))
    return { workflow_override: true, workflow_block: result.block.reason };
  const columns = result.block.reason === 'required' ? await listColumns(tx, item.boardId) : [];
  const block = result.block;
  // round 2: each condition the item does not meet, with its value now.
  const conditions = block.reason === 'conditions' ? result.transition?.conditions : undefined;
  const failed =
    conditions && snap && env ? await failedConditions(tx, a.ctx.accountId, item, conditions, snap, env) : [];
  const subColumns = block.reason === 'subitems' ? await subBoardColumns(tx, item) : [];
  throw new AppError('workflow_blocked', `workflow_blocked:${result.block.reason}`, {
    column_id: column.key,
    reason: result.block.reason,
    from,
    to,
    ...(block.message ? { message: block.message } : {}),
    ...(block.reason === 'conditions' && conditions
      ? { failed, any: conditions.operator === 'or' && conditions.rules.length > 1 }
      : {}),
    ...(result.block.reason === 'required'
      ? {
          columns: result.block.columns.map((k) => ({ id: k, title: columns.find((c) => c.key === k)?.title ?? k })),
        }
      : {}),
    ...(block.reason === 'subitems'
      ? {
          min: block.min,
          have: block.have,
          incomplete: block.incomplete,
          all: block.all,
          failing: block.failing,
          columns: block.columns.map((k) => ({ id: k, title: subColumns.find((c) => c.key === k)?.title ?? k })),
        }
      : {}),
  });
};

/** A rule's value in words: a label by its name, a person / team / group by name, "me"; the rest as written. */
const valueWords = (
  v: unknown,
  r: FilterRule,
  column: ColumnRow | undefined,
  names: { people: Map<string, string>; teams: Map<string, string>; groups: Map<string, string> },
): string => {
  if (v !== null && typeof v === 'object') {
    const o = v as { label?: unknown; value?: unknown };
    return String(o.label ?? o.value ?? JSON.stringify(v));
  }
  const x = String(v);
  if (r.column_id === '__group__') return names.groups.get(x) ?? x;
  if (x === 'me') return t('filter.me');
  if (x.startsWith('user:')) return names.people.get(x.slice(5)) ?? x;
  if (x.startsWith('team:')) return names.teams.get(x.slice(5)) ?? x;
  const labels = (column?.settings as { labels?: { id: number | string; label: string }[] } | undefined)?.labels;
  return labels?.find((l) => String(l.id) === x)?.label ?? x;
};

/**
 * The top-level conditions of a move the item does not meet (a nested group is one entry, in words). A negated
 * whole tree is not split up: it reads as one entry too.
 */
const failedConditions = async (
  tx: Db,
  accountId: string,
  item: ItemRow,
  conditions: FilterGroup,
  snap: { item: Parameters<typeof evaluateConditions>[1]; columns: ColumnRow[] },
  env: QueryEnv,
): Promise<ConditionFailure[]> => {
  const unmet = conditions.negate
    ? [{ part: conditions as FilterRule | FilterGroup, met: false }]
    : conditionParts(conditions, snap.item, env).filter((p) => !p.met);
  if (!unmet.length) return [];
  const values = unmet.flatMap((p) => (p.part.kind === 'rule' ? p.part.values : [])).map(String);
  const userIds = values.filter((v) => v.startsWith('user:')).map((v) => v.slice(5));
  const groups = await listGroups(tx, item.boardId);
  const names = {
    people: await memberNames(tx, accountId, userIds),
    teams: values.some((v) => v.startsWith('team:'))
      ? new Map((await listTeamRows(tx, accountId)).map((x) => [x.id, x.name]))
      : new Map<string, string>(),
    groups: new Map(groups.map((g) => [g.id, g.title])),
  };
  const sb = {
    columns: snap.columns.map((c) => ({ key: c.key, title: c.title, type: c.type })),
    groups: groups.map((g) => ({ id: g.id, title: g.title })),
    personName: (id: string) => names.people.get(id),
    teamName: (id: string) => names.teams.get(id),
  };
  return unmet.map(({ part }): ConditionFailure => {
    if (part.kind === 'group')
      return {
        column_id: '',
        title: conditionLines({ kind: 'group', operator: 'and', negate: false, rules: [part] }, sb)[0] ?? '',
        operator: 'group',
        values: [],
      };
    const column = snap.columns.find((c) => c.key === part.column_id);
    const field = `filter.field.${part.column_id}` as MessageKey;
    const system = part.column_id.startsWith('__');
    return {
      column_id: part.column_id,
      title: column?.title ?? (system && hasMessage(field) ? t(field) : part.column_id),
      operator: part.operator,
      ...(part.negate ? { negate: true } : {}),
      values: part.values
        .filter((v) => v !== null && v !== undefined && v !== '')
        .map((v) => valueWords(v, part, column, names)),
      ...(column ? { current: snap.item.cells[column.key]?.text ?? null } : {}),
    };
  });
};

/** The columns of the board the item's subitems live on (none yet = no sub-board). */
const subBoardColumns = async (tx: Db, item: ItemRow) => {
  if (item.depth > 0) return listColumns(tx, item.boardId);
  const sub = await findSubBoard(tx, item.boardId);
  return sub ? listColumns(tx, sub.id) : [];
};

/** A popup's plain-text note as an update document: one paragraph per line (no markup is read from it). */
export const plainTextDoc = (text: string): RichNode =>
  ({
    type: 'doc',
    content: text
      .split(/\r?\n/)
      .map((line) => (line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' })),
  }) as RichNode;
