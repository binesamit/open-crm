// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  type BoardPermissionContext,
  canBoard,
  effectiveBoardRole,
  looserRole,
  STRUCTURE_ACTIONS,
} from '../src/permissions/board';

const ctx = (over: Partial<BoardPermissionContext> & { kind?: BoardPermissionContext['board']['kind'] } = {}) => ({
  accountRole: 'member' as const,
  workspaceVisible: true,
  membership: null,
  ...over,
  board: { kind: over.kind ?? 'main', permissionSet: 'edit_everything' as const, ...over.board },
});

describe('canBoard (05 §4, §5, §10)', () => {
  it('members edit main boards per the permission set', () => {
    expect(canBoard(ctx(), 'item.update').ok).toBe(true);
    expect(canBoard(ctx(), 'column.create').ok).toBe(true);
    const content = ctx({ board: { kind: 'main', permissionSet: 'edit_content' } });
    expect(canBoard(content, 'item.update').ok).toBe(true);
    expect(canBoard(content, 'column.create').ok).toBe(false);
    const view = ctx({ board: { kind: 'main', permissionSet: 'view_comment' } });
    expect(canBoard(view, 'item.read').ok).toBe(true);
    expect(canBoard(view, 'item.create').ok).toBe(false);
  });

  it('only owners and admins change the board itself', () => {
    expect(canBoard(ctx(), 'board.update').ok).toBe(false);
    expect(canBoard(ctx({ membership: { role: 'owner' } }), 'board.update').ok).toBe(true);
    expect(canBoard(ctx({ accountRole: 'admin' }), 'board.delete').ok).toBe(true);
  });

  it('account viewers are read-only even as subscribers (strictest wins)', () => {
    const v = ctx({ accountRole: 'viewer', membership: { role: 'owner' } });
    expect(canBoard(v, 'board.read').ok).toBe(true);
    expect(canBoard(v, 'item.update').ok).toBe(false);
  });

  it('private and shareable boards need a subscription', () => {
    const priv = ctx({ kind: 'private' });
    expect(canBoard(priv, 'board.read')).toMatchObject({ ok: false, as404: true });
    expect(canBoard({ ...priv, membership: { role: 'subscriber' } }, 'item.read').ok).toBe(true);
    // Admins see the board's existence but not its content without subscribing.
    expect(canBoard({ ...priv, accountRole: 'admin' }, 'board.read').ok).toBe(true);
    expect(canBoard({ ...priv, accountRole: 'admin' }, 'item.read').ok).toBe(false);
  });

  it('guests only ever reach shareable boards they subscribe to', () => {
    expect(canBoard(ctx({ accountRole: 'guest' }), 'board.read').ok).toBe(false);
    expect(
      canBoard(ctx({ accountRole: 'guest', kind: 'private', membership: { role: 'subscriber' } }), 'board.read').ok,
    ).toBe(false);
    expect(
      canBoard(ctx({ accountRole: 'guest', kind: 'shareable', membership: { role: 'subscriber' } }), 'item.read').ok,
    ).toBe(true);
  });

  it('an explicit subscriber role only lowers what the set gives (05 §4)', () => {
    const sub = (level: 'editor' | 'viewer' | 'contributor', permissionSet = 'edit_everything' as const) =>
      ctx({ membership: { role: 'subscriber', level }, board: { kind: 'main', permissionSet } });
    expect(effectiveBoardRole(sub('viewer'))).toBe('viewer');
    expect(canBoard(sub('viewer'), 'item.update').ok).toBe(false);
    expect(canBoard(sub('contributor'), 'item.update').ok).toBe(true);
    expect(canBoard(sub('contributor'), 'column.create').ok).toBe(false);
    // Never above the set: an "editor" on a view-and-comment board stays a viewer.
    const capped = ctx({
      membership: { role: 'subscriber', level: 'editor' },
      board: { kind: 'main', permissionSet: 'view_comment' },
    });
    expect(effectiveBoardRole(capped)).toBe('viewer');
    // Owners are owners whatever the level.
    expect(effectiveBoardRole(ctx({ membership: { role: 'owner', level: 'viewer' } }))).toBe('owner');
  });

  it('looserRole: the more generous of two subscriptions (null = the set, wins)', () => {
    expect(looserRole('viewer', 'contributor')).toBe('contributor');
    expect(looserRole('viewer', null)).toBe(null);
  });

  it('guests never manage automations or invite, even on an edit-everything shareable board (05 §2)', () => {
    const g = ctx({ accountRole: 'guest', kind: 'shareable', membership: { role: 'subscriber' } });
    expect(canBoard(g, 'item.update').ok).toBe(true);
    expect(canBoard(g, 'automation.read').ok).toBe(true);
    expect(canBoard(g, 'automation.manage')).toMatchObject({ ok: false, reason: 'guest_restricted' });
    expect(canBoard(g, 'board.invite')).toMatchObject({ ok: false, reason: 'guest_restricted' });
    // A member with the same subscription keeps them.
    const m = ctx({ kind: 'shareable', membership: { role: 'subscriber' } });
    expect(canBoard(m, 'automation.manage').ok).toBe(true);
    expect(canBoard(m, 'board.invite').ok).toBe(true);
  });

  it('guests change no structure — columns, groups — unless the account allows it', () => {
    const g = ctx({ accountRole: 'guest', kind: 'shareable', membership: { role: 'subscriber' } });
    for (const a of STRUCTURE_ACTIONS) expect(canBoard(g, a)).toMatchObject({ ok: false, reason: 'guest_structure' });
    expect(canBoard(g, 'item.create').ok).toBe(true);
    // Even an explicit editor level, or an owner row (a guest never owns a board).
    expect(canBoard({ ...g, membership: { role: 'subscriber', level: 'editor' } }, 'column.update').ok).toBe(false);
    expect(canBoard({ ...g, membership: { role: 'owner' } }, 'column.delete').ok).toBe(false);
    // The account switch: as far as the permission set goes.
    for (const a of STRUCTURE_ACTIONS) expect(canBoard({ ...g, guestStructure: true }, a).ok).toBe(true);
    const content = {
      ...g,
      guestStructure: true,
      board: { kind: 'shareable' as const, permissionSet: 'edit_content' as const },
    };
    expect(canBoard(content, 'column.create').ok).toBe(false);
    expect(canBoard({ ...g, guestStructure: true }, 'board.update').ok).toBe(false);
    // Members and admins are not affected; account viewers never had it.
    const m = ctx({ kind: 'shareable', membership: { role: 'subscriber' } });
    expect(canBoard(m, 'column.update').ok).toBe(true);
    expect(canBoard(ctx({ accountRole: 'admin' }), 'column.delete').ok).toBe(true);
    expect(canBoard(ctx({ accountRole: 'viewer', membership: { role: 'subscriber' } }), 'column.update').ok).toBe(
      false,
    );
  });

  it('a hidden workspace hides its boards', () => {
    expect(canBoard(ctx({ workspaceVisible: false }), 'board.read').ok).toBe(false);
  });
});
