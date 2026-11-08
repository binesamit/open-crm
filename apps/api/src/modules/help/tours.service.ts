// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type CreateTour,
  createTourSchema,
  helpAssetPath,
  helpSlugOf,
  type HelpLocale,
  type MyTour,
  type MyTours,
  newId,
  setTourAnchorSchema,
  type Tour,
  type TourState,
  type TourStep,
  tourStepSchema,
  type UpdateTour,
  updateTourSchema,
} from '@bines/shared';
import type { z } from 'zod';
import type { AppDeps } from '../../types';
import { getAccountSettings } from '../accounts/accounts.repo';
import type { StaffActor } from '../tickets/console.service';
import { helpAssetTypes } from './help.assets';
import { mayPublish, mayWrite } from './help.service';
import { loadHelpSettings } from './help.settings';
import {
  clearProgress,
  findTour,
  guideSlugsOf,
  insertTour,
  listTourRows,
  progressOf,
  setProgress,
  setTourPrefs,
  tourPrefsOf,
  tourSlugTaken,
  type TourRow,
  updateTourRow,
} from './tours.repo';

/**
 * Guided tours. The staff side — owner console → Support → Knowledge → Tours: the knowledge center's
 * writers write and save drafts, its publishers publish (the same roles as articles). The member side: the published
 * tours of their language, for their role, with what they did with each; the offers on a first visit can be turned
 * off by the person (profile) or for a whole account (its admins).
 */
type Deps = Pick<AppDeps, 'db'>;

const stepsOf = (raw: unknown): TourStep[] => {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((s) => {
    const p = tourStepSchema.safeParse(s);
    return p.success ? [p.data] : [];
  });
};

export const tourDto = (t: TourRow): Tour => ({
  id: t.id,
  locale: t.locale as HelpLocale,
  slug: t.slug,
  title: t.title,
  route: t.route as Tour['route'],
  audience: t.audience as Tour['audience'],
  start: t.start as Tour['start'],
  status: t.status as Tour['status'],
  position: t.position,
  steps: stepsOf(t.steps),
  updated_at: t.updatedAt.toISOString(),
});

const assertWrite = async (deps: Deps, s: StaffActor) => {
  if (!mayWrite(s, await loadHelpSettings(deps.db))) throw new AppError('forbidden', 'help_write_forbidden');
};
const assertPublish = async (deps: Deps, s: StaffActor) => {
  if (!mayPublish(s, await loadHelpSettings(deps.db))) throw new AppError('forbidden', 'help_publish_forbidden');
};

const mustTour = async (deps: Deps, id: string) => {
  const t = await findTour(deps.db, id);
  if (!t) throw new AppError('not_found', 'Tour not found');
  return t;
};

/**
 * Steps as stored: unique ids, and a clip / picture only when it is a stored help image or video (else it is dropped,
 * like an article's foreign image).
 */
export const cleanSteps = async (deps: Deps, steps: TourStep[]) => {
  const ids = new Set<string>();
  for (const s of steps) {
    if (ids.has(s.id)) throw new AppError('invalid_value', 'tour_step_duplicate');
    ids.add(s.id);
  }
  const types = await helpAssetTypes(
    deps.db,
    steps.map((s) => s.media_id),
  );
  const media = (id: string | null) => {
    const type = id ? types.get(id) : undefined;
    return type && type !== 'text/vtt' ? id : null;
  };
  return steps.map((s) => ({ ...s, media_id: media(s.media_id) }));
};

const freeSlug = async (deps: Deps, locale: string, base: string) => {
  for (let i = 1; i < 500; i++) {
    const slug = i === 1 ? base : `${base.slice(0, 110)}-${i}`;
    if (!(await tourSlugTaken(deps.db, locale, slug))) return slug;
  }
  return `${base.slice(0, 90)}-${newId().toLowerCase()}`;
};

// ---- staff (owner console) ----

export const listTours = async (deps: Deps, _s: StaffActor, f: { locale?: string } = {}) => ({
  data: (await listTourRows(deps.db, f)).map(tourDto),
});

export const getTour = async (deps: Deps, _s: StaffActor, id: string) => tourDto(await mustTour(deps, id));

/** POST /platform/support/help/tours — a draft, last in the list. */
export const createTour = async (deps: Deps, s: StaffActor, raw: CreateTour) => {
  await assertWrite(deps, s);
  const input = createTourSchema.parse(raw);
  const slug = input.slug
    ? input.slug.toLowerCase()
    : await freeSlug(deps, input.locale, helpSlugOf(input.title).toLowerCase());
  if (input.slug && (await tourSlugTaken(deps.db, input.locale, slug)))
    throw new AppError('slug_taken', 'help_slug_taken');
  const count = (await listTourRows(deps.db)).length;
  const row = await insertTour(deps.db, {
    id: newId(),
    locale: input.locale,
    slug,
    title: input.title,
    route: input.route,
    audience: input.audience,
    start: input.start,
    status: 'draft',
    position: count,
    steps: (await cleanSteps(deps, input.steps)) as unknown as Record<string, unknown>[],
    createdBy: s.user.id,
    updatedBy: s.user.id,
  });
  return tourDto(row);
};

