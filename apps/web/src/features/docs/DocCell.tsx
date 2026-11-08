// SPDX-License-Identifier: AGPL-3.0-only
import { lazy, Suspense, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { t } from '@bines/shared';
import { cn } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import type { CellProps } from '../board/cells';
import { openCellDoc } from './doc-api';
import { usePlanGate } from '../../lib/plan-gate';
import { planGateAttrs } from '../../lib/plan-limit';

/** The panel (and Tiptap with it) loads on first open. */
const DocPanel = lazy(() => import('./DocPanel'));

/**
 * The `doc` column's cell (M8 ד2, 03 §3.13): the doc's name — a click opens it in a side panel over the board; an
 * empty cell offers "new doc" to whoever may change the item (the server makes it once, with the item's
 * permissions). Readers of an empty cell see nothing to open.
 */
export const DocCell = ({ column, value, editable, accountId, itemId }: CellProps) => {
  const qc = useQueryClient();
  const v = value as { doc_id?: string; name?: string } | null;
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Plan feature gate: "new doc" stays, disabled with the hint, without `docs` (open ones still open).
  const docsGate = usePlanGate(accountId, 'docs');

  const open = async () => {
    if (v?.doc_id) return setOpenId(v.doc_id);
    if (busy || !docsGate.allowed) return;
    setBusy(true);
    try {
      const res = await openCellDoc(accountId, itemId, column.id);
      setOpenId(res.doc.id);
      if (res.created) {
        await qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] });
        await qc.invalidateQueries({ queryKey: ['account', accountId, 'item'] });
      }
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full w-full items-center px-2 text-sm" data-testid="doc-cell" data-has-doc={v?.doc_id ? 'true' : 'false'}>
      {v?.doc_id ? (
        <button
          type="button"
          onClick={() => void open()}
          className="flex min-w-0 max-w-full items-center gap-1.5 rounded-[6px] px-1.5 py-0.5 text-start hover:bg-surface-2"
          title={t('docs2.cell.open', { name: v.name ?? '' })}
          data-testid="doc-cell-open"
        >
          <Icon name="file" size={14} className="shrink-0 text-info-fg" />
          <span className="truncate font-medium text-fg" data-testid="cell-value">
            {v.name || t('docs.untitled')}
          </span>
        </button>
      ) : editable ? (
        <button
          type="button"
          onClick={() => void open()}
          disabled={busy}
          {...planGateAttrs(docsGate)}
          className={cn(
            'flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-xs text-muted hover:bg-surface-2 hover:text-fg',
            busy && 'opacity-60',
            !docsGate.allowed && 'cursor-not-allowed opacity-45',
          )}
          aria-label={t('docs2.cell.new')}
          data-testid="doc-cell-new"
        >
          <Icon name="plus" size={13} strokeWidth={2.2} />
          {t('docs2.cell.new')}
        </button>
      ) : null}
      {openId ? (
        <Suspense fallback={null}>
          <DocPanel accountId={accountId} docId={openId} onClose={() => setOpenId(null)} />
        </Suspense>
      ) : null}
    </div>
  );
};
