// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes } from './index';
import { dateOrderOf, parseDateText, parseNumberText, type DateOrder } from './date-text';
import type { Region } from '../locale/format';
import type { TextPerson } from './text-ctx';

export { dateOrderOf, parseDateText, parseNumberText, type DateOrder };
export type { TextCtx, TextPerson } from './text-ctx';

/**
 * `region`: the account's region — a date typed with a time ("10/10/2026 14:00") is wall-clock time in its zone and
 * is stored as the UTC instant (03 §2.7). Without it the time is taken as UTC (audit 2026-10-10 A1: a pasted 14:00
 * showed 17:00 in Israel, and an export–import round trip moved every date-time by the offset).
 */
export type TextOptions = { region?: Region };

/**
 * Text → cell value (07 §10 paste, 14 §3): what a pasted cell — from Excel, or from a column of another type —
 * becomes in a column. `null` clears the cell; `undefined` = cannot be read as this type (the cell is skipped).
 * Each type parses its own text in its registry def (`fromText`, 03 §1 — rule 4, no switch here); a type without
 * one (computed, files, time, relations, buttons) is not pasted as text. Labels match by name (status: one label;
 * dropdown: a comma list); people by name or email, teams by name.
 */
export const cellFromText = (
  type: string,
  text: string,
  settings: unknown,
  people: TextPerson[] = [],
  opts: TextOptions = {},
): unknown | null | undefined => {
  if (!text.trim()) return null;
  const def = columnTypes.get(type);
  if (!def?.fromText) return undefined;
  return def.fromText(text, settings, { people, region: opts.region });
};

/**
 * A cell's value moved to a column of another board (07 §3.4, 04 §6.2): the same value for the same type (but
 * labels by their text — label ids are per board); date ↔ timeline and text ↔ long text directly; anything else
 * through the source's text. `undefined` = cannot be converted (the value is dropped, undo brings it back).
 */
export const convertCellValue = (
  source: { type: string; value: unknown; text: string },
  target: { type: string; settings: unknown },
  people: TextPerson[] = [],
): unknown | undefined => {
  const labels = source.type === 'status' || source.type === 'dropdown';
  if (source.type === target.type && !labels) return source.value;
  const v = source.value as Record<string, unknown> | null;
  if (source.type === 'date' && target.type === 'timeline' && v?.date) return { from: v.date, to: v.date };
  if (source.type === 'timeline' && target.type === 'date' && v?.to) return { date: v.to };
  if (source.type === 'long_text' && target.type === 'text') return String(v?.text ?? '').slice(0, 2000) || undefined;
  if (source.type === 'text' && target.type === 'long_text') return { text: String(source.value ?? '') };
  const out = cellFromText(target.type, source.text, target.settings, people);
  return out === null ? undefined : out;
};
