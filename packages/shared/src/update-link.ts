// SPDX-License-Identifier: AGPL-3.0-only
/**
 * s37reply: a link to one update or reply opens the item card on that update's thread only
 * the update with all its replies; a reply link also scrolls to that reply and marks it. One shape for every
 * entry point (bell, inbox, search, copied link, email, push): `?tab=updates&update=<id>` on the item's route.
 */

/** The item route's search param that holds the focused update / reply id. */
export const UPDATE_LINK_PARAM = 'update';

/** A well-formed update id in a URL (ULIDs; imported ids are kept verbatim, so be lenient but bounded). */
export const isUpdateLinkId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v);

/** The item route's search for a link to an update or reply (no id = the updates tab). */
export const updateLinkSearch = (updateId?: string | null): { tab: 'updates'; update?: string } =>
  updateId && isUpdateLinkId(updateId) ? { tab: 'updates', update: updateId } : { tab: 'updates' };

/** The same as a query string (`?tab=updates&update=…`), for links built outside the router (email, push). */
export const updateLinkQuery = (updateId?: string | null) => {
  const s = updateLinkSearch(updateId);
  return `?tab=${s.tab}${s.update ? `&${UPDATE_LINK_PARAM}=${encodeURIComponent(s.update)}` : ''}`;
};

/**
 * The thread that holds `id`: the top update itself, or the update one of whose replies (at any depth) it is.
 * `reply` is the reply's id when the link points at a reply (it gets the anchor), else null. Null when not found
 * (deleted, or not on this item).
 */
export const findUpdateThread = <T extends { id: string; replies: readonly { id: string }[] }>(
  updates: readonly T[],
  id: string,
): { thread: T; reply: string | null } | null => {
  for (const u of updates) {
    if (u.id === id) return { thread: u, reply: null };
    if (u.replies.some((r) => r.id === id)) return { thread: u, reply: id };
  }
  return null;
};

/**
 * s37reply2: the item route's search with the card switched to one update's thread (clicking an update's time)
 * — the rest of the URL (`view`, `q`, …) stays. An id that is not a valid link id leaves it as is.
 */
export const withUpdateLink = <S extends Record<string, unknown>>(
  prev: S,
  updateId: string,
): Record<string, unknown> =>
  isUpdateLinkId(updateId) ? { ...prev, tab: 'updates', [UPDATE_LINK_PARAM]: updateId } : prev;

/** The item route's search without the update link ("all updates"); the rest of the URL stays. */
export const withoutUpdateLink = <S extends Record<string, unknown>>(prev: S): Record<string, unknown> => {
  const next: Record<string, unknown> = { ...prev };
  delete next[UPDATE_LINK_PARAM];
  return next;
};
