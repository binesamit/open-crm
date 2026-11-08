// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { EXTENSION_SCOPES, type ExtensionScope, extensionKeySchema, extensionManifestSchema } from './manifest';
import { catalogEntryInfoSchema, extensionServerInfoSchema } from './server';

/**
 * Extensions API (D27, the planning notes "MARKETPLACE" ת0–ת2): install / consent / enable / disable / uninstall per
 * account by admins, the starter-kit catalog, and the short-lived token a board-view extension gets (ת2).
 * Every route is session-only (lib/scopes): an API token or an extension's own token can never manage extensions.
 */

/** Where a manifest comes from: a URL (fetched by the server, SSRF-guarded), pasted JSON, or the platform catalog. */
export const extensionSourceSchema = z.union([
  z.object({ manifest_url: z.url().max(2000) }),
  z.object({ manifest: z.record(z.string(), z.unknown()) }),
  z.object({ catalog_key: extensionKeySchema }),
]);
export type ExtensionSource = z.infer<typeof extensionSourceSchema>;

const scopeEnum = z.enum(EXTENSION_SCOPES as [ExtensionScope, ...ExtensionScope[]]);

/**
 * The admin's consent (the consent screen): which of the requested scopes are granted (all by default — fewer
 * may break the extension, never more), on which boards (null = every board), and whether guests may use it.
 */
export const extensionConsentSchema = z.object({
  accept: z.literal(true),
  scopes: z.array(scopeEnum).max(EXTENSION_SCOPES.length),
  board_ids: z.array(z.string().max(26)).min(1).max(200).nullable().default(null),
  /** And / or whole workspaces (their boards now and later); both null = the whole account. */
  workspace_ids: z.array(z.string().max(26)).min(1).max(100).nullable().default(null),
  allow_guests: z.boolean().default(false),
});
export type ExtensionConsent = z.infer<typeof extensionConsentSchema>;

export const previewExtensionSchema = extensionSourceSchema;
/** sha256 (hex) of the manifest as the consent screen showed it (`ExtensionPreview.digest`). */
const manifestDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const installExtensionSchema = z.object({
  source: extensionSourceSchema,
  consent: extensionConsentSchema,
  /**
   * EXT-RT3: the preview's `digest` — the install refuses (409 `manifest_changed`) when the manifest it fetches now is
   * not the one the admin consented to (a URL that served something else the second time).
   */
  manifest_digest: manifestDigestSchema.optional(),
});

export const updateInstallationSchema = z.object({
  status: z.enum(['enabled', 'disabled']).optional(),
  /** Fewer scopes than granted at any time; more only up to what the approved manifest asks for. */
  scopes: z.array(scopeEnum).max(EXTENSION_SCOPES.length).optional(),
  board_ids: z.array(z.string().max(26)).min(1).max(200).nullable().optional(),
  workspace_ids: z.array(z.string().max(26)).min(1).max(100).nullable().optional(),
  allow_guests: z.boolean().optional(),
});

export const approveUpdateSchema = z.object({
  consent: extensionConsentSchema,
  /** EXT-RT3: the waiting version the admin looked at — another one waiting now → 409 `pending_update_changed`. */
  version: z.string().max(80).optional(),
});

/**
 * POST /extensions/installations/:id/token — a token for one feature where it is shown: on one board (board view,
 * item tab, menu / batch action — ת2/ת3), for one widget of a dashboard (its boards the viewer may see — ת5), or
 * for the settings page (admins, no board content — ת5).
 */
export const mintExtensionTokenSchema = z.object({
  feature: z.string().max(40),
  board_id: z.string().max(26).optional(),
  /** A board view's tab: its `settings.extension.board_ids` join the token's boards. */
  view_id: z.string().max(26).optional(),
  dashboard_id: z.string().max(26).optional(),
  widget_id: z.string().max(26).optional(),
});

