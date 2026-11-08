// SPDX-License-Identifier: AGPL-3.0-only
import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useRouteContext } from '@tanstack/react-router';
import { t, type Me, type MyAccount } from '@bines/shared';
import { Notice, SkeletonRows, useEscapeClose, useLayer } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { docPath, useDoc } from './doc-api';
import { DocView } from './DocPage';


/**
 * A cell's doc in a side panel over the board (M8 ד2): the same live doc as its page — blocks, comments,
 * versions — at the inline-end edge, with "open as a page". An outside click closes it (the shared layers); Esc
 * closes it like the item card (round 13, `useEscapeClose`): typing in the doc, the first Esc only leaves the editor.
 */
const DocPanel = ({ accountId, docId, onClose }: { accountId: string; docId: string; onClose: () => void }) => {
  const { account, me } = useRouteContext({ strict: false }) as { account?: MyAccount; me?: Me };
  const doc = useDoc(accountId, docId);
  const ref = useRef<HTMLDivElement>(null);
  // Esc is not the layer's: the editor (its slash / mention lists) gets it first, then `useEscapeClose`.
  useLayer(ref, true, onClose, () => false);
  useEscapeClose(ref, true, onClose);
  if (!account || !me) return null;
  return createPortal(
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-label={doc.data?.name ?? t('docs2.cell.panel')}
      data-testid="doc-panel"
      // Fix: (product owner: "a right click in the doc works on the board's table"): the panel is a portal, and React
      // passes its events up to the cell it was opened from — the board row's menus must never get them.
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) e.stopPropagation();
      }}
      className="anim-dialog fixed inset-y-0 end-0 z-panel flex w-[min(820px,100vw)] flex-col border-s outline-none border-line bg-surface shadow-[var(--shadow-panel)]"
    >
      <div className="flex items-center gap-2 border-b border-line-soft px-4 py-2">
        <span className="flex-1 text-xs font-semibold text-muted">{t('docs2.cell.panel')}</span>
        <a
          href={docPath(account.slug, docId)}
          className="inline-flex items-center gap-1 rounded-[8px] px-2 py-1 text-xs font-semibold text-primary hover:bg-surface-2"
          data-testid="doc-panel-page"
        >
          {t('docs2.cell.asPage')}
          <Icon name="ext" size={12} />
        </a>
        <button
          type="button"
          onClick={onClose}
          className="grid size-8 place-items-center rounded-[10px] text-muted hover:bg-surface-2 hover:text-fg"
          aria-label={t('common.close')}
          title={t('common.close')}
          data-testid="doc-panel-close"
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {doc.isPending ? (
          <SkeletonRows rows={6} label={t('app.loading')} />
        ) : !doc.data ? (
          <Notice tone="error">{doc.error ? errorMessage(doc.error) : t('error.not_found')}</Notice>
        ) : (
          <DocView account={account} me={me} doc={doc.data} variant="panel" />
        )}
      </div>
    </div>,
    document.body,
  );
};

export default DocPanel;
