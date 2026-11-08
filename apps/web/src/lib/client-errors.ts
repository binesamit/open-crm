// SPDX-License-Identifier: AGPL-3.0-only
import type { ClientError, TicketContext } from '@bines/shared';

/**
 * A short ring buffer of the errors this tab saw: uncaught errors, unhandled promise rejections and
 * what the app's error boundaries report. A support ticket offers them as context — the person sees each one and
 * may remove it before sending. Messages are scrubbed of email addresses and URLs lose their query strings (same
 * rules as `monitoring.tsx`).
 * Errors hub (product decision 5): they are also sent automatically to the platform's support — a sample of
 * them (the share the owner console sets, learnt from the server's answer), each distinct message once per tab, in
 * small batches; the server scrubs again and limits per person. The owner can switch it off.
 */
const MAX = 20;
const buffer: ClientError[] = [];
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const scrub = (s: string) => s.replace(EMAIL, '[email]').slice(0, 500);
const stripQuery = (url: string) => url.split('?')[0]!.split('#')[0]!.slice(0, 300);

export const recordClientError = (error: unknown, area?: string) => {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : typeof error === 'string' ? error : String(error);
  if (!message.trim()) return;
  buffer.push({
    message: scrub(message),
    at: new Date().toISOString(),
    ...(typeof location !== 'undefined' ? { source: stripQuery(location.pathname) } : {}),
    ...(area ? { area: area.slice(0, 40) } : {}),
  });
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
  queueReport(buffer[buffer.length - 1]!);
};

// ---- automatic reports (errors hub) ----

/** At most this many distinct messages per tab and batch (the server's own limit per person is the real cap). */
const MAX_PER_TAB = 50;
const BATCH = 10;
const DELAY_MS = 5000;
const report = {
  /** null until the server answered once: the first error is always sent, then the owner's share. */
  sampleRate: null as number | null,
  enabled: true,
  seen: new Set<string>(),
  pending: [] as { message: string; source?: string; area?: string }[],
  timer: null as ReturnType<typeof setTimeout> | null,
  sender: null as ((body: unknown) => Promise<{ enabled: boolean; sample_rate: number }>) | null,
};

/** Where reports go (main.tsx wires the API client; tests a fake). Without one, nothing is sent. */
export const setClientErrorSender = (send: typeof report.sender) => {
  report.sender = send;
};

const accountSlugOf = (path: string) => /^\/a\/([a-z0-9-]{1,63})(\/|$)/.exec(path)?.[1];

const queueReport = (e: ClientError) => {
  if (!report.enabled || !report.sender || report.seen.size >= MAX_PER_TAB) return;
  if (report.seen.has(e.message)) return;
  report.seen.add(e.message);
  if (report.sampleRate !== null && Math.random() >= report.sampleRate) return;
  report.pending.push({
    message: e.message,
    ...(e.source ? { source: e.source } : {}),
    ...(e.area ? { area: e.area } : {}),
  });
  report.timer ??= setTimeout(() => void flushReports(), DELAY_MS);
};

/** Sends what is queued (the timer calls it). Failures are dropped quietly — never a new error. */
export const flushReports = async () => {
  report.timer = null;
  const errors = report.pending.splice(0, BATCH);
  if (!errors.length || !report.sender) return;
  try {
    const slug = typeof location !== 'undefined' ? accountSlugOf(location.pathname) : undefined;
    const res = await report.sender({ errors, ...(slug ? { account_slug: slug } : {}) });
    report.enabled = res.enabled;
    report.sampleRate = res.sample_rate;
  } catch {
    // Signed out, offline, or the server said no: stop for this tab.
    report.enabled = false;
  }
  if (report.pending.length && report.enabled) report.timer = setTimeout(() => void flushReports(), DELAY_MS);
};

/** The newest errors last, at most `max`. */
export const recentClientErrors = (max = 10): ClientError[] => buffer.slice(-max);

let installed = false;
/** Listens to the window's uncaught errors and rejections (once per tab; main.tsx). */
export const installClientErrorBuffer = () => {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => recordClientError(e.error ?? e.message, 'window'));
  window.addEventListener('unhandledrejection', (e) => recordClientError(e.reason, 'promise'));
};

/** Browser and OS names from the user agent (best effort, for the ticket's context). */
export const describeAgent = (ua: string) => {
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[1] !== undefined
      ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}`
      : /Firefox\/(\d+)/.test(ua)
        ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}`
        : /Chrome\/(\d+)/.test(ua)
          ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}`
          : /Version\/(\d+).*Safari/.test(ua)
            ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}`
            : 'other';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Android/.test(ua)
          ? 'Android'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'other';
  return { browser, os };
};

/** Everything the ticket form may offer to attach, before the person removes what they do not want to send. */
export const collectTicketContext = (maxErrors: number): Required<Omit<TicketContext, 'app_version'>> => {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const { browser, os } = describeAgent(ua);
  return {
    page_url: typeof location !== 'undefined' ? stripQuery(location.href) : '',
    user_agent: ua.slice(0, 500),
    browser,
    os,
    screen: typeof window !== 'undefined' ? `${window.innerWidth}×${window.innerHeight}` : '',
    errors: recentClientErrors(maxErrors),
  };
};
