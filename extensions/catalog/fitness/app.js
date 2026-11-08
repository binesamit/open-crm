// SPDX-License-Identifier: AGPL-3.0-only
// "כושר" — a board-view extension for trainees and coaches, built to the approved prototype
//: a workout mode (one exercise on the phone, the whole workout
// on a computer, a real rest timer, "last time" and records), food logging against a target with foods outside the
// plan, the week and progress, building workout and nutrition plans, a coach screen, and its settings — which of the
// person's boards and columns play which role. Writes go through an offline queue (data.js).
import { applyContext, sdk, tr } from '../common.js';
import { createQueue, createStore, guessSettings, ROLES, roleBoardId, settingsBoards, today } from './data.js';
import { createModel, daysAgo } from './model.js';
import { beep, clock, closePop, figure, fmt, h, select, wakeLock } from './ui.js';

const bines = sdk();
const awake = wakeLock();
const app = document.getElementById('app');

/** Everything the screens need; `render()` draws from it. */
const S = {
  ctx: null,
  cfg: null,
  cfgSaved: false,
  store: null,
  m: null,
  q: null,
  queued: 0,
  loading: true,
  error: '',
  tab: 'train',
  trainSub: 'next',
  foodSub: 'today',
  woPick: null,
  screen: 'home',
  ses: null,
  members: [],
  coachSel: null,
  coachSub: 'train',
  food: { group: null, local: new Map(), removed: new Set(), dayTmp: null, adding: null },
  prog: null,
  plan: null,
  noteFor: null,
  flash: '',
};
const T = (he, en) => tr(S.ctx ?? { locale: 'he' }, he, en);
const me = () => S.ctx.user.id;
const cfgKey = () => `cfg.${S.ctx.board_id}`;
const sesKey = () => `fit.ses.${S.ctx.board_id}.${me()}`;
const compact = (o) =>
  Object.fromEntries(
    Object.entries(o).filter(
      ([k, v]) => k && k !== 'undefined' && k !== 'null' && v !== undefined && v !== null && v !== '',
    ),
  );
const dm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '');

// ================================================================ boot

const narrow = () => {
  const on = window.innerWidth < 720;
  document.documentElement.classList.toggle('narrow', on);
  return document.body.classList.toggle('narrow', on);
};

const main = async () => {
  S.ctx = await bines.ready();
  applyContext(S.ctx);
  bines.listen('context', (c) => {
    S.ctx = c;
    applyContext(c);
    render();
  });
  narrow();
  // On a computer the frame follows the page's height; on a phone it is the screen's (the host fills it).
  let stopResize = document.body.classList.contains('narrow') ? null : bines.autoResize();
  window.addEventListener('resize', () => {
    const isNarrow = window.innerWidth < 720;
    if (isNarrow && stopResize) {
      stopResize();
      stopResize = null;
    } else if (!isNarrow && !stopResize) stopResize = bines.autoResize();
  });
  window.addEventListener('resize', () => {
    const was = document.body.classList.contains('narrow');
    narrow();
    if (was !== document.body.classList.contains('narrow')) render();
  });
  S.store = createStore(bines);
  S.q = createQueue({
    api: S.store.api,
    accountKey: `${S.ctx.account_id}:${S.ctx.board_id}:${me()}`,
    onChange: (n) => {
      const drained = S.queued > 0 && n === 0;
      S.queued = n;
      if (drained) void refreshLogs();
      paintSync();
    },
    onError: (op, err) => {
      S.error = `${T('לא נשמר', 'Not saved')}: ${op.what ?? op.path} (${err?.code || err?.message || err})`;
      render();
    },
  });
  render();
  await loadSettings();
  await loadAll();
  try {
    const saved = JSON.parse(localStorage.getItem(sesKey()) ?? 'null');
    if (saved?.workoutId) resumeSession(saved);
  } catch {
    // nothing to resume
  }
  S.loading = false;
  render();
  void S.q.flush();
};

const loadSettings = async () => {
  const ids = S.ctx.board_ids?.length ? S.ctx.board_ids : [S.ctx.board_id];
  await Promise.all(ids.map((id) => S.store.loadBoard(id)));
  let cfg = null;
  try {
    cfg = await bines.storage.get(cfgKey(), { scope: 'installation' });
  } catch {
    cfg = null;
  }
  if (!cfg) {
    try {
      cfg = await bines.storage.get(cfgKey(), { scope: 'user' });
    } catch {
      cfg = null;
    }
  }
  S.cfgSaved = !!cfg;
  S.cfg = cfg ?? guessSettings(S.ctx.board_id, S.store.boards);
  if (!S.cfgSaved) S.tab = 'settings';
};

const loadAll = async () => {
  const c = S.cfg;
  const ids = settingsBoards(c);
  await Promise.all(ids.map((id) => S.store.loadBoard(id)));
  await Promise.all(ids.map((id) => S.store.loadItems(id, true)));
  await Promise.all(
    [c.train?.templates, c.train?.log, c.food?.menu, c.food?.flog]
      .filter(Boolean)
      .map((id) => S.store.loadSubs(id, true)),
  );
  try {
    S.members = (await S.store.api('GET', '/users')).data ?? [];
  } catch {
    S.members = [];
  }
  S.m = createModel(S.store, c);
  try {
    S.food.group = (await bines.storage.get('menu.group', { scope: 'user' })) ?? null;
  } catch {
    S.food.group = null;
  }
};

const refreshLogs = async () => {
  const c = S.cfg;
  await Promise.all(
    [c.train?.log, c.food?.flog, c.train?.templates, c.train?.programs, c.food?.menu]
      .filter(Boolean)
      .map((id) => S.store.loadItems(id, true)),
  );
  await Promise.all(
    [c.train?.log, c.food?.flog, c.train?.templates, c.food?.menu]
      .filter(Boolean)
      .map((id) => S.store.loadSubs(id, true)),
  );
  S.m = createModel(S.store, c);
  if (S.queued === 0) {
    S.food.local.clear();
    S.food.removed.clear();
    S.food.dayTmp = null;
  }
  render();
};

const paintSync = () => {
  const el = document.getElementById('sync');
  if (!el) return;
  el.className = `chip sync ${S.queued ? 'acc' : navigator.onLine ? 'ok' : 'warn'}`;
  el.textContent = S.queued
    ? T(`${S.queued} ממתינים לשליחה`, `${S.queued} waiting to send`)
    : navigator.onLine
      ? T('הכול נשמר', 'All saved')
      : T('אין רשת', 'Offline');
};
window.addEventListener('online', paintSync);
window.addEventListener('offline', paintSync);

// ================================================================ render

let focusKey = null;
const render = () => {
  closePop();
  const active = document.activeElement;
  const k = active?.dataset?.k;
  const caret = k && 'selectionStart' in active ? active.selectionStart : null;
  focusKey = k ?? null;
  const nar = document.body.classList.contains('narrow');
  const body = S.loading
    ? h('div', { class: 'empty' }, T('טוען…', 'Loading…'))
    : S.tab === 'settings'
      ? settingsView()
      : S.tab === 'food'
        ? foodView(nar)
        : S.tab === 'prog'
          ? progressView(nar)
          : S.tab === 'coach'
            ? coachView()
            : trainView(nar);
  const err = S.error
    ? h(
        'div',
        { class: 'err', role: 'alert' },
        S.error,
        ' ',
        h('button', { class: 'abtn', on: { click: () => ((S.error = ''), render()) } }, T('סגירה', 'Close')),
      )
    : null;
  const flash = S.flash ? h('div', { class: 'note', role: 'status', style: { margin: '12px 14px 0' } }, S.flash) : null;
  app.replaceChildren(
    h(
      'div',
      { class: 'app' },
      nar ? null : topTabs(),
      h('div', { class: 'scr', id: 'scr' }, err, flash, body),
      nar && !S.loading ? bottomNav() : null,
    ),
  );
  paintSync();
  if (focusKey) {
    const el = app.querySelector(`[data-k="${CSS.escape(focusKey)}"]`);
    if (el) {
      el.focus();
      if (caret !== null && 'setSelectionRange' in el) {
        try {
          el.setSelectionRange(caret, caret);
        } catch {
          // number inputs refuse a caret
        }
      }
    }
  }
};

const go = (patch) => {
  Object.assign(S, patch);
  S.flash = '';
  render();
  document.getElementById('scr')?.scrollTo?.(0, 0);
};

const topTabs = () =>
  h(
    'nav',
    { class: 'tabs', attrs: { 'aria-label': T('מסכים', 'Screens') } },
    [
      ['train', T('אימון', 'Workout')],
      ['food', T('תזונה', 'Nutrition')],
      ['prog', T('התקדמות', 'Progress')],
      S.cfg?.coach?.enabled !== false ? ['coach', T('מאמן', 'Coach')] : null,
      ['settings', T('הגדרות', 'Settings')],
    ]
      .filter(Boolean)
      .map(([id, label]) =>
        h(
          'button',
          {
            class: 'tab',
            'data-testid': `fit-tab-${id}`,
            attrs: { 'aria-current': S.tab === id ? 'page' : 'false' },
            on: { click: () => go({ tab: id }) },
          },
          label,
        ),
      ),
    h('span', { class: 'chip sync', id: 'sync' }),
  );

const bottomNav = () =>
  h(
    'nav',
    { class: 'nav', attrs: { 'aria-label': T('מסכים', 'Screens') } },
    [
      ['train', '🏋', T('אימון', 'Workout')],
      ['food', '🥗', T('תזונה', 'Food')],
      ['prog', '📈', T('התקדמות', 'Progress')],
      ['settings', '⚙', T('הגדרות', 'Settings')],
    ].map(([id, icon, label]) =>
      h(
        'button',
        {
          'data-testid': `fit-nav-${id}`,
          attrs: { 'aria-current': S.tab === id ? 'page' : 'false' },
          on: { click: () => go({ tab: id }) },
        },
        h('i', {}, icon),
        label,
      ),
    ),
  );

const needs = (what) =>
  h(
    'div',
    { class: 'empty' },
    what,
    h(
      'div',
      { class: 'actions', style: { justifyContent: 'center' } },
      h('button', { class: 'abtn main', on: { click: () => go({ tab: 'settings' }) } }, T('להגדרות', 'Open settings')),
    ),
  );

const weekRow = (days) =>
  h(
    'div',
    { class: 'wk' },
    days.map((d) =>
      h(
        'div',
        {
          class: `day ${d.state === 'done' ? 'done' : d.state === 'today' ? 'today' : d.state === 'rest' ? 'rest' : ''}`,
          attrs: { title: d.date },
        },
        h(
          'b',
          {},
          new Date(`${d.date}T12:00:00`).toLocaleDateString(S.ctx.locale === 'en' ? 'en-GB' : 'he-IL', {
            weekday: 'narrow',
          }),
        ),
        d.label || (d.state === 'today' ? T('היום', 'Today') : d.state === 'rest' ? T('מנוחה', 'Rest') : '—'),
      ),
    ),
  );

// ================================================================ workout

const programOf = (uid) => S.m.activeProgram(uid);

const trainView = (nar) => {
  const m = S.m;
  if (!S.cfg.train?.templates || !m)
    return needs(T('בחר בהגדרות את לוח האימונים.', 'Pick the workouts board in the settings.'));
  if (S.screen === 'session' && S.ses) return nar ? phoneSession() : deskSession();
  if (S.screen === 'summary' && S.ses) return summaryView(nar);
  if (S.screen === 'saved' && S.ses) return savedView(nar);
  if (!nar && S.trainSub === 'build')
    return h('div', {}, trainSubtabs(), h('div', { class: 'dbody' }, programBuilder(me(), null)));
  return nar ? phoneHome() : deskHome();
};

const trainSubtabs = () =>
  h(
    'div',
    { class: 'subtabs' },
    h(
      'button',
      { attrs: { 'aria-pressed': String(S.trainSub === 'next') }, on: { click: () => go({ trainSub: 'next' }) } },
      T('האימון הבא · ביצוע', 'Next workout'),
    ),
    h(
      'button',
      {
        'data-testid': 'fit-build-program',
        attrs: { 'aria-pressed': String(S.trainSub === 'build') },
        on: { click: () => go({ trainSub: 'build' }) },
      },
      T('בניית תוכנית אימון', 'Build a workout plan'),
    ),
  );

