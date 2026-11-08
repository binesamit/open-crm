// SPDX-License-Identifier: AGPL-3.0-only
// "כושר" — what the screens show, read from the person's boards through the settings (data.js): programs, workouts
// and their steps, the training log and its sets ("last time", records, the week), meals and foods with their
// macros, today's food log and the targets. Nothing here writes.
import { dateOf, linked, linkUrl, num, people, statusLabel, text, today } from './data.js';

const byOrder = (a, b) => (a.order ?? 999) - (b.order ?? 999);

/** The days of the current week (the locale's first day: Sunday in Hebrew, Monday in English), as YYYY-MM-DD. */
export const weekDays = (locale) => {
  const d = new Date();
  const first = locale === 'en' ? 1 : 0;
  const back = (d.getDay() - first + 7) % 7;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  });
};
export const daysAgo = (iso) => {
  if (!iso) return Infinity;
  const [y, m, d] = iso.split('-').map(Number);
  const then = new Date(y, m - 1, d);
  const now = new Date();
  return Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - then) / 86400000);
};

export const createModel = (store, cfg) => {
  const T = cfg.train ?? {};
  const F = cfg.food ?? {};
  const B = (id) => (id ? store.boards.get(id) : null);
  const I = (id) => (id ? (store.items.get(id) ?? []) : []);
  const S = (id) => {
    const sid = B(id)?.subitems_board_id;
    return sid ? (store.subs.get(sid) ?? new Map()) : new Map();
  };
  const itemOf = (boardId, id) => I(boardId).find((i) => i.id === id) ?? null;

  // ---------- training
  const library = () => I(T.library);
  const exercise = (id) => itemOf(T.library, id);
  const programs = () => I(T.programs);
  const programsOf = (uid) =>
    T.prog?.trainee ? programs().filter((p) => people(p, T.prog.trainee).includes(uid)) : programs();
  const isActive = (p) =>
    !T.prog?.status || !T.active_label ? true : statusLabel(B(T.programs), T.prog.status, p) === T.active_label;
  /** The program a trainee follows now: an active one, newest first; else their newest. */
  const activeProgram = (uid) => {
    const mine = programsOf(uid);
    return [...mine].reverse().find(isActive) ?? mine[mine.length - 1] ?? null;
  };
  const workouts = () => I(T.templates);
  const workoutsOf = (program) => {
    if (!program) return workouts();
    const ids = T.prog?.workouts ? linked(program, T.prog.workouts) : [];
    if (ids.length) return ids.map((id) => itemOf(T.templates, id)).filter(Boolean);
    // The other side: workouts that link to the program.
    const back = (B(T.templates)?.columns ?? []).find(
      (c) => c.type === 'board_relation' && (c.settings?.board_ids ?? []).includes(T.programs),
    );
    const list = back ? workouts().filter((w) => linked(w, back.id).includes(program.id)) : [];
    return list.length ? list : workouts();
  };
  const steps = (workoutId) => {
    const st = T.step ?? {};
    return (S(T.templates).get(workoutId) ?? [])
      .map((s) => {
        const exId = st.ex ? linked(s, st.ex)[0] : null;
        const ex = exId ? exercise(exId) : null;
        return {
          id: s.id,
          exId,
          name: ex?.name ?? s.name,
          order: num(s, st.order),
          sets: Math.max(1, Math.round(num(s, st.sets) ?? 1)),
          reps: num(s, st.reps),
          kg: num(s, st.kg),
          rest: Math.max(0, Math.round(num(s, st.rest) ?? 0)),
          cue: text(s, st.cue),
        };
      })
      .sort(byOrder);
  };
  const exInfo = (exId, name) => {
    const ex = exId ? exercise(exId) : null;
    const L = T.lib ?? {};
    const kind = [text(ex, L.kind), text(ex, L.equip)].filter(Boolean).join(' · ');
    return { name: ex?.name ?? name, kind, cues: text(ex, L.cues), video: linkUrl(ex, L.video), prLib: num(ex, L.pr) };
  };

  // the log
  const logs = () => I(T.log);
  const logsOf = (uid) => {
    const L = T.logc ?? {};
    if (L.trainee) return logs().filter((l) => people(l, L.trainee).includes(uid));
    const mine = new Set(programsOf(uid).map((p) => p.id));
    return L.program && T.prog?.trainee
      ? logs().filter((l) => linked(l, L.program).some((id) => mine.has(id)))
      : logs();
  };
  const logDate = (l) => dateOf(l, T.logc?.date) || (l.created_at ?? '').slice(0, 10);
  const setsOf = (logId) => {
    const C = T.setc ?? {};
    return (S(T.log).get(logId) ?? []).map((s) => ({
      id: s.id,
      exId: C.ex ? linked(s, C.ex)[0] : null,
      name: s.name,
      set: num(s, C.set),
      reps: num(s, C.reps),
      kg: num(s, C.kg),
      rpe: num(s, C.rpe),
    }));
  };
  /** "Last time" of an exercise for this trainee: the sets of the newest log that has it. */
  const lastTime = (uid, exId, name) => {
    const sorted = [...logsOf(uid)].sort((a, b) => (logDate(b) < logDate(a) ? -1 : 1));
    for (const l of sorted) {
      const sets = setsOf(l.id).filter((s) => (exId ? s.exId === exId : s.name === name));
      if (sets.length) return { date: logDate(l), sets };
    }
    return null;
  };
  /** The best weight of an exercise: the library's column when set, else the heaviest set in the log. */
  const record = (uid, exId, name) => {
    const lib = exInfo(exId, name).prLib;
    let best = null;
    for (const l of logsOf(uid))
      for (const s of setsOf(l.id))
        if ((exId ? s.exId === exId : s.name === name) && s.kg && (!best || s.kg > best.kg)) best = s;
    return { kg: lib ?? best?.kg ?? null, reps: best?.reps ?? null };
  };
  /** Records worth showing on the home screen: the exercises of the newest logs, heaviest set each. */
  const recentRecords = (uid, max = 4) => {
    const seen = new Map();
    const sorted = [...logsOf(uid)].sort((a, b) => (logDate(b) < logDate(a) ? -1 : 1));
    for (const l of sorted)
      for (const s of setsOf(l.id)) {
        if (!s.kg) continue;
        const key = s.exId ?? s.name;
        const cur = seen.get(key);
        if (!cur || s.kg > cur.kg) seen.set(key, { ...s, name: exInfo(s.exId, s.name).name, date: logDate(l) });
      }
    return [...seen.values()].slice(0, max);
  };
  const doneLabel = () => T.done_label ?? '';
  const isDoneLog = (l) =>
    !T.logc?.state || !T.done_label ? true : statusLabel(B(T.log), T.logc.state, l) === T.done_label;
  /** The week: per day — done (a finished log), today, a past day without one (rest), or a coming day. */
  const week = (uid, locale) => {
    const days = weekDays(locale);
    const t = today();
    const byDay = new Map();
    for (const l of logsOf(uid)) if (isDoneLog(l)) byDay.set(logDate(l), l);
    return days.map((d) => {
      const l = byDay.get(d);
      const w = l && T.logc?.workout ? itemOf(T.templates, linked(l, T.logc.workout)[0]) : null;
      const short = w ? shortName(w.name) : l ? '✓' : '';
      return { date: d, state: l ? 'done' : d === t ? 'today' : d < t ? 'rest' : 'coming', label: short };
    });
  };
  /** The workout after the last one done in this program (the first when none). */
  const nextWorkout = (uid, program) => {
    const list = workoutsOf(program);
    if (!list.length) return null;
    const L = T.logc ?? {};
    const sorted = [...logsOf(uid)].sort((a, b) => (logDate(b) < logDate(a) ? -1 : 1));
    const last = L.workout
      ? sorted.map((l) => linked(l, L.workout)[0]).find((id) => list.some((w) => w.id === id))
      : null;
    const at = last ? list.findIndex((w) => w.id === last) : -1;
    return list[(at + 1) % list.length];
  };
  const minutesOf = (workoutId) => {
    const st = steps(workoutId);
    const secs = st.reduce((n, s) => n + s.sets * (45 + s.rest), 0);
    return Math.max(10, Math.round(secs / 60 / 5) * 5);
  };

  // ---------- nutrition
  const FC = F.f ?? {};
  const food = (id) => itemOf(F.foods, id);
  const foods = () => I(F.foods);
  const per100 = (id) => {
    const f = food(id);
    return {
      kcal: num(f, FC.kcal) ?? 0,
      prot: num(f, FC.prot) ?? 0,
      carb: num(f, FC.carb) ?? 0,
      fat: num(f, FC.fat) ?? 0,
      portion: num(f, FC.portion) ?? 100,
    };
  };
  const macro = (id, g) => {
    const p = per100(id);
    const k = (g || 0) / 100;
    return {
      kcal: Math.round(p.kcal * k),
      prot: Math.round(p.prot * k * 10) / 10,
      carb: Math.round(p.carb * k * 10) / 10,
      fat: Math.round(p.fat * k * 10) / 10,
    };
  };
  const sum = (list) =>
    list.reduce(
      (a, m) => ({ kcal: a.kcal + m.kcal, prot: a.prot + m.prot, carb: a.carb + m.carb, fat: a.fat + m.fat }),
      { kcal: 0, prot: 0, carb: 0, fat: 0 },
    );
  const menuGroups = () => B(F.menu)?.groups ?? [];
  /** Meals of a menu group, by time: [{id, name, time, foods: [{foodId, name, g}]}]. */
  const meals = (groupId) => {
    const M = F.msub ?? {};
    return I(F.menu)
      .filter((m) => !groupId || m.group_id === groupId)
      .map((m) => ({
        id: m.id,
        name: m.name,
        time: text(m, F.mealc?.time),
        foods: (S(F.menu).get(m.id) ?? []).map((s) => {
          const foodId = M.food ? linked(s, M.food)[0] : null;
          return { foodId, name: food(foodId)?.name ?? s.name, g: num(s, M.g) ?? per100(foodId).portion };
        }),
      }))
      .sort((a, b) => ((a.time || '99') < (b.time || '99') ? -1 : 1));
  };
  const dayLogs = (uid) => {
    const C = F.flogc ?? {};
    return C.trainee ? I(F.flog).filter((d) => people(d, C.trainee).includes(uid)) : I(F.flog);
  };
  const dayOf = (uid, date = today()) => dayLogs(uid).find((d) => dateOf(d, F.flogc?.date) === date) ?? null;
  const eatenOf = (dayId) => {
    const C = F.fsub ?? {};
    return (S(F.flog).get(dayId) ?? []).map((s) => {
      const foodId = C.food ? linked(s, C.food)[0] : null;
      return { id: s.id, name: s.name, foodId, g: num(s, C.g) ?? 0 };
    });
  };
  const target = (uid) => {
    const C = F.tgt ?? {};
    const list = I(F.targets);
    const mine = C.trainee ? list.filter((t) => people(t, C.trainee).includes(uid)) : list;
    const t = mine[0] ?? null;
    return t
      ? { kcal: num(t, C.kcal), prot: num(t, C.prot), carb: num(t, C.carb), fat: num(t, C.fat), name: t.name }
      : null;
  };
  /** The last days' food against the target: average calories / protein and the days within 10 % of the target. */
  const foodWeek = (uid, days = 7) => {
    const t = target(uid);
    const recent = dayLogs(uid).filter((d) => daysAgo(dateOf(d, F.flogc?.date)) < days);
    const per = recent.map((d) => sum(eatenOf(d.id).map((e) => macro(e.foodId, e.g))));
    const avg = (k) => (per.length ? per.reduce((n, x) => n + x[k], 0) / per.length : null);
    const inTarget = t?.kcal ? per.filter((x) => Math.abs(x.kcal - t.kcal) <= t.kcal * 0.1).length : null;
    return { days: per.length, kcal: avg('kcal'), prot: avg('prot'), inTarget };
  };

  // ---------- body metrics
  const metrics = () => {
    const M = T.met ?? {};
    const list = [...I(T.metrics)].sort((a, b) => (dateOf(a, M.date) < dateOf(b, M.date) ? -1 : 1));
    if (!list.length) return null;
    const last = list[list.length - 1];
    const month = list.filter((m) => daysAgo(dateOf(m, M.date)) <= 31);
    const first = month[0] ?? last;
    const d = (k) =>
      num(last, M[k]) !== null && num(first, M[k]) !== null ? num(last, M[k]) - num(first, M[k]) : null;
    return { kg: num(last, M.kg), fat: num(last, M.fat), dkg: d('kg'), dfat: d('fat') };
  };

  return {
    T,
    F,
    B,
    I,
    library,
    exercise,
    programs,
    programsOf,
    activeProgram,
    workouts,
    workoutsOf,
    steps,
    exInfo,
    logsOf,
    logDate,
    setsOf,
    lastTime,
    record,
    recentRecords,
    doneLabel,
    isDoneLog,
    week,
    nextWorkout,
    minutesOf,
    foods,
    food,
    per100,
    macro,
    sum,
    menuGroups,
    meals,
    dayOf,
    eatenOf,
    target,
    foodWeek,
    metrics,
  };
};

/** "בלוק 2 · אימון A" → "A"; "יום 1 · חזה, כתפיים" → "יום 1": the most telling short part for a week square. */
export const shortName = (name) => {
  const parts = String(name ?? '')
    .replace(/\([^)]*\)/g, '')
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of [...parts].reverse()) {
    if (p.length <= 6) return p;
    const last = p.split(/\s+/).pop() ?? '';
    if (last.length <= 2) return last;
  }
  return (parts[0] ?? '').slice(0, 6);
};
