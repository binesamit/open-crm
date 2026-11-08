// SPDX-License-Identifier: AGPL-3.0-only
import { OpenAPIHono } from '@hono/zod-openapi';
import { bodyLimit } from 'hono/body-limit';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { AppError, HELP_IMPORT_LIMITS } from '@bines/shared';
import type { AppDeps, AppEnv } from './types';
import { requestId } from './middleware/request-id';
import { gzipJson } from './middleware/compress';
import { securityHeaders } from './middleware/security-headers';
import { errorHandler, notFoundHandler } from './middleware/error';
import { recordingErrorHandler } from './modules/errors/errors.capture';
import { errorRoutes } from './modules/errors/errors.routes';
import { supportAgentRoutes } from './modules/support-agent/support-agent.routes';
import { loadSession, requirePlatformOwner, requireUser } from './middleware/auth';
import { healthRoutes } from './modules/health/health.routes';
import { meRoutes } from './modules/me/me.routes';
import { phoneRoutes } from './modules/phone/phone.routes';
import { platformRoutes } from './modules/platform/platform.routes';
import { securityIncidentRoutes } from './modules/platform/security-incidents.routes';
import { costRoutes } from './modules/costs/costs.routes';
import { loginProviderRoutes } from './modules/platform/login-providers.routes';
import { supportRoutes } from './modules/support/support.routes';
import { ticketRoutes } from './modules/tickets/tickets.routes';
import { supportConsoleRoutes } from './modules/tickets/console.routes';
import { HELP_ASSETS_PATH, HELP_IMPORT_PATH, helpRoutes } from './modules/help/help.routes';
import { tourRoutes } from './modules/help/tours.routes';
import { checklistRoutes } from './modules/help/checklist.routes';
import { legalRoutes } from './modules/legal/legal.routes';
import { guidesRoutes } from './modules/guides/guides.routes';
import { senderRoutes } from './modules/senders/senders.routes';
import { billingRoutes } from './modules/billing/billing.routes';
import { licenseRoutes } from './modules/license/license.routes';
import { pwaRoutes } from './modules/pwa/pwa.routes';
import { pwaStatus } from './modules/pwa/pwa.service';
import { accountRoutes } from './modules/accounts/accounts.routes';
import { boardRoutes } from './modules/boards/boards.routes';
import { itemRoutes } from './modules/items/items.routes';
import { nameRoutes } from './modules/items/names.routes';
import { bulkEditRoutes } from './modules/bulk/bulk-edit.routes';
import { conversionRoutes } from './modules/conversions/conversions.routes';
import { updateRoutes } from './modules/updates/updates.routes';
import { fileRoutes } from './modules/files/files.routes';
import { timeRoutes } from './modules/time/time.routes';
import { viewRoutes } from './modules/views/views.routes';
import { automationRoutes } from './modules/automations/automations.routes';
import { automationTemplateRoutes } from './modules/automations/templates.routes';
import { tokenRoutes } from './modules/tokens/tokens.routes';
import { webhookRoutes } from './modules/webhooks/webhooks.routes';
import { inboundEmailRoutes } from './modules/inbound-email/inbound.routes';
import { integrationRoutes } from './modules/integrations/integrations.routes';
import { exportRoutes } from './modules/export/export.routes';
import { idempotency } from './middleware/idempotency';
import { trashRoutes } from './modules/trash/trash.routes';
import { archiveRoutes } from './modules/archive/archive.routes';
import { teamRoutes } from './modules/teams/teams.routes';
import { tagRoutes } from './modules/tags/tags.routes';
import { permissionRoutes } from './modules/boards/permissions.routes';
import { realtimeRoutes } from './modules/realtime/realtime.routes';
import { notificationRoutes } from './modules/notifications/notifications.routes';
import { myWorkRoutes } from './modules/mywork/mywork.routes';
import { navRoutes } from './modules/nav/nav.routes';
import { searchRoutes } from './modules/search/search.routes';
import { templateRoutes } from './modules/boards/board-copy.templates.routes';
import { docRoutes } from './modules/docs/docs.routes';
import { dashboardRoutes } from './modules/dashboards/dashboards.routes';
import { itemTemplateRoutes } from './modules/item-templates/item-templates.routes';
import { scenarioRoutes } from './modules/scenarios/scenarios.routes';
import { aiRoutes } from './modules/ai/ai.routes';
import { voiceRoutes } from './modules/voice/voice.routes';
import { agentRoutes } from './modules/agents/agents.routes';
import { ai2Routes } from './modules/ai2/ai2.routes';
import { mountMcp } from './modules/mcp/mcp.routes';
import { mountOauth, oauthApiRoutes } from './modules/oauth/oauth.routes';
import { mountWeb } from './web';
import { isDiskStorage, mountDiskFiles } from './lib/disk-storage';
import { setupRoutes } from './modules/setup/setup.routes';
import { signupRoutes } from './modules/signup/signup.routes';
import { firstStepsRoutes } from './modules/signup/first-steps.routes';
import { onboardingRoutes } from './modules/onboarding/onboarding.routes';
import { loadPlatformSettings, webPageNames } from './modules/platform/platform-settings';
import { mountApiDocs, productNameOf } from './modules/apidocs/apidocs.routes';
import type { OpenApiDoc } from './modules/apidocs/spec';
import { mapOrigins } from './modules/geo/geo.csp';
import { geoRoutes } from './modules/geo/geo.routes';
import { webSearchRoutes } from './modules/web-search/web-search.routes';
import { boardViewRoutes } from './modules/views/board-views.routes';
import { boardViewerRoutes } from './modules/board-viewers/board-viewers.routes';
import { extensionRoutes } from './modules/extensions/extensions.routes';
import { extRoutes } from './modules/extensions/ext.routes';
import { extensionServerRoutes } from './modules/extensions/extensions-server.routes';
import { mcpServerRoutes } from './modules/mcp-servers/mcp-servers.routes';
import { flowRoutes } from './modules/flows/flows.routes';
import { formRoutes } from './modules/forms/forms.routes';
import { idocRoutes } from './modules/idocs/idocs.routes';
import { secretRoutes } from './modules/secrets/secrets.routes';
import { accountDeletionRoutes } from './modules/account-deletion/account-deletion.routes';
import { formPagePolicy } from './modules/forms/forms.csp';
import { extensionCors, pageFrameOrigins } from './modules/extensions/ext-origins';
import { pricingCors } from './modules/billing/pricing.service';
import { clientIp, clientIpConfig, ipBucket, withResolvedIp } from './lib/client-ip';
import { publicAddress } from './modules/platform/public-address';
import { RateLimiter, rateLimit } from './lib/rate-limit';
import { authCaptchaGuard } from './modules/captcha/captcha.auth';
import { captchaRoutes } from './modules/captcha/captcha.routes';
import { authCaptchaConfig, platformCaptchaKeys } from './modules/captcha/captcha.service';

