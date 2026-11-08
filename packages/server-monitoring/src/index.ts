// SPDX-License-Identifier: AGPL-3.0-only
import * as Sentry from '@sentry/node';
import { scrubSecrets } from '@bines/shared';

/**
 * Error monitoring (roadmap ס4) for the api AND the worker — one copy, so both scrub the same way (audit 2026-10-10,
 * duplication #1: the worker's old copy masked emails but not credentials). GlitchTip speaks the Sentry protocol, so
 * the official Sentry SDK reports to it. Off unless SENTRY_DSN is set — locally and in tests nothing is sent and every
 * function here is a no-op. Errors only: no tracing (tracesSampleRate 0), no request bodies, cookies, auth headers,
 * query strings, emails or credentials (CLAUDE.md rule 10).
 */
export type MonitoringEnv = {
  SENTRY_DSN?: string;
  /** Overrides the environment name; default = Railway's environment name (production/staging), else NODE_ENV. */
  SENTRY_ENVIRONMENT?: string;
  RAILWAY_ENVIRONMENT_NAME?: string;
  RAILWAY_GIT_COMMIT_SHA?: string;
  NODE_ENV?: string;
};

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
// Credentials in a message or an exception text are masked too (AI-RT7), then emails.
const scrubText = (s: string | undefined) => (s ? scrubSecrets(s).replace(EMAIL, '[email]') : s);
/** Keeps a URL's origin and path; a query string can carry tokens or search terms. */
const stripQuery = (url: string | undefined) => (url ? url.split('?')[0] : url);

/** Removes personal data and credentials from an event before it leaves the process (exported for tests). */
export const scrubEvent = <E extends Sentry.Event>(event: E): E => {
  if (event.request) {
    const { method, url } = event.request;
    const ua = event.request.headers?.['user-agent'];
    event.request = { method, url: stripQuery(url), ...(ua ? { headers: { 'user-agent': ua } } : {}) };
  }
  // Only an opaque id may identify the user; no email, name or IP.
  event.user = event.user?.id ? { id: event.user.id } : undefined;
  event.message = scrubText(event.message);
  for (const ex of event.exception?.values ?? []) ex.value = scrubText(ex.value);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .filter((b) => b.category !== 'console')
      .map((b) => ({
        ...b,
        message: scrubText(b.message),
        data: b.data?.url ? { ...b.data, url: stripQuery(String(b.data.url)) } : undefined,
      }));
  }
  delete event.extra;
  return event;
};

/** Starts the SDK when SENTRY_DSN is set; returns whether it did. Call once, before the app starts. */
export const initMonitoring = (env: MonitoringEnv, service: 'api' | 'worker'): boolean => {
  if (!env.SENTRY_DSN) return false;
  Sentry.init({
    dsn: env.SENTRY_DSN,
    release: env.RAILWAY_GIT_COMMIT_SHA || undefined,
    environment: env.SENTRY_ENVIRONMENT || env.RAILWAY_ENVIRONMENT_NAME || env.NODE_ENV || 'development',
    serverName: service,
    initialScope: { tags: { service } },
    // Collect nothing personal (SDK v11 'dataCollection', formerly sendDefaultPii: false); beforeSend scrubs the rest.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
    },
    tracesSampleRate: 0,
    maxBreadcrumbs: 30,
    integrations: (defaults) => [
      ...defaults.filter((i) => i.name !== 'OnUnhandledRejection'),
      // Keep Node's behaviour: an unhandled rejection is reported, then the process exits (Railway restarts it).
      Sentry.onUnhandledRejectionIntegration({ mode: 'strict' }),
    ],
    beforeSend: (event) => scrubEvent(event),
  });
  return true;
};

/** Reports an error (no-op when monitoring is off), with tags that let it be matched with the logs. */
export const captureError = (err: unknown, tags: Record<string, string | undefined> = {}) => {
  if (!Sentry.isInitialized()) return;
  Sentry.captureException(err, { tags: { ...tags } });
};

/** Sends what is queued before the process exits. */
export const closeMonitoring = async (timeoutMs = 2000) => {
  if (Sentry.isInitialized()) await Sentry.close(timeoutMs);
};
