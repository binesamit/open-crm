// SPDX-License-Identifier: AGPL-3.0-only
// The admins' settings page (Administration → Extensions → Calendar sync), as in the approved canvas: the steps on
// the side (✓ done, the current one highlighted, a click scrolls to its card), one card per step, "what syncs" as one
// matrix of switches, the extras as switch rows, "advanced" folded (own OAuth client, recurring events, days back),
// the status with three numbers, and a save bar that stays in view.
import {
  $,
  button,
  el,
  errText,
  field,
  fmtAgo,
  fmtTime,
  iconOf,
  input,
  nextId,
  notice,
  numInput,
  picker,
  providerCards,
  segmented,
  server,
  start,
  t,
  tf,
  toggle,
  watchVisible,
} from './common.js';

const VARS = ['title', 'description', 'location', 'meet_link', 'organizer', 'attendees', 'calendar'];
const ZONES = [
  'Asia/Jerusalem',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
];
const DURATIONS = [30, 60, 120];

let state = null; // GET /api/admin/state
let board = null; // GET /api/admin/board
let cfg = null; // the draft
let advOpen = false;
let rsvpOn = false; // the answers switch (on with no column picked yet = still off in the saved settings)
let otherDuration = false;
let saveState = { kind: 'idle', text: '' }; // idle | dirty | saving | saved | error
let currentStep = null;
const root = $('root');
const top = el('p', { className: 'notice', attrs: { hidden: true } });

const defaults = (boardId) => ({
  board_id: boardId,
  time_source: 'timeline',
  date_column_id: '',
  start_column_id: null,
  end_column_id: null,
  default_duration: 60,
  people_column_id: null,
  target: 'personal',
  no_people: 'creator',
  shared: null,
  timezone: 'Asia/Jerusalem',
  past_days: 30,
  member_import: 'existing',
  recurring: { enabled: false, days: 90 },
  directions: {
    to_google: { create: true, update: true, delete: true },
    to_bines: { create: true, update: true, delete: true },
  },
  on_bines_delete: 'delete',
  on_google_delete: 'trash',
  delete_status: null,
  attendees: { enabled: false, email_column_id: null, send_updates: 'none' },
  rsvp: { column_id: null, labels: { accepted: '', declined: '', tentative: '', pending: '' }, comments: false },
  create_meet: false,
  reminders: { enabled: false, popup_minutes: 10, email_minutes: null },
  template: { group_id: null, name: '{{title}}', fields: [] },
});

// ---- small builders -------------------------------------------------------------------------------------------

/** Something in the draft changed: the save bar says so (`redraw` = the page's shape depends on it). */
const changed = (redraw = false) => {
  if (saveState.kind !== 'saving') saveState = { kind: 'dirty', text: t('unsaved') };
  if (redraw) render();
  else {
    paintSaveState();
    paintSteps();
  }
};
const set =
  (fn, redraw = false) =>
  (v) => {
    fn(v);
    changed(redraw);
  };

const card = (key, title, sub, ...children) =>
  el(
    'section',
    { className: 'card', attrs: { id: `card-${key}`, 'aria-labelledby': `h-${key}`, 'data-step': key } },
    title ? el('h2', { text: title, attrs: { id: `h-${key}` } }) : null,
    sub ? el('p', { className: 'sub', text: sub }) : null,
    ...children,
  );

const choice = (label, options, value, onChange, extra = {}) =>
  field(label, picker({ options, value, onChange, label, ...extra }).root, { className: extra.className });

const seg = (label, options, value, onChange, className) => {
  const id = nextId('sl');
  return el(
    'div',
    { className: `field ${className ?? ''}`.trim() },
    el('span', { className: 'flabel', text: label, attrs: { id } }),
    segmented({ options, value, onChange, labelledby: id }),
  );
};

/**
 * A row with a text (and a line under it) and a switch at the end. `body` (the row's own settings) shows under it
 * while it is on: opened when the switch is turned on, then folded behind a "settings" button (`key` keeps it open
 * across renders).
 */
const openRows = new Set();
const switchRow = (title, hint, on, onChange, body, key) => {
  const id = nextId('sr');
  const hid = hint ? nextId('sh') : undefined;
  const bodyId = nextId('rb');
  const foldable = !!(body && key);
  const shown = on && body && (!foldable || openRows.has(key));
  return el(
    'div',
    { className: 'rowgroup' },
    el(
      'div',
      { className: 'row' },
      el(
        'div',
        { className: 'txt grow' },
        el('span', { text: title, attrs: { id } }),
        hint ? el('small', { text: hint, attrs: { id: hid } }) : null,
      ),
      foldable && on
        ? button(
            t('row_settings'),
            () => {
              if (openRows.has(key)) openRows.delete(key);
              else openRows.add(key);
              render();
            },
            'ghost small',
            { 'aria-expanded': shown ? 'true' : 'false', 'aria-controls': bodyId, 'aria-describedby': id },
          )
        : null,
      toggle({
        checked: on,
        labelledby: id,
        describedby: hid,
        onChange: (v) => {
          if (key && v) openRows.add(key);
          onChange(v);
        },
      }),
    ),
    shown ? el('div', { className: 'rowbody', attrs: { id: bodyId } }, body) : null,
  );
};