/** Largest JSON body the API reads (security review S-10). */
export const MAX_REQUEST_BYTES = 5 * 1024 * 1024;

/** The full OpenAPI document of an app (every route) — for the build-time export and tests, not served publicly. */
const fullDocs = new WeakMap<object, () => OpenApiDoc>();
export const fullOpenApiDocument = (app: object): OpenApiDoc => {
  const build = fullDocs.get(app);
  if (!build) throw new Error('not an app made by createApp');
  return build();
};

export const createApp = (deps: AppDeps, opts: { webDistDir?: string } = {}) => {
  const { env, logger, auth } = deps;

  // zod failures on any route become our 400 envelope instead of Hono's default body.
  const api = new OpenAPIHono<AppEnv>({
    defaultHook: (result) => {
      if (!result.success) {
        throw new AppError('validation_failed', 'Request validation failed', {
          issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }
    },
  });

  // No request body needs more than this (files go straight to storage): a huge body is refused before it is read.
  // The one exception: a knowledge package import (kb-import) carries its .zip / .md files in the request.
  const bodyCap = (maxSize: number) =>
    bodyLimit({
      maxSize,
      onError: () => {
        throw new AppError('payload_too_large', 'Request body too large');
      },
    });
  const defaultCap = bodyCap(MAX_REQUEST_BYTES);
  const importCap = bodyCap(HELP_IMPORT_LIMITS.requestBytes);
  // A guide's video travels in its upload request too.
  api.use('*', (c, next) =>
    (c.req.path.endsWith(HELP_IMPORT_PATH) || c.req.path.endsWith(HELP_ASSETS_PATH) ? importCap : defaultCap)(c, next),
  );
  api.use('*', loadSession(deps));
  api.use('*', idempotency(deps));
  api.route('/', healthRoutes);
  api.route('/', setupRoutes(deps));
  // Self sign-up (D32): off by default — every public route but its config answers 404 until the owner turns it on.
  api.route('/', signupRoutes(deps));
  api.route('/', firstStepsRoutes(deps));
  api.route('/', onboardingRoutes(deps));
  api.route('/', meRoutes(deps));
  api.route('/', platformRoutes(deps));
  api.route('/', securityIncidentRoutes(deps));
  api.route('/', costRoutes(deps));
  api.route('/', loginProviderRoutes(deps));
  api.route('/', accountRoutes(deps));
  api.route('/', boardRoutes(deps));
  api.route('/', templateRoutes(deps));
  api.route('/', itemRoutes(deps));
  api.route('/', nameRoutes(deps));
  api.route('/', bulkEditRoutes(deps));
  api.route('/', conversionRoutes(deps));
  api.route('/', updateRoutes(deps));
  api.route('/', phoneRoutes(deps));
  api.route('/', fileRoutes(deps));
  api.route('/', timeRoutes(deps));
  api.route('/', viewRoutes(deps));
  api.route('/', automationRoutes(deps));
  api.route('/', automationTemplateRoutes(deps));
  api.route('/', tokenRoutes(deps));
  api.route('/', webhookRoutes(deps));
  api.route('/', inboundEmailRoutes(deps));
  api.route('/', integrationRoutes(deps));
  api.route('/', exportRoutes(deps));
  api.route('/', trashRoutes(deps));
  api.route('/', archiveRoutes(deps));
  api.route('/', teamRoutes(deps));
  api.route('/', tagRoutes(deps));
  api.route('/', permissionRoutes(deps));
  api.route('/', realtimeRoutes(deps));
  api.route('/', notificationRoutes(deps));
  api.route('/', myWorkRoutes(deps));
  api.route('/', navRoutes(deps));
  api.route('/', searchRoutes(deps));
  api.route('/', docRoutes(deps));
  api.route('/', dashboardRoutes(deps));
  api.route('/', itemTemplateRoutes(deps));
  api.route('/', scenarioRoutes(deps));
  api.route('/', aiRoutes(deps));
  api.route('/', voiceRoutes(deps));
  api.route('/', oauthApiRoutes(deps));
  api.route('/', agentRoutes(deps));
  api.route('/', ai2Routes(deps));
  api.route('/', geoRoutes(deps));
  api.route('/', webSearchRoutes(deps));
  api.route('/', boardViewRoutes(deps));
  api.route('/', boardViewerRoutes(deps));
  api.route('/', extensionRoutes(deps));
  api.route('/', extRoutes(deps));
  api.route('/', extensionServerRoutes(deps));
  api.route('/', mcpServerRoutes(deps));
  api.route('/', flowRoutes(deps));
  api.route('/', formRoutes(deps));
  api.route('/', idocRoutes(deps));
  api.route('/', captchaRoutes(deps));
  api.route('/', supportRoutes(deps));
  api.route('/', ticketRoutes(deps));
  api.route('/', supportConsoleRoutes(deps));
  api.route('/', helpRoutes(deps));
  api.route('/', tourRoutes(deps));
  api.route('/', checklistRoutes(deps));
  api.route('/', legalRoutes(deps));
  api.route('/', guidesRoutes(deps));
  api.route('/', senderRoutes(deps));
  api.route('/', billingRoutes(deps));
  api.route('/', licenseRoutes(deps));
  api.route('/', pwaRoutes(deps));
  api.route('/', secretRoutes(deps));
  api.route('/', accountDeletionRoutes(deps));
  api.route('/', errorRoutes(deps));
  // Support agent: AI investigations of errors and tickets, for the owner console.
  api.route('/', supportAgentRoutes(deps));

  // Scripts and no-code tools (Make, n8n) authenticate with a personal API token (06 §1.2).
  api.openAPIRegistry.registerComponent('securitySchemes', 'apiToken', {
    type: 'http',
    scheme: 'bearer',
    description:
      'Personal API token `bos_pat_…` (profile menu → API tokens). Bound to one account; X-Account-Id optional.',
  });
  const docConfig = {
    openapi: '3.1.0',
    info: { title: `${productNameOf(env)} API`, version: 'v1' },
    security: [{ apiToken: [] }],
  };
  // The full document (every route, internal ones too — S-47) is for platform owners only; `/api/v1/openapi.json`
  // serves the public reference's document (mountApiDocs). Builds export it with `pnpm --filter @bines/api
  // openapi:export` (scripts/export-openapi.ts) — nothing needs it from a running server.
  api.get('/openapi.full.json', requireUser(), requirePlatformOwner(), (c) =>
    c.json(api.getOpenAPI31Document(docConfig)),
  );

  const app = new OpenAPIHono<AppEnv>();
  app.use('*', requestId());
  app.use('*', clientIp(clientIpConfig(env)));
  // gzip (perf review): large JSON answers (see gzipJson) and the SPA's assets. Event streams never.
  app.use('/api/*', gzipJson());
  // PWA (פ2): no API answer is ever stored — not by the browser, not by the service worker, not by a proxy.
  // Routes that choose their own caching (public icons, the email logo redirect) keep it.
  app.use('/api/*', async (c, next) => {
    await next();
    if (c.res.headers.has('cache-control')) return;
    try {
      c.res.headers.set('Cache-Control', 'no-store');
    } catch {
      c.res = new Response(c.res.body, c.res);
      c.res.headers.set('Cache-Control', 'no-store');
    }
  });
  app.use('/assets/*', compress());
  app.use(
    '*',
    securityHeaders(
      env,
      () => mapOrigins(deps.db),
      pageFrameOrigins(deps.db),
      formPagePolicy(deps.db),
      // Turnstile on the sign-in screens, or on the license server's registration page (licensing).
      async () =>
        !!(await authCaptchaConfig(deps.db)).site_key || !!(await platformCaptchaKeys(deps.db, 'registration')),
      async () => (await loadPlatformSettings(deps.db)).embedding.allowed_origins,
    ),
  );
  // Extension iframes (D27 ת2) call the API from their own origin with an extension token — never with cookies.
  app.use('/api/*', extensionCors(deps));
  // The public pricing JSON: the sites the owner lists may read it from a browser.
  app.use('/api/v1/public/pricing', pricingCors(deps));
  // The platform's own origins (M11): the public address set in the owner console, WEB_ORIGIN and the previous
  // addresses kept during a move — read per request, so a new domain needs no redeploy.
  app.use(
    '/api/*',
    cors({
      origin: async (o) => {
        const address = await publicAddress(deps);
        return address.accepted.includes(o) ? o : address.web;
      },
      credentials: true,
    }),
  );
  // Per client address, every API route (06 §1.10): a flood from one address cannot starve everyone else.
  if (env.RATE_LIMIT_IP_PER_10S > 0) {
    const perIp = new RateLimiter(env.RATE_LIMIT_IP_PER_10S, 10_000);
    app.use(
      '/api/*',
      rateLimit(perIp, (c) => ipBucket(c.get('clientIp'))),
    );
  }
  // Better Auth owns /api/auth/* (sign-in, sign-up, magic link, OAuth callbacks, sessions). It reads the client
  // address (its own rate limits, sessions) from the header we set — never from what the client sent (S-10).
  // Turnstile on the sign-in screens when the owner turned it on.
  app.use('/api/auth/*', authCaptchaGuard(deps));
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(withResolvedIp(c.req.raw, c.get('clientIp'))));
  // Files on the local disk (standalone mode): signed upload / download links, outside /api/v1's JSON body limit.
  if (isDiskStorage(deps.storage)) mountDiskFiles(app, deps.storage);
  app.route('/api/v1', api);
  // The public API reference (Scalar, served from this origin) — 06 §1.1.
  mountApiDocs(app, deps, {
    fullDoc: () => api.getOpenAPI31Document(docConfig) as unknown as OpenApiDoc,
    maxRequestBytes: MAX_REQUEST_BYTES,
  });
  // The MCP server (AI apps: Claude Code, Cursor …) — on the web origin, before the SPA fallback.
  // Its OAuth 2.1 authorization server (Claude.ai, ChatGPT): discovery documents and /oauth/* (מ5).
  mountOauth(app, deps);
  mountMcp(app, deps);
  fullDocs.set(app, () => api.getOpenAPI31Document(docConfig) as unknown as OpenApiDoc);
  if (opts.webDistDir)
    mountWeb(app, opts.webDistDir, {
      swEnabled: async () => (await pwaStatus(deps)).sw_enabled,
      pageNames: async (c) => webPageNames(await loadPlatformSettings(deps.db), c.req.header('accept-language')),
    });
  // Errors hub: unexpected 500s are recorded (source `code`) with the request id.
  app.onError(recordingErrorHandler(deps.db, errorHandler(logger)));
  app.notFound(notFoundHandler);
  return app;
};
