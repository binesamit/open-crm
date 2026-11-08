// SPDX-License-Identifier: AGPL-3.0-only
import {
  type BucketNode,
  EMPTY_BUCKET,
  type Field,
  GROUP_PALETTE,
  GROUP_PATH_SEP,
  type GroupBy,
  type GroupLevel,
  groupOptsOf,
  groupTree,
  paint,
  type QueryEnv,
  resolveField,
  t,
} from '@bines/shared';
import type { BoardDetail, Item, Member } from './board-api';
import { dateGroupLabel, groupCountryName } from './date-group';
import { bucketSeed } from './table/bucket-seed';
import { groupColor, type Section } from './table/BoardTable';

const BUCKET_COLORS = GROUP_PALETTE.map((k) => paint(k)!);
const EMPTY_COLOR = 'var(--status-empty)';

/** A level of a nested grouping in the view: its grouping (absent = the board's groups) and its field. */
export type ViewLevel = { g: GroupBy | undefined; field: Field };

/**
 * Prod ק3 — a nested grouping as the table's sections, in tree order: each parent a `header`
 * section (its title, count and — after its children — its summary), the deepest level's sections holding the rows.
 * Keys are the levels' `<column>:<bucket>` down to the section, joined by `GROUP_PATH_SEP`. A section's seed (a new
 * item, a drag into it) carries every level's value — the board group when the first level is the board's groups.
 */
export const nestedSections = (p: {
  rows: Item[];
  levels: ViewLevel[];
  board: BoardDetail;
  env: QueryEnv;
  names: Map<string, string>;
  members: Member[];
}): Section[] => {
  const { board, env } = p;
  const base = {
    timezone: env.timezone,
    nameOf: (id: string) => p.names.get(id),
    emptyLabel: t('group.empty'),
    checkedLabel: t('group.checked'),
    dates: { env, label: dateGroupLabel },
    teams: env.teams,
    countryName: groupCountryName,
  };
  const rank = new Map(board.groups.map((g, i) => [g.id, i]));
  const levels: GroupLevel[] = p.levels.map((l) =>
    l.g
      ? { field: l.field, opts: groupOptsOf(l.g, base) }
      : {
          field: l.field,
          opts: {
            ...base,
            nameOf: (id: string) => board.groups.find((g) => g.id === id)?.title,
            rank: (key: string) => rank.get(key) ?? Number.MAX_SAFE_INTEGER,
          },
        },
  );
  const last = levels.length - 1;
  const out: Section[] = [];
  const walk = (nodes: BucketNode<Item>[], parentKey: string, parentSeed: Seed | null | undefined) =>
    nodes.forEach((n, i) => {
      const level = p.levels[n.level]!;
      const column = level.field.id;
      const key = `${parentKey ? `${parentKey}${GROUP_PATH_SEP}` : ''}${column}:${n.key}`;
      const group = level.g ? undefined : board.groups.find((g) => g.id === n.key);
      const color = group
        ? groupColor(group)
        : (paint(n.color) ?? (n.key === EMPTY_BUCKET ? EMPTY_COLOR : BUCKET_COLORS[i % BUCKET_COLORS.length]!));
      const seed = levelSeed({ board, env, members: p.members }, level, n.key, n.rows, n.label, parentSeed);
      const header = n.level < last;
      out.push({
        key,
        title: n.label,
        color,
        items: n.rows,
        level: n.level,
        column,
        bucket: n.key,
        ...(header ? { header: true, ...(group ? { group } : {}) } : seed ? { seed } : {}),
      });
      walk(n.children, key, seed);
    });
  walk(groupTree(p.rows, levels), '', undefined);
  return out;
};

/** The view's levels (the first = its grouping or the board's groups); a column that is gone drops its level. */
export const viewLevels = (q: { group_by?: GroupBy; subgroups?: GroupBy[] }, env: QueryEnv): ViewLevel[] => {
  const levels: ViewLevel[] = [];
  const add = (g: GroupBy | undefined, id: string) => {
    try {
      levels.push({ g, field: resolveField(id, env) });
    } catch {
      // the column was deleted: the level is skipped
    }
  };
  add(q.group_by, q.group_by?.column_id ?? '__group__');
  for (const g of q.subgroups ?? []) add(g, g.column_id);
  return levels;
};

type Seed = NonNullable<Section['seed']>;

/**
 * A nested section's seed: its level's value (the board group, or the column's value — `bucketSeed`) on top of its
 * parents'. Null when it, or a parent, cannot be written (a computed column): no "+ item", no drop there.
 */
export const levelSeed = (
  ctx: { board: BoardDetail; env: QueryEnv; members: Member[] },
  level: ViewLevel,
  key: string,
  rows: Item[],
  title: string,
  parentSeed: Seed | null | undefined,
): Seed | null => {
  const group = level.g ? undefined : ctx.board.groups.find((g) => g.id === key);
  const own: Seed | undefined = group
    ? { groupId: group.id, cells: {} }
    : bucketSeed(level.field, key, {
        groupId: ctx.board.groups[0]?.id,
        members: ctx.members,
        env: ctx.env,
        columns: ctx.board.columns,
        rows,
        title,
        dates: { unit: level.g?.date_unit, pastDetail: level.g?.past_detail },
      });
  if (parentSeed === null || !own) return null;
  return {
    groupId: group ? group.id : (parentSeed?.groupId ?? own.groupId),
    cells: { ...parentSeed?.cells, ...own.cells },
  };
};

/** The sections to show (phones, ק3): none under a collapsed parent level. */
export const visibleSections = (sections: Section[], collapsed: Set<string>): Section[] => {
  let hiddenBelow: number | null = null;
  return sections.filter((s) => {
    const level = s.level ?? 0;
    if (hiddenBelow !== null && level > hiddenBelow) return false;
    hiddenBelow = s.header && collapsed.has(s.key) ? level : null;
    return true;
  });
};
