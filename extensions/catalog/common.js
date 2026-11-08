// SPDX-License-Identifier: AGPL-3.0-only
// Shared helpers of the catalogue's sample extensions (board-summary, kanban-stats). Everything read from the API is
// put on the page as text (textContent / attributes), never as HTML.
import { createBinesSdk } from './sdk.js';
import { HOST_ORIGIN } from './config.js';

/** The SDK, pinned to the app's origin when the build knows it (production: config.js from build.mjs). */
export const sdk = () => createBinesSdk(HOST_ORIGIN ? { hostOrigin: HOST_ORIGIN } : {});

export const $ = (id) => document.getElementById(id);

/** Direction, language and theme of the host. */
export const applyContext = (ctx) => {
  document.documentElement.dir = ctx.dir;
  document.documentElement.lang = ctx.locale;
  document.documentElement.classList.toggle('dark', ctx.theme === 'dark');
};

/** Hebrew or English text by the host's locale. */
export const tr = (ctx, he, en) => (ctx.locale === 'en' ? en : he);

/** An element with text (and optional class / attributes) — never innerHTML. */
export const el = (tag, opts = {}, ...children) => {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = String(opts.text);
  if (opts.style) Object.assign(node.style, opts.style);
  for (const [k, v] of Object.entries(opts.attrs ?? {})) node.setAttribute(k, String(v));
  for (const c of children) if (c) node.append(c);
  return node;
};

/** A colour from a label (#rrggbb only — anything else falls back to grey). */
export const safeColor = (c) => (typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c) ? c : '#9aa5a0');

/** The status columns of a board, with their labels. */
export const statusColumns = (board) =>
  (board.columns ?? []).filter((c) => c.type === 'status' && Array.isArray(c.settings?.labels));

/** Counts of an item list by one status column: [{label, color, done, count}] in the column's label order. */
export const countByStatus = (items, column) => {
  const labels = [...column.settings.labels].filter((l) => !l.is_deactivated).sort((a, b) => a.index - b.index);
  const counts = new Map(labels.map((l) => [l.id, 0]));
  let empty = 0;
  for (const it of items) {
    const v = it.cells?.[column.id]?.value;
    const id = v && typeof v === 'object' ? v.index : undefined;
    if (counts.has(id)) counts.set(id, counts.get(id) + 1);
    else empty++;
  }
  const rows = labels.map((l) => ({
    label: l.label,
    color: safeColor(l.color),
    done: !!l.is_done,
    count: counts.get(l.id),
  }));
  return { rows, empty, total: items.length };
};

/** A horizontal stacked bar of status counts. */
export const stackedBar = (counts, emptyLabel) => {
  const bar = el('div', { className: 'bar', attrs: { role: 'img' } });
  const parts = [];
  for (const r of counts.rows) {
    if (!r.count) continue;
    bar.append(
      el('span', {
        style: { flexGrow: String(r.count), background: r.color },
        attrs: { title: `${r.label}: ${r.count}` },
      }),
    );
    parts.push(`${r.label} ${r.count}`);
  }
  if (counts.empty) {
    bar.append(
      el('span', {
        className: 'empty',
        style: { flexGrow: String(counts.empty) },
        attrs: { title: `${emptyLabel}: ${counts.empty}` },
      }),
    );
    parts.push(`${emptyLabel} ${counts.empty}`);
  }
  bar.setAttribute('aria-label', parts.join(', '));
  return bar;
};

/** Shows an error on the page (as text). */
export const fail = (err) => {
  const status = $('status');
  if (status) status.textContent = `error: ${err && (err.code || err.message) ? err.code || err.message : err}`;
};
