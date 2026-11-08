// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type FlowConnectionSettings, type FlowLimit } from '@bines/shared';
import { type FlowHttp, type FlowHttpResponse, remoteMessage } from './adapters/types';

/**
 * Frugal platform calls (Make answers 429 "Requests limit for organization exceeded" past its
 * per-organization per-minute quota, and the flows list, the runs drawer, the failure check and flow automations all
 * draw from that one quota). Per connection, in this process (the api runs as one instance):
 * - **backoff** — after a 429 no call goes out on any path until the platform's reset time (`Retry-After` /
 *   `X-RateLimit-Reset` / `RateLimit-Reset`, else the connection's `backoff_default_seconds`);
 * - **budget** — a token bucket of `max_calls_per_minute`; background work (the failure check, the list's stats) may
 *   use only `background_share_percent` of it, so a person opening a flow still gets through;
 * - **pacing** — background calls start at least `stats_pacing_ms` apart;
 * - **cache** — answers kept for the connection's `cache_*_seconds`;
 * **slowing down** — the platform's limit is the customer's whole account, shared with every other
 *   system that calls it, which we cannot see. So a 429 also halves this connection's per-minute budget (down to a
 *   tenth), and each quiet minute after that gives back a tenth of it: we make room for the other caller instead of
 *   racing it. A platform that says how many calls are left (`X-RateLimit-Remaining` / `RateLimit-Remaining`, with a
 *   reset time) is not called again at the last one until that reset. No platform's own headers are assumed — only
 *   what an answer actually carries is read.
 * Every limit is the admin's setting (connection settings), none is fixed here.
 */

let clock: () => number = () => Date.now();
let sleeper: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
/** Tests: a controllable clock (null = the real one). */
export const setFlowClockForTests = (fn: (() => number) | null) => {
  clock = fn ?? (() => Date.now());
};
/** Tests: a sleep that does not wait (null = the real one). */
export const setFlowSleepForTests = (fn: ((ms: number) => Promise<void>) | null) => {
  sleeper = fn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
};
export const flowNow = () => clock();

type State = {
  tokens: number;
  refilledAt: number;
  backoffUntil: number;
  reason: string | null;
  /** The earliest start of the next background call (pacing). */
  nextBackgroundAt: number;
  /** The share of the per-minute budget in use now: 1, or less after the platform's 429 (slowing down). */
  pace: number;
  /** From when the next quiet minute gives some of the pace back. */
  paceSince: number;
  /** The connection's per-minute setting, as last seen (to say how slow it is now). */
  perMinute: number;
};
const states = new Map<string, State>();
const stateOf = (id: string, capacity: number, now = clock()): State => {
  let s = states.get(id);
  if (!s) {
    s = {
      tokens: capacity,
      refilledAt: now,
      backoffUntil: 0,
      reason: null,
      nextBackgroundAt: 0,
      pace: 1,
      paceSince: now,
      perMinute: capacity,
    };
    states.set(id, s);
  }
  s.perMinute = capacity;
  return s;
};

/** Slowing down: a 429 halves the pace, never below this share … */
const MIN_PACE = 0.1;
/** … and every quiet minute after it gives this much back. */
const PACE_STEP = 0.1;

/** The calls per minute this connection may make now: its setting × the pace (a quiet minute gives some back first). */
const callsPerMinuteNow = (s: State, perMinute: number, now: number) => {
  if (s.pace < 1 && now >= s.backoffUntil) {
    const minutes = Math.floor((now - Math.max(s.paceSince, s.backoffUntil)) / 60_000);
    if (minutes > 0) {
      s.pace = Math.min(1, s.pace + minutes * PACE_STEP);
      s.paceSince = Math.max(s.paceSince, s.backoffUntil) + minutes * 60_000;
    }
  }
  return Math.max(1, Math.floor(perMinute * s.pace));
};

/** Slowed down after the platform's 429: the calls per minute for now (null = at the setting's full pace). */
export const flowSlowedTo = (id: string): number | null => {
  const s = states.get(id);
  if (!s) return null;
  const now = callsPerMinuteNow(s, s.perMinute, clock());
  return s.pace < 1 ? now : null;
};

