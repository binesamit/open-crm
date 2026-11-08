// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { MAIN_TABLE_COLUMN_ORDERS, t, type MainTableColumnOrder } from '@bines/shared';
import { api, errorMessage } from '../../../lib/api';
import { showToast } from '../../../lib/toast';
import { boardKeys, type BoardDetail } from '../board-api';
import { PickerButton } from '../toolbar/parts';

const LABEL: Record<MainTableColumnOrder, () => string> = {
  shared: () => t('viewSettings.mainOrder.shared'),
  personal: () => t('viewSettings.mainOrder.personal'),
};

/**
 * a board setting, shown in the default table's settings — a column drag there moves the board's own
 * columns for everyone (`shared`, default) or keeps each person's own order (`personal`). Changing it needs
 * `board.update`; anyone else sees what it is.
 */
export const MainTableOrderSetting = ({ accountId, board }: { accountId: string; board: BoardDetail }) => {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (main_table_column_order: MainTableColumnOrder) =>
      api(accountId).patch<BoardDetail>(`/boards/${board.id}`, { main_table_column_order }),
    onSuccess: () => qc.invalidateQueries({ queryKey: boardKeys.board(accountId, board.id) }),
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const current = board.main_table_column_order;
  return (
    <div className="border-t border-line pt-3" data-testid="main-table-order">
      <div className="mb-1 text-xs font-medium text-muted">{t('viewSettings.mainOrder')}</div>
      {board.capabilities['board.update'] ? (
        <PickerButton
          testId="main-table-order-picker"
          menuLabel={t('viewSettings.mainOrder')}
          placeholder={LABEL.shared()}
          label={LABEL[current]()}
          className="w-full"
          items={MAIN_TABLE_COLUMN_ORDERS.map((o) => ({
            label: LABEL[o](),
            checked: current === o,
            onSelect: () => current !== o && save.mutate(o),
          }))}
        />
      ) : (
        <p className="text-sm" data-testid="main-table-order-value">
          {LABEL[current]()}
        </p>
      )}
    </div>
  );
};
