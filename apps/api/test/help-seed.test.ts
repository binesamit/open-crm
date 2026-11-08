// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { helpArticles, helpCategories, helpTours, platformSettings } from '../src/db/schema';
import { packFolder, seedHelpCenter } from '../src/modules/help/help.seed';
import { readPackage } from '../src/modules/help/help.import';
import { createTestContext, type TestContext } from './helpers';

/**
 * The help center that ships with the code (seed/help) fills a new installation's empty help center once, and never
 * touches an installation that already has articles or was seeded before.
 */
let t: TestContext;

beforeAll(async () => {
  t = await createTestContext();
});
afterAll(() => t.close());

describe('the shipped help center package', () => {
  it('is a valid package: every article has front-matter, every image it names is in it', () => {
    const pkg = readPackage([{ name: 'help.zip', bytes: packFolder('../../seed/help') }]);
    const articles = [...pkg.files.keys()].filter((p) => p.startsWith('articles/'));
    expect(articles.length).toBeGreaterThan(90);
    expect(pkg.files.has('categories.json')).toBe(true);
    expect(pkg.files.has('tours.json')).toBe(true);
    const dec = new TextDecoder();
    for (const p of articles) {
      const src = dec.decode(pkg.files.get(p));
      expect(src.startsWith('---\n'), p).toBe(true);
      for (const m of src.matchAll(/images\/[\w.-]+\.(?:webp|png|jpe?g)/g))
        expect(pkg.files.has(m[0]), `${p} → ${m[0]}`).toBe(true);
    }
  });
});

describe('seedHelpCenter', () => {
  it('imports the package into an empty help center, once', async () => {
    const res = await seedHelpCenter(t.deps, { dir: '../../seed/help', enabled: true });
    expect(res).toBe('imported');
    const articles = await t.db.select({ slug: helpArticles.slug, status: helpArticles.status }).from(helpArticles);
    expect(articles.length).toBeGreaterThan(90);
    expect(articles.some((a) => a.slug === 'welcome-overview' && a.status === 'published')).toBe(true);
    expect((await t.db.select().from(helpCategories)).length).toBeGreaterThan(10);
    expect((await t.db.select().from(helpTours)).length).toBeGreaterThan(10);
    const [mark] = await t.db.select().from(platformSettings).where(eq(platformSettings.id, 'help_seed'));
    expect(mark?.settings).toMatchObject({ imported: true });

    // Deleted by the owner: never brought back.
    await t.db.delete(helpArticles);
    expect(await seedHelpCenter(t.deps, { dir: '../../seed/help', enabled: true })).toBe('skipped');
    expect((await t.db.select().from(helpArticles)).length).toBe(0);
  });

  it('only marks an installation that already has articles, and skips when turned off or missing', async () => {
    await t.db.delete(platformSettings).where(eq(platformSettings.id, 'help_seed'));
    const dir = mkdtempSync(join(tmpdir(), 'help-seed-'));
    mkdirSync(join(dir, 'articles'));
    writeFileSync(join(dir, 'articles', 'x.md'), '---\ntitle: "X"\nslug: x\nlocale: he\npublish: true\n---\nשלום\n');
    expect(await seedHelpCenter(t.deps, { dir, enabled: false })).toBe('skipped');
    expect(await seedHelpCenter(t.deps, { dir: join(dir, 'nope'), enabled: true })).toBe('skipped');
    expect(await seedHelpCenter(t.deps, { dir, enabled: true })).toBe('imported');
    await t.db.delete(platformSettings).where(eq(platformSettings.id, 'help_seed'));
    expect(await seedHelpCenter(t.deps, { dir: '../../seed/help', enabled: true })).toBe('marked');
    expect((await t.db.select().from(helpArticles)).map((a) => a.slug)).toEqual(['x']);
  });
});
