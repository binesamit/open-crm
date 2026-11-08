// SPDX-License-Identifier: AGPL-3.0-only
import { createContext } from 'react';

/**
 * Prod fix (mobilehead): on a phone the board's compact bar (board name + view switch, search, filters, ⋯, add)
 * lives inside the shell's top bar — one 56px row instead of a title row, a tabs row and two toolbar rows. The
 * shell hands the board this element to portal its bar into; null (desktop, the item card open, no shell) means
 * the board draws the bar in its own page.
 */
export const MobileBarSlotContext = createContext<HTMLElement | null>(null);
