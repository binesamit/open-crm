// SPDX-License-Identifier: AGPL-3.0-only
import { lazy, Suspense, useContext, useMemo, useState } from 'react';
import { paint, readIds, t, type LocationValue, type QueryEnv, type ViewSettings } from '@bines/shared';
import { cn, EmptyState, Skeleton } from '@bines/ui';
import { Icon } from '../../../lib/icons';
import { useGeoConfig } from '../../maps/map-api';
import type { BoardDetail, Column, Item, Member, useBoardMutations } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { safeField } from '../toolbar/filter-model';
import { ItemTile } from './ItemTile';
import { useOpenItem } from '../open-item';
import { chosenFields, defaultCardFields } from './KanbanView';

const MapCanvas = lazy(() => import('../../maps/MapCanvas'));

/**
 * The Map view (M8 ד10): the view's matching items on a map by a location column — markers coloured by a status
 * column (its label colours), clustered when close; a marker shows the item's card (fields chosen in the view
 * settings), which opens the item. Addresses still waiting for coordinates are counted, not hidden silently.
 */
const DEFAULT_COLOR = paint('blue');
type Label = { id: number; label: string; color: string };

export const locationColumns = (board: BoardDetail) => board.columns.filter((c) => c.type === 'location');
export const colorColumns = (board: BoardDetail, env: QueryEnv) =>
  board.columns.filter((c) => {
    const f = safeField(c.id, env);
    return f && (f.model === 'label' || f.model === 'labels') && c.type !== 'dropdown';
  });

