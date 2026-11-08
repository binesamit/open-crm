// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  accountHelpAiDtoSchema,
  AppError,
  createHelpArticleSchema,
  HELP_LOCALES,
  helpAnswerSchema,
  helpArticleDetailSchema,
  helpArticleFilterSchema,
  helpArticleSummarySchema,
  helpArticleVersionSchema,
  helpArticleViewSchema,
  helpAskSchema,
  helpCategorySchema,
  helpCenterInfoSchema,
  helpCenterSettingsDtoSchema,
  helpConsoleConfigSchema,
  helpEventSchema,
  helpAssetSchema,
  helpFeedbackSchema,
  helpHitSchema,
  helpImportReportSchema,
  helpMetricsSchema,
  helpOptionsSchema,
  helpSearchQuerySchema,
  updateAccountHelpAiByOwnerSchema,
  updateAccountHelpAiSchema,
  updateHelpArticleSchema,
  updateHelpCenterSettingsSchema,
  upsertHelpCategorySchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { RateLimiter } from '../../lib/rate-limit';
import { currentUser, requireAccount, requireSupportConsole, requireUser } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  askHelp,
  getAccountHelpAi,
  getAccountHelpAiAsOwner,
  platformAiModels,
  testPlatformAi,
  updateAccountHelpAi,
  updateAccountHelpAiAsOwner,
} from './help.ai';
import { helpAssetLocation } from './help.assets';
import { exportHelpPackage, importHelpPackage, type Upload, uploadHelpImage } from './help.import';
import {
  helpCenterInfo,
  helpClientEvent,
  helpFeedback,
  helpOptions,
  type HelpReader,
  localeOf,
  searchHelp,
  viewHelpArticle,
} from './help.reader';
import {
  articleFromTicket,
  createHelpArticle,
  deleteHelpArticle,
  getHelpArticle,
  helpConsoleConfig,
  helpMetrics,
  listHelpArticles,
  listHelpVersions,
  publishHelpArticle,
  restoreHelpVersion,
  saveHelpCategory,
  unpublishHelpArticle,
  updateHelpArticle,
  updateHelpSettings,
} from './help.service';

/** Search-type requests per person (or address) per minute — the panel searches while typing (debounced). */
const SEARCH_PER_MIN = 120;
/** Help-assistant questions per person per minute (each may cost a model call). */
const ASK_PER_MIN = 10;
/** Public help-center reads per address per minute. */
const PUBLIC_PER_MIN = 120;
/** Article images per address per minute (an article may hold many). */
const ASSETS_PER_MIN = 1200;
/** The import route: its request may be larger than the API's usual body cap (app.ts). */
export const HELP_IMPORT_PATH = '/platform/support/help/import';
/** Help files (images, a guide's video and captions): a video may be larger than the usual body cap too. */
export const HELP_ASSETS_PATH = '/platform/support/help/assets';

const hitList = z.object({ data: z.array(helpHitSchema) }).openapi('HelpHitList');

/**
 * The knowledge center: the owner console's Support → Knowledge (`/platform/support/help/*`, the
 * owner and support staff — 404 to everyone else), the help panel inside an account (`/support/help/*`, a person's
 * session only) and the public help center (`/help/*`, no sign-in; `public` articles only).
 */