const columns = (types, withNone = true) => [
  ...(withNone ? [{ value: null, label: t('none') }] : []),
  ...(board?.columns ?? [])
    .filter((c) => !types || types.includes(c.type))
    .map((c) => ({ value: c.id, label: c.title, icon: iconOf(c.type) })),
];
const columnTitle = (id) => board?.columns.find((c) => c.id === id)?.title ?? '';

const copyButton = (value) =>
  button(t('copy'), async (e) => {
    const b = e.currentTarget;
    await navigator.clipboard.writeText(value).catch(() => undefined);
    b.textContent = t('copied');
    setTimeout(() => (b.textContent = t('copy')), 1500);
  });

// ---- which steps are done -------------------------------------------------------------------------------------

const STEPS = ['google', 'board', 'people', 'flow', 'invites', 'template', 'status'];
const isDone = (key) => {
  if (!state) return false;
  const saved = !!state.config;
  switch (key) {
    case 'google':
      return !!state.me.connection.connected;
    case 'board':
      return !!(
        cfg.board_id &&
        cfg.date_column_id &&
        (cfg.time_source === 'timeline' || (cfg.start_column_id && cfg.end_column_id))
      );
    case 'people':
      return (
        (cfg.target === 'shared' || !!cfg.people_column_id) && (cfg.target === 'personal' || !!cfg.shared?.calendar_id)
      );
    case 'flow':
    case 'invites':
    case 'template':
      return saved && isDone('board');
    default:
      return false;
  }
};

let stepButtons = [];
const paintSteps = () => {
  const firstOpen = STEPS.find((k) => !isDone(k) && document.getElementById(`card-${k}`)) ?? STEPS[0];
  const on = currentStep ?? firstOpen;
  for (const b of stepButtons) {
    const k = b.dataset.step;
    const done = isDone(k);
    b.classList.toggle('done', done);
    b.classList.toggle('on', k === on);
    if (k === on) b.setAttribute('aria-current', 'step');
    else b.removeAttribute('aria-current');
    b.querySelector('.n').textContent = done ? '✓' : String(STEPS.indexOf(k) + 1);
    b.querySelector('.state').textContent = done ? ` (${t('step_done')})` : '';
  }
};

const stepsNav = () => {
  stepButtons = STEPS.filter((k) => k === 'google' || k === 'board' || k === 'status' || board).map((k) =>
    el(
      'button',
      {
        className: 'step',
        attrs: { type: 'button', 'data-step': k },
        on: {
          click: () => {
            currentStep = k;
            clickedAt = Date.now();
            paintSteps();
            const target = document.getElementById(`card-${k}`);
            target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            target?.querySelector('h2')?.setAttribute('tabindex', '-1');
            target?.querySelector('h2')?.focus({ preventScroll: true });
          },
        },
      },
      el('span', { className: 'n', attrs: { 'aria-hidden': 'true' } }),
      el('span', { className: 'lbl', text: t(`step_${k}`) }),
      el('span', { className: 'state sr-only' }),
    ),
  );
  return el(
    'nav',
    { attrs: { 'aria-label': t('steps') } },
    el('ol', { className: 'steps' }, ...stepButtons.map((b) => el('li', {}, b))),
  );
};

// ---- cards ----------------------------------------------------------------------------------------------------

