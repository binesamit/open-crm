// SPDX-License-Identifier: AGPL-3.0-only
import { strToU8, unzipSync, zipSync } from 'fflate';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markdownToRichDoc, richDocToMarkdown, renderRichDoc } from '@bines/shared';
import { helpAssets } from '../src/db/schema';
import { cleanContent, stripAccountEmbeds } from '../src/modules/help/help.content';
import { parseFrontMatter, readPackage, safePath } from '../src/modules/help/help.import';
import { sniffImage } from '../src/modules/help/help.assets';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * kb-import: images in help articles (platform storage, checked by content, deduplicated, served by a
 * public redirect), the image node allowed only in help content and only for stored help images, and the package
 * import (preview, apply, idempotent re-import, translation groups, publish) / export from the owner console.
 */
let t: TestContext;
let owner: string;
let agent: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const png = (w: number, h: number, seed = 0) => {
  const img = new PNG({ width: w, height: h });
  img.data.fill(seed);
  return new Uint8Array(PNG.sync.write(img));
};

const send = (cookie: string, path: string, files: { name: string; bytes: Uint8Array }[]) => {
  const form = new FormData();
  for (const f of files) form.append('files', new File([f.bytes as Uint8Array<ArrayBuffer>], f.name));
  return t.app.request(`/api/v1${path}`, { method: 'POST', headers: { origin: WEB_ORIGIN, cookie }, body: form });
};

const md = (meta: Record<string, string>, text: string) =>
  `---\n${Object.entries(meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n${text}\n`;

const PKG = () =>
  zipSync({
    'kb/categories.json': strToU8(
      JSON.stringify([{ key: 'boards', name: 'בורדים', name_en: 'Boards', icon: 'board', position: 1 }]),
    ),
    'kb/screens.json': strToU8(JSON.stringify({ board: ['boards', 'views'], nowhere: ['x'] })),
    'kb/images/new-board.png': png(3, 2, 7),
    'kb/articles/create-board.md': strToU8(
      md(
        {
          title: 'יצירת בורד חדש',
          slug: 'create-board            # explicit',
          locale: 'he',
          category: 'boards',
          tags: '[boards, getting-started]',
          visibility: 'public',
          excerpt: 'איך יוצרים בורד',
          publish: 'true',
        },
        '## שלבים\n\n1. לוחצים על **חדש**\n2. בוחרים תבנית\n\n![המסך](images/new-board.png)\n\n| a | b |\n|---|---|\n| 1 | 2 |',
      ),
    ),
    'kb/articles/en/create-board.md': strToU8(
      md(
        {
          title: '"Create a new board"',
          slug: 'create-board',
          locale: 'en',
          category: 'Boards',
          tags: '[boards]',
          visibility: 'public',
          publish: 'true',
          translation_of: 'create-board',
        },
        'Click **New**.\n\n![screen](../../images/new-board.png)',
      ),
    ),
    'kb/articles/broken.md': strToU8('no front matter and no heading'),
  });

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const acc = await body(
    await t.api(owner).post('/platform/accounts', {
      name: 'Helpers',
      slug: 'helpers',
      first_admin_email: 'agent@support.test',
      template_set: 'empty',
    }),
  );
  expect(acc.account?.id).toBeTruthy();
  const token = t.inviteTokenFor('agent@support.test');
  agent = t.cookieFrom(await t.signUpWithPassword('agent@support.test', token))!;
  await t.api(agent).post('/invitations/accept', { token });
  await t.api(owner).post('/platform/support/staff', { email: 'agent@support.test', role: 'agent' });
});
afterAll(() => t.close());

