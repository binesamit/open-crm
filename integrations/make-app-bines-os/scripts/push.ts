// SPDX-License-Identifier: MIT
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Uploads `app/` to Make with its SDK-apps API (https://developers.make.com/api-documentation/api-reference/sdk-apps).
 *
 *   MAKE_API_TOKEN=…  MAKE_ZONE=eu1  node scripts/push.ts            # dry run: prints every call, sends nothing
 *   MAKE_API_TOKEN=…  MAKE_ZONE=eu1  node scripts/push.ts --apply    # creates / updates the app
 *
 * The token is a Make API token with the scopes `sdk-apps:read` and `sdk-apps:write` (Make → profile → API access).
 * Make names connections and webhooks itself; the names it gave are kept in `.make-app.json` (next to this package,
 * not committed) so a second push updates the same components instead of creating new ones. Set MAKE_APP_NAME to
 * push into an app that already exists (e.g. one created in the web editor).
 */
const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'app');
const STATE_FILE = join(ROOT, '.make-app.json');

type Index = {
  name: string;
  label: string;
  description: string;
  language: string;
  theme: string;
  version: number;
  connections: Record<string, { label: string; type: string }>;
  webhooks: Record<string, { label: string; type: string; connection: string }>;
  rpcs: Record<string, { label: string; connection: string }>;
  modules: Record<
    string,
    { typeId: number; label: string; description: string; connection: string | null; webhook: string | null }
  >;
};
type State = { app?: string; connections: Record<string, string>; webhooks: Record<string, string> };

const apply = process.argv.includes('--apply');
const token = process.env.MAKE_API_TOKEN ?? '';
const zone = process.env.MAKE_ZONE ?? '';
if (apply && (!token || !zone)) {
  console.error('Set MAKE_API_TOKEN and MAKE_ZONE (eu1, eu2, us1, us2 …) to push.');
  process.exit(1);
}
const API = `https://${zone || '<zone>'}.make.com/api/v2`;

const read = (path: string) => readFileSync(join(APP, path), 'utf8');
const index = JSON.parse(read('app.json')) as Index;
const state: State = existsSync(STATE_FILE)
  ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State)
  : { connections: {}, webhooks: {} };
const saveState = () => apply && writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);

