// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The Bines REST API as this extension's service user (OAuth client_credentials, @bines/ext-sdk/server) — only
 * the calls the sync needs, behind an interface the tests replace.
 */
import { BinesServerError, createServerClient, type ServerCredentials } from '@bines/ext-sdk/server';
import type { BinesItem, ItemWrite } from './mapping';

export type Introspection =
  | { active: false }
  | {
      active: true;
      user: { id: string; name: string; email: string };
      account_id: string;
      feature: string;
      expires_at: string;
    };

export type BoardInfo = {
  id: string;
  name: string;
  columns: { id: string; type: string; title: string }[];
  groups: { id: string; title: string }[];
};

export type HookInfo = { id: string; event: string; url: string; is_active: boolean };

export interface BinesApi {
  me(): Promise<{ id: string }>;
  /**
   * Which installation and account these credentials belong to (the token endpoint says so). An `installed` call is
   * signed with a secret it brings itself, so only this ties it to the installation it names.
   */
  grant(): Promise<{ installation_id: string; account_id: string }>;
  introspect(token: string): Promise<Introspection>;
  listBoards(): Promise<{ id: string; name: string }[]>;
  getBoard(id: string): Promise<BoardInfo>;
  getItem(id: string): Promise<BinesItem | null>;
  listItems(boardId: string): Promise<BinesItem[]>;
  createItem(boardId: string, body: ItemWrite): Promise<BinesItem>;
  updateItem(id: string, body: Partial<ItemWrite>): Promise<BinesItem>;
  /** Soft delete (the item goes to the trash). */
  deleteItem(id: string): Promise<void>;
  archiveItem(id: string): Promise<void>;
  postUpdate(itemId: string, body: string): Promise<void>;
  /** The account's members: id → email (needs `users:read`). */
  listMembers(): Promise<{ user_id: string; email: string; name: string }[]>;
  createWebhook(
    boardId: string,
    body: { url: string; event: string; secret: string; description: string },
  ): Promise<HookInfo>;
  listWebhooks(boardId: string): Promise<HookInfo[]>;
  deleteWebhook(id: string): Promise<void>;
}

export const binesApi = (creds: ServerCredentials, opts: { fetch?: typeof fetch } = {}): BinesApi => {
  const c = createServerClient(creds, opts);
  const notFound = (e: unknown) => e instanceof BinesServerError && e.status === 404;
  return {
    me: async () => ({ id: (await c.api<{ user: { id: string } }>('GET', '/auth/me')).user.id }),
    grant: async () => {
      const res = await (opts.fetch ?? fetch)(creds.token_endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${btoa(`${encodeURIComponent(creds.client_id)}:${encodeURIComponent(creds.client_secret)}`)}`,
        },
        body: 'grant_type=client_credentials',
      });
      const data = (await res.json()) as { installation_id?: string; account_id?: string; error?: string };
      if (!res.ok || !data.installation_id || !data.account_id)
        throw new BinesServerError(res.status, data.error ?? 'token_failed', 'token');
      return { installation_id: data.installation_id, account_id: data.account_id };
    },
    introspect: (token) => c.api<Introspection>('POST', '/ext/introspect', { token }),
    listBoards: async () => (await c.api<{ data: { id: string; name: string }[] }>('GET', '/boards')).data,
    getBoard: (id) => c.api<BoardInfo>('GET', `/boards/${encodeURIComponent(id)}`),
    getItem: async (id) => {
      try {
        return await c.api<BinesItem>('GET', `/items/${encodeURIComponent(id)}`);
      } catch (e) {
        if (notFound(e)) return null;
        throw e;
      }
    },
    listItems: async (boardId) =>
      (await c.api<{ data: BinesItem[] }>('GET', `/boards/${encodeURIComponent(boardId)}/items`)).data,
    createItem: (boardId, body) => c.api<BinesItem>('POST', `/boards/${encodeURIComponent(boardId)}/items`, body),
    updateItem: async (id, body) => {
      try {
        return await c.api<BinesItem>('PATCH', `/items/${encodeURIComponent(id)}`, body);
      } catch (e) {
        // A board that computes its names refuses a name (409 item_name_computed): the rest still goes in.
        if (e instanceof BinesServerError && e.status === 409 && body.name !== undefined) {
          const { name: _name, ...rest } = body;
          return c.api<BinesItem>('PATCH', `/items/${encodeURIComponent(id)}`, rest);
        }
        throw e;
      }
    },
    deleteItem: async (id) => {
      try {
        await c.api('DELETE', `/items/${encodeURIComponent(id)}`);
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
    archiveItem: async (id) => {
      try {
        await c.api('POST', `/items/${encodeURIComponent(id)}/archive`, {});
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
    postUpdate: async (itemId, body) => {
      await c.api('POST', `/items/${encodeURIComponent(itemId)}/updates`, { body });
    },
    listMembers: async () =>
      (await c.api<{ data: { user_id: string; email: string; name: string }[] }>('GET', '/users')).data,
    createWebhook: (boardId, body) => c.api<HookInfo>('POST', `/boards/${encodeURIComponent(boardId)}/webhooks`, body),
    listWebhooks: async (boardId) =>
      (await c.api<{ data: HookInfo[] }>('GET', `/boards/${encodeURIComponent(boardId)}/webhooks`)).data,
    deleteWebhook: async (id) => {
      try {
        await c.api('DELETE', `/webhooks/${encodeURIComponent(id)}`);
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    },
  };
};
