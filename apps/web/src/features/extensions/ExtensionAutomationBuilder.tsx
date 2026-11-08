// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useRef, useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { dateInZone, getRegion, queryColumnOf, t, type DraftRecipe, type QueryEnv } from '@bines/shared';
import { Dialog, SkeletonRows } from '@bines/ui';
import { BoardAccountContext } from '../board/board-context';
import { useBoard, useMembers, useTags, useTeams } from '../board/board-api';
import type { FilterCtx } from '../board/toolbar/FilterPanel';
import { useAccountLocale } from '../board/views/views-api';
import { Builder } from '../automations/Builder';

/** What `openAutomationBuilder` answers the page when the dialog closes. */
export type AutomationBuilderResult = { saved: boolean; automation_id?: string };

/**
 * A new automation's draft whose trigger is one of an extension's own triggers (`<extension>.<key>`), with its
 * inputs prefilled (e.g. which button it listens to).
 */
export const extensionTriggerDraft = (
  block: string,
  config?: { with_item?: boolean; inputs?: Record<string, string> },
): DraftRecipe => ({
  trigger: {
    type: 'extension_trigger',
    block,
    with_item: config?.with_item === true,
    ...(config?.inputs && Object.keys(config.inputs).length ? { inputs: { ...config.inputs } } : {}),
  },
  actions: [],
});

/**
 * the app's own automation builder (the same `Builder` as the board's automations), opened by an
 * extension's page (`openAutomationBuilder`) over the page, for one board, its trigger already chosen. It saves with
 * the member's own session and rights (the server refuses anyone who may not manage the board's automations), and
 * hands back whether an automation was saved, and which.
 */
export const ExtensionAutomationBuilder = ({
  accountId,
  meId,
  boardId,
  draft,
  lockedInputs,
  onDone,
}: {
  accountId: string;
  meId: string;
  boardId: string;
  draft: DraftRecipe;
  /** The trigger inputs the page prefilled: shown, not editable. */
  lockedInputs?: string[];
  onDone: (result: AutomationBuilderResult) => void;
}) => {
  const { accountSlug = '' } = useParams({ strict: false }) as { accountSlug?: string };
  const board = useBoard(accountId, boardId).data;
  const subBoard = useBoard(accountId, board?.subitems_board_id ?? '').data;
  const membersData = useMembers(accountId).data;
  const members = useMemo(() => membersData?.data ?? [], [membersData]);
  const teams = useTeams(accountId).data?.data;
  const tags = useTags(accountId).data?.data;
  const locale = useAccountLocale(accountId).data;
  const timezone = locale?.timezone ?? 'Asia/Jerusalem';
  const [today] = useState(() => dateInZone(new Date(), timezone));
  const saved = useRef<AutomationBuilderResult>({ saved: false });
  const env = useMemo<QueryEnv>(
    () => ({
      columns: (board?.columns ?? []).map(queryColumnOf),
      subitems: (subBoard?.columns ?? []).filter((c) => c.type !== 'name').map(queryColumnOf),
      meId,
      teams: (teams ?? []).map((x) => ({ id: x.id, member_ids: x.member_ids })),
      today,
      timezone,
      weekend: locale?.weekend ?? 'fri_sat',
      firstDay: locale?.first_day ?? 0,
      calendar: getRegion().calendar,
    }),
    [board?.columns, subBoard?.columns, meId, teams, today, timezone, locale],
  );
  if (!board)
    return (
      <Dialog open title={t('auto.builder.new')} onClose={() => onDone({ saved: false })}>
        <SkeletonRows rows={4} label={t('common.loading')} />
      </Dialog>
    );
  const filterCtx: FilterCtx = {
    env,
    columns: board.columns,
    subColumns: (subBoard?.columns ?? []).filter((c) => c.type !== 'name'),
    groups: board.groups,
    members,
    teams: teams ?? [],
    tags: tags ?? [],
    meId,
  };
  return (
    <BoardAccountContext.Provider value={{ id: accountId, slug: accountSlug, meId }}>
      <Builder
        board={board}
        members={members}
        filterCtx={filterCtx}
        initial={draft}
        lockedTriggerInputs={lockedInputs}
        onSaved={(a) => (saved.current = { saved: true, automation_id: a.id })}
        onClose={() => onDone(saved.current)}
      />
    </BoardAccountContext.Provider>
  );
};
