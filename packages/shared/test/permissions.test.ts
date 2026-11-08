// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { type AccountRole, canAccount, canInviteRole, DEFAULT_ACCOUNT_PERMISSIONS } from '../src';

describe('canInviteRole (05 §2 defaults)', () => {
  const cases: [AccountRole, AccountRole, boolean][] = [
    ['admin', 'admin', true],
    ['admin', 'guest', true],
    ['member', 'admin', false],
    ['member', 'member', false], // perm.invite_members defaults to ✘
    ['member', 'viewer', true],
    ['member', 'guest', true],
    ['viewer', 'viewer', false],
    ['viewer', 'guest', false],
    ['guest', 'guest', false],
  ];
  it.each(cases)('%s invites %s → %s', (actor, invitee, expected) => {
    expect(canInviteRole(actor, invitee).ok).toBe(expected);
  });

  it('respects account overrides', () => {
    const perms = { ...DEFAULT_ACCOUNT_PERMISSIONS, invite_members: true, viewer_invite_viewers: true };
    expect(canInviteRole('member', 'member', perms).ok).toBe(true);
    expect(canInviteRole('viewer', 'viewer', perms).ok).toBe(true);
  });
});

describe('canAccount', () => {
  it('only admins update the account', () => {
    expect(canAccount('admin', 'account.update').ok).toBe(true);
    expect(canAccount('member', 'account.update').ok).toBe(false);
  });

  it('everyone lists users — a guest gets a filtered list (D22.7, apps/api guest-people)', () => {
    expect(canAccount('guest', 'users.read').ok).toBe(true);
    expect(canAccount('viewer', 'users.read').ok).toBe(true);
  });
});
