// SPDX-License-Identifier: AGPL-3.0-only
// "כושר" — the data layer: the settings (which of the person's boards and columns play which role)
// reading boards and items through the extension's token, and every write going through a queue kept in IndexedDB,
// so a set ticked without a network is sent, in order, once the network is back.
//
// Nothing here knows a board, a column or a label by name: the settings map roles to the account's own boards and
// columns. `guessSettings` only proposes a starting map (by links between boards, column types and common words in
// titles) that the person confirms or changes in the settings screen.

/** Today as YYYY-MM-DD in the person's own time zone. */
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- cells

/** A number from a cell (numbers, mirror, formula …): its value when numeric, else its text. */
export const num = (item, col) => {
  if (!item || !col) return null;
  const c = item.cells?.[col];
  if (!c) return null;
  if (typeof c.value === 'number' && Number.isFinite(c.value)) return c.value;
  if (c.value && typeof c.value === 'object' && typeof c.value.rating === 'number') return c.value.rating;
  const t = typeof c.text === 'string' ? c.text.replace(/[^\d.,-]/g, '').replace(',', '.') : '';
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
};
export const text = (item, col) => (item && col ? (item.cells?.[col]?.text ?? '') : '');
export const linked = (item, col) => {
  const v = item?.cells?.[col]?.value;
  return v && Array.isArray(v.item_ids) ? v.item_ids : [];
};
export const people = (item, col) => {
  const v = item?.cells?.[col]?.value;
  return v && Array.isArray(v.persons_and_teams) ? v.persons_and_teams.map((p) => p.id) : [];
};
export const dateOf = (item, col) => {
  const v = item?.cells?.[col]?.value;
  return v && typeof v.date === 'string' ? v.date.slice(0, 10) : '';
};
export const statusLabel = (board, colId, item) => {
  const col = board?.columns?.find((c) => c.id === colId);
  const idx = item?.cells?.[colId]?.value?.index;
  return col?.settings?.labels?.find((l) => l.id === idx)?.label ?? '';
};
export const linkUrl = (item, col) => {
  const v = item?.cells?.[col]?.value;
  const url = v && typeof v.url === 'string' ? v.url : '';
  return /^https?:\/\//i.test(url) ? url : '';
};

// ---------------------------------------------------------------- settings

