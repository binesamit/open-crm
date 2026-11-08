// SPDX-License-Identifier: AGPL-3.0-only
import { AI_IMAGE_RERUN_MODES, type AiImageRerunMode, aiColumnSettingsSchema, msgKey, t } from '@bines/shared';
import type { MenuEntry } from '@bines/ui';
import type { Column } from '../board/board-api';

/** An AI column that makes images (round 4: its runs offer what to do with items that already have designs). */
export const isImageAiColumn = (column: Pick<Column, 'settings'>) =>
  aiColumnSettingsSchema.parse(column.settings ?? {}).output === 'image';

/**
 * The run-time choice (round 4) for items that already have designs — the cell's ▶, the batch bar's
 * AI run and "run on all": a new version of each design, or another design. The column's own setting comes first,
 * marked as such; the run sends it as `on_existing`.
 */
export const onExistingEntries = (
  column: Pick<Column, 'settings'>,
  run: (onExisting: AiImageRerunMode) => void,
  testId: string,
): MenuEntry[] => {
  const own = aiColumnSettingsSchema.parse(column.settings ?? {}).image_on_rerun;
  const order = [own, ...AI_IMAGE_RERUN_MODES.filter((m) => m !== own)];
  return [
    { kind: 'label', label: t('ai2.run.onExisting') },
    ...order.map((m): MenuEntry => ({
      label:
        m === own ? t('ai2.run.columnDefault', { label: t(msgKey(`ai2.rerun.${m}`)) }) : t(msgKey(`ai2.rerun.${m}`)),
      testId: `${testId}-${m}`,
      onSelect: () => run(m),
    })),
  ];
};