let showProviders = false;
const googleCard = () => {
  const c = state.me.connection;
  const name = state.me.name || c.email || '';
  const cards = () =>
    providerCards({
      connection: c,
      googleReady: state.client.source !== 'none',
      caldavReady: !!state.caldav_ready,
      onChanged: () => {
        showProviders = false;
        return reload(false);
      },
    }).root;
  const disconnect = button(t('disconnect'), async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      await server('DELETE', '/api/connection');
      await reload(false);
    } catch (err) {
      notice(top, errText(err.code, err.message), 'error');
      b.disabled = false;
    }
  });
  const body = c.connected
    ? el(
        'div',
        {},
        el(
          'div',
          { className: 'acct' },
          el('span', {
            className: 'avatar',
            text: (name.trim()[0] ?? '?').toUpperCase(),
            attrs: { 'aria-hidden': 'true' },
          }),
          el(
            'div',
            { className: 'grow' },
            el('span', { text: name }),
            el('small', { text: `${c.email} · ${t(`provider_${c.provider}`)} · ${t('personal_cal')}` }),
          ),
          el(
            'div',
            { className: 'actions' },
            button(
              t('reconnect'),
              () => {
                showProviders = !showProviders;
                render();
                $('reconnect-mine')?.focus();
              },
              'ghost',
              { id: 'reconnect-mine', 'aria-expanded': showProviders ? 'true' : 'false' },
            ),
            disconnect,
          ),
        ),
        showProviders ? el('div', { className: 'below' }, cards()) : null,
      )
    : cards();
  return card(
    'google',
    null,
    null,
    el(
      'div',
      { className: 'card-head' },
      el('h2', { className: 'grow', text: t('step_google'), attrs: { id: 'h-google' } }),
      el('span', {
        className: `pill ${c.connected ? 'ok' : 'muted'}`,
        text: c.connected ? t('connected') : t('not_connected'),
      }),
    ),
    el('p', { className: 'sub', text: c.connected ? t('sub_google') : `${t('sub_google')} ${t('mine_intro')}` }),
    body,
  );
};

const boardCard = () => {
  const dateTypes = cfg.time_source === 'timeline' ? ['timeline'] : ['date', 'timeline'];
  const durationOptions = [
    ...DURATIONS.map((m) => ({ value: m, label: t(`dur_${m}`) })),
    { value: 'other', label: t('dur_other') },
  ];
  const durationValue = otherDuration || !DURATIONS.includes(cfg.default_duration) ? 'other' : cfg.default_duration;
  const myZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let zones = ZONES;
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    /* an older browser: the short list */
  }
  return card(
    'board',
    t('step_board'),
    t('sub_board'),
    el(
      'div',
      { className: 'fields' },
      choice(
        t('board'),
        state.boards.map((b) => ({ value: b.id, label: b.name, icon: iconOf('board') })),
        cfg.board_id || null,
        async (v) => {
          cfg = {
            ...cfg,
            board_id: v,
            date_column_id: '',
            start_column_id: null,
            end_column_id: null,
            people_column_id: null,
          };
          await loadBoard(v);
          changed(true);
        },
        { icon: iconOf('board') },
      ),
      board
        ? seg(
            t('time_source'),
            [
              { value: 'timeline', label: t('src_timeline') },
              { value: 'date_hours', label: t('src_date_hours') },
            ],
            cfg.time_source,
            set((v) => (cfg.time_source = v), true),
          )
        : null,
      board
        ? choice(
            cfg.time_source === 'timeline' ? t('timeline_column') : t('date_column'),
            columns(dateTypes, false),
            cfg.date_column_id || null,
            set((v) => (cfg.date_column_id = v)),
            { icon: iconOf(cfg.time_source === 'timeline' ? 'timeline' : 'date') },
          )
        : null,
      board && cfg.time_source === 'date_hours'
        ? el(
            'div',
            { className: 'field' },
            el('span', { className: 'flabel', text: t('hours_columns'), attrs: { 'aria-hidden': 'true' } }),
            el(
              'div',
              { className: 'pair' },
              picker({
                options: columns(['hour']),
                value: cfg.start_column_id,
                onChange: set((v) => (cfg.start_column_id = v)),
                label: t('start_column'),
                placeholder: t('start_column'),
                icon: iconOf('hour'),
              }).root,
              picker({
                options: columns(['hour']),
                value: cfg.end_column_id,
                onChange: set((v) => (cfg.end_column_id = v)),
                label: t('end_column'),
                placeholder: t('end_column'),
                icon: iconOf('hour'),
              }).root,
            ),
          )
        : null,
      board
        ? el(
            'div',
            { className: 'field' },
            ...(() => {
              const id = nextId('sl');
              return [
                el('span', { className: 'flabel', text: t('duration'), attrs: { id } }),
                el(
                  'div',
                  { className: 'actions' },
                  segmented({
                    options: durationOptions,
                    value: durationValue,
                    labelledby: id,
                    onChange: (v) => {
                      otherDuration = v === 'other';
                      if (v !== 'other') cfg.default_duration = v;
                      changed(true);
                    },
                  }),
                  durationValue === 'other'
                    ? el(
                        'span',
                        { className: 'actions' },
                        numInput(
                          cfg.default_duration,
                          set((v) => (cfg.default_duration = v ?? 60)),
                          { 'aria-label': `${t('duration')} (${t('minutes')})` },
                        ),
                        el('span', { className: 'muted', text: t('minutes') }),
                      )
                    : null,
                ),
              ];
            })(),
          )
        : null,
      board
        ? choice(
            t('timezone'),
            [...new Set([cfg.timezone, ...ZONES, ...zones])].map((z) => ({
              value: z,
              label: z === myZone ? `${z} ${t('tz_yours')}` : z,
            })),
            cfg.timezone,
            set((v) => (cfg.timezone = v)),
          )
        : null,
    ),
    state.boards.length ? null : el('p', { className: 'muted below', text: t('no_boards') }),
  );
};