let fake = 0;
/** One API call; in a dry run it is only printed (and a create answers a placeholder name). */
const call = async (
  method: string,
  path: string,
  body?: string | Uint8Array,
  type = 'application/json',
): Promise<{ status: number; json: Record<string, unknown> | null }> => {
  console.warn(`${apply ? '→' : '[dry run]'} ${method} ${path}${body ? ` (${body.length} bytes, ${type})` : ''}`);
  if (!apply) return { status: method === 'GET' ? 404 : 200, json: { name: `planned-${++fake}` } };
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Token ${token}`, ...(body !== undefined ? { 'content-type': type } : {}) },
    ...(body !== undefined ? { body } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  if (!res.ok && !(method === 'GET' && res.status === 404))
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return { status: res.status, json };
};
/** The name Make gave a created component (answers nest it under the component's kind). */
const nameOf = (json: Record<string, unknown> | null, kind: string): string => {
  const inner = (json?.[kind] as { name?: string } | undefined) ?? (json as { name?: string } | null);
  if (!inner?.name) throw new Error(`Make did not answer a ${kind} name: ${JSON.stringify(json)}`);
  return inner.name;
};
/** The status of a refused call (`call` throws `METHOD path → status: …`). */
const statusOf = (e: unknown) => Number(/ → (\d{3}):/.exec((e as Error).message)?.[1] ?? 0);

/**
 * The app's icon (`assets/icon.png`, 512 × 512, from `src/icon.ts`): `PUT /sdk/apps/{name}/{version}/icon` with the
 * PNG as the body (Make's API reference). Make's docs were wrong about the method of `base` once, so a 404 / 405
 * retries with POST; then `GET …/icon/512` checks Make has it.
 */
const pushIcon = async (v: string) => {
  const png = new Uint8Array(readFileSync(join(ROOT, 'assets', 'icon.png')));
  try {
    await call('PUT', `${v}/icon`, png, 'image/png');
  } catch (e) {
    if (![404, 405].includes(statusOf(e))) throw e;
    console.warn(`PUT ${v}/icon was refused (${statusOf(e)}); trying POST.`);
    await call('POST', `${v}/icon`, png, 'image/png');
  }
  console.warn(`${apply ? '→' : '[dry run]'} GET ${v}/icon/512 (check)`);
  if (!apply) return;
  const res = await fetch(`${API}${v}/icon/512`, { headers: { authorization: `Token ${token}` } });
  const type = res.headers.get('content-type') ?? '';
  await res.arrayBuffer();
  if (!res.ok || !type.startsWith('image/'))
    console.warn(
      `The icon check answered ${res.status} (${type || 'no type'}). Upload assets/icon.png in the app → General.`,
    );
  else console.warn('Icon set.');
};

const section = (path: string, file: string, type = 'application/jsonc') => call('PUT', path, read(file), type);

/** Raw GET for the preflight (never throws; a dry run skips it). */
const peek = async (path: string): Promise<{ status: number; json: Record<string, unknown> | null }> => {
  const res = await fetch(`${API}${path}`, { headers: { authorization: `Token ${token}` } });
  const text = await res.text();
  try {
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  } catch {
    return { status: res.status, json: null };
  }
};

/**
 * Before writing anything: who the token is, which organizations (and zones) it sees, and whether the app exists for
 * this user in this zone. A user in several organizations or zones gets a clear message instead of a 403 halfway.
 */
const preflight = async (appName: string | undefined) => {
  const me = await peek('/users/me');
  if (me.status === 401 || me.status === 403)
    throw new Error(
      `The token was refused by ${zone}.make.com (${me.status}). Create a new API token in this zone with sdk-apps:read and sdk-apps:write.`,
    );
  const user = (me.json?.authUser ?? me.json?.user) as { email?: string; name?: string } | undefined;
  console.warn(`Make user: ${user?.email ?? user?.name ?? '(unknown)'} — zone ${zone}`);
  const orgs = await peek('/organizations');
  const list = (orgs.json?.organizations as { id: number; name: string; zone: string }[] | undefined) ?? [];
  for (const o of list)
    console.warn(
      `  organization ${o.id} "${o.name}" — zone ${o.zone}${o.zone?.startsWith(zone) ? '' : '  (other zone)'}`,
    );
  if (list.length && !list.some((o) => o.zone?.startsWith(zone)))
    throw new Error(
      `None of your organizations is in zone ${zone}. Set MAKE_ZONE to the zone in your Make address (${[...new Set(list.map((o) => o.zone))].join(', ')}).`,
    );
  if (appName) {
    const app = await peek(`/sdk/apps/${appName}/${index.version}`);
    if (app.status === 404 || app.status === 403)
      throw new Error(
        `App "${appName}" is not visible to this token in zone ${zone}. Custom apps belong to the Make user who created them: use a token of that user, in the zone where the app was created (or delete .make-app.json to create a fresh app).`,
      );
    console.warn(`App "${appName}" found.`);
  }
};

const main = async () => {
  if (apply) await preflight(process.env.MAKE_APP_NAME || state.app);
  // 1. The app.
  const appName = process.env.MAKE_APP_NAME || state.app;
  let app: string;
  if (appName) app = appName;
  else {
    const res = await call(
      'POST',
      '/sdk/apps',
      JSON.stringify({
        name: index.name,
        label: index.label,
        description: index.description,
        theme: index.theme,
        language: index.language,
      }),
    );
    app = nameOf(res.json, 'app');
  }
  state.app = app;
  saveState();
  const v = `/sdk/apps/${app}/${index.version}`;

  // 2. The connection, then the base (it reads the connection's fields). There is no functions step: the app uses
  //    Make's built-in IML only, so publishing never needs custom IML functions enabled.
  for (const [key, c] of Object.entries(index.connections)) {
    if (!state.connections[key]) {
      const res = await call('POST', `/sdk/apps/${app}/connections`, JSON.stringify({ type: c.type, label: c.label }));
      state.connections[key] = nameOf(res.json, 'appConnection');
      saveState();
    }
    const name = state.connections[key]!;
    await section(`/sdk/apps/connections/${name}/api`, `connections/${key}/api.json`);
    await section(`/sdk/apps/connections/${name}/parameters`, `connections/${key}/parameters.json`);
  }
  // PUT, not POST: Make's docs say POST, but the API answers POST with 404 and takes PUT (checked 2026-10-09).
  await call('PUT', `${v}/base`, read('base.json'), 'application/jsonc');

  // 3. Webhooks (one per instant trigger: attached, dedicated).
  for (const [key, w] of Object.entries(index.webhooks)) {
    if (!state.webhooks[key]) {
      const res = await call(
        'POST',
        `/sdk/apps/${app}/webhooks`,
        JSON.stringify({ type: w.type, label: w.label, connection: state.connections[w.connection] }),
      );
      state.webhooks[key] = nameOf(res.json, 'appWebhook');
      saveState();
    }
    const name = state.webhooks[key]!;
    for (const s of ['api', 'parameters', 'attach', 'detach'])
      await section(`/sdk/apps/webhooks/${name}/${s}`, `webhooks/${key}/${s}.json`);
  }

  // 4. RPCs.
  for (const [key, r] of Object.entries(index.rpcs)) {
    const exists = await call('GET', `${v}/rpcs/${key}`);
    if (exists.status === 404)
      await call(
        'POST',
        `${v}/rpcs`,
        JSON.stringify({ name: key, label: r.label, connection: state.connections[r.connection] }),
      );
    await section(`${v}/rpcs/${key}/api`, `rpcs/${key}/api.json`);
    await section(`${v}/rpcs/${key}/parameters`, `rpcs/${key}/parameters.json`);
  }

  // 5. Modules.
  for (const [key, m] of Object.entries(index.modules)) {
    const exists = await call('GET', `${v}/modules/${key}`);
    if (exists.status === 404)
      await call(
        'POST',
        `${v}/modules`,
        JSON.stringify({
          name: key,
          typeId: m.typeId,
          label: m.label,
          description: m.description,
          moduleInitMode: 'blank',
          ...(m.connection ? { connection: state.connections[m.connection] } : {}),
          ...(m.webhook ? { webhook: state.webhooks[m.webhook] } : {}),
        }),
      );
    for (const s of ['api', 'parameters', 'expect', 'interface', 'samples'])
      if (existsSync(join(APP, 'modules', key, `${s}.json`)))
        await section(`${v}/modules/${key}/${s}`, `modules/${key}/${s}.json`);
  }

  // 6. Groups (the module list's sections) and the docs.
  try {
    await call('PUT', `${v}/groups`, read('groups.json'), 'application/jsonc');
  } catch (e) {
    console.warn(`Groups were not set (${(e as Error).message}). Paste app/groups.json into the web editor → Groups.`);
  }
  await call('PUT', `${v}/readme`, read('readme.md'), 'text/markdown');

  // 7. The icon.
  await pushIcon(v);
  console.warn(apply ? `Pushed to Make app "${app}".` : 'Dry run only — add --apply to send.');
};

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
