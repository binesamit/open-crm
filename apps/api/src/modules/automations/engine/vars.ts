// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes, type TemplateLookup } from '@bines/shared';
import type { ColumnRow } from '../../boards/boards.repo';
import type { ItemSnapshot } from './context';

/**
 * Template variables (04 §4.3) over fresh snapshots. Paths: `item.*`, `parent.*`, `subitem.*`, `created.*`, `board.*`,
 * `actor`, `creator`, `previous_value`, `new_value`, `update.body`, `today`, `now`, `automation.title`, `run.id`.
 * Unknown paths return undefined (rendered empty + a warning).
 */
export type ItemVars = { item: ItemSnapshot; columns: ColumnRow[]; url: string; groupTitle?: string };

export type VarsInput = {
  item?: ItemVars;
  parent?: ItemVars;
  /** D14: the subitem the event was about (`{subitem.*}`). */
  subitem?: ItemVars;
  created?: ItemVars;
  board: { id: string; name: string; url: string };
  actor: { id: string | null; name: string; email: string };
  creatorName: (userId: string | null) => string;
  previousValue?: string;
  newValue?: string;
  updateText?: string;
  /** webhook_in: the JSON body (`{payload.a.b}`). */
  payload?: unknown;
  /** flow_failed / flow_recovered: the flow (`{flow.name}`, `{flow.error}`, `{flow.url}` …). */
  flow?: Record<string, unknown> | null;
  today: string;
  now: Date;
  automation: { title: string };
  runId: string;
};

/** `item.<key>.<field>`: typed sub-fields of a cell value (04 §4.3). */
const field = (value: unknown, text: string | null, f: string, names?: string[]): unknown => {
  if (f === 'raw') return JSON.stringify(value ?? null);
  const v = value as Record<string, unknown> | null;
  switch (f) {
    case 'label':
      return text ?? '';
    case 'ids':
      return (
        (v?.item_ids as string[] | undefined) ??
        ((v?.persons_and_teams as { id: string }[] | undefined) ?? []).map((p) => p.id)
      );
    case 'first':
      // A linked item's name may hold ", ": the cell's names list, when it has one.
      return names ? (names[0] ?? '') : ((text ?? '').split(', ')[0] ?? '');
    case 'number':
      return typeof value === 'number' ? value : Number.parseFloat(text ?? '');
    default:
      return v && f in v ? v[f] : undefined;
  }
};

const itemPath = (vars: ItemVars | undefined, rest: string[], creatorName: VarsInput['creatorName']): unknown => {
  if (!vars) return undefined;
  const { item } = vars;
  const [head, sub] = rest;
  switch (head) {
    case 'name':
      return item.name;
    case 'id':
      return item.id;
    case 'url':
      return vars.url;
    case 'group':
      return vars.groupTitle ?? '';
    case 'group_id':
      return item.group_id;
    case 'created_at':
      return item.created_at;
    case 'creator':
      return creatorName(item.created_by);
    case undefined:
      return item.name;
  }
  const column = vars.columns.find((c) => c.key === head);
  if (!column) return undefined;
  if (columnTypes.get(column.type)?.storage === 'item') return item.name;
  const cell = item.cells[head];
  if (!sub) return cell?.text ?? '';
  return field(cell?.value ?? null, cell?.text ?? null, sub, cell?.names);
};

export const buildLookup =
  (v: VarsInput): TemplateLookup =>
  (path) => {
    const [root, ...rest] = path.split('.');
    switch (root) {
      case 'item':
        return itemPath(v.item, rest, v.creatorName);
      case 'parent':
        return itemPath(v.parent, rest, v.creatorName);
      case 'subitem':
        return itemPath(v.subitem, rest, v.creatorName);
      case 'created':
        return itemPath(v.created, rest, v.creatorName);
      case 'board':
        return rest[0] === 'id' ? v.board.id : rest[0] === 'url' ? v.board.url : v.board.name;
      case 'actor':
        return rest[0] === 'email' ? v.actor.email : rest[0] === 'id' ? v.actor.id : v.actor.name;
      case 'creator':
        return v.item ? v.creatorName(v.item.item.created_by) : undefined;
      case 'previous_value':
        return v.previousValue;
      case 'new_value':
        return v.newValue;
      case 'update':
        return rest[0] === 'body' ? v.updateText : undefined;
      case 'payload':
        return rest.reduce<unknown>(
          (o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
          v.payload,
        );
      case 'flow':
        return v.flow ? (v.flow[rest[0] ?? 'name'] ?? undefined) : undefined;
      case 'today':
        return v.today;
      case 'now':
        return v.now.toISOString();
      case 'automation':
        return v.automation.title;
      case 'run':
        return v.runId;
      default:
        return undefined;
    }
  };
