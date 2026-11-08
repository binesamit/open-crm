// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useMemo, useState } from 'react';
import {
  columnTypes,
  conditionFailureText,
  conditionLines,
  conditionParts,
  dateInZone,
  getRegion,
  queryColumnOf,
  t,
  type FilterGroup,
  type FilterRule,
  type QueryEnv,
  type QueryRow,
  type WorkflowTransition,
} from '@bines/shared';
import { cn } from '@bines/ui';
import { BoardAccountContext } from '../board-context';
import { useItems, useMembers, useTeams, type BoardDetail, type Column } from '../board-api';
import { useAccountLocale } from '../views/views-api';

/**
 * round 2 — a workflow move's conditions in its popup: each one ticked off (✓) or not (✗) on the item's
 * values with the popup's draft, as it is filled in. The server checks again on save; this only shows the way.
 */

type Cells = Record<string, { value: unknown; text: string | null } | undefined>;

export type MoveCheck = {
  key: string;
  text: string;
  met: boolean;
  /** The column the condition reads, when the popup can change it. */
  column?: Column;
};

/** The query engine's environment for the board (as the board's own filter reads it). */
const useBoardEnv = (accountId: string, board: BoardDetail): QueryEnv => {
  const { meId } = useContext(BoardAccountContext);
  const locale = useAccountLocale(accountId).data;
  const teams = useTeams(accountId).data?.data;
  const timezone = locale?.timezone ?? 'Asia/Jerusalem';
  const [today] = useState(() => dateInZone(new Date(), timezone));
  return useMemo<QueryEnv>(
    () => ({
      columns: board.columns.map(queryColumnOf),
      meId,
      teams: (teams ?? []).map((x) => ({ id: x.id, member_ids: x.member_ids })),
      today,
      timezone,
      weekend: locale?.weekend ?? 'fri_sat',
      firstDay: locale?.first_day ?? 0,
      calendar: getRegion().calendar,
    }),
    [board.columns, meId, teams, today, timezone, locale],
  );
};

/**
 * The move's conditions against the item with the draft's values: one check per top-level condition, and whether
 * one is enough ("or"). `draft` holds the popup's values by column id.
 */
export const useMoveChecks = (
  accountId: string,
  board: BoardDetail,
  itemId: string,
  rowCells: Cells,
  draft: Record<string, unknown>,
  move: Pick<WorkflowTransition, 'conditions'> | undefined,
  /** The columns the popup can ask for (a condition on another one can only be shown). */
  editable: Column[],
): { checks: MoveCheck[]; any: boolean } => {
  const env = useBoardEnv(accountId, board);
  const item = useItems(accountId, board.id).data?.data.find((x) => x.id === itemId);
  const members = useMembers(accountId).data?.data ?? [];
  const teams = useTeams(accountId).data?.data ?? [];
  const conditions = move?.conditions?.negate ? undefined : move?.conditions;
  const nameOf = (id: string) => members.find((m) => m.user_id === id)?.name;
  const cells: Cells = { ...rowCells };
  for (const [id, value] of Object.entries(draft)) {
    const c = board.columns.find((x) => x.id === id);
    const def = c && columnTypes.get(c.type);
    cells[id] = {
      value,
      text:
        value === null || value === undefined || !def
          ? null
          : (def.toText(value as never, c.settings as never, { userName: nameOf }) ?? null),
    };
  }
  const row: QueryRow = {
    id: itemId,
    group_id: item?.group_id ?? null,
    parent_item_id: item?.parent_item_id ?? null,
    depth: item?.depth ?? 0,
    name: item?.name ?? '',
    position: item?.position ?? '',
    key: item?.key ?? null,
    cells,
    created_at: item?.created_at ?? '',
    created_by: item?.created_by ?? null,
    updated_at: item?.updated_at ?? '',
  };
  const sb = {
    columns: board.columns.map((c) => ({ key: c.id, title: c.title, type: c.type })),
    groups: board.groups.map((g) => ({ id: g.id, title: g.title })),
    personName: nameOf,
    teamName: (id: string) => teams.find((x) => x.id === id)?.name,
  };
  const ruleText = (r: FilterRule) => {
    const c = board.columns.find((x) => x.id === r.column_id);
    const labels = (c?.settings as { labels?: { id: number | string; label: string }[] } | undefined)?.labels;
    const values = r.values
      .filter((v) => v !== null && v !== undefined && v !== '')
      .map((v) => {
        const x = String(v);
        if (r.column_id === '__group__') return sb.groups.find((g) => g.id === x)?.title ?? x;
        if (x === 'me') return t('filter.me');
        if (x.startsWith('user:')) return nameOf(x.slice(5)) ?? x;
        if (x.startsWith('team:')) return sb.teamName(x.slice(5)) ?? x;
        return labels?.find((l) => String(l.id) === x)?.label ?? x;
      });
    return conditionFailureText({
      column_id: r.column_id,
      title: c?.title ?? r.column_id,
      operator: r.operator,
      negate: r.negate,
      values,
    });
  };
  const groupText = (g: FilterGroup) =>
    conditionLines({ kind: 'group', operator: 'and', negate: false, rules: [g] }, sb)[0] ?? '';
  const checks = conditionParts(conditions, row, env).map(({ part, met }, i) => ({
    key: `${i}`,
    met,
    text: part.kind === 'rule' ? ruleText(part) : groupText(part),
    column: part.kind === 'rule' ? editable.find((c) => c.id === part.column_id) : undefined,
  }));
  return { checks, any: conditions?.operator === 'or' && checks.length > 1 };
};

/** The list at the top of the popup: ✓ next to each condition that is met, ✗ next to what is still missing. */
export const MoveChecklist = ({ checks, any }: { checks: MoveCheck[]; any: boolean }) =>
  checks.length ? (
    <section className="space-y-1 rounded-[var(--radius-sm)] bg-surface-2 px-3 py-2" data-testid="popup-checklist">
      <p className="text-xs text-fg-2">
        {t('popup.checklist')}
        {any ? <span className="text-muted"> · {t('popup.checklist.any')}</span> : null}
      </p>
      <ul className="space-y-0.5 text-sm">
        {checks.map((c) => (
          <li
            key={c.key}
            className="flex items-start gap-2"
            data-testid="popup-check"
            data-met={c.met ? 'true' : 'false'}
          >
            <span
              aria-label={c.met ? t('popup.checklist.met') : t('popup.checklist.unmet')}
              className={cn('w-4 shrink-0 text-center', c.met ? 'text-ok-fg' : 'text-danger-fg')}
            >
              {c.met ? '✓' : '✗'}
            </span>
            <span className="min-w-0">
              {c.text}
              {!c.met && !c.column ? (
                <span className="text-xs text-muted"> · {t('popup.checklist.locked')}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  ) : null;