export const extensionTokenSchema = z
  .object({
    token: z.string(),
    expires_at: z.string(),
    scopes: z.array(z.string()),
    /** The board it was minted on ('' for a widget or the settings page). */
    board_id: z.string(),
    /** Every board it may read (a widget: the dashboard's boards the viewer may see). */
    board_ids: z.array(z.string()),
    origin: z.string(),
    /** Path prefix of the REST API on the app's origin. */
    api_base: z.string(),
  })
  .meta({ id: 'ExtensionToken' });
export type ExtensionTokenDto = z.infer<typeof extensionTokenSchema>;

const scopeLine = z.object({ scope: z.string(), write: z.boolean() });

export const extensionFeatureDtoSchema = z.object({
  type: z.string(),
  key: z.string(),
  name: z.string(),
  name_en: z.string().nullable(),
  url: z.string().nullable(),
});

export const packSummarySchema = z.object({
  board_templates: z.number(),
  starter_kit: z
    .object({
      workspace_name: z.string(),
      folders: z.number(),
      boards: z.number(),
      /** Also a board from every built-in template (but the excluded ones). */
      all_builtin: z.boolean(),
    })
    .nullable(),
  automation_recipes: z.number(),
  agent_templates: z.number(),
  automation_templates: z.number().optional(),
});

export const extensionPreviewSchema = z
  .object({
    manifest: extensionManifestSchema,
    /** sha256 of this manifest — sent back with the install so it installs exactly what was shown (EXT-RT3). */
    digest: z.string(),
    kind: z.enum(['data', 'code']),
    scopes: z.array(scopeLine),
    frame_origins: z.array(z.string()),
    features: z.array(extensionFeatureDtoSchema),
    data: packSummarySchema.nullable(),
    /** Plain-language warnings: runs code, local development origin, ... */
    warnings: z.array(z.string()),
    /** The same extension already installed here: what this manifest adds (a new scope/origin/feature = consent). */
    existing: z
      .object({
        installation_id: z.string(),
        version: z.string(),
        added_scopes: z.array(z.string()),
        added_origins: z.array(z.string()),
        added_features: z.array(z.string()),
      })
      .nullable(),
  })
  .meta({ id: 'ExtensionPreview' });
export type ExtensionPreview = z.infer<typeof extensionPreviewSchema>;

export const extensionInstallationSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    name_en: z.string().nullable(),
    description: z.string().nullable(),
    icon: z.string().nullable(),
    version: z.string(),
    kind: z.enum(['data', 'code']),
    status: z.enum(['enabled', 'disabled']),
    /** Switched off for every account by the platform owner (emergency kill switch). */
    killed: z.boolean(),
    publisher: z.object({ name: z.string(), email: z.string().nullable(), url: z.string().nullable() }),
    source: z.enum(['url', 'manifest', 'catalog']),
    source_url: z.string().nullable(),
    requested_scopes: z.array(z.string()),
    granted_scopes: z.array(z.string()),
    board_ids: z.array(z.string()).nullable(),
    workspace_ids: z.array(z.string()).nullable(),
    allow_guests: z.boolean(),
    frame_origins: z.array(z.string()),
    features: z.array(extensionFeatureDtoSchema),
    data: packSummarySchema.nullable(),
    pending_update: z
      .object({
        version: z.string(),
        /** Everything the waiting version asks for (the consent screen of the update). */
        requested_scopes: z.array(z.string()),
        added_scopes: z.array(z.string()),
        added_origins: z.array(z.string()),
        added_features: z.array(z.string()),
      })
      .nullable(),
    consented_at: z.string().nullable(),
    installed_at: z.string(),
    // ---- ת6: versions and the extension's own server ----
    /** Locked on this version: the daily check only reports newer ones. */
    version_locked: z.boolean().default(false),
    /** A version asking for nothing new applies by itself (else it waits like one that asks for more). */
    auto_update: z.boolean().default(true),
    last_checked_at: z.string().nullable().default(null),
    check_error: z.string().nullable().default(null),
    server: extensionServerInfoSchema.nullable().default(null),
  })
  .meta({ id: 'ExtensionInstallation' });
