# Quickstart — build your first Bines OS extension

This hands-on tutorial is for developers writing their first extension. You build **"Quick list"**: a board view that lists the board's items, lets each user pin favourites
(saved in the extension's own storage), opens an item's card on click, and adds new items. Along the way you meet the
manifest, the consent screen, the SDK, scopes and versioned updates.

Time: about 45 minutes. Reference for everything used here: [`README.md`](README.md).

---

## 0. What you need

- Node.js 22+ and npm.
- A Bines OS where you are an **account admin**, one of:
  - **A local Bines** (recommended for development) — needs a clone of the Bines repository, Docker and pnpm.
    A development Bines accepts `http://localhost` extension origins.
  - **A hosted Bines** — then your dev server must be reachable on a public **HTTPS** address (an HTTPS tunnel), because
    a production Bines refuses `http://` and `localhost` origins. Replace `http://localhost:5180` below with your tunnel
    URL.

## 1. Run Bines locally

From the Bines repository root:

```sh
docker compose up -d        # Postgres, Mailpit (mail), MinIO (files)
pnpm install
cp .env.example .env        # if you have no .env yet
pnpm db:migrate
pnpm db:seed
pnpm dev                    # web on http://localhost:5173, API on http://localhost:3000
```

Sign in at <http://localhost:5173> as an account admin and open (or create) a board with a few items.

## 2. Scaffold the extension

Still from the repository root (the scaffolder links the SDK from `packages/ext-sdk`):

```sh
node packages/create-bines-app/index.mjs ../quick-list --name "Quick list"
cd ../quick-list
npm install
npm run dev                 # http://localhost:5180 (the page) and http://localhost:5180/manifest.json
```

Options: `--id <id>` (default: the folder name), `--port <n>` (default 5180), `--server` (also a lifecycle server,
see README §11).

You get:

| File | What |
|---|---|
| `manifest.config.mjs` | builds the manifest; the dev server serves it at `/manifest.json` with the local origin |
| `vite.config.ts` | dev server on `localhost:5180`, `frame-ancestors` header, the `/manifest.json` route |
| `index.html`, `src/main.ts`, `src/style.css` | the page |

Open <http://localhost:5180/manifest.json>. It looks like this:

```json
{
  "manifest_version": 1,
  "id": "quick-list",
  "name": "Quick list",
  "version": "0.1.0",
  "description": "A board view built with create-bines-app.",
  "publisher": { "name": "You", "email": "you@example.com" },
  "permissions": ["boards:read"],
  "origins": ["http://localhost:5180"],
  "features": [{ "type": "board_view", "key": "main", "name": "Quick list", "url": "http://localhost:5180/index.html" }]
}
```

## 3. Install it in your account

1. In Bines: **Administration → Extensions → For developers**.
2. Choose **By address**, paste `http://localhost:5180/manifest.json`, press **Check**.
3. The consent screen shows what the extension adds (one board view) and what it may do ("read boards"), plus a
   development-mode notice. Approve.
4. Open a board → **+ view** → **Quick list**. The starter page shows your name and the first 20 items.

## 4. Write the page

Replace `index.html`:

```html
<!doctype html>
<html lang="he" dir="rtl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Quick list</title>
    <link rel="stylesheet" href="/src/style.css" />
  </head>
  <body>
    <main>
      <p id="status">…</p>
      <p><strong id="count">–</strong> items</p>
      <form id="add">
        <input id="new-name" placeholder="New item" maxlength="255" />
        <button type="submit">Add</button>
      </form>
      <ul id="list"></ul>
    </main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

Replace `src/main.ts`:

```ts
import { BinesApiError, createBinesSdk, type ExtContext } from '@bines/ext-sdk';

type Item = { id: string; name: string; parent_item_id: string | null };

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// In production pin the host: createBinesSdk({ hostOrigin: 'https://your-bines.example.com' }).
const bines = createBinesSdk();
let ctx: ExtContext;
let pinned: string[] = [];

const applyContext = (c: ExtContext) => {
  document.documentElement.dir = c.dir;
  document.documentElement.lang = c.locale;
  document.documentElement.classList.toggle('dark', c.theme === 'dark');
};

// Everything from the API goes on the page as text — never as HTML.
const render = (items: Item[]) => {
  const top = items.filter((i) => !i.parent_item_id);
  top.sort((a, b) => Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)));
  $('count').textContent = String(top.length);
  $('list').replaceChildren(
    ...top.map((item) => {
      const li = document.createElement('li');
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.textContent = pinned.includes(item.id) ? '★' : '☆';
      pin.addEventListener('click', () => void togglePin(item.id));
      const name = document.createElement('span');
      name.textContent = item.name;
      name.addEventListener('click', () => void bines.execute('openItemCard', { itemId: item.id }));
      li.append(pin, ' ', name);
      return li;
    }),
  );
};

