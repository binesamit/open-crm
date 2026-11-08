// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre 6 finds its worker next to its own module (`import.meta.url`) — gone once Vite pre-bundles (dev) or
// bundles (build) the library, and the map never draws. Vite builds the worker as its own file instead.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
// The RTL text plugin (BSD-2) from our own origin — Hebrew / Arabic map labels read right to left.
import rtlPluginUrl from '../../../node_modules/@mapbox/mapbox-gl-rtl-text/dist/mapbox-gl-rtl-text.js?url';
import { getLocale, t } from '@bines/shared';
import { localizeMap } from './map-labels';

/**
 * A MapLibre map (BSD-3; M8 ד10, D25) for the Map view and the location cell's preview. Tiles come from the
 * account's style URL (OpenFreeMap by default). Markers are DOM elements over a clustered GeoJSON source — they
 * read the board's colours, take the keyboard and the pointer, and a cluster shows its count and zooms in. When the
 * style cannot load (offline, a blocked provider) the map falls back to a blank style so the markers still work.
 */
export type MapMarker = { id: string; lat: number; lng: number; color: string; label: string };

maplibregl.setWorkerUrl(maplibreWorkerUrl);

/**
 * Round 11: the plugin is WebAssembly — production's CSP must allow `'wasm-unsafe-eval'` in script-src
 * (`apps/api/src/middleware/security-headers.ts`), or MapLibre drops every label holding Hebrew (the map showed no
 * names). It is set before the first map is created; `lazy` loads it once RTL text first shows.
 */
let rtlRequested = false;
const ensureRtl = () => {
  if (rtlRequested) return;
  rtlRequested = true;
  if (maplibregl.getRTLTextPluginStatus() === 'unavailable')
    maplibregl.setRTLTextPlugin(rtlPluginUrl, true).catch(() => undefined);
};

const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e8eef3' } }],
};

const SOURCE = 'items';
type Collection = {
  type: 'FeatureCollection';
  features: { type: 'Feature'; geometry: { type: 'Point'; coordinates: [number, number] }; properties: object }[];
};
const toGeoJson = (markers: MapMarker[]): Collection => ({
  type: 'FeatureCollection',
  features: markers.map((m) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [m.lng, m.lat] },
    properties: { id: m.id, color: m.color, label: m.label },
  })),
});

const fit = (map: MlMap, markers: MapMarker[], single: boolean) => {
  if (!markers.length) return;
  if (markers.length === 1 || single) {
    map.jumpTo({ center: [markers[0]!.lng, markers[0]!.lat], zoom: 14 });
    return;
  }
  const b = new maplibregl.LngLatBounds();
  for (const m of markers) b.extend([m.lng, m.lat]);
  map.fitBounds(b, { padding: 56, maxZoom: 15, duration: 0 });
};

