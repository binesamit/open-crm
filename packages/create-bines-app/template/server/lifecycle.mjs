// SPDX-License-Identifier: MIT
// Your extension's server (D27 ת6, docs/EXTENSIONS-GUIDE.md §6): Bines calls POST /lifecycle when the extension is
// installed / updated / enabled / disabled / uninstalled in an account. Every call is signed:
//   x-bines-signature: sha256=HMAC-SHA256(signing_secret, "<x-bines-timestamp>.<raw body>")
// `installed` carries the credentials (client id + secret, the signing secret). Keep them secret; prove they are
// real by trading them for a token, and use that token as your extension's service user.
// (@bines/ext-sdk/server has the same helpers for TypeScript servers: verifyLifecycle, createServerClient.)
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';

const PORT = Number('__SERVER_PORT__');
// The Bines you work with. `installed` is signed with the secret it brings — anyone could sign one — so only its
// origins (platform, token endpoint, API) say it is ours. Set BINES_ORIGIN in production.
const BINES_ORIGIN = new URL(process.env.BINES_ORIGIN ?? 'http://localhost:3000').origin;
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
};
const STORE = new URL('../.data/', import.meta.url);
const CREDS = new URL('credentials.json', STORE);
const MAX_AGE_MS = 5 * 60_000;

const load = () => {
  try {
    return JSON.parse(readFileSync(CREDS, 'utf8'));
  } catch {
    return {};
  }
};
const save = (all) => {
  mkdirSync(STORE, { recursive: true });
  writeFileSync(CREDS, JSON.stringify(all, null, 2), { mode: 0o600 });
};

const sign = (secret, ts, body) => `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** A token for the API, as the extension's service user (OAuth client_credentials). */
const tokenFor = async (c) => {
  const res = await fetch(c.token_endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(c.client_id)}:${encodeURIComponent(c.client_secret)}`).toString('base64')}`,
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`token: ${data.error ?? res.status}`);
  return data.access_token;
};

const handle = async (raw, headers) => {
  const ts = String(headers['x-bines-timestamp'] ?? '');
  const sig = String(headers['x-bines-signature'] ?? '');
  if (!ts || !sig || Math.abs(Date.now() - Number(ts)) > MAX_AGE_MS) return 401;
  const event = JSON.parse(raw);
  const all = load();
  const known = all[event.installation?.id];
  // `installed` is signed with the secret it brings (also after the admin's "reconnect"); every other call with the
  // one saved before. Its origins must be our Bines — then only the real Bines can issue a token for the credentials
  // (checked below before anything is saved).
  if (event.event === 'installed') {
    const c = event.credentials ?? {};
    const ours = [event.platform, c.token_endpoint, c.api_base].every((u) => originOf(u) === BINES_ORIGIN);
    if (!ours) return 401;
  }
  const secret = event.event === 'installed' ? event.credentials?.signing_secret : known?.signing_secret;
  if (!secret || !same(sign(secret, ts, raw), sig)) return 401;
  if (event.event === 'installed') {
    // Prove the credentials before trusting them: only the real Bines can issue a token for them.
    const token = await tokenFor(event.credentials);
    const me = await fetch(`${event.credentials.api_base}/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    console.warn(`installed in ${event.account?.name ?? event.account?.id}: token ok, /auth/me ${me.status}`);
    all[event.installation.id] = { ...event.credentials, account_id: event.account.id };
    save(all);
  } else if (event.event === 'uninstalled') {
    delete all[event.installation.id];
    save(all);
    if (!Object.keys(all).length) rmSync(STORE, { recursive: true, force: true });
  }
  console.warn(`${event.event}: ${event.installation?.key} v${event.installation?.version} (${event.reason ?? ''})`);
  return 200;
};

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/lifecycle') {
    res.statusCode = 404;
    return res.end();
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    handle(Buffer.concat(chunks).toString('utf8'), req.headers)
      .then((status) => {
        res.statusCode = status;
        res.end();
      })
      .catch((err) => {
        console.error(err);
        res.statusCode = 500;
        res.end();
      });
  });
}).listen(PORT, 'localhost', () => console.warn(`lifecycle server on http://localhost:${PORT}/lifecycle`));
