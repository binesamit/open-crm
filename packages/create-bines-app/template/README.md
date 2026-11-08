# __APP_NAME__

A Bines OS extension (board view) made with `create-bines-app`. The full guide: in Bines, Administration →
Extensions → For developers (or the public page `https://<your Bines>/api/docs/extensions`).

## Develop

```sh
npm install
npm run dev        # http://localhost:__PORT__ — the page and /manifest.json
npm run server     # only with --server: the lifecycle endpoint on http://localhost:__SERVER_PORT__
```

In a **development** Bines (a production server refuses `localhost`): Administration → Extensions → add by URL →
`http://localhost:__PORT__/manifest.json` → approve the permissions → open a board → "+ view" → **__APP_NAME__**.

## Ship

1. Host the built page (`npm run build` → `dist/`) on your own **https** origin.
2. Print the production manifest: `node manifest.config.mjs https://ext.example.com` and host it next to the page.
3. Pin the host in `src/main.ts`: `createBinesSdk({ hostOrigin: 'https://your-bines.example.com' })`, and set
   `frame-ancestors` to your Bines origin.
4. Add it by URL in each account — or ask the platform owner to publish it in the catalog (security review).

Rules that keep everyone safe: ask only for the scopes you need; keep tokens in memory only; show API data as
text; verify every lifecycle signature and its timestamp; never log tokens or secrets.
