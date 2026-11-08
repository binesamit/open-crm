// SPDX-License-Identifier: MIT
/**
 * @bines/ext-sdk v1 (MIT) — the only way an extension's page talks to Bines OS (D27, docs/10-EXTENSIONS.md §4).
 *
 * The page runs in a sandboxed iframe on the extension's **own origin**. It never sees the user's session: the
 * host (Bines) hands it a short-lived token by postMessage — never in the URL — and the page calls the public REST
 * API with that token. What the token may do = the user's own rights × the scopes the admin approved × where the
 * page is shown (a board, a dashboard's boards the viewer sees, or nothing for a settings page). The token lives in
 * memory only (this closure); the SDK asks the host for a fresh one before it runs out.
 *
 * Dependency-free and written as erasable TypeScript, so a dev server can strip the types and serve it as is.
 * For an extension's **server** (automation blocks, triggers): `@bines/ext-sdk/server`.
 */
export const PROTOCOL = 'bines-ext';
export const PROTOCOL_VERSION = 1;

/** Where the page is shown (the manifest feature's type). */
export type ExtSurface =
  | 'board_view'
  | 'item_view'
  | 'board_menu_action'
  | 'batch_action'
  | 'dashboard_widget'
  | 'account_settings_page'
  | 'user_settings_page'
  | 'panel'
  | 'app_page';

export type ExtContext = {
  account_id: string;
  /** The board it is shown on ('' on a dashboard widget or a settings page). */
  board_id: string;
  installation_id: string;
  extension_key: string;
  feature: string;
  user: { id: string; name: string };
  theme: 'light' | 'dark';
  locale: 'he' | 'en';
  dir: 'rtl' | 'ltr';
  /** ת3+: where it is shown; older hosts omit it (a board view). */
  surface?: ExtSurface;
  /** An item tab, or a menu action from an item: the item. */
  item_id?: string | null;
  /** A menu / batch action: the selected items (one for an item menu, none for the board menu). */
  selection?: { item_ids: string[] };
  /**
   * The boards its token reads (only those the viewer may see): a dashboard widget's; a board view's own board plus
   * the boards a person picked for the tab (`pickBoards`).
   */
  board_ids?: string[];
  dashboard_id?: string | null;
  widget_id?: string | null;
  /** Shown in a modal frame (a menu / batch action, or `openModal`). */
  modal?: boolean;
  /** What `openModal({params})` passed. */
  params?: Record<string, unknown> | null;
};

export type ExtToken = { token: string; expires_at: string; api_base: string; scopes: string[] };

/** host → frame */
export type HostMessage =
  | { protocol: typeof PROTOCOL; v: number; type: 'init'; context: ExtContext; token: ExtToken }
  | { protocol: typeof PROTOCOL; v: number; type: 'context'; context: ExtContext }
  | { protocol: typeof PROTOCOL; v: number; type: 'reply'; id: number; ok: boolean; result?: unknown; error?: string };

/** frame → host */
export type FrameMessage =
  | { protocol: typeof PROTOCOL; v: number; type: 'ready' }
  | { protocol: typeof PROTOCOL; v: number; type: 'request'; id: number; action: HostAction; payload?: unknown };

/** What a page may ask the host to do. */
export type HostAction =
  | 'token'
  | 'resize'
  | 'notice'
  | 'notify'
  | 'openItemCard'
  | 'openModal'
  | 'closeModal'
  | 'pickBoards'
  | 'openWindow'
  | 'setBadge'
  | 'openAutomationBuilder'
  | 'setAutomationActive';

export type StorageScope = 'installation' | 'user';

/** An automation that uses one of this extension's own triggers (`automations(trigger)`). */
export type ExtAutomation = {
  id: string;
  board_id: string | null;
  name: string;
  active: boolean;
  /** As stored: `{ type: 'extension_trigger', block: '<extension>.<key>', with_item, inputs? }`. */
  trigger: Record<string, unknown>;
};
export type NotifyTone = 'info' | 'success' | 'error';

export class BinesApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

type Listener = (ctx: ExtContext) => void;

export type UploadedFile = { id: string; name: string; size: number; mime: string };