export type FlowBudget = Pick<
  FlowConnectionSettings,
  'max_calls_per_minute' | 'background_share_percent' | 'stats_pacing_ms' | 'backoff_default_seconds'
>;

/** Is the connection in a platform backoff? (`null` = free to call.) */
export const flowBackoff = (id: string): { until: number; reason: string | null } | null => {
  const s = states.get(id);
  return s && s.backoffUntil > clock() ? { until: s.backoffUntil, reason: s.reason } : null;
};

/** The connection's current limit, as the API shows it. */
export const flowLimitOf = (id: string): FlowLimit | null => {
  const b = flowBackoff(id);
  return b
    ? { until: new Date(b.until).toISOString(), by: 'platform', reason: b.reason, slowed_to: flowSlowedTo(id) }
    : null;
};

const backoffError = (until: number, reason: string | null) =>
  new AppError('rate_limited', 'flow_platform_backoff', {
    status: 429,
    retry_at: new Date(until).toISOString(),
    retry_after_ms: Math.max(0, until - clock()),
    ...(reason ? { remote_message: reason } : {}),
  });

/** Our own refusal or the platform's 429: the rest of a pass would only meet it again. */
export const isFlowRateLimited = (err: unknown) =>
  err instanceof AppError && (err.code === 'rate_limited' || err.details?.status === 429);

/**
 * The limit an error says (backoff / budget), for an answer that shows it instead of failing. The platform's 429 is
 * read as the connection's backoff (its reset time from the headers).
 */
export const limitFromError = (err: unknown, connectionId: string): FlowLimit | null => {
  if (!(err instanceof AppError) || !isFlowRateLimited(err)) return null;
  if (err.message !== 'flow_calls_per_minute') {
    const backoff = flowLimitOf(connectionId);
    if (backoff) return backoff;
  }
  const at = typeof err.details?.retry_at === 'string' ? err.details.retry_at : null;
  const reason = typeof err.details?.remote_message === 'string' ? err.details.remote_message : null;
  const slowed_to = flowSlowedTo(connectionId);
  if (err.message === 'flow_calls_per_minute')
    return { until: at ?? new Date(clock() + 60_000).toISOString(), by: 'budget', reason: null, slowed_to };
  return { until: at ?? new Date(clock() + 60_000).toISOString(), by: 'platform', reason, slowed_to };
};

/**
 * When the platform lets us call again, from a 429's headers: `Retry-After` (seconds or a date), `X-RateLimit-Reset` /
 * `RateLimit-Reset` (seconds from now, or an epoch in seconds / ms). Null = it did not say. Capped at one hour.
 */
export const resetFromHeaders = (headers: FlowHttpResponse['headers'], now = clock()): number | null => {
  if (!headers) return null;
  const get = (k: string) => header(headers, k);
  const cap = (t: number) => Math.min(t, now + 60 * 60_000);
  const retry = get('retry-after');
  if (retry) {
    const n = Number(retry);
    if (Number.isFinite(n) && n >= 0) return cap(now + n * 1000);
    const d = Date.parse(retry);
    if (!Number.isNaN(d)) return cap(Math.max(now, d));
  }
  for (const k of ['x-ratelimit-reset', 'ratelimit-reset', 'x-rate-limit-reset']) {
    const n = Number(get(k));
    if (!get(k) || !Number.isFinite(n) || n < 0) continue;
    if (n > 1e12) return cap(Math.max(now, n));
    if (n > 1e9) return cap(Math.max(now, n * 1000));
    return cap(now + n * 1000);
  }
  return null;
};

/**
 * The platform said 429: nobody calls it on this connection until its reset, and the connection slows down — half its
 * pace (once per 429 episode: calls already on their way when it came do not halve it again), its bucket emptied.
 */