/** The roles of the settings, with the column types each may be. */
export const ROLES = {
  train: {
    templates: { kind: 'board', label: 'לוח האימונים (תבניות)' },
    step: {
      kind: 'cols',
      on: 'templates.sub',
      label: 'עמודות התרגיל באימון (תתי-פריטים)',
      cols: {
        ex: { types: ['board_relation'], label: 'תרגיל', words: ['תרגיל', 'exercise'] },
        order: { types: ['numbers'], label: 'סדר', words: ['סדר', 'order'] },
        sets: { types: ['numbers'], label: 'סטים', words: ['סטים', 'sets'] },
        reps: { types: ['numbers'], label: 'חזרות', words: ['חזרות', 'reps'] },
        kg: { types: ['numbers'], label: 'משקל', words: ['משקל', 'ק״ג', 'kg', 'weight'] },
        rest: { types: ['numbers'], label: 'מנוחה (שניות)', words: ['מנוחה', 'rest'] },
        cue: { types: ['long_text', 'text'], label: 'הערה', words: ['טמפו', 'הערה', 'note', 'tempo'] },
      },
    },
    library: { kind: 'board', label: 'ספריית התרגילים' },
    lib: {
      kind: 'cols',
      on: 'library',
      label: 'עמודות בספרייה',
      cols: {
        kind: { types: ['status', 'dropdown'], label: 'סוג', words: ['סוג', 'kind', 'type'] },
        equip: { types: ['dropdown', 'status'], label: 'ציוד', words: ['ציוד', 'equipment'] },
        cues: { types: ['long_text', 'text'], label: 'דגשי ביצוע', words: ['דגש', 'cue', 'ביצוע'] },
        video: { types: ['link'], label: 'סרטון', words: ['סרטון', 'video'] },
        pr: { types: ['mirror', 'numbers', 'formula'], label: 'שיא משקל', words: ['שיא משקל', 'שיא', 'record', 'pr'] },
      },
    },
    log: { kind: 'board', label: 'יומן האימונים' },
    logc: {
      kind: 'cols',
      on: 'log',
      label: 'עמודות ביומן',
      cols: {
        date: { types: ['date'], label: 'תאריך', words: ['תאריך', 'date'] },
        workout: { types: ['board_relation'], label: 'אימון', words: ['אימון', 'workout'], links: 'templates' },
        program: { types: ['board_relation'], label: 'תוכנית', words: ['תוכנית', 'program'], links: 'programs' },
        trainee: { types: ['people'], label: 'מתאמן', words: ['מתאמן', 'trainee', 'אחראי'] },
        state: { types: ['status'], label: 'סטטוס ביצוע', words: ['ביצוע', 'סטטוס', 'status'] },
        minutes: { types: ['numbers'], label: 'משך (דקות)', words: ['משך', 'duration', 'דק'] },
        rpe: { types: ['rating', 'numbers'], label: 'קושי (RPE)', words: ['rpe', 'קושי'] },
        notes: { types: ['long_text', 'text'], label: 'איך היה', words: ['איך', 'הערות', 'notes'] },
      },
    },
    setc: {
      kind: 'cols',
      on: 'log.sub',
      label: 'עמודות הסט ביומן (תתי-פריטים)',
      cols: {
        ex: { types: ['board_relation'], label: 'תרגיל', words: ['תרגיל', 'exercise'] },
        set: { types: ['numbers'], label: 'מספר סט', words: ['סט', 'set'] },
        reps: { types: ['numbers'], label: 'חזרות', words: ['חזרות', 'reps'] },
        kg: { types: ['numbers'], label: 'משקל', words: ['משקל', 'ק״ג', 'kg', 'weight'] },
        rpe: { types: ['numbers', 'rating'], label: 'RPE', words: ['rpe', 'קושי'] },
      },
    },
    programs: { kind: 'board', label: 'תוכניות האימון' },
    prog: {
      kind: 'cols',
      on: 'programs',
      label: 'עמודות התוכנית',
      cols: {
        trainee: { types: ['people'], label: 'מתאמן', words: ['מתאמן', 'trainee'] },
        status: { types: ['status'], label: 'סטטוס', words: ['סטטוס', 'status'] },
        goal: { types: ['dropdown', 'status'], label: 'מטרה', words: ['מטרה', 'goal'] },
        period: { types: ['timeline'], label: 'תקופה', words: ['תקופה', 'period'] },
        days: { types: ['numbers'], label: 'אימונים בשבוע', words: ['בשבוע', 'per week', 'days'] },
        workouts: { types: ['board_relation'], label: 'אימונים', words: ['אימונים', 'workouts'], links: 'templates' },
      },
    },
    metrics: { kind: 'board', label: 'מדדי גוף', optional: true },
    met: {
      kind: 'cols',
      on: 'metrics',
      label: 'עמודות המדדים',
      cols: {
        date: { types: ['date'], label: 'תאריך', words: ['תאריך', 'date'] },
        kg: { types: ['numbers'], label: 'משקל', words: ['משקל', 'weight', 'ק״ג'] },
        fat: { types: ['numbers'], label: 'אחוז שומן', words: ['שומן', 'fat'] },
      },
    },
  },
  food: {
    foods: { kind: 'board', label: 'מאגר המזונות', optional: true },
    f: {
      kind: 'cols',
      on: 'foods',
      label: 'ערכים ל-100 גרם',
      cols: {
        kcal: { types: ['numbers'], label: 'קלוריות', words: ['קלוריות ל-100', 'קלוריות', 'kcal', 'calories'] },
        prot: { types: ['numbers'], label: 'חלבון', words: ['חלבון', 'protein'] },
        carb: { types: ['numbers'], label: 'פחמימה', words: ['פחמימה', 'carb'] },
        fat: { types: ['numbers'], label: 'שומן', words: ['שומן', 'fat'] },
        portion: { types: ['numbers'], label: 'מנה רגילה (גרם)', words: ['מנה', 'portion'] },
      },
    },
    menu: { kind: 'board', label: 'תפריט (ארוחות)', optional: true },
    mealc: {
      kind: 'cols',
      on: 'menu',
      label: 'עמודות הארוחה',
      cols: { time: { types: ['hour', 'text'], label: 'שעה', words: ['שעה', 'time'] } },
    },
    msub: {
      kind: 'cols',
      on: 'menu.sub',
      label: 'עמודות המזון בארוחה',
      cols: {
        food: { types: ['board_relation'], label: 'מזון', words: ['מזון', 'food'] },
        g: { types: ['numbers'], label: 'כמות (גרם)', words: ['כמות', 'גרם', 'grams', 'g'] },
      },
    },
    flog: { kind: 'board', label: 'יומן התזונה', optional: true },
    flogc: {
      kind: 'cols',
      on: 'flog',
      label: 'עמודות יומן התזונה',
      cols: {
        date: { types: ['date'], label: 'תאריך', words: ['תאריך', 'date'] },
        trainee: { types: ['people'], label: 'מתאמן', words: ['מתאמן', 'trainee'] },
        train: { types: ['checkbox'], label: 'יום אימון', words: ['אימון', 'training'] },
      },
    },
    fsub: {
      kind: 'cols',
      on: 'flog.sub',
      label: 'עמודות המזון ביומן',
      cols: {
        food: { types: ['board_relation'], label: 'מזון', words: ['מזון', 'food'] },
        g: { types: ['numbers'], label: 'כמות (גרם)', words: ['כמות', 'גרם', 'grams', 'g'] },
      },
    },
    targets: { kind: 'board', label: 'יעדים', optional: true },
    tgt: {
      kind: 'cols',
      on: 'targets',
      label: 'עמודות היעד',
      cols: {
        kcal: { types: ['numbers', 'formula', 'mirror'], label: 'יעד קלורי', words: ['יעד קלורי', 'target', 'קלורי'] },
        prot: { types: ['numbers', 'formula', 'mirror'], label: 'יעד חלבון', words: ['יעד חלבון', 'protein'] },
        carb: { types: ['numbers', 'formula', 'mirror'], label: 'יעד פחמימה', words: ['יעד פחמימה', 'carb'] },
        fat: { types: ['numbers', 'formula', 'mirror'], label: 'יעד שומן', words: ['יעד שומן', 'fat'] },
        trainee: { types: ['people'], label: 'מתאמן', words: ['מתאמן', 'trainee'] },
      },
    },
  },
};