export const helpRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();
  const searchLimiter = new RateLimiter(SEARCH_PER_MIN, 60_000);
  const askLimiter = new RateLimiter(ASK_PER_MIN, 60_000);
  const publicLimiter = new RateLimiter(PUBLIC_PER_MIN, 60_000);
  const assetLimiter = new RateLimiter(ASSETS_PER_MIN, 60_000);
  const charge = (c: Context<AppEnv>, limiter: RateLimiter, key: string) => {
    const waitMs = limiter.hit(key);
    if (waitMs > 0) {
      c.header('Retry-After', String(Math.ceil(waitMs / 1000)));
      throw new AppError('rate_limited', 'Too many requests', { retry_after_ms: waitMs });
    }
  };

  // ---------------------------------------------------------------- console
  const consoleMw = [requireUser(), requireSupportConsole(deps)];
  const common = errors(400, 401, 403, 404, 409, 422);
  const ptags = ['platform'];
  const staff = (c: Context<AppEnv>) => ({ user: currentUser(c), role: c.get('supportRole') ?? 'agent' });
  const detail = json(helpArticleDetailSchema, 'Article');
  const versionParams = z.object({
    id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
    versionId: z.string().openapi({ param: { name: 'versionId', in: 'path' } }),
  });

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/help/config',
      tags: ptags,
      summary: 'The knowledge center: my permissions, its settings, categories and the tags in use',
      middleware: consoleMw,
      responses: { 200: json(helpConsoleConfigSchema, 'Configuration'), ...common },
    }),
    async (c) => c.json(await helpConsoleConfig(deps, staff(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/support/help/settings',
      tags: ptags,
      summary: 'Change the knowledge center settings (leads and the owner); the AI key is write-only',
      middleware: consoleMw,
      request: jsonBody(updateHelpCenterSettingsSchema),
      responses: { 200: json(helpCenterSettingsDtoSchema, 'Settings'), ...common },
    }),
    async (c) => c.json(await updateHelpSettings(deps, staff(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/help/ai/test',
      tags: ptags,
      summary: 'Test the platform AI connection of the help assistant',
      middleware: consoleMw,
      responses: { 200: json(z.object({ ok: z.boolean(), error: z.string().nullable() }), 'Result'), ...common },
    }),
    async (c) => c.json(await testPlatformAi(deps, staff(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/help/ai/models',
      tags: ptags,
      summary: 'The models the platform AI connection may use',
      middleware: consoleMw,
      request: { query: z.object({ refresh: z.enum(['1', 'true']).optional() }) },
      responses: { 200: json(z.object({}).passthrough(), 'Models'), ...common },
    }),
    async (c) => c.json(await platformAiModels(deps, staff(c), !!c.req.valid('query').refresh), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/help/accounts/{id}/ai',
      tags: ptags,
      summary: "An account's help-assistant connection: source, cap, lock, this month's spend",
      middleware: consoleMw,
      request: { params: idParam },
      responses: { 200: json(accountHelpAiDtoSchema, 'Account help AI'), ...common },
    }),
    async (c) => c.json(await getAccountHelpAiAsOwner(deps, staff(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/support/help/accounts/{id}/ai',
      tags: ptags,
      summary: "Set an account's help-assistant source (platform / own), monthly cap and lock",
      middleware: consoleMw,
      request: { params: idParam, ...jsonBody(updateAccountHelpAiByOwnerSchema) },
      responses: { 200: json(accountHelpAiDtoSchema, 'Account help AI'), ...common },
    }),
    async (c) =>
      c.json(await updateAccountHelpAiAsOwner(deps, staff(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  const categories = json(z.object({ categories: z.array(helpCategorySchema) }), 'Categories');
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/help/categories',
      tags: ptags,
      summary: 'Add a help category',
      middleware: consoleMw,
      request: jsonBody(upsertHelpCategorySchema),
      responses: { 200: categories, ...common },
    }),
    async (c) => c.json(await saveHelpCategory(deps, staff(c), null, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/support/help/categories/{id}',
      tags: ptags,
      summary: 'Change a help category (name, English name, icon, order, archived)',
      middleware: consoleMw,
      request: { params: idParam, ...jsonBody(upsertHelpCategorySchema) },
      responses: { 200: categories, ...common },
    }),
    async (c) => c.json(await saveHelpCategory(deps, staff(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/help/articles',
      tags: ptags,
      summary: 'Help articles (drafts too), newest change first',
      middleware: consoleMw,
      request: { query: helpArticleFilterSchema },
      responses: { 200: json(z.object({ data: z.array(helpArticleSummarySchema) }), 'Articles'), ...common },
    }),
    async (c) => c.json(await listHelpArticles(deps, staff(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/help/articles',
      tags: ptags,
      summary: 'Write a help article (a draft), or a translation of one',
      middleware: consoleMw,
      request: jsonBody(createHelpArticleSchema),
      responses: { 201: detail, ...common },
    }),
    async (c) => c.json(await createHelpArticle(deps, staff(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/help/articles/{id}',
      tags: ptags,
      summary: 'A help article: the working copy and its translations',
      middleware: consoleMw,
      request: { params: idParam },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await getHelpArticle(deps, staff(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/support/help/articles/{id}',
      tags: ptags,
      summary: 'Save a help article (a new title or content is a new version)',
      middleware: consoleMw,
      request: { params: idParam, ...jsonBody(updateHelpArticleSchema) },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await updateHelpArticle(deps, staff(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/support/help/articles/{id}',
      tags: ptags,
      summary: 'Delete a help article',
      middleware: consoleMw,
      request: { params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...common },
    }),
    async (c) => c.json(await deleteHelpArticle(deps, staff(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/help/articles/{id}/publish',
      tags: ptags,
      summary: 'Publish the working copy of a help article',
      middleware: consoleMw,
      request: { params: idParam },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await publishHelpArticle(deps, staff(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/help/articles/{id}/unpublish',
      tags: ptags,
      summary: 'Take a help article back to a draft',
      middleware: consoleMw,
      request: { params: idParam },
      responses: { 200: detail, ...common },
    }),
    async (c) => c.json(await unpublishHelpArticle(deps, staff(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/help/articles/{id}/versions',
      tags: ptags,
      summary: 'The versions of a help article',
      middleware: consoleMw,
      request: { params: idParam },
      responses: { 200: json(z.object({ data: z.array(helpArticleVersionSchema) }), 'Versions'), ...common },
    }),
    async (c) => c.json(await listHelpVersions(deps, staff(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/help/articles/{id}/versions/{versionId}/restore',
      tags: ptags,
      summary: 'Restore an old version of a help article (as a new version)',
      middleware: consoleMw,
      request: { params: versionParams },
      responses: { 200: detail, ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await restoreHelpVersion(deps, staff(c), p.id, p.versionId), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/support/tickets/{id}/article',
      tags: ptags,
      summary: 'Turn a solved ticket into a help article draft (personal details removed)',
      middleware: consoleMw,
      request: { params: idParam },
      responses: { 201: detail, ...common },
    }),
    async (c) => c.json(await articleFromTicket(deps, staff(c), c.req.valid('param').id), 201),
  );
  // ---- images & the package import / export (kb-import)
  /** The files of a multipart request (any field name). */
  const uploadedFiles = async (c: Context<AppEnv>): Promise<Upload[]> => {
    let form: Record<string, unknown>;
    try {
      form = await c.req.parseBody({ all: true });
    } catch {
      throw new AppError('invalid_value', 'help_import_bad_request');
    }
    const files = Object.values(form)
      .flat()
      .filter((v): v is File => typeof v === 'object' && v !== null && 'arrayBuffer' in v && 'name' in v);
    return Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })));
  };
  const multipart = (description: string) => ({
    body: {
      required: true,
      description,
      content: {
        'multipart/form-data': {
          schema: { type: 'object' as const, properties: { file: { type: 'string' as const, format: 'binary' } } },
        },
      },
    },
  });
  r.openapi(
    createRoute({
      method: 'post',
      path: HELP_ASSETS_PATH,
      tags: ptags,
      summary:
        'Upload a help file: an image (PNG / JPEG / WebP / GIF), a guide video (MP4 / WebM) or captions (WebVTT) — checked by content; same bytes stored once',
      middleware: consoleMw,
      request: multipart('`file`: the image, video or captions'),
      responses: { 201: json(helpAssetSchema, 'Image'), ...errors(400, 401, 403, 404, 413, 422) },
    }),
    async (c) => {
      const [file] = await uploadedFiles(c);
      if (!file) throw new AppError('invalid_value', 'help_image_missing');
      return c.json(await uploadHelpImage(deps, staff(c), file.bytes), 201);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: HELP_IMPORT_PATH,
      tags: ptags,
      summary: 'Import a knowledge package (.zip or .md files); `dry_run=1` previews without writing',
      middleware: consoleMw,
      request: {
        query: z.object({ dry_run: z.enum(['0', '1', 'true', 'false']).optional() }),
        ...multipart('One .zip, or .md files (with categories.json / screens.json / images)'),
      },
      responses: { 200: json(helpImportReportSchema, 'Report'), ...errors(400, 401, 403, 404, 413, 422) },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const dryRun = q.dry_run === '1' || q.dry_run === 'true';
      return c.json(await importHelpPackage(deps, staff(c), await uploadedFiles(c), dryRun), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/help/export',
      tags: ptags,
      summary: 'Download every article, category, screen tag and image as a knowledge package (.zip)',
      middleware: consoleMw,
      responses: {
        200: {
          description: 'The package',
          content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } },
        },
        ...common,
      },
    }),
    async (c) => {
      staff(c);
      const zip = await exportHelpPackage(deps);
      const day = new Date().toISOString().slice(0, 10);
      c.header('content-type', 'application/zip');
      c.header('content-disposition', `attachment; filename="help-center-${day}.zip"`);
      c.header('cache-control', 'no-store');
      return c.body(zip as Uint8Array<ArrayBuffer>, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/support/help/metrics',
      tags: ptags,
      summary: 'Knowledge center metrics: deflection, helpful yes / no, searches that found nothing',
      middleware: consoleMw,
      request: { query: z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }) },
      responses: { 200: json(helpMetricsSchema, 'Metrics'), ...common },
    }),
    async (c) => c.json(await helpMetrics(deps, staff(c), c.req.valid('query').days), 200),
  );

  // ---------------------------------------------------------------- inside an account
  const accountMw = [requireAccount(deps)];
  const atags = ['support'];
  const acommon = errors(400, 401, 403, 404, 422, 423, 429);
  const reader = (c: Context<AppEnv>): HelpReader & { accountId: string } => {
    const ctx = c.get('account');
    if (ctx.support) throw new AppError('forbidden', 'support_not_allowed');
    if (ctx.role === 'guest') throw new AppError('forbidden', 'help_not_for_guests');
    const user = currentUser(c);
    return { userId: user.id, accountId: ctx.accountId, locale: localeOf(user.locale) };
  };

  r.openapi(
    createRoute({
      method: 'get',
      path: '/support/help/options',
      tags: atags,
      summary: 'What the help panel offers: articles, the assistant (and why not), how many suggestions',
      middleware: accountMw,
      request: { headers: accountHeader },
      responses: { 200: json(helpOptionsSchema, 'Options'), ...acommon },
    }),
    async (c) => c.json(await helpOptions(deps, reader(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/support/help/search',
      tags: atags,
      summary: 'Search the help articles (or the articles for a screen when no words are given)',
      middleware: accountMw,
      request: { headers: accountHeader, query: helpSearchQuerySchema },
      responses: { 200: json(hitList, 'Articles'), ...acommon },
    }),
    async (c) => {
      const rd = reader(c);
      charge(c, searchLimiter, rd.userId!);
      return c.json(await searchHelp(deps, rd, c.req.valid('query')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/support/help/articles/{id}',
      tags: atags,
      summary: 'A published help article (by id or slug)',
      middleware: accountMw,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(helpArticleViewSchema, 'Article'), ...acommon },
    }),
    async (c) => c.json(await viewHelpArticle(deps, reader(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/support/help/articles/{id}/feedback',
      tags: atags,
      summary: '"Did this help?" on a help article',
      middleware: accountMw,
      request: { headers: accountHeader, params: idParam, ...jsonBody(helpFeedbackSchema) },
      responses: { 200: json(okSchema, 'Recorded'), ...acommon },
    }),
    async (c) => c.json(await helpFeedback(deps, reader(c), c.req.valid('param').id, c.req.valid('json').helpful), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/support/help/events',
      tags: atags,
      summary: 'Record a help outcome: found the answer (deflected) or opened a ticket after help',
      middleware: accountMw,
      request: { headers: accountHeader, ...jsonBody(helpEventSchema) },
      responses: { 200: json(okSchema, 'Recorded'), ...acommon },
    }),
    async (c) => c.json(await helpClientEvent(deps, reader(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/support/help/ask',
      tags: atags,
      summary: 'Ask the help assistant (answers only from published articles, with citations)',
      middleware: accountMw,
      request: { headers: accountHeader, ...jsonBody(helpAskSchema) },
      responses: { 200: json(helpAnswerSchema, 'Answer'), ...errors(400, 401, 403, 404, 422, 423, 429) },
    }),
    async (c) => {
      const rd = reader(c);
      charge(c, askLimiter, rd.userId!);
      return c.json(await askHelp(deps, rd, c.req.valid('json').question), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/support/help/ai-settings',
      tags: atags,
      summary: "The help assistant's AI connection for this account (admins)",
      middleware: accountMw,
      request: { headers: accountHeader },
      responses: { 200: json(accountHelpAiDtoSchema, 'Settings'), ...acommon },
    }),
    async (c) => {
      const ctx = c.get('account');
      return c.json(await getAccountHelpAi(deps, { accountId: ctx.accountId, role: ctx.role }), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/support/help/ai-settings',
      tags: atags,
      summary: "Choose the help assistant's AI connection: the platform's (capped) or the account's own (admins)",
      middleware: accountMw,
      request: { headers: accountHeader, ...jsonBody(updateAccountHelpAiSchema) },
      responses: { 200: json(accountHelpAiDtoSchema, 'Settings'), ...acommon },
    }),
    async (c) => {
      const ctx = c.get('account');
      if (ctx.support) throw new AppError('forbidden', 'support_not_allowed');
      return c.json(
        await updateAccountHelpAi(
          deps,
          { accountId: ctx.accountId, role: ctx.role, userId: currentUser(c).id },
          c.req.valid('json'),
        ),
        200,
      );
    },
  );

  // ---------------------------------------------------------------- the public help center
  const htags = ['help'];
  const hcommon = errors(404, 429);
  const anyone = (c: Context<AppEnv>, locale?: string): HelpReader => {
    charge(c, publicLimiter, c.get('user')?.id ?? `ip:${c.get('clientIp') ?? 'unknown'}`);
    const user = c.get('user');
    return {
      userId: user?.id ?? null,
      accountId: null,
      locale: localeOf(locale ?? user?.locale),
    };
  };
  const localeQuery = z.object({ locale: z.enum(HELP_LOCALES).optional() });

  r.openapi(
    createRoute({
      method: 'get',
      path: '/help/center',
      tags: htags,
      summary: 'The public help center: its name, logo and categories',
      request: { query: localeQuery },
      responses: { 200: json(helpCenterInfoSchema, 'Help center'), ...hcommon },
    }),
    async (c) => c.json(await helpCenterInfo(deps, anyone(c, c.req.valid('query').locale)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/help/articles',
      tags: htags,
      summary: 'Search the public help articles, or list a category',
      request: { query: helpSearchQuerySchema },
      responses: { 200: json(hitList, 'Articles'), ...hcommon },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(await searchHelp(deps, anyone(c, q.locale), { ...q, mode: q.mode ?? 'search' }), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/help/assets/{id}',
      tags: htags,
      summary: 'A file of a help article: a redirect to a short-lived link (captions: the WebVTT text itself)',
      request: { params: idParam },
      responses: {
        200: {
          description: 'Captions (WebVTT)',
          content: {
            'text/vtt': {
              schema: { type: 'string' },
              example: 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:04.000\nOpen the settings\n',
            },
          },
        },
        302: { description: 'Redirect to a short-lived signed URL' },
        ...hcommon,
      },
    }),
    async (c) => {
      charge(c, assetLimiter, `ip:${c.get('clientIp') ?? 'unknown'}`);
      c.header('cache-control', 'public, max-age=300');
      const found = await helpAssetLocation(deps, c.req.valid('param').id);
      if ('redirect' in found) return c.redirect(found.redirect, 302);
      c.header('content-type', found.type);
      c.header('x-content-type-options', 'nosniff');
      return c.body(found.text, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/help/articles/{slug}',
      tags: htags,
      summary: 'A public help article',
      request: {
        params: z.object({
          slug: z
            .string()
            .max(120)
            .openapi({ param: { name: 'slug', in: 'path' } }),
        }),
        query: localeQuery,
      },
      responses: { 200: json(helpArticleViewSchema, 'Article'), ...hcommon },
    }),
    async (c) => {
      const { locale } = c.req.valid('query');
      return c.json(await viewHelpArticle(deps, anyone(c, locale), c.req.valid('param').slug, locale), 200);
    },
  );

  return r;
};