export type ExtensionInstallation = z.infer<typeof extensionInstallationSchema>;

export const extensionCatalogEntrySchema = z.object({
  key: z.string(),
  name: z.string(),
  name_en: z.string().nullable(),
  description: z.string().nullable(),
  icon: z.string().nullable(),
  version: z.string(),
  kind: z.enum(['data', 'code']),
  data: packSummarySchema.nullable(),
  installed: z.boolean(),
  killed: z.boolean(),
  /** Round 13 (the store's cards): who publishes it, its English description, what it adds and asks for. */
  description_en: z.string().nullable().optional(),
  publisher: z.object({ name: z.string(), url: z.string().nullable() }).optional(),
  feature_types: z.array(z.string()).optional(),
  permissions: z.array(z.string()).optional(),
  /** The version installed in this account (null = not installed) — the store's "update" tab compares it. */
  installed_version: z.string().nullable().optional(),
});
export type ExtensionCatalogEntry = z.infer<typeof extensionCatalogEntrySchema>;

export const extensionsListSchema = z.object({
  installed: z.array(extensionInstallationSchema),
  catalog: z.array(extensionCatalogEntrySchema),
});

/** A board view any member may add as a tab (GET /extensions/board-views?board_id=). */
export const extensionBoardViewSchema = z.object({
  installation_id: z.string(),
  extension_key: z.string(),
  extension_name: z.string(),
  icon: z.string().nullable(),
  feature: z.string(),
  name: z.string(),
  name_en: z.string().nullable(),
  url: z.string(),
  origin: z.string(),
  /** The page works without a network (manifest `offline`) — the app does not cover it with the offline screen. */
  offline: z.boolean().optional(),
});
export type ExtensionBoardView = z.infer<typeof extensionBoardViewSchema>;

/**
 * A framed feature a member may open (GET /extensions/features — ת3/ת5): item tabs, menu / batch actions,
 * dashboard widgets, settings pages (admins) — and board views.
 */
export const extensionFrameFeatureSchema = extensionBoardViewSchema.extend({
  type: z.enum([
    'board_view',
    'item_view',
    'board_menu_action',
    'batch_action',
    'dashboard_widget',
    'account_settings_page',
    'user_settings_page',
    'panel',
    'app_page',
  ]),
  /** board_menu_action: where it is offered. */
  contexts: z.array(z.enum(['board', 'item'])).nullable(),
  /** Menu / batch actions: the modal frame's size. */
  modal: z.object({ width: z.number(), height: z.number() }).nullable(),
  /** dashboard_widget: its size when added. */
  default_size: z.object({ w: z.number(), h: z.number() }).nullable(),
  /** app_page: the drawing its sidebar entry names (`APP_PAGE_ICONS`), if any. */
  page_icon: z.string().nullable().optional(),
});
export type ExtensionFrameFeature = z.infer<typeof extensionFrameFeatureSchema>;

/**
 * the extensions' pages in the sidebar for me (GET /extensions/app-pages), each with its count — mine
 * when the extension set one for me, else the account's, else none (`null`).
 */
export const extensionAppPageSchema = extensionFrameFeatureSchema.extend({
  badge: z.number().int().nullable(),
});
export type ExtensionAppPage = z.infer<typeof extensionAppPageSchema>;

/** The most a page's count may be (the sidebar shows "99+" above 99). */
export const APP_PAGE_BADGE_MAX = 1_000_000;

/**
 * `PUT /ext/app-pages/{key}/badge` (its server or its page) and `PUT /extensions/installations/{id}/app-pages/{key}/badge`
 * (the page through the app, `setBadge`): the count beside the page. `null` removes it (a member's own count then
 * falls back to the account's). `user_id`: one member's count (its server only — a page sets only its own user's).
 */
