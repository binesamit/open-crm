// SPDX-License-Identifier: AGPL-3.0-only
import { CHECKLIST_EVENTS } from './checklist';
import { z } from 'zod';
import { HELP_LOCALES, HELP_ROUTE_KEYS, type HelpRouteKey } from './help';

/**
 * Guided tours: short step-by-step walks over the app's own screens — the screen dims, one element
 * at a time is lit with a bubble ("2 of 5", a sentence, an optional clip). Tours are content the platform owner
 * writes in the owner console (Support → Knowledge → Tours), never code: each names its screen, who it is for, its
 * language and how it starts. A step points at an element by its `data-tour` mark, picked on the screen itself.
 * Whoever saw a tour can run it again from the "?" menu; progress is kept per person on the server.
 */

/** Who a tour is for: every member (never guests), or the account's admins only. */
export const TOUR_AUDIENCES = ['all', 'admins'] as const;
export type TourAudience = (typeof TOUR_AUDIENCES)[number];

/** How a tour starts on the first visit to its screen: a small offer card, by itself, or only from the "?" menu. */
export const TOUR_STARTS = ['offer', 'auto', 'menu'] as const;
export type TourStart = (typeof TOUR_STARTS)[number];

export const TOUR_STATUSES = ['draft', 'published'] as const;
export type TourStatus = (typeof TOUR_STATUSES)[number];

/** What a person did with a tour: finished it, or closed it / said "not now". */
export const TOUR_STATES = ['done', 'dismissed'] as const;
export type TourState = (typeof TOUR_STATES)[number];

/** A `data-tour` mark: letters, digits, dots and dashes (`board.new-item`). */
export const TOUR_ANCHOR_RE = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*$/;

export const tourStepSchema = z.object({
  /** Stable within the tour (the editor's list key and the on-screen picker's target). */
  id: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[\w-]+$/),
  /** The element the step points at (`data-tour` mark); null = a bubble in the middle of the screen. */
  anchor: z.string().trim().max(80).regex(TOUR_ANCHOR_RE).nullable().default(null),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().max(600).default(''),
  /** An optional short clip or picture in the bubble (a help file: image, GIF or video). */
  media_id: z.string().nullable().default(null),
  /** Wait for a click on the element instead of "next". */
  wait_click: z.boolean().default(false),
  /** Wait until the person really does this ("creates an item"), then go on by itself. */
  wait_event: z.enum(CHECKLIST_EVENTS).nullable().default(null),
});
export type TourStep = z.infer<typeof tourStepSchema>;
export type TourStepInput = z.input<typeof tourStepSchema>;

const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u, 'invalid_slug');

export const tourSchema = z
  .object({
    id: z.string(),
    locale: z.enum(HELP_LOCALES),
    slug: z.string(),
    title: z.string(),
    route: z.enum(HELP_ROUTE_KEYS),
    audience: z.enum(TOUR_AUDIENCES),
    start: z.enum(TOUR_STARTS),
    status: z.enum(TOUR_STATUSES),
    position: z.number().int(),
    steps: z.array(tourStepSchema),
    updated_at: z.string(),
  })
  .meta({ id: 'Tour' });
export type Tour = z.infer<typeof tourSchema>;

export const createTourSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    slug: slugSchema.optional(),
    locale: z.enum(HELP_LOCALES).default('he'),
    route: z.enum(HELP_ROUTE_KEYS).default('home'),
    audience: z.enum(TOUR_AUDIENCES).default('all'),
    start: z.enum(TOUR_STARTS).default('offer'),
    steps: z.array(tourStepSchema).max(20).default([]),
  })
  .meta({ id: 'CreateTour' });
export type CreateTour = z.input<typeof createTourSchema>;

export const updateTourSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    slug: slugSchema,
    route: z.enum(HELP_ROUTE_KEYS),
    audience: z.enum(TOUR_AUDIENCES),
    start: z.enum(TOUR_STARTS),
    status: z.enum(TOUR_STATUSES),
    position: z.number().int().min(0).max(10_000),
    steps: z.array(tourStepSchema).max(20),
  })
  .partial()
  .meta({ id: 'UpdateTour' });
export type UpdateTour = z.input<typeof updateTourSchema>;

/** The on-screen picker: the element the platform owner clicked becomes the step's anchor. */
export const setTourAnchorSchema = z
  .object({ step_id: z.string().min(1).max(40), anchor: z.string().trim().max(80).regex(TOUR_ANCHOR_RE) })
  .meta({ id: 'SetTourAnchor' });

/** A tour as a member gets it: published, in their language, with what they did with it. */
export const myTourSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    route: z.enum(HELP_ROUTE_KEYS),
    start: z.enum(TOUR_STARTS),
    position: z.number().int(),
    steps: z.array(
      tourStepSchema.extend({
        /** The step's clip / picture address. */
        media: z.string().nullable(),
        media_type: z.string().nullable(),
      }),
    ),
    state: z.enum(TOUR_STATES).nullable(),
    /** The published guide that links this tour (its video), by slug. */
    guide_slug: z.string().nullable(),
  })
  .meta({ id: 'MyTour' });
export type MyTour = z.infer<typeof myTourSchema>;

export const myToursSchema = z
  .object({
    /** Tours are on: the platform's knowledge center is on and the account did not turn them off. */
    enabled: z.boolean(),
    /** This person still wants the offers on a first visit (they can turn them off and on in their profile). */
    offers: z.boolean(),
    tours: z.array(myTourSchema),
  })
  .meta({ id: 'MyTours' });
export type MyTours = z.infer<typeof myToursSchema>;

export const setTourProgressSchema = z
  .object({ state: z.enum(TOUR_STATES).nullable() })
  .meta({ id: 'SetTourProgress' });
export const setTourPrefsSchema = z.object({ offers: z.boolean() }).meta({ id: 'SetTourPrefs' });

/**
 * Screens a tour can open by itself ("show me in the app" from a guide): the path under `/a/<slug>`. Screens of one
 * board / item / doc / dashboard / workspace have no single address — the tour then waits until the person opens one.
 */
export const TOUR_ROUTE_PATHS: Partial<Record<HelpRouteKey, string>> = {
  home: '',
  automations: '/automations',
  flows: '/flows',
  agents: '/agents',
  my_work: '/my-work',
  inbox: '/inbox',
  admin: '/admin',
  profile: '/profile',
  support: '/help',
  trash: '/trash',
  archive: '/archive',
};

/** The tours this person may see on a screen, in order: published, for them, not done or dismissed. */
export const toursToOffer = (tours: MyTour[], route: HelpRouteKey) =>
  tours
    .filter((t) => t.route === route && t.start !== 'menu' && !t.state)
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));

/** A tour's length for the list: ~10 seconds a step. */
export const tourSeconds = (steps: number) => Math.max(10, steps * 10);
