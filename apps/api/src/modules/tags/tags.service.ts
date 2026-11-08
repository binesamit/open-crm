// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, newId, TAG_NAME_MAX, tagColorFor, type GroupColor } from '@bines/shared';
import type { Db } from '../../db/client';
import { tags } from '../../db/schema';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { listTagRows, type TagRow, tagsByIds, tagsByNames } from './tags.repo';

/**
 * Tags (03 §3.1) are account-wide: anyone who may edit a tags cell may create one by typing it. Guests don't get
 * the list (it would show tags of boards they can't see); their cells still carry the names in the cell text.
 */
const tagDto = (t: TagRow) => ({ id: t.id, name: t.name, color: t.color });

export const listTags = async (db: Db, a: Actor) =>
  a.ctx.role === 'guest' ? [] : (await listTagRows(db, a.ctx.accountId)).map(tagDto);

/** Finds tags by name (case-insensitive) and creates the missing ones, in the given order. */
export const ensureTags = async (tx: Db, a: Actor, names: string[], color?: GroupColor) => {
  const wanted = [...new Map(names.map((n) => [n.trim().toLowerCase(), n.trim()])).values()].filter(Boolean);
  if (wanted.some((n) => n.length > TAG_NAME_MAX)) throw new AppError('invalid_value', 'Tag name too long');
  const found = await tagsByNames(tx, a.ctx.accountId, wanted);
  const have = new Set(found.map((t) => t.name.toLowerCase()));
  const missing = wanted.filter((n) => !have.has(n.toLowerCase()));
  if (missing.length) {
    const rows = missing.map((name) => ({
      id: newId(),
      accountId: a.ctx.accountId,
      name,
      color: color ?? tagColorFor(name),
      createdBy: a.user.id,
    }));
    // A concurrent create of the same name wins; we read it back below.
    await tx.insert(tags).values(rows).onConflictDoNothing();
    for (const r of rows) {
      await recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'tag.created',
        actorId: a.user.id,
        requestId: a.requestId,
        after: { id: r.id, name: r.name, color: r.color },
      });
    }
  }
  const all = await tagsByNames(tx, a.ctx.accountId, wanted);
  const byName = new Map(all.map((t) => [t.name.toLowerCase(), t]));
  return wanted.map((n) => byName.get(n.toLowerCase())!).filter(Boolean);
};

export const createTag = async (db: Db, a: Actor, input: { name: string; color?: GroupColor }) => {
  if (a.ctx.role === 'guest' || a.ctx.role === 'viewer') throw new AppError('forbidden', 'cannot_create_tags');
  const [tag] = await db.transaction((tx) => ensureTags(tx, a, [input.name], input.color));
  return tagDto(tag!);
};

/**
 * A tags cell write (03 §3.1): `{tag_ids}` (account tags) and/or `{tags: [names]}` (found or created) →
 * `{tag_ids}` + a name lookup for the cell text. Unknown ids are `invalid_value`.
 */
export const resolveTagsValue = async (tx: Db, a: Actor, raw: unknown) => {
  const r = (raw ?? {}) as { tag_ids?: unknown; tags?: unknown };
  const ids = Array.isArray(r.tag_ids) ? r.tag_ids.map(String) : [];
  const names = Array.isArray(r.tags) ? r.tags.map((n) => String(n).replace(/^#+/, '').trim()).filter(Boolean) : [];
  if (!Array.isArray(r.tag_ids) && !Array.isArray(r.tags)) return { value: raw, names: new Map<string, string>() };
  const known = await tagsByIds(tx, a.ctx.accountId, [...new Set(ids)]);
  if (known.length !== new Set(ids).size) throw new AppError('invalid_value', 'Unknown tag');
  const created = names.length ? await ensureTags(tx, a, names) : [];
  const all = [...known, ...created];
  const order = [...new Set([...ids, ...created.map((t) => t.id)])];
  return {
    value: { tag_ids: order },
    names: new Map(all.map((t) => [t.id, t.name])),
  };
};
