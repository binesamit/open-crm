// SPDX-License-Identifier: MIT
import { createHash, createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { TRIGGER_EVENTS } from '../../n8n-nodes-bines-os/nodes/shared/constants.ts';
import { SCHEMA } from '../../n8n-nodes-bines-os/test/mock.ts';
import { APP_DIR, buildFiles, ROOT } from '../src/build.ts';
import { ICON_FILE, MARK_BARS, renderIcon } from '../src/icon.ts';
import { MODULE_TYPE, TRIGGERS, VERIFY_CONDITION } from '../src/spec.ts';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Index = {
  connections: Record<string, unknown>;
  webhooks: Record<string, { connection: string }>;
  rpcs: Record<string, { connection: string }>;
  modules: Record<string, { typeId: number; connection: string | null; webhook: string | null }>;
};

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const full = join(dir, f);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
const files = walk(APP_DIR);
const rel = (f: string) => relative(APP_DIR, f).replace(/\\/g, '/');
const jsonFiles = files.filter((f) => f.endsWith('.json'));
const index = JSON.parse(readFileSync(join(APP_DIR, 'app.json'), 'utf8')) as Index;
const read = (path: string) => JSON.parse(readFileSync(join(APP_DIR, path), 'utf8')) as Json;

/**
 * Make's built-in IML functions (developers.make.com → custom apps → IML: general, text, array, date, math, JSON).
 * The app may call only these — custom IML functions need Make support to enable them.
 */
const BUILTINS = new Set([
  // general
  'get', 'if', 'ifempty', 'switch', 'omit', 'pick',
  // text
  'ascii', 'base64', 'capitalize', 'contains', 'decodeURL', 'encodeURL', 'escapeHTML', 'escapeMarkdown', 'indexOf',
  'length', 'lower', 'md5', 'mime', 'replace', 'replaceEmojiCharacters', 'sha1', 'sha256', 'sha512', 'split',
  'startcase', 'stripHTML', 'substring', 'toBinary', 'toString', 'trim', 'upper',
  // array
  'add', 'deduplicate', 'distinct', 'first', 'flatten', 'join', 'keys', 'last', 'map', 'merge', 'remove', 'reverse',
  'shuffle', 'slice', 'sort', 'toArray', 'toCollection',
  // date
  'formatDate', 'parseDate', 'addDays', 'addHours', 'addMinutes', 'addMonths', 'addSeconds', 'addYears', 'setSecond',
  'setMinute', 'setHour', 'setDay', 'setDate', 'setMonth', 'setYear',
  // math
  'abs', 'average', 'ceil', 'floor', 'formatNumber', 'max', 'median', 'min', 'parseNumber', 'round', 'stdevP', 'sum',
  'trunc',
  // JSON
  'createJSON', 'parseJSON',
]); // prettier-ignore

/** Every `{{…}}` expression of the app's JSON files. */
const expressions = jsonFiles.flatMap((f) =>
  [...readFileSync(f, 'utf8').matchAll(/\{\{([^}]*)\}\}/g)].map((m) => ({
    file: rel(f),
    expr: JSON.parse(`"${m[1]!}"`) as string,
  })),
);

// ── a small IML evaluator (Make's semantics for what the app uses) to run the real expressions ─────────────────

