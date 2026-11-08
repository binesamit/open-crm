// SPDX-License-Identifier: AGPL-3.0-only
import { useQueryClient } from '@tanstack/react-query';
import { type AiImageRerunMode, t } from '@bines/shared';
import { Menu, useActionMenu, type MenuEntry } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import type { BoardDetail, Column } from '../board/board-api';
import { runStartToast, runToast } from './AiCell';
import { useRunAiColumn } from './ai2-api';
import { isImageAiColumn, onExistingEntries } from './run-choice';
import { usePlanGate } from '../../lib/plan-gate';
import { gateMenuEntry, planGateAttrs } from '../../lib/plan-limit';

/**
 * AI columns (מ11) from the batch bar and the column menu: fill the selected items / the empty cells / all — or, for
 * an image column (the images queue), complete only the designs that were not made (`onlyMissing`).
 */
const useRun = (accountId: string, boardId: string) => {
  const qc = useQueryClient();
  const run = useRunAiColumn(accountId, boardId, { onStart: runStartToast });
  return (
    columnId: string,
    mode: 'items' | 'empty' | 'all',
    itemIds?: string[],
    onExisting?: AiImageRerunMode,
    onlyMissing?: boolean,
  ) =>
    run.mutate(
      {
        columnId,
        mode,
        ...(itemIds ? { item_ids: itemIds } : {}),
        ...(onExisting ? { on_existing: onExisting } : {}),
        ...(onlyMissing ? { only_missing: true } : {}),
      },
      {
        onSuccess: (r) => runToast(accountId, r, () => qc.invalidateQueries({ queryKey: ['account', accountId] })),
        onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
      },
    );
};

const aiColumns = (board: BoardDetail) => board.columns.filter((c) => c.type === 'ai' && !c.read_only);

/** The batch bar's "AI" button: run one of the board's AI columns on the selected items. */
export const AiBatchButton = ({
  accountId,
  board,
  itemIds,
  className,
}: {
  accountId: string;
  board: BoardDetail;
  itemIds: string[];
  className: string;
}) => {
  const menu = useActionMenu();
  const go = useRun(accountId, board.id);
  const aiGate = usePlanGate(accountId, 'ai');
  const columns = aiColumns(board);
  if (!columns.length || !board.capabilities['item.update']) return null;
  const items: MenuEntry[] = columns.map((c): MenuEntry =>
    isImageAiColumn(c)
      ? {
          kind: 'submenu',
          label: c.title,
          testId: 'batch-ai-column',
          items: [
            ...onExistingEntries(c, (on) => go(c.id, 'items', itemIds, on), 'batch-ai-existing'),
            { kind: 'separator' },
            {
              label: t('ai2.run.completeMissing'),
              testId: 'batch-ai-missing',
              onSelect: () => go(c.id, 'items', itemIds, undefined, true),
            },
          ],
        }
      : { label: c.title, testId: 'batch-ai-column', onSelect: () => go(c.id, 'items', itemIds) },
  );
  return (
    <>
      <button
        type="button"
        className={className}
        data-testid="batch-ai"
        {...planGateAttrs(aiGate)}
        onClick={aiGate.allowed ? menu.fromTrigger : undefined}
        aria-haspopup="menu"
      >
        <Icon name="sparkle" size={18} />
        {t('ai2.batch.run')}
      </button>
      <Menu at={menu.at} onClose={menu.close} items={items} label={t('ai2.batch.run')} />
    </>
  );
};

/** Extra entries of an AI column's header menu (whoever may edit items). */
export const useAiColumnMenu = (accountId: string, board: BoardDetail, column: Column): MenuEntry[] => {
  const go = useRun(accountId, board.id);
  // Plan feature gate: the run rows stay, disabled with the upgrade hint, without `ai`.
  const aiGate = usePlanGate(accountId, 'ai');
  if (column.type !== 'ai' || !board.capabilities['item.update']) return [];
  const runAll: MenuEntry =
    aiGate.allowed && isImageAiColumn(column)
      ? {
          kind: 'submenu',
          label: t('ai2.form.runAll'),
          icon: <Icon name="sparkle" size={16} />,
          testId: 'column-ai-run-all',
          items: onExistingEntries(column, (on) => go(column.id, 'all', undefined, on), 'column-ai-existing'),
        }
      : gateMenuEntry(aiGate, {
          label: t('ai2.form.runAll'),
          icon: <Icon name="sparkle" size={16} />,
          testId: 'column-ai-run-all',
          onSelect: () => go(column.id, 'all'),
        });
  return [
    gateMenuEntry(aiGate, {
      label: t('ai2.form.runEmpty'),
      icon: <Icon name="sparkle" size={16} />,
      testId: 'column-ai-run-empty',
      onSelect: () => go(column.id, 'empty'),
    }),
    runAll,
    // The images queue: only the designs not made (failed / left pending) — never a made one again.
    ...(isImageAiColumn(column)
      ? [
          gateMenuEntry(aiGate, {
            label: t('ai2.run.completeMissing'),
            icon: <Icon name="restore" size={16} />,
            testId: 'column-ai-missing',
            onSelect: () => go(column.id, 'all', undefined, undefined, true),
          }),
        ]
      : []),
  ];
};