export const MapView = ({
  board,
  items,
  settings,
  env,
  members,
  mutations,
}: {
  board: BoardDetail;
  items: Item[];
  settings: ViewSettings;
  env: QueryEnv;
  members: Member[];
  mutations: ReturnType<typeof useBoardMutations>;
}) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const geo = useGeoConfig(accountId).data;
  const [selected, setSelected] = useState<string | null>(null);
  const locCols = locationColumns(board);
  const locCol = locCols.find((c) => c.id === settings.map?.location_column_id) ?? locCols[0];
  const colorCol =
    board.columns.find((c) => c.id === settings.map?.color_by) ??
    (settings.map?.color_by === '' ? undefined : colorColumns(board, env)[0]);
  const fields = useMemo(() => {
    const chosen = settings.map?.card_fields;
    const picked = chosen?.length ? chosenFields(board, chosen) : [];
    return picked.length ? picked : defaultCardFields(board, locCol?.id);
  }, [settings.map?.card_fields, board, locCol?.id]);

  const { markers, pending, failed } = useMemo(() => {
    const out: { id: string; lat: number; lng: number; color: string; label: string }[] = [];
    let pending = 0;
    let failed = 0;
    if (!locCol) return { markers: out, pending, failed };
    const f = colorCol ? safeField(colorCol.id, env) : null;
    const labels = ((colorCol?.settings.labels as Label[] | undefined) ?? []).filter(Boolean);
    for (const it of items) {
      const v = it.cells[locCol.id]?.value as LocationValue | undefined;
      if (!v) continue;
      if (v.lat === undefined || v.lng === undefined) {
        if (v.geocode_failed) failed++;
        else pending++;
        continue;
      }
      const labelId = f ? readIds(it, f)[0] : undefined;
      const color = paint(labels.find((l) => String(l.id) === labelId)?.color) ?? DEFAULT_COLOR;
      out.push({ id: it.id, lat: v.lat, lng: v.lng, color, label: it.name });
    }
    return { markers: out, pending, failed };
  }, [items, locCol, colorCol, env]);

  if (!locCol)
    return (
      <EmptyState icon={<Icon name="map" size={28} />} title={t('mapView.noColumn')} testId="map-no-column">
        {t('mapView.noColumnHint')}
      </EmptyState>
    );
  const chosen = selected ? items.find((i) => i.id === selected) : undefined;
  const located = items.filter((i) => markers.some((m) => m.id === i.id));
  return (
    <div className="flex h-[calc(100vh-260px)] min-h-[420px] gap-3 pb-4 max-md:flex-col" data-testid="map-view">
      <div className="relative min-h-[320px] flex-1 overflow-hidden rounded-[12px] border border-line bg-surface-2">
        {geo ? (
          <Suspense fallback={<Skeleton className="h-full w-full" />}>
            <MapCanvas
              styleUrl={geo.style_url}
              markers={markers}
              onSelect={setSelected}
              selected={selected}
              popup={
                chosen && markers.some((m) => m.id === chosen.id)
                  ? {
                      id: chosen.id,
                      onClose: () => setSelected(null),
                      content: (
                        <MarkerCard
                          item={chosen}
                          fields={fields}
                          env={env}
                          members={members}
                          board={board}
                          mutations={mutations}
                        />
                      ),
                    }
                  : null
              }
            />
          </Suspense>
        ) : (
          <Skeleton className="h-full w-full" />
        )}
        {pending || failed ? (
          <div
            // r27: above the map's attribution (bottom corner, ~30px with its margin; wider when opened) and over the
            // map's own layers, on desktop and phone.
            className="absolute start-2 bottom-10 z-10 max-w-[calc(100%-1rem)] rounded-[8px] bg-surface/95 px-2.5 py-1 text-xs text-fg-2 shadow-sm"
            data-testid="map-unlocated"
          >
            {pending ? t('mapView.pending', { n: pending }) : null}
            {pending && failed ? ' · ' : null}
            {failed ? t('mapView.failed', { n: failed }) : null}
          </div>
        ) : null}
      </div>
      <aside className="flex w-80 shrink-0 flex-col gap-2 overflow-hidden max-md:w-full" data-testid="map-side">
        {chosen ? (
          <div data-testid="map-selected">
            <ItemTile
              item={chosen}
              fields={fields}
              env={env}
              members={members}
              boardId={board.id}
              menu={{ board, mutations }}
            />
          </div>
        ) : (
          <p className="rounded-[12px] border border-dashed border-line px-3 py-4 text-center text-sm text-muted">
            {t('mapView.pick')}
          </p>
        )}
        <div className="text-xs font-medium text-muted">{t('mapView.onMap', { n: markers.length })}</div>
        <ul
          className="min-h-0 flex-1 overflow-auto rounded-[12px] border border-line bg-surface"
          data-testid="map-list"
        >
          {located.map((it) => {
            const m = markers.find((x) => x.id === it.id)!;
            return (
              <li key={it.id}>
                <button
                  type="button"
                  data-testid="map-list-item"
                  data-item-name={it.name}
                  onClick={() => setSelected(it.id)}
                  className={cn(
                    'flex w-full items-center gap-2 border-b border-line-soft px-3 py-2 text-start text-sm last:border-b-0 hover:bg-surface-2',
                    selected === it.id && 'bg-info-soft',
                  )}
                >
                  <span aria-hidden className="size-2.5 shrink-0 rounded-full" style={{ background: m.color }} />
                  <span className="min-w-0 flex-1 truncate">{it.name}</span>
                  <span className="max-w-[45%] truncate text-xs text-muted">{it.cells[locCol.id]?.text}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>
    </div>
  );
};

/**
 * Fix: — the window a marker opens on the map: the item's card (the fields chosen for the map) and an
 * explicit "open item" action.
 */
const MarkerCard = ({
  item,
  fields,
  env,
  members,
  board,
  mutations,
}: {
  item: Item;
  fields: Column[];
  env: QueryEnv;
  members: Member[];
  board: BoardDetail;
  mutations: ReturnType<typeof useBoardMutations>;
}) => {
  const open = useOpenItem(board.id);
  return (
    <div className="w-72 space-y-2 text-fg" data-testid="map-popup-card" data-item-name={item.name}>
      <ItemTile
        item={item}
        fields={fields}
        env={env}
        members={members}
        boardId={board.id}
        menu={{ board, mutations }}
      />
      <button
        type="button"
        data-testid="map-popup-open"
        onClick={() => open(item.id)}
        className="flex h-8 w-full items-center justify-center gap-1.5 rounded-[10px] bg-primary text-sm font-semibold text-on-primary hover:brightness-110"
      >
        <Icon name="ext" size={14} />
        {t('mapView.openItem')}
      </button>
    </div>
  );
};
