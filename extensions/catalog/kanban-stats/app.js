// SPDX-License-Identifier: AGPL-3.0-only
// "סטטיסטיקת קנבן" — a catalogue extension (dashboard widget, boards:read only): for each board of the dashboard, its
// items per status lane (the board's status column — the viewer picks which one; remembered per user), the % done
// and the biggest lane. Read-only; everything from the API is shown as text.
import { $, applyContext, countByStatus, el, fail, sdk, stackedBar, statusColumns, tr } from '../common.js';

const bines = sdk();

const boardBlock = async (ctx, boardId, chosen) => {
  const board = await bines.api('GET', `/boards/${encodeURIComponent(boardId)}`);
  const columns = statusColumns(board);
  const block = el('div', { className: 'board', attrs: { 'data-testid': 'ks-board', 'data-board': boardId } });
  if (!columns.length) {
    block.append(
      el(
        'div',
        { className: 'board-head' },
        el('b', { text: board.name }),
        el('span', { className: 'muted', text: tr(ctx, 'אין עמודת סטטוס', 'No status column') }),
      ),
    );
    return block;
  }
  const column = columns.find((c) => c.id === chosen[boardId]) ?? columns[0];
  const { data } = await bines.api('GET', `/boards/${encodeURIComponent(boardId)}/items`);
  const items = data.filter((i) => !i.parent_item_id);
  const counts = countByStatus(items, column);
  const done = counts.rows.filter((r) => r.done).reduce((n, r) => n + r.count, 0);
  const top = [...counts.rows].sort((a, b) => b.count - a.count)[0];

  const head = el('div', { className: 'board-head' }, el('b', { text: board.name }));
  if (columns.length > 1) {
    const select = el('select', {
      attrs: { 'aria-label': tr(ctx, 'עמודת סטטוס', 'Status column'), 'data-testid': 'ks-column' },
    });
    for (const c of columns) {
      const o = el('option', { text: c.title, attrs: { value: c.id } });
      if (c.id === column.id) o.selected = true;
      select.append(o);
    }
    select.addEventListener('change', async () => {
      chosen[boardId] = select.value;
      await bines.storage.set('columns', chosen, { scope: 'user' }).catch(() => undefined);
      block.replaceWith(await boardBlock(ctx, boardId, chosen));
    });
    head.append(select);
  }
  block.append(
    head,
    stackedBar(counts, tr(ctx, 'ריק', 'Empty')),
    el(
      'div',
      { className: 'board-head muted' },
      el('span', {
        text: `${items.length} ${tr(ctx, 'פריטים', 'items')} · ${items.length ? Math.round((done / items.length) * 100) : 0}% ${tr(ctx, 'הושלמו', 'done')}`,
      }),
      top && top.count
        ? el('span', { text: `${tr(ctx, 'הנתיב הגדול', 'Biggest lane')}: ${top.label} (${top.count})` })
        : null,
    ),
  );
  return block;
};

const main = async () => {
  const ctx = await bines.ready();
  applyContext(ctx);
  bines.listen('context', applyContext);
  const boards = ctx.board_ids ?? [];
  const chosen = (await bines.storage.get('columns', { scope: 'user' }).catch(() => null)) ?? {};
  const root = $('boards');
  if (!boards.length)
    root.append(el('p', { className: 'muted', text: tr(ctx, 'אין לוחות בדשבורד', 'No boards on this dashboard') }));
  for (const b of boards) root.append(await boardBlock(ctx, b, chosen));
  $('status').textContent = tr(ctx, 'סטטיסטיקת קנבן', 'Kanban stats');
  $('status').dataset.ready = '1';
};

main().catch(fail);