const pickList = (program) => {
  const m = S.m;
  const list = m.workoutsOf(program);
  const next = m.nextWorkout(me(), program);
  if (S.woPick === null || !list.some((w) => w.id === S.woPick)) S.woPick = next?.id ?? list[0]?.id ?? null;
  return h(
    'div',
    { class: 'wo-pick' },
    list.length
      ? list.map((w) =>
          h(
            'button',
            {
              class: S.woPick === w.id ? 'sel' : '',
              'data-testid': 'fit-workout',
              on: { click: () => go({ woPick: w.id }) },
            },
            h(
              'span',
              {},
              h('span', { class: 'nm' }, w.name),
              h('br'),
              h(
                'span',
                { class: 'm' },
                T(
                  `${m.steps(w.id).length} תרגילים · ~${m.minutesOf(w.id)} דק׳`,
                  `${m.steps(w.id).length} exercises · ~${m.minutesOf(w.id)} min`,
                ),
              ),
            ),
            h('span', { class: 'm' }, next?.id === w.id ? T('הבא', 'Next') : ''),
          ),
        )
      : h('div', { class: 'empty' }, T('אין אימונים בתוכנית.', 'No workouts in the plan.')),
  );
};

const recordsList = () => {
  const rec = S.m.recentRecords(me());
  return rec.length
    ? h(
        'div',
        { class: 'list' },
        rec.map((r) =>
          h('div', {}, h('span', {}, r.name), h('span', {}, `${fmt(r.kg, 1)} ${T('ק״ג', 'kg')} × ${fmt(r.reps)}`)),
        ),
      )
    : h(
        'div',
        { class: 'list' },
        h('div', {}, h('span', { class: 'muted' }, T('עוד אין סטים ביומן.', 'No sets logged yet.')), h('span', {}, '')),
      );
};

const metricTiles = () => {
  const mt = S.m.metrics();
  if (!mt) return null;
  const delta = (d, unit) => (d === null ? '' : ` · ${d > 0 ? '+' : ''}${fmt(d, 1)}${unit}`);
  return h(
    'div',
    { class: 'tiles' },
    h(
      'div',
      { class: 'tile' },
      h('div', { class: 'v' }, fmt(mt.kg, 1)),
      h('div', { class: 'd' }, T('משקל ק״ג', 'Weight kg'), delta(mt.dkg, '')),
    ),
    h(
      'div',
      { class: 'tile' },
      h('div', { class: 'v' }, mt.fat === null ? '—' : `${fmt(mt.fat, 1)}%`),
      h('div', { class: 'd' }, T('שומן', 'Body fat'), delta(mt.dfat, '')),
    ),
  );
};

const phoneHome = () => {
  const p = programOf(me());
  const wk = S.m.week(me(), S.ctx.locale);
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'topbar' },
      h(
        'div',
        {},
        h('div', { class: 'ttl' }, T('הכושר שלי', 'My training')),
        h('div', { class: 'sub' }, p?.name ?? T('בלי תוכנית פעילה', 'No active plan')),
      ),
      h('span', { class: 'chip sync', id: 'sync' }),
    ),
    h(
      'div',
      { class: 'sect' },
      T('השבוע', 'This week'),
      h(
        'span',
        {},
        T(
          `${wk.filter((d) => d.state === 'done').length} אימונים`,
          `${wk.filter((d) => d.state === 'done').length} workouts`,
        ),
      ),
    ),
    weekRow(wk),
    h('div', { class: 'sect' }, T('האימון הבא', 'Next workout'), h('span', {}, T('לפי התוכנית', 'By the plan'))),
    pickList(p),
    h(
      'div',
      { class: 'bottom' },
      h(
        'button',
        {
          class: 'btn main',
          'data-testid': 'fit-start',
          disabled: !S.woPick,
          on: { click: () => startSession(S.woPick, p) },
        },
        T('התחלה', 'Start'),
      ),
    ),
    h('div', { class: 'sect' }, T('שיאים אחרונים', 'Recent records'), h('span', {}, T('משקל עבודה', 'Working weight'))),
    recordsList(),
    metricTiles(),
    h('div', { style: { height: '16px' } }),
  );
};

const deskHome = () => {
  const p = programOf(me());
  const wk = S.m.week(me(), S.ctx.locale);
  return h(
    'div',
    {},
    trainSubtabs(),
    h(
      'div',
      { class: 'dbody' },
      h(
        'div',
        { class: 'dcols' },
        h(
          'div',
          {},
          h(
            'div',
            { class: 'toolbar' },
            h('span', { class: 'pick' }, T('תוכנית:', 'Plan:'), ' ', h('b', {}, p?.name ?? '—')),
          ),
          h(
            'div',
            { class: 'box' },
            h(
              'div',
              { class: 'bt' },
              h('span', {}, T('האימון הבא', 'Next workout')),
              h('span', {}, T('לפי התוכנית', 'By the plan')),
            ),
            pickList(p),
            h(
              'div',
              { class: 'actions', style: { margin: '0 12px 12px' } },
              h(
                'button',
                {
                  class: 'abtn main',
                  'data-testid': 'fit-start',
                  disabled: !S.woPick,
                  on: { click: () => startSession(S.woPick, p) },
                },
                T('התחלה', 'Start'),
              ),
              S.woPick
                ? h(
                    'button',
                    { class: 'abtn', on: { click: () => void bines.execute('openItemCard', { itemId: S.woPick }) } },
                    T('פתיחת האימון', 'Open the workout'),
                  )
                : null,
            ),
          ),
        ),
        h(
          'div',
          { class: 'dside' },
          h(
            'div',
            { class: 'box' },
            h(
              'div',
              { class: 'bt' },
              h('span', {}, T('השבוע', 'This week')),
              h('span', {}, String(wk.filter((d) => d.state === 'done').length)),
            ),
            weekRow(wk),
          ),
          h('div', { class: 'box' }, h('div', { class: 'bt' }, h('span', {}, T('שיאים', 'Records'))), recordsList()),
        ),
      ),
    ),
  );
};

// ---------- the session

let tick = null;
const saveSes = () => {
  try {
    if (!S.ses) localStorage.removeItem(sesKey());
    else localStorage.setItem(sesKey(), JSON.stringify({ ...S.ses, rest: null }));
  } catch {
    // private mode: the session lives until the page closes
  }
};
const startSession = (workoutId, program) => {
  const c = S.cfg.train;
  if (!c.log)
    return void ((S.error = T(
      'בחר בהגדרות את יומן האימונים — שם נרשם האימון.',
      'Pick the training log board in the settings.',
    )),
    render());
  const w = S.m.workouts().find((x) => x.id === workoutId);
  if (!w) return;
  const st = S.m.steps(w.id);
  const logId = S.q.tmp();
  const L = c.logc ?? {};
  void S.q.push({
    method: 'POST',
    path: `/boards/${c.log}/items`,
    body: {
      name: `${w.name} · ${dm(today())}`,
      values: compact({ [L.date]: today(), [L.workout]: w.id, [L.program]: program?.id, [L.trainee]: me() }),
    },
    creates: logId,
    what: T('אימון חדש ביומן', 'New log entry'),
  });
  S.ses = {
    workoutId: w.id,
    programId: program?.id ?? null,
    name: w.name,
    program: program?.name ?? '',
    logId,
    started: Date.now(),
    step: 0,
    steps: st.map((s) => ({
      ...s,
      rows: Array.from({ length: s.sets }, () => ({ reps: s.reps ?? '', kg: s.kg ?? '', done: false })),
    })),
    volume: 0,
    done: 0,
    prs: [],
    rpe: null,
    note: '',
    rest: null,
    restDone: false,
  };
  saveSes();
  awake.on();
  go({ screen: 'session' });
};
const resumeSession = (saved) => {
  S.ses = { ...saved, rest: null };
  S.screen = saved.screen === 'summary' ? 'summary' : 'session';
  awake.on();
};
const readInputs = () => {
  if (!S.ses) return;
  S.ses.steps.forEach((st, si) =>
    st.rows.forEach((r, i) => {
      if (r.done) return;
      const reps = document.querySelector(`[data-k="reps-${si}-${i}"]`);
      const kg = document.querySelector(`[data-k="kg-${si}-${i}"]`);
      if (reps) r.reps = reps.value;
      if (kg) r.kg = kg.value;
    }),
  );
};
const stopRest = () => {
  if (tick) clearInterval(tick);
  tick = null;
  if (S.ses) S.ses.rest = null;
};
const paintRest = () => {
  const r = S.ses?.rest;
  if (!r) return;
  document.querySelectorAll('.rest-t').forEach((t) => (t.textContent = clock(r.left)));
  document.querySelectorAll('.rest-bar').forEach((b) => (b.style.transform = `scaleX(${1 - r.left / r.total})`));
};
const startRest = (secs) => {
  stopRest();
  if (!secs || S.cfg.ui?.timer === false) return;
  S.ses.rest = { total: secs, left: secs };
  S.ses.restDone = false;
  tick = setInterval(() => {
    const r = S.ses?.rest;
    if (!r) return;
    r.left -= 1;
    if (r.left <= 0) {
      stopRest();
      beep();
      S.ses.restDone = true;
      render();
      return;
    }
    paintRest();
  }, 1000);
};
const checkSet = (si, i) => {
  readInputs();
  const ses = S.ses;
  const st = ses.steps[si];
  const r = st.rows[i];
  if (r.done) return;
  r.done = true;
  ses.done += 1;
  const kg = parseFloat(r.kg) || 0;
  const reps = parseFloat(r.reps) || 0;
  ses.volume += kg * reps;
  const rec = S.m.record(me(), st.exId, st.name);
  if (kg && rec.kg !== null && kg > rec.kg && !ses.prs.some((p) => p.name === st.name))
    ses.prs.push({ name: st.name, kg, reps });
  const C = S.cfg.train.setc ?? {};
  void S.q.push({
    method: 'POST',
    path: `/items/${ses.logId}/subitems`,
    body: {
      name: st.name,
      values: compact({ [C.ex]: st.exId, [C.set]: i + 1, [C.reps]: reps || undefined, [C.kg]: kg || undefined }),
    },
    what: `${st.name} · ${T('סט', 'set')} ${i + 1}`,
  });
  ses.step = si;
  if (st.rows.every((x) => x.done)) stopRest();
  else startRest(st.rest);
  saveSes();
  render();
};
const finish = () => {
  readInputs();
  stopRest();
  S.ses.screen = 'summary';
  saveSes();
  go({ screen: 'summary' });
};
const rpeValue = (rpe) => {
  const L = S.cfg.train.logc ?? {};
  const col = S.m.B(S.cfg.train.log)?.columns?.find((c) => c.id === L.rpe);
  if (!col || !rpe) return undefined;
  if (col.type === 'rating') {
    const max = col.settings?.max ?? 5;
    return Math.max(1, Math.round((rpe / 10) * max));
  }
  return rpe;
};
const saveSession = () => {
  const ses = S.ses;
  const note = document.querySelector('[data-k="note"]');
  if (note) ses.note = note.value;
  const c = S.cfg.train;
  const L = c.logc ?? {};
  void S.q.push({
    method: 'PATCH',
    path: `/items/${ses.logId}`,
    body: {
      values: compact({
        [L.state]: c.done_label,
        [L.minutes]: Math.max(1, Math.round((Date.now() - ses.started) / 60000)),
        [L.rpe]: rpeValue(ses.rpe),
        [L.notes]: ses.note || undefined,
      }),
    },
    what: T('סיום אימון', 'Workout finished'),
  });
  awake.off();
  S.ses.screen = 'saved';
  saveSes();
  try {
    localStorage.removeItem(sesKey());
  } catch {
    // ignore
  }
  go({ screen: 'saved' });
};
const abort = () => {
  stopRest();
  awake.off();
  const c = S.cfg.train;
  if (c.partial_label && c.logc?.state)
    void S.q.push({
      method: 'PATCH',
      path: `/items/${S.ses.logId}`,
      body: { values: { [c.logc.state]: c.partial_label } },
      what: T('אימון חלקי', 'Partial workout'),
    });
  S.ses = null;
  saveSes();
  go({ screen: 'home' });
};
const elapsed = () => clock(Math.floor((Date.now() - S.ses.started) / 1000));
const pct = () => {
  const all = S.ses.steps.flatMap((s) => s.rows);
  return Math.round((all.filter((r) => r.done).length / Math.max(all.length, 1)) * 100);
};

