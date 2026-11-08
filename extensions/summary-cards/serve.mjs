// SPDX-License-Identifier: AGPL-3.0-only
// Development / E2E host for the sample extensions (never deployed). Serves this folder, the SDK as /sdk.js
// (packages/ext-sdk, its TypeScript types stripped by Node) and two manifests pointing at this server:
//   /manifest.json      "summary cards" — a board view, boards:read only (ת2)
//   /kit/manifest.json  "sample kit" — item tab, menu + batch action, widget, settings page, automation action and
//                       trigger (ת3–ת5)
// The kit's automation action is POST /kit/run: it checks the signature with @bines/ext-sdk/server (the secret is
// handed over in development by POST /dev/secret {installation_id, secret}) and writes an update back with the
// token from the call. GET /dev/runs lists what it received (for the E2E test).
//   node extensions/summary-cards/serve.mjs [port]     (default 3998, on 127.0.0.1)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkSource = join(here, '../../packages/ext-sdk/src/index.ts');
const serverSdkSource = join(here, '../../packages/ext-sdk/src/server.ts');
const port = Number(process.argv[2] ?? process.env.EXT_SAMPLE_PORT ?? 3998);
const origin = `http://127.0.0.1:${port}`;

export const sampleManifest = (o = origin) => ({
  manifest_version: 1,
  id: 'summary-cards',
  name: 'כרטיסי סיכום',
  name_en: 'Summary cards',
  description: 'תוסף לדוגמה: מספרים על הלוח (קריאה בלבד).',
  version: '1.0.0',
  icon: '📊',
  publisher: { name: 'Bines (sample)' },
  permissions: ['boards:read'],
  origins: [o],
  features: [
    { type: 'board_view', key: 'summary', name: 'כרטיסי סיכום', name_en: 'Summary cards', url: `${o}/index.html` },
  ],
});

export const kitManifest = (o = origin) => ({
  manifest_version: 1,
  id: 'sample-kit',
  name: 'ערכת דוגמה',
  name_en: 'Sample kit',
  description: 'תוסף לדוגמה: לשונית בכרטיס, פעולה בתפריט ובסרגל, ווידג׳ט, דף הגדרות ובלוק אוטומציה.',
  version: '1.0.0',
  icon: '🧪',
  publisher: { name: 'Bines (sample)' },
  permissions: ['boards:read', 'items:write', 'updates:write'],
  origins: [o],
  features: [
    { type: 'item_view', key: 'tab', name: 'לשונית דוגמה', name_en: 'Sample tab', url: `${o}/kit.html?page=item` },
    {
      type: 'board_menu_action',
      key: 'mark',
      name: 'סמן בתוסף',
      name_en: 'Mark with the kit',
      url: `${o}/kit.html?page=action`,
      contexts: ['board', 'item'],
      modal: { width: 480, height: 320 },
    },
    {
      type: 'batch_action',
      key: 'bulk',
      name: 'סמן את המסומנים',
      name_en: 'Mark the selected',
      url: `${o}/kit.html?page=action`,
    },
    {
      type: 'dashboard_widget',
      key: 'count',
      name: 'ספירת פריטים',
      name_en: 'Item count',
      url: `${o}/kit.html?page=widget`,
      default_size: { w: 3, h: 2 },
    },
    { type: 'account_settings_page', key: 'settings', name: 'הגדרות', url: `${o}/kit.html?page=settings` },
    {
      type: 'automation_action',
      key: 'note',
      name: 'כתוב הערה מהתוסף',
      name_en: 'Write a note from the kit',
      url: `${o}/kit/run`,
      inputs: [{ key: 'message', label: 'הודעה', label_en: 'Message', type: 'template', required: true }],
    },
    {
      type: 'automation_trigger',
      key: 'ping',
      name: 'כשהתוסף שולח פינג',
      name_en: 'When the kit pings',
      payload_fields: [{ key: 'text', label: 'טקסט' }],
    },
  ],
});

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const FILES = ['index.html', 'app.js', 'kit.html', 'kit.js'];

/** Development only: the signing secret of each installation (the admin copies it from Administration → תוספות). */
const secrets = new Map();
const seen = new Set();
const runs = [];
let serverSdk = null;
const loadServerSdk = async () =>
  (serverSdk ??= await import(
    `data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(await readFile(serverSdkSource, 'utf8')))}`
  ));

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
};

/** The kit's automation action: verify, then write the message back on the item as an update ("via app"). */
const runAction = async (req, res) => {
  const raw = await readBody(req);
  const { verifyBinesSignature } = await loadServerSdk();
  const installation = String(req.headers['x-bines-installation'] ?? '');
  const secret = secrets.get(installation);
  const check = secret
    ? await verifyBinesSignature({
        secret,
        timestamp: req.headers['x-bines-timestamp'],
        signature: req.headers['x-bines-signature'],
        body: raw,
        seen,
      })
    : 'no_secret';
  const body = check === 'ok' ? JSON.parse(raw) : null;
  runs.push({ check, block: body?.block ?? null, item_id: body?.item?.id ?? null, input: body?.input ?? null });
  if (check !== 'ok') return json(res, 401, { error: check });
  if (body.item) {
    const r = await fetch(`${body.token.api_base}/items/${encodeURIComponent(body.item.id)}/updates`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${body.token.token}`,
        'x-account-id': body.account_id,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ body: String(body.input?.message ?? '') }),
    });
    if (!r.ok) return json(res, 502, { error: `write_back_${r.status}` });
  }
  return json(res, 200, { output: { noted: true } });
};

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', origin).pathname;
  // The pages may be framed only by the local app (an extension decides who may frame it).
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src http://localhost:* http://127.0.0.1:*; frame-ancestors http://localhost:* http://127.0.0.1:*",
  );
  try {
    if (path === '/health') return res.end('ok');
    if (path === '/manifest.json') return json(res, 200, sampleManifest());
    if (path === '/kit/manifest.json') return json(res, 200, kitManifest());
    if (path === '/kit/run' && req.method === 'POST') return await runAction(req, res);
    if (path === '/dev/secret' && req.method === 'POST') {
      const { installation_id: id, secret } = JSON.parse(await readBody(req));
      secrets.set(String(id), String(secret));
      return json(res, 200, { ok: true });
    }
    if (path === '/dev/runs') return json(res, 200, { runs });
    if (path === '/sdk.js') {
      res.setHeader('content-type', TYPES['.js']);
      return res.end(stripTypeScriptTypes(await readFile(sdkSource, 'utf8')));
    }
    const file = path === '/' ? 'index.html' : path.slice(1);
    if (!FILES.includes(file)) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('content-type', TYPES[file.slice(file.lastIndexOf('.'))]);
    res.end(await readFile(join(here, file)));
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
});

server.listen(port, '127.0.0.1', () => console.warn(`sample extensions on ${origin}`));
