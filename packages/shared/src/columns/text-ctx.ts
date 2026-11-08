// SPDX-License-Identifier: AGPL-3.0-only
import type { Region } from '../locale/format';

/**
 * What a column type's `fromText` (03 §1) may need beside the text and the settings: the account's people and
 * teams (people cells match by name or email) and its region (a date typed with a time is wall-clock in its zone).
 * Shared by the defs and `cellFromText`, so neither imports the other.
 */
export type TextPerson = { id: string; kind: 'person' | 'team'; name: string; email?: string };

export type TextCtx = { people: TextPerson[]; region?: Region };

export const normText = (s: string) => s.trim().toLocaleLowerCase();

/** The parts of a list typed as text: commas, semicolons or new lines between them. */
export const textParts = (s: string) =>
  s
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

type Label = { id: number; label: string; is_deactivated?: boolean };

/** The active labels of a status / dropdown column's settings. */
export const activeLabelsOf = (settings: unknown): Label[] =>
  ((settings as { labels?: Label[] } | null)?.labels ?? []).filter((l) => !l.is_deactivated);
