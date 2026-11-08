// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { requiredScope } from '../src/lib/scopes';

/**
 * Sign-in takeover routes are a person's session only (extensions security review follow-up): no API, MCP,
 * extension or server token — whatever its scopes — may create a recovery link or reset a member's 2FA.
 */
describe('session-only takeover routes', () => {
  it('refuses tokens on recovery links and 2FA resets', () => {
    expect(requiredScope('POST', '/users/01ABC/recovery-link')).toEqual({ forbidden: true });
    expect(requiredScope('POST', '/users/01ABC/reset-2fa')).toEqual({ forbidden: true });
    expect(requiredScope('POST', '/platform/accounts/01ABC/recovery-link')).toEqual({ forbidden: true });
  });

  it('leaves the other user routes to their scopes', () => {
    expect(requiredScope('GET', '/users')).toEqual({ scope: 'users:read' });
    expect(requiredScope('PATCH', '/users/01ABC')).toEqual({ scope: 'users:write' });
  });
});
