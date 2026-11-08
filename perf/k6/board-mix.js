// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Mixed load of 50 concurrent users (12-ROADMAP ס3, docs/PERFORMANCE-REVIEW.md) against an account made by
 * `pnpm --filter @bines/api perf:seed` (~100k items). Every virtual user is one of the seeded users (session
 * cookie from email + password sign-in) and loops over weighted actions with think time:
 *   open board (board + views + update counts + all items, as the web does) · filtered / sorted / searched
 *   items query · open an item card · edit a cell · post an update · My Work · global search · inbox.
 * A second scenario holds one board event stream (SSE) open per user for the whole run.
 *
 * Run (Docker, from the repo root; Git Bash needs MSYS_NO_PATHCONV=1):
 *   docker run --rm -v "$PWD/perf:/perf" grafana/k6 run /perf/k6/board-mix.js \
 *     -e CONFIG=/perf/.perf-perf100k.json -e BASE=http://host.docker.internal:3100 -e DURATION=3m
 * Other knobs: VUS (default: one per seeded user), SSE=0 (no streams), OPEN_BIG=0 (never open a 20k+ board),
 * LABEL (result file name), ORIGIN (default: BASE when it is not local, else http://localhost:5173), SETUP_TIMEOUT.
 * Against a deployed server (staging): sign-in is rate-limited (10 a minute per address), so setup waits out each
 * 429 — 50 users take ~5 minutes: pass SETUP_TIMEOUT=600s. The session cookie there is `__Secure-bos.session_token`.
 * Results: summary on stdout + perf/results/board-mix-<label>.json (LABEL env).
 */
/* global open, __ENV, __VU -- k6 runtime globals */
import http from 'k6/http';
import { check, fail, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const config = JSON.parse(open(__ENV.CONFIG || '/perf/.perf-perf100k.json'));
const BASE = __ENV.BASE || config.base;
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|host\.docker\.internal)(:|\/|$)/.test(BASE);
const ORIGIN = __ENV.ORIGIN || (LOCAL ? 'http://localhost:5173' : BASE.replace(/\/+$/, ''));
const DURATION = __ENV.DURATION || '3m';
const VUS = Number(__ENV.VUS || config.users.length);
const LABEL = __ENV.LABEL || 'run';
const SSE = (__ENV.SSE || '1') === '1';
/** OPEN_BIG=0: "open board" skips the boards of 20k+ items (isolates their cost from the rest of the mix). */
const OPEN_BIG = (__ENV.OPEN_BIG || '1') === '1';
const OPENABLE = OPEN_BIG ? config.boards : config.boards.filter((b) => b.items < 20000);

/** Time to open a board as the user sees it: the four requests in parallel, slowest wins. */
const boardOpen = new Trend('board_open_ms', true);

const NAMES = [
  'board',
  'views',
  'update_counts',
  'items_all',
  'items_all_big',
  'sub_items_all',
  'query_filter',
  'query_search',
  'query_person',
  'item',
  'item_updates',
  'item_activity',
  'my_work',
  'search',
  'inbox_count',
  'notifications',
  'set_cell',
  'post_update',
];
const WRITES = new Set(['set_cell', 'post_update']);

export const options = {
  scenarios: {
    users: { executor: 'constant-vus', vus: VUS, duration: DURATION, exec: 'user', gracefulStop: '30s' },
    ...(SSE
      ? {
          streams: {
            executor: 'constant-vus',
            vus: VUS,
            duration: DURATION,
            exec: 'stream',
            gracefulStop: '5s',
          },
        }
      : {}),
  },
  thresholds: {
    'http_req_duration{kind:read}': ['p(95)<300'],
    'http_req_duration{kind:write}': ['p(95)<500'],
    'http_req_failed{kind:read}': ['rate<0.01'],
    'http_req_failed{kind:write}': ['rate<0.01'],
    board_open_ms: ['p(95)<1000'],
    // Listed so the summary shows p95 per endpoint (not pass/fail gates).
    ...Object.fromEntries(NAMES.map((n) => [`http_req_duration{name:${n}}`, ['p(95)<100000']])),
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
  setupTimeout: __ENV.SETUP_TIMEOUT || '120s',
};

const headers = (cookie, json) => ({
  cookie,
  origin: ORIGIN,
  'x-account-id': config.account_id,
  'accept-encoding': 'gzip',
  ...(json ? { 'content-type': 'application/json' } : {}),
});
const params = (cookie, name, json = false) => ({
  headers: headers(cookie, json),
  tags: { name, kind: WRITES.has(name) ? 'write' : 'read' },
  timeout: '60s',
});

export function setup() {
  const cookies = config.users.slice(0, VUS).map((email) => {
    for (let attempt = 1; ; attempt++) {
      const res = http.post(`${BASE}/api/auth/sign-in/email`, JSON.stringify({ email, password: config.password }), {
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        tags: { name: 'sign_in', kind: 'setup' },
      });
      // Sign-in is rate-limited per address on a deployed server: wait as told and try again.
      if (res.status === 429 && attempt <= 20) {
        const wait = Number(res.headers['X-Retry-After'] || res.headers['Retry-After']) || 10;
        sleep(Math.min(Math.max(wait, 1), 65));
        continue;
      }
      // Plain `bos.session_token` locally; `__Secure-bos.session_token` behind https in production mode.
      const name = Object.keys(res.cookies).find((n) => n.endsWith('bos.session_token'));
      const c = name && res.cookies[name];
      if (!c || !c.length) fail(`sign-in failed for ${email}: ${res.status}`);
      return `${name}=${c[0].value}`;
    }
  });
  return { cookies };
}

const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
const WORDS = ['Acme', 'Globex', 'חיפה', 'שדרוג', 'Initech', 'אתר', 'קמפיין', 'renewal', 'מנוי', 'Hooli'];
// Per-VU memory of item ids seen (k6 keeps module state per VU).
const known = {};

const body = (res) => {
  try {
    return res.json();
  } catch {
    return null;
  }
};

const queryItems = (cookie, board, q, name) => {
  const res = http.post(
    `${BASE}/api/v1/boards/${board.id}/items/query`,
    JSON.stringify({ limit: 50, ...q }),
    params(cookie, name, true),
  );
  check(res, { [`${name} 200`]: (r) => r.status === 200 });
  const data = body(res);
  if (data && data.data && data.data.length) known[board.id] = data.data.map((i) => i.id);
  return res;
};

const itemOf = (cookie, board) => {
  if (!known[board.id]) queryItems(cookie, board, { sort: [{ column_id: 'due', direction: 'desc' }] }, 'query_filter');
  return known[board.id] ? pick(known[board.id]) : null;
};

const actions = [
  [
    10,
    function openBoard(cookie) {
      const board = pick(OPENABLE);
      const big = board.items >= 20000;
      const t = Date.now();
      const reqs = [
        ['GET', `${BASE}/api/v1/boards/${board.id}`, null, params(cookie, 'board')],
        ['GET', `${BASE}/api/v1/boards/${board.id}/views`, null, params(cookie, 'views')],
        ['GET', `${BASE}/api/v1/boards/${board.id}/update-counts`, null, params(cookie, 'update_counts')],
        ['GET', `${BASE}/api/v1/boards/${board.id}/items`, null, params(cookie, big ? 'items_all_big' : 'items_all')],
      ];
      if (board.sub_board_id)
        reqs.push(['GET', `${BASE}/api/v1/boards/${board.sub_board_id}/items`, null, params(cookie, 'sub_items_all')]);
      const res = http.batch(reqs);
      boardOpen.add(Date.now() - t, { big: String(big) });
      res.forEach((r) => check(r, { 'open board 200': (x) => x.status === 200 }));
    },
  ],
  [
    15,
    function query(cookie) {
      const board = pick(config.boards);
      const r = Math.random();
      if (r < 0.4)
        queryItems(
          cookie,
          board,
          {
            filter: {
              kind: 'group',
              operator: 'and',
              rules: [{ column_id: 'status', operator: 'any_of', values: [Math.floor(Math.random() * 3)] }],
            },
            sort: [{ column_id: pick(['amount', 'due', 'name']), direction: pick(['asc', 'desc']) }],
          },
          'query_filter',
        );
      else if (r < 0.7) queryItems(cookie, board, { search: pick(WORDS) }, 'query_search');
      else queryItems(cookie, board, { person: 'me', sort: [{ column_id: 'due', direction: 'asc' }] }, 'query_person');
    },
  ],
  [
    15,
    function openItem(cookie) {
      const board = pick(config.boards);
      const id = itemOf(cookie, board);
      if (!id) return;
      const res = http.batch([
        ['GET', `${BASE}/api/v1/items/${id}`, null, params(cookie, 'item')],
        ['GET', `${BASE}/api/v1/items/${id}/updates`, null, params(cookie, 'item_updates')],
        ['GET', `${BASE}/api/v1/items/${id}/activity`, null, params(cookie, 'item_activity')],
      ]);
      res.forEach((r) => check(r, { 'item 200': (x) => x.status === 200 }));
    },
  ],
  [
    25,
    function editCell(cookie) {
      const board = pick(config.boards);
      const id = itemOf(cookie, board);
      if (!id) return;
      const r = Math.random();
      const [col, value] =
        r < 0.5
          ? ['status', { index: Math.floor(Math.random() * 3) }]
          : r < 0.8
            ? ['amount', Math.round(Math.random() * 50000)]
            : ['note', `k6 ${pick(WORDS)} ${Date.now() % 1000}`];
      const res = http.put(
        `${BASE}/api/v1/items/${id}/cells/${col}`,
        JSON.stringify({ value }),
        params(cookie, 'set_cell', true),
      );
      check(res, { 'set cell 200': (x) => x.status === 200 });
    },
  ],
  [
    8,
    function postUpdate(cookie) {
      const board = pick(config.boards);
      const id = itemOf(cookie, board);
      if (!id) return;
      const res = http.post(
        `${BASE}/api/v1/items/${id}/updates`,
        JSON.stringify({ body: `עדכון מ-k6: ${pick(WORDS)} ${pick(WORDS)}` }),
        params(cookie, 'post_update', true),
      );
      check(res, { 'post update 2xx': (x) => x.status === 200 || x.status === 201 });
    },
  ],
  [
    7,
    function myWork(cookie) {
      check(http.get(`${BASE}/api/v1/me/work`, params(cookie, 'my_work')), { 'my work 200': (x) => x.status === 200 });
    },
  ],
  [
    10,
    function search(cookie) {
      const res = http.get(`${BASE}/api/v1/search?q=${encodeURIComponent(pick(WORDS))}`, params(cookie, 'search'));
      check(res, { 'search 200': (x) => x.status === 200 });
    },
  ],
  [
    10,
    function inbox(cookie) {
      const res = http.batch([
        ['GET', `${BASE}/api/v1/me/inbox/count`, null, params(cookie, 'inbox_count')],
        ['GET', `${BASE}/api/v1/me/notifications`, null, params(cookie, 'notifications')],
      ]);
      res.forEach((r) => check(r, { 'inbox 200': (x) => x.status === 200 }));
    },
  ],
];
const TOTAL_WEIGHT = actions.reduce((s, [w]) => s + w, 0);

export function user(data) {
  const cookie = data.cookies[(__VU - 1) % data.cookies.length];
  let r = Math.random() * TOTAL_WEIGHT;
  for (const [w, fn] of actions) {
    r -= w;
    if (r <= 0) {
      fn(cookie);
      break;
    }
  }
  sleep(1 + Math.random() * 3); // think time: 1–4 s
}

/** One board event stream per user, re-opened every ~60 s (the request ends by timeout: expected). */
export function stream(data) {
  const cookie = data.cookies[(__VU - 1) % data.cookies.length];
  const board = config.boards[(__VU - 1) % config.boards.length];
  http.get(`${BASE}/api/v1/boards/${board.id}/events?account_id=${config.account_id}`, {
    headers: { cookie, origin: ORIGIN, accept: 'text/event-stream' },
    tags: { name: 'sse', kind: 'stream' },
    timeout: '60s',
  });
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data),
    [`/perf/results/board-mix-${LABEL}.json`]: JSON.stringify(data, null, 1),
  };
}

