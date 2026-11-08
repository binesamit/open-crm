// SPDX-License-Identifier: AGPL-3.0-only
// The "sample kit" extension (D27 ת3–ת5) — development and E2E only, never deployed. One page that plays every
// framed slot by `?page=`: an item tab, a menu / batch action in a modal frame, a dashboard widget and a settings
// page. Everything from the API is shown as text (textContent), never as HTML.
import { createBinesSdk } from './sdk.js';

const $ = (id) => document.getElementById(id);
const page = new URLSearchParams(location.search).get('page') ?? 'item';
const bines = createBinesSdk();

const applyContext = (ctx) => {
  document.documentElement.dir = ctx.dir;
  document.documentElement.lang = ctx.locale;
  document.documentElement.classList.toggle('dark', ctx.theme === 'dark');
};

const show = (name) => {
  for (const s of document.querySelectorAll('section[data-page]')) s.hidden = s.dataset.page !== name;
};

const item = async (ctx) => {
  const it = await bines.api('GET', `/items/${encodeURIComponent(ctx.item_id)}`);
  $('item-name').textContent = it.name;
  $('item-note').addEventListener('click', async () => {
    try {
      await bines.api('POST', `/items/${encodeURIComponent(ctx.item_id)}/updates`, {
        body: { body: 'עדכון מלשונית התוסף' },
      });
      $('item-result').textContent = 'ok';
      await bines.notify('העדכון נכתב', { tone: 'success' });
    } catch (err) {
      $('item-result').textContent = err && err.code ? err.code : 'error';
    }
  });
};

const action = async () => {
  const ids = await bines.selection();
  $('sel-count').textContent = String(ids.length);
  $('sel-apply').addEventListener('click', async () => {
    let done = 0;
    for (const id of ids) {
      await bines.api('POST', `/items/${encodeURIComponent(id)}/updates`, { body: { body: 'סומן על ידי התוסף' } });
      done++;
    }
    $('sel-result').textContent = String(done);
    await bines.closeModal({ done });
  });
};

const widget = async (ctx) => {
  const boards = ctx.board_ids ?? [];
  let total = 0;
  for (const b of boards) {
    const { data } = await bines.api('GET', `/boards/${encodeURIComponent(b)}/items`);
    total += data.filter((i) => !i.parent_item_id).length;
  }
  $('w-count').textContent = String(total);
  $('w-boards').textContent = `${boards.length} לוחות`;
};

const settings = async () => {
  const current = await bines.storage.get('greeting', { scope: 'installation' });
  $('greeting').value = current ?? '';
  // Editable only once the stored value is in (typing earlier would be overwritten by it).
  $('greeting').disabled = false;
  $('save').disabled = false;
  $('save').addEventListener('click', async () => {
    await bines.storage.set('greeting', $('greeting').value, { scope: 'installation' });
    $('saved').textContent = 'saved';
  });
};

const main = async () => {
  const ctx = await bines.ready();
  applyContext(ctx);
  bines.listen('context', applyContext);
  show(page);
  $('status').textContent = `${ctx.surface ?? 'board_view'} · ${ctx.user.name || ''}`;
  if (page === 'item') await item(ctx);
  else if (page === 'action') await action(ctx);
  else if (page === 'widget') await widget(ctx);
  else if (page === 'settings') await settings(ctx);
  if (page !== 'widget') bines.autoResize();
  $('status').dataset.ready = '1';
};

main().catch((err) => {
  $('status').textContent = `error: ${err && err.message ? err.message : err}`;
});
