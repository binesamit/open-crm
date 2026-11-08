// SPDX-License-Identifier: AGPL-3.0-only
// "סיכום בורד" — a catalogue extension (board view, boards:read only): the board at a glance — items, % done, overdue
// dates, items per status / group / person. Read-only; everything from the API is shown as text.
import { $, applyContext, countByStatus, el, fail, safeColor, sdk, stackedBar, statusColumns, tr } from '../common.js';

const bines = sdk();

const today = () => new Date().toISOString().slice(0, 10);

/** Rows "name — count", biggest first, up to `max`. */
const list = (entries, max = 8) =>
  el(
    'ul',
    { className: 'rows' },
    ...entries
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map(([name, n]) => el('li', {}, el('span', { text: name }), el('b', { text: n }))),
  );

const main = async () => {
  const ctx = await bines.ready();
  applyContext(ctx);
  bines.listen('context', applyContext);
  bines.autoResize();
  $('l-items').textContent = tr(ctx, 'פריטים', 'Items');
  $('l-done').textContent = tr(ctx, 'הושלמו', 'Done');
  $('l-overdue').textContent = tr(ctx, 'באיחור', 'Overdue');
  $('l-groups').textContent = tr(ctx, 'קבוצות', 'Groups');

  const board = await bines.api('GET', `/boards/${encodeURIComponent(ctx.board_id)}`);
  const { data } = await bines.items();
  const items = data.filter((i) => !i.parent_item_id);
  $('items').textContent = String(items.length);
  $('groups').textContent = String((board.groups ?? []).length);

  // Done = the first status column's "done" labels.
  const status = statusColumns(board)[0];
  const counts = status ? countByStatus(items, status) : null;
  const doneIds = new Set(status ? status.settings.labels.filter((l) => l.is_done).map((l) => l.id) : []);
  const isDone = (it) => (status ? doneIds.has(it.cells?.[status.id]?.value?.index) : false);
  const done = items.filter(isDone).length;
  $('done').textContent = items.length ? `${Math.round((done / items.length) * 100)}%` : '–';

  // Overdue = a date in any date column before today, on an item not done.
  const dateCols = (board.columns ?? []).filter((c) => c.type === 'date');
  const now = today();
  const overdue = items.filter(
    (it) =>
      !isDone(it) &&
      dateCols.some((c) => {
        const d = it.cells?.[c.id]?.value?.date;
        return typeof d === 'string' && d.slice(0, 10) < now;
      }),
  ).length;
  $('overdue').textContent = dateCols.length ? String(overdue) : '–';

  const byStatus = $('by-status');
  if (counts) {
    byStatus.append(
      el('h2', { text: `${tr(ctx, 'לפי', 'By')} ${status.title}` }),
      stackedBar(counts, tr(ctx, 'ריק', 'Empty')),
      el(
        'ul',
        { className: 'legend' },
        ...counts.rows
          .filter((r) => r.count)
          .map((r) =>
            el(
              'li',
              {},
              el('span', { className: 'dot', style: { background: safeColor(r.color) } }),
              el('span', { text: `${r.label} · ${r.count}` }),
            ),
          ),
      ),
    );
  }

  const groups = new Map((board.groups ?? []).map((g) => [g.id, g.title]));
  const perGroup = new Map();
  for (const it of items) {
    const name = groups.get(it.group_id) ?? '—';
    perGroup.set(name, (perGroup.get(name) ?? 0) + 1);
  }
  $('by-group').append(el('h2', { text: tr(ctx, 'לפי קבוצה', 'By group') }), list([...perGroup.entries()]));

  const people = (board.columns ?? []).find((c) => c.type === 'people');
  if (people) {
    const perPerson = new Map();
    for (const it of items) {
      const text = it.cells?.[people.id]?.text;
      const names = text
        ? text
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [tr(ctx, 'ללא', 'Nobody')];
      for (const n of names) perPerson.set(n, (perPerson.get(n) ?? 0) + 1);
    }
    $('by-person').append(
      el('h2', { text: `${tr(ctx, 'לפי', 'By')} ${people.title}` }),
      list([...perPerson.entries()]),
    );
  }
  $('status').textContent = board.name;
  $('status').dataset.ready = '1';
};

main().catch(fail);
