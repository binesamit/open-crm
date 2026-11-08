// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useMemo, useState } from 'react';
import {
  dateInZone,
  getRegion,
  t,
  type ChoiceFilter,
  type FilterGroup,
  type QueryEnv,
  queryColumnOf,
} from '@bines/shared';
import { Field, Notice, Segmented } from '@bines/ui';
import { useBoard, useMembers, useTags, useTeams } from './board-api';
import { BoardAccountContext } from './board-context';
import { FilterGroupEditor, type FilterCtx } from './toolbar/FilterPanel';
import { emptyGroup } from './toolbar/filter-model';
import { PickerButton } from './toolbar/parts';
import { useAccountLocale, useViews } from './views/views-api';

/** What the relation column's settings dialog edits for its filters (r19relfilter). */
export type ChoiceState = {
  /** Linked board id → its filter (a board left out offers every item). */
  filters: Record<string, ChoiceFilter>;
  onlyMatching: boolean;
  enforceApi: boolean;
  caption: string;
};

export const choiceStateOf = (settings: Record<string, unknown>): ChoiceState => ({
  filters: { ...((settings.choice_filter as Record<string, ChoiceFilter> | undefined) ?? {}) },
  onlyMatching: settings.only_matching_in_cell === true,
  enforceApi: settings.choice_filter_api !== false,
  caption: typeof settings.choice_caption === 'string' ? settings.choice_caption : '',
});

/** The settings to save: filters of the boards still linked; defaults are left out. */
export const choiceSettings = (base: Record<string, unknown>, s: ChoiceState, boardIds: string[]) => {
  const { choice_filter: _f, only_matching_in_cell: _o, choice_filter_api: _a, choice_caption: _c, ...rest } = base;
  // A view not picked yet (no shared view on that board) is not saved.
  const filters = Object.fromEntries(
    Object.entries(s.filters).filter(([b, f]) => boardIds.includes(b) && (f.mode !== 'view' || f.view_id)),
  );
  return {
    ...rest,
    ...(Object.keys(filters).length ? { choice_filter: filters } : {}),
    ...(s.onlyMatching ? { only_matching_in_cell: true } : {}),
    ...(!s.enforceApi ? { choice_filter_api: false } : {}),
    ...(s.caption.trim() ? { choice_caption: s.caption.trim().slice(0, 120) } : {}),
  };
};

/**
 * "Offer only items that…" in a relation column's settings (plan ס3): per linked board — every item, a shared
 * view of that board (a live link: the view's filter today), or a filter built here with the board filter's
 * editor on that board's columns. Plus: show only matching links in the cell, enforce in the API, a caption.
 */
