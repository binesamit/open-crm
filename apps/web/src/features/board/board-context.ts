// SPDX-License-Identifier: AGPL-3.0-only
import { createContext } from 'react';
import type { QueryRow, RowColors } from '@bines/shared';

/** Account id + slug and the signed-in user, for components deep inside the board (cells, rows). */
export const BoardAccountContext = createContext({ id: '', slug: '', meId: '' });

/** Conditional coloring of the current view (compiled once per view settings): an item's row / cell colours. */
export const ColoringContext = createContext<((item: QueryRow) => RowColors) | null>(null);