const peopleCard = () =>
  card(
    'people',
    t('step_people'),
    t('sub_people'),
    el(
      'div',
      { className: 'fields' },
      choice(
        t('people_column'),
        columns(['people']),
        cfg.people_column_id,
        set((v) => (cfg.people_column_id = v)),
        { icon: iconOf('people') },
      ),
      seg(
        t('target'),
        ['personal', 'shared', 'both'].map((v) => ({ value: v, label: t(`target_${v}`) })),
        cfg.target,
        set((v) => (cfg.target = v), true),
      ),
      cfg.target !== 'shared'
        ? seg(
            t('no_people'),
            ['creator', 'skip'].map((v) => ({ value: v, label: t(`np_${v}`) })),
            cfg.no_people ?? 'creator',
            set((v) => (cfg.no_people = v)),
          )
        : null,
      cfg.target !== 'personal'
        ? state.calendars.some((c) => c.writable)
          ? choice(
              t('shared_calendar'),
              state.calendars
                .filter((c) => c.writable)
                .map((c) => ({ value: c.id, label: c.name, icon: iconOf('calendar') })),
              cfg.shared?.calendar_id ?? null,
              set(
                (v) =>
                  (cfg.shared = {
                    user_id: state.me.id,
                    calendar_id: v,
                    calendar_name: state.calendars.find((c) => c.id === v)?.name ?? v,
                  }),
              ),
              { icon: iconOf('calendar') },
            )
          : field(t('shared_calendar'), el('p', { className: 'muted', text: t('shared_need') }))
        : null,
    ),
  );

const flowCard = () => {
  const d = cfg.directions;
  const toGoogleDel = d.to_google.delete ? cfg.on_bines_delete : 'unlink';
  const toBinesDel = d.to_bines.delete ? cfg.on_google_delete : 'unlink';
  const heads = [t('to_google'), t('to_bines')];
  const cell = (i, control) => el('td', { className: 'c', attrs: { 'data-label': heads[i] } }, control);
  const rowFor = (k) => {
    const id = nextId('mx');
    return el(
      'tr',
      {},
      el('td', { text: t(`d_${k}`), attrs: { id } }),
      ...['to_google', 'to_bines'].map((dir, i) => {
        const hid = nextId('mh');
        return cell(
          i,
          el(
            'span',
            {},
            el('span', { className: 'sr-only', text: heads[i], attrs: { id: hid } }),
            toggle({
              checked: d[dir][k],
              labelledby: `${id} ${hid}`,
              onChange: set((v) => (d[dir][k] = v)),
            }),
          ),
        );
      }),
    );
  };
  const delId = nextId('mx');
  return card(
    'flow',
    t('step_flow'),
    t('sub_flow'),
    el(
      'table',
      { className: 'matrix' },
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', { attrs: { scope: 'col' } }, el('span', { className: 'sr-only', text: t('action') })),
          ...heads.map((h) => el('th', { className: 'c', text: h, attrs: { scope: 'col' } })),
        ),
      ),
      el(
        'tbody',
        {},
        rowFor('create'),
        rowFor('update'),
        el(
          'tr',
          {},
          el('td', { text: t('d_delete'), attrs: { id: delId } }),
          cell(
            0,
            segmented({
              options: ['unlink', 'delete', 'cancel'].map((v) => ({ value: v, label: t(`obd_${v}`) })),
              value: toGoogleDel,
              label: `${t('d_delete')} — ${heads[0]}`,
              onChange: set((v) => {
                d.to_google.delete = true;
                cfg.on_bines_delete = v;
              }),
            }),
          ),
          cell(
            1,
            segmented({
              options: ['unlink', 'archive', 'trash', 'status'].map((v) => ({ value: v, label: t(`ogd_${v}`) })),
              value: toBinesDel,
              label: `${t('d_delete')} — ${heads[1]}`,
              onChange: set((v) => {
                d.to_bines.delete = true;
                cfg.on_google_delete = v;
              }, true),
            }),
          ),
        ),
      ),
    ),
    el('p', { className: 'muted small below', text: t('delete_hint') }),
    toBinesDel === 'status'
      ? el(
          'div',
          { className: 'fields below' },
          choice(
            t('status_column'),
            columns(['status'], false),
            cfg.delete_status?.column_id ?? null,
            set((v) => (cfg.delete_status = { column_id: v, label: cfg.delete_status?.label ?? '' })),
            { icon: iconOf('status') },
          ),
          field(
            t('status_label'),
            input(
              cfg.delete_status?.label ?? '',
              set((v) => (cfg.delete_status = { column_id: cfg.delete_status?.column_id ?? '', label: v })),
            ),
          ),
        )
      : null,
  );
};

