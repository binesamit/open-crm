// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { AppError, isId, newId } from '../src';

describe('AppError', () => {
  it('maps codes to HTTP status', () => {
    expect(new AppError('account_suspended').status).toBe(423);
    expect(new AppError('account_mismatch').status).toBe(403);
  });
});

describe('ids', () => {
  it('generates ULIDs', () => {
    expect(isId(newId())).toBe(true);
  });
});
