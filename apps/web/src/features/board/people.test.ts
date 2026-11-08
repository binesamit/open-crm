// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { AgentDirectory } from '@bines/shared';
import type { Member } from './board-api';
import {
  directoryMembers,
  firstMentionIndex,
  mentionDisabled,
  mentionItems,
  mentionReason,
  nextMentionIndex,
} from './people';

const agent = (id: string, name: string, mention: boolean, board_ids: string[], assign = false) => ({
  id,
  user_id: `u-${id}`,
  name,
  avatar: null,
  role: 'agent',
  mention,
  assign,
  board_ids,
});

const directory: AgentDirectory = {
  data: [
    agent('a1', 'Zed helper', true, ['B']),
    agent('a2', 'Alpha writer', true, ['C']),
    agent('a3', 'Mute bot', false, ['B'], true),
  ],
  unavailable: [{ id: 'a4', user_id: 'u-a4', name: 'Beta paused', avatar: null, role: 'agent', reason: 'inactive' }],
};

const human: Member = {
  user_id: 'u1',
  name: 'Dana',
  email: 'dana@x.io',
  role: 'member',
  status: 'active',
  avatar_url: null,
};

describe('agent mention picker (r18gates)', () => {
  it('people pickers keep only the agents of this board, without reasons', () => {
    const list = directoryMembers(directory, 'B');
    expect(list.map((m) => m.agent?.id)).toEqual(['a1', 'a3']);
    expect(list.every((m) => !m.agent?.unavailable)).toBe(true);
  });

  it('the mention list adds the unavailable agents with their reason, never assignable', () => {
    const list = directoryMembers(directory, 'B', true);
    const reasons = Object.fromEntries(list.map((m) => [m.agent!.id, mentionDisabled(m) ? mentionReason(m) : null]));
    expect(reasons).toEqual({ a1: null, a2: 'not_on_this_board', a3: 'mention_off', a4: 'inactive' });
    expect(list.find((m) => m.agent!.id === 'a2')!.agent!.assign).toBe(false);
    expect(list.find((m) => m.agent!.id === 'a4')!.agent!.assign).toBe(false);
    // An agent that acts on assignment here stays assignable even though it cannot be mentioned.
    expect(list.find((m) => m.agent!.id === 'a3')!.agent!.assign).toBe(true);
  });

  it('people and enabled agents first, then the disabled agents by name; the query filters both', () => {
    const members = [human, ...directoryMembers(directory, 'B', true)];
    expect(mentionItems(members, '').map((m) => m.name)).toEqual([
      'Dana',
      'Zed helper',
      'Alpha writer',
      'Beta paused',
      'Mute bot',
    ]);
    expect(mentionItems(members, 'bot').map((m) => m.name)).toEqual(['Mute bot']);
  });

  it('the keyboard skips disabled rows', () => {
    const items = mentionItems([human, ...directoryMembers(directory, 'B', true)], '');
    expect(firstMentionIndex(items)).toBe(0);
    expect(nextMentionIndex(items, 1, 1)).toBe(0);
    expect(nextMentionIndex(items, 0, -1)).toBe(1);
    const onlyDisabled = mentionItems(directoryMembers(directory, 'B', true), 'beta');
    expect(firstMentionIndex(onlyDisabled)).toBe(-1);
  });
});
