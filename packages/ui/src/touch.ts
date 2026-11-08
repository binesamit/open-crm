// SPDX-License-Identifier: AGPL-3.0-only
/**
 * r23ui: whether the device's main pointer is a finger (a phone / tablet: `pointer: coarse`).
 * A laptop with a touch screen has a fine main pointer and answers false.
 */
export const isTouchPrimary = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

/**
 * Whether a search / filter field that opens with a menu, list, picker or palette takes the focus by itself.
 * Desktop: yes (one types at once). Phones: no — focusing a field slides the on-screen keyboard over half the list
 * before one decided to search; the field focuses when it is tapped. The single rule every search field follows.
 */
export const autoFocusSearch = (): boolean => !isTouchPrimary();