const invitesCard = () => {
  const labels = cfg.rsvp.labels;
  const rsvpHint = cfg.rsvp.column_id
    ? `${['accepted', 'declined', 'tentative', 'pending'].map((k) => labels[k] || '—').join(' · ')} ← "${columnTitle(cfg.rsvp.column_id)}"`
    : t('rsvp_hint');
  const meetCol = cfg.template.fields.find((f) => f.template.includes('{{meet_link}}'))?.column_id;
  return card(
    'invites',
    t('step_invites'),
    t('sub_invites'),
    el(
      'div',
      { className: 'rows' },
      switchRow(
        t('invites_on'),
        t('invites_hint'),
        cfg.attendees.enabled,
        set((v) => (cfg.attendees.enabled = v), true),
        el(
          'div',
          { className: 'fields' },
          choice(
            t('email_column'),
            columns(['email', 'text', 'long_text']),
            cfg.attendees.email_column_id,
            set((v) => (cfg.attendees.email_column_id = v)),
            { icon: iconOf('email') },
          ),
          seg(
            t('send_updates'),
            ['all', 'externalOnly', 'none'].map((v) => ({ value: v, label: t(`su_${v}`) })),
            cfg.attendees.send_updates,
            set((v) => (cfg.attendees.send_updates = v)),
          ),
        ),
        'invites',
      ),
      switchRow(
        t('rsvp_on'),
        rsvpHint,
        rsvpOn,
        (v) => {
          rsvpOn = v;
          if (!v) cfg.rsvp.column_id = null;
          changed(true);
        },
        el(
          'div',
          { className: 'fields' },
          choice(
            t('rsvp_column'),
            columns(['status'], false),
            cfg.rsvp.column_id,
            set((v) => (cfg.rsvp.column_id = v), true),
            { icon: iconOf('status'), className: 'wide' },
          ),
          ...['accepted', 'declined', 'tentative', 'pending'].map((k) =>
            field(
              t(`rsvp_${k}`),
              input(
                labels[k],
                set((v) => (labels[k] = v)),
              ),
            ),
          ),
          el(
            'div',
            { className: 'rows wide' },
            switchRow(
              t('rsvp_comments'),
              t('rsvp_comments_hint'),
              cfg.rsvp.comments,
              set((v) => (cfg.rsvp.comments = v)),
            ),
          ),
        ),
        'rsvp',
      ),
      switchRow(
        t('meet'),
        meetCol ? tf('meet_hint_col', { col: columnTitle(meetCol) }) : t('meet_hint_none'),
        cfg.create_meet,
        set((v) => (cfg.create_meet = v)),
      ),
      switchRow(
        t('reminders_on'),
        cfg.reminders.enabled ? t('reminders_hint') : null,
        cfg.reminders.enabled,
        set((v) => (cfg.reminders.enabled = v), true),
        el(
          'div',
          { className: 'fields' },
          field(
            t('popup_minutes'),
            numInput(
              cfg.reminders.popup_minutes,
              set((v) => (cfg.reminders.popup_minutes = v)),
            ),
          ),
          field(
            t('email_minutes'),
            numInput(
              cfg.reminders.email_minutes,
              set((v) => (cfg.reminders.email_minutes = v)),
            ),
          ),
        ),
        'reminders',
      ),
    ),
  );
};