/** The board a `cols` role sits on (`log.sub` = the log's subitems board). */
export const roleBoardId = (cfg, boards, part, on) => {
  const [key, sub] = on.split('.');
  const id = cfg[part]?.[key];
  if (!id) return null;
  return sub ? (boards.get(id)?.subitems_board_id ?? null) : id;
};

const norm = (s) => String(s ?? '').toLowerCase();
const pickCol = (board, spec, taken, linkTo) => {
  const cols = (board?.columns ?? []).filter((c) => spec.types.includes(c.type) && !taken.has(c.id));
  const byLink = linkTo ? cols.find((c) => (c.settings?.board_ids ?? []).includes(linkTo)) : null;
  if (byLink) return byLink.id;
  for (const w of spec.words) {
    const hit = cols.find((c) => norm(c.title).includes(norm(w)));
    if (hit) return hit.id;
  }
  return spec.types.includes('board_relation') || spec.types.includes('people') || spec.types.includes('date')
    ? (cols[0]?.id ?? null)
    : null;
};
const relTargets = (board) =>
  (board?.columns ?? []).filter((c) => c.type === 'board_relation').flatMap((c) => c.settings?.board_ids ?? []);
const titled = (list, words) => list.find((b) => words.some((w) => norm(b.name).includes(norm(w))));

/**
 * A first proposal: the view's board is the workouts; its subitems link to the library; the log is the board that
 * links to the workouts and has a date; the programs link to the workouts too; the nutrition boards follow the same
 * shape (meals → foods). The person confirms it in the settings screen.
 */
