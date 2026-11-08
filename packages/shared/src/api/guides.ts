// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Guides: the installation and licensing guide (docs/GUIDE.md + GUIDE.he.md, bundled into the build
 * public at /api/docs/guide[/he] and in the app), and the platform owner's own guides — private Markdown pages kept in
 * the database, written in the owner console and shown only to the owner.
 */
export const GUIDE_LOCALES = ['he', 'en'] as const;
export type GuideLocale = (typeof GUIDE_LOCALES)[number];

/**
 * Sections of the installation guide other screens link to (the license card → "Activating a key" …). Both languages
 * number their sections the same way; the key resolves to the heading that starts with that number, whatever the
 * language (test/install-guide.test.ts checks the numbers still name these sections).
 */
export const INSTALL_GUIDE_SECTIONS = {
  license: 1,
  requirements: 2,
  install: 3,
  first_admin: 4,
  registration: 5,
  editions: 6,
  activate: 7,
  license_card: 8,
  renewal: 9,
  upgrade: 10,
  privacy: 11,
  troubleshooting: 13,
  faq: 14,
} as const;
export type InstallGuideSection = keyof typeof INSTALL_GUIDE_SECTIONS;
export const isInstallGuideSection = (s: unknown): s is InstallGuideSection =>
  typeof s === 'string' && Object.hasOwn(INSTALL_GUIDE_SECTIONS, s);

const headingsSchema = z.array(z.object({ depth: z.number().int(), id: z.string(), text: z.string() }));

/** GET /guides/install: the guide in one language, rendered and white-labelled on the server. */
export const installGuideSchema = z.object({
  locale: z.enum(GUIDE_LOCALES),
  title: z.string(),
  /** Safe HTML (raw HTML in the Markdown is escaped; links are http(s) / mailto / anchors / the guide's own pages). */
  html: z.string(),
  headings: headingsSchema,
  /** Section key (INSTALL_GUIDE_SECTIONS) → the heading id in this language. */
  sections: z.record(z.string(), z.string()),
  product_name: z.string(),
  /** The same page on the public docs site (no sign-in), in this language. */
  public_path: z.string(),
});
export type InstallGuide = z.infer<typeof installGuideSchema>;

export const installGuideQuerySchema = z.object({ locale: z.enum(GUIDE_LOCALES).optional() });

// ------------------------------------------------------------------------------------------------ owner guides

export const ownerGuideTitleSchema = z.string().trim().max(160);
export const ownerGuideBodySchema = z.string().max(200_000);
const localizedOptional = <T extends z.ZodTypeAny>(s: T) => z.object({ he: s.optional(), en: s.optional() });

/** An owner guide: a title and a Markdown body per language — either language may stay empty. */
export const ownerGuideSchema = z.object({
  id: z.string(),
  title: z.object({ he: z.string(), en: z.string() }),
  body: z.object({ he: z.string(), en: z.string() }),
  sort_order: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type OwnerGuide = z.infer<typeof ownerGuideSchema>;

const someTitle = (v: { title?: { he?: string; en?: string } }) => !!(v.title?.he?.trim() || v.title?.en?.trim());

/** POST /platform/guides: at least one title; the body is Markdown (the owner console, or a script via the API). */
export const createOwnerGuideSchema = z
  .object({
    title: localizedOptional(ownerGuideTitleSchema),
    body: localizedOptional(ownerGuideBodySchema).optional(),
  })
  .refine(someTitle, { message: 'A guide needs a title in at least one language', path: ['title'] });
export type CreateOwnerGuide = z.infer<typeof createOwnerGuideSchema>;

/** PATCH /platform/guides/{id}: only what is sent changes; the guide keeps at least one title. */
export const updateOwnerGuideSchema = z.object({
  title: localizedOptional(ownerGuideTitleSchema).optional(),
  body: localizedOptional(ownerGuideBodySchema).optional(),
});
export type UpdateOwnerGuide = z.infer<typeof updateOwnerGuideSchema>;

/** PUT /platform/guides/order: every guide's id, in the new order. */
export const reorderOwnerGuidesSchema = z.object({ ids: z.array(z.string().max(26)).min(1).max(500) });