const templateCard = () => {
  const list = el('div', { className: 'tfields' });
  const drawFields = () =>
    list.replaceChildren(
      ...cfg.template.fields.map((f, i) =>
        el(
          'div',
          { className: 'tfield' },
          picker({
            options: columns(null, false),
            value: f.column_id || null,
            onChange: set((v) => (f.column_id = v)),
            label: `${t('template_column')} ${i + 1}`,
          }).root,
          input(
            f.template,
            set((v) => (f.template = v)),
            { dir: 'auto', 'aria-label': `${t('template_value')} ${i + 1}` },
          ),
          button(
            t('remove'),
            () => {
              cfg.template.fields.splice(i, 1);
              changed();
              drawFields();
            },
            'ghost',
            { 'aria-label': `${t('remove')} ${i + 1}` },
          ),
        ),
      ),
    );
  drawFields();
  return card(
    'template',
    t('step_template'),
    t('sub_template'),
    el(
      'div',
      { className: 'fields' },
      field(
        t('template_name'),
        input(
          cfg.template.name,
          set((v) => (cfg.template.name = v)),
          { dir: 'auto' },
        ),
      ),
      choice(
        t('template_group'),
        [
          { value: null, label: t('none') },
          ...(board?.groups ?? []).map((g) => ({ value: g.id, label: g.title, icon: iconOf('group') })),
        ],
        cfg.template.group_id,
        set((v) => (cfg.template.group_id = v)),
        { icon: iconOf('group') },
      ),
    ),
    el('h4', { className: 'below', text: t('template_fields') }),
    list,
    el(
      'div',
      { className: 'below' },
      button(t('add_field'), () => {
        cfg.template.fields.push({ column_id: '', template: '{{description}}' });
        changed();
        drawFields();
        list.lastElementChild?.querySelector('button')?.focus();
      }),
    ),
    el(
      'p',
      { className: 'vars' },
      el('span', { text: t('vars') }),
      ...VARS.map((v) => el('code', { text: `{{${v}}}` })),
    ),
  );
};

const advanced = () => {
  const bodyId = 'adv-body';
  const toggleBtn = el(
    'button',
    {
      className: 'adv',
      attrs: { type: 'button', 'aria-expanded': advOpen ? 'true' : 'false', 'aria-controls': bodyId },
      on: {
        click: () => {
          advOpen = !advOpen;
          render();
          $('adv-toggle')?.focus();
        },
      },
    },
    el('span', { className: 'chev', text: '⌄', attrs: { 'aria-hidden': 'true' } }),
    el('span', { text: `${t('adv_title')}: ${t('adv_summary')}` }),
  );
  toggleBtn.id = 'adv-toggle';
  if (!advOpen) return el('div', { className: 'adv-wrap' }, toggleBtn);
  return el(
    'div',
    { className: 'adv-wrap' },
    toggleBtn,
    el(
      'div',
      { className: 'adv-body', attrs: { id: bodyId } },
      clientCard(),
      board
        ? card(
            'import',
            t('adv_import'),
            null,
            el(
              'div',
              { className: 'rows' },
              switchRow(
                t('recurring_on'),
                t('recurring_hint'),
                cfg.recurring.enabled,
                set((v) => (cfg.recurring.enabled = v), true),
                field(
                  t('recurring_days'),
                  numInput(
                    cfg.recurring.days,
                    set((v) => (cfg.recurring.days = v ?? 90)),
                  ),
                ),
              ),
              el(
                'div',
                { className: 'row' },
                el(
                  'div',
                  { className: 'txt grow' },
                  el('span', { text: t('past_days'), attrs: { id: 'past-days' } }),
                  el('small', { text: t('past_days_hint') }),
                ),
                numInput(
                  cfg.past_days,
                  set((v) => (cfg.past_days = v ?? 30)),
                  { 'aria-labelledby': 'past-days' },
                ),
              ),
              el(
                'div',
                { className: 'row' },
                el(
                  'div',
                  { className: 'txt grow' },
                  el('span', { text: t('member_import'), attrs: { id: 'member-import' } }),
                  el('small', { text: t('member_import_hint') }),
                ),
                segmented({
                  options: ['none', 'new', 'existing'].map((v) => ({ value: v, label: t(`import_${v}`) })),
                  value: cfg.member_import ?? 'existing',
                  onChange: set((v) => (cfg.member_import = v)),
                  labelledby: 'member-import',
                }),
              ),
            ),
          )
        : null,
    ),
  );
};