export type BinesSdk = {
  /** Resolves once the host has introduced itself (context + first token). */
  ready: () => Promise<ExtContext>;
  get: (what: 'context') => Promise<ExtContext>;
  /** A REST call (`/boards/:id/items` …) with the extension token; JSON in, JSON out. */
  api: <T = unknown>(
    method: string,
    path: string,
    opts?: { query?: Record<string, string>; body?: unknown },
  ) => Promise<T>;
  /** The view's board items (GET /boards/:id/items). */
  items: <T = unknown>() => Promise<T>;
  /** The items the page is about: a batch's selection, the item of an item tab / item menu, else none. */
  selection: () => Promise<string[]>;
  listen: (event: 'context', cb: Listener) => () => void;
  execute: (action: Exclude<HostAction, 'token'>, payload?: unknown) => Promise<unknown>;
  /** A toast in the app ("<extension>: <text>"), a few per 10 seconds. */
  notify: (text: string, opts?: { tone?: NotifyTone }) => Promise<void>;
  /**
   * Opens a page of this extension (same origin; `path` relative to this page) in a modal frame over the app.
   * Resolves with what that page passes to `closeModal(result)` — `undefined` when the user closed it.
   */
  openModal: (opts?: {
    path?: string;
    width?: number;
    height?: number;
    params?: Record<string, unknown>;
  }) => Promise<unknown>;
  /** In a modal frame: closes it, handing `result` to whoever opened it. */
  closeModal: (result?: unknown) => Promise<void>;
  /**
   * Opens a page of this extension (same origin; `path` relative to this page) in a new top-level window — for a
   * sign-in such as Google's, which will not load in a sandboxed window. Call it on the user's click. The window has
   * no opener and the page gets no handle: let your server tell the page how it ended.
   */
  openWindow: (path: string, opts?: { width?: number; height?: number }) => Promise<void>;
  /**
   * The count beside one of this extension's sidebar pages (`app_page`) — **this user's own** (`null` removes it, and
   * the account's count, if its server set one, shows again). `key` defaults to this page's feature. Above 99 the app
   * shows "99+"; screen readers hear the exact number. For the account's count or another member's, use its server
   * (`setAppPageBadge` in `@bines/ext-sdk/server`).
   */
  setBadge: (count: number | null, opts?: { key?: string }) => Promise<void>;
  /**
   * Opens the app's own automation builder in a dialog over the page, its trigger already set to one of **this
   * extension's own** `automation_trigger` keys (`config.with_item`: the trigger brings an item; `config.inputs`:
   * values of the trigger's manifest `inputs`, prefilled and locked — the automation then runs only for fires whose
   * payload carries the same values, e.g. `{ button: '<id>' }`). `board_id`: one of
   * the boards this page's token reads (default: the frame's board). Call it on the user's click; one at a time,
   * never from a modal. The member's own rights apply (who may not manage the board's automations is refused).
   * Resolves when the dialog closes: `{ saved: true, automation_id }` or `{ saved: false }`.
   */
  openAutomationBuilder: (opts: {
    trigger: string;
    config?: { with_item?: boolean; inputs?: Record<string, string> };
    board_id?: string;
  }) => Promise<{ saved: boolean; automation_id?: string }>;
  /**
   * The automations that use one of this extension's own triggers (`GET /ext/automations?trigger=`), on the boards
   * this page's token reads that this member reads — e.g. which of its buttons has a live automation. Read only.
   */
  automations: (trigger: string) => Promise<ExtAutomation[]>;
  /**
   * Switches on / off an automation that uses one of this extension's own triggers (e.g. from `automations()`), on a
   * board this page's token reads — with the member's own rights (who may not manage the board's automations is
   * refused). Resolves with its state.
   */
  setAutomationActive: (automationId: string, active: boolean) => Promise<{ active: boolean }>;
  /** The extension's own storage: shared by its users (`installation`) or per user (`user`, the default). */
  storage: {
    get: <T = unknown>(key: string, opts?: { scope?: StorageScope }) => Promise<T | null>;
    set: (key: string, value: unknown, opts?: { scope?: StorageScope }) => Promise<void>;
    delete: (key: string, opts?: { scope?: StorageScope }) => Promise<void>;
    list: (opts?: { scope?: StorageScope; prefix?: string }) => Promise<{ key: string; size: number }[]>;
  };
  files: {
    /**
     * Uploads a file (≤ 4 MB, needs `items:write`) as the user; with `item_id` + `column_id` it is attached to that
     * file cell too.
     */
    upload: (file: Blob, opts?: { name?: string; item_id?: string; column_id?: string }) => Promise<UploadedFile>;
  };
  /** Keeps the frame as tall as the page (ResizeObserver → `resize`). */
  autoResize: () => () => void;
  /**
   * The page's current token (renewed when it has under a minute left) — to hand to **your own server**, which asks
   * Bines who it belongs to (`POST /ext/introspect`). Send it in a header, never in a URL; never store it.
   */
  token: () => Promise<ExtToken>;
};