const load = async () => {
  const { data } = await bines.items<{ data: Item[] }>();
  render(data);
};

const togglePin = async (id: string) => {
  pinned = pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id];
  await bines.storage.set('pinned', pinned); // scope 'user' (the default): each user has their own pins
  await load();
};

const addItem = async (name: string) => {
  try {
    await bines.api('POST', `/boards/${encodeURIComponent(ctx.board_id)}/items`, { body: { name } });
    await bines.notify(`Added: ${name}`, { tone: 'success' });
    await load();
  } catch (err) {
    if (err instanceof BinesApiError && err.code === 'insufficient_scope')
      await bines.notify('Adding items needs the "items:write" permission', { tone: 'error' });
    else throw err;
  }
};

const main = async () => {
  ctx = await bines.ready();
  applyContext(ctx);
  bines.listen('context', (c) => {
    ctx = c;
    applyContext(c);
  });
  bines.autoResize();
  $('status').textContent = `${ctx.user.name} · ${ctx.extension_key}`;
  pinned = (await bines.storage.get<string[]>('pinned')) ?? [];
  await load();
  $('add').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $<HTMLInputElement>('new-name');
    const name = input.value.trim();
    if (!name) return;
    input.value = '';
    void addItem(name);
  });
};

main().catch((err: unknown) => {
  $('status').textContent = err instanceof Error ? err.message : String(err);
});
```

Save. Vite reloads the frame. Pins work (they live in the extension's storage, per user). Click a name: the item card
opens. Try **Add**: you get the error toast — the extension only has `boards:read`. That is the point of the next step.

What you used: `ready`, `listen('context')`, `autoResize`, `items`, `storage.get/set`, `execute('openItemCard')`,
`api`, `notify`, `BinesApiError` — all documented in README §7.

## 5. Ask for a new permission (a versioned update)

Edit `manifest.config.mjs`:

```js
  version: '0.2.0',
  // …
  permissions: ['boards:read', 'items:write'],
```

The installed copy does **not** pick this up silently: a new scope needs the admin's consent.

1. **Administration → Extensions → Installed → Quick list → Check for update** (Bines also checks once a day).
2. The update is listed under **Updates**, showing exactly what is new ("create and change items"). Approve it.
3. Back on the board, **Add** now creates items. In the board's activity the change shows as made "via Quick list",
   and it can be undone like any other change.

Had you only changed code or text (same scopes, origins and features) with a higher `version`, the update would have
been applied automatically.

## 6. (Optional) Show the same page as an item tab

Add a second feature to the manifest in `manifest.config.mjs`:

```js
  features: [
    { type: 'board_view', key: 'main', name: 'Quick list', url: `${origin}/index.html` },
    { type: 'item_view', key: 'item', name: 'Quick list', url: `${origin}/index.html` },
  ],
```

Bump `version` to `0.3.0` and approve the update (a new feature needs consent). In the page, `ctx.surface` is now
`'item_view'` and `ctx.item_id` is the open item; for example:

```ts
const ids = await bines.selection(); // [item_id] in an item tab, the selection in a batch action, else []
```

Other surfaces work the same way: `board_menu_action` and `batch_action` open your page in a modal, and
`dashboard_widget` gets `ctx.board_ids` instead of a board (README §4).

## 7. Ship it

1. Host the page on your HTTPS origin:

   ```sh
   npm run build                                          # → dist/
   node manifest.config.mjs https://quick-list.example.com 2> dist/manifest.json
   ```

   (The template's script prints the manifest on **stderr**, hence `2>`.)

2. In `src/main.ts`, pin the host: `createBinesSdk({ hostOrigin: 'https://your-bines.example.com' })`, then rebuild.
3. Make your host send `Content-Security-Policy: frame-ancestors https://your-bines.example.com` (and ideally
   `default-src 'self'; connect-src https://your-bines.example.com`).
4. In the production Bines: **Administration → Extensions → For developers → By address** →
   `https://quick-list.example.com/manifest.json`. Because the origin changed from `localhost`, this is a new install.
5. Want every account of that Bines to see it in the **Store** tab? Send the platform owner the manifest URL and your
   answers to the review checklist (README §15).

## 8. Before you call it done

- [ ] Every scope in `permissions` is needed, and the page copes with `403 insufficient_scope`.
- [ ] Platform data is rendered with `textContent`, never `innerHTML`.
- [ ] No token is stored or logged; `hostOrigin` is pinned in production.
- [ ] `frame-ancestors` names only your Bines origin.
- [ ] The page follows `dir` (RTL in Hebrew), `locale` and `theme`.
- [ ] `version` bumped for every release; `id` and feature `key`s never change.

Next: automation actions and triggers, your own server, and data packs — README §10–§12. Working examples of every
surface are in `extensions/summary-cards/kit.js` (served by `node extensions/summary-cards/serve.mjs`).
