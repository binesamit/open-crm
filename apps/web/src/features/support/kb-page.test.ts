// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { HelpCategory, HelpHit } from '@bines/shared';
import { categoryIcon, categoryLabel, helpHiddenFor, parseKbSearch, relatedOf, visibleCategories } from './kb-page';

const cat = (id: string, extra: Partial<HelpCategory> = {}): HelpCategory => ({
  id,
  name: `קטגוריה ${id}`,
  name_en: null,
  icon: null,
  position: 0,
  archived: false,
  ...extra,
});
const hit = (id: string, slug = `s-${id}`): HelpHit => ({
  id,
  slug,
  locale: 'he',
  title: id,
  excerpt: '',
  category_id: 'c1',
  tags: [],
  url: `https://x.test/help?article=${slug}`,
  kind: 'article',
  duration: null,
  poster: null,
  step_count: 0,
});

describe('the knowledge center page', () => {
  it('reads its view from the URL: an article, a category, or the index', () => {
    expect(parseKbSearch({})).toEqual({});
    expect(parseKbSearch({ article: ' how-to ', category: 'c1' })).toEqual({ article: 'how-to', category: 'c1' });
    expect(parseKbSearch({ article: '', category: 7 })).toEqual({});
    expect(parseKbSearch({ article: 'x'.repeat(300) }).article).toHaveLength(120);
  });

  it("names a category in the reader's language", () => {
    expect(categoryLabel({ name: 'בורדים', name_en: 'Boards' }, 'en')).toBe('Boards');
    expect(categoryLabel({ name: 'בורדים', name_en: 'Boards' }, 'he')).toBe('בורדים');
    expect(categoryLabel({ name: 'בורדים', name_en: null }, 'en')).toBe('בורדים');
  });

  it("shows a category's icon: an app icon by name, a short text (emoji), else the default", () => {
    expect(categoryIcon('board')).toEqual({ kind: 'icon', name: 'board' });
    expect(categoryIcon(' 📊 ')).toEqual({ kind: 'text', text: '📊' });
    expect(categoryIcon('not-an-icon-name')).toBeNull();
    expect(categoryIcon('')).toBeNull();
    expect(categoryIcon(null)).toBeNull();
    // An own property only (never the prototype's).
    expect(categoryIcon('toString')).toBeNull();
  });

  it('lists only the categories that hold articles for this person', () => {
    const list = [cat('c1'), cat('c2'), cat('c3', { archived: true })];
    expect(visibleCategories(list, { c1: 2, c3: 4 }).map((c) => c.id)).toEqual(['c1']);
    expect(visibleCategories(list, undefined)).toEqual([]);
  });

  it('"see also" leaves out the article being read (by id or slug) and keeps the order', () => {
    const hits = [hit('a'), hit('b'), hit('c'), hit('d')];
    expect(relatedOf(hits, { id: 'b' }).map((h) => h.id)).toEqual(['a', 'c', 'd']);
    expect(relatedOf(hits, { slug: 's-a' }).map((h) => h.id)).toEqual(['b', 'c', 'd']);
    expect(relatedOf(hits, { id: 'z' }, 2).map((h) => h.id)).toEqual(['a', 'b']);
  });

  it('is not for guests nor inside an account opened by a support grant', () => {
    expect(helpHiddenFor({ role: 'member', support: null } as never)).toBe(false);
    expect(helpHiddenFor({ role: 'guest', support: null } as never)).toBe(true);
    expect(helpHiddenFor({ role: 'admin', support: { id: 'g' } } as never)).toBe(true);
  });
});