const restBox = (st) => {
  const ses = S.ses;
  return ses.rest
    ? h(
        'div',
        { class: 'rest', 'data-testid': 'fit-rest' },
        h(
          'div',
          {},
          h('div', { class: 'l' }, T('מנוחה', 'Rest')),
          h('div', { class: 't rest-t' }, clock(ses.rest.left)),
          h(
            'div',
            { class: 'bar' },
            h('i', { class: 'rest-bar', style: { transform: `scaleX(${1 - ses.rest.left / ses.rest.total})` } }),
          ),
        ),
        h(
          'div',
          { class: 'b' },
          h(
            'button',
            { on: { click: () => ((ses.rest.left += 30), (ses.rest.total += 30), paintRest()) } },
            T('+30 שנ׳', '+30 s'),
          ),
          h('button', { on: { click: () => (stopRest(), render()) } }, T('דלג', 'Skip')),
        ),
      )
    : h(
        'div',
        { class: 'rest idle' },
        h(
          'div',
          {},
          h(
            'div',
            { class: 'l' },
            ses.restDone ? T('המנוחה נגמרה, לסט הבא', 'Rest is over — next set') : T('מנוחה', 'Rest'),
          ),
          h('div', { class: 't' }, clock(st?.rest ?? 0)),
        ),
        h(
          'div',
          { class: 'b' },
          h('span', { style: { fontSize: '12px', opacity: '0.8' } }, T('מתחיל אחרי ✓', 'Starts after ✓')),
        ),
      );
};

let cueOpen = false;
const cueBlock = (text) => {
  const long = text.length > 160;
  return [
    h('div', { class: `cue ${long && !cueOpen ? 'clamp' : ''}` }, text),
    long
      ? h(
          'button',
          { class: 'more', on: { click: () => ((cueOpen = !cueOpen), render()) } },
          cueOpen ? T('פחות', 'Less') : T('עוד', 'More'),
        )
      : null,
  ];
};
const exCard = (si, full) => {
  const ses = S.ses;
  const st = ses.steps[si];
  const info = S.m.exInfo(st.exId, st.name);
  const rec = S.m.record(me(), st.exId, st.name);
  const last = S.m.lastTime(me(), st.exId, st.name);
  const lastText = last
    ? `${last.sets.length}×${fmt(last.sets[0]?.reps)}${last.sets.some((s) => s.kg) ? ` · ${fmt(Math.max(...last.sets.map((s) => s.kg || 0)), 1)}` : ''}`
    : T('פעם ראשונה', 'First time');
  const hasKg = st.kg !== null || st.rows.some((r) => r.kg !== '' && r.kg !== null);
  const stepDone = st.rows.every((r) => r.done);
  return h(
    'div',
    { class: `ex ${stepDone && !full ? 'done-step' : ''}`, 'data-testid': 'fit-exercise' },
    h(
      'div',
      { class: 'media' },
      figure(),
      rec.kg ? h('span', { class: 'pr' }, T(`שיא ${fmt(rec.kg, 1)} ק״ג`, `Best ${fmt(rec.kg, 1)} kg`)) : null,
      full && info.video
        ? h(
            'a',
            { class: 'play', href: info.video, target: '_blank', rel: 'noopener noreferrer' },
            T('▶ סרטון', '▶ Video'),
          )
        : null,
    ),
    h(
      'div',
      { class: 'exh' },
      h('span', { class: 'n' }, full ? st.name : `${si + 1} · ${st.name}`),
      h(
        'span',
        { class: 'k' },
        full ? info.kind : `${st.sets}×${fmt(st.reps)}${st.kg !== null ? ` · ${fmt(st.kg, 1)}` : ''}`,
      ),
    ),
    full && (info.cues || st.cue) ? cueBlock([info.cues, st.cue].filter(Boolean).join(' · ')) : null,
    h(
      'div',
      { class: 'prev' },
      h(
        'span',
        {},
        last ? T(`פעם קודמת · ${dm(last.date)}`, `Last time · ${dm(last.date)}`) : T('פעם קודמת', 'Last time'),
      ),
      h('span', { class: last ? 'ltr' : '' }, lastText),
    ),
    h(
      'table',
      { class: 'sets' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { class: 'c1' }, T('סט', 'Set')),
          h('th', { class: 'c2' }, T('תוכנית', 'Plan')),
          h('th', {}, T('חזרות', 'Reps')),
          h('th', {}, hasKg ? T('ק״ג', 'kg') : ''),
          h('th', { class: 'c5' }),
        ),
      ),
      h(
        'tbody',
        {},
        st.rows.map((r, i) =>
          h(
            'tr',
            { class: r.done ? 'done' : '' },
            h('td', { class: 'i' }, String(i + 1)),
            h('td', { class: 'plan' }, `${fmt(st.reps)}${st.kg !== null ? ` × ${fmt(st.kg, 1)}` : ''}`),
            h(
              'td',
              {},
              h('input', {
                class: 'inp',
                type: 'number',
                inputmode: 'decimal',
                'data-k': `reps-${si}-${i}`,
                value: String(r.reps ?? ''),
                readonly: r.done || undefined,
                attrs: { 'aria-label': T(`חזרות סט ${i + 1}`, `Reps set ${i + 1}`) },
              }),
            ),
            h(
              'td',
              {},
              hasKg
                ? h('input', {
                    class: 'inp',
                    type: 'number',
                    inputmode: 'decimal',
                    step: '0.5',
                    'data-k': `kg-${si}-${i}`,
                    value: String(r.kg ?? ''),
                    readonly: r.done || undefined,
                    attrs: { 'aria-label': T(`משקל סט ${i + 1}`, `Weight set ${i + 1}`) },
                  })
                : '',
            ),
            h(
              'td',
              {},
              h(
                'button',
                {
                  class: `chk ${r.done ? 'on' : ''}`,
                  'data-testid': 'fit-set-check',
                  attrs: { 'aria-label': T(`סימון סט ${i + 1}`, `Mark set ${i + 1}`) },
                  on: { click: () => checkSet(si, i) },
                },
                '✓',
              ),
            ),
          ),
        ),
      ),
    ),
    S.cfg.ui?.add_sets === false
      ? null
      : h(
          'button',
          {
            class: 'addset',
            on: {
              click: () => (
                readInputs(),
                st.rows.push({ reps: st.reps ?? '', kg: st.kg ?? '', done: false }),
                saveSes(),
                render()
              ),
            },
          },
          T('+ סט נוסף', '+ Add a set'),
        ),
  );
};

const phoneSession = () => {
  const ses = S.ses;
  const si = Math.min(ses.step, ses.steps.length - 1);
  const st = ses.steps[si];
  const next = ses.steps[si + 1];
  const p = pct();
  if (!st)
    return h(
      'div',
      { class: 'empty' },
      T('לאימון הזה אין תרגילים.', 'This workout has no exercises.'),
      h('div', { class: 'bottom' }, h('button', { class: 'btn', on: { click: abort } }, T('חזרה', 'Back'))),
    );
  const stepDone = st.rows.every((r) => r.done);
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'topbar' },
      h('div', {}, h('div', { class: 'ttl' }, ses.name), h('div', { class: 'sub' }, ses.program)),
      h(
        'button',
        { class: 'icon', attrs: { 'aria-label': T('יציאה מהאימון', 'Leave the workout') }, on: { click: abort } },
        '✕',
      ),
    ),
    h(
      'div',
      { class: 'chips' },
      h('span', { class: 'chip acc ses-clock' }, T('אימון פעיל · ', 'Active · '), elapsed()),
      h('span', { class: 'chip' }, T(`נפח ${fmt(ses.volume)} ק״ג`, `Volume ${fmt(ses.volume)} kg`)),
      h('span', { class: 'chip sync', id: 'sync' }),
    ),
    h('div', { class: 'progress' }, h('i', { style: { width: `${p}%` } })),
    h(
      'div',
      { class: 'pl' },
      h('span', {}, T(`תרגיל ${si + 1} מתוך ${ses.steps.length}`, `Exercise ${si + 1} of ${ses.steps.length}`)),
      h('span', {}, `${p}%`),
    ),
    exCard(si, true),
    restBox(st),
    next
      ? h(
          'div',
          { class: 'next' },
          h('span', {}, T('הבא · ', 'Next · '), h('span', { class: 'nm' }, next.name)),
          h('span', {}, `${next.sets}×${fmt(next.reps)}${next.kg !== null ? ` · ${fmt(next.kg, 1)}` : ''}`),
        )
      : null,
    h(
      'div',
      { class: 'bottom' },
      si > 0
        ? h(
            'button',
            {
              class: 'btn quiet',
              on: {
                click: () => (readInputs(), stopRest(), (ses.step = si - 1), (ses.restDone = false), saveSes(), go({})),
              },
            },
            T('הקודם', 'Previous'),
          )
        : null,
      next
        ? h(
            'button',
            {
              class: `btn ${stepDone ? 'main' : ''}`,
              'data-testid': 'fit-next',
              on: {
                click: () => (readInputs(), stopRest(), (ses.step = si + 1), (ses.restDone = false), saveSes(), go({})),
              },
            },
            stepDone ? T('לתרגיל הבא', 'Next exercise') : T('דלג על התרגיל', 'Skip exercise'),
          )
        : h(
            'button',
            { class: 'btn main', 'data-testid': 'fit-finish', on: { click: finish } },
            T('סיום אימון', 'Finish'),
          ),
    ),
  );
};

const deskSession = () => {
  const ses = S.ses;
  const p = pct();
  return h(
    'div',
    { class: 'dbody' },
    h(
      'div',
      { class: 'toolbar' },
      h('span', { class: 'pick' }, T('אימון:', 'Workout:'), ' ', h('b', {}, ses.name)),
      h('span', { class: 'chip acc ses-clock' }, T('אימון פעיל · ', 'Active · '), elapsed()),
      h('span', { class: 'chip' }, T(`נפח ${fmt(ses.volume)} ק״ג`, `Volume ${fmt(ses.volume)} kg`)),
      h('span', { class: 'chip' }, `${p}%`),
      h('span', { class: 'sp' }),
      h('button', { class: 'abtn', on: { click: abort } }, T('יציאה', 'Leave')),
      h(
        'button',
        { class: 'abtn main', 'data-testid': 'fit-finish', on: { click: finish } },
        T('סיום אימון', 'Finish'),
      ),
    ),
    h(
      'div',
      { class: 'dcols' },
      h(
        'div',
        { class: 'grid' },
        ses.steps.map((_, si) => exCard(si, false)),
      ),
      h(
        'div',
        { class: 'dside' },
        restBox(ses.steps[ses.step]),
        h(
          'div',
          { class: 'box' },
          h('div', { class: 'bt' }, h('span', {}, T('התקדמות באימון', 'Progress')), h('span', {}, `${p}%`)),
          h(
            'div',
            { style: { padding: '10px 12px' } },
            h('div', { class: 'pct' }, h('i', { style: { width: `${p}%` } })),
          ),
          h(
            'div',
            { class: 'list' },
            ses.steps.map((st, si) =>
              h(
                'div',
                {},
                h('span', {}, `${si + 1} · ${st.name}`),
                h('span', {}, `${st.rows.filter((r) => r.done).length}/${st.rows.length}`),
              ),
            ),
          ),
        ),
      ),
    ),
  );
};