/** Make's `replace`: a search string written `/…/flags` is a regular expression. */
const imlReplace = (text: unknown, search: string, by: string) => {
  const re = /^\/(.*)\/([gimsuy]*)$/.exec(search);
  return String(text ?? '').replace(re ? new RegExp(re[1]!, re[2]) : search, by);
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FNS: Record<string, (...a: any[]) => unknown> = {
  if: (c, a, b) => (c ? a : b),
  ifempty: (a, b) => (a === undefined || a === null || a === '' ? b : a),
  get: (o, k: string) => (o == null ? undefined : (o as Json)[k]),
  trim: (s) => String(s ?? '').trim(),
  replace: imlReplace,
  substring: (s, a: number, b: number) => String(s ?? '').substring(a, b),
  length: (v) => (Buffer.isBuffer(v) || typeof v === 'string' || Array.isArray(v) ? v.length : 0),
  abs: Math.abs,
  parseNumber: (s) => Number(s),
  formatDate: (d: Date, f: string) => (f === 'x' ? String(d.getTime()) : d.toISOString()),
  createJSON: (v) => JSON.stringify(v),
  sha256: (text: string, enc: 'hex', key?: string) =>
    key === undefined
      ? createHash('sha256').update(text).digest(enc)
      : createHmac('sha256', key).update(text).digest(enc),
};
/** IML's root variables: one that a context does not set reads as empty, like a missing field. */
const ROOTS = ['parameters', 'webhook', 'headers', 'body', 'query', 'connection', 'now', 'temp', 'data'];
const iml = (expr: string, scope: Json): unknown => {
  const js = expr
    .replace(/==/g, '===')
    .replace(/!=(?!=)/g, '!==')
    // IML reads a field of a missing value as empty (no error).
    .replace(/([A-Za-z_][A-Za-z0-9_]*)\.(?=[A-Za-z_])/g, '$1?.')
    .replace(/([A-Za-z_][A-Za-z0-9_]*)\(/g, (_, n: string) => `$fn.${n}(`);
  const names = [...new Set([...ROOTS, ...Object.keys(scope)])];
  return new Function('$fn', ...names, `return (${js});`)(FNS, ...names.map((n) => scope[n])) as unknown;
};
/** A value with `{{…}}` inside: a lone expression keeps its type, otherwise the parts are joined as text. */
const render = (template: string, scope: Json): unknown => {
  const lone = /^\{\{([^}]*)\}\}$/.exec(template);
  if (lone) return iml(lone[1]!, scope);
  return template.replace(/\{\{([^}]*)\}\}/g, (_, e: string) => String(iml(e, scope) ?? ''));
};
const renderDeep = (v: unknown, scope: Json): unknown =>
  typeof v === 'string'
    ? render(v, scope)
    : Array.isArray(v)
      ? v.map((x) => renderDeep(x, scope))
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderDeep(x, scope)]))
        : v;

