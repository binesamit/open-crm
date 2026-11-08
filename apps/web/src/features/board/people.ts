// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo } from 'react';
import type { AgentDirectory } from '@bines/shared';
import { useAgentDirectory } from '../agents/agents-api';
import { type Member, useMembers } from './board-api';

/**
 * The agents of the directory as members. People pickers (`mentions` off): the agents that act on this board
 * (`boardId`, the board's top board), as before. The @mention list (`mentions` on): also the agents one
 * could mention that do not act here, each with its reason (`agent.unavailable`, an
 * `agents.mention.unavailable.<reason>` key) — never assignable, never selectable in the list.
 */
export const directoryMembers = (
  directory: AgentDirectory | undefined,
  boardId: string | null | undefined,
  mentions = false,
): Member[] => {
  const member = (
    a: { id: string; user_id: string; name: string; avatar: string | null },
    agent: Omit<NonNullable<Member['agent']>, 'id' | 'avatar'>,
  ): Member => ({
    user_id: a.user_id,
    name: a.name,
    email: '',
    role: 'agent',
    status: 'active',
    avatar_url: null,
    agent: { id: a.id, avatar: a.avatar, ...agent },
  });
  const out: Member[] = [];
  for (const a of directory?.data ?? []) {
    const here = !boardId || a.board_ids.includes(boardId);
    if (here)
      out.push(
        member(a, {
          mention: a.mention,
          assign: a.assign,
          ...(mentions && !a.mention ? { unavailable: 'mention_off' } : {}),
        }),
      );
    else if (mentions)
      out.push(
        member(a, { mention: false, assign: false, unavailable: a.mention ? 'not_on_this_board' : 'mention_off' }),
      );
  }
  if (mentions)
    for (const a of directory?.unavailable ?? [])
      out.push(member(a, { mention: false, assign: false, unavailable: a.reason }));
  return out;
};

/**
 * The account's people plus its agents as "digital workers" (the planning notes "AGENTS-MCP" מ8): an agent that acts on a
 * mention or an assignment shows in the @mention list and the people pickers — only on its boards (`boardId`, the
 * board's top board). With `mentions`, the mention list's unavailable agents come too (disabled, with the reason).
 * The member list itself (administration, sharing, permissions) never includes agents.
 */
export const usePeople = (accountId: string, boardId?: string | null, mentions = false): Member[] => {
  const members = useMembers(accountId).data?.data;
  const directory = useAgentDirectory(accountId).data;
  return useMemo(
    () => [...(members ?? []), ...directoryMembers(directory, boardId, mentions)],
    [members, directory, boardId, mentions],
  );
};

/** In the @mention list: an agent that may not be picked here (shown greyed with its reason). */
export const mentionDisabled = (m: Member) => !!m.agent && (!m.agent.mention || !!m.agent.unavailable);

/** Why a mention row is disabled: the reason's key suffix (`agents.mention.unavailable.<reason>`). */
export const mentionReason = (m: Member) => m.agent?.unavailable ?? 'mention_off';

const byName = (a: Member, b: Member) => (a.name || a.email).localeCompare(b.name || b.email);

/**
 * The @mention list for a query: people and the agents that act here first (agents by name), then the disabled
 * agents by name; the query filters both. At most `limit` rows.
 */
export const mentionItems = (members: Member[], query: string, limit = 8): Member[] => {
  const q = query.toLowerCase();
  const hits = members.filter((m) => m.status === 'active' && `${m.name} ${m.email}`.toLowerCase().includes(q));
  const people = hits.filter((m) => !m.agent);
  const agents = hits.filter((m) => m.agent && !mentionDisabled(m)).sort(byName);
  const disabled = hits.filter(mentionDisabled).sort(byName);
  return [...people, ...agents, ...disabled].slice(0, limit);
};

/** The next selectable row from `from` going `step` (±1), wrapping; `from` itself when none is selectable. */
export const nextMentionIndex = (items: Member[], from: number, step: 1 | -1) => {
  const n = items.length;
  for (let i = 1; i <= n; i++) {
    const at = (((from + step * i) % n) + n) % n;
    if (!mentionDisabled(items[at]!)) return at;
  }
  return from;
};

/** The first selectable row (-1 when every row is disabled). */
export const firstMentionIndex = (items: Member[]) => items.findIndex((m) => !mentionDisabled(m));
