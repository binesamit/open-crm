// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { WidgetSize } from './types';

/**
 * The dashboard grid (plan §3.4): 12 columns counted from the inline start (the right in Hebrew), rows of a fixed
 * height. A move or a resize pushes what it lands on downwards, then everything floats up — so widgets never
 * overlap and never leave holes. Pure, so the client previews exactly what the server stores.
 */
export const GRID_COLS = 12;
export const GRID_MAX_ROWS = 400;

export const gridRectSchema = z.object({
  x: z
    .number()
    .int()
    .min(0)
    .max(GRID_COLS - 1),
  y: z.number().int().min(0).max(GRID_MAX_ROWS),
  w: z.number().int().min(1).max(GRID_COLS),
  h: z.number().int().min(1).max(40),
});
export type GridRect = z.infer<typeof gridRectSchema>;
export type GridItem = { id: string; rect: GridRect };

const overlaps = (a: GridRect, b: GridRect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Keeps a rect on the grid and at least its type's minimum size. */
export const clampRect = (r: GridRect, min: WidgetSize = { w: 1, h: 1 }): GridRect => {
  const w = Math.min(GRID_COLS, Math.max(min.w, Math.round(r.w)));
  const h = Math.min(40, Math.max(min.h, Math.round(r.h)));
  const x = Math.min(GRID_COLS - w, Math.max(0, Math.round(r.x)));
  const y = Math.min(GRID_MAX_ROWS, Math.max(0, Math.round(r.y)));
  return { x, y, w, h };
};

const byPosition = (a: GridItem, b: GridItem) => a.rect.y - b.rect.y || a.rect.x - b.rect.x || (a.id < b.id ? -1 : 1);

/** Floats every widget up as far as it goes (top to bottom), keeping columns. */
export const compactLayout = (items: GridItem[], pinned?: string): GridItem[] => {
  const placed: GridItem[] = [];
  const pin = items.find((i) => i.id === pinned);
  if (pin) placed.push(pin);
  for (const it of [...items].filter((i) => i.id !== pinned).sort(byPosition)) {
    let y = 0;
    const rect = { ...it.rect, y };
    // Lowest y where it fits without overlapping anything placed (the pinned one keeps its place).
    for (;;) {
      rect.y = y;
      const hit = placed.find((p) => overlaps(p.rect, rect));
      if (!hit) break;
      y = hit.rect.y + hit.rect.h;
    }
    placed.push({ id: it.id, rect: { ...rect } });
  }
  const order = new Map(items.map((i, n) => [i.id, n]));
  return placed.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
};

/** Puts one widget at `rect` (a drop or a resize): it keeps that place, the rest make room and float up. */
export const placeWidget = (items: GridItem[], id: string, rect: GridRect): GridItem[] =>
  compactLayout(
    items.map((i) => (i.id === id ? { id, rect } : i)),
    id,
  );

/** Where a new widget goes: the first row under everything, at the start. */
export const nextFreeRect = (items: GridItem[], size: WidgetSize): GridRect => ({
  x: 0,
  y: items.reduce((m, i) => Math.max(m, i.rect.y + i.rect.h), 0),
  w: Math.min(GRID_COLS, size.w),
  h: size.h,
});

/** Reading order on a phone (one column): top to bottom, then from the inline start. */
export const mobileOrder = <T extends { position: GridRect }>(widgets: T[]): T[] =>
  [...widgets].sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
