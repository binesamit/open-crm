// SPDX-License-Identifier: AGPL-3.0-only
import type { JSONContent } from '@tiptap/react';

/**
 * Unsent update / reply drafts (owner fix: closing the card mid-sentence is safe). The composer's TipTap JSON is
 * kept in this browser per item (updates) or per update (replies) for 12 hours, then dropped. Posting, or "ניקוי",
 * removes it. Storage can be blocked (private mode): then drafts just don't survive — nothing else changes.
 */
export const DRAFT_TTL_MS = 12 * 60 * 60 * 1000;
const PREFIX = 'bos:draft:';

type Stored = { doc: JSONContent; at: number };

export const draftKey = (accountId: string, scope: 'item' | 'reply', id: string) =>
  `${PREFIX}${accountId}:${scope}:${id}`;

const parse = (raw: string | null): Stored | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<Stored>;
    return v && typeof v.at === 'number' && v.doc && typeof v.doc === 'object' ? (v as Stored) : null;
  } catch {
    return null;
  }
};

/** Drops every expired (or unreadable) draft in this browser. */
const sweep = (now: number) => {
  const stale: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (!k?.startsWith(PREFIX)) continue;
    const v = parse(localStorage.getItem(k));
    if (!v || now - v.at > DRAFT_TTL_MS) stale.push(k);
  }
  for (const k of stale) localStorage.removeItem(k);
};

/** The draft saved under `key`, unless it expired (expired drafts are removed on the way). */
export const readDraft = (key: string, now = Date.now()): JSONContent | null => {
  try {
    sweep(now);
    return parse(localStorage.getItem(key))?.doc ?? null;
  } catch {
    return null;
  }
};

/** Saves the draft (each change restarts its 12 hours); an empty editor removes it. */
export const writeDraft = (key: string, doc: JSONContent | null, now = Date.now()) => {
  try {
    if (!doc) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ doc, at: now } satisfies Stored));
  } catch {
    // storage blocked or full: the draft just isn't kept
  }
};

export const clearDraft = (key: string) => writeDraft(key, null);
