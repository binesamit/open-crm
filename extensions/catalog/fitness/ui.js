// SPDX-License-Identifier: AGPL-3.0-only
// "כושר" — small DOM helpers. Everything from the API reaches the page as text: `h()` turns strings into text nodes
// and sets attributes one by one; there is no innerHTML anywhere in this extension.

/** h('div', {class: 'x', on: {click}, attrs: {...}, style: {...}}, ...children) — children: nodes, strings, arrays. */
export const h = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'style') Object.assign(node.style, v);
    else if (k === 'attrs') {
      for (const [a, x] of Object.entries(v)) if (x !== undefined && x !== null) node.setAttribute(a, String(x));
    } else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = !!v;
    else if (k === 'disabled') node.disabled = !!v;
    else if (k === 'selected') node.selected = !!v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return node;
};

/**
 * A dropdown in the app's style (product owner: never the browser's own pickers): a button that opens a list under it, with a
 * search field when the list is long, arrows / Enter / Esc, and a click outside to close. `options`: [{value, label}].
 */
let openPop = null;
export const closePop = () => {
  openPop?.remove();
  openPop = null;
};
document.addEventListener('pointerdown', (e) => {
  if (openPop && !openPop.contains(e.target) && !e.target.closest?.('.dd')) closePop();
});
window.addEventListener('resize', closePop);
export const select = (value, options, onChange, props = {}) => {
  const current = options.find((o) => (o.value ?? '') === (value ?? ''));
  const { attrs = {}, class: cls = '', ...rest } = props;
  const btn = h(
    'button',
    {
      ...rest,
      type: 'button',
      class: `dd ${cls}`,
      attrs: { ...attrs, 'aria-haspopup': 'listbox', 'aria-expanded': 'false' },
      on: {
        click: () => {
          if (openPop && openPop.dataset.for === btn.dataset.id) return closePop();
          open();
        },
        keydown: (e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            open();
          }
        },
      },
    },
    h('span', { class: 'dd-v' }, current?.label ?? '—'),
    h('span', { class: 'dd-c', attrs: { 'aria-hidden': 'true' } }, '▾'),
  );
  btn.dataset.id = Math.random().toString(36).slice(2);
  const open = () => {
    closePop();
    const r = btn.getBoundingClientRect();
    const search = options.length > 8;
    let active = Math.max(
      0,
      options.findIndex((o) => (o.value ?? '') === (value ?? '')),
    );
    let shown = options;
    const list = h('ul', { class: 'dd-list', role: 'listbox' });
    const choose = (o) => {
      closePop();
      btn.setAttribute('aria-expanded', 'false');
      if ((o.value ?? '') !== (value ?? '')) onChange(o.value ?? '');
      else btn.focus();
    };
    const paint = () => {
      list.replaceChildren(
        ...shown.map((o, i) =>
          h(
            'li',
            {
              role: 'option',
              class: `${i === active ? 'on' : ''} ${(o.value ?? '') === (value ?? '') ? 'cur' : ''}`,
              attrs: { 'aria-selected': String((o.value ?? '') === (value ?? '')) },
              on: { pointerdown: (e) => e.preventDefault(), click: () => choose(o) },
            },
            o.label,
          ),
        ),
      );
      list.children[active]?.scrollIntoView?.({ block: 'nearest' });
    };
    const keys = (e) => {
      if (e.key === 'ArrowDown') active = Math.min(shown.length - 1, active + 1);
      else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
      else if (e.key === 'Enter' && shown[active]) return (e.preventDefault(), choose(shown[active]));
      else if (e.key === 'Escape') return (closePop(), btn.focus());
      else return;
      e.preventDefault();
      paint();
    };
    const box = h('div', { class: 'dd-pop', on: { keydown: keys } });
    box.dataset.for = btn.dataset.id;
    if (search) {
      const input = h('input', {
        type: 'text',
        class: 'dd-search',
        placeholder: document.documentElement.lang === 'en' ? 'Search' : 'חיפוש',
        attrs: { 'aria-label': document.documentElement.lang === 'en' ? 'Search' : 'חיפוש' },
        on: {
          input: (e) => {
            const q = e.target.value.trim().toLowerCase();
            shown = q ? options.filter((o) => String(o.label).toLowerCase().includes(q)) : options;
            active = 0;
            paint();
          },
        },
      });
      box.append(input);
      setTimeout(() => input.focus(), 0);
    } else setTimeout(() => list.focus(), 0);
    list.tabIndex = -1;
    box.append(list);
    document.body.append(box);
    const width = Math.max(r.width, 180);
    const below = window.innerHeight - r.bottom;
    box.style.width = `${Math.min(width, window.innerWidth - 16)}px`;
    box.style.insetInlineStart = '';
    box.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
    if (document.documentElement.dir !== 'rtl')
      box.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    if (below < 220 && r.top > below) box.style.bottom = `${window.innerHeight - r.top + 4}px`;
    else box.style.top = `${r.bottom + 4}px`;
    box.style.maxHeight = `${Math.max(160, (below < 220 && r.top > below ? r.top : below) - 16)}px`;
    openPop = box;
    btn.setAttribute('aria-expanded', 'true');
    paint();
  };
  return btn;
};

/** mm:ss */
export const clock = (s) =>
  `${String(Math.floor(Math.max(0, s) / 60)).padStart(2, '0')}:${String(Math.max(0, s) % 60).padStart(2, '0')}`;

export const fmt = (n, digits = 0) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? '—'
    : Number(n).toLocaleString('he-IL', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

/** A figure shown where an exercise has no picture (pictures need the app's file links, not open to extensions). */
export const figure = () => {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('aria-hidden', 'true');
  const shapes = [
    ['circle', { cx: 50, cy: 22, r: 9, opacity: 0.8 }],
    ['rect', { x: 43, y: 33, width: 14, height: 30, rx: 6, opacity: 0.8 }],
    ['rect', { x: 14, y: 40, width: 72, height: 6, rx: 3, opacity: 0.6 }],
    ['rect', { x: 8, y: 34, width: 8, height: 18, rx: 2 }],
    ['rect', { x: 84, y: 34, width: 8, height: 18, rx: 2 }],
    ['rect', { x: 40, y: 62, width: 7, height: 26, rx: 3, opacity: 0.8 }],
    ['rect', { x: 53, y: 62, width: 7, height: 26, rx: 3, opacity: 0.8 }],
  ];
  for (const [tag, a] of shapes) {
    const el = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(a)) el.setAttribute(k, String(v));
    el.setAttribute('fill', 'currentColor');
    svg.append(el);
  }
  return svg;
};

/** A short beep and a vibration (the rest is over). Silent where the browser refuses. */
export const beep = () => {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => {
      o.stop();
      void ctx.close();
    }, 220);
  } catch {
    // no sound
  }
  try {
    navigator.vibrate?.([120, 60, 120]);
  } catch {
    // no vibration
  }
};

/** Keeps the screen on while a workout runs (the host frame allows `screen-wake-lock`). */
export const wakeLock = () => {
  let lock = null;
  let wanted = false;
  const get = async () => {
    try {
      lock = await navigator.wakeLock?.request('screen');
    } catch {
      lock = null;
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (wanted && document.visibilityState === 'visible') void get();
  });
  return {
    on: () => {
      wanted = true;
      void get();
    },
    off: () => {
      wanted = false;
      try {
        void lock?.release();
      } catch {
        // already gone
      }
      lock = null;
    },
  };
};
