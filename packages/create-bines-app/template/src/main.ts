// SPDX-License-Identifier: MIT
// Your board view (D27): it runs in a sandboxed iframe on your own origin and talks to Bines only through
// @bines/ext-sdk — the host hands it a short-lived token by postMessage (never in the URL). Everything from the API
// is shown as text (textContent), never as HTML.
import { createBinesSdk, type ExtContext } from '@bines/ext-sdk';

type Item = { id: string; name: string; parent_item_id?: string | null };

const $ = (id: string) => document.getElementById(id)!;
// The host is pinned from the build: `VITE_BINES_ORIGIN=https://your-bines.example.com` in `.env.production`.
// Without it the SDK warns and takes the first https (or localhost) parent — fine while developing, not in production.
const hostOrigin = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_BINES_ORIGIN;
const bines = createBinesSdk(hostOrigin ? { hostOrigin } : {});

const applyContext = (ctx: ExtContext) => {
  document.documentElement.dir = ctx.dir;
  document.documentElement.lang = ctx.locale;
  document.documentElement.classList.toggle('dark', ctx.theme === 'dark');
};

const main = async () => {
  const ctx = await bines.ready();
  applyContext(ctx);
  bines.listen('context', applyContext);
  bines.autoResize();
  $('status').textContent = `${ctx.user.name} · ${ctx.extension_key}`;
  const { data } = await bines.items<{ data: Item[] }>();
  const top = data.filter((i) => !i.parent_item_id);
  $('count').textContent = String(top.length);
  $('names').replaceChildren(
    ...top.slice(0, 20).map((i) => {
      const li = document.createElement('li');
      li.textContent = i.name;
      li.addEventListener('click', () => void bines.execute('openItemCard', { itemId: i.id }));
      return li;
    }),
  );
};

main().catch((err: unknown) => {
  $('status').textContent = err instanceof Error ? err.message : String(err);
});
