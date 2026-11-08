// SPDX-License-Identifier: AGPL-3.0-only
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import {
  CHECKLIST_EVENTS,
  AppError,
  HELP_ARTICLE_KINDS,
  HELP_IMPORT_LIMITS,
  HELP_LOCALES,
  HELP_ROUTE_KEYS,
  HELP_VISIBILITIES,
  type HelpGuide,
  type HelpImportFile,
  type HelpImportReport,
  type HelpLocale,
  type HelpRouteKey,
  helpSlugOf,
  markdownToRichDoc,
  newId,
  helpVideoEmbedUrl,
  richDocToMarkdown,
  type RichNode,
  TOUR_ANCHOR_RE,
  TOUR_AUDIENCES,
  TOUR_STARTS,
  type TourStep,
} from '@bines/shared';
import type { StaffActor } from '../tickets/console.service';
import type { AppDeps } from '../../types';
import {
  checkHelpFile,
  findHelpAssetBySha,
  type HelpFileKind,
  helpAssetDto,
  helpAssetFileName,
  helpAssetsByIds,
  sha256Hex,
  storeHelpAsset,
} from './help.assets';
import { canonical, cleanGuide, cleanHelpContent, guideAssetIds, imageIdsOf } from './help.content';
import {
  findArticleBySlug,
  groupArticles,
  type HelpArticleRow,
  insertHelpCategory,
  listArticleRows,
  listHelpCategories,
  updateArticleRow,
} from './help.repo';
import { createHelpArticle, mayPublish, mayWrite, publishHelpArticle, updateHelpArticle } from './help.service';
import { loadHelpSettings, storeHelpSettings } from './help.settings';
import { findTourBySlug, listTourRows } from './tours.repo';
import { cleanSteps, createTour, tourDto, updateTour } from './tours.service';

/**
 * The knowledge center's package import / export (kb-import, — "articles are uploaded from the UI, not
 * only by code"). A package is a .zip (or loose files) with `articles/*.md` (front-matter + Markdown), optional
 * `categories.json`, `screens.json` and `images/*` (docs: KB-FORMAT). Import is an upsert by (language, slug): a new
 * article is created, a changed one gets a new version, an unchanged one is left alone — so importing the same package
 * twice changes nothing. A preview (`dry_run`) reports what would happen without writing anything.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger' | 'secrets' | 'storage'>;

export type Upload = { name: string; bytes: Uint8Array };

// ---------------------------------------------------------------------------------------------------- package

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
/** A guide's video and captions. */
const VIDEO_EXT = /\.(mp4|m4v|webm)$/i;
const CAPTION_EXT = /\.vtt$/i;
const MD_EXT = /\.(md|markdown)$/i;
/** Junk that zip tools add. */
const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/i;

/** A safe package path (forward slashes, no `..`, not absolute), or null. */
export const safePath = (raw: string): string | null => {
  const p = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.includes('\0')) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '..' || s === '.' || s === '')) return null;
  return parts.join('/');
};

const baseName = (p: string) => p.split('/').pop() ?? p;

