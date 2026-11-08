// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { AppError, updateDocumentMetaOf, type PublicIdocQuestion, type RichNode } from '@bines/shared';
import type { AppDeps } from '../../types';
import { updates, users } from '../../db/schema';
import { createDocumentUpdate } from '../updates/updates.service';
import type { Actor } from '../items/items.service';
import type { IdocDocRow } from './idocs.repo';
import type { DocView } from './idocs.resolve';

/**
 * Questions on the public page are updates on the item (source `document`): the team answers in the app as usual.
 * The page shows only the threads a client started on THIS document, with every reply in them — never the item's
 * other updates (internal talk), never secret ones.
 */

type Deps = Pick<AppDeps, 'db'>;

const MAX_THREADS = 200;

type Row = {
  id: string;
  parentUpdateId: string | null;
  source: string;
  meta: unknown;
  bodyText: string;
  createdAt: Date;
  authorName: string | null;
};

const threadRows = async (deps: Deps, doc: Pick<IdocDocRow, 'itemId'>): Promise<Row[]> =>
  deps.db
    .select({
      id: updates.id,
      parentUpdateId: updates.parentUpdateId,
      source: updates.source,
      meta: updates.meta,
      bodyText: updates.bodyText,
      createdAt: updates.createdAt,
      authorName: users.name,
    })
    .from(updates)
    .leftJoin(users, eq(users.id, updates.createdBy))
    .where(and(eq(updates.itemId, doc.itemId), isNull(updates.deletedAt), eq(updates.isSecret, false)))
    .orderBy(asc(updates.createdAt))
    .limit(5000);

/** The roots of this document's threads, and every update under each (id → its root). */
const threadsOf = (rows: Row[], docId: string) => {
  const roots = rows.filter(
    (r) => !r.parentUpdateId && r.source === 'document' && updateDocumentMetaOf(r.meta)?.doc_id === docId,
  );
  const rootOf = new Map<string, string>(roots.map((r) => [r.id, r.id]));
  // Replies arrive after their parent (ordered by time), so one pass settles nested replies.
  for (const r of rows)
    if (r.parentUpdateId && rootOf.has(r.parentUpdateId)) rootOf.set(r.id, rootOf.get(r.parentUpdateId)!);
  return { roots: roots.slice(-MAX_THREADS), rootOf };
};

const sectionTitleOf = (view: Pick<DocView, 'publicSections'>, sectionId: string | null) => {
  const s = sectionId ? view.publicSections.find((x) => x.id === sectionId) : null;
  return s && 'title' in s && typeof s.title === 'string' ? s.title : '';
};

export const publicQuestions = async (
  deps: Deps,
  doc: Pick<IdocDocRow, 'id' | 'itemId'>,
  _view: Pick<DocView, 'publicSections'>,
): Promise<PublicIdocQuestion[]> => {
  const rows = await threadRows(deps, doc);
  const { roots, rootOf } = threadsOf(rows, doc.id);
  const who = (r: Row) => {
    const d = r.source === 'document' ? updateDocumentMetaOf(r.meta) : null;
    return d ? { from: 'client' as const, name: d.name } : { from: 'team' as const, name: r.authorName ?? '' };
  };
  return roots.map((root) => {
    const meta = updateDocumentMetaOf(root.meta)!;
    return {
      id: root.id,
      section_id: meta.section_id ?? null,
      section_title: meta.section_title,
      ...who(root),
      text: root.bodyText,
      at: root.createdAt.toISOString(),
      replies: rows
        .filter((r) => r.id !== root.id && rootOf.get(r.id) === root.id)
        .map((r) => ({ ...who(r), text: r.bodyText, at: r.createdAt.toISOString() })),
    };
  });
};

const plainDoc = (text: string): RichNode => ({
  type: 'doc',
  content: text
    .split(/\n{2,}/)
    .map((para) => para.trim())
    .filter(Boolean)
    .map((para) => ({
      type: 'paragraph',
      content: para
        .split('\n')
        .flatMap((line, i) => [...(i ? [{ type: 'hardBreak' }] : []), ...(line ? [{ type: 'text', text: line }] : [])]),
    })),
});

/** A client's question (or reply in one of this document's threads) → an update on the item. */
export const askQuestion = async (
  deps: Deps,
  a: Actor,
  doc: IdocDocRow,
  view: Pick<DocView, 'publicSections'>,
  input: { section_id: string | null; text: string; parent_id?: string },
  name: string,
) => {
  let parent: typeof updates.$inferSelect | null = null;
  if (input.parent_id) {
    const rows = await threadRows(deps, doc);
    const { rootOf } = threadsOf(rows, doc.id);
    if (!rootOf.has(input.parent_id)) throw new AppError('not_found', 'Question not found');
    parent =
      (
        await deps.db
          .select()
          .from(updates)
          .where(inArray(updates.id, [input.parent_id]))
          .limit(1)
      )[0] ?? null;
    if (!parent) throw new AppError('not_found', 'Question not found');
  }
  const sectionId =
    input.section_id && view.publicSections.some((s) => s.id === input.section_id) ? input.section_id : null;
  await createDocumentUpdate(
    deps.db,
    a,
    doc.itemId,
    { doc: plainDoc(input.text) },
    {
      doc_id: doc.id,
      doc_name: doc.name,
      section_title: sectionTitleOf(view, sectionId),
      name,
      ...(sectionId ? { section_id: sectionId } : {}),
    },
    parent,
  );
};