describe('the Make app files', () => {
  it('app/ is what src/build.ts generates (run `pnpm --filter make-app-bines-os build`)', async () => {
    const built = await buildFiles();
    expect(files.map(rel).sort()).toEqual([...built.keys()].sort());
    for (const [path, content] of built) expect(readFileSync(join(APP_DIR, path), 'utf8'), path).toBe(content);
  });

  it('every JSON file parses', () => {
    expect(jsonFiles.length).toBeGreaterThan(100);
    for (const f of jsonFiles) expect(() => JSON.parse(readFileSync(f, 'utf8')), rel(f)).not.toThrow();
  });

  it('every module has a valid type and links to an existing connection or webhook', () => {
    const types = new Set<number>(Object.values(MODULE_TYPE));
    for (const [name, m] of Object.entries(index.modules)) {
      expect(types.has(m.typeId), name).toBe(true);
      if (m.typeId === MODULE_TYPE.instant) {
        expect(m.webhook && index.webhooks[m.webhook], `${name} webhook`).toBeTruthy();
        expect(m.connection).toBeNull();
      } else {
        expect(m.connection && index.connections[m.connection], `${name} connection`).toBeTruthy();
        expect(m.webhook).toBeNull();
      }
      for (const s of ['parameters', 'expect', 'interface', 'samples'])
        expect(files.map(rel), `${name}/${s}`).toContain(`modules/${name}/${s}.json`);
      if (m.typeId !== MODULE_TYPE.instant) expect(files.map(rel)).toContain(`modules/${name}/api.json`);
    }
    for (const [name, w] of Object.entries(index.webhooks)) {
      expect(index.connections[w.connection], name).toBeTruthy();
      for (const s of ['api', 'parameters', 'attach', 'detach'])
        expect(files.map(rel)).toContain(`webhooks/${name}/${s}.json`);
    }
    for (const [name, r] of Object.entries(index.rpcs)) expect(index.connections[r.connection], name).toBeTruthy();
  });

  it('every rpc:// reference names an existing RPC, and every RPC is used', () => {
    const refs = new Set<string>();
    for (const f of jsonFiles)
      for (const m of readFileSync(f, 'utf8').matchAll(/rpc:\/\/([A-Za-z0-9_]+)/g)) refs.add(m[1]!);
    // The column-values form comes from the API (`GET /boards/{id}/fields`): its pickers name these RPCs.
    refs.add('listValues');
    refs.add('listUsers');
    for (const r of refs) expect(Object.keys(index.rpcs), `rpc://${r}`).toContain(r);
    for (const r of Object.keys(index.rpcs)) expect(refs.has(r), `unused RPC ${r}`).toBe(true);
  });

  it('uses no custom IML function: every {{name(…)}} is a Make built-in', () => {
    expect(existsSync(join(APP_DIR, 'functions'))).toBe(false);
    expect(index).not.toHaveProperty('functions');
    expect(expressions.length).toBeGreaterThan(50);
    const unknown = new Set<string>();
    for (const { file, expr } of expressions) {
      // Names inside quotes are text, not calls.
      const code = expr.replace(/'[^']*'|"[^"]*"/g, "''");
      for (const m of code.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g))
        if (!BUILTINS.has(m[1]!)) unknown.add(`${m[1]}() in ${file}`);
    }
    expect([...unknown]).toEqual([]);
  });

  it('every expression parses (as the JavaScript-like IML it is)', () => {
    for (const { file, expr } of expressions) {
      const js = expr.replace(/([A-Za-z_][A-Za-z0-9_]*)\(/g, '$fn.$1(').replace(/==/g, '===');
      expect(() => new Function('$fn', `return (${js});`), `${file}: ${expr}`).not.toThrow();
    }
  });

  it('groups list every module exactly once', () => {
    const groups = read('groups.json') as unknown as { modules: string[] }[];
    expect(groups.flatMap((g) => g.modules).sort()).toEqual(Object.keys(index.modules).sort());
  });

  it('has an instant trigger for each of the n8n trigger’s events', () => {
    expect(TRIGGERS.map((t) => t.event).sort()).toEqual(TRIGGER_EVENTS.map((e) => e.value).sort());
    expect(TRIGGERS).toHaveLength(TRIGGER_EVENTS.length);
  });

  it('the push script plans every call in a dry run — and never the functions endpoint', () => {
    const run = spawnSync(process.execPath, [join(ROOT, 'scripts', 'push.ts')], { encoding: 'utf8', env: {} });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stderr).toContain('[dry run] POST /sdk/apps');
    expect(run.stderr).toContain('/modules/createItem/api');
    expect(run.stderr).toContain('/webhooks/');
    expect(run.stderr).toContain('Dry run only');
    expect(run.stderr).not.toMatch(/\/functions/);
    // The icon: the PNG as the body, then a check that Make has it.
    expect(run.stderr).toMatch(/\[dry run\] PUT \/sdk\/apps\/[^/]+\/1\/icon \(\d+ bytes, image\/png\)/);
    expect(run.stderr).toMatch(/\[dry run\] GET \/sdk\/apps\/[^/]+\/1\/icon\/512 \(check\)/);
  });

  it('the icon is the brand mark: a 512 × 512 PNG, black bars on transparent (Make paints them on the theme)', () => {
    const png = readFileSync(join(ROOT, ICON_FILE));
    // Up to date with src/icon.ts (`pnpm --filter make-app-bines-os build`).
    expect(png.equals(renderIcon())).toBe(true);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(512);
    expect(png.readUInt32BE(20)).toBe(512);
    expect(png.length).toBeLessThan(500 * 1024);
    expect(read('app.json').theme).toBe('#5b5bd6');
    // The bars are the n8n nodes' mark (its white rects, the background square left out).
    const svg = readFileSync(join(ROOT, '..', 'n8n-nodes-bines-os', 'nodes', 'BinesOs', 'binesOs.svg'), 'utf8');
    const bars = [...svg.matchAll(/<rect ([^>]*fill="#ffffff"[^>]*)\/>/g)].map((m) => {
      const attr = (n: string) => Number(new RegExp(`${n}="([\\d.]+)"`).exec(m[1]!)?.[1] ?? 1);
      return {
        x: attr('x'),
        y: attr('y'),
        width: attr('width'),
        height: attr('height'),
        rx: attr('rx'),
        opacity: attr('fill-opacity'),
      };
    });
    expect(bars).toEqual(MARK_BARS);
    // Pixels: transparent corner, opaque black inside the tall bar, 0.85 inside the top bar.
    const rgba = inflateSync(png.subarray(41, png.length - 12 - 4));
    const alpha = (x: number, y: number) => rgba[y * (1 + 512 * 4) + 1 + x * 4 + 3];
    expect(alpha(5, 5)).toBe(0);
    expect(alpha(140, 256)).toBe(255);
    expect(alpha(316, 165)).toBe(Math.round(0.85 * 255));
  });
});

