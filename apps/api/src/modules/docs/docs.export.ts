// SPDX-License-Identifier: AGPL-3.0-only
import {
  docAssetIds,
  docExportDirection,
  docExportDocument,
  docToHtml,
  docToMarkdown,
  type DocExportFormat,
  type DocExportLinks,
  type RichNode,
} from '@bines/shared';
import type { AppDeps, Actor } from '../../types';
import { assetsByIds } from '../files/files.repo';
import { isInlineSafeMime } from '../../lib/storage';
import { loadDocAccess } from './docs.access';
import { loadDocContent } from './docs.repo';
import { liveDocState } from './docs.versions';
import { decodeState, deriveDoc } from './ydoc';
import { webOrigin } from '../platform/public-address';

/**
 * GET /docs/:id/export?format=html|md|pdf (M8 ד3). Whoever reads the doc exports it as it was last saved, through
 * the shared allowlist renderer (docs/export.ts — no HTML from the browser ever passes). Images and files get
 * links valid for an hour; items, boards and docs link into the app. `pdf` is the same page made for printing —
 * the browser prints it to PDF (Hebrew shaping and fonts are the browser's, D25).
 */
const ASSET_LINK_TTL = 60 * 60;

export const exportDoc = async (
  deps: Pick<AppDeps, 'db' | 'storage' | 'env'>,
  a: Actor,
  docId: string,
  format: DocExportFormat,
) => {
  const access = await loadDocAccess(deps.db, a.ctx, a.user, docId);
  // As it is now: from the live server when the doc is open (saves are debounced), else as last saved.
  const live = liveDocState(a.ctx.accountId, docId);
  const content = live
    ? deriveDoc(decodeState(live)).content
    : (((await loadDocContent(deps.db, a.ctx.accountId, docId))?.content as RichNode | null) ?? null);

  // Links for the files the doc shows (only this account's, only uploaded ones).
  const assets = await assetsByIds(deps.db, a.ctx.accountId, docAssetIds(content));
  const urls = new Map<string, string>();
  for (const asset of assets) {
    if (asset.uploadStatus !== 'uploaded' || !asset.storageKey) continue;
    urls.set(
      asset.id,
      await deps.storage.presignGet(asset.storageKey, asset.fileName, {
        inline: isInlineSafeMime(asset.mime), // S-34: never an SVG inline (S-07)
        ttl: ASSET_LINK_TTL,
      }),
    );
  }
  const base = `${await webOrigin(deps)}/a/${a.ctx.account.slug}`;
  const links: DocExportLinks = {
    assetUrl: (id) => urls.get(id) ?? null,
    entityUrl: (kind, id, boardId) =>
      kind === 'doc'
        ? `${base}/d/${id}`
        : kind === 'board'
          ? `${base}/b/${id}`
          : boardId
            ? `${base}/b/${boardId}/i/${id}`
            : null,
  };

  const title = access.doc.name;
  const safeName = title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'doc';
  if (format === 'md')
    return {
      body: docToMarkdown(content, links, title),
      type: 'text/markdown; charset=utf-8',
      name: `${safeName}.md`,
      inline: false,
    };
  // Direction / language: the doc's own text, else the reader's language (never a fixed one).
  const { dir, lang } = docExportDirection(content, title, a.user.locale === 'en' ? 'en' : 'he');
  const page = docExportDocument({ title, bodyHtml: docToHtml(content, links), dir, lang });
  return { body: page, type: 'text/html; charset=utf-8', name: `${safeName}.html`, inline: format === 'pdf' };
};