/** Joins a reference to the folder of the file it appears in (`..` allowed while it stays inside the package). */
const joinPath = (dir: string, ref: string): string | null => {
  const out = dir ? dir.split('/') : [];
  for (const s of ref.split('/')) {
    if (s === '' || s === '.') continue;
    if (s === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(s);
  }
  return out.join('/') || null;
};

export type Package = { files: Map<string, Uint8Array>; warnings: string[] };

/** A reference written in a package file → the package path it names (beside the file, else from the root), or null. */
const resolveRef = (dir: string, href: string, pkg: Package): string | null => {
  let ref = href.split(/[?#]/)[0]!;
  try {
    ref = decodeURI(ref);
  } catch {
    // keep as written
  }
  const local = joinPath(dir, ref);
  const root = joinPath('', ref.replace(/^\/+/, ''));
  return [local, root].find((p): p is string => !!p && pkg.files.has(p)) ?? null;
};

/**
 * The uploaded files → one package: a .zip is unpacked (sizes checked before anything is allocated — a "zip bomb" is
 * refused), loose .md files go under `articles/`, loose images under `images/`, `categories.json` / `screens.json` at
 * the root. A zip of a folder (`kb/articles/…`) is read from inside that folder.
 */
export const readPackage = (uploads: Upload[]): Package => {
  const files = new Map<string, Uint8Array>();
  const warnings: string[] = [];
  let unpacked = 0;
  const add = (path: string, bytes: Uint8Array) => {
    if (files.size >= HELP_IMPORT_LIMITS.files) throw new AppError('payload_too_large', 'help_import_too_many_files');
    files.set(path, bytes);
  };
  for (const u of uploads) {
    const name = baseName(u.name.replace(/\\/g, '/'));
    if (/\.zip$/i.test(name)) {
      let entries: Record<string, Uint8Array>;
      try {
        let count = 0;
        entries = unzipSync(u.bytes, {
          filter: (f) => {
            if (f.name.endsWith('/') || JUNK.test(f.name)) return false;
            if (++count > HELP_IMPORT_LIMITS.files)
              throw new AppError('payload_too_large', 'help_import_too_many_files');
            if (!safePath(f.name)) {
              warnings.push(`help_import_bad_path:${f.name.slice(0, 120)}`);
              return false;
            }
            // A guide's video may be larger than an image; everything else keeps the image cap.
            if (
              f.originalSize > (VIDEO_EXT.test(f.name) ? HELP_IMPORT_LIMITS.videoBytes : HELP_IMPORT_LIMITS.imageBytes)
            ) {
              warnings.push(`help_import_file_too_large:${f.name.slice(0, 120)}`);
              return false;
            }
            unpacked += f.originalSize;
            if (unpacked > HELP_IMPORT_LIMITS.unpackedBytes)
              throw new AppError('payload_too_large', 'help_import_too_large');
            return true;
          },
        });
      } catch (e) {
        if (e instanceof AppError) throw e;
        throw new AppError('invalid_value', 'help_import_bad_zip');
      }
      const paths = Object.keys(entries).map((p) => safePath(p)!);
      // A zip of the folder: strip the folder when nothing is at the root.
      const firsts = new Set(paths.map((p) => p.split('/')[0]));
      const strip =
        firsts.size === 1 && paths.every((p) => p.includes('/')) && !paths.some((p) => p.startsWith('articles/'))
          ? `${[...firsts][0]}/`
          : '';
      for (const [raw, bytes] of Object.entries(entries)) add(safePath(raw)!.slice(strip.length), bytes);
    } else if (MD_EXT.test(name)) add(`articles/${name}`, u.bytes);
    else if (IMAGE_EXT.test(name)) add(`images/${name}`, u.bytes);
    else if (VIDEO_EXT.test(name) || CAPTION_EXT.test(name)) add(`videos/${name}`, u.bytes);
    else if (/^(categories|screens|tours)\.json$/i.test(name)) add(name.toLowerCase(), u.bytes);
    else warnings.push(`help_import_unknown_file:${name.slice(0, 120)}`);
  }
  return { files, warnings };
};

// ---------------------------------------------------------------------------------------------------- front-matter

const unquote = (v: string): unknown => {
  const s = v.trim();
  if (s.startsWith('"')) {
    try {
      return JSON.parse(s) as string;
    } catch {
      return s.slice(1, s.endsWith('"') ? -1 : undefined);
    }
  }
  if (s.startsWith("'")) return s.slice(1, s.endsWith("'") ? -1 : undefined).replace(/''/g, "'");
  if (/^(true|yes)$/i.test(s)) return true;
  if (/^(false|no)$/i.test(s)) return false;
  if (/^(null|~)?$/i.test(s)) return null;
  return s;
};

/** A comment after an unquoted value (`slug: x   # note`) is not part of it. */
const stripComment = (v: string) => {
  const s = v.trim();
  if (s.startsWith('"') || s.startsWith("'")) {
    const q = s[0]!;
    let i = 1;
    while (i < s.length && !(s[i] === q && s[i - 1] !== '\\')) i++;
    return s.slice(0, i + 1);
  }
  return s.replace(/\s+#.*$/, '');
};

/** `[a, "b c", 'd']` → items. */
const inlineList = (v: string): unknown[] => {
  const inner = v.trim().slice(1, -1);
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (const ch of inner) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => unquote(x)).filter((x) => x !== null && x !== '');
};

/**
 * The front-matter between `---` lines: the simple YAML the format uses (`key: value`, quoted strings, `[a, b]` and
 * `- item` lists, true / false, `#` comments). Anything richer is not needed and not read.
 */
export const parseFrontMatter = (raw: string): { data: Record<string, unknown>; body: string } => {
  const src = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(src);
  if (!m) return { data: {}, body: src };
  const data: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const line of m[1]!.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? (listKey ? /^-\s+(.*)$/.exec(line) : null);
    if (item && listKey) {
      (data[listKey] as unknown[]).push(unquote(stripComment(item[1]!)));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = stripComment(kv[2] ?? '');
    listKey = null;
    if (!value) {
      data[key] = [];
      listKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) data[key] = inlineList(value);
    else data[key] = unquote(value);
  }
  for (const [k, v] of Object.entries(data)) if (Array.isArray(v) && !v.length && k !== 'tags') data[k] = null;
  return { data, body: src.slice(m[0].length) };
};

const optText = (max: number) =>
  z.preprocess((v) => (v === null || v === undefined ? undefined : String(v).trim()), z.string().max(max).optional());

const articleMetaSchema = z.object({
  title: optText(200),
  slug: optText(120),
  locale: z.preprocess((v) => (v ? String(v).toLowerCase() : 'he'), z.enum(HELP_LOCALES)),
  category: optText(80),
  tags: z.preprocess(
    (v) =>
      (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : [])
        .map((x) => String(x ?? '').trim())
        .filter(Boolean),
    z.array(z.string().max(40)).max(30),
  ),
  visibility: z.preprocess((v) => (v ? String(v) : 'signed_in'), z.enum(HELP_VISIBILITIES)),
  excerpt: optText(300),
  publish: z.preprocess((v) => v === true || v === 'true', z.boolean()),
  translation_of: optText(120),
  // A practical guide: its video (a file in the package or a YouTube / Vimeo address), still
  // captions, length, chapters (`- "0:14 Title"`) and steps (`- "Text | images/shot.png | 0.42,0.31"`).
  kind: z.preprocess((v) => (v ? String(v).toLowerCase() : 'article'), z.enum(HELP_ARTICLE_KINDS)),
  /** The slug of the tour "show me in the app" starts. */
  tour: optText(120),
  video: optText(500),
  poster: optText(300),
  captions_he: optText(300),
  captions_en: optText(300),
  duration: z.preprocess(
    (v) => (v === null || v === undefined || v === '' ? undefined : Number(v)),
    z.number().int().min(0).max(36_000).optional(),
  ),
  chapters: z.preprocess((v) => (Array.isArray(v) ? v.map(String) : []), z.array(z.string().max(200)).max(30)),
  steps: z.preprocess((v) => (Array.isArray(v) ? v.map(String) : []), z.array(z.string().max(1500)).max(40)),
});
type ArticleMeta = z.infer<typeof articleMetaSchema>;

/** `"1:05 Title"` / `"65 Title"` → a chapter (null when it is not one). */
export const parseChapter = (raw: string): { at: number; title: string } | null => {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.+?)\s*$/.exec(raw) ?? /^\s*()(\d{1,5})\s+(.+?)\s*$/.exec(raw);
  if (!m) return null;
  const [h, mm, ss, title] = m.length === 5 ? [m[1], m[2], m[3], m[4]] : [undefined, '0', m[2], m[3]];
  const at = Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss);
  return title && Number.isFinite(at) ? { at, title: title.slice(0, 120) } : null;
};

/** `"Text | images/shot.png | 0.42,0.31"` → a step: its text, the screenshot's package path and the marker. */
export const parseStepLine = (raw: string) => {
  const [text = '', image = '', marker = ''] = raw.split('|').map((s) => s.trim());
  const xy = /^(0(?:\.\d+)?|1(?:\.0+)?)\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?)$/.exec(marker);
  return {
    text: text.slice(0, 1000),
    image: image || null,
    marker: xy ? { x: Number(xy[1]), y: Number(xy[2]) } : null,
  };
};