describe('the expressions, run', () => {
  it('the API base from whatever address a person typed', () => {
    const baseUrl = read('base.json').baseUrl as string;
    for (const typed of [
      'https://crm.example.com',
      'https://crm.example.com/',
      ' https://crm.example.com/api/v1 ',
      'https://crm.example.com/api/v1/',
    ])
      expect(render(baseUrl, { connection: { baseUrl: typed } }), typed).toBe('https://crm.example.com/api/v1');
    expect(render(read('connections/binesOs/api.json').url, { parameters: { baseUrl: 'https://x.io/' } })).toBe(
      'https://x.io/api/v1/auth/me',
    );
  });

  describe('the signature check (the lite signature: timestamp + "." + deliveryId)', () => {
    const condition = read('webhooks/watchItemsCreated/api.json').condition as string;
    const secret = 'a'.repeat(48);
    const hmac = (key: string, text: string) => `sha256=${createHmac('sha256', key).update(text).digest('hex')}`;
    /**
     * A delivery as the API sends it (`apps/api/src/modules/webhooks/delivery.ts`): a flat body with `timestamp` and
     * `signatureLite` on top, `deliveryId` in the event; `X-Bines-Signature-Lite` = HMAC(secret, ts + "." + id); and
     * the full `X-Bines-Signature` over the raw bytes. Hebrew, emoji and numbers: what `createJSON` would not redo.
     */
    const deliver = (ts = String(Date.now()), key = secret, id = '01JBDELIVERY0000000000000A') => {
      const lite = hmac(key, `${ts}.${id}`);
      const raw = JSON.stringify({
        event: { type: 'item_created', itemName: 'דנה לוי 🚀', value: { index: 1 }, n: 1.5, big: 1e21, deliveryId: id },
        timestamp: ts,
        signatureLite: lite,
      });
      const headers = {
        'x-bines-delivery': id,
        'x-bines-timestamp': ts,
        'x-bines-signature': hmac(key, `${ts}.${raw}`),
        'x-bines-signature-lite': lite,
      };
      // Make hands the module the parsed body — with its own key order — never the raw bytes.
      const parsed = JSON.parse(raw) as Json;
      const body = { signatureLite: parsed.signatureLite, timestamp: parsed.timestamp, event: parsed.event } as Json;
      return { raw, headers, body };
    };
    const check = (headers: Json, body: Json, parameters: Json = { secret }, webhook: Json = {}) =>
      render(condition, { headers, body, parameters, webhook, now: new Date() });

    it('is the spec’s and never re-serialises the body', () => {
      expect(condition).toBe(VERIFY_CONDITION);
      expect(condition).not.toContain('createJSON');
      // Why: the parsed body as JSON again is not the bytes the full signature covers.
      const { raw, body } = deliver();
      expect(JSON.stringify(body)).not.toBe(raw);
    });

    it('accepts a Hebrew payload signed by the server: headers, sender casing, or the body alone', () => {
      const { headers, body } = deliver();
      expect(check(headers, body)).toBe(true);
      const cased = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [
          k.replace(/(^|-)([a-z])/g, (_, d: string, c: string) => d + c.toUpperCase()),
          v,
        ]),
      );
      expect(check(cased, body)).toBe(true);
      // No headers reach the webhook: the flat body carries the same values.
      expect(check({}, body)).toBe(true);
      // The secret kept as the webhook's data instead of its parameters.
      expect(check(headers, body, {}, { secret })).toBe(true);
    });

    it('rejects forged, tampered, stale, unsigned and secret-less deliveries; the switch turns it off', () => {
      const { headers, body } = deliver();
      expect(check(headers, body, { secret: 'b'.repeat(48) })).toBe(false);
      const forged = deliver(undefined, 'b'.repeat(48));
      expect(check(forged.headers, forged.body)).toBe(false);
      expect(check({ ...headers, 'x-bines-delivery': '01JBOTHER' }, body)).toBe(false);
      expect(check({}, { ...body, event: { ...body.event, deliveryId: '01JBOTHER' } })).toBe(false);
      expect(check({ ...headers, 'x-bines-timestamp': String(Number(headers['x-bines-timestamp']) + 1) }, body)).toBe(
        false,
      );
      const stale = deliver(String(Date.now() - 11 * 60 * 1000));
      expect(check(stale.headers, stale.body)).toBe(false);
      expect(check({}, { event: body.event })).toBeFalsy();
      expect(check(headers, body, {})).toBeFalsy();
      expect(check({}, {}, { secret, verifySignature: false })).toBe(true);
    });
  });

  it('each trigger subscribes to its event, narrowed by the options chosen, as a flat subscription', () => {
    const attach = (key: string, parameters: Json) =>
      renderDeep(read(`webhooks/${key}/attach.json`).body, { parameters, webhook: { url: 'https://hook.make.com/x' } });
    for (const t of TRIGGERS) {
      const b = attach(t.key, {}) as Json;
      expect(b.event, t.key).toBe(t.event === 'subitem_status_changed' ? 'subitem_column_changed' : t.event);
      expect(b).toMatchObject({ url: 'https://hook.make.com/x', description: `Make: ${t.event}` });
      expect(b.config, t.key).toMatchObject({ include_item: true, format: 'flat' });
    }
    expect(attach('watchStatusChanged', { columnId: 'status', label: 'Done', groupId: 'g1' })).toMatchObject({
      event: 'status_changed',
      config: { include_item: true, column_id: 'status', label: 'Done' },
    });
    expect((attach('watchStatusChanged', {}) as Json).config).toMatchObject({ column_id: '', label: '' });
    expect(attach('watchItemsMovedToGroup', { groupId: 'g2', includeItem: false })).toMatchObject({
      config: { include_item: false, group_id: 'g2' },
    });
    expect(attach('watchAutomationSends', { channel: '  new-lead ' })).toMatchObject({
      config: { channel: 'new-lead' },
    });
    expect(attach('watchSubitemStatusChanged', { columnId: 'stage', label: 'Blocked' })).toMatchObject({
      event: 'subitem_column_changed',
      config: { column_id: 'stage', column_type: 'status', label: 'Blocked' },
    });
    expect(read('webhooks/watchItemsCreated/api.json').output).toBe('{{body.event}}');
  });

  it('pickers: columns of a type, labels by text, values labelled with their hint', () => {
    const columns = read('rpcs/listColumns/api.json').response as Json;
    const pick = (parameters: Json) =>
      (iml(columns.iterate.container.slice(2, -2), { parameters, body: SCHEMA }) as Json[])
        .filter((item) => iml(columns.iterate.condition.slice(2, -2), { parameters, item }))
        .map((item) => render(columns.output.label, { item }));
    expect(pick({})).toHaveLength(SCHEMA.columns.length);
    expect(pick({ kind: 'files' })).toHaveLength(1);
    expect(pick({ kind: 'status' })).toEqual(['Status (status)']);
    expect(pick({ kind: 'status', subitems: 'true' })).toEqual(['Stage (status)']);

    const values = read('rpcs/listValues/api.json') as Json;
    expect(values.url).toBe('/boards/{{parameters.boardId}}/columns/{{parameters.column_id}}/choices');
    const { label, value } = values.response.output as { label: string; value: string };
    const dana = { id: 'u1', text: 'Dana Levi', hint: 'dana@example.com' };
    const free = { id: null, text: 'free', hint: null };
    expect(render(label, { item: dana })).toBe('Dana Levi (dana@example.com)');
    expect(render(label, { item: free })).toBe('free');
    expect(render(value, { item: dana, parameters: { purpose: 'find' } })).toBe('Dana Levi');
    expect(render(value, { item: dana, parameters: { purpose: 'write' } })).toBe('u1');
    expect(render(value, { item: free, parameters: { purpose: 'filter' } })).toBe('free');
    expect(render(values.qs.subitems, { parameters: { subitems: true } })).toBe('true');
    expect(render(values.qs.subitems, { parameters: {} })).toBe('false');
  });

  it('upload: the presign body and the upload address (a local path goes to the instance)', () => {
    const [presign, put] = read('modules/uploadFile/api.json') as unknown as Json[];
    expect(
      renderDeep(presign!.body, {
        parameters: { fileName: 'a.pdf', data: Buffer.from('hello'), mime: 'application/pdf' },
      }),
    ).toEqual({ name: 'a.pdf', size: 5, mime: 'application/pdf' });
    expect(renderDeep(presign!.body, { parameters: { data: Buffer.from('') } })).toMatchObject({
      name: 'file',
      mime: 'application/octet-stream',
    });
    const url = (upload_url: string) =>
      render(put!.url, {
        connection: { baseUrl: 'https://crm.example.com/api/v1/' },
        temp: { presigned: { upload_url } },
      });
    expect(url('/files/up/1')).toBe('https://crm.example.com/files/up/1');
    expect(url('https://s3.example.com/x')).toBe('https://s3.example.com/x');
  });
});

