// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { HELP_ROUTE_KEYS, helpRouteOf } from '../src/api/help';

describe('helpRouteOf', () => {
  it('maps the knowledge center page to support', () => {
    expect(helpRouteOf('/a/acme/help')).toBe('support');
    expect(helpRouteOf('/a/acme/help/')).toBe('support');
    expect(helpRouteOf('/a/acme/support')).toBe('support');
  });

  it('keeps the other screens and the route keys unchanged', () => {
    expect(helpRouteOf('/a/acme/b/01ABC')).toBe('board');
    expect(helpRouteOf('/a/acme/my-work')).toBe('my_work');
    expect(helpRouteOf('/a/acme')).toBe('home');
    expect(HELP_ROUTE_KEYS).not.toContain('help');
  });
});
