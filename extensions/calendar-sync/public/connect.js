// SPDX-License-Identifier: AGPL-3.0-only
// "My connections" → Calendar: each member connects (or disconnects) their own calendar — a Google account, or
// any CalDAV server (address, user name, app password) — as provider cards (the approved canvas, section 3).
import {
  $,
  button,
  el,
  errText,
  field,
  fmtAgo,
  notice,
  numInput,
  picker,
  providerCards,
  segmented,
  server,
  start,
  t,
  tf,
} from './common.js';

const root = $('root');
const note = el('p', { className: 'notice', attrs: { hidden: true } });

/** How the member's own sync stands, with "sync now" (shown once they are connected and a board is picked). */
const syncBox = (me) => {
  let sync = me.sync;
  const line = el('span');
  const err = el('small', { className: 'err', attrs: { hidden: true } });
  const msg = el('small', { className: 'muted', attrs: { role: 'status' } });
  const paint = () => {
    line.textContent = [
      sync.last_sync_at ? tf('sync_last', { when: fmtAgo(sync.last_sync_at) }) : t('sync_never'),
      tf('sync_items', { n: sync.items }),
    ].join(' · ');
    err.hidden = !sync.error;
    err.textContent = sync.error ? `${t('sync_error')} ${sync.error}` : '';
  };
  const now = button(
    t('sync_now'),
    async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      msg.textContent = t('sync_running');
      try {
        sync = (await server('POST', '/api/sync')).sync ?? sync;
        msg.textContent = sync.error ? '' : t('sync_done');
      } catch (err2) {
        msg.textContent = errText(err2.code, err2.message);
      }
      paint();
      b.disabled = false;
    },
    'ghost',
  );
  paint();
  // The "synced 2 minutes ago" keeps counting while the page stays open.
  const tick = setInterval(() => (line.isConnected ? paint() : clearInterval(tick)), 30_000);
  return el(
    'div',
    { className: 'prov sync' },
    el(
      'div',
      { className: 'grow' },
      el('span', { text: t('sync_title') }),
      el('small', {}, line),
      err,
      el('small', { className: 'muted', text: tf('sync_how', { m: sync.interval_minutes }) }),
      msg,
    ),
    now,
  );
};

const IMPORT_MODES = ['none', 'new', 'existing'];

/**
 * What syncs, the member's own choice: which of their calendars, and what of it comes into the board (up to what the
 * admin allows). Each change is saved at once.
 */
const prefsBox = (me) => {
  let prefs = me.prefs;
  const allowed = IMPORT_MODES.slice(0, IMPORT_MODES.indexOf(me.allowed.import) + 1);
  const msg = el('small', { className: 'muted', attrs: { role: 'status' } });
  const save = async (patch, after = '') => {
    msg.className = 'muted';
    msg.textContent = t('prefs_saving');
    try {
      prefs = (await server('PUT', '/api/prefs', patch)).prefs;
      msg.textContent = after || t('prefs_saved');
    } catch (e) {
      msg.className = 'err';
      msg.textContent = errText(e.code, e.message);
    }
    paint();
  };

  // Which calendar.
  const cals = me.calendars ?? [];
  const calendar = cals.length
    ? picker({
        options: cals.map((c) => ({
          value: c.primary ? 'primary' : c.id,
          label: c.primary ? `${t('main_calendar')} · ${c.name}` : c.name,
        })),
        value: prefs.calendar_id,
        onChange: (v) => v && save({ calendar_id: v }, `${t('prefs_saved')} ${t('switch_note')}`),
        label: t('which_calendar'),
        icon: '📅',
      }).root
    : el('small', { className: 'err', text: t('calendars_failed') });
  const refresh = button(t('refresh_list'), () => load(), 'ghost small');

  // What comes in.
  const hint = el('small', { className: 'muted' });
  let daysTimer = 0;
  const days = field(
    t('import_days'),
    numInput(prefs.days, (v) => {
      clearTimeout(daysTimer);
      if (v === null) return;
      daysTimer = setTimeout(() => save({ days: Math.min(v, me.allowed.max_days) }), 600);
    }),
    { hint: `≤ ${me.allowed.max_days}` },
  );
  const mode = segmented({
    options: allowed.map((v) => ({ value: v, label: t(`import_${v}`) })),
    value: allowed.includes(prefs.import) ? prefs.import : 'none',
    onChange: (v) => save({ import: v }),
    label: t('import_title'),
  });
  const paint = () => {
    const m = allowed.includes(prefs.import) ? prefs.import : 'none';
    hint.textContent = tf(`import_${m}_hint`, { n: prefs.days });
    days.hidden = m !== 'existing';
  };
  paint();

  return el(
    'div',
    { className: 'prov prefs' },
    el(
      'div',
      { className: 'grow' },
      el('span', { text: t('what_title') }),
      field(t('which_calendar'), el('div', { className: 'actions' }, calendar, refresh), {
        hint: t('separate_hint'),
      }),
      field(t('import_title'), mode),
      hint,
      days,
      allowed.length < IMPORT_MODES.length
        ? el('small', { className: 'muted', text: tf('import_capped', { what: t(`import_${me.allowed.import}`) }) })
        : null,
      msg,
    ),
  );
};

const render = (me, after = '') => {
  const cards = providerCards({
    connection: me.connection,
    googleReady: !!me.google_ready,
    caldavReady: !!me.caldav_ready,
    onChanged: async (what) => {
      await load(what === 'connected' ? t('connected_ok') : t('disconnected_ok'));
    },
  });
  root.replaceChildren(
    ...[
      el('h1', { text: t('my_title') }),
      el('p', { className: 'intro', text: t('my_intro') }),
      note,
      cards.root,
      me.connection.connected && me.prefs ? prefsBox(me) : null,
      me.connection.connected && me.configured && me.sync ? syncBox(me) : null,
      me.connection.connected ? el('p', { className: 'muted small after', text: t('disconnect_note') }) : null,
    ].filter(Boolean),
  );
  if (after) notice(note, after, 'success');
  else if (!me.google_ready && !me.caldav_ready) notice(note, t('google_missing'), 'warn');
  else if (!me.configured) notice(note, t('not_configured'), 'info');
  else notice(note, '');
};

const load = async (after) => render(await server('GET', '/api/me'), after);

const fail = (e) => {
  root.replaceChildren(el('h1', { text: t('my_title') }), note);
  notice(note, e.status === 401 ? t('not_installed') : errText(e.code, e.message), 'error');
};

start()
  .then(() => load())
  .catch(fail);