/** Seconds → `m:ss` (or `h:mm:ss`), as a chapter is written in a package. */
export const formatChapterTime = (at: number) => {
  const h = Math.floor(at / 3600);
  const m = Math.floor((at % 3600) / 60);
  const s = String(at % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

/** tours.json: the package's guided tours, upserted by (language, slug). */
const toursFileSchema = z
  .array(
    z.object({
      slug: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .regex(/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u),
      locale: z.preprocess((v) => (v ? String(v).toLowerCase() : 'he'), z.enum(HELP_LOCALES)),
      title: z.string().trim().min(1).max(120),
      route: z.enum(HELP_ROUTE_KEYS),
      audience: z.enum(TOUR_AUDIENCES).default('all'),
      start: z.enum(TOUR_STARTS).default('offer'),
      position: z.number().int().min(0).max(10_000).optional(),
      publish: z.boolean().default(false),
      steps: z
        .array(
          z.object({
            id: z
              .string()
              .trim()
              .min(1)
              .max(40)
              .regex(/^[\w-]+$/),
            anchor: z.string().trim().max(80).regex(TOUR_ANCHOR_RE).nullish(),
            title: z.string().trim().min(1).max(120),
            body: z.string().trim().max(600).default(''),
            /** A picture / clip in the package (`images/…`, `videos/…`). */
            media: z.string().trim().max(300).nullish(),
            wait_click: z.boolean().default(false),
            /** Wait until the person does this (`item_created` …). */
            wait_event: z.enum(CHECKLIST_EVENTS).nullish(),
          }),
        )
        .max(20)
        .default([]),
    }),
  )
  .max(200);

const SLUG_RE = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;

const categoriesSchema = z
  .array(
    z.object({
      key: z.preprocess((v) => String(v ?? ''), z.string().trim().min(1).max(80)),
      name: z.string().trim().min(1).max(80),
      name_en: z.string().trim().max(80).nullish(),
      icon: z.string().trim().max(40).nullish(),
      position: z.number().int().min(0).max(10_000).nullish(),
    }),
  )
  .max(200);

const decodeText = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);

export { canonical };

const sameNames = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toLocaleLowerCase() === b.trim().toLocaleLowerCase();

const errorCode = (e: unknown) =>
  e instanceof AppError ? (e.message.startsWith('help_') ? e.message : e.code) : 'help_import_failed';

// ---------------------------------------------------------------------------------------------------- import

type Planned = {
  path: string;
  meta: ArticleMeta;
  title: string;
  slug: string;
  body: string;
  warnings: string[];
};

const IMAGE_REF = '__help_import_ref:';

/**
 * POST /platform/support/help/import — `dryRun` previews (nothing is written). Writers import; categories and screens
 * are the leads' (like the settings): for a writer they are reported, not changed. `publish: true` publishes only for
 * the publishing roles.
 */
export const importHelpPackage = async (
  deps: Deps,
  s: StaffActor,
  uploads: Upload[],
  dryRun: boolean,
): Promise<HelpImportReport> => {
  const settings = await loadHelpSettings(deps.db);
  if (!mayWrite(s, settings)) throw new AppError('forbidden', 'help_write_forbidden');
  const configure = s.role !== 'agent';
  const publishAllowed = mayPublish(s, settings);
  if (!uploads.length) throw new AppError('invalid_value', 'help_import_empty');
  const pkg = readPackage(uploads);
  const report: HelpImportReport = {
    dry_run: dryRun,
    counts: { new: 0, updated: 0, unchanged: 0, errors: 0, published: 0 },
    categories: { created: 0, matched: 0 },
    images: { new: 0, reused: 0 },
    tours: { new: 0, updated: 0, unchanged: 0, errors: 0 },
    screens: [],
    warnings: [...pkg.warnings],
    files: [],
  };

  // ---- categories.json: matched by (Hebrew) name, else created
  const existingCats = (await listHelpCategories(deps.db)).filter((c) => !c.archivedAt);
  /** package key → category id (`new:<key>` in a preview, null when it may not be created). */
  const catByKey = new Map<string, string | null>();
  const catFile = pkg.files.get('categories.json');
  if (catFile) {
    let parsed: z.infer<typeof categoriesSchema> = [];
    try {
      parsed = categoriesSchema.parse(JSON.parse(decodeText(catFile).replace(/^\uFEFF/, '')));
    } catch {
      report.warnings.push('help_import_bad_categories');
    }
    let position = existingCats.length;
    for (const c of parsed) {
      const found = existingCats.find((x) => sameNames(x.name, c.name));
      if (found) {
        catByKey.set(c.key, found.id);
        report.categories.matched++;
        continue;
      }
      if (!configure) {
        catByKey.set(c.key, null);
        report.warnings.push(`help_import_category_not_allowed:${c.name}`);
        continue;
      }
      report.categories.created++;
      if (dryRun) {
        catByKey.set(c.key, `new:${c.key}`);
        continue;
      }
      const row = await insertHelpCategory(deps.db, {
        id: newId(),
        name: c.name,
        nameEn: c.name_en || null,
        icon: c.icon && /^[a-z0-9-]{1,40}$/i.test(c.icon) ? c.icon : null,
        position: c.position ?? position++,
      });
      existingCats.push(row);
      catByKey.set(c.key, row.id);
    }
  }
  const resolveCategory = (value: string | undefined, warnings: string[]): string | null => {
    if (!value) return null;
    if (catByKey.has(value)) return catByKey.get(value) ?? null;
    const found = existingCats.find((x) => sameNames(x.name, value) || sameNames(x.nameEn, value));
    if (found) return found.id;
    warnings.push(`help_import_category_unknown:${value}`);
    return null;
  };

  // ---- screens.json: screen → tags, merged into the settings (a screen in the file replaces its tags)
  const screenFile = pkg.files.get('screens.json');
  if (screenFile) {
    let raw: unknown = null;
    try {
      raw = JSON.parse(decodeText(screenFile).replace(/^\uFEFF/, ''));
    } catch {
      report.warnings.push('help_import_bad_screens');
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const next = new Map(settings.route_tags.map((r) => [r.route, r.tags]));
      for (const [key, tags] of Object.entries(raw as Record<string, unknown>)) {
        if (!(HELP_ROUTE_KEYS as readonly string[]).includes(key) || !Array.isArray(tags)) {
          report.warnings.push(`help_import_screen_unknown:${key.slice(0, 40)}`);
          continue;
        }
        const clean = [...new Set(tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
        next.set(key as HelpRouteKey, clean);
        report.screens.push(key);
      }
      if (report.screens.length && !configure) {
        report.warnings.push('help_import_screens_not_allowed');
        report.screens = [];
      } else if (report.screens.length && !dryRun)
        await storeHelpSettings(deps.db, s.user.id, {
          ...settings,
          route_tags: [...next].map(([route, tags]) => ({ route, tags })),
        });
    }
  }

  // ---- articles
  const plans: Planned[] = [];
  const articlePaths = [...pkg.files.keys()].filter((p) => p.startsWith('articles/') && MD_EXT.test(p)).sort();
  if (!articlePaths.length) report.warnings.push('help_import_no_articles');
  if (articlePaths.length > HELP_IMPORT_LIMITS.articles)
    throw new AppError('payload_too_large', 'help_import_too_many_articles');
  const fail = (path: string, error: string, extra: Partial<HelpImportFile> = {}) => {
    report.counts.errors++;
    report.files.push({
      path,
      outcome: 'error',
      title: null,
      slug: null,
      locale: null,
      article_id: null,
      published: false,
      error,
      warnings: [],
      ...extra,
    });
  };
  for (const path of articlePaths) {
    const text = decodeText(pkg.files.get(path)!);
    if (text.length > HELP_IMPORT_LIMITS.markdownChars) {
      fail(path, 'help_import_too_long');
      continue;
    }
    const { data, body: rawBody } = parseFrontMatter(text);
    const meta = articleMetaSchema.safeParse(data);
    if (!meta.success) {
      fail(path, `help_import_bad_field:${String(meta.error.issues[0]?.path[0] ?? '')}`);
      continue;
    }
    const warnings: string[] = [];
    let body = rawBody;
    let title = meta.data.title ?? '';
    if (!title) {
      // No title in the front-matter: the first "# heading".
      const h = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(body);
      if (h && body.slice(0, h.index).trim() === '') {
        title = h[1]!.slice(0, 200);
        body = body.slice(h.index + h[0].length);
      }
    }
    if (!title) {
      fail(path, 'help_import_no_title');
      continue;
    }
    let slug = meta.data.slug?.toLowerCase() ?? '';
    if (!slug) {
      slug = helpSlugOf(title).toLowerCase();
      warnings.push('help_import_slug_from_title');
    }
    if (!SLUG_RE.test(slug)) {
      fail(path, 'help_import_bad_slug', { title, slug, locale: meta.data.locale });
      continue;
    }
    plans.push({ path, meta: meta.data, title, slug, body, warnings });
  }
  // Originals before their translations.
  plans.sort((a, b) => Number(!!a.meta.translation_of) - Number(!!b.meta.translation_of));

  /** (locale, slug) → the article of this import (id null in a preview when new), and its group key. */
  const done = new Map<string, { id: string | null; group: string }>();
  /** group key → the languages in it (from the database, then this import). */
  const groupLocales = new Map<string, Set<string>>();
  const localesOf = async (group: string) => {
    let set = groupLocales.get(group);
    if (!set) {
      set = new Set(group.startsWith('new:') ? [] : (await groupArticles(deps.db, group)).map((g) => g.locale));
      groupLocales.set(group, set);
    }
    return set;
  };
  /** sha256 → stored image id (null = would be new, in a preview). */
  const imageBySha = new Map<string, string | null>();

  /**
   * A file of the package (an image, a guide's video or captions) → its stored id; the same bytes are stored once.
   * `ok` false = not a file of an accepted kind (a warning says so); id null = would be new (a preview).
   */
  const storeRef = async (
    ref: string,
    kinds: readonly HelpFileKind[],
    warnings: string[],
    invalid = 'help_import_file_invalid',
  ): Promise<{ id: string | null; ok: boolean }> => {
    const bytes = pkg.files.get(ref)!;
    try {
      checkHelpFile(bytes, kinds);
    } catch {
      warnings.push(`${invalid}:${ref.slice(0, 120)}`);
      return { id: null, ok: false };
    }
    const sha = sha256Hex(bytes);
    if (!imageBySha.has(sha)) {
      const known = await findHelpAssetBySha(deps.db, sha);
      if (known) {
        imageBySha.set(sha, known.id);
        report.images.reused++;
      } else if (dryRun) {
        imageBySha.set(sha, null);
        report.images.new++;
      } else {
        const stored = await storeHelpAsset(deps, s.user.id, bytes, kinds);
        imageBySha.set(sha, stored.row.id);
        report.images[stored.reused ? 'reused' : 'new']++;
      }
    }
    return { id: imageBySha.get(sha) ?? null, ok: true };
  };

  // --- tours.json: guided tours, upserted by (language, slug) — before the guides that link them
  /** `locale:slug` → the tour's id (null = would be new, in a preview). */
  const tourBySlug = new Map<string, string | null>();
  const tourFile = pkg.files.get('tours.json');
  if (tourFile) {
    let tours: z.infer<typeof toursFileSchema> = [];
    try {
      tours = toursFileSchema.parse(JSON.parse(decodeText(tourFile).replace(/^\uFEFF/, '')));
    } catch {
      report.warnings.push('help_import_bad_tours');
    }
    for (const t of tours) {
      const key = `${t.locale}:${t.slug.toLowerCase()}`;
      try {
        const steps: TourStep[] = [];
        let newMedia = false;
        for (const st of t.steps) {
          let media: string | null = null;
          if (st.media) {
            const found = resolveRef('', st.media, pkg);
            if (!found) report.warnings.push(`help_import_file_missing:${st.media.slice(0, 120)}`);
            else {
              const r = await storeRef(found, ['image', 'video'], report.warnings);
              media = r.id;
              if (r.ok && !r.id) newMedia = true;
            }
          }
          steps.push({
            id: st.id,
            anchor: st.anchor ?? null,
            title: st.title,
            body: st.body,
            media_id: media,
            wait_click: st.wait_click,
            wait_event: st.wait_event ?? null,
          });
        }
        const existing = await findTourBySlug(deps.db, t.locale, t.slug.toLowerCase());
        const wantPublish = t.publish && publishAllowed;
        if (t.publish && !publishAllowed) report.warnings.push(`help_publish_forbidden:${t.slug}`);
        if (!existing) {
          report.tours.new++;
          if (dryRun) {
            tourBySlug.set(key, null);
            continue;
          }
          const created = await createTour(deps, s, {
            title: t.title,
            slug: t.slug.toLowerCase(),
            locale: t.locale,
            route: t.route,
            audience: t.audience,
            start: t.start,
            steps,
          });
          const row = await updateTour(deps, s, created.id, {
            ...(t.position !== undefined ? { position: t.position } : {}),
            ...(wantPublish ? { status: 'published' as const } : {}),
          });
          tourBySlug.set(key, row.id);
          continue;
        }
        tourBySlug.set(key, existing.id);
        const nextStatus = wantPublish ? 'published' : existing.status;
        const changed =
          newMedia ||
          t.title !== existing.title ||
          t.route !== existing.route ||
          t.audience !== existing.audience ||
          t.start !== existing.start ||
          nextStatus !== existing.status ||
          (t.position !== undefined && t.position !== existing.position) ||
          canonical(dryRun ? steps : await cleanSteps(deps, steps)) !== canonical(existing.steps);
        report.tours[changed ? 'updated' : 'unchanged']++;
        if (changed && !dryRun)
          await updateTour(deps, s, existing.id, {
            title: t.title,
            route: t.route,
            audience: t.audience,
            start: t.start,
            steps,
            ...(t.position !== undefined ? { position: t.position } : {}),
            ...(nextStatus !== existing.status ? { status: nextStatus as 'published' } : {}),
          });
      } catch (e) {
        deps.logger.warn({ tour: t.slug, err: String(e) }, 'help import: tour failed');
        report.tours.errors++;
        report.warnings.push(`help_import_tour_failed:${t.slug}:${errorCode(e)}`);
      }
    }
  }
  /** The tour an article's `tour:` names: this import's first, then a stored one (its language, then any). */
  const tourIdFor = async (slug: string | undefined, locale: string, warnings: string[]) => {
    if (!slug) return null;
    const s2 = slug.toLowerCase();
    if (tourBySlug.has(`${locale}:${s2}`)) return tourBySlug.get(`${locale}:${s2}`) ?? null;
    const row =
      (await findTourBySlug(deps.db, locale, s2)) ?? (await findTourBySlug(deps.db, locale === 'he' ? 'en' : 'he', s2));
    if (!row) warnings.push(`help_import_tour_unknown:${slug.slice(0, 120)}`);
    return row?.id ?? null;
  };

  for (const plan of plans) {
    const { meta, path, warnings } = plan;
    const key = `${meta.locale}:${plan.slug}`;
    const base = { path, title: plan.title, slug: plan.slug, locale: meta.locale as HelpLocale };
    if (done.has(key)) {
      fail(path, 'help_import_duplicate', base);
      continue;
    }
    try {
      // Images: `![alt](images/x.png)` → a help image (the same bytes are stored once).
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const refs: string[] = [];
      const draft = markdownToRichDoc(plan.body, {
        maxLength: HELP_IMPORT_LIMITS.markdownChars,
        image: (href, alt, title) => {
          if (/^[a-z][\w+.-]*:|^\/\//i.test(href)) {
            warnings.push(`help_import_image_external:${href.slice(0, 120)}`);
            return null;
          }
          const found = resolveRef(dir, href, pkg);
          if (!found) {
            warnings.push(`help_import_image_missing:${href.slice(0, 120)}`);
            return null;
          }
          refs.push(found);
          // `![alt](images/x.png "width=320")` — the width it is shown at.
          const width = Number(/^\s*(?:width\s*=\s*)?(\d{2,4})(?:px)?\s*$/i.exec(title ?? '')?.[1]);
          return {
            type: 'image',
            attrs: { src: `${IMAGE_REF}${found}`, alt: alt.slice(0, 300), ...(width ? { width } : {}) },
          };
        },
      });
      const refIds = new Map<string, string | null>();
      let newImages = false;
      for (const ref of new Set(refs)) {
        const { id, ok } = await storeRef(ref, ['image'], warnings, 'help_import_image_invalid');
        if (ok && !id) newImages = true;
        refIds.set(ref, id);
      }
      const withIds = (n: RichNode): RichNode | null => {
        if (n.type === 'image' && typeof n.attrs?.src === 'string' && n.attrs.src.startsWith(IMAGE_REF)) {
          const id = refIds.get(n.attrs.src.slice(IMAGE_REF.length));
          if (id) return { ...n, attrs: { ...n.attrs, src: id } };
          const alt = String(n.attrs.alt ?? '');
          return alt ? { type: 'paragraph', content: [{ type: 'text', text: alt }] } : null;
        }
        return n.content ? { ...n, content: n.content.map(withIds).filter((c): c is RichNode => !!c) } : n;
      };
      const content = await cleanHelpContent(deps.db, withIds(draft));

      // A practical guide: its video, still, captions, chapters and steps from the front-matter.
      let guide: HelpGuide | null = null;
      if (meta.kind === 'guide') {
        const fileOf = async (ref: string | undefined, kinds: readonly HelpFileKind[]) => {
          if (!ref) return null;
          const found = resolveRef(dir, ref, pkg);
          if (!found) {
            warnings.push(`help_import_file_missing:${ref.slice(0, 120)}`);
            return null;
          }
          const r = await storeRef(found, kinds, warnings);
          if (r.ok && !r.id) newImages = true;
          return r.id;
        };
        const isUrl = !!meta.video && /^https?:\/\//i.test(meta.video);
        if (isUrl && !helpVideoEmbedUrl(meta.video))
          warnings.push(`help_import_video_url:${meta.video!.slice(0, 120)}`);
        const url = isUrl && helpVideoEmbedUrl(meta.video) ? meta.video! : null;
        const assetId = meta.video && !isUrl ? await fileOf(meta.video, ['video']) : null;
        const captions: { locale: HelpLocale; asset_id: string }[] = [];
        for (const [locale, ref] of [
          ['he', meta.captions_he],
          ['en', meta.captions_en],
        ] as const) {
          const id = await fileOf(ref, ['captions']);
          if (id) captions.push({ locale, asset_id: id });
        }
        const chapters = meta.chapters.flatMap((c) => {
          const ch = parseChapter(c);
          if (!ch) warnings.push(`help_import_bad_chapter:${c.slice(0, 60)}`);
          return ch ? [ch] : [];
        });
        const steps = [];
        for (const line of meta.steps) {
          const st = parseStepLine(line);
          if (!st.text) {
            warnings.push(`help_import_bad_step:${line.slice(0, 60)}`);
            continue;
          }
          steps.push({ text: st.text, image_id: await fileOf(st.image ?? undefined, ['image']), marker: st.marker });
        }
        guide = await cleanGuide(deps.db, {
          video:
            assetId || url
              ? {
                  asset_id: assetId,
                  url,
                  poster_id: await fileOf(meta.poster, ['image']),
                  captions,
                  chapters,
                  duration: meta.duration ?? null,
                }
              : null,
          steps,
        });
      }
      const tourId = await tourIdFor(meta.tour, meta.locale, warnings);

      const categoryId = resolveCategory(meta.category, warnings);
      const tags = [...new Set(meta.tags)];
      const existing = await findArticleBySlug(deps.db, meta.locale, plan.slug);

      // Translation: the article of the other language with that slug (this import first, then the stored ones).
      let original: { id: string | null; group: string } | null = null;
      if (meta.translation_of) {
        const ref = meta.translation_of.toLowerCase();
        for (const l of HELP_LOCALES.filter((x) => x !== meta.locale)) {
          original = done.get(`${l}:${ref}`) ?? null;
          if (original) break;
          const row = await findArticleBySlug(deps.db, l, ref);
          if (row) {
            original = { id: row.id, group: row.groupId };
            break;
          }
        }
        if (!original) warnings.push(`help_import_translation_unknown:${ref}`);
      }
      if (original && (!existing || existing.groupId !== original.group)) {
        const locales = await localesOf(original.group);
        if (locales.has(meta.locale)) throw new AppError('conflict', 'help_translation_exists');
      }

      const wantPublish = meta.publish && publishAllowed;
      if (meta.publish && !publishAllowed) warnings.push('help_publish_forbidden');
      const categoryForWrite = categoryId?.startsWith('new:') ? null : categoryId;

      let outcome: HelpImportFile['outcome'];
      let row: Pick<HelpArticleRow, 'id' | 'groupId' | 'status' | 'version' | 'publishedVersion'> | null = null;
      let needsPublish = false;
      if (!existing) {
        outcome = 'new';
        needsPublish = wantPublish;
        if (!dryRun) {
          const created = await createHelpArticle(deps, s, {
            title: plan.title,
            slug: plan.slug,
            locale: meta.locale,
            excerpt: meta.excerpt,
            category_id: categoryForWrite,
            tags,
            visibility: meta.visibility,
            content,
            kind: meta.kind,
            guide,
            tour_id: tourId,
            ...(original?.id ? { translation_of: original.id } : {}),
          });
          row = {
            id: created.id,
            groupId: created.group_id,
            status: created.status,
            version: created.version,
            publishedVersion: null,
          };
        }
      } else {
        const guideChanged = meta.kind === 'guide' && canonical(guide) !== canonical(existing.guide ?? null);
        const contentChanged = newImages || canonical(content) !== canonical(existing.content) || guideChanged;
        const metaChanged =
          plan.title !== existing.title ||
          (meta.excerpt ?? existing.excerpt) !== existing.excerpt ||
          (categoryId ?? null) !== (existing.categoryId ?? null) ||
          canonical(tags) !== canonical(existing.tags ?? []) ||
          meta.visibility !== existing.visibility ||
          meta.kind !== existing.kind ||
          // A tour that would be new (a preview) changes the link too.
          (tourId ?? null) !== (existing.tourId ?? null) ||
          (!!meta.tour && tourBySlug.get(`${meta.locale}:${meta.tour.toLowerCase()}`) === null);
        const regroup = !!original && existing.groupId !== original.group;
        outcome = contentChanged || metaChanged || regroup ? 'updated' : 'unchanged';
        row = existing;
        if (!dryRun && regroup && original && !original.group.startsWith('new:'))
          row = await updateArticleRow(deps.db, existing.id, { groupId: original.group });
        if (!dryRun && (contentChanged || metaChanged)) {
          const updated = await updateHelpArticle(deps, s, existing.id, {
            title: plan.title,
            ...(meta.excerpt !== undefined ? { excerpt: meta.excerpt } : {}),
            category_id: categoryForWrite,
            tags,
            visibility: meta.visibility,
            kind: meta.kind,
            tour_id: tourId,
            ...(contentChanged ? { content } : {}),
            ...(guideChanged ? { guide } : {}),
          });
          row = { ...row, version: updated.version, status: updated.status };
        }
        needsPublish =
          wantPublish &&
          (outcome === 'updated' ||
            existing.status !== 'published' ||
            (existing.publishedVersion ?? 0) < existing.version);
      }
      if (needsPublish && !dryRun && row) await publishHelpArticle(deps, s, row.id);

      const group = row?.groupId ?? original?.group ?? `new:${key}`;
      done.set(key, { id: row?.id ?? null, group });
      (await localesOf(group)).add(meta.locale);
      report.counts[outcome === 'new' ? 'new' : outcome === 'updated' ? 'updated' : 'unchanged']++;
      if (needsPublish) report.counts.published++;
      report.files.push({
        ...base,
        outcome,
        article_id: row?.id ?? null,
        published: needsPublish,
        error: null,
        warnings,
      });
    } catch (e) {
      deps.logger.warn({ path, err: String(e) }, 'help import: article failed');
      fail(path, errorCode(e), { ...base, warnings });
    }
  }
  report.files.sort((a, b) => a.path.localeCompare(b.path));
  if (!dryRun)
    deps.logger.info({ by: s.user.id, counts: report.counts, images: report.images }, 'help center package imported');
  return report;
};

/** POST /platform/support/help/assets — an image for an article (writers): stored once per content. */
export const uploadHelpImage = async (deps: Pick<Deps, 'db' | 'storage'>, s: StaffActor, bytes: Uint8Array) => {
  if (!mayWrite(s, await loadHelpSettings(deps.db))) throw new AppError('forbidden', 'help_write_forbidden');
  // Images, and a guide's video and captions — each checked by its first bytes.
  const { row, reused } = await storeHelpAsset(deps, s.user.id, bytes, ['image', 'video', 'captions']);
  return helpAssetDto(row, reused);
};

// ---------------------------------------------------------------------------------------------------- export

const yamlString = (v: string) => JSON.stringify(v);

/**
 * GET /platform/support/help/export — every article (the working copy), the categories, the screens' tags and the
 * images, as a package in the same format the import reads (a backup, or a copy to another installation).
 */
export const exportHelpPackage = async (deps: Pick<Deps, 'db' | 'storage'>): Promise<Uint8Array> => {
  const [settings, categories, articles] = await Promise.all([
    loadHelpSettings(deps.db),
    listHelpCategories(deps.db),
    listArticleRows(deps.db, { limit: 10_000 }),
  ]);
  const zip: Zippable = {};
  const enc = new TextEncoder();
  // Categories: a key per category (from its English name when it has one), unique in the package.
  const keys = new Map<string, string>();
  const used = new Set<string>();
  for (const c of categories) {
    let k = helpSlugOf(c.nameEn || c.name).toLowerCase();
    for (let i = 2; used.has(k); i++) k = `${helpSlugOf(c.nameEn || c.name).toLowerCase()}-${i}`;
    used.add(k);
    keys.set(c.id, k);
  }
  zip['categories.json'] = enc.encode(
    JSON.stringify(
      categories.map((c) => ({
        key: keys.get(c.id),
        name: c.name,
        ...(c.nameEn ? { name_en: c.nameEn } : {}),
        ...(c.icon ? { icon: c.icon } : {}),
        position: c.position,
      })),
      null,
      2,
    ),
  );
  zip['screens.json'] = enc.encode(
    JSON.stringify(Object.fromEntries(settings.route_tags.map((r) => [r.route, r.tags])), null, 2),
  );
  const byId = new Map(articles.map((a) => [a.id, a]));
  const tours = (await listTourRows(deps.db)).map(tourDto);
  const tourSlugs = new Map(tours.map((t) => [t.id, t.slug]));
  // Every file the package needs: articles' images, guides' videos / stills / captions / screenshots (prod
  //) and tours' clips. Images under images/, videos and captions under videos/.
  const fileIds = [
    ...articles.flatMap((a) => imageIdsOf(a.content as RichNode)),
    ...articles.flatMap((a) => guideAssetIds(a.guide as HelpGuide | null)),
    ...tours.flatMap((t) => t.steps.map((s) => s.media_id).filter((x): x is string => !!x)),
  ];
  const assets = new Map((await helpAssetsByIds(deps.db, fileIds)).map((a) => [a.id, a]));
  const imageFiles = new Map<string, string>();
  for (const a of assets.values()) {
    const video = a.contentType.startsWith('video/') || a.contentType === 'text/vtt';
    const max = a.contentType.startsWith('video/') ? HELP_IMPORT_LIMITS.videoBytes : HELP_IMPORT_LIMITS.imageBytes;
    const bytes = await deps.storage.get(a.storageKey, max).catch(() => null);
    if (!bytes) continue;
    const file = `${video ? 'videos' : 'images'}/${helpAssetFileName(a)}`;
    zip[file] = [new Uint8Array(bytes), { level: 0 }];
    imageFiles.set(a.id, file);
  }
  if (tours.length)
    zip['tours.json'] = enc.encode(
      JSON.stringify(
        tours.map((t) => ({
          slug: t.slug,
          locale: t.locale,
          title: t.title,
          route: t.route,
          audience: t.audience,
          start: t.start,
          position: t.position,
          publish: t.status === 'published',
          steps: t.steps.map((s) => ({
            id: s.id,
            ...(s.anchor ? { anchor: s.anchor } : {}),
            title: s.title,
            ...(s.body ? { body: s.body } : {}),
            ...(s.media_id && imageFiles.has(s.media_id) ? { media: imageFiles.get(s.media_id) } : {}),
            ...(s.wait_click ? { wait_click: true } : {}),
            ...(s.wait_event ? { wait_event: s.wait_event } : {}),
          })),
        })),
        null,
        2,
      ),
    );
  /** A guide's front-matter lines. */
  const guideLines = (a: (typeof articles)[number]) => {
    if (a.kind !== 'guide') return [];
    const g = (a.guide ?? null) as HelpGuide | null;
    const file = (id: string | null | undefined) => (id ? imageFiles.get(id) : undefined);
    const v = g?.video;
    const out = ['kind: guide'];
    if (a.tourId && tourSlugs.has(a.tourId)) out.push(`tour: ${tourSlugs.get(a.tourId)}`);
    const video = file(v?.asset_id) ?? v?.url;
    if (video) out.push(`video: ${yamlString(video)}`);
    if (file(v?.poster_id)) out.push(`poster: ${yamlString(file(v?.poster_id)!)}`);
    for (const c of v?.captions ?? [])
      if (file(c.asset_id)) out.push(`captions_${c.locale}: ${yamlString(file(c.asset_id)!)}`);
    if (v?.duration) out.push(`duration: ${v.duration}`);
    if (v?.chapters.length)
      out.push('chapters:', ...v.chapters.map((c) => `  - ${yamlString(`${formatChapterTime(c.at)} ${c.title}`)}`));
    if (g?.steps.length)
      out.push(
        'steps:',
        ...g.steps.map((s) => {
          const parts = [s.text.replace(/\|/g, '/'), file(s.image_id) ?? ''];
          if (s.marker) parts.push(`${+s.marker.x.toFixed(3)},${+s.marker.y.toFixed(3)}`);
          return `  - ${yamlString(parts.join(' | ').replace(/( \| )+$/, ''))}`;
        }),
      );
    return out;
  };
  const names = new Set<string>();
  for (const a of articles) {
    const original =
      a.groupId !== a.id
        ? (byId.get(a.groupId) ??
          articles.find((x) => x.groupId === a.groupId && x.id !== a.id && x.locale !== a.locale))
        : undefined;
    const lines = [
      '---',
      `title: ${yamlString(a.title)}`,
      `slug: ${a.slug}`,
      `locale: ${a.locale}`,
      ...(a.categoryId && keys.has(a.categoryId) ? [`category: ${yamlString(keys.get(a.categoryId)!)}`] : []),
      `tags: [${(a.tags ?? []).map(yamlString).join(', ')}]`,
      `visibility: ${a.visibility}`,
      ...(a.excerpt ? [`excerpt: ${yamlString(a.excerpt)}`] : []),
      `publish: ${a.status === 'published'}`,
      ...(original && original.locale !== a.locale ? [`translation_of: ${original.slug}`] : []),
      ...guideLines(a),
      '---',
      '',
    ];
    const body = richDocToMarkdown(a.content as RichNode, {
      image: (attrs) => {
        const file = imageFiles.get(String(attrs.src));
        const alt = String(attrs.alt ?? '').replace(/[[\]]/g, '');
        const width = typeof attrs.width === 'number' ? ` "width=${attrs.width}"` : '';
        return file ? `![${alt}](${file}${width})` : '';
      },
    });
    let name = `articles/${a.locale}/${a.slug}.md`;
    for (let i = 2; names.has(name); i++) name = `articles/${a.locale}/${a.slug}-${i}.md`;
    names.add(name);
    zip[name] = enc.encode(lines.join('\n') + body);
  }
  return zipSync(zip, { level: 6 });
};
