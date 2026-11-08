// SPDX-License-Identifier: AGPL-3.0-only
import { cloneElement, type CSSProperties, type ReactElement, useState } from 'react';
import type { IconStyle } from '@bines/shared';
import { useIconStyle } from './icon-style';

/**
 * The app's icons (24×24 grid, currentColor), drawn in the user's icon style (the approved canvas
 * the approved canvas is the spec). Each icon is a list of parts:
 *  - `b` — a closed main shape: tinted in `duo`, filled in `solid`;
 *  - `k` — a detail drawn on the main shape (cut out of it in `solid`);
 *  - `o` — a line outside the main shape (always a plain stroke);
 *  - a trailing `*` marks the icon's accent part: a stronger tint in `duo`, the brand amber in `accent`.
 */
export type IconRole = 'b' | 'b*' | 'k' | 'k*' | 'o' | 'o*';
export type IconPart = readonly [IconRole, ReactElement];

const PATHS = {
  plus: [
    ['b', <circle cx="12" cy="12" r="9" />],
    ['k*', <path d="M12 8v8M8 12h8" />],
  ],
  search: [
    ['b', <circle cx="11" cy="11" r="6.5" />],
    ['o*', <path d="M20 20l-4.2-4.2" />],
  ],
  filter: [['b*', <path d="M4 5h16l-6 8v5l-4 2v-7z" />]],
  sort: [
    ['o', <path d="M7 4v16M4 17l3 3 3-3" />],
    ['o*', <path d="M17 20V4M14 7l3-3 3 3" />],
  ],
  eye: [
    ['b', <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />],
    ['k*', <circle cx="12" cy="12" r="3" />],
  ],
  // "Seen by": the device an update was seen on.
  desktop: [
    ['b', <rect x="3" y="4" width="18" height="12" rx="2" />],
    ['o*', <path d="M8 20h8M12 16v4" />],
  ],
  mobile: [
    ['b', <rect x="7" y="2.5" width="10" height="19" rx="2" />],
    ['k*', <path d="M11 18.5h2" />],
  ],
  tablet: [
    ['b', <rect x="4.5" y="2.5" width="15" height="19" rx="2" />],
    ['k*', <path d="M11 18.5h2" />],
  ],
  eyeOff: [
    ['o*', <path d="M3 3l18 18" />],
    [
      'o',
      <path d="M10.6 6.1A10 10 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.8M6.6 7.6C3.8 9.4 2 12 2 12s4 7 10 7a9.6 9.6 0 0 0 4.4-1" />,
    ],
  ],
  group: [
    ['b', <rect x="3" y="4" width="18" height="6" rx="2" />],
    ['b*', <rect x="3" y="14" width="18" height="6" rx="2" />],
  ],
  palette: [
    [
      'b',
      <path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.6-.8 1.6-1.6 0-.9-.6-1.2-.6-2.1 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4c0-4.9-4-8.7-9-8.7z" />,
    ],
    ['k*', <path d="M7.5 11h.01M10.5 7h.01M15 7.5h.01" />],
  ],
  person: [
    ['b', <circle cx="12" cy="8" r="4" />],
    ['b*', <path d="M4 21a8 8 0 0 1 16 0z" />],
  ],
  gear: [
    [
      'b',
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />,
    ],
    ['k*', <circle cx="12" cy="12" r="3" />],
  ],
  collapse: [
    ['o', <path d="M4 9h16M4 15h16" />],
    ['o*', <path d="M9 4l3 3 3-3M9 20l3-3 3 3" />],
  ],
  expand: [
    ['o', <path d="M4 12h16" />],
    ['o*', <path d="M9 7l3-3 3 3M9 17l3 3 3-3" />],
  ],
  download: [
    ['o*', <path d="M12 4v11M7 10l5 5 5-5" />],
    ['o', <path d="M5 20h14" />],
  ],
  bolt: [['b*', <path d="M13 3 5 14h6l-1 7 8-11h-6z" />]],
  bell: [
    ['b', <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.8 1.8H4.2z" />],
    ['o*', <path d="M10 20.8a2 2 0 0 0 4 0" />],
  ],
  clock: [
    ['b', <circle cx="12" cy="12" r="9" />],
    ['k*', <path d="M12 7v5l3 2" />],
  ],
  lock: [
    ['b', <rect x="5" y="11" width="14" height="10" rx="2" />],
    ['o', <path d="M8 11V8a4 4 0 0 1 8 0v3" />],
    ['k*', <path d="M12 15v2" />],
  ],
  history: [
    ['o', <path d="M4 12a8 8 0 1 0 2.3-5.6L4 9M4 4v5h5" />],
    ['o*', <path d="M12 8v4l3 2" />],
  ],
  table: [
    ['b', <rect x="3" y="4" width="18" height="16" rx="2" />],
    ['k', <path d="M3 9.5h18M3 15h18" />],
    ['k*', <path d="M9 4v16" />],
  ],
  kanban: [
    ['b', <rect x="3" y="4" width="5" height="14" rx="1.5" />],
    ['b*', <rect x="10" y="4" width="5" height="9" rx="1.5" />],
    ['b', <rect x="17" y="4" width="4" height="11" rx="1.5" />],
  ],
  calendar: [
    ['b', <rect x="3" y="5" width="18" height="16" rx="2" />],
    ['k', <path d="M3 10h18" />],
    ['o', <path d="M8 3v4M16 3v4" />],
    ['k*', <circle cx="15.5" cy="15.5" r=".9" />],
  ],
  cards: [
    ['b', <rect x="3" y="4" width="8" height="7" rx="1.5" />],
    ['b*', <rect x="13" y="4" width="8" height="7" rx="1.5" />],
    ['b', <rect x="3" y="13" width="8" height="7" rx="1.5" />],
    ['b', <rect x="13" y="13" width="8" height="7" rx="1.5" />],
  ],
  timeline: [
    ['b', <rect x="4" y="4.5" width="10" height="4" rx="2" />],
    ['b*', <rect x="8" y="10.5" width="12" height="4" rx="2" />],
    ['b', <rect x="3" y="16.5" width="8" height="4" rx="2" />],
  ],
  gantt: [
    ['b', <rect x="3" y="4" width="8" height="4" rx="1.5" />],
    ['b*', <rect x="13" y="16" width="8" height="4" rx="1.5" />],
    ['o', <path d="M11 6h3v10M12 14l2 2 2-2" />],
  ],
  workload: [
    ['b', <rect x="4" y="11" width="4" height="9" rx="1" />],
    ['b', <rect x="10" y="6" width="4" height="14" rx="1" />],
    ['b', <rect x="16" y="13" width="4" height="7" rx="1" />],
    ['o*', <path d="M2 8.5h20" strokeDasharray="2 2" />],
  ],
  pin: [
    ['b*', <path d="M9 4h6l-1 6 3 3H7l3-3z" />],
    ['o', <path d="M12 13v8" />],
  ],
  chevronDown: [['o', <path d="M6 9l6 6 6-6" />]],
  chevronStart: [['o', <path d="M9 6l6 6-6 6" />]],
  chevronEnd: [['o', <path d="M15 6l-6 6 6 6" />]],
  chat: [
    ['b', <path d="M4 5h16v11H9l-5 4z" />],
    ['k*', <path d="M8 9.5h8M8 12.5h5" />],
  ],
  x: [['o', <path d="M6 6l12 12M18 6L6 18" />]],
  edit: [
    ['b', <path d="M4 20h4L19 9l-4-4L4 16z" />],
    ['k*', <path d="M13 7l4 4" />],
  ],
  /** A board's Dashboard view (round 15): four tiles of different heights, like a dashboard's glyph. */
  dashboard: [
    ['b', <rect x="3.5" y="3.5" width="7" height="9" rx="1.5" />],
    ['b*', <rect x="13.5" y="3.5" width="7" height="5" rx="1.5" />],
    ['b', <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" />],
    ['b', <rect x="3.5" y="15.5" width="7" height="5" rx="1.5" />],
  ],
  /** A form view (M11): a clipboard with fields. */
  form: [
    ['b', <rect x="5" y="4" width="14" height="17" rx="2" />],
    ['o', <path d="M9 4V2.8h6V4" />],
    ['k', <path d="M8.5 10h7M8.5 14h7" />],
    ['k*', <path d="M8.5 18h4" />],
  ],
  move: [
    ['o', <path d="M5 12h14" />],
    ['o*', <path d="M13 6l6 6-6 6" />],
  ],
  // phase 3: a scenario's router (one way in, branches out) and a step that did not run.
  split: [
    ['o', <path d="M20 12h-6" />],
    ['o*', <path d="M14 12l-6-6H4M14 12l-6 6H4" />],
  ],
  minus: [['o', <path d="M5 12h14" />]],
  // Moves inside the hierarchy: a row turning into a subitem of the one above.
  nest: [
    ['o', <path d="M4 5h10" />],
    ['o*', <path d="M6 9v5a3 3 0 0 0 3 3h10M16 14l3 3-3 3" />],
  ],
  duplicate: [
    ['b*', <rect x="8" y="8" width="12" height="12" rx="2" />],
    ['o', <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />],
  ],
  archive: [
    ['b', <rect x="3" y="4" width="18" height="5" rx="1" />],
    ['b', <path d="M5 9h14v10a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z" />],
    ['k*', <path d="M10 13h4" />],
  ],
  trash: [
    ['b', <path d="M6 7l1 13h10l1-13z" />],
    ['o', <path d="M4 7h16" />],
    ['o*', <path d="M9 7V4h6v3" />],
    ['k', <path d="M10 11v5M14 11v5" />],
  ],
  ext: [
    ['o*', <path d="M14 4h6v6M20 4l-9 9" />],
    ['o', <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />],
  ],
  link: [
    ['o', <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />],
    ['o*', <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />],
  ],
  copy: [
    ['b*', <rect x="8" y="8" width="12" height="12" rx="2" />],
    ['o', <path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" />],
  ],
  folder: [
    ['b', <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />],
    ['k*', <path d="M3 10.5h18" />],
  ],
  board: [
    ['b', <rect x="3" y="4" width="18" height="16" rx="2" />],
    ['k', <path d="M3 9.5h18" />],
    ['k*', <path d="M9 9.5V20" />],
  ],
  send: [
    ['b', <path d="M21 3l-7 18-4-7-7-4z" />],
    ['k*', <path d="M21 3L10 14" />],
  ],
  mail: [
    ['b', <rect x="3" y="5" width="18" height="14" rx="2" />],
    ['k*', <path d="M3 7l9 6 9-6" />],
  ],
  shield: [
    ['b', <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />],
    ['k*', <path d="M9 12l2 2 4-4" />],
  ],
  key: [
    ['b', <circle cx="8" cy="15" r="4" />],
    ['o*', <path d="M11 12l9-9M17 6l3 3" />],
  ],
  logout: [
    ['o', <path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4" />],
    ['o*', <path d="M10 16l-4-4 4-4M6 12h10" />],
  ],
  sun: [
    ['b', <circle cx="12" cy="12" r="4" />],
    [
      'o*',
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />,
    ],
  ],
  moon: [['b*', <path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />]],
  upload: [
    ['o*', <path d="M12 20V9M7 14l5-5 5 5" />],
    ['o', <path d="M5 4h14" />],
  ],
  play: [['b*', <path d="M7 5l12 7-12 7z" />]],
  reply: [
    ['o*', <path d="M10 8L4 13l6 5" />],
    ['o', <path d="M4 13h10a6 6 0 0 1 6 6" />],
  ],
  smile: [
    ['b', <circle cx="12" cy="12" r="9" />],
    ['k*', <path d="M8.5 14a4.5 4.5 0 0 0 7 0M9 9.5h.01M15 9.5h.01" />],
  ],
  heart: [['b*', <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />]],
  file: [
    ['b', <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />],
    ['k*', <path d="M14 3v5h5" />],
  ],
  clip: [['o', <path d="M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7" />]],
  /** A photo (the phone's gallery). */
  image: [
    ['b', <rect x="3.5" y="4.5" width="17" height="15" rx="2" />],
    ['k', <circle cx="9" cy="9.5" r="1.6" />],
    ['k*', <path d="M20.5 15.5l-4.5-4.5-8.5 8.5" />],
  ],
  info: [
    ['b', <circle cx="12" cy="12" r="9" />],
    ['k*', <path d="M12 11v5M12 8h.01" />],
  ],
  warn: [
    ['b', <path d="M12 3l10 18H2z" />],
    ['k*', <path d="M12 10v4M12 17h.01" />],
  ],
  building: [
    ['b', <rect x="4" y="3" width="16" height="18" rx="1" />],
    ['k', <path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" />],
    ['k*', <path d="M10 21v-3h4v3" />],
  ],
  people: [
    ['b', <circle cx="9" cy="8" r="3.5" />],
    ['b', <path d="M2.5 20a6.5 6.5 0 0 1 13 0z" />],
    ['o*', <path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-3.5-6" />],
  ],
  check: [['o', <path d="M5 12l5 5 9-10" />]],
  back: [['o', <path d="M9 6l6 6-6 6" />]],
  menu: [['o', <path d="M4 7h16M4 12h16M4 17h16" />]],
  restore: [
    ['o', <path d="M4 12a8 8 0 1 0 2.3-5.6L4 9" />],
    ['o*', <path d="M4 4v5h5" />],
  ],
  template: [
    ['b', <rect x="3" y="3" width="18" height="18" rx="2" />],
    ['k', <path d="M3 9h18" />],
    ['k*', <path d="M9 21V9" />],
  ],
  home: [
    ['b', <path d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z" />],
    ['k*', <path d="M9.5 21v-5.5h5V21" />],
  ],
  myWork: [
    ['b', <rect x="4" y="4" width="16" height="16" rx="3" />],
    ['k*', <path d="M8 12l3 3 5-6" />],
  ],
  inbox: [
    ['b', <path d="M5 5h14l1.5 8v6a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-6z" />],
    ['k*', <path d="M3.5 13H8l1.5 2.5h5L16 13h4.5" />],
  ],
  google: [['o', <path d="M21 12.2c0-.7-.1-1.3-.2-2H12v3.8h5a4.3 4.3 0 0 1-1.9 2.8M12 21a9 9 0 1 1 6.1-15.6" />]],
  // M8 ד9–ד10: chart / files / map views and the location column.
  chart: [
    ['b', <rect x="4" y="11" width="4" height="9" rx="1" />],
    ['b', <rect x="10" y="4" width="4" height="16" rx="1" />],
    ['b*', <rect x="16" y="13.5" width="4" height="6.5" rx="1" />],
  ],
  place: [
    ['b', <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />],
    ['k*', <circle cx="12" cy="9.5" r="2.5" />],
  ],
  map: [
    ['b', <path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2z" />],
    ['k*', <path d="M9 4v14M15 6v14" />],
  ],
  // מ11–מ12: AI columns and the assistant panel.
  sparkle: [
    ['b', <path d="M11 3.5l1.8 5.2L18 10.5l-5.2 1.8L11 17.5l-1.8-5.2L4 10.5l5.2-1.8z" />],
    ['b*', <path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />],
  ],
  stop: [['b*', <rect x="7" y="7" width="10" height="10" rx="2" />]],
  // The media player.
  pause: [
    ['b', <rect x="6.5" y="5" width="3.5" height="14" rx="1" />],
    ['b*', <rect x="14" y="5" width="3.5" height="14" rx="1" />],
  ],
  volume: [
    ['b', <path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z" />],
    ['o*', <path d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" />],
  ],
  mute: [
    ['b', <path d="M4 9.5v5h3.5L12 19V5L7.5 9.5z" />],
    ['o*', <path d="M16 9.5l5 5M21 9.5l-5 5" />],
  ],
  fullscreen: [['o', <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />]],
  pip: [
    ['b', <rect x="3" y="5" width="18" height="14" rx="2" />],
    ['k*', <rect x="12" y="12" width="7" height="5" rx="1" />],
  ],
  rewind: [
    ['o*', <path d="M11 6L5 12l6 6" />],
    ['o', <path d="M19 6l-6 6 6 6" />],
  ],
  forward: [
    ['o*', <path d="M13 6l6 6-6 6" />],
    ['o', <path d="M5 6l6 6-6 6" />],
  ],
  mic: [
    ['b*', <rect x="9" y="3" width="6" height="11" rx="3" />],
    ['o', <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />],
  ],
  // The knowledge center (an open book).
  book: [
    ['b', <path d="M12 6.5C10.5 5.2 8.3 4.5 4 4.5v13c4.3 0 6.5.7 8 2 1.5-1.3 3.7-2 8-2v-13c-4.3 0-6.5.7-8 2z" />],
    ['k*', <path d="M12 6.5v13" />],
  ],
  // External flows: two steps and the path between them.
  flow: [
    ['b', <circle cx="6" cy="6" r="2.5" />],
    ['b*', <circle cx="18" cy="18" r="2.5" />],
    ['o', <path d="M8.5 6H14a3 3 0 0 1 0 6h-4a3 3 0 0 0 0 6h5.5" />],
  ],
  agent: [
    ['b', <rect x="5" y="8" width="14" height="11" rx="3" />],
    ['o*', <path d="M12 4v4" />],
    ['k', <path d="M9.5 13h.01M14.5 13h.01M9 16.5h6" />],
  ],
  doc: [
    ['b', <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />],
    ['k', <path d="M14 3v5h5" />],
    ['k*', <path d="M9 13h6M9 17h4" />],
  ],
  star: [['b*', <path d="M12 3.5l2.6 5.5 6 .7-4.5 4.1 1.2 5.9L12 16.8l-5.3 2.9 1.2-5.9-4.5-4.1 6-.7z" />]],
  /** A board template: three tiles and a fourth to come. */
  boardTemplate: [
    ['b', <rect x="3" y="3" width="7" height="7" rx="1.5" />],
    ['b', <rect x="14" y="3" width="7" height="7" rx="1.5" />],
    ['b', <rect x="3" y="14" width="7" height="7" rx="1.5" />],
    ['o*', <path d="M17.5 14v7M14 17.5h7" />],
  ],
} satisfies Record<string, readonly IconPart[]>;

export type IconName = keyof typeof PATHS;
export const ICON_NAMES = Object.keys(PATHS) as IconName[];
export const iconParts = (name: IconName): readonly IconPart[] => PATHS[name];

/** A name typed by a person (e.g. a help category's icon) that is one of the app's icons. */
export const isIconName = (name: string | null | undefined): name is IconName =>
  !!name && Object.prototype.hasOwnProperty.call(PATHS, name);

/**
 * How each icon style draws the parts — data only: a new style is one more row here (and its id in
 * `ICON_STYLES`). `base` = the main shapes: outline only, tinted, or filled with the details cut out.
 */
type StyleDef = {
  /** Stroke width from the width the caller asked for (1.8 by default). */
  stroke: (w: number) => number;
  cap: 'round' | 'square';
  join: 'round' | 'miter';
  /** A rect's corner radius from its own (and half its short side, the most it may take). */
  corner?: (rx: number, half: number) => number;
  base: 'outline' | 'tint' | 'filled';
  /** The accent part in the brand amber. */
  amberAccent?: boolean;
};
const ROUND = { cap: 'round', join: 'round' } as const;
export const ICON_STYLE_DEFS: Record<IconStyle, StyleDef> = {
  duo: { ...ROUND, stroke: (w) => w, base: 'tint' },
  line: { ...ROUND, stroke: (w) => w, base: 'outline' },
  solid: { ...ROUND, stroke: (w) => w, base: 'filled' },
  sharp: { cap: 'square', join: 'miter', stroke: (w) => w + 0.2, corner: () => 0, base: 'outline' },
  bold: {
    ...ROUND,
    stroke: (w) => Math.round(w * 1.35 * 10) / 10,
    corner: (rx, half) => Math.min(rx + 1.2, half),
    base: 'outline',
  },
  accent: { ...ROUND, stroke: (w) => w, base: 'outline', amberAccent: true },
};

let maskSeq = 0;

const TINT: CSSProperties = { fill: 'currentColor', fillOpacity: 'var(--icon-tint)' };
const TINT_STRONG: CSSProperties = { fill: 'currentColor', fillOpacity: 'var(--icon-tint-strong)' };
const AMBER: CSSProperties = { stroke: 'var(--icon-accent)' };

/**
 * Draws icon parts in the user's icon style (or `iconStyle`, for a preview of another one). `Icon` (by name) and the
 * column-type glyphs use it.
 */
export const Glyph = ({
  parts,
  size = 16,
  strokeWidth = 1.8,
  className,
  testId,
  iconStyle,
}: {
  parts: readonly IconPart[];
  size?: number;
  strokeWidth?: number;
  className?: string;
  testId?: string;
  iconStyle?: IconStyle;
}) => {
  const current = useIconStyle();
  const style = iconStyle ?? current;
  const def = ICON_STYLE_DEFS[style];
  // Unique on the page (useId repeats across React roots, and one mask id would serve every solid icon).
  const [maskId] = useState(() => `bines-icon-mask-${++maskSeq}`);
  const sw = def.stroke(strokeWidth);
  const shaped = parts.map(([role, el], i) => {
    const e = el as ReactElement<Record<string, unknown>>;
    const accent = role.endsWith('*');
    const extra: Record<string, unknown> = { key: i };
    if (def.corner && e.type === 'rect' && e.props.rx !== undefined)
      extra.rx = def.corner(Number(e.props.rx), Math.min(Number(e.props.width), Number(e.props.height)) / 2);
    if (def.base === 'tint' && role[0] === 'b') extra.style = accent ? TINT_STRONG : TINT;
    if (def.amberAccent && accent) extra.style = AMBER;
    return [role, cloneElement(e, extra)] as const;
  });
  let body;
  if (def.base === 'filled' && shaped.some(([role]) => role[0] === 'b')) {
    // Main shapes filled, the details on them cut out (a mask, so they show the background whatever it is).
    const base = shaped.filter(([role]) => role[0] === 'b').map(([, el]) => el);
    body = (
      <>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="-2" y="-2" width="28" height="28">
          <g fill="#fff" stroke="#fff">
            {base}
          </g>
          <g stroke="#000" strokeWidth={sw + 0.3}>
            {shaped.filter(([role]) => role[0] === 'k').map(([, el]) => el)}
          </g>
        </mask>
        <g fill="currentColor" mask={`url(#${maskId})`}>
          {base}
        </g>
        {shaped.filter(([role]) => role[0] === 'o').map(([, el]) => el)}
      </>
    );
  } else body = shaped.map(([, el]) => el);
  return (
    <svg
      // Round 13: in rem, so icons follow the user's text size like the text next to them.
      style={{ width: `${size / 16}rem`, height: `${size / 16}rem` }}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap={def.cap}
      strokeLinejoin={def.join}
      aria-hidden
      data-icon-style={style}
      data-testid={testId}
      className={className ?? 'shrink-0'}
    >
      {body}
    </svg>
  );
};

export const Icon = ({
  name,
  size = 16,
  strokeWidth = 1.8,
  className,
  iconStyle,
}: {
  name: IconName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  iconStyle?: IconStyle;
}) => <Glyph parts={PATHS[name]} size={size} strokeWidth={strokeWidth} className={className} iconStyle={iconStyle} />;
