// SPDX-License-Identifier: AGPL-3.0-only
// A sample board-view extension ("summary cards", D27 ת2) — for development and the E2E test only, never
// deployed. It reads the board's items through @bines/ext-sdk (served by serve.mjs as /sdk.js) and shows a few
// numbers. Everything from the API is rendered as text (textContent), never as HTML.
import { createBinesSdk } from './sdk.js';

const $ = (id) => document.getElementById(id);
const bines = createBinesSdk();

const applyContext = (ctx) => {
  document.documentElement.dir = ctx.dir;
  document.documentElement.lang = ctx.locale;
  document.documentElement.classList.toggle('dark', ctx.theme === 'dark');
};

const main = async () => {
  const ctx = await bines.ready();
  applyContext(ctx);
  bines.listen('context', applyContext);
  bines.autoResize();
  $('status').textContent = `שלום ${ctx.user.name || ''}`.trim();
  const { data } = await bines.items();
  const top = data.filter((i) => !i.parent_item_id);
  $('count').textContent = String(top.length);
  $('groups').textContent = String(new Set(top.map((i) => i.group_id)).size);
  const list = $('names');
  list.replaceChildren(
    ...top.slice(0, 10).map((i) => {
      const li = document.createElement('li');
      li.textContent = i.name;
      return li;
    }),
  );
  $('status').dataset.ready = '1';
};

// Writing needs `items:write`; this sample asks only for `boards:read`, so the API refuses (403 insufficient_scope).
$('write').addEventListener('click', async () => {
  try {
    await bines.api('POST', `/boards/${(await bines.get('context')).board_id}/items`, {
      body: { name: 'from sample' },
    });
    $('write-result').textContent = 'written';
  } catch (err) {
    $('write-result').textContent = err && err.code ? err.code : 'error';
  }
});

main().catch((err) => {
  $('status').textContent = `error: ${err && err.message ? err.message : err}`;
});