describe('package helpers', () => {
  it('parses the front-matter the format uses', () => {
    const { data, body: text } = parseFrontMatter(
      '\uFEFF---\r\ntitle: "שלום: עולם"\r\nslug: a-b   # note\r\ntags: [x, "y z"]\r\nlist:\r\n  - one\r\n  - two\r\npublish: true\r\n---\r\nBody',
    );
    expect(data).toMatchObject({ title: 'שלום: עולם', slug: 'a-b', tags: ['x', 'y z'], list: ['one', 'two'] });
    expect(data.publish).toBe(true);
    expect(text).toBe('Body');
  });

  it('refuses unsafe paths', () => {
    expect(safePath('../etc/passwd')).toBeNull();
    expect(safePath('/abs/x.md')).toBeNull();
    expect(safePath('C:/x.md')).toBeNull();
    expect(safePath('a/../../b')).toBeNull();
    expect(safePath('articles\\x.md')).toBe('articles/x.md');
    const pkg = readPackage([
      { name: 'p.zip', bytes: zipSync({ 'articles/a.md': strToU8('x'), '__MACOSX/._a.md': strToU8('x') }) },
    ]);
    expect([...pkg.files.keys()]).toEqual(['articles/a.md']);
  });

  it('sniffs images by content and reads their size', () => {
    expect(sniffImage(png(5, 4))).toMatchObject({ type: 'image/png', width: 5, height: 4 });
    expect(sniffImage(strToU8('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImage(strToU8('GIF89a\x02\x00\x03\x00rest-of-gif'))).toMatchObject({ width: 2, height: 3 });
  });

  it('keeps image nodes only in help content, only with a help image id', () => {
    const id = '01HZX4T9V4M6P8Q2R3S5T7V9WX';
    const out = cleanContent({
      type: 'doc',
      content: [
        { type: 'image', attrs: { src: id, alt: 'ok', onerror: 'x' } },
        { type: 'image', attrs: { src: 'https://evil.test/x.png', alt: 'external' } },
        { type: 'image', attrs: { asset_id: id, alt: 'doc image' } },
      ],
    });
    expect(out.content).toEqual([{ type: 'image', attrs: { src: id, alt: 'ok' } }]);
    expect(stripAccountEmbeds({ type: 'image', attrs: { src: 'javascript:alert(1)' } })).toBeNull();
    // The account renderer (updates, docs) never shows an image node.
    expect(renderRichDoc({ type: 'doc', content: [{ type: 'image', attrs: { src: id } }] }).html).toBe('');
  });

  it('turns Markdown images into image nodes only when asked, and round-trips', () => {
    const src = '# T\n\nBefore ![alt](images/a.png) after\n\n- item **bold**\n- second\n\n1. one\n2. two _it_';
    expect(JSON.stringify(markdownToRichDoc(src))).not.toContain('"image"');
    const doc = markdownToRichDoc(src, { image: (href, alt) => ({ type: 'image', attrs: { src: href, alt } }) });
    expect(doc.content!.map((n) => n.type)).toEqual([
      'heading',
      'paragraph',
      'image',
      'paragraph',
      'bulletList',
      'orderedList',
    ]);
    const back = richDocToMarkdown(doc, { image: (a) => `![${String(a.alt)}](${String(a.src)})` });
    const again = markdownToRichDoc(back, { image: (href, alt) => ({ type: 'image', attrs: { src: href, alt } }) });
    expect(again).toEqual(doc);
  });
});

describe('images', () => {
  it('uploads an image (writers), refuses non-images, dedupes, serves a public redirect', async () => {
    const bytes = png(4, 3, 1);
    const up = await send(owner, '/platform/support/help/assets', [{ name: 'shot.png', bytes }]);
    const a = await body(up);
    expect(up.status, JSON.stringify(a)).toBe(201);
    expect(a).toMatchObject({ content_type: 'image/png', width: 4, height: 3, reused: false });
    expect(a.url).toBe(`/api/v1/help/assets/${a.id}`);
    expect([...t.storage.objects.keys()].some((k) => k.startsWith('platform/help/'))).toBe(true);

    const again = await body(await send(owner, '/platform/support/help/assets', [{ name: 'copy.png', bytes }]));
    expect(again).toMatchObject({ id: a.id, reused: true });

    // A script named .png, an SVG: refused by content.
    const svg = await send(owner, '/platform/support/help/assets', [
      { name: 'x.png', bytes: strToU8('<svg onload="alert(1)"></svg>') },
    ]);
    expect(svg.status).toBe(422);
    const none = await t.app.request('/api/v1/platform/support/help/assets', {
      method: 'POST',
      headers: { origin: WEB_ORIGIN, cookie: owner, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(none.status).toBe(422);

    // Signed-out readers: a redirect to a short-lived storage link.
    const pub = await t.app.request(`/api/v1/help/assets/${a.id}`);
    expect(pub.status).toBe(302);
    expect(pub.headers.get('location')).toContain('platform/help/');
    expect((await t.app.request('/api/v1/help/assets/01HZX4T9V4M6P8Q2R3S5T7V9WX')).status).toBe(404);
    expect((await t.app.request('/api/v1/help/assets/not-an-id')).status).toBe(404);
    // Support agents write articles (the default writing roles): they may upload too.
    expect((await send(agent, '/platform/support/help/assets', [{ name: 'a.png', bytes }])).status).toBe(201);
  });

  it('keeps a stored image in an article, drops a foreign one, renders it', async () => {
    const a = await body(await send(owner, '/platform/support/help/assets', [{ name: 's.png', bytes: png(2, 2, 9) }]));
    const res = await t.api(owner).post('/platform/support/help/articles', {
      title: 'With image',
      locale: 'en',
      visibility: 'public',
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Look' }] },
          { type: 'image', attrs: { src: a.id, alt: 'the <b>screen</b>', width: 300 } },
          { type: 'image', attrs: { src: '01HZX4T9V4M6P8Q2R3S5T7V9WX', alt: 'not stored' } },
          { type: 'image', attrs: { src: 'https://evil.test/x.png', alt: 'external' } },
        ],
      },
    });
    const art = await body(res);
    expect(res.status, JSON.stringify(art)).toBe(201);
    const images = (art.content.content as Json[]).filter((n) => n.type === 'image');
    expect(images).toEqual([{ type: 'image', attrs: { src: a.id, alt: 'the <b>screen</b>', width: 300 } }]);
    await t.api(owner).post(`/platform/support/help/articles/${art.id}/publish`);
    const view = await body(await t.app.request(`/api/v1/help/articles/${art.slug}?locale=en`));
    expect(view.html).toContain(`<img src="${WEB_ORIGIN}/api/v1/help/assets/${a.id}"`);
    expect(view.html).toContain('alt="the &lt;b&gt;screen&lt;/b&gt;"');
    expect(view.html).not.toContain('evil.test');
  });
});

describe('package import', () => {
  it('previews without writing anything', async () => {
    const before = (await t.db.select().from(helpAssets)).length;
    const res = await send(owner, '/platform/support/help/import?dry_run=1', [{ name: 'kb.zip', bytes: PKG() }]);
    const r = await body(res);
    expect(res.status, JSON.stringify(r)).toBe(200);
    expect(r.dry_run).toBe(true);
    expect(r.counts).toMatchObject({ new: 2, updated: 0, unchanged: 0, errors: 1, published: 2 });
    expect(r.categories).toEqual({ created: 1, matched: 0 });
    expect(r.images).toEqual({ new: 1, reused: 0 });
    expect(r.screens).toEqual(['board']);
    expect(r.warnings).toContain('help_import_screen_unknown:nowhere');
    expect(r.files.find((f: Json) => f.path === 'articles/broken.md')).toMatchObject({
      outcome: 'error',
      error: 'help_import_no_title',
    });
    expect((await t.db.select().from(helpAssets)).length).toBe(before);
    const list = await body(await t.api(owner).get('/platform/support/help/articles?q=board'));
    expect(list.data.filter((a: Json) => a.slug === 'create-board')).toHaveLength(0);
  });

  it('imports: categories, screens, images, translation group, publish', async () => {
    const res = await send(owner, '/platform/support/help/import', [{ name: 'kb.zip', bytes: PKG() }]);
    const r = await body(res);
    expect(res.status, JSON.stringify(r)).toBe(200);
    expect(r.counts).toMatchObject({ new: 2, errors: 1, published: 2 });
    expect(r.images).toEqual({ new: 1, reused: 0 });
    const cfg = await body(await t.api(owner).get('/platform/support/help/config'));
    const cat = cfg.categories.find((c: Json) => c.name === 'בורדים');
    expect(cat).toMatchObject({ name_en: 'Boards', icon: 'board' });
    expect(cfg.settings.route_tags).toContainEqual({ route: 'board', tags: ['boards', 'views'] });

    const he = r.files.find((f: Json) => f.path === 'articles/create-board.md');
    const en = r.files.find((f: Json) => f.path === 'articles/en/create-board.md');
    const heArt = await body(await t.api(owner).get(`/platform/support/help/articles/${he.article_id}`));
    const enArt = await body(await t.api(owner).get(`/platform/support/help/articles/${en.article_id}`));
    expect(heArt).toMatchObject({ status: 'published', visibility: 'public', category_id: cat.id, locale: 'he' });
    expect(heArt.tags).toEqual(['boards', 'getting-started']);
    expect(enArt.group_id).toBe(heArt.group_id);
    expect(enArt.category_id).toBe(cat.id); // matched by the existing category's English name
    expect(enArt.title).toBe('Create a new board');
    const img = (heArt.content.content as Json[]).find((n) => n.type === 'image');
    const enImg = (enArt.content.content as Json[]).find((n) => n.type === 'image');
    expect(img!.attrs.src).toBe(enImg!.attrs.src); // the same file → one image
    expect(JSON.stringify(heArt.content)).toContain('"table"');

    // Published: searchable and readable by everyone.
    const view = await body(await t.app.request('/api/v1/help/articles/create-board?locale=he'));
    expect(view.html).toContain(`/api/v1/help/assets/${img!.attrs.src}`);
    expect(view.translations).toEqual([{ slug: 'create-board', locale: 'en', title: 'Create a new board' }]);
    const hits = await body(await t.app.request('/api/v1/help/articles?q=%D7%AA%D7%91%D7%A0%D7%99%D7%AA&locale=he'));
    expect(hits.data.map((h: Json) => h.slug)).toContain('create-board');
  });

  it('importing the same package again changes nothing', async () => {
    const before = await body(await t.api(owner).get('/platform/support/help/articles'));
    const r = await body(await send(owner, '/platform/support/help/import', [{ name: 'kb.zip', bytes: PKG() }]));
    expect(r.counts).toMatchObject({ new: 0, updated: 0, unchanged: 2, published: 0 });
    expect(r.categories).toEqual({ created: 0, matched: 1 });
    expect(r.images).toEqual({ new: 0, reused: 1 });
    const after = await body(await t.api(owner).get('/platform/support/help/articles'));
    const versions = (l: Json) => Object.fromEntries((l.data as Json[]).map((a) => [a.id, a.version]));
    expect(versions(after)).toEqual(versions(before));
  });

  it('a changed file is a new version; loose .md files import too', async () => {
    const file = md(
      { title: 'יצירת בורד חדש', slug: 'create-board', locale: 'he', category: 'בורדים', publish: 'false' },
      'טקסט חדש',
    );
    const r = await body(
      await send(owner, '/platform/support/help/import', [{ name: 'create-board.md', bytes: strToU8(file) }]),
    );
    expect(r.counts).toMatchObject({ updated: 1, published: 0 });
    const id = r.files[0].article_id;
    const art = await body(await t.api(owner).get(`/platform/support/help/articles/${id}`));
    expect(art.unpublished_changes).toBe(true);
    expect(art.visibility).toBe('signed_in');
  });

  it('a second translation into the same language is refused per file', async () => {
    const file = md({ title: 'Another', slug: 'another-board', locale: 'en', translation_of: 'create-board' }, 'Text');
    const r = await body(await send(owner, '/platform/support/help/import', [{ name: 'x.md', bytes: strToU8(file) }]));
    expect(r.files[0]).toMatchObject({ outcome: 'error', error: 'help_translation_exists' });
  });

  it('an agent imports articles but not categories / screens, and may not publish', async () => {
    const zip = zipSync({
      'categories.json': strToU8(JSON.stringify([{ key: 'new', name: 'קטגוריה חדשה' }])),
      'screens.json': strToU8(JSON.stringify({ item: ['x'] })),
      'articles/a.md': strToU8(md({ title: 'Agent article', slug: 'agent-a', category: 'new', publish: 'true' }, 'x')),
    });
    const r = await body(await send(agent, '/platform/support/help/import', [{ name: 'p.zip', bytes: zip }]));
    expect(r.counts).toMatchObject({ new: 1, published: 0 });
    expect(r.warnings).toContain('help_import_screens_not_allowed');
    expect(r.files[0].warnings).toContain('help_publish_forbidden');
    const cfg = await body(await t.api(owner).get('/platform/support/help/config'));
    expect(cfg.categories.map((c: Json) => c.name)).not.toContain('קטגוריה חדשה');
  });

  it('refuses a bad zip and path traversal inside one', async () => {
    const bad = await send(owner, '/platform/support/help/import', [{ name: 'x.zip', bytes: strToU8('not a zip') }]);
    expect(bad.status).toBe(422);
    const evil = zipSync({ '../../evil.md': strToU8(md({ title: 'Evil', slug: 'evil' }, 'x')) });
    const r = await body(await send(owner, '/platform/support/help/import', [{ name: 'e.zip', bytes: evil }]));
    expect(r.counts.new).toBe(0);
    expect(r.warnings.some((w: string) => w.startsWith('help_import_bad_path'))).toBe(true);
  });

  // A real package on disk (the knowledge center's content): `KB_PACKAGE_DIR=… vitest run test/kb-import.test.ts`.
  it.runIf(!!process.env.KB_PACKAGE_DIR)('previews a real package folder without errors', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = process.env.KB_PACKAGE_DIR!;
    const entries: Record<string, Uint8Array> = {};
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else entries[`kb/${relative(root, p).replace(/\\/g, '/')}`] = new Uint8Array(readFileSync(p));
      }
    };
    walk(root);
    const count = Object.keys(entries).filter((k) => /^kb\/articles\/.+\.md$/.test(k)).length;
    const res = await send(owner, '/platform/support/help/import?dry_run=1', [
      { name: 'kb.zip', bytes: zipSync(entries) },
    ]);
    const r = await body(res);
    expect(res.status, JSON.stringify(r).slice(0, 2000)).toBe(200);
    const errors = (r.files as Json[]).filter((f) => f.outcome === 'error');
    expect(errors, JSON.stringify(errors)).toEqual([]);
    expect(r.files).toHaveLength(count);
    console.warn(
      `real package: ${count} articles`,
      JSON.stringify({ counts: r.counts, categories: r.categories, screens: r.screens, warnings: r.warnings }),
      `file warnings: ${JSON.stringify([...new Set((r.files as Json[]).flatMap((f) => f.warnings.map((w: string) => w.split(':')[0])))])}`,
    );
  });

  it('exports a package the import reads back unchanged', async () => {
    const res = await t.app.request('/api/v1/platform/support/help/export', {
      headers: { origin: WEB_ORIGIN, cookie: owner },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    const bytes = new Uint8Array(await res.arrayBuffer());
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(
      expect.arrayContaining(['categories.json', 'screens.json', 'articles/he/create-board.md']),
    );
    expect(Object.keys(files).some((f) => f.startsWith('images/'))).toBe(true);
    const he = new TextDecoder().decode(files['articles/he/create-board.md']);
    expect(he).toContain('slug: create-board');
    const en = new TextDecoder().decode(files['articles/en/create-board.md']);
    expect(en).toContain('translation_of: create-board');
    expect(en).toMatch(/!\[screen\]\(images\/[0-9A-Z]+\.png\)/);
    const r = await body(await send(owner, '/platform/support/help/import?dry_run=1', [{ name: 'b.zip', bytes }]));
    expect(
      r.files.filter((f: Json) => f.outcome !== 'unchanged'),
      JSON.stringify(r.files),
    ).toEqual([]);
    expect(r.counts.new).toBe(0);
    expect(r.counts.updated).toBe(0);
    expect(r.counts.errors).toBe(0);
  });
});
