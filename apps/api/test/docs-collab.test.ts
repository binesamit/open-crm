// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLAB_PATH, createCollab, type Collab } from '../src/modules/docs/collab';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * M8 ד1 — live co-editing over a real WebSocket: the Hocuspocus server of the API on an HTTP server, two clients
 * on one doc see each other's text; a viewer connects read-only (its changes reach no one); the session cookie
 * or a collab token authenticates; another origin, another account's doc, a doc one cannot read — refused.
 */
let t: TestContext;
let collab: Collab;
let server: Server;
let url: string;
let admin: string;
let bob: string; // member
let vera: string; // account viewer
let acmeId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const textOf = (doc: Y.Doc) =>
  doc
    .getXmlFragment('default')
    .toArray()
    .map((el) =>
      (el as Y.XmlElement)
        .toArray()
        .map((x) => (x as Y.XmlText).toString())
        .join(''),
    )
    .join('\n');

const typeParagraph = (doc: Y.Doc, text: string) =>
  doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    doc.getXmlFragment('default').push([p]);
    const tx = new Y.XmlText();
    p.push([tx]);
    tx.insert(0, text);
  });

type Client = { doc: Y.Doc; provider: HocuspocusProvider; failed: () => string | null };
const clients: Client[] = [];

/** A browser-like client: by token (from the API), or by the session cookie (the app's way). */
const connect = async (
  name: string,
  auth: { token: string } | { cookie: string; origin?: string },
): Promise<Client> => {
  const doc = new Y.Doc();
  let failure: string | null = null;
  const headers = 'cookie' in auth ? { cookie: auth.cookie, origin: auth.origin ?? WEB_ORIGIN } : undefined;
  // Node's WebSocket (undici) takes request headers — a browser sends the cookie and origin by itself.
  const Ws = headers
    ? class extends WebSocket {
        constructor(u: string | URL) {
          super(u, { headers } as unknown as string[]);
        }
      }
    : WebSocket;
  const provider = new HocuspocusProvider({
    url,
    name,
    document: doc,
    token: 'token' in auth ? auth.token : 'session',
    WebSocketPolyfill: Ws,
    onAuthenticationFailed: ({ reason }) => {
      failure = reason || 'denied';
    },
  } as ConstructorParameters<typeof HocuspocusProvider>[0]);
  const c = { doc, provider, failed: () => failure };
  clients.push(c);
  return c;
};
const synced = (c: Client) => until(() => c.provider.isSynced || !!c.failed());
const tokenFor = async (cookie: string, docId: string) =>
  (await body(await as(cookie).post(`/docs/${docId}/collab-token`, {}))).token as string;