const summaryBody = () => {
  const ses = S.ses;
  return [
    h(
      'div',
      { class: 'tiles' },
      h(
        'div',
        { class: 'tile' },
        h('div', { class: 'v' }, fmt(ses.volume)),
        h('div', { class: 'd' }, T('נפח ק״ג', 'Volume kg')),
      ),
      h(
        'div',
        { class: 'tile' },
        h('div', { class: 'v' }, String(ses.done)),
        h('div', { class: 'd' }, T('סטים שבוצעו', 'Sets done')),
      ),
    ),
    ses.prs.length
      ? [
          h('div', { class: 'sect' }, T('שיאים חדשים', 'New records')),
          h(
            'div',
            { class: 'list' },
            ses.prs.map((r) =>
              h(
                'div',
                {},
                h('span', {}, r.name, h('span', { class: 'new' }, T('חדש', 'new'))),
                h('span', {}, `${fmt(r.kg, 1)} × ${fmt(r.reps)}`),
              ),
            ),
          ),
        ]
      : null,
    h(
      'div',
      { class: 'field' },
      h('label', {}, T('קושי כללי (RPE)', 'Overall effort (RPE)')),
      h(
        'div',
        { class: 'rpe' },
        [5, 6, 7, 8, 9, 10].map((n) =>
          h(
            'button',
            {
              attrs: { 'aria-pressed': String(ses.rpe === n) },
              on: {
                click: () => {
                  const nt = document.querySelector('[data-k="note"]');
                  if (nt) ses.note = nt.value;
                  ses.rpe = n;
                  saveSes();
                  render();
                },
              },
            },
            String(n),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { attrs: { for: 'fit-note' } }, T('איך היה', 'How was it')),
      h(
        'textarea',
        {
          id: 'fit-note',
          rows: '2',
          'data-k': 'note',
          placeholder: T('למשל: הברכיים היו כבדות, הפולי זרם', 'e.g. legs felt heavy, pull-downs flowed'),
        },
        ses.note,
      ),
    ),
    h(
      'div',
      { class: 'bottom' },
      h(
        'button',
        { class: 'btn main', 'data-testid': 'fit-save', on: { click: saveSession } },
        T('שמירה ליומן', 'Save to the log'),
      ),
    ),
  ];
};
const summaryView = (nar) =>
  nar
    ? h(
        'div',
        {},
        h(
          'div',
          { class: 'topbar' },
          h(
            'div',
            {},
            h('div', { class: 'ttl' }, T('סיום אימון', 'Workout done')),
            h('div', { class: 'sub' }, `${S.ses.name} · ${elapsed()}`),
          ),
          h('div', { class: 'icon' }, '✓'),
        ),
        summaryBody(),
      )
    : h(
        'div',
        { class: 'dbody', style: { maxWidth: '560px' } },
        h(
          'div',
          { class: 'sect', style: { padding: 0 } },
          `${T('סיום אימון', 'Workout done')} · ${S.ses.name} · ${elapsed()}`,
        ),
        summaryBody(),
      );
const savedView = () =>
  h(
    'div',
    { 'data-testid': 'fit-saved' },
    h(
      'div',
      { class: 'topbar' },
      h(
        'div',
        {},
        h('div', { class: 'ttl' }, T('נשמר ביומן האימונים', 'Saved to the training log')),
        h('div', { class: 'sub' }, S.ses.name),
      ),
      h('div', { class: 'icon' }, '✓'),
    ),
    h(
      'div',
      { class: 'empty' },
      T(`${S.ses.done} סטים נרשמו ביומן.`, `${S.ses.done} sets were logged.`),
      ' ',
      S.queued
        ? T(`${S.queued} ממתינים לרשת ויישלחו לבד.`, `${S.queued} wait for the network and will be sent.`)
        : T('הכול נשלח.', 'Everything was sent.'),
    ),
    h(
      'div',
      { class: 'bottom' },
      h(
        'button',
        { class: 'btn', on: { click: () => ((S.ses = null), saveSes(), go({ screen: 'home' })) } },
        T('חזרה', 'Back'),
      ),
    ),
  );

// ================================================================ nutrition

const EXTRA = () => T('תוספת', 'Extra');
const OUTSIDE = () => T('מחוץ לתוכנית', 'Outside the plan');
const foodKey = (meal, food) => `${meal} · ${food}`;
const dayRow = () => S.m.dayOf(me());
/**
 * What was eaten today: the day's subitems (minus those just removed) and the ones written locally, not yet sent.
 * Every entry is its own row (two extras of the same food are two entries); a planned food is "eaten" when an entry
 * carries its name.
 */
const eatenNow = () => {
  const day = dayRow();
  const list = [...(day ? S.m.eatenOf(day.id) : []), ...S.food.local.values()].filter((e) => !S.food.removed.has(e.id));
  return {
    size: list.length,
    values: () => list,
    has: (name) => list.some((e) => e.name === name),
    get: (name) => list.find((e) => e.name === name),
  };
};
const groupNow = () => {
  const groups = S.m.menuGroups();
  return (
    groups.find((g) => g.id === S.food.group)?.id ??
    groups.find((g) => g.id === S.cfg.food?.day_group)?.id ??
    groups[0]?.id ??
    null
  );
};
const ensureDay = () => {
  const F = S.cfg.food;
  const day = dayRow();
  if (day) return day.id;
  if (S.food.dayTmp) return S.food.dayTmp;
  const C = F.flogc ?? {};
  S.food.dayTmp = S.q.tmp();
  const trained = S.m.logsOf(me()).some((l) => S.m.logDate(l) === today());
  void S.q.push({
    method: 'POST',
    path: `/boards/${F.flog}/items`,
    body: {
      name: new Date().toLocaleDateString(S.ctx.locale === 'en' ? 'en-GB' : 'he-IL'),
      values: compact({ [C.date]: today(), [C.trainee]: me(), [C.train]: trained ? 'true' : undefined }),
    },
    creates: S.food.dayTmp,
    what: T('יום חדש ביומן התזונה', 'New day in the food log'),
  });
  return S.food.dayTmp;
};
const eatFood = (name, foodId, g) => {
  const F = S.cfg.food;
  if (!F.flog)
    return void ((S.error = T('בחר בהגדרות את יומן התזונה.', 'Pick the food log board in the settings.')), render());
  const day = ensureDay();
  const id = S.q.tmp();
  const C = F.fsub ?? {};
  void S.q.push({
    method: 'POST',
    path: `/items/${day}/subitems`,
    body: { name, values: compact({ [C.food]: foodId, [C.g]: g }) },
    creates: id,
    what: name,
  });
  S.food.local.set(id, { id, name, foodId, g });
};
const uneat = (e) => {
  void S.q.push({ method: 'DELETE', path: `/items/${e.id}`, what: `${T('ביטול', 'Undo')}: ${e.name}` });
  if (S.food.local.has(e.id)) S.food.local.delete(e.id);
  else S.food.removed.add(e.id);
};
const toggleFood = (meal, f) => {
  const key = foodKey(meal.name, f.name);
  const now = eatenNow().get(key);
  if (now) uneat(now);
  else eatFood(key, f.foodId, f.g);
  render();
};
const toggleMeal = (meal) => {
  const eaten = eatenNow();
  const all = meal.foods.every((f) => eaten.has(foodKey(meal.name, f.name)));
  for (const f of meal.foods) {
    const e = eaten.get(foodKey(meal.name, f.name));
    if (all && e) uneat(e);
    if (!all && !e) eatFood(foodKey(meal.name, f.name), f.foodId, f.g);
  }
  render();
};

const bars = (eaten, target) => {
  const row = (label, v, t, unit) =>
    h(
      'div',
      { class: 'barrow' },
      h('span', {}, label),
      h(
        'span',
        { class: 'bar' },
        h('i', {
          class: t && v > t * 1.05 ? 'over' : '',
          style: { width: `${t ? Math.min(100, (v / t) * 100) : 0}%` },
        }),
      ),
      h('span', { class: 'num' }, `${fmt(v)} / ${t ? fmt(t) : '—'} ${unit}`),
    );
  return h(
    'div',
    { class: 'bars' },
    row(T('קלוריות', 'Calories'), eaten.kcal, target?.kcal, ''),
    row(T('חלבון', 'Protein'), eaten.prot, target?.prot, T('ג׳', 'g')),
    row(T('פחמימה', 'Carbs'), eaten.carb, target?.carb, T('ג׳', 'g')),
    row(T('שומן', 'Fat'), eaten.fat, target?.fat, T('ג׳', 'g')),
  );
};

const foodOptions = (sel) => S.m.foods().map((f) => ({ value: f.id, label: f.name, sel: f.id === sel }));
const addRow = (mealName) => {
  const a = S.food.adding;
  if (!a || a.meal !== mealName)
    return h(
      'button',
      {
        class: 'addset',
        style: { margin: '6px 12px 8px' },
        'data-testid': 'fit-add-extra',
        on: {
          click: () => {
            const first = S.m.foods()[0];
            S.food.adding = { meal: mealName, foodId: first?.id ?? '', g: S.m.per100(first?.id).portion };
            render();
          },
        },
      },
      T('+ מזון שלא בתוכנית', '+ Food not in the plan'),
    );
  return h(
    'div',
    { class: 'food addrow' },
    select(
      a.foodId,
      foodOptions(a.foodId),
      (v) => {
        a.foodId = v;
        a.g = S.m.per100(v).portion;
        render();
      },
      { attrs: { 'aria-label': T('מזון', 'Food') } },
    ),
    h('input', {
      type: 'number',
      inputmode: 'decimal',
      value: String(a.g),
      'data-k': `extra-g-${mealName}`,
      attrs: { 'aria-label': T('גרם', 'Grams') },
      on: { input: (e) => (a.g = parseFloat(e.target.value) || 0) },
    }),
    h(
      'button',
      {
        class: 'abtn main',
        'data-testid': 'fit-add-extra-save',
        on: {
          click: () => {
            const f = S.m.food(a.foodId);
            if (f) eatFood(`${EXTRA()} · ${mealName} · ${f.name}`, f.id, a.g);
            S.food.adding = null;
            render();
          },
        },
      },
      T('הוספה', 'Add'),
    ),
    h(
      'button',
      {
        class: 'x',
        attrs: { 'aria-label': T('ביטול', 'Cancel') },
        on: { click: () => ((S.food.adding = null), render()) },
      },
      '✕',
    ),
  );
};
const extrasFor = (mealName, eaten) =>
  [...eaten.values()]
    .filter((e) => e.name.startsWith(`${EXTRA()} · ${mealName} · `))
    .map((e) => {
      const x = S.m.macro(e.foodId, e.g);
      return h(
        'div',
        { class: 'food extra' },
        h(
          'span',
          { class: 'fn' },
          e.name.split(' · ').slice(2).join(' · '),
          ' ',
          h('span', { class: 'tag' }, `· ${EXTRA()}`),
        ),
        h('span', { class: 'g' }, `${fmt(e.g)} ${T('ג׳', 'g')}`),
        h('span', { class: 'kc' }, `${fmt(x.kcal)} ${T('קק״ל', 'kcal')}`),
        h(
          'button',
          { class: 'chk on', attrs: { 'aria-label': T('הסרה', 'Remove') }, on: { click: () => (uneat(e), render()) } },
          '✕',
        ),
      );
    });

const mealsList = (meals, eaten) => [
  ...meals.map((meal) => {
    const tot = S.m.sum(meal.foods.map((f) => S.m.macro(f.foodId, f.g)));
    const all = meal.foods.length > 0 && meal.foods.every((f) => eaten.has(foodKey(meal.name, f.name)));
    return h(
      'div',
      { class: 'meal', 'data-testid': 'fit-meal' },
      h(
        'div',
        { class: 'mh' },
        h(
          'span',
          {},
          h('span', { class: 'nm' }, meal.name),
          meal.time ? h('span', { class: 'm' }, ` · ${meal.time}`) : null,
        ),
        h('span', { class: 'm' }, `${fmt(tot.kcal)} ${T('קק״ל', 'kcal')} · ${fmt(tot.prot, 1)} ${T('ח׳', 'p')}`),
        h(
          'button',
          { class: all ? 'on' : '', on: { click: () => toggleMeal(meal) } },
          all ? T('✓ נאכל', '✓ Eaten') : T('אכלתי הכול', 'Ate it all'),
        ),
      ),
      meal.foods.map((f) => {
        const on = eaten.has(foodKey(meal.name, f.name));
        const x = S.m.macro(f.foodId, f.g);
        return h(
          'div',
          { class: `food ${on ? 'on' : ''}` },
          h('span', { class: 'fn' }, f.name),
          h('span', { class: 'g' }, `${fmt(f.g)} ${T('ג׳', 'g')}`),
          h('span', { class: 'kc' }, `${fmt(x.kcal)} ${T('קק״ל', 'kcal')}`),
          h(
            'button',
            {
              class: `chk ${on ? 'on' : ''}`,
              'data-testid': 'fit-food-check',
              attrs: { 'aria-label': T('אכלתי', 'Ate it') },
              on: { click: () => toggleFood(meal, f) },
            },
            '✓',
          ),
        );
      }),
      extrasFor(meal.name, eaten),
      addRow(meal.name),
    );
  }),
  h(
    'div',
    { class: 'meal' },
    h(
      'div',
      { class: 'mh' },
      h(
        'span',
        {},
        h('span', { class: 'nm' }, OUTSIDE()),
        h('span', { class: 'm' }, T(' · מה שאכלתי ולא היה בתפריט', ' · what I ate that was not on the menu')),
      ),
    ),
    extrasFor(OUTSIDE(), eaten).length
      ? extrasFor(OUTSIDE(), eaten)
      : h(
          'div',
          { class: 'food note' },
          T(
            'כלום עדיין. כל מה שנוסף כאן נספר ביעד ונרשם ביומן.',
            'Nothing yet. Anything added here counts toward the target and goes to the log.',
          ),
        ),
    addRow(OUTSIDE()),
  ),
];

const foodView = (nar) => {
  const F = S.cfg.food ?? {};
  if (!F.menu || !F.foods)
    return needs(
      T(
        'כדי לרשום תזונה, בחר בהגדרות את לוח התפריט ואת מאגר המזונות.',
        'To log food, pick the menu and the foods boards in the settings.',
      ),
    );
  const meals = S.m.meals(groupNow());
  const eaten = eatenNow();
  const tot = S.m.sum([...eaten.values()].map((e) => S.m.macro(e.foodId, e.g)));
  const target = S.m.target(me());
  const groups = S.m.menuGroups();
  const menuPick =
    groups.length > 1
      ? h(
          'div',
          { class: 'field' },
          h('label', {}, T('התפריט שלי', 'My menu')),
          select(
            groupNow(),
            groups.map((g) => ({ value: g.id, label: g.title })),
            (v) => {
              S.food.group = v;
              void bines.storage.set('menu.group', v, { scope: 'user' }).catch(() => undefined);
              render();
            },
            { attrs: { 'aria-label': T('התפריט שלי', 'My menu') } },
          ),
        )
      : null;
  if (nar)
    return h(
      'div',
      {},
      h(
        'div',
        { class: 'topbar' },
        h(
          'div',
          {},
          h('div', { class: 'ttl' }, T('תזונה · היום', 'Food · today')),
          h(
            'div',
            { class: 'sub' },
            target?.kcal
              ? T(
                  `יעד ${fmt(target.kcal)} קק״ל · ${fmt(target.prot)} ג׳ חלבון`,
                  `Target ${fmt(target.kcal)} kcal · ${fmt(target.prot)} g protein`,
                )
              : T('אין יעד', 'No target'),
          ),
        ),
        h('span', { class: 'chip sync', id: 'sync' }),
      ),
      h(
        'div',
        { class: 'tiles t3', style: { marginTop: '12px' } },
        h(
          'div',
          { class: 'tile' },
          h('div', { class: 'v' }, target?.kcal ? fmt(target.kcal - tot.kcal) : fmt(tot.kcal)),
          h('div', { class: 'd' }, target?.kcal ? T('נותר לאכול', 'Left to eat') : T('קלוריות', 'Calories')),
        ),
        h(
          'div',
          { class: 'tile' },
          h('div', { class: 'v' }, target?.prot ? fmt(Math.max(0, target.prot - tot.prot)) : fmt(tot.prot)),
          h('div', { class: 'd' }, target?.prot ? T('חלבון חסר ג׳', 'Protein left g') : T('חלבון ג׳', 'Protein g')),
        ),
        h(
          'div',
          { class: 'tile' },
          h('div', { class: 'v' }, String(eaten.size)),
          h('div', { class: 'd' }, T('מזונות נרשמו', 'Foods logged')),
        ),
      ),
      bars(tot, target),
      menuPick,
      mealsList(meals, eaten),
      h('div', { style: { height: '16px' } }),
    );
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'subtabs' },
      h(
        'button',
        { attrs: { 'aria-pressed': String(S.foodSub === 'today') }, on: { click: () => go({ foodSub: 'today' }) } },
        T('היום · רישום', 'Today'),
      ),
      h(
        'button',
        {
          'data-testid': 'fit-build-plan',
          attrs: { 'aria-pressed': String(S.foodSub === 'plan') },
          on: { click: () => go({ foodSub: 'plan' }) },
        },
        T('בניית תוכנית תזונה', 'Build a nutrition plan'),
      ),
    ),
    h(
      'div',
      { class: 'dbody' },
      S.foodSub === 'plan'
        ? planBuilder(me(), null)
        : h(
            'div',
            { class: 'dcols' },
            h(
              'div',
              {},
              h(
                'div',
                { class: 'box' },
                h(
                  'div',
                  { class: 'bt' },
                  h('span', {}, T('היום', 'Today')),
                  h('span', {}, T(`${eaten.size} מזונות נרשמו`, `${eaten.size} foods logged`)),
                ),
                menuPick,
                mealsList(meals, eaten),
                h('div', { style: { height: '12px' } }),
              ),
            ),
            h(
              'div',
              { class: 'dside' },
              h(
                'div',
                { class: 'box' },
                h(
                  'div',
                  { class: 'bt' },
                  h('span', {}, T('מול היעד', 'Against the target')),
                  h('span', {}, target?.name ?? ''),
                ),
                bars(tot, target),
                h('div', { style: { height: '12px' } }),
              ),
              foodWeekBox(me()),
            ),
          ),
    ),
  );
};
const foodWeekBox = (uid) => {
  const w = S.m.foodWeek(uid);
  const t = S.m.target(uid);
  return h(
    'div',
    { class: 'box' },
    h(
      'div',
      { class: 'bt' },
      h('span', {}, T('7 ימים אחרונים', 'Last 7 days')),
      h('span', {}, T(`${w.days} ימים נרשמו`, `${w.days} days logged`)),
    ),
    h(
      'div',
      { class: 'list' },
      h(
        'div',
        {},
        h('span', {}, T('קלוריות ממוצע', 'Average calories')),
        h('span', {}, `${fmt(w.kcal)}${t?.kcal ? ` / ${fmt(t.kcal)}` : ''}`),
      ),
      h(
        'div',
        {},
        h('span', {}, T('חלבון ממוצע', 'Average protein')),
        h('span', {}, `${fmt(w.prot)}${t?.prot ? ` / ${fmt(t.prot)}` : ''} ${T('ג׳', 'g')}`),
      ),
      h(
        'div',
        {},
        h('span', {}, T('ימים ביעד', 'Days on target')),
        h('span', {}, w.inTarget === null ? '—' : `${w.inTarget} / ${w.days}`),
      ),
    ),
  );
};