export const guessSettings = (homeId, boards) => {
  const list = [...boards.values()].filter((b) => !b.parent_board_id);
  const home = boards.get(homeId);
  const cfg = { v: 1, train: { templates: homeId }, food: {}, coach: { enabled: true } };
  const homeSub = home?.subitems_board_id ? boards.get(home.subitems_board_id) : null;
  cfg.train.library = relTargets(homeSub).find((id) => id !== homeId) ?? null;
  const linkers = list.filter((b) => b.id !== homeId && relTargets(b).includes(homeId));
  const hasDate = (b) => (b.columns ?? []).some((c) => c.type === 'date');
  cfg.train.log = linkers.find((b) => hasDate(b) && b.subitems_board_id)?.id ?? null;
  cfg.train.programs =
    linkers.find((b) => b.id !== cfg.train.log && (b.columns ?? []).some((c) => c.type === 'people'))?.id ??
    relTargets(home).find((id) => id !== cfg.train.log && id !== cfg.train.library) ??
    null;
  cfg.train.metrics = titled(list, ['מדד', 'metric', 'body', 'שקיל'])?.id ?? null;
  // Nutrition: a board with subitems that link to a board with numbers per 100 g.
  const isFoods = (b) => (b?.columns ?? []).filter((c) => c.type === 'numbers').length >= 4;
  const mealBoards = list.filter((b) => {
    const sub = b.subitems_board_id ? boards.get(b.subitems_board_id) : null;
    return sub && relTargets(sub).some((id) => isFoods(boards.get(id)));
  });
  const foodsId = mealBoards
    .map((b) => relTargets(boards.get(b.subitems_board_id)).find((id) => isFoods(boards.get(id))))
    .find(Boolean);
  cfg.food.foods = foodsId ?? null;
  cfg.food.flog = mealBoards.find(hasDate)?.id ?? null;
  cfg.food.menu = mealBoards.find((b) => b.id !== cfg.food.flog)?.id ?? null;
  cfg.food.targets =
    list.find((b) => (b.columns ?? []).filter((c) => c.type === 'formula').length >= 3 && b.id !== cfg.food.foods)
      ?.id ?? null;
  // Columns per role.
  for (const part of ['train', 'food']) {
    for (const [key, role] of Object.entries(ROLES[part])) {
      if (role.kind !== 'cols') continue;
      const bid = roleBoardId(cfg, boards, part, role.on);
      const board = bid ? boards.get(bid) : null;
      const taken = new Set();
      cfg[part][key] = {};
      for (const [ck, spec] of Object.entries(role.cols)) {
        const linkTo = spec.links ? cfg[part][spec.links] : null;
        const id = board ? pickCol(board, spec, taken, linkTo) : null;
        if (id) taken.add(id);
        cfg[part][key][ck] = id;
      }
    }
  }
  // Status labels: "done" = the label marked done, "partial" / "active" by their words — the person can change them.
  const labelsOf = (boardId, colId) =>
    (boards.get(boardId)?.columns?.find((c) => c.id === colId)?.settings?.labels ?? []).filter(
      (l) => !l.is_deactivated,
    );
  const byWords = (labels, words) =>
    labels.find((l) => words.some((w) => norm(l.label).includes(norm(w))))?.label ?? null;
  const logLabels = labelsOf(cfg.train.log, cfg.train.logc?.state);
  cfg.train.done_label =
    logLabels.find((l) => l.is_done)?.label ?? byWords(logLabels, ['בוצע', 'done', 'הושלם']) ?? null;
  cfg.train.partial_label = byWords(logLabels, ['חלקי', 'partial']);
  cfg.train.active_label = byWords(labelsOf(cfg.train.programs, cfg.train.prog?.status), ['פעיל', 'active', 'בתהליך']);
  return cfg;
};

/** The boards the settings name (for the "boards this view uses" dialog). */
export const settingsBoards = (cfg) =>
  [
    cfg.train?.templates,
    cfg.train?.library,
    cfg.train?.log,
    cfg.train?.programs,
    cfg.train?.metrics,
    cfg.food?.foods,
    cfg.food?.menu,
    cfg.food?.flog,
    cfg.food?.targets,
  ].filter(Boolean);

// ---------------------------------------------------------------- reading

export const createStore = (bines) => {
  const boards = new Map();
  const items = new Map();
  const subs = new Map();
  const api = (method, path, body) => bines.api(method, path, body === undefined ? {} : { body });

  const loadBoard = async (id) => {
    if (!id) return null;
    if (boards.has(id)) return boards.get(id);
    try {
      const b = await api('GET', `/boards/${encodeURIComponent(id)}`);
      boards.set(id, b);
      if (b.subitems_board_id && !boards.has(b.subitems_board_id)) {
        try {
          boards.set(b.subitems_board_id, await api('GET', `/boards/${encodeURIComponent(b.subitems_board_id)}`));
        } catch {
          // no subitems yet
        }
      }
      return b;
    } catch {
      return null;
    }
  };
  const loadItems = async (id, force = false) => {
    if (!id) return [];
    if (!force && items.has(id)) return items.get(id);
    try {
      const res = await api('GET', `/boards/${encodeURIComponent(id)}/items`);
      const list = (res.data ?? []).filter((i) => !i.parent_item_id);
      items.set(id, list);
      return list;
    } catch {
      items.set(id, []);
      return [];
    }
  };
  /** Every subitem of a board (its subitems board's items), grouped by parent. */
  const loadSubs = async (boardId, force = false) => {
    const b = boards.get(boardId);
    const sid = b?.subitems_board_id;
    if (!sid) return new Map();
    if (!force && subs.has(sid)) return subs.get(sid);
    const by = new Map();
    try {
      const res = await api('GET', `/boards/${encodeURIComponent(sid)}/items`);
      for (const s of res.data ?? []) {
        if (!s.parent_item_id) continue;
        if (!by.has(s.parent_item_id)) by.set(s.parent_item_id, []);
        by.get(s.parent_item_id).push(s);
      }
    } catch {
      // none
    }
    subs.set(sid, by);
    return by;
  };
  return { boards, items, subs, api, loadBoard, loadItems, loadSubs };
};