const clientCard = () => {
  const c = state.client;
  const msg = el('p', { className: 'notice', attrs: { hidden: true } });
  let id = c.source === 'account' ? c.client_id : '';
  let secret = '';
  return card(
    'client',
    t('sec_client'),
    t(`client_source_${c.source}`),
    el(
      'div',
      { className: 'fields' },
      field(
        t('redirect_uri'),
        el(
          'div',
          { className: 'copyrow' },
          el('code', { text: state.urls.redirect_uri }),
          copyButton(state.urls.redirect_uri),
        ),
        { className: 'wide' },
      ),
      field(
        t('client_id'),
        input(id, (v) => (id = v), { autocomplete: 'off', dir: 'ltr' }),
      ),
      field(
        t('client_secret'),
        input('', (v) => (secret = v), {
          type: 'password',
          autocomplete: 'new-password',
          dir: 'ltr',
          placeholder: c.source === 'account' ? t('secret_keep') : '',
        }),
        { hint: c.secret_hint && c.source === 'account' ? `${t('secret_saved')}${c.secret_hint}` : undefined },
      ),
    ),
    el(
      'div',
      { className: 'actions below' },
      button(
        t('save_client'),
        async () => {
          try {
            await server('PUT', '/api/admin/google-client', { client_id: id, client_secret: secret });
            await reload(false);
          } catch (e) {
            notice(msg, errText(e.code, e.message), 'error');
          }
        },
        'primary',
      ),
      c.source === 'account'
        ? button(t('remove_client'), async () => {
            try {
              await server('DELETE', '/api/admin/google-client');
              await reload(false);
            } catch (e) {
              notice(msg, errText(e.code, e.message), 'error');
            }
          })
        : null,
    ),
    msg,
    el(
      'details',
      {},
      el('summary', { text: t('guide_title') }),
      el('ol', { className: 'guide' }, ...t('guide').map((s) => el('li', { text: s }))),
    ),
    el(
      'details',
      {},
      el('summary', { text: t('other_urls') }),
      el(
        'ul',
        { className: 'urls' },
        ...['origin', 'lifecycle', 'webhook', 'push'].map((k) => el('li', {}, el('code', { text: state.urls[k] }))),
        el('li', {}, el('code', { text: `${state.urls.origin}/health` })),
      ),
    ),
  );
};

const statusCard = () => {
  const s = state.status;
  const errors = s.log.filter((l) => l.level === 'error').length;
  const failing = s.streams.filter((r) => r.last_error).length;
  const bad = errors + failing;
  const stat = (v, k, cls = '') =>
    el(
      'div',
      { className: `stat ${cls}`.trim() },
      el('div', { className: 'v', text: v }),
      el('div', { className: 'k', text: k }),
    );
  return card(
    'status',
    t('sec_status'),
    `${tf('last_sync', { when: fmtAgo(s.last_sync_at) })} · ${bad ? tf('n_errors', { n: bad }) : t('no_errors')}`,
    el(
      'div',
      { className: 'health' },
      stat(String(s.connections), t('stat_members')),
      stat(String(s.streams.length), t('stat_calendars')),
      stat(String(bad), t('stat_errors'), bad ? 'bad' : ''),
    ),
    s.streams.length
      ? el(
          'details',
          {},
          el('summary', { text: `${t('calendars_title')} (${s.streams.length}) · ${t('hooks')}${s.hooks}` }),
          el(
            'ul',
            { className: 'streams' },
            ...s.streams.map((r) =>
              el(
                'li',
                {},
                el('span', { className: 'who', text: `${r.user} (${r.email})` }),
                el('span', { text: `${t(`role_${r.role}`)} · ${r.calendar_id}` }),
                el('span', { text: `${t('col_last')}: ${fmtTime(r.last_sync_at)}` }),
                el('span', { text: `${t('col_push')}: ${r.push_until ? fmtTime(r.push_until) : '—'}` }),
                r.last_error ? el('span', { className: 'err', text: r.last_error }) : null,
              ),
            ),
          ),
        )
      : null,
    el(
      'details',
      { attrs: { open: s.log.length > 0 && s.log.length <= 5 } },
      el('summary', { text: t('log_title') }),
      s.log.length
        ? el(
            'ul',
            { className: 'log' },
            ...s.log.map((l) => el('li', { className: l.level, text: `${fmtTime(l.at)} — ${l.message}` })),
          )
        : el('p', { className: 'muted', text: t('no_log') }),
    ),
  );
};

// ---- the save bar ---------------------------------------------------------------------------------------------

let saveMsg = null;
let saveBtn = null;
const paintSaveState = () => {
  if (!saveMsg) return;
  const { kind, text } = saveState;
  saveMsg.className = kind === 'saved' ? 'saved' : kind === 'error' ? 'save-err' : 'dirty';
  saveMsg.textContent = text;
  saveMsg.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  saveBtn.disabled = !cfg.board_id || kind === 'saving';
};

const saveBar = () => {
  saveMsg = el('span', { attrs: { role: 'status' } });
  saveBtn = button(
    t('save'),
    async () => {
      saveState = { kind: 'saving', text: t('saving') };
      paintSaveState();
      try {
        await server('PUT', '/api/admin/config', cfg);
        saveState = { kind: 'saved', text: t('saved') };
        await reload(false);
      } catch (e) {
        saveState = { kind: 'error', text: errText(e.code, e.message) };
        paintSaveState();
      }
    },
    'primary',
  );
  const sync = button(
    t('sync_now'),
    async () => {
      try {
        await server('POST', '/api/admin/sync');
        saveState = { kind: 'saved', text: t('sync_started') };
      } catch (e) {
        saveState = { kind: 'error', text: errText(e.code, e.message) };
      }
      paintSaveState();
    },
    'ghost',
    { disabled: !state.config },
  );
  const bar = el('div', { className: 'savebar' }, saveBtn, saveMsg, el('span', { className: 'grow' }), sync);
  paintSaveState();
  return bar;
};