export const setAppPageBadgeSchema = z.object({
  count: z.number().int().min(0).max(APP_PAGE_BADGE_MAX).nullable(),
  user_id: z.string().min(1).max(26).optional(),
});
export type SetAppPageBadge = z.infer<typeof setAppPageBadgeSchema>;
export const appPageBadgeSchema = z.object({
  key: z.string(),
  count: z.number().int().nullable(),
  user_id: z.string().nullable(),
});

/**
 * `GET /ext/automations?trigger=<key>` — a page's own question "which automations use my trigger?"
 * (e.g. which of its buttons has a live automation). Only its own `automation_trigger` keys; only automations on the
 * boards its token reads.
 */
export const extAutomationsQuerySchema = z.object({ trigger: z.string().min(1).max(40) });
export const extAutomationSchema = z.object({
  id: z.string(),
  board_id: z.string().nullable(),
  name: z.string(),
  active: z.boolean(),
  /** The automation's trigger as stored: `{ type: 'extension_trigger', block: '<extension>.<key>', with_item }`. */
  trigger: z.record(z.string(), z.unknown()),
});
export type ExtAutomation = z.infer<typeof extAutomationSchema>;
export const extAutomationListSchema = z.object({ data: z.array(extAutomationSchema) });

/**
 * the host action `openAutomationBuilder` — the app's own automation builder over the page, its
 * trigger one of the calling extension's own `automation_trigger` keys. `config`: the trigger's own fields
 * (`with_item`, and `inputs` — values of its manifest `inputs`, prefilled and locked in the builder). `board_id`: one
 * of the boards its token reads (default: the frame's board).
 */
export const openAutomationBuilderSchema = z.object({
  trigger: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/),
  config: z
    .object({
      with_item: z.boolean().optional(),
      inputs: z
        .record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().max(500))
        .refine((r) => Object.keys(r).length <= 10)
        .optional(),
    })
    .strip()
    .optional(),
  board_id: z.string().min(1).max(26).optional(),
});
export type OpenAutomationBuilder = z.infer<typeof openAutomationBuilderSchema>;

/**
 * the host action `setAutomationActive` — switch on / off an automation whose trigger is the calling
 * extension's own, on a board its token reads, with the member's own rights (`automation.manage`).
 */
export const setAutomationActiveSchema = z.object({
  automation_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  active: z.boolean(),
});
export type SetAutomationActive = z.infer<typeof setAutomationActiveSchema>;

const blockFieldDtoSchema = z.object({
  key: z.string(),
  label: z.string(),
  label_en: z.string().nullable(),
  type: z.enum(['text', 'template', 'number', 'boolean', 'select', 'column']),
  required: z.boolean(),
  options: z.array(z.object({ value: z.string(), label: z.string() })).nullable(),
  column_types: z.array(z.string()).nullable(),
  placeholder: z.string().nullable(),
});

/** Automation blocks of enabled extensions on a board (GET /extensions/automation-blocks — the builder). */
export const extensionBlocksSchema = z
  .object({
    actions: z.array(
      z.object({
        block: z.string(),
        extension_name: z.string(),
        icon: z.string().nullable(),
        name: z.string(),
        name_en: z.string().nullable(),
        description: z.string().nullable(),
        inputs: z.array(blockFieldDtoSchema),
      }),
    ),
    triggers: z.array(
      z.object({
        block: z.string(),
        extension_name: z.string(),
        icon: z.string().nullable(),
        name: z.string(),
        name_en: z.string().nullable(),
        description: z.string().nullable(),
        payload_fields: z.array(z.object({ key: z.string(), label: z.string() })),
        /** the fields each automation fills (it runs only for fires carrying the same values). */
        inputs: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            label_en: z.string().nullable(),
            type: z.literal('text'),
            placeholder: z.string().nullable(),
          }),
        ),
      }),
    ),
  })
  .meta({ id: 'ExtensionBlocks' });
export type ExtensionBlocks = z.infer<typeof extensionBlocksSchema>;
export type ExtensionActionBlock = ExtensionBlocks['actions'][number];
export type ExtensionTriggerBlock = ExtensionBlocks['triggers'][number];

