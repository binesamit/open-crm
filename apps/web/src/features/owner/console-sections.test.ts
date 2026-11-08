// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { OWNER_SECTIONS, sectionFromSearch } from './console-sections';
import { sectionsFor } from './OwnerNav';

describe('owner console sections', () => {
  it('keeps known sections, sends the old `platform` page to the overview and drops the rest', () => {
    expect(sectionFromSearch('security')).toBe('security');
    expect(sectionFromSearch('support')).toBe('support');
    expect(sectionFromSearch('platform')).toBe('overview');
    expect(sectionFromSearch('nope')).toBeUndefined();
    expect(sectionFromSearch(3)).toBeUndefined();
  });

  it('shows the owner every section once, and support staff only support and errors', () => {
    const owner = sectionsFor(true).flatMap((g) => g.sections);
    expect([...owner].sort()).toEqual([...OWNER_SECTIONS].sort());
    expect(sectionsFor(false).flatMap((g) => g.sections)).toEqual(['support', 'errors']);
  });
});