// ================================================================ progress

const progressView = (nar) => {
  const wk = S.m.week(me(), S.ctx.locale);
  const content = [
    h(
      'div',
      { class: 'sect' },
      T('השבוע', 'This week'),
      h(
        'span',
        {},
        T(
          `${wk.filter((d) => d.state === 'done').length} אימונים`,
          `${wk.filter((d) => d.state === 'done').length} workouts`,
        ),
      ),
    ),
    weekRow(wk),
    metricTiles(),
    h('div', { class: 'sect' }, T('שיאים', 'Records')),
    recordsList(),
    S.cfg.food?.flog
      ? [
          h('div', { class: 'sect' }, T('תזונה · 7 ימים', 'Food · 7 days')),
          h('div', { style: { margin: '8px 14px 0' } }, foodWeekBox(me())),
        ]
      : null,
    h('div', { style: { height: '16px' } }),
  ];
  return nar
    ? h(
        'div',
        {},
        h(
          'div',
          { class: 'topbar' },
          h(
            'div',
            {},
            h('div', { class: 'ttl' }, T('התקדמות', 'Progress')),
            h('div', { class: 'sub' }, T('30 יום', '30 days')),
          ),
          h('span', { class: 'chip sync', id: 'sync' }),
        ),
        content,
      )
    : h('div', { class: 'dbody', style: { maxWidth: '760px' } }, content);
};

// ================================================================ plan builders

const exerciseOptions = () => S.m.library().map((e) => ({ value: e.id, label: e.name }));
const newProgram = (uid, from) => {
  const m = S.m;
  const base = from ?? m.activeProgram(uid);
  const workouts = base ? m.workoutsOf(base) : [];
  return {
    uid,
    name: base ? `${base.name} · ${T('הבא', 'next')}` : T('תוכנית חדשה', 'New plan'),
    goal: '',
    weeks: 4,
    days: Math.max(1, workouts.length || 3),
    fromId: base?.id ?? '',
    workouts: (workouts.length ? workouts : [{ id: null, name: T('אימון A', 'Workout A') }]).map((w) => ({
      name: w.name,
      rows: w.id
        ? m
            .steps(w.id)
            .map((s) => ({ exId: s.exId ?? '', sets: s.sets, reps: s.reps ?? 10, kg: s.kg, rest: s.rest || 90 }))
        : [],
    })),
    saved: false,
  };
};
const statusOptions = (boardId, colId) => {
  const col = S.m.B(boardId)?.columns?.find((c) => c.id === colId);
  return (col?.settings?.labels ?? [])
    .filter((l) => !l.is_deactivated)
    .map((l) => ({ value: l.label, label: l.label }));
};

