// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { accountSlugSchema } from '../src';

describe('accountSlugSchema', () => {
  it.each(['demo', 'acme-ltd', 'a1b'])('accepts %s', (slug) => {
    expect(accountSlugSchema.safeParse(slug).success).toBe(true);
  });

  it.each(['ab', '-acme', 'acme-', 'Acme', 'אקמי', 'a_b'])('rejects malformed %s', (slug) => {
    expect(accountSlugSchema.safeParse(slug).success).toBe(false);
  });

  it.each(['owner', 'admin', 'api', 'portal', 'login'])('rejects reserved %s', (slug) => {
    const result = accountSlugSchema.safeParse(slug);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('slug_reserved');
  });
});
