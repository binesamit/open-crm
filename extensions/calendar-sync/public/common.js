// SPDX-License-Identifier: AGPL-3.0-only
// Shared by the two pages: the SDK (pinned to the Bines origin), the calls to this extension's own server (with the
// page's token in a header — the server asks Bines who it is), DOM helpers that only ever set text, and the small
// controls in the Bines look (no browser-native <select> / checkbox anywhere): a picker with search, a switch and a
// segmented control.
import { createBinesSdk } from './sdk.js';
import { HOST_ORIGIN } from './config.js';
import { STRINGS } from './strings.js';

export const bines = createBinesSdk({ hostOrigin: HOST_ORIGIN });

let ctx = null;
export const t = (key) => {
  const lang = ctx?.locale === 'en' ? 'en' : 'he';
  return STRINGS[lang][key] ?? STRINGS.he[key] ?? key;
};
/** A text with `{name}` slots. */
export const tf = (key, vars) => String(t(key)).replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
export const errText = (code, message) => {
  const codes = t('err_codes');
  return (codes[code] ?? t('error')) + (message && code in codes && /: $/.test(codes[code]) ? message : '');
};
export const context = () => ctx;
const rtl = () => document.documentElement.dir !== 'ltr';

export const start = async () => {
  ctx = await bines.ready();
  const apply = (c) => {
    ctx = c;
    document.documentElement.dir = c.dir;
    document.documentElement.lang = c.locale;
    document.documentElement.classList.toggle('dark', c.theme === 'dark');
  };
  apply(ctx);
  bines.listen('context', apply);
  bines.autoResize();
  return ctx;
};

export class ServerError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