export default function MapCanvas({
  styleUrl,
  markers,
  onSelect,
  selected,
  single = false,
  className,
  popup,
}: {
  styleUrl: string;
  markers: MapMarker[];
  onSelect?: (id: string) => void;
  selected?: string | null;
  /** A preview of one place: no clustering, no controls but zoom. */
  single?: boolean;
  className?: string;
  /**
   * Fix: — a window over the map at a marker (the item's card): rendered by React into a MapLibre popup
   * anchored at the marker; closing it (its X, a click on the map, Esc) calls `onClose`.
   */
  popup?: { id: string; content: ReactNode; onClose: () => void } | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const domMarkers = useRef(new Map<string, maplibregl.Marker>());
  const onSelectRef = useRef(onSelect);
  const markersRef = useRef(markers);
  const selectedRef = useRef(selected);
  const [ready, setReady] = useState(false);
  const [popupBox, setPopupBox] = useState<HTMLDivElement | null>(null);
  const popupCloseRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    popupCloseRef.current = popup?.onClose;
    onSelectRef.current = onSelect;
    markersRef.current = markers;
    selectedRef.current = selected;
  });

  // The map, once (a new style URL rebuilds it).
  useEffect(() => {
    if (!box.current) return;
    ensureRtl();
    const first = markersRef.current[0];
    const map = new maplibregl.Map({
      container: box.current,
      style: styleUrl,
      center: first ? [first.lng, first.lat] : [34.85, 31.5],
      zoom: first ? 12 : 6,
      attributionControl: { compact: true },
      cooperativeGestures: false,
    });
    mapRef.current = map;
    const rtl = document.documentElement.dir === 'rtl';
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), rtl ? 'top-left' : 'top-right');
    // Round 11: place / street names in the UI language (each style load, the blank fallback has none).
    map.on('style.load', () => localizeMap(map as unknown as Parameters<typeof localizeMap>[0], getLocale()));
    let loaded = false;
    const setup = () => {
      if (map.getSource(SOURCE)) return;
      map.addSource(SOURCE, {
        type: 'geojson',
        data: toGeoJson(markersRef.current),
        cluster: !single,
        clusterRadius: 48,
        clusterMaxZoom: 15,
      });
      // An invisible layer keeps the clustered source loaded; the visible markers are DOM elements (below).
      map.addLayer({
        id: 'items-hit',
        type: 'circle',
        source: SOURCE,
        paint: { 'circle-opacity': 0, 'circle-radius': 1 },
      });
      fit(map, markersRef.current, single);
      setReady(true);
    };
    map.on('load', () => {
      loaded = true;
      setup();
    });
    // The provider is unreachable: a blank map, so the markers (and the E2E) still work.
    map.on('error', () => {
      if (loaded) return;
      loaded = true;
      map.setStyle(BLANK_STYLE);
      map.once('styledata', setup);
    });
    const dom = domMarkers.current;
    return () => {
      for (const m of dom.values()) m.remove();
      dom.clear();
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, [styleUrl, single]);

  // New data: the source, the fit when the set changed.
  const key = markers.map((m) => m.id).join(',');
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(toGeoJson(markersRef.current));
    fit(map, markersRef.current, single);
  }, [ready, key, single]);
  // Colours / labels changed without the set changing.
  const look = markers.map((m) => `${m.color}${m.label}${m.lat}${m.lng}`).join('|');
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData(toGeoJson(markersRef.current));
  }, [ready, look]);

  // The chosen item (from the list): fly to it and mark it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !selected) return;
    const m = markersRef.current.find((x) => x.id === selected);
    if (m) map.easeTo({ center: [m.lng, m.lat], zoom: Math.max(map.getZoom(), 14) });
    for (const [id, dm] of domMarkers.current)
      if (id.startsWith('p:')) dm.getElement().dataset.selected = id === `p:${selected}` ? 'true' : 'false';
  }, [ready, selected]);

  // The popup at the chosen marker (its content is portalled in below).
  const popupId = popup?.id ?? null;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !popupId) return;
    const m = markersRef.current.find((x) => x.id === popupId);
    if (!m) return;
    const box = document.createElement('div');
    box.dataset.testid = 'map-popup';
    box.dir = document.documentElement.dir || 'rtl';
    // No fixed `anchor`: MapLibre turns the popup to the side with room, so it stays inside the map (round 12);
    // on a narrow map it is never wider than the map.
    const p = new maplibregl.Popup({
      offset: 16,
      maxWidth: 'min(320px, calc(100% - 24px))',
      closeButton: true,
      focusAfterOpen: false,
    })
      .setLngLat([m.lng, m.lat])
      .setDOMContent(box)
      .addTo(map);
    let closing = false;
    p.on('close', () => {
      if (!closing) popupCloseRef.current?.();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') popupCloseRef.current?.();
    };
    document.addEventListener('keydown', onKey);
    setPopupBox(box);
    return () => {
      document.removeEventListener('keydown', onKey);
      closing = true;
      p.remove();
      setPopupBox(null);
    };
  }, [ready, popupId]);

  // DOM markers for what the clustered source shows now.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const sync = () => {
      const source = map.getSource(SOURCE) as GeoJSONSource | undefined;
      if (!source) return;
      const seen = new Set<string>();
      for (const f of map.querySourceFeatures(SOURCE)) {
        const p = f.properties as Record<string, unknown>;
        const [lng, lat] = (f.geometry as unknown as { coordinates: [number, number] }).coordinates;
        const isCluster = !!p.cluster;
        const id = isCluster ? `c:${p.cluster_id}` : `p:${p.id}`;
        if (seen.has(id)) continue;
        seen.add(id);
        let m = domMarkers.current.get(id);
        if (!m) {
          const el = document.createElement('button');
          el.type = 'button';
          if (isCluster) {
            const n = Number(p.point_count);
            el.className =
              'grid place-items-center rounded-full border-2 border-[var(--surface)] bg-[var(--primary)] text-xs font-bold text-[var(--on-primary)] shadow-md';
            el.style.width = el.style.height = `${n < 10 ? 30 : n < 100 ? 36 : 44}px`;
            el.textContent = String(p.point_count_abbreviated ?? n);
            el.dataset.testid = 'map-cluster';
            el.setAttribute('aria-label', t('map.cluster', { n }));
            const clusterId = Number(p.cluster_id);
            el.addEventListener('click', (e) => {
              e.stopPropagation();
              void source.getClusterExpansionZoom(clusterId).then((zoom) => map.easeTo({ center: [lng, lat], zoom }));
            });
          } else {
            // Fix: MapLibre places a marker by the element's own `transform`, so the element never
            // scales or transitions (that made pins jump on hover); the dot inside grows instead, around its
            // centre, and the marker's anchor stays put.
            el.className =
              'group grid size-6 place-items-center rounded-full outline-offset-1 focus-visible:outline-2 focus-visible:outline-[var(--primary)]';
            const dot = document.createElement('span');
            dot.className =
              'pointer-events-none block size-4 rounded-full border-2 border-[var(--surface)] shadow-md transition-[scale] duration-150 group-hover:scale-125 group-data-[selected=true]:scale-125 group-data-[selected=true]:ring-2 group-data-[selected=true]:ring-[var(--primary)]';
            dot.style.background = String(p.color);
            el.appendChild(dot);
            el.dataset.testid = 'map-marker';
            el.dataset.itemId = String(p.id);
            el.title = String(p.label);
            el.setAttribute('aria-label', String(p.label));
            el.addEventListener('click', (e) => {
              e.stopPropagation();
              onSelectRef.current?.(String(p.id));
            });
          }
          m = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
          domMarkers.current.set(id, m);
        } else {
          m.setLngLat([lng, lat]);
          if (!isCluster) {
            const el = m.getElement();
            const dot = el.firstElementChild as HTMLElement | null;
            if (dot) dot.style.background = String(p.color);
            el.title = String(p.label);
          }
        }
        if (!isCluster) m.getElement().dataset.selected = selectedRef.current === p.id ? 'true' : 'false';
      }
      for (const [id, m] of domMarkers.current)
        if (!seen.has(id)) {
          m.remove();
          domMarkers.current.delete(id);
        }
    };
    const onData = (e: maplibregl.MapSourceDataEvent) => {
      if (e.sourceId === SOURCE && map.isSourceLoaded(SOURCE)) sync();
    };
    sync();
    map.on('moveend', sync);
    map.on('idle', sync);
    map.on('sourcedata', onData);
    return () => {
      map.off('moveend', sync);
      map.off('idle', sync);
      map.off('sourcedata', onData);
    };
  }, [ready]);

  return (
    <>
      <div
        ref={box}
        className={className ?? 'h-full w-full'}
        data-testid={single ? 'map-preview' : 'map-canvas'}
        data-ready={ready || undefined}
        dir="ltr"
      />
      {popupBox && popup ? createPortal(popup.content, popupBox) : null}
    </>
  );
}
