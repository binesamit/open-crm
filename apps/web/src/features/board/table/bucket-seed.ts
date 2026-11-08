// SPDX-License-Identifier: AGPL-3.0-only
import { EMPTY_BUCKET, type Field, type GroupDateUnit, type QueryEnv } from '@bines/shared';
import type { Column, Item, Member } from '../board-api';
import { dateGroupDay } from '../date-group';
import type { Section } from './BoardTable';

/** Engines whose cell has its own endpoint (votes, docs, secrets, time, files): never written on create. */
const OWN_WRITER = new Set(['vote', 'doc', 'secret', 'time', 'files']);

/**
 * "+ item" in a section of a grouping by column (15 §4; — the new item gets the section's value): the new
 * item's group (the board's first) and the cell value that lands it in this bucket. The drag between sections
 * (`bucket.ts`) and "add item below" use the same seed. Undefined where the bucket cannot be written (computed,
 * read-only, own-endpoint columns, system fields but the board's group). The empty section, and a column I may
 * not edit (restricted), create the item without a value.
 *
 * `rows`: the section's loaded items — values that have no key of their own (relations, links, emails, countries,
 * long text…) copy the cell of an item already there, so the new one shows in the same section. `title`: the
 * section's label (a text bucket's key is lowercased; the label keeps the casing).
 */
export const bucketSeed = (
  field: Field,
  key: string,
  opts: {
    groupId: string | undefined;
    members: Member[];
    env: QueryEnv;
    /** The board's columns (the viewer's `restricted_edit` / `read_only`). */
    columns?: Column[];
    rows?: Item[];
    title?: string;
    /** How the view groups dates (its `group_by`); absent = "when". */
    dates?: { unit?: GroupDateUnit; pastDetail?: boolean };
  },
): Section['seed'] => {
  const groupId = opts.groupId;
  if (!groupId) return undefined;
  if (field.source === 'system') return field.id === '__group__' ? { groupId: key, cells: {} } : undefined;
  if (field.def.storage !== 'cell' || field.def.readOnly) return undefined;
  if (field.def.engine && OWN_WRITER.has(field.def.engine)) return undefined;
  const none = { groupId, cells: {} };
  if (key === EMPTY_BUCKET) return none;
  const col = opts.columns?.find((c) => c.id === field.id);
  if (col?.read_only) return undefined;
  // The server refuses a restricted cell (forbidden): the item is still created, without the value.
  if (col?.restricted_edit) return none;
  const at = (value: unknown) => ({ groupId, cells: { [field.id]: value } });
  // ק2: a combination's section ("combo:<id>|<id>") — every value of it.
  const ids = key.startsWith('combo:') ? key.slice('combo:'.length).split('|') : [key];
  const person = (id: string) => ({
    id,
    kind: opts.members.some((mb) => mb.user_id === id) ? 'person' : 'team',
  });
  switch (field.column.type) {
    case 'status':
      return at({ index: Number(key) });
    case 'dropdown':
      return at({ ids: ids.map(Number) });
    case 'tags':
      return at({ tag_ids: ids });
    case 'people':
      return at({ persons_and_teams: ids.map(person) });
    case 'checkbox':
      return at({ checked: true });
    case 'numbers':
      return at(Number(key));
    case 'rating':
      return at({ rating: Number(key) });
    case 'date':
    case 'timeline': {
      // A day inside the bucket: in "when" (this week, next month…), or the period's first day.
      const day = dateGroupDay(key, opts.env, opts.dates);
      if (!day) return undefined;
      return at(field.column.type === 'date' ? { date: day } : { from: day, to: day });
    }
    default: {
      // A value without a key of its own: the cell of an item already in the section (same text = same bucket).
      const sample = opts.rows?.find((r) => r.cells?.[field.id]?.value != null);
      if (sample) return at(sample.cells[field.id]!.value);
      if (field.column.type === 'text') return at(opts.title ?? key);
      return undefined;
    }
  }
};