/** A call to this extension's server. */
export const server = async (method, path, body) => {
  const token = await bines.token();
  const res = await fetch(path, {
    method,
    credentials: 'omit',
    headers: {
      authorization: `Bearer ${token.token}`,
      'x-installation-id': ctx.installation_id,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ServerError(res.status, data?.error?.code ?? 'error', data?.error?.message ?? '');
  return data;
};

export const $ = (id) => document.getElementById(id);

/** An element with text and attributes — never innerHTML. */
export const el = (tag, opts = {}, ...children) => {
  const node = document.createElement(tag);
  if (opts.className) node.className = opts.className;
  if (opts.text !== undefined) node.textContent = String(opts.text);
  for (const [k, v] of Object.entries(opts.attrs ?? {}))
    if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  for (const [k, v] of Object.entries(opts.on ?? {})) node.addEventListener(k, v);
  for (const c of children) if (c) node.append(c);
  return node;
};

let uid = 0;
export const nextId = (prefix = 'x') => `${prefix}-${++uid}`;

export const notice = (node, text, tone = 'info') => {
  node.textContent = text;
  node.className = `notice ${tone}`;
  node.hidden = !text;
  node.setAttribute('role', tone === 'error' ? 'alert' : 'status');
};

/** A button in the Bines look: `primary`, `ghost` or plain. */
export const button = (text, onClick, kind = '', attrs = {}) =>
  el('button', { className: `btn ${kind}`.trim(), text, attrs: { type: 'button', ...attrs }, on: { click: onClick } });

/** A text input (the browser's own text field is fine; only its pickers are not). */
export const input = (value, onInput, attrs = {}) =>
  el('input', {
    className: 'inp',
    attrs: { type: 'text', value: value ?? '', ...attrs },
    on: { input: (e) => onInput(e.target.value) },
  });

/** A whole-number input: empty = null. */
export const numInput = (value, onInput, attrs = {}) =>
  input(
    value === null || value === undefined ? '' : String(value),
    (v) => onInput(v.trim() === '' || !/^\d+$/.test(v.trim()) ? null : Number(v.trim())),
    { inputmode: 'numeric', class: 'inp num', ...attrs },
  );

/** A label above a control (the control gets an aria label from it when it has none). */
export const field = (label, control, { hint, className } = {}) => {
  const id = nextId('f');
  const lab = el('span', { className: 'flabel', text: label, attrs: { id } });
  const target = control.matches?.('input, button, [role]')
    ? control
    : control.querySelector?.('input, button, [role]');
  if (target && !target.hasAttribute('aria-label') && !target.hasAttribute('aria-labelledby'))
    target.setAttribute('aria-labelledby', id);
  return el(
    'div',
    { className: `field ${className ?? ''}`.trim() },
    lab,
    control,
    hint ? el('span', { className: 'fhint', text: hint }) : null,
  );
};

// ---- switch ---------------------------------------------------------------------------------------------------

/** A switch (`role="switch"`): Space / Enter / click flip it. */
export const toggle = ({ checked, onChange, label, labelledby, describedby }) => {
  const node = el('button', {
    className: 'sw-t',
    attrs: {
      type: 'button',
      role: 'switch',
      'aria-checked': checked ? 'true' : 'false',
      'aria-label': labelledby ? undefined : label,
      'aria-labelledby': labelledby,
      'aria-describedby': describedby,
    },
  });
  node.addEventListener('click', () => {
    const next = node.getAttribute('aria-checked') !== 'true';
    node.setAttribute('aria-checked', next ? 'true' : 'false');
    onChange(next);
  });
  return node;
};

// ---- segmented control ----------------------------------------------------------------------------------------

/** A segmented control with radio-group semantics: one tab stop, the arrows move and choose. */
export const segmented = ({ options, value, onChange, label, labelledby }) => {
  let current = value;
  const group = el('div', {
    className: 'seg',
    attrs: { role: 'radiogroup', 'aria-label': labelledby ? undefined : label, 'aria-labelledby': labelledby },
  });
  const buttons = options.map((o) =>
    el('button', {
      text: o.label,
      attrs: { type: 'button', role: 'radio', 'data-value': String(o.value) },
      on: { click: () => choose(o.value, false) },
    }),
  );
  const paint = () =>
    buttons.forEach((b, i) => {
      const on = options[i].value === current;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on || (!options.some((o) => o.value === current) && i === 0) ? 0 : -1;
    });
  const choose = (v, focus) => {
    const changed = v !== current;
    current = v;
    paint();
    if (focus) buttons[options.findIndex((o) => o.value === v)]?.focus();
    if (changed) onChange(v);
  };
  group.addEventListener('keydown', (e) => {
    const i = Math.max(
      0,
      buttons.findIndex((b) => b === document.activeElement),
    );
    const fwd = rtl() ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl() ? 'ArrowRight' : 'ArrowLeft';
    let j = null;
    if (e.key === fwd || e.key === 'ArrowDown') j = (i + 1) % options.length;
    else if (e.key === back || e.key === 'ArrowUp') j = (i - 1 + options.length) % options.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = options.length - 1;
    if (j === null) return;
    e.preventDefault();
    choose(options[j].value, true);
  });
  group.append(...buttons);
  paint();
  return group;
};

// ---- picker ---------------------------------------------------------------------------------------------------

/** The icon of a column type (the same marks the canvas uses). */
export const COLUMN_ICONS = {
  board: '▦',
  timeline: '⟷',
  date: '📅',
  hour: '🕑',
  people: '👤',
  status: '◉',
  email: '✉',
  text: 'T',
  long_text: '¶',
  number: '#',
  link: '🔗',
  phone: '☎',
  group: '▤',
  calendar: '📆',
};
export const iconOf = (type) => COLUMN_ICONS[type] ?? '•';

let openPicker = null;
document.addEventListener('pointerdown', (e) => {
  if (openPicker && !openPicker.root.contains(e.target)) openPicker.close(false);
});

/**
 * A picker: a button that opens a list in a popover, with a search field when the list is long. Keyboard: Enter /
 * Space / ↓ open it; ↑ ↓ Home End move; Enter chooses; Esc / Tab close; typing filters. The popover opens inside the
 * page (absolute, under the button): when it reaches past the page's end the page grows — the frame follows.
 *
 * @param {{ options: {value: string|null, label: string, icon?: string}[], value: string|null,
 *   onChange: (v: string|null) => void, label: string, placeholder?: string, icon?: string }} p
 */
export const picker = (p) => {
  let value = p.value ?? null;
  let options = p.options;
  let shown = [];
  let active = 0;
  const listId = nextId('lb');
  const pv = el('span', { className: 'pv' });
  const ic = el('span', { className: 't', attrs: { 'aria-hidden': 'true' } });
  const btn = el(
    'button',
    {
      className: 'picker',
      attrs: { type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': listId },
    },
    ic,
    pv,
    el('span', { className: 'chev', text: '⌄', attrs: { 'aria-hidden': 'true' } }),
  );
  const search = el('input', {
    className: 'inp',
    attrs: {
      type: 'text',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'true',
      'aria-controls': listId,
      'aria-label': `${t('search')} — ${p.label}`,
      placeholder: t('search'),
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  const list = el('ul', { attrs: { role: 'listbox', id: listId, tabindex: '-1', 'aria-label': p.label } });
  const pop = el('div', { className: 'pop', attrs: { hidden: true } }, search, list);
  const root = el('div', { className: 'pk' }, btn, pop);

  const current = () => options.find((o) => o.value === value);
  const render = () => {
    const o = current();
    pv.textContent = o?.label ?? p.placeholder ?? t('pick');
    btn.classList.toggle('empty', !o || o.value === null);
    const icon = o?.icon ?? p.icon;
    ic.textContent = icon ?? '';
    ic.hidden = !icon;
    btn.setAttribute('aria-label', `${p.label}: ${pv.textContent}`);
  };
  const paintActive = () => {
    [...list.children].forEach((li, i) => li.classList.toggle('active', i === active));
    const li = list.children[active];
    const host = search.hidden ? list : search;
    if (li?.id) host.setAttribute('aria-activedescendant', li.id);
    else host.removeAttribute('aria-activedescendant');
    li?.scrollIntoView?.({ block: 'nearest' });
  };
  const fill = (query = '') => {
    const q = query.trim().toLowerCase();
    shown = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;
    list.replaceChildren(
      ...shown.map((o, i) =>
        el(
          'li',
          {
            attrs: { role: 'option', id: `${listId}-${i}`, 'aria-selected': o.value === value ? 'true' : 'false' },
            on: {
              pointerdown: (e) => e.preventDefault(),
              click: () => choose(o.value),
              pointermove: () => {
                if (active !== i) {
                  active = i;
                  paintActive();
                }
              },
            },
          },
          o.icon ? el('span', { className: 't', text: o.icon, attrs: { 'aria-hidden': 'true' } }) : null,
          el('span', { className: 'grow', text: o.label }),
        ),
      ),
    );
    if (!shown.length)
      list.append(el('li', { className: 'empty-list', text: t('no_matches'), attrs: { role: 'presentation' } }));
    active = Math.max(
      0,
      shown.findIndex((o) => o.value === value),
    );
    paintActive();
  };
  const choose = (v) => {
    const changed = v !== value;
    value = v;
    render();
    api.close(true);
    if (changed) p.onChange(v);
  };
  let typed = '';
  let typedAt = 0;
  const keys = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const n = shown.length;
      if (!n) return;
      if (e.key === 'ArrowDown') active = (active + 1) % n;
      else if (e.key === 'ArrowUp') active = (active - 1 + n) % n;
      else if (e.key === 'Home') active = 0;
      else active = n - 1;
      paintActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (shown[active]) choose(shown[active].value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      api.close(true);
    } else if (e.key === 'Tab') {
      api.close(false);
    } else if (search.hidden && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // A short list (no search field): typing jumps to the first match.
      typed = Date.now() - typedAt > 700 ? e.key : typed + e.key;
      typedAt = Date.now();
      const i = shown.findIndex((o) => o.label.toLowerCase().startsWith(typed.toLowerCase()));
      if (i >= 0) {
        active = i;
        paintActive();
      }
    }
  };
  search.addEventListener('keydown', keys);
  search.addEventListener('input', () => fill(search.value));
  list.addEventListener('keydown', keys);

  const api = {
    root,
    get value() {
      return value;
    },
    set(v) {
      value = v;
      render();
    },
    setOptions(next) {
      options = next;
      render();
    },
    close(focusButton) {
      if (pop.hidden) return;
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      if (openPicker === api) openPicker = null;
      if (focusButton) btn.focus();
    },
    open() {
      if (openPicker && openPicker !== api) openPicker.close(false);
      search.value = '';
      search.hidden = options.length <= 6;
      fill();
      pop.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      openPicker = api;
      (search.hidden ? list : search).focus({ preventScroll: true });
    },
  };
  btn.addEventListener('click', () => (pop.hidden ? api.open() : api.close(true)));
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      api.open();
    }
  });
  render();
  return api;
};

// ---- the visible part of a page whose frame is as tall as the page --------------------------------------------

/**
 * The frame is as tall as its content (`autoResize`), so the host page scrolls it and CSS `sticky` has nothing to
 * stick to. An IntersectionObserver still sees which part of the page is on screen (clipped by the host's viewport),
 * so a bar can be kept in view by hand: `cb(top, bottom)` in page coordinates whenever that part changes.
 */
export const watchVisible = (target, cb) => {
  const thresholds = Array.from({ length: 401 }, (_, i) => i / 400);
  const io = new IntersectionObserver(
    (entries) => {
      const e = entries[entries.length - 1];
      if (!e.isIntersecting) return;
      const top = e.intersectionRect.top - e.boundingClientRect.top;
      cb(top, top + e.intersectionRect.height);
    },
    { threshold: thresholds },
  );
  io.observe(target);
  return () => io.disconnect();
};

// ---- relative times -------------------------------------------------------------------------------------------

export const fmtTime = (iso) => {
  if (!iso) return t('never');
  return new Date(iso).toLocaleString(ctx?.locale === 'en' ? 'en-GB' : 'he-IL', {
    dateStyle: 'short',
    timeStyle: 'short',
  });
};

export const fmtAgo = (iso) => {
  if (!iso) return t('never');
  const s = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(ctx?.locale === 'en' ? 'en' : 'he', { numeric: 'auto' });
  // ICU's Hebrew says "לפני דקה (1)" for one unit: the "(1)" goes.
  const fmt = (n, unit) => rtf.format(n, unit).replace(/\s*\(1\)$/, '');
  const abs = Math.abs(s);
  if (abs < 60) return fmt(Math.round(s), 'second');
  if (abs < 3600) return fmt(Math.round(s / 60), 'minute');
  if (abs < 86400) return fmt(Math.round(s / 3600), 'hour');
  if (abs < 86400 * 7) return fmt(Math.round(s / 86400), 'day');
  return fmtTime(iso);
};

// ---- connecting a calendar (both pages) -----------------------------------------------------------------------

/** The consent address, fetched before the click (its state lives 10 minutes; one older than 8 is fetched again). */
let prepared = null;
export const prepareConnect = async () => {
  prepared = { ...(await server('POST', '/api/connect')), at: Date.now() };
};

/**
 * Opens the Google consent in a new window, straight on the click (no await before `window.open`, or pop-up
 * blockers stop it). Bines pages send Cross-Origin-Opener-Policy, so the window gets no opener and this page no
 * handle (`window.open` returns null although the window opened): the page asks the server how the consent ended.
 * `signal` stops the waiting (the window itself stays open: this page has no handle on it).
 */
export const connectGoogle = async ({ onWaiting, signal } = {}) => {
  if (!prepared || Date.now() - prepared.at > 8 * 60_000) await prepareConnect();
  const { url, ticket } = prepared;
  prepared = null;
  // Bines opens it top level: Google's sign-in will not load in a window that inherits this frame's sandbox. A
  // host without `openWindow` (an older Bines): open it from here.
  const state = new URL(url).searchParams.get('state') ?? '';
  try {
    await bines.openWindow(`/oauth/google/go?state=${encodeURIComponent(state)}`, { width: 520, height: 680 });
  } catch {
    window.open(url, '_blank', 'popup,width=520,height=680');
  }
  onWaiting?.();
  prepareConnect().catch(() => {});
  const until = Date.now() + 10 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1500));
    if (signal?.aborted) return 'cancelled';
    const { status } = await server('GET', `/api/connect/${encodeURIComponent(ticket)}`);
    if (signal?.aborted) return 'cancelled';
    if (status) return status;
  }
  return 'timeout';
};