beforeAll(async () => {
  t = await createTestContext();
  collab = createCollab(t.deps, { debounce: 50, maxDebounce: 200 });
  server = createServer((_req, res) => res.end());
  collab.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${COLLAB_PATH}`;

  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await as(admin).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(async () => {
  for (const c of clients) c.provider.destroy();
  await collab.close();
  await new Promise((r) => server.close(r));
  await t.close();
});

describe('co-editing a doc', () => {
  it('two editors see each other; a viewer reads live but cannot write; what was typed is saved', async () => {
    const doc = await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Together' }));
    const name = doc.collab_name as string;
    const a = await connect(name, { cookie: admin });
    const b = await connect(name, { token: await tokenFor(bob, doc.id) });
    const v = await connect(name, { cookie: vera });
    await Promise.all([synced(a), synced(b), synced(v)]);
    expect([a.failed(), b.failed(), v.failed()]).toEqual([null, null, null]);
    expect(v.provider.authorizedScope).toBe('readonly');
    expect(a.provider.authorizedScope).toBe('read-write');

    typeParagraph(a.doc, 'שלום מדנה');
    await until(() => textOf(b.doc) === 'שלום מדנה' && textOf(v.doc) === 'שלום מדנה');
    typeParagraph(b.doc, 'hello from Bob');
    await until(() => textOf(a.doc) === 'שלום מדנה\nhello from Bob');

    // The viewer's local change is refused by the server: nobody else gets it.
    typeParagraph(v.doc, 'viewer was here');
    await new Promise((r) => setTimeout(r, 300));
    expect(textOf(a.doc)).toBe('שלום מדנה\nhello from Bob');

    // Saved (debounced): the content and text without a WebSocket.
    let text = '';
    const end = Date.now() + 5000;
    while (Date.now() < end && text !== 'שלום מדנה\nhello from Bob') {
      text = (await body(await as(bob).get(`/docs/${doc.id}/content`))).text;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(text).toBe('שלום מדנה\nhello from Bob');

    // Presence: each client sees the others' awareness states.
    a.provider.setAwarenessField('user', { name: 'Admin', color: '#00854d' });
    await until(() =>
      [...b.provider.awareness!.getStates().values()].some(
        (s) => (s as { user?: { name?: string } }).user?.name === 'Admin',
      ),
    );
  });

  it('refuses a doc one cannot read, a forged token, and a foreign origin', async () => {
    const secret = await body(await as(bob).post(`/workspaces/${wsId}/docs`, { name: 'Bob only', kind: 'private' }));
    const denied = await connect(secret.collab_name, { cookie: vera });
    await until(() => !!denied.failed());

    const doc = await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Open' }));
    const forged = await connect(doc.collab_name, { token: `${(await tokenFor(admin, doc.id)).split('.')[0]}.AAAA` });
    await until(() => !!forged.failed());
    // A token is for one doc only.
    const other = await connect(secret.collab_name, { token: await tokenFor(admin, doc.id) });
    await until(() => !!other.failed());

    // Another site's page cannot open the socket with the user's cookie.
    const foreign = new WebSocket(url, {
      headers: { cookie: admin, origin: 'https://evil.test' },
    } as unknown as string[]);
    const outcome = await new Promise<string>((resolve) => {
      foreign.onopen = () => resolve('open');
      foreign.onerror = () => resolve('error');
    });
    expect(outcome).toBe('error');
  });

  it('access changes reach open connections: demoted → read-only, removed → refused', async () => {
    const doc = await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Draft', kind: 'private' }));
    const users = (await body(await as(admin).get('/users'))).data as Json[];
    const id = (email: string) => users.find((u) => u.email === email)!.user_id as string;
    const members = (level: string | null) => ({
      members: [
        { type: 'user', id: id('admin@acme.test'), level: 'owner' },
        ...(level ? [{ type: 'user', id: id('bob@acme.test'), level }] : []),
      ],
    });
    await as(admin).put(`/docs/${doc.id}/members`, members('editor'));
    const c = await connect(doc.collab_name, { cookie: bob });
    await synced(c);
    expect(c.provider.authorizedScope).toBe('read-write');

    await as(admin).put(`/docs/${doc.id}/members`, members('viewer'));
    await until(() => c.provider.authorizedScope === 'readonly' && c.provider.isSynced);

    await as(admin).put(`/docs/${doc.id}/members`, members(null));
    await until(() => !!c.failed());
  });

  it('guests (): a shareable doc only, read-only unless an editor; a private doc refuses them', async () => {
    const doc = await body(
      await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'For the client', kind: 'shareable' }),
    );
    const invited = await as(admin).post(`/docs/${doc.id}/invite`, {
      emails: ['gail@guest.test'],
      role: 'guest',
      level: 'viewer',
    });
    expect(invited.status).toBe(200);
    const gail = await join('gail@guest.test');
    const v = await connect(doc.collab_name, { cookie: gail });
    await synced(v);
    expect(v.failed()).toBeNull();
    expect(v.provider.authorizedScope).toBe('readonly');

    const users = (await body(await as(admin).get('/users'))).data as Json[];
    const id = (email: string) => users.find((u) => u.email === email)!.user_id as string;
    await as(admin).put(`/docs/${doc.id}/members`, {
      members: [
        { type: 'user', id: id('admin@acme.test'), level: 'owner' },
        { type: 'user', id: id('gail@guest.test'), level: 'editor' },
      ],
    });
    await until(() => v.provider.authorizedScope === 'read-write' && v.provider.isSynced);

    // Not shareable any more: the guest is refused, though still listed as a member.
    await as(admin).patch(`/docs/${doc.id}`, { kind: 'private' });
    await until(() => !!v.failed());
  });
});