// ---------------------------------------------------------------- the queue (offline)

const DB_NAME = 'bines-fitness';
const openDb = () =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('ops')) db.createObjectStore('ops', { keyPath: 'seq', autoIncrement: true });
      if (!db.objectStoreNames.contains('ids')) db.createObjectStore('ids', { keyPath: 'tmp' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
const tx = async (store, mode, fn) => {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => (out = v));
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
};
const all = (store) =>
  tx(store, 'readonly', (s) => new Promise((r) => (s.getAll().onsuccess = (e) => r(e.target.result))));

/**
 * Every write goes through here: kept in IndexedDB first, then sent in order. A write that creates an item can be
 * referenced by later ones before it exists (`tmp:<id>` in a path or an `item_ids`) — replaced by the real id when
 * it is sent. A network failure stops the run (tried again when the browser is online); an answer from the server
 * that refuses the write (4xx) drops that write and reports it.
 */
export const createQueue = ({ api, onChange, onError, accountKey }) => {
  let memory = null; // when IndexedDB is not available (private mode): a list in memory
  const ids = new Map();
  let running = false;
  const load = async () => {
    try {
      for (const r of await all('ids')) ids.set(r.tmp, r.id);
      return null;
    } catch {
      memory = [];
      return null;
    }
  };
  const ready = load();
  const list = async () => (memory ? memory : (await all('ops')).filter((o) => o.acct === accountKey));
  const swap = (v) => {
    if (typeof v === 'string') return v.replace(/tmp:[A-Za-z0-9]+/g, (m) => ids.get(m) ?? m);
    if (Array.isArray(v)) return v.map(swap);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)]));
    return v;
  };
  const remove = async (seq) => {
    if (memory) memory = memory.filter((o) => o.seq !== seq);
    else await tx('ops', 'readwrite', (s) => s.delete(seq));
  };
  /** Sends the writes in order until none is left — including those added while it runs. */
  let retryTimer = null;
  const flush = async () => {
    await ready;
    if (running || !navigator.onLine) return;
    running = true;
    let stalled = false;
    try {
      for (;;) {
        const op = (await list())[0];
        if (!op) break;
        let res;
        try {
          res = await api(op.method, swap(op.path), swap(op.body));
        } catch (err) {
          const status = err?.status ?? 0;
          if (!status || status >= 500 || status === 429) {
            stalled = true; // the network or the server: try again a little later
            break;
          }
          await remove(op.seq);
          onError?.(op, err);
          continue;
        }
        if (op.creates && res?.id) {
          ids.set(op.creates, res.id);
          if (!memory) await tx('ids', 'readwrite', (s) => s.put({ tmp: op.creates, id: res.id }));
        }
        await remove(op.seq);
        onChange?.(await size());
      }
    } finally {
      running = false;
      onChange?.(await size());
    }
    // A write added between the last read and the end of the run: go again.
    if (!stalled && navigator.onLine && (await size()) > 0) return flush();
    if (stalled && !retryTimer)
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void flush();
      }, 15_000);
  };
  const size = async () => (await list()).length;
  const push = async (op) => {
    await ready;
    const row = { ...op, acct: accountKey, at: Date.now() };
    if (memory) memory.push({ ...row, seq: Date.now() + Math.random() });
    else await tx('ops', 'readwrite', (s) => s.add(row));
    onChange?.(await size());
    void flush();
  };
  /** A temporary id for an item about to be created (usable in later writes before it exists). */
  const tmp = () => `tmp:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const real = (id) => (id && id.startsWith('tmp:') ? (ids.get(id) ?? null) : id);
  window.addEventListener('online', () => void flush());
  return { push, flush, size, tmp, real };
};