/**
 * The calendar providers as cards (the member page, and the admin's own calendar): Google — connect, the waiting
 * state while its window is open (with cancel), connected + disconnect; CalDAV — the inline form (server address,
 * user name, app password, "check and connect").
 *
 * @param {{ connection: {connected: boolean, provider?: string, email?: string}, googleReady: boolean,
 *   caldavReady: boolean, onChanged: (what: 'connected'|'disconnected') => Promise<void>|void }} p
 */
export const providerCards = (p) => {
  const c = p.connection;
  const msg = el('p', { className: 'notice', attrs: { hidden: true } });
  const wrap = el('div', { className: 'provs' });
  let waiting = null; // AbortController while the Google window is open
  let formOpen = false;
  const dav = { url: '', username: '', password: '' };

  const fail = (e) =>
    notice(msg, e?.status === 401 ? t('not_installed') : errText(e?.code ?? 'error', e?.message), 'error');

  const disconnect = button(t('disconnect'), async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      await server('DELETE', '/api/connection');
      await p.onChanged('disconnected');
    } catch (err) {
      fail(err);
      b.disabled = false;
    }
  });

  const googleCard = () => {
    const on = c.connected && c.provider === 'google';
    const broken = on && c.status === 'error';
    if (waiting)
      return el(
        'div',
        { className: 'prov', attrs: { 'aria-live': 'polite' } },
        el('span', { className: 'logo g', text: 'G', attrs: { 'aria-hidden': 'true' } }),
        el(
          'div',
          { className: 'grow' },
          el('span', { text: t('waiting_title') }),
          el('small', { text: t('waiting_hint') }),
        ),
        button(
          t('cancel'),
          () => {
            waiting?.abort();
            waiting = null;
            draw();
            wrap.querySelector('.prov .btn')?.focus();
          },
          'ghost',
        ),
      );
    const connect = button(
      on ? t('reconnect') : t('connect_short'),
      async () => {
        notice(msg, '');
        waiting = new AbortController();
        const signal = waiting.signal;
        try {
          const status = await connectGoogle({
            signal,
            onWaiting: () => {
              draw();
              wrap.querySelector('.prov .btn')?.focus();
            },
          });
          waiting = null;
          if (status === 'cancelled') return;
          if (status !== 'ok') {
            draw();
            return notice(msg, t(`done_${status}`) ?? t('error'), 'error');
          }
          await p.onChanged('connected');
        } catch (e) {
          waiting = null;
          draw();
          fail(e);
        }
      },
      on ? 'ghost' : c.connected ? '' : 'primary',
      { 'aria-label': on ? `${t('reconnect')} — Google` : `${t('connect_short')} — Google Calendar` },
    );
    return el(
      'div',
      { className: 'prov' },
      el('span', { className: 'logo g', text: 'G', attrs: { 'aria-hidden': 'true' } }),
      el(
        'div',
        { className: 'grow' },
        el('span', { text: t('google_name') }),
        el('small', { text: on ? c.email : p.googleReady ? t('google_hint') : t('google_missing') }),
        broken && c.error ? el('small', { className: 'err', text: c.error }) : null,
      ),
      on
        ? el('span', {
            className: `pill ${broken ? 'error' : 'ok'}`,
            text: broken ? t('needs_reconnect') : t('connected'),
          })
        : null,
      // Connected and working: only "disconnect" (as in the canvas); a broken connection is connected again.
      p.googleReady && (!on || broken) ? connect : null,
      on ? disconnect : null,
    );
  };

  const caldavCard = () => {
    const on = c.connected && c.provider === 'caldav';
    const toggleForm = button(
      on ? t('reconnect') : t('connect_short'),
      () => {
        formOpen = !formOpen;
        draw();
        if (formOpen) wrap.querySelector('.form input')?.focus();
      },
      on ? 'ghost' : '',
      {
        'aria-expanded': formOpen ? 'true' : 'false',
        'aria-label': `${on ? t('reconnect') : t('connect_short')} — CalDAV`,
      },
    );
    const formId = nextId('dav');
    toggleForm.setAttribute('aria-controls', formId);
    const check = button(
      t('caldav_test'),
      async (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        notice(msg, t('caldav_checking'), 'info');
        try {
          await server('POST', '/api/connect/caldav', dav);
          dav.password = '';
          formOpen = false;
          notice(msg, '');
          await p.onChanged('connected');
        } catch (err) {
          fail(err);
          b.disabled = false;
        }
      },
      'primary',
    );
    return el(
      'div',
      { className: 'prov' },
      el('span', { className: 'logo c', text: 'CalDAV', attrs: { 'aria-hidden': 'true' } }),
      el(
        'div',
        { className: 'grow' },
        el('span', { text: t('caldav_name') }),
        el('small', { text: on ? c.email : t('caldav_hint') }),
        on && c.status === 'error' && c.error ? el('small', { className: 'err', text: c.error }) : null,
      ),
      on
        ? el('span', {
            className: `pill ${c.status === 'error' ? 'error' : 'ok'}`,
            text: c.status === 'error' ? t('needs_reconnect') : t('connected'),
          })
        : null,
      toggleForm,
      on ? disconnect : null,
      formOpen
        ? el(
            'div',
            { className: 'form', attrs: { id: formId } },
            field(
              t('caldav_url'),
              input(dav.url, (v) => (dav.url = v), {
                dir: 'ltr',
                autocomplete: 'off',
                inputmode: 'url',
                placeholder: 'https://caldav.icloud.com',
              }),
            ),
            el(
              'div',
              { className: 'two' },
              field(
                t('caldav_username'),
                input(dav.username, (v) => (dav.username = v), {
                  dir: 'ltr',
                  autocomplete: 'off',
                  placeholder: 'name@icloud.com',
                }),
              ),
              field(
                t('caldav_password'),
                input(dav.password, (v) => (dav.password = v), {
                  type: 'password',
                  dir: 'ltr',
                  autocomplete: 'new-password',
                  placeholder: '••••••••',
                }),
              ),
            ),
            el(
              'div',
              { className: 'actions' },
              check,
              el('small', { className: 'muted', text: t('caldav_secret_note') }),
            ),
          )
        : null,
    );
  };

  const draw = () => {
    wrap.replaceChildren(googleCard(), ...(p.caldavReady ? [caldavCard()] : []), msg);
  };
  draw();
  if (p.googleReady) prepareConnect().catch(() => {});
  return { root: wrap, msg };
};