export const RelationFilterSection = ({
  accountId,
  boardIds,
  boardNames,
  state,
  onChange,
}: {
  accountId: string;
  boardIds: string[];
  boardNames: Map<string, string>;
  state: ChoiceState;
  onChange: (s: ChoiceState) => void;
}) => {
  const any = boardIds.some((b) => state.filters[b]);
  return (
    <div className="space-y-3 rounded-[var(--radius)] border border-line p-3" data-testid="relation-filter-section">
      <p className="text-xs font-semibold text-fg-2">{t('relfilter.title')}</p>
      {boardIds.map((b) => (
        <BoardChoice
          key={b}
          accountId={accountId}
          boardId={b}
          title={boardIds.length > 1 ? (boardNames.get(b) ?? '') : null}
          value={state.filters[b] ?? null}
          onChange={(f) => {
            const filters = { ...state.filters };
            if (f) filters[b] = f;
            else delete filters[b];
            onChange({ ...state, filters });
          }}
        />
      ))}
      {any ? (
        <>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="relation-only-matching"
              className="size-[0.9375rem] accent-[var(--check)]"
              checked={state.onlyMatching}
              onChange={() => onChange({ ...state, onlyMatching: !state.onlyMatching })}
            />
            {t('relfilter.onlyMatching')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="relation-enforce-api"
              className="size-[0.9375rem] accent-[var(--check)]"
              checked={state.enforceApi}
              onChange={() => onChange({ ...state, enforceApi: !state.enforceApi })}
            />
            {t('relfilter.enforceApi')}
          </label>
          <Field label={t('relfilter.caption')} hint={t('relfilter.captionHint')}>
            <input
              value={state.caption}
              maxLength={120}
              data-testid="relation-filter-caption-input"
              onChange={(e) => onChange({ ...state, caption: e.target.value })}
              className="h-9 w-full rounded-[10px] border border-line-strong bg-surface px-2.5 text-sm outline-none focus:border-primary"
            />
          </Field>
          <p className="text-xs text-muted">{t('relfilter.keepNote')}</p>
        </>
      ) : null}
    </div>
  );
};

type Mode = 'none' | 'view' | 'filter';

const BoardChoice = ({
  accountId,
  boardId,
  title,
  value,
  onChange,
}: {
  accountId: string;
  boardId: string;
  title: string | null;
  value: ChoiceFilter | null;
  onChange: (f: ChoiceFilter | null) => void;
}) => {
  const mode: Mode = value?.mode ?? 'none';
  const viewList = useViews(accountId, boardId);
  const views = (viewList.data?.data ?? []).filter((v) => v.visibility === 'shared');
  const viewsLoaded = viewList.isSuccess;
  // The last built filter survives switching to a view and back (until the dialog closes).
  const [draft, setDraft] = useState<FilterGroup>(value?.mode === 'filter' ? value.filter : emptyGroup());
  const chosenView = value?.mode === 'view' ? views.find((v) => v.id === value.view_id) : undefined;
  return (
    <div className="space-y-2" data-testid={`relation-filter-board-${boardId}`}>
      {title ? <p className="text-xs text-muted">{title}</p> : null}
      <Segmented<Mode>
        label={t('relfilter.title')}
        value={mode}
        testId="relation-filter-mode"
        onChange={(m) =>
          onChange(
            m === 'none'
              ? null
              : m === 'view'
                ? views[0]
                  ? { mode: 'view', view_id: views[0].id }
                  : { mode: 'view', view_id: '' }
                : { mode: 'filter', filter: draft },
          )
        }
        options={[
          { value: 'none', label: t('relfilter.mode.none'), testId: 'relation-filter-mode-none' },
          { value: 'view', label: t('relfilter.mode.view'), testId: 'relation-filter-mode-view' },
          { value: 'filter', label: t('relfilter.mode.filter'), testId: 'relation-filter-mode-filter' },
        ]}
      />
      {value?.mode === 'view' ? (
        <>
          <PickerButton
            testId="relation-filter-view"
            menuLabel={t('relfilter.mode.view')}
            placeholder={t('relfilter.pickView')}
            label={chosenView?.name}
            items={views.map((v) => ({
              label: v.name,
              checked: v.id === value.view_id,
              onSelect: () => onChange({ mode: 'view', view_id: v.id }),
            }))}
          />
          {chosenView ? (
            <p className="text-xs text-muted" data-testid="relation-filter-live-note">
              {t('relfilter.liveView', { name: chosenView.name })}
            </p>
          ) : viewsLoaded && value.view_id ? (
            <Notice tone="warn">{t('relfilter.viewMissing')}</Notice>
          ) : !views.length && viewsLoaded ? (
            <Notice>{t('relfilter.noSharedViews')}</Notice>
          ) : null}
        </>
      ) : null}
      {value?.mode === 'filter' ? (
        <BoardFilterEditor
          accountId={accountId}
          boardId={boardId}
          group={value.filter}
          onChange={(g) => {
            setDraft(g);
            onChange({ mode: 'filter', filter: g });
          }}
        />
      ) : null}
    </div>
  );
};

/**
 * The board filter's editor, on a board's columns (its groups, the account's people / teams / tags): a relation's
 * linked board here; the AI style examples' "which items" too.
 */
export const BoardFilterEditor = ({
  accountId,
  boardId,
  group,
  onChange,
  testId = 'relation-filter-editor',
}: {
  accountId: string;
  boardId: string;
  group: FilterGroup;
  onChange: (g: FilterGroup) => void;
  testId?: string;
}) => {
  const { meId } = useContext(BoardAccountContext);
  const board = useBoard(accountId, boardId).data;
  const members = useMembers(accountId).data?.data;
  const teams = useTeams(accountId).data?.data;
  const tags = useTags(accountId).data?.data;
  const locale = useAccountLocale(accountId).data;
  const ctx = useMemo<FilterCtx | null>(() => {
    if (!board) return null;
    const timezone = locale?.timezone ?? 'Asia/Jerusalem';
    const env: QueryEnv = {
      columns: board.columns.map(queryColumnOf),
      meId,
      teams: (teams ?? []).map((x) => ({ id: x.id, member_ids: x.member_ids })),
      today: dateInZone(new Date(), timezone),
      timezone,
      weekend: locale?.weekend ?? 'fri_sat',
      firstDay: locale?.first_day ?? 0,
      calendar: getRegion().calendar,
    };
    return {
      env,
      columns: board.columns,
      subColumns: [],
      groups: board.groups,
      members: members ?? [],
      teams: teams ?? [],
      tags: tags ?? [],
      meId,
    };
  }, [board, members, teams, tags, locale, meId]);
  if (!ctx) return null;
  return (
    <div data-testid={testId}>
      <FilterGroupEditor group={group} depth={1} ctx={ctx} onChange={onChange} />
    </div>
  );
};
