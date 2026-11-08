// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { t, widgetTypes, type Widget, type WidgetItems, type WidgetPick } from '@bines/shared';
import { Button, SkeletonRows, useEscapeClose } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';

/**
 * Prod / — a widget's drill-down: a click on a value (a number, a bar, a segment, a person) lists
 * the items behind it in a side panel, and a click on an item opens its card over the page, never leaving it. Where
 * the widget lives decides how: a workspace dashboard asks its widget's items endpoint and opens the card over the
 * dashboard; a board's Dashboard view asks the board and opens the card over the board.
 */
export type DrillSource = {
  /** A cache key for this place's drills (the dashboard / the board view). */
  key: readonly unknown[];
  fetch: (widget: Widget, pick: WidgetPick, cursor?: string) => Promise<WidgetItems>;
  openItem: (boardId: string, itemId: string) => void;
};

export const WidgetDrillContext = createContext<DrillSource | null>(null);
export const useDrillSource = () => useContext(WidgetDrillContext);

/** Whether a click on this widget's values lists items (its type can, and its "click shows items" is on). */
export const canDrill = (widget: Widget) =>
  !!widgetTypes.get(widget.type)?.drill?.length && (widget.settings as { drill?: boolean }).drill !== false;

export type DrillState = { pick: WidgetPick; label: string };

export const DrillPanel = ({
  widget,
  title,
  drill,
  source,
  onClose,
}: {
  widget: Widget;
  title: string;
  drill: DrillState;
  source: DrillSource;
  onClose: () => void;
}) => {
  const panel = useRef<HTMLElement>(null);
  useEscapeClose(panel, true, onClose);
  const q = useInfiniteQuery({
    queryKey: [...source.key, 'drill', widget.id, widget.type, widget.settings, drill.pick],
    queryFn: ({ pageParam }) => source.fetch(widget, drill.pick, pageParam || undefined),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const total = q.data?.pages[0]?.total;
  const heading = drill.label ? `${title} · ${drill.label}` : title;
  return (
    <aside
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-label={heading}
      data-testid="widget-drill-panel"
      className="anim-from-end fixed inset-y-0 end-0 z-panel flex w-full flex-col border-s border-line bg-surface shadow-[var(--shadow-panel)] outline-none md:max-w-[380px]"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <header className="flex items-start gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-heading" title={heading}>
            {heading}
          </h2>
          {total !== undefined ? (
            <p className="text-xs text-muted" data-testid="widget-drill-total">
              {t('dashboards.items', { n: total })}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('dashboards.drill.close')}
          className="grid size-8 place-items-center rounded-[var(--radius-sm)] text-muted hover:bg-surface-2 hover:text-fg"
          data-testid="widget-drill-close"
        >
          <Icon name="x" size={16} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {q.isPending ? (
          <SkeletonRows rows={6} label={t('app.loading')} />
        ) : q.isError ? (
          <p className="px-2 text-sm text-danger-fg">{errorMessage(q.error)}</p>
        ) : !rows.length ? (
          <p className="px-2 py-4 text-sm text-muted">{t('dashboards.drill.empty')}</p>
        ) : (
          <ul className="grid gap-0.5">
            {rows.map((r) => (
              <li key={`${r.board_id}:${r.id}`}>
                <button
                  type="button"
                  onClick={() => source.openItem(r.board_id, r.id)}
                  className="flex w-full flex-col items-start rounded-[var(--radius-sm)] px-2 py-1.5 text-start hover:bg-surface-2"
                  data-testid="widget-drill-item"
                  data-name={r.name}
                >
                  <span className="w-full truncate text-[0.8125rem] text-fg">
                    {r.parent_name ? <span className="text-muted">{r.parent_name} › </span> : null}
                    {r.name}
                  </span>
                  <span className="w-full truncate text-xs text-muted">{r.board_name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {q.hasNextPage ? (
          <div className="px-2 pt-2">
            <Button
              variant="secondary"
              size="sm"
              busy={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
              data-testid="widget-drill-more"
            >
              {t('dashboards.drill.more')}
            </Button>
          </div>
        ) : null}
      </div>
    </aside>
  );
};