export type SdkOptions = {
  /** Pin the host origin (recommended in production): messages from anywhere else are ignored. */
  hostOrigin?: string;
  /** How long to wait for the host to answer a request (`openModal` waits until the modal closes). */
  timeoutMs?: number;
  /** For tests: another window / fetch. */
  window?: Window;
  fetch?: typeof fetch;
};

const isHostMessage = (d: unknown): d is HostMessage =>
  !!d && typeof d === 'object' && (d as { protocol?: unknown }).protocol === PROTOCOL;

/** An origin an unpinned SDK may accept `init` from: https, or a loopback host while developing. */
const trustedUnpinnedOrigin = (origin: string) =>
  /^https:\/\//.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

export const createBinesSdk = (opts: SdkOptions = {}): BinesSdk => {
  const win = opts.window ?? window;
  const doFetch = opts.fetch ?? win.fetch.bind(win);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let hostOrigin: string | null = opts.hostOrigin ?? null;
  let context: ExtContext | null = null;
  let token: ExtToken | null = null;
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Set<Listener>();
  let readyResolve: (ctx: ExtContext) => void = () => undefined;
  const readyPromise = new Promise<ExtContext>((r) => {
    readyResolve = r;
  });

  const post = (msg: FrameMessage) => {
    // Before the host introduced itself only `ready` (no secret) goes out, to the parent window.
    win.parent.postMessage(msg, hostOrigin ?? '*');
  };

  if (!hostOrigin && typeof console !== 'undefined')
    console.warn(
      '[bines-ext-sdk] hostOrigin is not pinned: the first https parent to send `init` becomes the host. Pass { hostOrigin } in production.',
    );

  win.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== win.parent || !isHostMessage(e.data)) return;
    if (hostOrigin && e.origin !== hostOrigin) return;
    const msg = e.data;
    if (msg.type === 'init') {
      // Unpinned: the host is learned from the first `init` — only from an https origin (or a loopback host in
      // development), never from a plain-http page that framed this one (audit 2026-10-10 web #1).
      if (!hostOrigin && !trustedUnpinnedOrigin(e.origin)) return;
      hostOrigin ??= e.origin;
      context = msg.context;
      token = msg.token;
      readyResolve(msg.context);
      listeners.forEach((l) => l(msg.context));
    } else if (msg.type === 'context') {
      context = msg.context;
      listeners.forEach((l) => l(msg.context));
    } else if (msg.type === 'reply') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error ?? 'host_error'));
    }
  });

  const request = async (action: HostAction, payload?: unknown, wait = timeoutMs): Promise<unknown> => {
    await readyPromise;
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      if (wait > 0)
        setTimeout(() => {
          if (pending.delete(id)) reject(new Error('host_timeout'));
        }, wait);
      post({ protocol: PROTOCOL, v: PROTOCOL_VERSION, type: 'request', id, action, payload });
    });
  };

  /** A token with at least a minute left — else a fresh one from the host. */
  const freshToken = async (force = false): Promise<ExtToken> => {
    await readyPromise;
    if (!force && token && new Date(token.expires_at).getTime() - Date.now() > 60_000) return token;
    token = (await request('token')) as ExtToken;
    return token;
  };

  /** One request with the token (retried once with a fresh token on 401); the answer as JSON. */
  const send = async <T>(
    method: string,
    path: string,
    o: { query?: Record<string, string>; body?: unknown; raw?: Blob; contentType?: string } = {},
  ) => {
    const once = async (t: ExtToken) => {
      const qs = o.query ? `?${new URLSearchParams(o.query).toString()}` : '';
      const base = hostOrigin ? new URL(t.api_base, hostOrigin).toString().replace(/\/$/, '') : t.api_base;
      const json = o.body !== undefined;
      return doFetch(`${base}${path}${qs}`, {
        method,
        // Never cookies: the token is the only credential an extension has.
        credentials: 'omit',
        headers: {
          authorization: `Bearer ${t.token}`,
          'x-account-id': context!.account_id,
          ...(json ? { 'content-type': 'application/json' } : {}),
          ...(o.raw ? { 'content-type': o.contentType || 'application/octet-stream' } : {}),
        },
        body: o.raw ?? (json ? JSON.stringify(o.body) : undefined),
      });
    };
    let res = await once(await freshToken());
    if (res.status === 401) res = await once(await freshToken(true));
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : null;
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new BinesApiError(res.status, err?.code ?? 'error', err?.message ?? res.statusText);
    }
    return data as T;
  };

  const call = <T>(method: string, path: string, o: { query?: Record<string, string>; body?: unknown } = {}) =>
    send<T>(method, path, o);

  const storagePath = (key: string, scope: StorageScope = 'user') => `/ext/storage/${scope}/${encodeURIComponent(key)}`;

  post({ protocol: PROTOCOL, v: PROTOCOL_VERSION, type: 'ready' });

  return {
    ready: () => readyPromise,
    get: async () => readyPromise.then(() => context!),
    api: call,
    items: async <T>() => {
      const ctx = await readyPromise;
      return call<T>('GET', `/boards/${encodeURIComponent(ctx.board_id)}/items`);
    },
    selection: async () => {
      await readyPromise;
      const ctx = context!;
      if (ctx.selection?.item_ids?.length) return [...ctx.selection.item_ids];
      return ctx.item_id ? [ctx.item_id] : [];
    },
    listen: (_event, cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    execute: (action, payload) =>
      request(
        action,
        payload,
        action === 'openModal' || action === 'pickBoards' || action === 'openAutomationBuilder' ? 0 : timeoutMs,
      ),
    notify: async (text, o = {}) => {
      await request('notify', { text, tone: o.tone ?? 'info' });
    },
    openModal: (o = {}) => request('openModal', o, 0),
    openWindow: async (path, o = {}) => {
      await request('openWindow', { path, ...o });
    },
    closeModal: async (result) => {
      await request('closeModal', { result });
    },
    setBadge: async (count, o = {}) => {
      await request('setBadge', { count, ...(o.key ? { key: o.key } : {}) });
    },
    // Waits for the dialog to close (no timeout), like openModal.
    openAutomationBuilder: (o) =>
      request('openAutomationBuilder', o, 0) as Promise<{ saved: boolean; automation_id?: string }>,
    setAutomationActive: (automationId, active) =>
      request('setAutomationActive', { automation_id: automationId, active }) as Promise<{ active: boolean }>,
    automations: async (trigger) =>
      (await send<{ data: ExtAutomation[] }>('GET', '/ext/automations', { query: { trigger } })).data,
    storage: {
      get: async <T>(key: string, o: { scope?: StorageScope } = {}) => {
        try {
          return (await send<{ value: T }>('GET', storagePath(key, o.scope))).value;
        } catch (e) {
          if (e instanceof BinesApiError && e.status === 404) return null;
          throw e;
        }
      },
      set: async (key, value, o = {}) => {
        await send('PUT', storagePath(key, o.scope), { body: { value } });
      },
      delete: async (key, o = {}) => {
        await send('DELETE', storagePath(key, o.scope));
      },
      list: async (o = {}) =>
        (
          await send<{ data: { key: string; size: number }[] }>('GET', `/ext/storage/${o.scope ?? 'user'}`, {
            query: o.prefix ? { prefix: o.prefix } : undefined,
          })
        ).data,
    },
    files: {
      upload: async (file, o = {}) => {
        const name = o.name ?? (file as Blob & { name?: string }).name ?? 'file';
        const uploaded = await send<UploadedFile>('POST', '/ext/files', {
          query: { name, ...(file.type ? { mime: file.type } : {}) },
          raw: file,
          contentType: file.type,
        });
        if (o.item_id && o.column_id)
          await send('POST', `/items/${encodeURIComponent(o.item_id)}/cells/${encodeURIComponent(o.column_id)}/files`, {
            body: { file_ids: [uploaded.id] },
          });
        return uploaded;
      },
    },
    autoResize: () => {
      const doc = win.document.documentElement;
      let last = 0;
      const sendSize = () => {
        const h = Math.ceil(doc.scrollHeight);
        if (h !== last) {
          last = h;
          void request('resize', { height: h }).catch(() => undefined);
        }
      };
      const ro = new ResizeObserver(sendSize);
      ro.observe(doc);
      sendSize();
      return () => ro.disconnect();
    },
    token: () => freshToken(),
  };
};
