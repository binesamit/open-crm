// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { newId } from '@bines/shared';
import type { Db } from '../../db/client';
import { itemLinks, items } from '../../db/schema';
import { anyId } from './items.repo';

/**
 * Two-way relations (03 §2.16): the rows a reflection reads and writes. item_links stays the truth; the relation
 * cell (`{item_ids}` + names + count) is its cache.
 */

/** Items in any state (trashed too): a reflection still mirrors links to trashed items, like a one-way link. */
export const itemsAnyState = (db: Db, accountId: string, ids: string[]) =>
  ids.length
    ? db
        .select({ id: items.id, boardId: items.boardId, name: items.name, deletedAt: items.deletedAt })
        .from(items)
        .where(and(eq(items.accountId, accountId), anyId(items.id, ids)))
    : Promise.resolve([]);

/** Targets of one relation cell, in their order. */
export const linkTargets = async (db: Db, columnId: string, fromItemId: string) =>
  (
    await db
      .select({ to: itemLinks.toItemId })
      .from(itemLinks)
      .where(and(eq(itemLinks.columnId, columnId), eq(itemLinks.fromItemId, fromItemId)))
      .orderBy(asc(itemLinks.position))
  ).map((r) => r.to);

/** Outgoing links of these items in one column: from item id → its targets in order. */
export const linkTargetsOf = async (db: Db, columnId: string, fromItemIds: string[]) => {
  const out = new Map<string, { to: string; position: string }[]>();
  if (!fromItemIds.length) return out;
  const rows = await db
    .select({ from: itemLinks.fromItemId, to: itemLinks.toItemId, position: itemLinks.position })
    .from(itemLinks)
    .where(and(eq(itemLinks.columnId, columnId), anyId(itemLinks.fromItemId, fromItemIds)))
    .orderBy(asc(itemLinks.position));
  for (const r of rows) out.set(r.from, [...(out.get(r.from) ?? []), { to: r.to, position: r.position }]);
  return out;
};

/** Every outgoing link of one item, by column (a move rewrites them; a reflection compares before and after). */
export const outgoingLinksByColumn = async (db: Db, itemId: string) => {
  const out = new Map<string, string[]>();
  const rows = await db
    .select({ columnId: itemLinks.columnId, to: itemLinks.toItemId })
    .from(itemLinks)
    .where(eq(itemLinks.fromItemId, itemId))
    .orderBy(asc(itemLinks.position));
  for (const r of rows) out.set(r.columnId, [...(out.get(r.columnId) ?? []), r.to]);
  return out;
};

/** Every link of a column with the boards of both ends (enabling two-way pairs the existing links). */
export const columnLinks = (db: Db, columnId: string) =>
  db
    .select({ from: itemLinks.fromItemId, to: itemLinks.toItemId })
    .from(itemLinks)
    .where(eq(itemLinks.columnId, columnId))
    .orderBy(asc(itemLinks.position));

/** Every link of a dependency column with its meta (kind + lag) — the graph a date shift walks (M8 ד7). */
export const dependencyLinks = (db: Db, columnId: string) =>
  db
    .select({ from: itemLinks.fromItemId, to: itemLinks.toItemId, meta: itemLinks.meta })
    .from(itemLinks)
    .where(eq(itemLinks.columnId, columnId))
    .orderBy(asc(itemLinks.position));

/** The next position after `positions` (positions are zero-padded counters, '0000', '0001', …). */
export const nextLinkPosition = (positions: string[]) => {
  const max = positions.reduce((m, p) => Math.max(m, Number.parseInt(p, 10) || 0), -1);
  return String(max + 1).padStart(4, '0');
};

/** Appends links (`to` at the end of `from`'s list); an existing pair is left as it is. */
export const appendLinks = async (
  db: Db,
  accountId: string,
  columnId: string,
  pairs: { from: string; to: string }[],
  createdBy: string | null,
) => {
  if (!pairs.length) return;
  const existing = await linkTargetsOf(db, columnId, [...new Set(pairs.map((p) => p.from))]);
  const rows: (typeof itemLinks.$inferInsert)[] = [];
  for (const p of pairs) {
    const list = existing.get(p.from) ?? [];
    if (list.some((l) => l.to === p.to)) continue;
    const position = nextLinkPosition(list.map((l) => l.position));
    list.push({ to: p.to, position });
    existing.set(p.from, list);
    rows.push({ id: newId(), accountId, columnId, fromItemId: p.from, toItemId: p.to, position, createdBy });
  }
  for (let i = 0; i < rows.length; i += 1000)
    await db
      .insert(itemLinks)
      .values(rows.slice(i, i + 1000))
      .onConflictDoNothing();
};

export const removeLinks = async (db: Db, columnId: string, pairs: { from: string; to: string }[]) => {
  for (const p of pairs)
    await db
      .delete(itemLinks)
      .where(and(eq(itemLinks.columnId, columnId), eq(itemLinks.fromItemId, p.from), eq(itemLinks.toItemId, p.to)));
};

/**
 * r19relfilter: the distinct live items a relation column links to (from live items), with their boards — the
 * items whose "matches the filter" mark a board shows. At most `cap` + 1 rows (the caller reports truncation).
 * Reads the (column_id, from, to) index.
 */
export const linkedTargetsOfColumn = async (db: Db, columnId: string, cap: number) => {
  const target = alias(items, 't');
  const from = alias(items, 'f');
  return db
    .selectDistinct({ id: itemLinks.toItemId, boardId: target.boardId })
    .from(itemLinks)
    .innerJoin(target, and(eq(target.id, itemLinks.toItemId), isNull(target.deletedAt)))
    .innerJoin(from, and(eq(from.id, itemLinks.fromItemId), isNull(from.deletedAt)))
    .where(eq(itemLinks.columnId, columnId))
    .limit(cap + 1);
};

/** P1-03: the items that link TO this one through a column (the other side of a one-way relation). */
export const linkSources = async (db: Db, columnId: string, toItemId: string) =>
  (
    await db
      .select({ from: itemLinks.fromItemId })
      .from(itemLinks)
      .where(and(eq(itemLinks.columnId, columnId), eq(itemLinks.toItemId, toItemId)))
  ).map((r) => r.from);