/**
 * What the app leaves to the Bines OS API (its own tests: apps/api/test/integrations-flat.test.ts and
 * packages/shared/test/integration-values.test.ts): the modules only have to send and read the right shapes.
 */
describe('the API calls', () => {
  it('search filters: the module sends its rows as `rules` (column_id, operator, value, choice)', () => {
    const search = read('modules/searchItems/api.json');
    expect(search.body).toMatchObject({ rules: '{{parameters.filters}}', search: '{{parameters.search}}' });
    expect(search.pagination.body).toEqual({ cursor: '{{body.next_cursor}}' });
    const filters = (read('modules/searchItems/expect.json') as unknown as Json[])[0]!.options.nested[0];
    const fields = (filters.spec as Json[]).map((f) => f.name);
    expect(fields).toEqual(['column_id', 'operator', 'value']);
    expect(filters.spec[0].options.nested[0].name).toBe('choice');
  });

  it('modules send plain values and read flat items', () => {
    for (const m of ['createItem', 'updateItem', 'createSubitem', 'updateSubitem']) {
      const api = read(`modules/${m}/api.json`);
      expect(api.body.values, m).toBe('{{parameters.columns}}');
      expect(api.qs, m).toEqual({ format: 'flat' });
      expect(api.response.output, m).toBe('{{body}}');
    }
    for (const m of ['getItem', 'duplicateItem', 'moveItemToGroup', 'searchItems', 'findItems', 'getSubitems'])
      expect(read(`modules/${m}/api.json`).qs, m).toEqual({ format: 'flat' });
    const find = read('modules/findSubitems/api.json') as unknown as Json[];
    expect(find[1]!.url).toBe('/boards/{{temp.schema.subitems.board_id}}/items/find');
    expect(find[1]!.body.value).toBe('{{ifempty(parameters.choice, parameters.value)}}');
    expect(JSON.stringify(read('modules/findSubitems/expect.json'))).toContain(
      'rpc://listValues?purpose=find&subitems=true',
    );
    expect(read('modules/moveItemToBoard/api.json').body).not.toHaveProperty('mapping');
    expect(read('rpcs/columnFields/api.json')).toMatchObject({
      url: '/boards/{{parameters.boardId}}/fields',
      response: { output: { name: 'columns', type: 'collection', spec: '{{body.data}}' } },
    });
  });
});
