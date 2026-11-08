// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The palette another work-management tool ships (its group, status and interface colours) — every hex the trade-dress
 * audit found in our code before D-PAL (docs/plans LICENSING-MODEL part ה'). Our palette must stay away from all of
 * them (palette.test.ts) and none may appear in our source (no-foreign-palette.test.ts) outside the known-input
 * tables that map imported data to our keys.
 */
export const FOREIGN_GROUP = [
  '#579bfc',
  '#00c875',
  '#037f4c',
  '#9cd326',
  '#fdab3d',
  '#e2445c',
  '#a25ddc',
  '#c4c4c4',
  '#0086c0',
  '#784bd1',
  '#ffcb00',
  '#ff642e',
  '#ff7575',
  '#bb3354',
  '#ff158a',
  '#4eccc6',
  '#225091',
  '#7f5347',
  '#808080',
];

export const FOREIGN_STATUS = [
  '#00c875',
  '#9cd326',
  '#cab641',
  '#ffcb00',
  '#784bd1',
  '#9d50dd',
  '#007eb5',
  '#579bfc',
  '#66ccff',
  '#bb3354',
  '#df2f4a',
  '#ff007f',
  '#ff5ac4',
  '#ff642e',
  '#fdab3d',
  '#7f5347',
  '#c4c4c4',
  '#757575',
  '#e2445c',
  '#0086c0',
  '#037f4c',
  '#a25ddc',
  '#225091',
  '#4eccc6',
  '#a9bee8',
  '#ff7575',
  '#e484bd',
  '#cd9282',
  '#9aadbd',
  '#7e3b8a',
  '#3d4f5e',
  '#ad967a',
  '#2b76e5',
  '#175a63',
  '#563e3e',
  '#68a1bd',
  '#8bc34a',
  '#f9c449',
  '#4a4a4a',
  '#ffadad',
];

/** The primary blue, and interface colours (text, lines, backgrounds) of the same tool. */
export const FOREIGN_UI = ['#0073ea', '#323338', '#676879', '#c3c6d4', '#e6e9ef', '#f5f6f8', '#d0d4e4', '#cce5ff'];

export const FOREIGN_PALETTE = [...new Set([...FOREIGN_GROUP, ...FOREIGN_STATUS, ...FOREIGN_UI])];
