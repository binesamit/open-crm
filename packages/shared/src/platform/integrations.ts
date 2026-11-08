// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * How people reach the platform's own no-code integrations: the n8n community-node package and the
 * Make app. Owner console → Platform settings → Integrations; the account's Administration → Connections and the
 * public API guide show the steps with these values. Never a literal link in code — the Make app's invitation link
 * is the owner's (empty = "ask your administrator").
 */

/**
 * The npm name of the n8n community nodes (integrations/n8n-nodes-bines-os/package.json `name`) — the default of
 * the owner's setting. A test keeps it equal to the package's real name.
 */
export const DEFAULT_N8N_PACKAGE = 'n8n-nodes-bines-os';

/** An npm package name (`name` or `@scope/name`), lower case, as n8n's "Install community node" takes it. */
export const npmPackageNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/, 'npm_package_invalid');

/** The Make app's invitation link: a public https address. */
export const makeInvitationUrlSchema = z.url({ protocol: /^https$/ }).max(500);

/** `platform_settings.settings.integrations`. */
export const platformIntegrationsSchema = z.object({
  /** The n8n package to install (empty = DEFAULT_N8N_PACKAGE). */
  n8n_package: npmPackageNameSchema.optional(),
  /** The Make app's invitation link (empty = none; accounts are told to ask their administrator). */
  make_invitation_url: makeInvitationUrlSchema.optional(),
});
export type PlatformIntegrations = z.infer<typeof platformIntegrationsSchema>;

export const updatePlatformIntegrationsSchema = z.object({
  n8n_package: npmPackageNameSchema.nullable().optional(),
  make_invitation_url: makeInvitationUrlSchema.nullable().optional(),
});

/** GET /auth/integrations: what a member needs to connect n8n / Make to this platform. */
export const integrationsGuideSchema = z.object({
  product_name: z.string(),
  /** The address to paste as the "Instance URL" (the API's public origin; `/api/v1` is added by the node / app). */
  base_url: z.string(),
  /** `<base_url>/api/v1`. */
  api_base: z.string(),
  n8n_package: z.string(),
  /** Null = the owner has not set one. */
  make_invitation_url: z.string().nullable(),
});
export type IntegrationsGuide = z.infer<typeof integrationsGuideSchema>;

/** The values in effect: the owner's, else the defaults. */
export const resolveIntegrations = (s: PlatformIntegrations | undefined) => ({
  n8n_package: s?.n8n_package?.trim() || DEFAULT_N8N_PACKAGE,
  make_invitation_url: s?.make_invitation_url?.trim() || null,
});
