// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { mergeInvitationAccess } from '../src/modules/invitations/invitations.service';

describe('re-inviting an address with a pending invitation', () => {
  it('keeps the earlier access and adds the new one', () => {
    expect(
      mergeInvitationAccess(
        { board_ids: ['b1'], doc_ids: ['d1'], doc_level: 'editor', message: 'old' },
        { board_ids: ['b2', 'b1'], dashboard_ids: ['x1'], dashboard_levels: { x1: 'viewer' } },
      ),
    ).toEqual({
      board_ids: ['b1', 'b2'],
      doc_ids: ['d1'],
      doc_levels: { d1: 'editor' },
      dashboard_ids: ['x1'],
      dashboard_levels: { x1: 'viewer' },
    });
  });
  it('a new level wins on the objects it shares; no earlier invitation → the new payload', () => {
    expect(
      mergeInvitationAccess(
        { doc_ids: ['d1'], doc_levels: { d1: 'viewer' } },
        { doc_ids: ['d1'], doc_levels: { d1: 'editor' } },
      ),
    ).toEqual({
      doc_ids: ['d1'],
      doc_levels: { d1: 'editor' },
    });
    expect(mergeInvitationAccess(undefined, { board_ids: ['b1'] })).toEqual({ board_ids: ['b1'] });
  });
});