// ---- page -----------------------------------------------------------------------------------------------------

let unwatch = null;
let observer = null;

/** Keeps the save bar (and the steps, on a wide page) in view while the host page scrolls the frame. */
const follow = (ext, nav, bar) => {
  unwatch?.();
  let navY = 0;
  let barY = 0;
  const wide = matchMedia('(min-width: 761px)');
  unwatch = watchVisible(ext, (visTop, visBottom) => {
    // A page that scrolls itself (no host resizing it) has CSS sticky; this is for the frame grown to its content.
    const framedFull = document.documentElement.scrollHeight <= window.innerHeight + 1;
    const extTop = ext.getBoundingClientRect().top;
    if (!framedFull) {
      navY = barY = 0;
    } else {
      const barH = bar.offsetHeight;
      const barNatural = bar.getBoundingClientRect().top - barY - extTop; // in ext coordinates
      const visB = visBottom; // already in ext coordinates
      barY = Math.min(0, visB - 8 - barH - barNatural);
      const navNatural = nav.getBoundingClientRect().top - navY - extTop;
      const maxNav = ext.offsetHeight - nav.offsetHeight;
      navY = wide.matches ? Math.max(0, Math.min(maxNav - navNatural, visTop + 12 - navNatural)) : 0;
    }
    bar.style.transform = barY ? `translateY(${barY}px)` : '';
    nav.style.transform = navY ? `translateY(${navY}px)` : '';
  });
};

/** The highlighted step follows the card in view (after the first scroll; a click on a step wins for a moment). */
let clickedAt = 0;
const watchCards = () => {
  observer?.disconnect();
  const seen = new Map();
  let first = true;
  observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries)
        seen.set(e.target, e.isIntersecting ? { top: e.boundingClientRect.top, h: e.intersectionRect.height } : null);
      if (first) {
        first = false;
        return;
      }
      if (Date.now() - clickedAt < 1200) return;
      const best = [...seen].filter(([, v]) => v && v.h > 80).sort((a, b) => a[1].top - b[1].top)[0];
      const k = best?.[0].dataset.step;
      if (k && STEPS.includes(k) && k !== currentStep) {
        currentStep = k;
        paintSteps();
      }
    },
    { threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
  );
  for (const c of document.querySelectorAll('.card[data-step]')) observer.observe(c);
};

/** Which control had the focus, by its place among the page's controls (ids are made afresh on each render). */
const FOCUSABLE = 'button:not([disabled]), input, [tabindex]';
const focusIndex = () => {
  const a = document.activeElement;
  if (!a || a === document.body || !root.contains(a)) return -1;
  return [...root.querySelectorAll(FOCUSABLE)].indexOf(a);
};

const render = () => {
  const focusAt = focusIndex();
  const nav = stepsNav();
  const bar = saveBar();
  const main = el(
    'div',
    { className: 'main' },
    googleCard(),
    boardCard(),
    ...(board ? [peopleCard(), flowCard(), invitesCard(), templateCard()] : []),
    advanced(),
    statusCard(),
    bar,
  );
  const ext = el('div', { className: 'ext' }, nav, main);
  root.replaceChildren(el('h1', { className: 'sr-only', text: t('admin_title') }), top, ext);
  paintSteps();
  follow(ext, nav, bar);
  watchCards();
  if (focusAt >= 0) [...root.querySelectorAll(FOCUSABLE)][focusAt]?.focus({ preventScroll: true });
};

const loadBoard = async (id) => {
  board = id ? await server('GET', `/api/admin/board?id=${encodeURIComponent(id)}`).catch(() => null) : null;
};

const reload = async (resetDraft = true) => {
  state = await server('GET', '/api/admin/state');
  if (resetDraft || !cfg) {
    cfg = structuredClone(state.config ?? defaults(''));
    if (saveState.kind !== 'saved') saveState = { kind: 'idle', text: '' };
  }
  rsvpOn = !!cfg.rsvp.column_id;
  if (cfg.board_id && board?.id !== cfg.board_id) await loadBoard(cfg.board_id);
  render();
};

start()
  .then(() => {
    root.setAttribute('aria-busy', 'true');
    return reload();
  })
  .then(() => root.removeAttribute('aria-busy'))
  .catch((e) => {
    notice(top, e.status === 401 ? t('not_installed') : errText(e.code, e.message), 'error');
    root.replaceChildren(top);
  });