/** PATCH — writers change it; publishing (or taking down) is the publishers'. */
export const updateTour = async (deps: Deps, s: StaffActor, id: string, raw: UpdateTour) => {
  await assertWrite(deps, s);
  const input = updateTourSchema.parse(raw);
  const t = await mustTour(deps, id);
  if (input.status !== undefined && input.status !== t.status) await assertPublish(deps, s);
  else if (t.status === 'published') await assertPublish(deps, s);
  const slug = input.slug?.toLowerCase();
  if (slug && slug !== t.slug && (await tourSlugTaken(deps.db, t.locale, slug, t.id)))
    throw new AppError('slug_taken', 'help_slug_taken');
  const steps = input.steps ? await cleanSteps(deps, input.steps) : undefined;
  const row = await updateTourRow(deps.db, t.id, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(slug ? { slug } : {}),
    ...(input.route ? { route: input.route } : {}),
    ...(input.audience ? { audience: input.audience } : {}),
    ...(input.start ? { start: input.start } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.position !== undefined ? { position: input.position } : {}),
    ...(steps ? { steps: steps as unknown as Record<string, unknown>[] } : {}),
    updatedBy: s.user.id,
  });
  return tourDto(row);
};

/** DELETE — soft (a published one only by a publisher); guides that linked it lose the link. */
export const deleteTour = async (deps: Deps, s: StaffActor, id: string) => {
  const t = await mustTour(deps, id);
  if (t.status === 'published') await assertPublish(deps, s);
  else await assertWrite(deps, s);
  await updateTourRow(deps.db, t.id, { deletedAt: new Date(), status: 'draft', updatedBy: s.user.id });
  return { ok: true as const };
};

/** POST …/anchor — the on-screen picker: the element the writer clicked becomes the step's anchor. */
export const setTourAnchor = async (
  deps: Deps,
  s: StaffActor,
  id: string,
  raw: z.input<typeof setTourAnchorSchema>,
) => {
  await assertWrite(deps, s);
  const input = setTourAnchorSchema.parse(raw);
  const t = await mustTour(deps, id);
  if (t.status === 'published') await assertPublish(deps, s);
  const steps = stepsOf(t.steps);
  const i = steps.findIndex((x) => x.id === input.step_id);
  if (i < 0) throw new AppError('not_found', 'tour_step_unknown');
  steps[i] = { ...steps[i]!, anchor: input.anchor };
  return tourDto(
    await updateTourRow(deps.db, t.id, {
      steps: steps as unknown as Record<string, unknown>[],
      updatedBy: s.user.id,
    }),
  );
};

// ---- members (inside an account) ----

export type TourReader = { userId: string; accountId: string; role: string; locale: HelpLocale };

/** Are tours on for this account: the knowledge center is on, and the account's admins did not turn them off. */
const toursOn = async (deps: Deps, accountId: string) => {
  const [help, settings] = await Promise.all([loadHelpSettings(deps.db), getAccountSettings(deps.db, accountId)]);
  const tours = (settings as { tours?: { enabled?: unknown } }).tours;
  return help.enabled && tours?.enabled !== false;
};

/** GET /support/tours — the published tours this person may take, in their language, with their progress. */
export const myTours = async (deps: Deps, r: TourReader): Promise<MyTours> => {
  const [enabled, prefs] = await Promise.all([toursOn(deps, r.accountId), tourPrefsOf(deps.db, r.userId)]);
  if (!enabled) return { enabled: false, offers: prefs.offers, tours: [] };
  let rows = await listTourRows(deps.db, { status: 'published', locale: r.locale });
  if (!rows.length) rows = await listTourRows(deps.db, { status: 'published' });
  rows = rows.filter((t) => t.audience !== 'admins' || r.role === 'admin');
  const [progress, guides] = await Promise.all([
    progressOf(deps.db, r.userId),
    guideSlugsOf(
      deps.db,
      rows.map((t) => t.id),
      r.locale,
    ),
  ]);
  const steps = rows.map((t) => stepsOf(t.steps));
  const types = await helpAssetTypes(
    deps.db,
    steps.flat().map((s) => s.media_id),
  );
  const tours: MyTour[] = rows.map((t, i) => ({
    id: t.id,
    title: t.title,
    route: t.route as MyTour['route'],
    start: t.start as MyTour['start'],
    position: t.position,
    steps: steps[i]!.map((s) => {
      const type = s.media_id ? (types.get(s.media_id) ?? null) : null;
      return { ...s, media: type ? helpAssetPath(s.media_id!) : null, media_type: type };
    }),
    state: (progress.get(t.id) as TourState | undefined) ?? null,
    guide_slug: guides.get(t.id) ?? null,
  }));
  return { enabled: true, offers: prefs.offers, tours };
};

/** PUT /support/tours/{id}/progress — finished / closed it; null forgets (the tour is offered again). */
export const setMyTourProgress = async (deps: Deps, r: TourReader, id: string, state: TourState | null) => {
  const t = await findTour(deps.db, id);
  if (!t || t.status !== 'published') throw new AppError('not_found', 'Tour not found');
  if (state) await setProgress(deps.db, r.userId, t.id, state);
  else await clearProgress(deps.db, r.userId, t.id);
  return { ok: true as const };
};

/** DELETE /support/tours/progress — "reset all tours": every tour is offered again. */
export const resetMyTours = async (deps: Deps, r: TourReader) => {
  await clearProgress(deps.db, r.userId);
  return { ok: true as const };
};

/** PUT /me/tour-prefs — the person's own "offer me tours" switch (every account, every device). */
export const setMyTourPrefs = async (deps: Deps, userId: string, prefs: { offers: boolean }) => {
  await setTourPrefs(deps.db, userId, prefs);
  return tourPrefsOf(deps.db, userId);
};
