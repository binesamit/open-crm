// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { kitGallerySchema } from '../api/onboarding';
import { extensionKeySchema } from './manifest';

/**
 * Starter kits as data (M11 stage 3): the platform owner makes, edits, previews, versions and
 * removes the kits a new account can open with — all in the owner console, no code and no file. A kit is a data
 * pack in the platform catalog (D27 ת1) with a `starter_kit`; "save as starter kit" takes boards of an account the
 * owner is a member of (as templates, with their folders and, optionally, their automations).
 */

const kitText = (max: number) => z.string().trim().min(1).max(max);

/** A board the kit makes: its template (the kit's own or a built-in one) and the folder it goes into. */
export const starterKitBoardSchema = z.object({
  template: z.string().max(64),
  /** The template's name (the kit's own template, else the built-in one); null when it no longer exists. */
  name: z.string().nullable(),
  folder: z.string().nullable(),
  source: z.enum(['kit', 'builtin', 'missing']),
  /** Listed in the kit (editable); false = one of "every built-in template but …" (follows its template). */
  listed: z.boolean(),
});

export const starterKitVersionSchema = z.object({
  id: z.string(),
  version: z.string(),
  /** created / edited / from_boards / restored / seeded / default_moved. */
  note: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string().nullable(),
});

/** GET /platform/starter-kits/{key} — what a new account gets from the kit, before choosing it. */
export const starterKitDetailSchema = z
  .object({
    key: z.string(),
    name: z.string(),
    name_en: z.string().nullable(),
    description: z.string().nullable(),
    description_en: z.string().nullable(),
    icon: z.string().nullable(),
    version: z.string(),
    default: z.boolean(),
    /** The first workspace's name; null = the new account's own name. */
    workspace_name: z.string().nullable(),
    /** Its card on the start screen. */
    gallery: kitGallerySchema,
    folders: z.array(z.string()),
    /** Every board the kit makes, in order (the listed ones, then the built-in ones it takes "all but"). */
    boards: z.array(starterKitBoardSchema),
    /** Also a board from every built-in template but these; null = only the listed boards. */
    all_builtin_templates: z.object({ except: z.array(z.string()) }).nullable(),
    /** The kit's own board templates (from "save as starter kit") — what `boards` may refer to. */
    templates: z.array(z.object({ key: z.string(), name: z.string() })),
    automation_recipes: z.number().int(),
    /** Phase B: the dashboards and docs the kit makes (their names). */
    dashboards: z.array(z.string()).default([]),
    docs: z.array(z.string()).default([]),
    automation_templates: z.number().int(),
    /** Accounts that opened with it (or installed it). */
    installs: z.number().int(),
    updated_at: z.string(),
    versions: z.array(starterKitVersionSchema),
  })
  .meta({ id: 'StarterKit' });
export type StarterKitDetail = z.infer<typeof starterKitDetailSchema>;

/** POST /platform/starter-kits — "save as starter kit" from boards of an account I am an active member of. */
export const createStarterKitSchema = z.object({
  key: extensionKeySchema,
  name: kitText(80),
  name_en: kitText(80).optional(),
  description: z.string().trim().max(1000).optional(),
  account_id: z.string().max(26),
  board_ids: z.array(z.string().max(26)).min(1).max(50),
  /** The boards' automations come along as recipes (they load inactive in a new account, D21). */
  include_automations: z.boolean().default(true),
  /** The first workspace's name; omitted / null = the new account's own name. */
  workspace_name: kitText(120).nullable().optional(),
  /** Each board into a folder named like its folder in the source account (else all at the workspace root). */
  keep_folders: z.boolean().default(true),
  default: z.boolean().default(false),
  /** Phase B: dashboards over those boards, and docs, of the same account. */
  dashboard_ids: z.array(z.string().max(26)).max(10).default([]),
  doc_ids: z.array(z.string().max(26)).max(20).default([]),
});

/** PATCH /platform/starter-kits/{key} — any of these; every save is a new version (the old one is kept). */
export const updateStarterKitSchema = z.object({
  name: kitText(80).optional(),
  name_en: kitText(80).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  description_en: z.string().trim().max(1000).nullable().optional(),
  icon: z.string().trim().max(8).nullable().optional(),
  workspace_name: kitText(120).nullable().optional(),
  folders: z.array(kitText(120)).max(50).optional(),
  boards: z
    .array(z.object({ template: z.string().max(64), folder: z.string().max(120).nullable().optional() }))
    .max(100)
    .optional(),
  all_builtin_templates: z
    .object({ except: z.array(z.string().max(64)).max(200).default([]) })
    .nullable()
    .optional(),
  /** The platform's default kit (`template_set: 'default'`, the first account) — one kit at a time. */
  default: z.boolean().optional(),
  /** Its card on the start screen. */
  gallery: kitGallerySchema.partial().optional(),
});

/** GET /platform/accounts/{id}/kit-boards — the boards "save as starter kit" may take from that account. */
export const kitSourceBoardsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      workspace: z.string(),
      folder: z.string().nullable(),
    }),
  ),
  /** Phase B: its dashboards and docs (a kit may take them too). */
  dashboards: z.array(z.object({ id: z.string(), name: z.string(), workspace: z.string() })).default([]),
  docs: z.array(z.object({ id: z.string(), name: z.string(), workspace: z.string() })).default([]),
});
