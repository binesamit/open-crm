// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import { ApiError } from '@bines/sdk';
import { markPlanBlock, planBlock, planBlockOf, planBlockOfStatus, resetPlanBlocks } from './plan-status';

const err = (status: number, code: string) => new ApiError(status, { code, message: code } as never);

describe('plan status (423 plan_suspended / plan_read_only)', () => {
  afterEach(() => resetPlanBlocks());

  it('reads only 423 plan answers', () => {
    expect(planBlockOf(err(423, 'plan_suspended'))).toBe('suspended');
    expect(planBlockOf(err(423, 'plan_read_only'))).toBe('read_only');
    expect(planBlockOf(err(402, 'plan_limit_reached'))).toBeNull();
    expect(planBlockOf(err(403, 'plan_read_only'))).toBeNull();
    expect(planBlockOf(new Error('x'))).toBeNull();
  });

  it('keeps one state per account; suspended wins over read-only', () => {
    markPlanBlock('a', 'read_only');
    expect(planBlock('a')).toBe('read_only');
    expect(planBlock('b')).toBeNull();
    markPlanBlock('a', 'suspended');
    markPlanBlock('a', 'read_only');
    expect(planBlock('a')).toBe('suspended');
  });

  it('closed (plan-lock): a 403 account_closed, or the stated status; it wins over everything', () => {
    expect(planBlockOf(err(403, 'account_closed'))).toBe('closed');
    expect(planBlockOf(err(403, 'forbidden'))).toBeNull();
    expect(planBlockOfStatus('closed')).toBe('closed');
    expect(planBlockOfStatus('active')).toBeNull();
    expect(planBlockOfStatus(undefined)).toBeUndefined();
    markPlanBlock('c', 'suspended');
    markPlanBlock('c', 'closed');
    markPlanBlock('c', 'read_only');
    markPlanBlock('c', 'suspended');
    expect(planBlock('c')).toBe('closed');
  });
});