const programBuilder = (uid, who) => {
  const c = S.cfg.train;
  if (!c.programs || !c.templates)
    return needs(
      T('כדי לבנות תוכנית, בחר בהגדרות את לוח התוכניות.', 'To build a plan, pick the plans board in the settings.'),
    );
  if (!S.prog || S.prog.uid !== uid) S.prog = newProgram(uid);
  const P = S.prog;
  const vol = (r) => (r.kg ? (r.sets || 0) * (r.reps || 0) * r.kg : 0);
  const exOpts = exerciseOptions();
  const plans = S.m.programsOf(uid);
  const set =
    (fn) =>
    (...a) => {
      fn(...a);
      P.saved = false;
      render();
    };
  return h(
    'div',
    { class: 'builder', 'data-testid': 'fit-program-builder' },
    h(
      'div',
      { class: 'bh' },
      h('span', { class: 'nm' }, T('בניית תוכנית אימון', 'Build a workout plan'), who ? ` · ${who}` : ''),
      h('input', {
        type: 'text',
        'data-k': 'p-name',
        value: P.name,
        attrs: { 'aria-label': T('שם התוכנית', 'Plan name') },
        on: { input: (e) => ((P.name = e.target.value), (P.saved = false)) },
      }),
      h(
        'span',
        { class: 'pb-meta' },
        c.prog?.goal
          ? select(
              P.goal,
              [{ value: '', label: T('מטרה', 'Goal') }, ...statusOptions(c.programs, c.prog.goal)],
              set((v) => (P.goal = v)),
              { attrs: { 'aria-label': T('מטרה', 'Goal') } },
            )
          : null,
        c.prog?.period
          ? [
              h('input', {
                type: 'number',
                'data-k': 'p-weeks',
                value: String(P.weeks),
                attrs: { 'aria-label': T('שבועות', 'Weeks') },
                on: { input: (e) => (P.weeks = parseInt(e.target.value, 10) || 1) },
              }),
              T(' שבועות', ' weeks'),
            ]
          : null,
        c.prog?.days
          ? [
              h('input', {
                type: 'number',
                'data-k': 'p-days',
                value: String(P.days),
                attrs: { 'aria-label': T('אימונים בשבוע', 'Workouts a week') },
                on: { input: (e) => (P.days = parseInt(e.target.value, 10) || 1) },
              }),
              T(' בשבוע', ' a week'),
            ]
          : null,
        plans.length
          ? select(
              P.fromId,
              [
                { value: '', label: T('להתחיל מאפס', 'Start empty') },
                ...plans.map((p) => ({ value: p.id, label: `${T('להתחיל מ', 'Start from ')}${p.name}` })),
              ],
              (v) => {
                const from = plans.find((p) => p.id === v);
                S.prog = v
                  ? newProgram(uid, from)
                  : { ...newProgram(uid, null), workouts: [{ name: T('אימון A', 'Workout A'), rows: [] }], fromId: '' };
                render();
              },
              { attrs: { 'aria-label': T('להתחיל מתוכנית', 'Start from a plan') } },
            )
          : null,
      ),
    ),
    P.workouts.map((w, wi) => {
      const sets = w.rows.reduce((n, r) => n + (r.sets || 0), 0);
      const v = w.rows.reduce((n, r) => n + vol(r), 0);
      return h(
        'div',
        { class: 'bmeal' },
        h(
          'div',
          { class: 'mh' },
          h('input', {
            type: 'text',
            class: 'mn',
            'data-k': `w-name-${wi}`,
            value: w.name,
            attrs: { 'aria-label': T('שם האימון', 'Workout name') },
            on: { input: (e) => ((w.name = e.target.value), (P.saved = false)) },
          }),
          h(
            'span',
            { class: 'tot' },
            T(
              `${w.rows.length} תרגילים · ${sets} סטים · נפח ${fmt(v)} ק״ג`,
              `${w.rows.length} exercises · ${sets} sets · volume ${fmt(v)} kg`,
            ),
          ),
          h('button', { class: 'del', on: { click: set(() => P.workouts.splice(wi, 1)) } }, T('הסרה', 'Remove')),
        ),
        h(
          'div',
          { class: 'brow prow head' },
          h('span', {}, T('תרגיל (ספריית תרגילים)', 'Exercise (library)')),
          h('span', { class: 'v' }, T('סטים', 'Sets')),
          h('span', { class: 'v' }, T('חזרות', 'Reps')),
          h('span', { class: 'v' }, T('ק״ג', 'kg')),
          h('span', { class: 'v rst' }, T('מנוחה', 'Rest')),
          h('span', { class: 'v vol' }, T('נפח', 'Volume')),
          h('span', {}),
        ),
        w.rows.map((r, ri) =>
          h(
            'div',
            { class: 'brow prow' },
            select(
              r.exId,
              [{ value: '', label: '—' }, ...exOpts],
              set((val) => (r.exId = val)),
              { attrs: { 'aria-label': T('תרגיל', 'Exercise') } },
            ),
            ...[
              ['sets', 1],
              ['reps', 1],
              ['kg', 0.5],
              ['rest', 5],
            ].map(([k, step]) =>
              h('input', {
                type: 'number',
                class: k === 'rest' ? 'rst' : '',
                step: String(step),
                'data-k': `r-${wi}-${ri}-${k}`,
                value: r[k] === null || r[k] === undefined ? '' : String(r[k]),
                placeholder: '—',
                attrs: { 'aria-label': k },
                on: {
                  input: (e) => {
                    r[k] = e.target.value === '' ? null : parseFloat(e.target.value);
                    P.saved = false;
                    render();
                  },
                },
              }),
            ),
            h('span', { class: 'v vol' }, fmt(vol(r))),
            h(
              'button',
              {
                class: 'x',
                attrs: { 'aria-label': T('הסרה', 'Remove') },
                on: { click: set(() => w.rows.splice(ri, 1)) },
              },
              '✕',
            ),
          ),
        ),
        h(
          'button',
          {
            class: 'badd',
            on: {
              click: set(() => w.rows.push({ exId: exOpts[0]?.value ?? '', sets: 3, reps: 10, kg: null, rest: 90 })),
            },
          },
          T('+ תרגיל', '+ Exercise'),
        ),
      );
    }),
    h(
      'button',
      {
        class: 'badd',
        on: {
          click: set(() =>
            P.workouts.push({
              name: `${T('אימון', 'Workout')} ${String.fromCharCode(65 + P.workouts.length)}`,
              rows: [],
            }),
          ),
        },
      },
      T('+ אימון', '+ Workout'),
    ),
    h(
      'div',
      { class: 'btot' },
      h(
        'div',
        { class: 'actions', style: { marginTop: 0 } },
        h(
          'button',
          {
            class: 'abtn main',
            'data-testid': 'fit-save-program',
            disabled: P.saving,
            on: { click: () => saveProgram(P, who) },
          },
          P.saved ? T('נשמר ✓', 'Saved ✓') : T('שמירת התוכנית', 'Save the plan'),
        ),
        h(
          'button',
          {
            class: 'abtn',
            on: {
              click: set(() =>
                P.workouts.forEach((w) =>
                  w.rows.forEach((r) => {
                    if (r.kg) r.kg = Math.round((r.kg + 2.5) * 10) / 10;
                  }),
                ),
              ),
            },
          },
          T('הבלוק הבא: +2.5 ק״ג לכל תרגיל', 'Next block: +2.5 kg each'),
        ),
      ),
      h(
        'p',
        { class: 'muted', style: { margin: '6px 0 0', fontSize: '12px' } },
        T(
          'נשמר כפריט בלוח התוכניות ופריט לכל אימון בלוח האימונים (בקבוצה בשם התוכנית) עם תת-פריט לכל תרגיל. אפשר להמשיך לערוך גם כאן וגם בטבלה של הלוח.',
          'Saved as an item on the plans board and an item per workout on the workouts board (in a group named after the plan) with a subitem per exercise. Edit it here or in the board table.',
        ),
      ),
    ),
  );
};

