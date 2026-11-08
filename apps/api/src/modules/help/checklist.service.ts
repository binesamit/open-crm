// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ChecklistEvent,
  type ChecklistSettings,
  type ChecklistState,
  type ChecklistStep,
  type ClientChecklistEvent,
  CLIENT_CHECKLIST_EVENTS,
  DEFAULT_CHECKLIST,
  defaultChecklistTourSlug,
  type HelpLocale,
} from '@bines/shared';
import type { AppDeps } from '../../types';
import { getAccountSettings } from '../accounts/accounts.repo';
import { st } from '../../lib/i18n';
import { checklistPrefsOf, didEvent, joinedAt, setChecklistPrefs } from './checklist.repo';
import { loadHelpSettings } from './help.settings';
import { findTourBySlug } from './tours.repo';

/**
 * "First steps" (canvas screen 3): each person's checklist in an account — the owner's steps (or
 * the built-in ones, in the reader's language), each done once the person really did it, with its "show me" tour.
 */
type Deps = Pick<AppDeps, 'db'>;
export type ChecklistReader = { userId: string; accountId: string; role: string; locale: HelpLocale; support: boolean };

const DAY = 86_400_000;
const isClientEvent = (e: ChecklistEvent): e is ClientChecklistEvent =>
  (CLIENT_CHECKLIST_EVENTS as readonly string[]).includes(e);

/** The steps in force: the owner's, else the built-in ones with their texts in this language. */
export const checklistSteps = (settings: ChecklistSettings, locale: HelpLocale): ChecklistStep[] =>
  settings.steps ??
  DEFAULT_CHECKLIST.map((d) => ({
    id: d.id,
    event: d.event,
    title: st(`checklist.default.${d.id}.title`, undefined, locale),
    description: st(`checklist.default.${d.id}.description`, undefined, locale),
    tour_slug: defaultChecklistTourSlug(d.id),
    audience: d.audience,
    enabled: true,
  }));

/** The platform's switch, the account's switch, and never for guests or a support visit. */
const availableFor = async (deps: Deps, r: ChecklistReader) => {
  const help = await loadHelpSettings(deps.db);
  if (!help.first_steps.enabled || r.role === 'guest' || r.support) return { help, on: false };
  const account = (await getAccountSettings(deps.db, r.accountId)) as { tours?: { first_steps?: unknown } };
  return { help, on: account.tours?.first_steps !== false };
};

const NONE: ChecklistState = {
  available: false,
  open: false,
  dismissed: false,
  collapsed: true,
  completed: false,
  steps: [],
};

/** GET /me/first-steps — the person's checklist here; steps found done are kept (never looked up again). */
export const myChecklist = async (deps: Deps, r: ChecklistReader): Promise<ChecklistState> => {
  const { help, on } = await availableFor(deps, r);
  if (!on) return NONE;
  const steps = checklistSteps(help.first_steps, r.locale).filter(
    (s) => s.enabled && (s.audience === 'all' || r.role === 'admin'),
  );
  const prefs = await checklistPrefsOf(deps.db, r.userId, r.accountId);
  const done = new Set(prefs.done ?? []);
  const before = done.size;
  for (const s of steps) {
    if (done.has(s.id)) continue;
    const yes =
      s.event === 'joined' ||
      (isClientEvent(s.event) ? !!prefs.marks?.[s.event] : await didEvent(deps.db, r.accountId, r.userId, s.event));
    if (yes) done.add(s.id);
  }
  const completed = steps.length > 0 && steps.every((s) => done.has(s.id));
  if (done.size !== before || (completed && !prefs.completed_at))
    await setChecklistPrefs(deps.db, r.userId, r.accountId, {
      ...prefs,
      done: [...done],
      completed_at: completed ? (prefs.completed_at ?? new Date().toISOString()) : null,
    });
  const tourIds = new Map<string, string | null>();
  for (const s of steps) {
    if (!s.tour_slug || tourIds.has(s.tour_slug)) continue;
    const tour =
      (await findTourBySlug(deps.db, r.locale, s.tour_slug)) ??
      (await findTourBySlug(deps.db, r.locale === 'he' ? 'en' : 'he', s.tour_slug));
    const usable = tour && tour.status === 'published' && (tour.audience !== 'admins' || r.role === 'admin');
    tourIds.set(s.tour_slug, usable ? tour.id : null);
  }
  const joined = await joinedAt(deps.db, r.accountId, r.userId);
  const recent = !!joined && Date.now() - joined.getTime() <= help.first_steps.auto_days * DAY;
  return {
    available: true,
    open: recent && !prefs.dismissed && !completed,
    dismissed: !!prefs.dismissed,
    collapsed: !!prefs.collapsed,
    completed,
    steps: steps.map((s) => ({
      id: s.id,
      event: s.event,
      title: s.title,
      description: s.description,
      done: done.has(s.id),
      tour_id: s.tour_slug ? (tourIds.get(s.tour_slug) ?? null) : null,
    })),
  };
};

/** POST /me/first-steps/mark — the app reports what leaves no trace in the log (a board opened, a view switched). */
export const markChecklist = async (deps: Deps, r: ChecklistReader, event: ClientChecklistEvent) => {
  const prefs = await checklistPrefsOf(deps.db, r.userId, r.accountId);
  await setChecklistPrefs(deps.db, r.userId, r.accountId, {
    ...prefs,
    marks: { ...prefs.marks, [event]: new Date().toISOString() },
  });
  return { ok: true as const };
};

/** POST /me/first-steps/dismiss — closed (or opened again from the "?" menu). */
export const dismissChecklist = async (
  deps: Deps,
  r: ChecklistReader,
  change: { dismissed?: boolean; collapsed?: boolean },
) => {
  const prefs = await checklistPrefsOf(deps.db, r.userId, r.accountId);
  await setChecklistPrefs(deps.db, r.userId, r.accountId, {
    ...prefs,
    ...(change.dismissed !== undefined ? { dismissed: change.dismissed } : {}),
    ...(change.collapsed !== undefined ? { collapsed: change.collapsed } : {}),
  });
  return { ok: true as const };
};

/** GET /me/first-steps/seen — a tour step waiting for an action: did the person do it since the step opened? */
export const checklistSeen = async (deps: Deps, r: ChecklistReader, event: ChecklistEvent, since: Date) => {
  if (event === 'joined') return { seen: true };
  if (isClientEvent(event)) {
    const at = (await checklistPrefsOf(deps.db, r.userId, r.accountId)).marks?.[event];
    return { seen: !!at && new Date(at) > since };
  }
  return { seen: await didEvent(deps.db, r.accountId, r.userId, event, since) };
};