export const noteFlowRateLimited = (id: string, budget: FlowBudget, res: FlowHttpResponse) => {
  const now = clock();
  const until = resetFromHeaders(res.headers, now) ?? now + budget.backoff_default_seconds * 1000;
  let remote: string | null = null;
  try {
    remote = remoteMessage(res.body ? JSON.parse(res.body) : null);
  } catch {
    remote = res.body?.slice(0, 200) || null;
  }
  const s = stateOf(id, budget.max_calls_per_minute, now);
  if (s.backoffUntil <= now) {
    s.pace = Math.max(MIN_PACE, s.pace / 2);
    s.paceSince = now;
    s.tokens = 0;
    s.refilledAt = now;
  }
  s.backoffUntil = Math.max(s.backoffUntil, until);
  s.reason = `flow_platform_error (429)${remote ? `: ${remote}` : ''}`.slice(0, 300);
};

/** A header of an answer, any case (the first value of a repeated one). */
const header = (headers: FlowHttpResponse['headers'], name: string) => {
  const v = headers ? Object.entries(headers).find(([h]) => h.toLowerCase() === name)?.[1] : undefined;
  return Array.isArray(v) ? v[0] : v;
};

/**
 * An answer that says how many calls are left for now (`X-RateLimit-Remaining` / `RateLimit-Remaining` /
 * `X-Rate-Limit-Remaining`) and when that resets: at the last one, nobody calls until the reset — the account's other
 * users get there too. An answer without those headers changes nothing.
 */
export const noteFlowQuota = (id: string, budget: FlowBudget, res: FlowHttpResponse) => {
  const raw = ['x-ratelimit-remaining', 'ratelimit-remaining', 'x-rate-limit-remaining']
    .map((k) => header(res.headers, k))
    .find((v) => v !== undefined && v !== '');
  const left = Number(raw);
  if (raw === undefined || !Number.isFinite(left) || left > 1) return;
  const now = clock();
  const until = resetFromHeaders(res.headers, now);
  if (!until || until <= now) return;
  const s = stateOf(id, budget.max_calls_per_minute, now);
  s.backoffUntil = Math.max(s.backoffUntil, until);
  s.reason = 'flow_platform_quota_used';
};

/**
 * One call from the per-minute bucket. Returns 0 when taken, else how long until one is free. Background callers
 * leave the person's share (100 − `background_share_percent` %) untouched.
 */
export const takeFlowCall = (id: string, budget: FlowBudget, background: boolean, now = clock()): number => {
  const s = stateOf(id, budget.max_calls_per_minute, now);
  // Slowed down after a 429: the bucket is that much smaller and fills that much slower.
  const cap = callsPerMinuteNow(s, budget.max_calls_per_minute, now);
  const perMs = cap / 60_000;
  s.tokens = Math.min(cap, s.tokens + (now - s.refilledAt) * perMs);
  s.refilledAt = now;
  // Background: at least one token must stay above the person's reserve.
  const floor = background ? cap * (1 - budget.background_share_percent / 100) : 0;
  if (s.tokens - 1 >= floor - 1e-9) {
    s.tokens -= 1;
    return 0;
  }
  return Math.ceil((floor + 1 - s.tokens) / perMs);
};

/** Longest a person's call waits for a free slot in the bucket before it is refused (one slot at the set pace). */
const maxWaitMs = (perMinute: number) => Math.min(10_000, Math.ceil(60_000 / perMinute));

/**
 * The transport every adapter of a connection uses: refused while in backoff, metered by the bucket, paced in the
 * background, and a 429 starts the backoff for every path.
 */
