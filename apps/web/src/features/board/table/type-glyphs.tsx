// SPDX-License-Identifier: AGPL-3.0-only
import { Glyph, type IconPart } from '../../../lib/icons';

/**
 * Column type glyphs for the add-column menu (F4) — 24-unit strokes in parts (lib/icons: `b` main shape, `k` a detail
 * on it, `o` a line outside it, `*` the accent part), so they follow the user's icon style.
 */
export const TYPE_GLYPH: Record<string, readonly IconPart[]> = {
  text: [
    ['b', <path d="M4 20h4L19 9l-4-4L4 16z" />],
    ['k*', <path d="M13 7l4 4" />],
  ],
  long_text: [
    ['b', <rect x="4" y="3" width="16" height="18" rx="2" />],
    ['k', <path d="M8 8h8M8 12h8" />],
    ['k*', <path d="M8 16h5" />],
  ],
  numbers: [
    ['o', <path d="M7 4v16M4 17l3 3 3-3" />],
    ['o*', <path d="M17 20V4M14 7l3-3 3 3" />],
  ],
  status: [
    ['b', <circle cx="12" cy="12" r="9" />],
    ['k*', <path d="M8 12l3 3 5-6" />],
  ],
  date: [
    ['b', <rect x="3" y="5" width="18" height="16" rx="2" />],
    ['k', <path d="M3 10h18" />],
    ['o', <path d="M8 3v4M16 3v4" />],
    ['k*', <circle cx="15.5" cy="15.5" r=".9" />],
  ],
  timeline: [
    ['o', <path d="M3 12h18" />],
    ['b*', <rect x="6" y="8" width="10" height="8" rx="2" />],
  ],
  people: [
    ['b', <circle cx="9" cy="8" r="3.5" />],
    ['b', <path d="M2.5 20a6.5 6.5 0 0 1 13 0z" />],
    ['o*', <path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-3.5-6" />],
  ],
  dropdown: [
    ['b', <rect x="3" y="5" width="18" height="14" rx="3" />],
    ['k*', <path d="M8.5 10.5l3.5 3.5 3.5-3.5" />],
  ],
  tags: [
    ['b', <path d="M3 12V4h8l10 10-8 8z" />],
    ['k*', <circle cx="7.5" cy="8.5" r="1.5" />],
  ],
  file: [['o', <path d="M20 11l-8.5 8.5a5 5 0 0 1-7-7L13 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L14 7" />]],
  email: [
    ['b', <rect x="3" y="5" width="18" height="14" rx="2" />],
    ['k*', <path d="M3 7l9 6 9-6" />],
  ],
  phone: [
    ['b*', <path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />],
  ],
  link: [
    ['o', <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />],
    ['o*', <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />],
  ],
  checkbox: [
    ['b', <rect x="4" y="4" width="16" height="16" rx="3" />],
    ['k*', <path d="M8 12l3 3 5-6" />],
  ],
  rating: [['b*', <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" />]],
  vote: [['b*', <path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" />]],
  board_relation: [
    ['b', <rect x="3" y="4" width="18" height="16" rx="2" />],
    ['k', <path d="M3 9.5h18" />],
    ['k*', <path d="M9 9.5V20" />],
  ],
  mirror: [
    ['b', <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" />],
    ['k*', <circle cx="12" cy="12" r="3" />],
  ],
  formula: [['b*', <path d="M13 3 5 14h6l-1 7 8-11h-6z" />]],
  time_tracking: [
    ['b', <circle cx="12" cy="13" r="8" />],
    ['k*', <path d="M12 9v4l2.5 1.5" />],
    ['o', <path d="M10 2h4" />],
  ],
  creation_log: [
    ['b', <circle cx="12" cy="8" r="4" />],
    ['b*', <path d="M4 21a8 8 0 0 1 16 0z" />],
  ],
  last_updated: [
    ['b', <circle cx="12" cy="12" r="9" />],
    ['k*', <path d="M12 7v5l3 2" />],
  ],
  item_id: [
    ['o', <path d="M9 4L7 20M17 4l-2 16" />],
    ['o*', <path d="M4 9h16M3 15h16" />],
  ],
  progress: [
    ['b', <rect x="3" y="9" width="18" height="6" rx="3" />],
    ['k*', <path d="M6 12h7" />],
  ],
  button: [
    ['b', <rect x="3" y="7" width="18" height="10" rx="3" />],
    ['k*', <path d="M9 12h6" />],
  ],
  ai: [
    ['b', <path d="M11 3.5l1.8 5.2L18 10.5l-5.2 1.8L11 17.5l-1.8-5.2L4 10.5l5.2-1.8z" />],
    ['b*', <path d="M18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />],
  ],
  hour: [
    ['b', <circle cx="12" cy="12" r="9" />],
    ['k*', <path d="M12 7v5h4" />],
  ],
  week: [
    ['b', <rect x="3" y="5" width="18" height="16" rx="2" />],
    ['k', <path d="M3 10h18" />],
    ['o', <path d="M8 3v4M16 3v4" />],
    ['k*', <path d="M7 15h10" />],
  ],
  world_clock: [
    ['b', <circle cx="12" cy="12" r="9" />],
    ['k*', <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />],
  ],
  color_picker: [
    [
      'b',
      <path d="M12 3a9 9 0 0 0 0 18c1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5s.8-1.5 1.8-1.5H17a4 4 0 0 0 4-4c0-4.7-4-8.5-9-8.5z" />,
    ],
    ['k*', <path d="M7.5 11h.01M10 7h.01M15 7.5h.01" />],
  ],
  country: [
    ['o', <path d="M5 21V4" />],
    ['b*', <path d="M5 4h11l-2 4 2 4H5z" />],
  ],
  location: [
    ['b', <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z" />],
    ['k*', <circle cx="12" cy="9.5" r="2.5" />],
  ],
};
export const FALLBACK_GLYPH: readonly IconPart[] = [['b', <rect x="4" y="4" width="16" height="16" rx="3" />]];

/** A column type's glyph, in the user's icon style. */
export const TypeGlyph = ({ type, size = 14 }: { type: string; size?: number }) => (
  <Glyph parts={TYPE_GLYPH[type] ?? FALLBACK_GLYPH} size={size} />
);

/** A column type's glyph in a small tile (pickers that list columns: the add-column menu, the name source). */
export const ColumnTypeGlyph = ({ type, size = 14 }: { type: string; size?: number }) => (
  <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-surface-2 text-heading">
    <TypeGlyph type={type} size={size} />
  </span>
);
