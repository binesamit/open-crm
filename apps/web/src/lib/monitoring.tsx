// SPDX-License-Identifier: AGPL-3.0-only
import * as Sentry from '@sentry/react';
import { recordClientError } from './client-errors';

/**
 * Error monitoring (roadmap ס4): GlitchTip, which speaks the Sentry protocol. The DSN is baked in at build time
 * (VITE_SENTRY_DSN); without it nothing is sent. Errors only — no tracing, no session replay, no user data:
 * no emails, no request bodies, no query strings, no console breadcrumbs. The page's CSP allows the DSN's origin
 * (apps/api/src/middleware/security-headers.ts).
 */
export type WebMonitoringEnv = {
  VITE_SENTRY_DSN?: string;
  VITE_SENTRY_ENVIRONMENT?: string;
  VITE_SENTRY_RELEASE?: string;
  MODE?: string;
};

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const scrubText = (s: string | undefined) => (s ? s.replace(EMAIL, '[email]') : s);
const stripQuery = (url: string | undefined) => (url ? url.split('?')[0] : url);

/** Removes personal data from an event before it is sent (exported for tests). */
export const scrubEvent = <E extends Sentry.Event>(event: E): E => {
  if (event.request) event.request = { url: stripQuery(event.request.url) };
  event.user = event.user?.id ? { id: event.user.id } : undefined;
  event.message = scrubText(event.message);
  for (const ex of event.exception?.values ?? []) ex.value = scrubText(ex.value);
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs
      .filter((b) => b.category !== 'console' && !b.category?.startsWith('ui.'))
      .map((b) => ({
        ...b,
        message: scrubText(b.message),
        data: b.data?.url ? { ...b.data, url: stripQuery(String(b.data.url)) } : undefined,
      }));
  }
  delete event.extra;
  return event;
};

/** Starts the SDK when a DSN was built in; returns whether it did. */
export const initMonitoring = (env: WebMonitoringEnv = import.meta.env): boolean => {
  if (!env.VITE_SENTRY_DSN) return false;
  Sentry.init({
    dsn: env.VITE_SENTRY_DSN,
    release: env.VITE_SENTRY_RELEASE || undefined,
    environment: env.VITE_SENTRY_ENVIRONMENT || env.MODE || 'production',
    initialScope: { tags: { service: 'web' } },
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
    beforeSend: (event) => scrubEvent(event),
  });
  return true;
};

/** Errors already sent — the route's `onCatch` and the error screen both see the same one (round 12). */
const reported = new WeakSet<object>();

/**
 * Reports an error caught by a boundary (the router's, an area's); no-op when monitoring is off. `area` tags where
 * it happened (item card, a view, a widget…). Each error object is sent once.
 */
export const reportError = (error: unknown, area?: string) => {
  // The support ticket form offers the tab's recent errors (lib/client-errors.ts), with or without monitoring.
  recordClientError(error, area);
  if (!Sentry.isInitialized()) return;
  if (error && typeof error === 'object') {
    if (reported.has(error)) return;
    reported.add(error);
  }
  Sentry.captureException(error, area ? { tags: { area } } : undefined);
};