export const guardedFlowHttp =
  (id: string, budget: FlowBudget, inner: FlowHttp, background: boolean): FlowHttp =>
  async (req) => {
    const b = flowBackoff(id);
    if (b) throw backoffError(b.until, b.reason);
    const refused = (wait: number) =>
      new AppError('rate_limited', 'flow_calls_per_minute', {
        retry_after_ms: wait,
        retry_at: new Date(clock() + wait).toISOString(),
        limit: flowSlowedTo(id) ?? budget.max_calls_per_minute,
      });
    let wait = takeFlowCall(id, budget, background);
    if (wait > 0) {
      if (background || wait > maxWaitMs(flowSlowedTo(id) ?? budget.max_calls_per_minute)) throw refused(wait);
      await sleeper(wait);
      wait = takeFlowCall(id, budget, background);
      if (wait > 0) throw refused(wait);
    }
    if (background && budget.stats_pacing_ms > 0) {
      const s = stateOf(id, budget.max_calls_per_minute);
      const now = clock();
      const at = Math.max(now, s.nextBackgroundAt);
      s.nextBackgroundAt = at + budget.stats_pacing_ms;
      if (at > now) await sleeper(at - now);
      // Slept into a backoff another path started meanwhile: do not call.
      const after = flowBackoff(id);
      if (after) throw backoffError(after.until, after.reason);
    }
    const res = await inner(req);
    if (res.status === 429) noteFlowRateLimited(id, budget, res);
    else noteFlowQuota(id, budget, res);
    return res;
  };

const refreshedAt = new Map<string, number>();
/**
 * "Refresh" asks the platform again at most once per `refresh_min_seconds` per connection and screen part (`what`);
 * true = this refresh may.
 */
export const mayRefresh = (connectionId: string, what: string, minSeconds: number, now = clock()) => {
  const key = cacheKey(connectionId, what);
  const last = refreshedAt.get(key);
  if (last !== undefined && now - last < minSeconds * 1000) return false;
  refreshedAt.set(key, now);
  return true;
};

// ---- which flows a walk read last (a pass cut short by the budget goes on where it stopped next time) ----

const readAt = new Map<string, Map<string, number>>();
export const noteFlowRead = (connectionId: string, flowId: string) => {
  let m = readAt.get(connectionId);
  if (!m) readAt.set(connectionId, (m = new Map()));
  m.set(flowId, clock());
};
/** The flows, least recently read first (never read: first, in their own order). */
export const leastRecentlyRead = <T extends { id: string }>(connectionId: string, flows: T[]): T[] => {
  const m = readAt.get(connectionId);
  if (!m) return flows;
  return flows
    .map((f, i) => ({ f, i, at: m.get(f.id) ?? -1 }))
    .sort((x, y) => x.at - y.at || x.i - y.i)
    .map((x) => x.f);
};

// ---- the answers kept per connection ----

type Entry = { at: number; value: unknown };
const cache = new Map<string, Entry>();
/** Entries older than this go on the next sweep, whatever the TTL (a stale answer is still shown in a backoff). */
const MAX_KEEP_MS = 24 * 60 * 60_000;
const MAX_ENTRIES = 20_000;

export const cacheKey = (connectionId: string, ...parts: string[]) => [connectionId, ...parts].join('\u0001');

/** The kept answer if younger than `ttlSeconds` (0 = never kept). */
export const cacheGet = <T>(key: string, ttlSeconds: number): { at: number; value: T } | null => {
  const e = cache.get(key);
  if (!e || ttlSeconds <= 0 || clock() - e.at > ttlSeconds * 1000) return null;
  return e as { at: number; value: T };
};
/** The kept answer of any age (shown while the platform cannot be asked). */
export const cachePeek = <T>(key: string): { at: number; value: T } | null =>
  (cache.get(key) as { at: number; value: T } | undefined) ?? null;

export const cacheSet = (key: string, value: unknown) => {
  if (cache.size >= MAX_ENTRIES) {
    const now = clock();
    for (const [k, e] of cache) if (now - e.at > MAX_KEEP_MS) cache.delete(k);
    while (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, { at: clock(), value });
};

/** Forget a connection's answers (a flow switched, a run retried, the target changed). */
export const cacheDrop = (connectionId: string) => {
  const prefix = `${connectionId}\u0001`;
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
};

/** Forget everything about a connection: answers, budget and backoff (its key or address changed, or it was removed). */
export const resetFlowConnection = (connectionId: string) => {
  cacheDrop(connectionId);
  states.delete(connectionId);
  readAt.delete(connectionId);
  const prefix = cacheKey(connectionId, '');
  for (const k of refreshedAt.keys()) if (k.startsWith(prefix)) refreshedAt.delete(k);
};
