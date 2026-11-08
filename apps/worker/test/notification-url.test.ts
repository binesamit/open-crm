// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { itemUrl } from '../src/notifications';
import type { MailRow } from '../src/repositories/notifications.repo';

const row = (r: Partial<MailRow>) =>
  ({
    type: 'update.mentioned',
    account_slug: 'acme',
    doc_id: null,
    dashboard_id: null,
    update_id: null,
    item_id: 'I1',
    item_name: 'Deal',
    top_board_id: 'B1',
    ...r,
  }) as MailRow;

describe('notification links (s37reply)', () => {
  it('opens an update or reply on its own thread', () => {
    expect(itemUrl('https://app', row({ update_id: 'R1' }))).toBe('https://app/a/acme/b/B1/i/I1?tab=updates&update=R1');
  });

  it('keeps the plain item and the time tab links', () => {
    expect(itemUrl('https://app', row({}))).toBe('https://app/a/acme/b/B1/i/I1');
    expect(itemUrl('', row({ type: 'time.forgotten' }))).toBe('/a/acme/b/B1/i/I1?tab=time');
  });
});