/** The installation's signing secret (admins): its server checks our calls and signs its trigger calls with it. */
export const extensionSecretSchema = z.object({ secret: z.string(), installation_id: z.string() });

// ---- the extension's own storage (ת5, with its token) ----
export const extStorageEntrySchema = z.object({
  key: z.string(),
  value: z.unknown(),
  size: z.number(),
  updated_at: z.string(),
});
export const extStorageListSchema = z.object({
  data: z.array(extStorageEntrySchema.omit({ value: true })),
  used_bytes: z.number(),
  quota_bytes: z.number(),
});
export const putExtStorageSchema = z.object({ value: z.unknown() });

/** its server asks who a token of its own pages belongs to (`POST /ext/introspect`). */
export const extIntrospectSchema = z.object({ token: z.string().min(1).max(4096) });
export const extIntrospectionSchema = z.object({
  active: z.boolean(),
  /** When active: the member on the page, the account and the feature it was minted for. */
  user: z.object({ id: z.string(), name: z.string(), email: z.string() }).optional(),
  account_id: z.string().optional(),
  feature: z.string().optional(),
  expires_at: z.string().optional(),
});
export type ExtIntrospection = z.infer<typeof extIntrospectionSchema>;

// ---- the platform owner (owner console) ----
export const killExtensionSchema = z.object({
  key: extensionKeySchema,
  reason: z.string().trim().min(1).max(500),
});

export const platformExtensionSchema = z.object({
  key: z.string(),
  name: z.string(),
  kind: z.enum(['data', 'code']),
  /** In the platform catalog (seed/packs) or only added privately by accounts. */
  catalog: z.boolean(),
  installs: z.number(),
  killed: z.object({ reason: z.string(), at: z.string() }).nullable(),
  /** The catalog entry (ת7): its version, where it is refreshed from, and the §8 review it was published with. */
  entry: catalogEntryInfoSchema.nullable().default(null),
});
export type PlatformExtension = z.infer<typeof platformExtensionSchema>;

/** Starter kits a new account can open with (owner console → new account). */
export const starterKitOptionSchema = z.object({
  key: z.string(),
  name: z.string(),
  name_en: z.string().nullable(),
  default: z.boolean(),
  /** M11 stage 3: what the kit is, its version and size — the owner console's kit list and picker. */
  description: z.string().nullable().optional(),
  version: z.string().optional(),
  folders: z.number().int().optional(),
  boards: z.number().int().optional(),
  icon: z.string().nullable().optional(),
});
export type StarterKitOption = z.infer<typeof starterKitOptionSchema>;

/** "Save as pack" (ת1): these boards (as templates) and their automations (as recipes) in one manifest. */
export const exportPackSchema = z.object({
  key: extensionKeySchema,
  name: z.string().trim().min(1).max(80),
  board_ids: z.array(z.string().max(26)).min(1).max(50),
  include_automations: z.boolean().default(true),
  /** Account automation templates to carry along (installed into the other account's template library). */
  automation_template_ids: z.array(z.string().max(26)).max(200).optional(),
});

/**
 * s37market: the extension developer guide inside the app (GET /extensions/docs/{page}) — the same bundled Markdown as
 * the public pages at /api/docs/extensions[/quickstart], rendered and white-labelled on the server.
 */
export const EXTENSION_DOC_PAGES = ['guide', 'quickstart'] as const;
export type ExtensionDocPageKey = (typeof EXTENSION_DOC_PAGES)[number];
export const extensionDocPageSchema = z.object({
  page: z.enum(EXTENSION_DOC_PAGES),
  title: z.string(),
  /** Safe HTML (raw HTML in the Markdown is escaped; links are http(s) / mailto / anchors / the docs' own pages). */
  html: z.string(),
  headings: z.array(z.object({ depth: z.number().int(), id: z.string(), text: z.string() })),
  product_name: z.string(),
  /** The same page on the public docs site (for sharing with an outside developer). */
  public_path: z.string(),
});
export type ExtensionDocPage = z.infer<typeof extensionDocPageSchema>;