const saveProgram = (P, who) => {
  const c = S.cfg.train;
  const st = c.step ?? {};
  const pc = c.prog ?? {};
  const from = today();
  const to = (() => {
    const d = new Date();
    d.setDate(d.getDate() + P.weeks * 7 - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const prog = S.q.tmp();
  void S.q.push({
    method: 'POST',
    path: `/boards/${c.programs}/items`,
    body: {
      name: P.name,
      values: compact({
        [pc.trainee]: P.uid,
        [pc.goal]: P.goal || undefined,
        [pc.period]: `${from} / ${to}`,
        [pc.days]: P.days,
      }),
    },
    creates: prog,
    what: `${T('תוכנית', 'Plan')} "${P.name}"`,
  });
  const group = S.q.tmp();
  void S.q.push({
    method: 'POST',
    path: `/boards/${c.templates}/groups`,
    body: { title: P.name },
    creates: group,
    what: T('קבוצה לאימונים', 'Group for the workouts'),
  });
  const back = (S.m.B(c.templates)?.columns ?? []).find(
    (col) => col.type === 'board_relation' && (col.settings?.board_ids ?? []).includes(c.programs),
  );
  const ids = [];
  for (const w of P.workouts) {
    const wid = S.q.tmp();
    ids.push(wid);
    void S.q.push({
      method: 'POST',
      path: `/boards/${c.templates}/items`,
      body: { name: w.name, group_id: group, values: compact({ [back?.id]: prog }) },
      creates: wid,
      what: w.name,
    });
    w.rows.forEach((r, i) => {
      const ex = S.m.exercise(r.exId);
      void S.q.push({
        method: 'POST',
        path: `/items/${wid}/subitems`,
        body: {
          name: ex?.name ?? T('תרגיל', 'Exercise'),
          values: compact({
            [st.ex]: r.exId || undefined,
            [st.order]: i + 1,
            [st.sets]: r.sets,
            [st.reps]: r.reps,
            [st.kg]: r.kg,
            [st.rest]: r.rest,
          }),
        },
        what: `${w.name} · ${ex?.name ?? ''}`,
      });
    });
  }
  if (pc.workouts)
    void S.q.push({
      method: 'PATCH',
      path: `/items/${prog}`,
      body: { values: { [pc.workouts]: ids.join(',') } },
      what: T('קישור האימונים לתוכנית', 'Link the workouts'),
    });
  if (who)
    void S.q.push({
      method: 'POST',
      path: `/items/${prog}/updates`,
      body: { body: T(`תוכנית אימון חדשה בשבילך: ${P.name}`, `A new workout plan for you: ${P.name}`) },
      what: T('הודעה למתאמן', 'Note to the trainee'),
    });
  P.saved = true;
  S.flash = T(
    'התוכנית נשמרת. היא תופיע במסך האימון כשהשמירה תסתיים.',
    'The plan is being saved. It shows on the workout screen once saved.',
  );
  render();
};

const newPlan = (uid, fromGroup) => {
  const m = S.m;
  const g = fromGroup ?? groupNow();
  return {
    uid,
    name: g
      ? `${m.menuGroups().find((x) => x.id === g)?.title ?? ''} · ${T('חדש', 'new')}`
      : T('תפריט חדש', 'New menu'),
    fromId: g ?? '',
    meals: m.meals(g).map((meal) => ({
      name: meal.name,
      time: meal.time,
      foods: meal.foods.filter((f) => f.foodId).map((f) => ({ foodId: f.foodId, g: f.g })),
    })),
    saved: false,
  };
};
const planBuilder = (uid, who) => {
  const F = S.cfg.food ?? {};
  if (!F.menu || !F.foods)
    return needs(
      T(
        'כדי לבנות תפריט, בחר בהגדרות את לוח התפריט ואת מאגר המזונות.',
        'To build a menu, pick the menu and foods boards in the settings.',
      ),
    );
  if (!S.plan || S.plan.uid !== uid) S.plan = newPlan(uid);
  const P = S.plan;
  const target = S.m.target(uid);
  const fopts = S.m.foods().map((f) => ({ value: f.id, label: f.name }));
  const all = S.m.sum(P.meals.flatMap((m) => m.foods.map((f) => S.m.macro(f.foodId, f.g))));
  const set =
    (fn) =>
    (...a) => {
      fn(...a);
      P.saved = false;
      render();
    };
  const groups = S.m.menuGroups();
  return h(
    'div',
    { class: 'builder', 'data-testid': 'fit-plan-builder' },
    h(
      'div',
      { class: 'bh' },
      h('span', { class: 'nm' }, T('בניית תוכנית תזונה', 'Build a nutrition plan'), who ? ` · ${who}` : ''),
      h('input', {
        type: 'text',
        'data-k': 'm-name',
        value: P.name,
        attrs: { 'aria-label': T('שם התפריט', 'Menu name') },
        on: { input: (e) => ((P.name = e.target.value), (P.saved = false)) },
      }),
      h(
        'span',
        { class: 'pb-meta' },
        target?.kcal
          ? T(
              `יעד: ${fmt(target.kcal)} קק״ל · ${fmt(target.prot)} ח׳ · ${fmt(target.carb)} פ׳ · ${fmt(target.fat)} ש׳`,
              `Target: ${fmt(target.kcal)} kcal · ${fmt(target.prot)} p · ${fmt(target.carb)} c · ${fmt(target.fat)} f`,
            )
          : T('אין יעד', 'No target'),
        groups.length
          ? select(
              P.fromId,
              [
                { value: '', label: T('להתחיל מאפס', 'Start empty') },
                ...groups.map((g) => ({ value: g.id, label: `${T('להתחיל מ', 'Start from ')}${g.title}` })),
              ],
              (v) => {
                S.plan = v ? newPlan(uid, v) : { ...newPlan(uid, null), meals: [], fromId: '' };
                render();
              },
              { attrs: { 'aria-label': T('להתחיל מתפריט', 'Start from a menu') } },
            )
          : null,
      ),
    ),
    P.meals.map((meal, mi) => {
      const t = S.m.sum(meal.foods.map((f) => S.m.macro(f.foodId, f.g)));
      return h(
        'div',
        { class: 'bmeal' },
        h(
          'div',
          { class: 'mh' },
          h('input', {
            type: 'text',
            class: 'mn',
            'data-k': `ml-${mi}`,
            value: meal.name,
            attrs: { 'aria-label': T('שם הארוחה', 'Meal name') },
            on: { input: (e) => ((meal.name = e.target.value), (P.saved = false)) },
          }),
          h('input', {
            type: 'text',
            class: 'mt',
            'data-k': `mt-${mi}`,
            value: meal.time ?? '',
            placeholder: '08:00',
            attrs: { 'aria-label': T('שעה', 'Time') },
            on: { input: (e) => ((meal.time = e.target.value), (P.saved = false)) },
          }),
          h(
            'span',
            { class: 'tot' },
            `${fmt(t.kcal)} ${T('קק״ל', 'kcal')} · ${fmt(t.prot, 1)} ${T('ח׳', 'p')} · ${fmt(t.carb, 1)} ${T('פ׳', 'c')} · ${fmt(t.fat, 1)} ${T('ש׳', 'f')}`,
          ),
          h('button', { class: 'del', on: { click: set(() => P.meals.splice(mi, 1)) } }, T('הסרה', 'Remove')),
        ),
        h(
          'div',
          { class: 'brow head' },
          h('span', {}, T('מזון (מאגר מזונות)', 'Food (foods board)')),
          h('span', {}, T('גרם', 'Grams')),
          h('span', { class: 'v' }, T('קק״ל', 'kcal')),
          h('span', { class: 'v pr' }, T('חלבון', 'Protein')),
          h('span', { class: 'v c' }, T('פחמ׳', 'Carbs')),
          h('span', { class: 'v f' }, T('שומן', 'Fat')),
          h('span', {}),
        ),
        meal.foods.map((f, fi) => {
          const x = S.m.macro(f.foodId, f.g);
          return h(
            'div',
            { class: 'brow' },
            select(
              f.foodId,
              fopts,
              set((v) => {
                f.foodId = v;
                f.g = S.m.per100(v).portion;
              }),
              { attrs: { 'aria-label': T('מזון', 'Food') } },
            ),
            h('input', {
              type: 'number',
              'data-k': `fg-${mi}-${fi}`,
              value: String(f.g ?? ''),
              attrs: { 'aria-label': T('גרם', 'Grams') },
              on: {
                input: (e) => {
                  f.g = parseFloat(e.target.value) || 0;
                  P.saved = false;
                  render();
                },
              },
            }),
            h('span', { class: 'v' }, fmt(x.kcal)),
            h('span', { class: 'v pr' }, fmt(x.prot, 1)),
            h('span', { class: 'v c' }, fmt(x.carb, 1)),
            h('span', { class: 'v f' }, fmt(x.fat, 1)),
            h(
              'button',
              {
                class: 'x',
                attrs: { 'aria-label': T('הסרה', 'Remove') },
                on: { click: set(() => meal.foods.splice(fi, 1)) },
              },
              '✕',
            ),
          );
        }),
        h(
          'button',
          {
            class: 'badd',
            on: {
              click: set(() =>
                meal.foods.push({ foodId: fopts[0]?.value ?? '', g: S.m.per100(fopts[0]?.value).portion }),
              ),
            },
          },
          T('+ מזון', '+ Food'),
        ),
      );
    }),
    h(
      'button',
      {
        class: 'badd',
        on: { click: set(() => P.meals.push({ name: T('ארוחה חדשה', 'New meal'), time: '12:00', foods: [] })) },
      },
      T('+ ארוחה', '+ Meal'),
    ),
    h(
      'div',
      { class: 'btot' },
      target ? bars(all, target) : null,
      h(
        'div',
        { class: 'actions', style: { marginTop: '4px' } },
        h(
          'button',
          { class: 'abtn main', 'data-testid': 'fit-save-plan', on: { click: () => savePlan(P, who) } },
          P.saved ? T('נשמר ✓', 'Saved ✓') : T('שמירת התפריט', 'Save the menu'),
        ),
      ),
    ),
  );
};
const savePlan = (P, who) => {
  const F = S.cfg.food;
  const M = F.msub ?? {};
  const title = who ? `${who} · ${P.name}` : P.name;
  const group = S.q.tmp();
  void S.q.push({
    method: 'POST',
    path: `/boards/${F.menu}/groups`,
    body: { title },
    creates: group,
    what: `${T('תפריט', 'Menu')} "${title}"`,
  });
  for (const meal of P.meals) {
    const mid = S.q.tmp();
    const time = /^\d{1,2}:\d{2}$/.test(meal.time ?? '') ? meal.time : undefined;
    void S.q.push({
      method: 'POST',
      path: `/boards/${F.menu}/items`,
      body: { name: meal.name, group_id: group, values: compact({ [F.mealc?.time]: time }) },
      creates: mid,
      what: meal.name,
    });
    for (const f of meal.foods) {
      const food = S.m.food(f.foodId);
      void S.q.push({
        method: 'POST',
        path: `/items/${mid}/subitems`,
        body: { name: food?.name ?? T('מזון', 'Food'), values: compact({ [M.food]: f.foodId, [M.g]: f.g }) },
        what: `${meal.name} · ${food?.name ?? ''}`,
      });
    }
  }
  P.saved = true;
  S.flash = who
    ? T(
        `התפריט "${title}" נשמר בלוח התפריט. ${who} יבחר אותו ב"התפריט שלי".`,
        `The menu "${title}" was saved. ${who} picks it under "My menu".`,
      )
    : T(
        'התפריט נשמר. בחר אותו ב"התפריט שלי" כשהשמירה תסתיים.',
        'The menu was saved. Pick it under "My menu" once saved.',
      );
  render();
};

// ================================================================ coach

const trainees = () => {
  const col = S.cfg.train?.prog?.trainee;
  if (!col) return [];
  const ids = new Set();
  for (const p of S.m.programs())
    for (const id of (p.cells?.[col]?.value?.persons_and_teams ?? [])
      .filter((x) => x.kind === 'person')
      .map((x) => x.id))
      ids.add(id);
  return [...ids].map((id) => ({ id, name: S.members.find((m) => m.user_id === id)?.name ?? T('מתאמן', 'Trainee') }));
};
const traineeStats = (uid) => {
  const m = S.m;
  const p = m.activeProgram(uid);
  const wk = m.week(uid, S.ctx.locale);
  const done = wk.filter((d) => d.state === 'done').length;
  const want =
    num0(p && S.cfg.train.prog?.days ? p.cells?.[S.cfg.train.prog.days]?.value : null) || m.workoutsOf(p).length || 3;
  const logs = [...m.logsOf(uid)].sort((a, b) => (m.logDate(b) < m.logDate(a) ? -1 : 1));
  const last = logs[0] ?? null;
  const gap = last ? daysAgo(m.logDate(last)) : Infinity;
  const lastRpe = last ? (S.cfg.train.logc?.rpe ? last.cells?.[S.cfg.train.logc.rpe]?.text : '') : '';
  const flag =
    gap >= 7
      ? T(
          `לא התאמן ${gap === Infinity ? 'עדיין' : `${gap} ימים`}`,
          gap === Infinity ? 'No workouts yet' : `No workout for ${gap} days`,
        )
      : null;
  return { p, wk, adh: Math.min(100, Math.round((done / Math.max(want, 1)) * 100)), last, gap, flag, lastRpe };
};
const num0 = (v) => (typeof v === 'number' ? v : 0);

const coachView = () => {
  const list = trainees();
  if (!S.cfg.train?.programs)
    return needs(
      T(
        'כדי לראות מתאמנים, בחר בהגדרות את לוח התוכניות ואת עמודת המתאמן.',
        'To see trainees, pick the plans board and its trainee column in the settings.',
      ),
    );
  if (!list.length)
    return h(
      'div',
      { class: 'empty' },
      T(
        'עוד אין מתאמנים: מתאמן הוא מי שמופיע בעמודת "מתאמן" של תוכנית.',
        'No trainees yet: a trainee is whoever is in the trainee column of a plan.',
      ),
    );
  if (!S.coachSel || !list.some((t) => t.id === S.coachSel)) S.coachSel = list[0].id;
  const t = list.find((x) => x.id === S.coachSel);
  const st = traineeStats(t.id);
  const m = S.m;
  let main;
  if (S.coachSub === 'build')
    main = [
      h(
        'p',
        { class: 'note', style: { margin: '0 0 12px' } },
        T(
          'כאן המאמן מכין את התוכנית למתאמן. השמירה יוצרת את הפריטים בלוחות התוכניות והאימונים, והמתאמן רואה אותה במסך האימון.',
          'Here the coach prepares the trainee’s plan. Saving creates the items on the plans and workouts boards; the trainee sees it on the workout screen.',
        ),
      ),
      programBuilder(t.id, t.name),
    ];
  else if (S.coachSub === 'food') {
    const day = m.dayOf(t.id);
    const tot = m.sum(day ? m.eatenOf(day.id).map((e) => m.macro(e.foodId, e.g)) : []);
    main = [
      h(
        'div',
        { class: 'cols', style: { marginBottom: '14px' } },
        h(
          'div',
          { class: 'box' },
          h(
            'div',
            { class: 'bt' },
            h('span', {}, T('היום · מול היעד', 'Today vs target')),
            h(
              'span',
              {},
              day
                ? T(`${m.eatenOf(day.id).length} מזונות`, `${m.eatenOf(day.id).length} foods`)
                : T('לא נרשם', 'Nothing logged'),
            ),
          ),
          bars(tot, m.target(t.id)),
          h('div', { style: { height: '12px' } }),
        ),
        foodWeekBox(t.id),
      ),
      planBuilder(t.id, t.name),
    ];
  } else {
    const sets = st.last ? m.setsOf(st.last.id) : [];
    const byEx = new Map();
    for (const s of sets) {
      const k = s.exId ?? s.name;
      if (!byEx.has(k)) byEx.set(k, { name: m.exInfo(s.exId, s.name).name, reps: [], kg: 0 });
      const e = byEx.get(k);
      e.reps.push(fmt(s.reps));
      e.kg = Math.max(e.kg, s.kg || 0);
    }
    main = [
      h(
        'div',
        { class: 'cols' },
        h(
          'div',
          { class: 'box' },
          h(
            'div',
            { class: 'bt' },
            h('span', {}, T('השבוע', 'This week')),
            h(
              'span',
              {},
              T(
                `${st.wk.filter((d) => d.state === 'done').length} בוצעו`,
                `${st.wk.filter((d) => d.state === 'done').length} done`,
              ),
            ),
          ),
          weekRow(st.wk),
          h(
            'div',
            { style: { padding: '0 12px 12px' } },
            h('div', { class: 'pct' }, h('i', { style: { width: `${st.adh}%` } })),
          ),
        ),
        h(
          'div',
          { class: 'box' },
          h(
            'div',
            { class: 'bt' },
            h('span', {}, T('האימון האחרון · סטים', 'Last workout · sets')),
            h('span', {}, st.last ? dm(m.logDate(st.last)) : '—'),
          ),
          byEx.size
            ? h(
                'table',
                {},
                h(
                  'thead',
                  {},
                  h(
                    'tr',
                    {},
                    h('th', {}, T('תרגיל', 'Exercise')),
                    h('th', {}, T('חזרות', 'Reps')),
                    h('th', {}, T('ק״ג', 'kg')),
                  ),
                ),
                h(
                  'tbody',
                  {},
                  [...byEx.values()].map((e) =>
                    h(
                      'tr',
                      {},
                      h('td', {}, e.name),
                      h('td', { class: 'm' }, e.reps.join(' · ')),
                      h('td', { class: 'm' }, e.kg ? fmt(e.kg, 1) : '—'),
                    ),
                  ),
                ),
              )
            : h('div', { class: 'empty' }, T('אין סטים.', 'No sets.')),
        ),
      ),
      h(
        'p',
        { class: 'note' },
        T(
          'עריכת התוכנית: בטאב "בניית תוכנית אימון" כאן, או בטבלה של הלוח. הערה למתאמן נשמרת כעדכון על התוכנית שלו.',
          'Edit the plan under "Build a workout plan" here, or in the board table. A note to the trainee is saved as an update on their plan.',
        ),
      ),
      S.noteFor === t.id
        ? h(
            'div',
            { class: 'field', style: { margin: '12px 0 0' } },
            h('label', { attrs: { for: 'fit-coach-note' } }, T('הערה למתאמן', 'Note to the trainee')),
            h('textarea', { id: 'fit-coach-note', rows: '3', 'data-k': 'coach-note' }),
            h(
              'div',
              { class: 'actions' },
              h(
                'button',
                {
                  class: 'abtn main',
                  on: {
                    click: () => {
                      const v = document.getElementById('fit-coach-note')?.value?.trim();
                      if (v && st.p)
                        void S.q.push({
                          method: 'POST',
                          path: `/items/${st.p.id}/updates`,
                          body: { body: v },
                          what: T('הערה למתאמן', 'Note to the trainee'),
                        });
                      S.noteFor = null;
                      S.flash = T('ההערה נשלחה.', 'The note was sent.');
                      render();
                    },
                  },
                },
                T('שליחה', 'Send'),
              ),
              h('button', { class: 'abtn', on: { click: () => ((S.noteFor = null), render()) } }, T('ביטול', 'Cancel')),
            ),
          )
        : h(
            'div',
            { class: 'actions' },
            h(
              'button',
              {
                class: 'abtn main',
                on: {
                  click: () => {
                    S.prog = newProgram(t.id, st.p);
                    S.prog.workouts.forEach((w) =>
                      w.rows.forEach((r) => {
                        if (r.kg) r.kg = Math.round((r.kg + 2.5) * 10) / 10;
                      }),
                    );
                    go({ coachSub: 'build' });
                  },
                },
              },
              T('הבלוק הבא עם +2.5 ק״ג', 'Next block with +2.5 kg'),
            ),
            st.p
              ? h(
                  'button',
                  { class: 'abtn', on: { click: () => ((S.noteFor = t.id), render()) } },
                  T('הערה למתאמן', 'Note to the trainee'),
                )
              : null,
            st.p
              ? h(
                  'button',
                  { class: 'abtn', on: { click: () => void bines.execute('openItemCard', { itemId: st.p.id }) } },
                  T('פתיחת התוכנית', 'Open the plan'),
                )
              : null,
          ),
    ];
  }
  return h(
    'div',
    { class: 'coach', 'data-testid': 'fit-coach' },
    h(
      'div',
      { class: 'tr-list' },
      list.map((x) => {
        const s = traineeStats(x.id);
        return h(
          'button',
          {
            class: `tr ${x.id === S.coachSel ? 'sel' : ''}`,
            'data-testid': 'fit-trainee',
            on: { click: () => go({ coachSel: x.id }) },
          },
          h('span', { class: 'av' }, x.name.slice(0, 1)),
          h(
            'span',
            { style: { minWidth: 0 } },
            h('span', { class: 'nm' }, x.name),
            h('span', { class: 'pg' }, s.p?.name ?? '—'),
          ),
          h('span', { class: `fl ${s.flag ? 'bad' : ''}` }, s.flag ? '!' : `${s.adh}%`),
        );
      }),
    ),
    h(
      'div',
      { class: 'tr-main' },
      h('h3', {}, t.name),
      h(
        'div',
        { class: 'meta' },
        [
          st.p?.name ?? T('בלי תוכנית', 'No plan'),
          st.last ? T(`אימון אחרון: ${dm(m.logDate(st.last))}`, `Last workout: ${dm(m.logDate(st.last))}`) : null,
          T(`עמידה בתוכנית ${st.adh}%`, `On plan ${st.adh}%`),
          st.flag,
        ]
          .filter(Boolean)
          .join(' · '),
      ),
      h(
        'div',
        { class: 'subtabs' },
        [
          ['train', T('אימון', 'Workout')],
          ['build', T('בניית תוכנית אימון', 'Build a workout plan')],
          ['food', T('תזונה', 'Nutrition')],
        ].map(([id, label]) =>
          h(
            'button',
            {
              attrs: { 'aria-pressed': String(S.coachSub === id) },
              on: {
                click: () => {
                  if (id === 'build' && S.prog?.uid !== t.id) S.prog = null;
                  if (id === 'food' && S.plan?.uid !== t.id) S.plan = null;
                  go({ coachSub: id });
                },
              },
            },
            label,
          ),
        ),
      ),
      main,
    ),
  );
};

// ================================================================ settings

const settingsView = () => {
  const cfg = S.cfg;
  const boards = [...S.store.boards.values()].filter(
    (b) => !b.parent_board_id && (S.ctx.board_ids?.length ? S.ctx.board_ids.includes(b.id) : b.id === S.ctx.board_id),
  );
  const boardOpts = [{ value: '', label: '—' }, ...boards.map((b) => ({ value: b.id, label: b.name }))];
  const field = (label, control) => h('div', { class: 'sf' }, h('label', {}, label), control);
  const part = (pk, title) => {
    const out = [h('h4', {}, title)];
    for (const [key, role] of Object.entries(ROLES[pk])) {
      if (role.kind === 'board') {
        out.push(
          field(
            role.label,
            select(
              cfg[pk][key] ?? '',
              boardOpts,
              (v) => {
                cfg[pk][key] = v || null;
                void S.store.loadBoard(v).then(render);
                render();
              },
              { 'data-testid': `fit-set-${pk}-${key}` },
            ),
          ),
        );
        continue;
      }
      const bid = roleBoardId(cfg, S.store.boards, pk, role.on);
      const board = bid ? S.store.boards.get(bid) : null;
      if (!board) continue;
      cfg[pk][key] = cfg[pk][key] ?? {};
      out.push(h('div', { class: 'sf' }, h('label', { style: { fontWeight: 500, color: 'var(--fg-2)' } }, role.label)));
      for (const [ck, spec] of Object.entries(role.cols)) {
        const opts = [
          { value: '', label: '—' },
          ...(board.columns ?? [])
            .filter((c) => spec.types.includes(c.type))
            .map((c) => ({ value: c.id, label: c.title })),
        ];
        out.push(
          field(
            spec.label,
            select(cfg[pk][key][ck] ?? '', opts, (v) => {
              cfg[pk][key][ck] = v || null;
              render();
            }),
          ),
        );
      }
    }
    return out;
  };
  const labelPick = (label, boardId, colId, key) =>
    boardId && colId
      ? field(
          label,
          select(
            cfg.train[key] ?? '',
            [{ value: '', label: '—' }, ...statusOptions(boardId, colId)],
            (v) => ((cfg.train[key] = v || null), render()),
          ),
        )
      : null;
  const sw = (label, on, flip) =>
    h(
      'div',
      { class: 'sw' },
      h('span', {}, label),
      h('button', {
        class: 'k',
        role: 'switch',
        attrs: { 'aria-checked': String(on), 'aria-label': label },
        on: { click: () => (flip(), render()) },
      }),
    );
  cfg.ui = cfg.ui ?? {};
  cfg.coach = cfg.coach ?? { enabled: true };
  const groups = cfg.food?.menu ? (S.store.boards.get(cfg.food.menu)?.groups ?? []) : [];
  return h(
    'div',
    { class: 'dbody', 'data-testid': 'fit-settings' },
    !S.cfgSaved
      ? h(
          'p',
          { class: 'note', style: { margin: '0 0 12px' } },
          T(
            'זו הפתיחה: התוסף הציע אילו לוחות ועמודות משמשים לכל דבר. בדוק, תקן ושמור.',
            'First run: the extension suggested which boards and columns play which role. Check, fix and save.',
          ),
        )
      : null,
    h(
      'div',
      { class: 'box', style: { marginBottom: '14px' } },
      h(
        'div',
        { class: 'bt' },
        h('span', {}, T('הלוחות שהתצוגה הזאת משתמשת בהם', 'Boards this view uses')),
        h('span', {}, String(boards.length)),
      ),
      h(
        'div',
        { style: { padding: '10px 12px' } },
        h(
          'div',
          { class: 'muted', style: { fontSize: '13px', marginBottom: '8px' } },
          boards.map((b) => b.name).join(' · ') || '—',
        ),
        h(
          'button',
          { class: 'abtn main', 'data-testid': 'fit-pick-boards', on: { click: pickBoards } },
          T('בחירת לוחות…', 'Choose boards…'),
        ),
        h(
          'div',
          { class: 'muted', style: { fontSize: '12px', marginTop: '6px' } },
          T(
            'הבחירה נעשית בחלון של המערכת, וכל אחד רואה רק לוחות שמותר לו.',
            'You choose in the app’s own window; everyone sees only boards they are allowed to.',
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'set-grid' },
      h(
        'div',
        {},
        part('train', T('אימון', 'Workouts')),
        labelPick(
          T('סטטוס "בוצע" ביומן', '"Done" status in the log'),
          cfg.train.log,
          cfg.train.logc?.state,
          'done_label',
        ),
        labelPick(
          T('סטטוס "חלקי" ביומן', '"Partial" status in the log'),
          cfg.train.log,
          cfg.train.logc?.state,
          'partial_label',
        ),
        labelPick(
          T('סטטוס של תוכנית פעילה', 'Status of an active plan'),
          cfg.train.programs,
          cfg.train.prog?.status,
          'active_label',
        ),
      ),
      h(
        'div',
        {},
        part('food', T('תזונה', 'Nutrition')),
        groups.length
          ? field(
              T('התפריט היומי כברירת מחדל (קבוצה)', 'Default daily menu (group)'),
              select(
                cfg.food.day_group ?? '',
                [{ value: '', label: '—' }, ...groups.map((g) => ({ value: g.id, label: g.title }))],
                (v) => ((cfg.food.day_group = v || null), render()),
              ),
            )
          : null,
      ),
      h(
        'div',
        {},
        h('h4', {}, T('תצוגה', 'Display')),
        sw(T('טיימר מנוחה', 'Rest timer'), cfg.ui.timer !== false, () => (cfg.ui.timer = cfg.ui.timer === false)),
        sw(
          T('הוספת סט תוך כדי', 'Add sets during a workout'),
          cfg.ui.add_sets !== false,
          () => (cfg.ui.add_sets = cfg.ui.add_sets === false),
        ),
        sw(
          T('מסך מאמן', 'Coach screen'),
          cfg.coach.enabled !== false,
          () => (cfg.coach.enabled = cfg.coach.enabled === false),
        ),
        h(
          'div',
          { class: 'actions' },
          h(
            'button',
            { class: 'abtn main', 'data-testid': 'fit-save-settings', on: { click: saveSettings } },
            T('שמירת ההגדרות', 'Save the settings'),
          ),
          h(
            'button',
            {
              class: 'abtn',
              on: {
                click: () => {
                  S.cfg = guessSettings(S.ctx.board_id, S.store.boards);
                  render();
                },
              },
            },
            T('להציע מחדש', 'Suggest again'),
          ),
        ),
        h(
          'p',
          { class: 'muted', style: { fontSize: '12px' } },
          T(
            'ההגדרות משותפות לכל מי שפותח את התצוגה בלוח הזה. מי שאין לו הרשאה לשנות אותן שומר אותן רק לעצמו.',
            'The settings are shared by everyone who opens this view on this board. Someone not allowed to change them keeps them for themselves only.',
          ),
        ),
      ),
    ),
  );
};
const pickBoards = async () => {
  try {
    const res = await bines.execute('pickBoards');
    if (!res) return;
    S.ctx = await bines.get('context');
    await Promise.all((S.ctx.board_ids ?? []).map((id) => S.store.loadBoard(id)));
    if (!S.cfgSaved) S.cfg = guessSettings(S.ctx.board_id, S.store.boards);
    render();
  } catch (err) {
    S.error =
      T('בחירת לוחות לא זמינה כאן.', 'Choosing boards is not available here.') +
      ` (${err?.code || err?.message || err})`;
    render();
  }
};
const saveSettings = async () => {
  try {
    await bines.storage.set(cfgKey(), S.cfg, { scope: 'installation' });
  } catch {
    try {
      await bines.storage.set(cfgKey(), S.cfg, { scope: 'user' });
      S.flash = T(
        'נשמר רק בשבילך (אין לך הרשאה לשנות את ההגדרות המשותפות).',
        'Saved for you only (you may not change the shared settings).',
      );
    } catch (err) {
      S.error = `${T('לא נשמר', 'Not saved')}: ${err?.code || err?.message || err}`;
      return render();
    }
  }
  S.cfgSaved = true;
  S.loading = true;
  render();
  await loadAll();
  S.loading = false;
  S.flash = S.flash || T('ההגדרות נשמרו.', 'Settings saved.');
  go({ tab: 'train' });
};

// the session clock
setInterval(() => {
  if (S.ses && S.screen === 'session')
    document
      .querySelectorAll('.ses-clock')
      .forEach((x) => (x.textContent = `${T('אימון פעיל · ', 'Active · ')}${elapsed()}`));
}, 1000);

main().catch((err) => {
  app.replaceChildren(
    h('div', { class: 'err', role: 'alert' }, `${T('שגיאה', 'Error')}: ${err?.code || err?.message || err}`),
  );
});
