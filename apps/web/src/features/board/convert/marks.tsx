// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FailedConversions } from '@bines/shared';
import { Button } from '@bines/ui';
import { copyText } from '../../../lib/entity-menu';
import { columnTypeLabel } from '../../../lib/locale';
import type { Column } from '../board-api';
import { clearFailed, conversionKeys, useFailedConversions } from './convert-api';
import { t } from '@bines/shared';

/**
 * Cells that failed in a conversion (D28 §5): empty in the new type, their original value in the backup. The table
 * marks them ("the original value: …", a click copies it) until someone clears the marks, and the board can show
 * only them ("נכשלו בהמרה") for a quick manual fix.
 */
export type ConversionMarks = Map<string, Map<string, string>>;
export const ConversionMarksContext = createContext<ConversionMarks | null>(null);

export const useConversionMarks = (accountId: string, boardId: string) => {
  const failed = useFailedConversions(accountId, boardId).data?.data;
  const marks = useMemo<ConversionMarks | null>(() => {
    if (!failed?.length) return null;
    const out: ConversionMarks = new Map();
    for (const f of failed) {
      const m = out.get(f.column_id) ?? new Map<string, string>();
      for (const [itemId, text] of Object.entries(f.items)) m.set(itemId, text);
      out.set(f.column_id, m);
    }
    return out;
  }, [failed]);
  return { failed: failed ?? [], marks };
};

/** The mark in an empty cell whose conversion failed: its original value as a tooltip; a click copies it. */
export const FailedMark = ({ text }: { text: string }) => (
  <button
    type="button"
    data-testid="convert-failed-mark"
    title={t('convert.mark', { value: text })}
    aria-label={t('convert.mark', { value: text })}
    onClick={(e) => {
      e.stopPropagation();
      copyText(text);
    }}
    onPointerDown={(e) => e.stopPropagation()}
    className="absolute end-1 top-1/2 z-[1] flex size-5 -translate-y-1/2 items-center justify-center rounded-full bg-accent-soft text-[0.6875rem] font-bold text-accent-fg hover:brightness-95"
  >
    !
  </button>
);

/**
 * Above the board while a conversion has failed cells: how many, "show only them" (the filter), "clear the marks".
 */
export const ConversionBanner = ({
  accountId,
  boardId,
  failed,
  columns,
  only,
  onOnly,
}: {
  accountId: string;
  boardId: string;
  failed: FailedConversions['data'];
  columns: Column[];
  only: boolean;
  /** Absent: no quick filter (a windowed board). */
  onOnly?: (on: boolean) => void;
}) => {
  const qc = useQueryClient();
  if (!failed.length) return null;
  return (
    <div className="flex flex-col gap-1.5 px-6 pt-2" data-testid="convert-banner">
      {failed.map((f) => {
        const n = Object.keys(f.items).length;
        const title = columns.find((c) => c.id === f.column_id)?.title ?? f.column_id;
        return (
          <div
            key={f.conversion_id}
            data-testid="convert-banner-row"
            data-count={n}
            className="flex flex-wrap items-center gap-2 rounded-[10px] bg-accent-soft px-3 py-2 text-[0.8125rem] text-accent-fg"
          >
            <span>{t('convert.banner', { name: title, n, type: columnTypeLabel(f.to_type) })}</span>
            {onOnly ? (
              <Button size="sm" variant="secondary" data-testid="convert-show-failed" onClick={() => onOnly(!only)}>
                {only ? t('convert.showAll') : t('convert.showFailed')}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              data-testid="convert-clear-marks"
              onClick={() =>
                void clearFailed(accountId, boardId, f.conversion_id).then(() => {
                  onOnly?.(false);
                  return qc.invalidateQueries({ queryKey: conversionKeys.all(accountId, boardId) });
                })
              }
            >
              {t('convert.clearMarks')}
            </Button>
          </div>
        );
      })}
    </div>
  );
};

/** The items of the marked failures (the "failed in conversion" filter). */
export const failedItemIds = (failed: FailedConversions['data']) =>
  new Set(failed.flatMap((f) => Object.keys(f.items)));
