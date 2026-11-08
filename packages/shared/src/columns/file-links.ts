// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/** at most this many links in one files cell (like its files). */
export const FILE_CELL_LINKS_MAX = 100;
export const FILE_LINK_URL_MAX = 2000;
export const FILE_LINK_NAME_MAX = 255;

/** A web link kept in a files cell: the cell value holds them, no storage. */
export const cellLinkSchema = z.object({
  id: z.string(),
  url: z.string(),
  /** Empty = show the address. */
  name: z.string(),
  added_by: z.string(),
  added_at: z.string(),
});
export type CellLink = z.infer<typeof cellLinkSchema>;

/**
 * A link as typed: `example.com/x` gains `https://`; only http(s) addresses are kept (never `javascript:` / `data:`),
 * with a host. Undefined when it is not one.
 */
export const normalizeFileLink = (raw: string): string | undefined => {
  const s = raw.trim();
  if (!s || s.length > FILE_LINK_URL_MAX) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    if (!u.hostname || !u.hostname.includes('.')) return u.hostname === 'localhost' ? u.toString() : undefined;
    return u.toString();
  } catch {
    return undefined;
  }
};

/** What a link shows: its name, else the address without the scheme and a trailing slash. */
export const fileLinkLabel = (l: Pick<CellLink, 'url' | 'name'>) =>
  l.name.trim() || l.url.replace(/^https?:\/\//i, '').replace(/\/$/, '');

/** A link in the cell's text (search, export, formulas): its name and its address. */
export const fileLinkText = (l: Pick<CellLink, 'url' | 'name'>) =>
  l.name.trim() ? `${l.name.trim()} ${l.url}` : l.url;

/** The body of POST / PATCH on a cell's links. */
export const addCellLinkSchema = z.object({
  url: z.string().trim().min(1).max(FILE_LINK_URL_MAX),
  name: z.string().trim().max(FILE_LINK_NAME_MAX).optional(),
});
export const updateCellLinkSchema = addCellLinkSchema.partial();