/** Compact per-endpoint table (k6's default summary is long). */
function textSummary(data) {
  const m = data.metrics;
  const row = (label, metric) => {
    const v = metric && metric.values;
    if (!v || !v.count) return null;
    const f = (x) => (x === undefined ? '-' : x.toFixed(0)).padStart(7);
    return `${label.padEnd(34)}${String(v.count).padStart(7)}${f(v.med)}${f(v['p(95)'])}${f(v['p(99)'])}${f(v.max)}`;
  };
  const lines = [
    `${'endpoint'.padEnd(34)}${'count'.padStart(7)}${'med'.padStart(7)}${'p95'.padStart(7)}${'p99'.padStart(7)}${'max'.padStart(7)}`,
  ];
  for (const n of NAMES) {
    const r = row(n, m[`http_req_duration{name:${n}}`]);
    if (r) lines.push(r);
  }
  lines.push(row('ALL reads', m['http_req_duration{kind:read}']));
  lines.push(row('ALL writes', m['http_req_duration{kind:write}']));
  lines.push(row('board_open_ms (wall)', m.board_open_ms));
  const fr = (k) => (m[k] ? `${(m[k].values.rate * 100).toFixed(2)}%` : '-');
  lines.push(`errors: reads ${fr('http_req_failed{kind:read}')} · writes ${fr('http_req_failed{kind:write}')}`);
  lines.push(`requests: ${m.http_reqs.values.count} (${m.http_reqs.values.rate.toFixed(1)}/s)`);
  const failed = Object.entries(m)
    .filter(([, v]) => v.thresholds && Object.values(v.thresholds).some((t) => !t.ok))
    .map(([k]) => k);
  lines.push(`thresholds failed: ${failed.length ? failed.join(', ') : 'none'}`);
  return `\n${lines.filter(Boolean).join('\n')}\n`;
}
