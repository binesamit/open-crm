// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { AppError, type AssistantRef, type AssistantRefType, wrapUntrustedContent } from '@bines/shared';
import type { Db } from '../../db/client';
import { assertBoard, loadBoardAccess, readableBoardIds } from '../boards/boards.access';
import { loadDashboardAccess } from '../dashboards/dashboards.access';
import { assertDoc, loadDocAccess } from '../docs/docs.access';
import { type Actor, loadItem } from '../items/items.service';
import { boardNames } from './ai2.repo';

/**
 * "@" references in a chat message (product owner: "choose items or boards… to be specific, from anywhere")
 * the person points at an item, a board, a document or a dashboard they can open, wherever the panel is. Each is
 * checked when the message is sent (one they cannot open does not exist: 404, before the stream), and the stored
 * transcript keeps a mark per reference (type, id, the name it had, an item's board, a dashboard's boards). When
 * the conversation goes to the model, a mark becomes its exact ids — ours, outside the data — with the read tool to
 * use, and its name as untrusted data. The model reads it through its tools, within its own access (an agent only
 * its boards).
 */
export const REF_MARK = 'bines_ref';
export type RefMark = {
  type: typeof REF_MARK;
  ref_type: AssistantRefType;
  id: string;
  name: string;
  board_id: string | null;
  /** A dashboard: the boards it shows that the person can see. */
  boards?: { id: string; name: string }[];
};

export const isRefMark = (b: unknown): b is RefMark =>
  !!b && typeof b === 'object' && (b as { type?: unknown }).type === REF_MARK;

/** The marks of a stored user turn, as the chat shows them (the message's references). */
export const refsOfContent = (content: unknown[]): AssistantRef[] =>
  content.flatMap((turn) => {
    const blocks = (turn as { content?: unknown }).content;
    return Array.isArray(blocks)
      ? blocks.filter(isRefMark).map((m) => ({ type: m.ref_type, id: m.id, name: m.name, board_id: m.board_id }))
      : [];
  });

/** Checks each reference as the person (404 when they cannot open it) and makes its mark; repeats count once. */
export const resolveRefs = async (
  db: Db,
  a: Actor,
  refs: { type: AssistantRefType; id: string }[],
): Promise<RefMark[]> => {
  const seen = new Set<string>();
  const out: RefMark[] = [];
  for (const r of refs) {
    const key = `${r.type}:${r.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(await refMark(db, a, r));
  }
  return out;
};

const refMark = async (db: Db, a: Actor, r: { type: AssistantRefType; id: string }): Promise<RefMark> => {
  const mark = (name: string, board_id: string | null = null, boards?: RefMark['boards']): RefMark => ({
    type: REF_MARK,
    ref_type: r.type,
    id: r.id,
    name,
    board_id,
    ...(boards ? { boards } : {}),
  });
  switch (r.type) {
    case 'item': {
      const found = await loadItem(db, a, r.id);
      return mark(found.item.name, found.access.board.id);
    }
    case 'board': {
      const access = await loadBoardAccess(db, a.ctx, a.user, r.id);
      assertBoard(access, 'item.read');
      return mark(access.board.name);
    }
    case 'doc': {
      const access = await loadDocAccess(db, a.ctx, a.user, r.id);
      assertDoc(access, 'doc.read');
      return mark(access.doc.name);
    }
    case 'dashboard': {
      const access = await loadDashboardAccess(db, a.ctx, a.user, r.id);
      const ids = (access.dashboard.settings as { board_ids?: unknown }).board_ids;
      const readable = await readableBoardIds(db, a.ctx, a.user, Array.isArray(ids) ? (ids as string[]) : []);
      return mark(access.dashboard.name, null, await boardNames(db, a.ctx.accountId, [...readable]));
    }
    default:
      throw new AppError('invalid_value', 'unknown_reference');
  }
};

const READ_TOOL: Record<AssistantRefType, string> = {
  item: 'get_item',
  board: 'get_board',
  doc: 'get_doc',
  dashboard: 'get_board (for each of its boards)',
};

/** One mark → what the model gets: the ids and the tool to read it, then the name (and boards) as data. */
export const refBlocks = (m: RefMark): Anthropic.TextBlockParam[] => {
  const ids = [
    '<reference>',
    `The user pointed at this ${m.ref_type} with "@" — use it as the exact subject when the message refers to it.`,
    `${m.ref_type}_id: ${m.id}`,
    m.board_id ? `board_id: ${m.board_id}` : null,
    m.boards ? `dashboard_board_ids: ${m.boards.map((b) => b.id).join(', ') || '(none)'}` : null,
    `read it with: ${READ_TOOL[m.ref_type]}`,
    '</reference>',
  ].filter((x) => x !== null);
  const names = [`${m.ref_type}: ${m.name}`, ...(m.boards ?? []).map((b) => `dashboard board ${b.id}: ${b.name}`)];
  return [
    { type: 'text', text: ids.join('\n') },
    { type: 'text', text: wrapUntrustedContent('reference', names.join('\n')) },
  ];
};
