// SPDX-License-Identifier: AGPL-3.0-only
import { t, type ExportRequest } from '@bines/shared';
import type { MenuEntry } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { errorMessage } from '../../lib/api';
import { downloadPost } from '../../lib/download';
import { showToast } from '../../lib/toast';

/** Download the board as Excel / CSV (M6): `request` = the view's query and columns, or a selection. */
export const exportBoard = (accountId: string, boardId: string, request: Partial<ExportRequest>) =>
  downloadPost(accountId, `/boards/${boardId}/export`, request).catch((e) =>
    showToast({ message: errorMessage(e), tone: 'error' }),
  );

/**
 * "ייצוא" (N20: in the board header's ⋯ menu): what the view shows — its filter, search, sort and visible
 * columns in its order — as Excel (with the subitems too, when the board has them) or CSV.
 */
export const exportMenuEntry = (
  accountId: string,
  boardId: string,
  request: () => Partial<ExportRequest>,
  hasSubitems = false,
): MenuEntry => ({
  kind: 'submenu',
  label: t('export.button'),
  icon: <Icon name="download" size={16} />,
  items: [
    { kind: 'label', label: t('export.view_hint') },
    {
      label: t('export.xlsx'),
      onSelect: () => void exportBoard(accountId, boardId, { ...request(), format: 'xlsx' }),
    },
    ...(hasSubitems
      ? [
          {
            label: t('export.xlsx_subitems'),
            onSelect: () =>
              void exportBoard(accountId, boardId, { ...request(), format: 'xlsx', include_subitems: true }),
          },
        ]
      : []),
    {
      label: t('export.csv'),
      onSelect: () => void exportBoard(accountId, boardId, { ...request(), format: 'csv' }),
    },
  ],
});
