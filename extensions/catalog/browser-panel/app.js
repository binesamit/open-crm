// SPDX-License-Identifier: AGPL-3.0-only
// "פאנל דפדפן" — a catalogue extension (panel): the strip above the app's own item card in a browser side panel
//. The browser extension hands the host what the tab shows (`params.url`, `params.title`
// `params.selection`); this page finds the contact and asks the host to open its card. Walking-skeleton step: it
// searches by the selected text, else by the address's last path part. Site rules and profiles come next.
// Everything read from the API is shown as text.
import { $, applyContext, el, fail, sdk, tr } from '../common.js';

const bines = sdk();

/** What to look for, in order: the selected text, else the last part of the address's path. */
export const lookupTerms = (params) => {
  const out = [];
  const sel = typeof params?.selection === 'string' ? params.selection.trim() : '';
  if (sel) out.push(sel.slice(0, 120));
  try {
    const last = new URL(String(params?.url ?? '')).pathname.split('/').filter(Boolean).pop();
    if (last && last.length >= 4) out.push(decodeURIComponent(last).slice(0, 120));
  } catch {
    // no address
  }
  return [...new Set(out)];
};

let run = 0;
const lookup = async (ctx) => {
  const mine = ++run;
  const terms = lookupTerms(ctx.params);
  const list = $('matches');
  list.replaceChildren();
  if (!terms.length) {
    $('status').textContent = tr(ctx, 'פתח שיחה או סמן טקסט כדי לחפש.', 'Open a chat or select text to search.');
    return;
  }
  $('status').textContent = tr(ctx, 'מחפש…', 'Searching…');
  for (const q of terms) {
    const res = await bines.api('GET', '/search', { query: { q } });
    if (mine !== run) return;
    const items = res?.items ?? [];
    if (!items.length) continue;
    $('status').textContent = tr(ctx, `נמצא לפי "${q}"`, `Found by "${q}"`);
    for (const it of items.slice(0, 5)) {
      const open = el('button', { text: `${it.name} · ${it.board?.name ?? ''}` });
      open.addEventListener('click', () => void bines.execute('openItemCard', { itemId: it.id }).catch(fail));
      list.append(el('li', {}, open));
    }
    await bines.execute('openItemCard', { itemId: items[0].id });
    return;
  }
  $('status').textContent = tr(ctx, 'לא נמצא במערכת.', 'Not found.');
};

const main = async () => {
  const ctx = await bines.ready();
  applyContext(ctx);
  bines.autoResize();
  await lookup(ctx);
  bines.listen('context', (next) => {
    applyContext(next);
    void lookup(next).catch(fail);
  });
};

main().catch(fail);
