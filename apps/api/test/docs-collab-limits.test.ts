// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COLLAB_CLOSE_TOO_FAST,
  COLLAB_CLOSE_TOO_LARGE,
  COLLAB_PATH,
  createCollab,
  type Collab,
  type CollabOptions,
} from '../src/modules/docs/collab';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * S-92 — a collaborative document's size is enforced, not only logged: an edit that would take it past the cap is
 * refused and the socket closed with 4413 (what was saved stays); a connection sending too fast is closed with 4429.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);
const CAP = 20_000;

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const typeParagraph = (doc: Y.Doc, text: string) =>
  doc.transact(() => {
    const p = new Y.XmlElement('paragraph');
    doc.getXmlFragment('default').push([p]);
    const tx = new Y.XmlText();
    p.push([tx]);
    tx.insert(0, text);
  });

type Server_ = { collab: Collab; server: Server; url: string };
const servers: Server_[] = [];
const providers: HocuspocusProvider[] = [];

const start = async (opts: CollabOptions): Promise<Server_> => {
  const collab = createCollab(t.deps, { debounce: 50, maxDebounce: 200, ...opts });
  const server = createServer((_req, res) => res.end());
  collab.attach(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const s = { collab, server, url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}${COLLAB_PATH}` };
  servers.push(s);
  return s;
};

/** A client by session cookie; records the close codes the server sent. */
const connect = (url: string, name: string, stopOn?: number) => {
  const doc = new Y.Doc();
  const codes: number[] = [];
  const headers = { cookie: admin, origin: WEB_ORIGIN };
  const Ws = class extends WebSocket {
    constructor(u: string | URL) {
      super(u, { headers } as unknown as string[]);
    }
  };
  const provider: HocuspocusProvider = new HocuspocusProvider({
    url,
    name,
    document: doc,
    token: 'session',
    WebSocketPolyfill: Ws,
    // As the web client does (features/docs/collab.ts): its own onClose runs before the socket schedules a
    // reconnect, so turning `shouldConnect` off there stops it.
    onClose: ({ event }: { event: { code: number } }) => {
      codes.push(event.code);
      if (stopOn === event.code) provider.configuration.websocketProvider.shouldConnect = false;
    },
  } as ConstructorParameters<typeof HocuspocusProvider>[0]);
  providers.push(provider);
  return { doc, provider, codes };
};

const savedText = async (docId: string) => (await body(await as(admin).get(`/docs/${docId}/content`))).text as string;

beforeAll(async () => {
  t = await createTestContext();
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
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
});
afterAll(async () => {
  for (const p of providers) p.destroy();
  for (const s of servers) {
    await s.collab.close();
    await new Promise((r) => s.server.close(r));
  }
  await t.close();
});

describe('S-92: collaborative document limits', () => {
  it('an edit past the size cap is refused (4413) and never saved; edits under it are', async () => {
    const { url, collab } = await start({ maxDocBytes: CAP });
    const doc = await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Big' }));
    const c = connect(url, doc.collab_name);
    await until(() => c.provider.isSynced);

    typeParagraph(c.doc, 'small start');
    await until(() => (collab.hocuspocus.documents.get(doc.collab_name)?.getXmlFragment('default').length ?? 0) === 1);
    let text = '';
    for (const end = Date.now() + 5000; Date.now() < end && text !== 'small start';) {
      text = await savedText(doc.id);
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(text).toBe('small start');

    typeParagraph(c.doc, 'x'.repeat(CAP + 1000));
    await until(() => c.codes.includes(COLLAB_CLOSE_TOO_LARGE));
    c.provider.destroy();
    // The server's copy never took it, and nothing above the cap reached the database.
    const live = collab.hocuspocus.documents.get(doc.collab_name);
    if (live) expect(Y.encodeStateAsUpdate(live).byteLength).toBeLessThanOrEqual(CAP);
    await new Promise((r) => setTimeout(r, 400));
    expect(await savedText(doc.id)).toBe('small start');
  });

  it('a client that stops on 4413 (as the web app does) does not reconnect', async () => {
    const { url, collab } = await start({ maxDocBytes: CAP });
    const doc = await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Stop' }));
    const c = connect(url, doc.collab_name, COLLAB_CLOSE_TOO_LARGE);
    await until(() => c.provider.isSynced);
    typeParagraph(c.doc, 'y'.repeat(CAP + 1000));
    await until(() => c.codes.includes(COLLAB_CLOSE_TOO_LARGE));
    let opened = 0;
    c.provider.configuration.websocketProvider.on('open', () => opened++);
    await new Promise((r) => setTimeout(r, 2500));
    // (the provider reports one close to its own onClose twice — socket and provider level)
    expect(new Set(c.codes)).toEqual(new Set([COLLAB_CLOSE_TOO_LARGE]));
    expect(opened).toBe(0);
    expect(c.provider.configuration.websocketProvider.status).toBe('disconnected');
    expect(collab.hocuspocus.getConnectionsCount()).toBe(0);
    c.provider.destroy();
  });

  it('a connection sending too fast is closed (4429)', async () => {
    const { url } = await start({ messageRate: { max: 20, windowMs: 60_000 } });
    const doc = await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Fast' }));
    const c = connect(url, doc.collab_name);
    await until(() => c.provider.isSynced);
    for (let i = 0; i < 60; i++) typeParagraph(c.doc, `line ${i}`);
    await until(() => c.codes.includes(COLLAB_CLOSE_TOO_FAST));
    c.provider.destroy();
  });
});
