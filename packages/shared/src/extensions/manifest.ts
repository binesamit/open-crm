// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { httpUrl, trimmed } from '../api/zod';
import { TOKEN_SCOPES, type TokenScope } from '../api/tokens';
import { templateSlotSchema } from '../automations/recipe-template';
import { kitGallerySchema } from '../api/onboarding';

/**
 * Extensions ("תוספות", D27, the planning notes "MARKETPLACE" §4.1): one manifest describes an extension — who publishes
 * it, which scopes it asks for, which origins its code is served from, and what it adds (features and/or data).
 * The same schema validates on the server (install, update), in the consent screen and in developer tooling.
 *
 * Two kinds: a **data pack** (board templates, a starter kit, automation recipes, agent templates — no code runs)
 * and a **code** extension (a board view in a sandboxed iframe on the extension's own origin, ת2).
 */
export const MANIFEST_VERSION = 1;

/** An extension's id in its manifest (its key per account): lowercase, digits and dashes. */
export const extensionKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,47}$/, 'extension_key_invalid')
  .refine((k) => k !== 'empty' && k !== 'default', 'extension_key_reserved');

/** A feature's key inside its manifest. */
const featureKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/);

/**
 * Scopes an extension may ask for: the API token scopes (lib/scopes) minus `admin` — no extension ever gets the
 * account's administration (it acts as the user who opens it, and never more than the admin approved).
 */
// Never `admin`; never a secret column's value.
export const EXTENSION_SCOPES = TOKEN_SCOPES.filter((s) => s !== 'admin' && s !== 'secrets:read') as Exclude<
  TokenScope,
  'admin' | 'secrets:read'
>[];
export type ExtensionScope = (typeof EXTENSION_SCOPES)[number];

/** Semantic version `1.2.3` (pre-release / build suffixes allowed). */
const semverSchema = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?(?:\+[0-9A-Za-z.-]{1,32})?$/);

/**
 * A host an origin may name (EXT-RT2): DNS labels (letters, digits, dashes; punycode for other scripts), an IPv4
 * address or a bracketed IPv6 one. The URL parser lets through `*`, `;`, `,`, quotes and more — a wildcard or a CSP
 * directive smuggled into `frame-src` — so the host is checked on its own.
 */
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST_RE = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]+\\])$`);
export const isSafeOriginHost = (hostname: string) => hostname.length <= 253 && HOST_RE.test(hostname);

/** Is `s` exactly an http(s) origin with a plain host (no wildcard, path, credentials or odd characters)? */
export const isPlainOrigin = (s: string) => {
  try {
    const u = new URL(s);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      u.origin === s &&
      !u.username &&
      !u.password &&
      isSafeOriginHost(u.hostname)
    );
  } catch {
    return false;
  }
};

/** `https://ext.example.com` (no path); `http://localhost:*` / `127.0.0.1` only outside production (server check). */
export const originSchema = z.string().max(300).refine(isPlainOrigin, 'origin_invalid');

/**
 * EXT-RT10: control characters and bidi overrides / isolates (U+202A–U+202E, U+2066–U+2069) let a name read as
 * something else on the consent screen (a reversed publisher name); the plain direction marks (U+200E/U+200F) stay
 * allowed.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const SPOOF_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/;
export const hasSpoofChars = (s: string) => SPOOF_CHARS.test(s);
const text = (max: number) => trimmed(max).refine((s) => !hasSpoofChars(s), 'text_control_chars');
const longText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !hasSpoofChars(s), 'text_control_chars');

/** What every framed feature has: a page at `url` that runs in a sandboxed iframe on one of `origins`. */
const frameFields = {
  key: featureKeySchema,
  name: text(60),
  name_en: text(60).optional(),
  url: httpUrl,
  description: longText(300).optional(),
};

/**
 * A board view (ת2): a tab in "+ view". `offline`: the page keeps working without a network (it
 * queues its own writes) — while it is open the app shows its offline banner instead of the blocking offline screen.
 */
export const boardViewFeatureSchema = z.object({
  type: z.literal('board_view'),
  ...frameFields,
  offline: z.boolean().optional(),
});

/** A tab in the item card (ת3): the page gets the item as context. */
export const itemViewFeatureSchema = z.object({ type: z.literal('item_view'), ...frameFields });

/** How big the modal frame of a menu / batch action opens (the page may resize its height). */
const modalSizeSchema = z
  .object({
    width: z.number().int().min(320).max(1200).default(560),
    height: z.number().int().min(160).max(900).default(420),
  })
  .default({ width: 560, height: 420 });

/**
 * An entry in the board ⋯ menu and / or the item menu (ת3): opens the page in a modal frame with the board (and
 * the item) as context.
 */
export const boardMenuActionFeatureSchema = z.object({
  type: z.literal('board_menu_action'),
  ...frameFields,
  contexts: z
    .array(z.enum(['board', 'item']))
    .min(1)
    .max(2)
    .default(['board', 'item']),
  modal: modalSizeSchema,
});

/** An entry in the batch bar (ת3): opens the page in a modal frame with the selected items as context. */
export const batchActionFeatureSchema = z.object({
  type: z.literal('batch_action'),
  ...frameFields,
  modal: modalSizeSchema,
});

/** A dashboard widget (ת5): reads only boards of the dashboard that the viewer may see. */
export const dashboardWidgetFeatureSchema = z.object({
  type: z.literal('dashboard_widget'),
  ...frameFields,
  default_size: z
    .object({ w: z.number().int().min(2).max(12), h: z.number().int().min(1).max(12) })
    .default({ w: 4, h: 3 }),
});

/** The extension's settings page under Administration → תוספות (ת5): admins only, no board content. */
export const accountSettingsPageFeatureSchema = z.object({ type: z.literal('account_settings_page'), ...frameFields });

/**
 * the extension's page for each member — in their profile (e.g. "connect your own calendar"): any
 * member of the account, their own settings only, no board content. Its server tells who is on the page by asking
 * `POST /ext/introspect` about the page's token.
 */
export const userSettingsPageFeatureSchema = z.object({ type: z.literal('user_settings_page'), ...frameFields });

/**
 * A panel: a narrow page of its own (`/a/<account>/x/<installation>/panel`) — the extension's page
 * in a strip on top and, under it, the app's own item card for the item the page opens (`openItemCard`). Meant to be
 * embedded by a site the platform owner allowed ("allowed embedding origins"), e.g. a browser side panel; the host
 * hands the page whatever it was opened with as `context.params`. Its token reads the installation's boards that
 * this person reads.
 */
export const panelFeatureSchema = z.object({ type: z.literal('panel'), ...frameFields });

/**
 * The drawings an `app_page` may name for its sidebar entry (the app's own icon set, so the entry looks like the
 * others). A name the app does not know shows the generic extension icon — a newer manifest never fails on it.
 */
export const APP_PAGE_ICONS = [
  'chat',
  'inbox',
  'mail',
  'send',
  'bell',
  'calendar',
  'clock',
  'chart',
  'dashboard',
  'table',
  'kanban',
  'timeline',
  'board',
  'doc',
  'file',
  'folder',
  'book',
  'people',
  'person',
  'building',
  'map',
  'place',
  'star',
  'heart',
  'bolt',
  'flow',
  'sparkle',
  'image',
  'mic',
  'ext',
] as const;
export type AppPageIcon = (typeof APP_PAGE_ICONS)[number];

/**
 * a full page the extension adds to the app's sidebar (e.g. an inbox), at `/apps/<extension>/<key>`
 * for every member the installation reaches. Its server (or the page) may show a count beside it (`PUT
 * /ext/app-pages/<key>/badge`). `icon`: one of `APP_PAGE_ICONS`. Its token reads and writes on the boards a panel's
 * does (the installation's top-level boards this member reads, with the member's own rights).
 */
export const appPageFeatureSchema = z.object({
  type: z.literal('app_page'),
  ...frameFields,
  icon: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9]{0,31}$/)
    .optional(),
});
export type AppPageFeature = z.infer<typeof appPageFeatureSchema>;

/**
 * One field of an automation block's form (ת4): the builder draws the form from these. `template` = text with
 * `{item.…}` variables (rendered for the item when the automation runs); `column` = a column of the board (its key).
 */
export const blockFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: text(60),
  label_en: text(60).optional(),
  type: z.enum(['text', 'template', 'number', 'boolean', 'select', 'column']),
  required: z.boolean().default(false),
  /** `select`: the choices. */
  options: z
    .array(z.object({ value: z.string().max(100), label: text(60) }))
    .max(50)
    .optional(),
  /** `column`: the column types allowed (empty = any). */
  column_types: z.array(z.string().max(40)).max(20).optional(),
  placeholder: longText(120).optional(),
});
export type BlockField = z.infer<typeof blockFieldSchema>;

/**
 * An automation action (ת4): "…then <name>". When the automation runs, the platform POSTs a signed request (HMAC +
 * timestamp) to `url` — the extension's own server, on one of `origins`.
 */
export const automationActionFeatureSchema = z.object({
  type: z.literal('automation_action'),
  key: featureKeySchema,
  name: text(60),
  name_en: text(60).optional(),
  url: httpUrl,
  description: longText(300).optional(),
  inputs: z.array(blockFieldSchema).max(20).default([]),
});

/**
 * a field of an extension's trigger — set per automation (e.g. which of the extension's buttons it
 * listens to). The automation stores its value in `trigger.inputs`; a fire runs it only when the payload carries the
 * same value under the same key. Text only.
 */
export const triggerInputSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: text(60),
  label_en: text(60).optional(),
  type: z.literal('text').default('text'),
  placeholder: longText(120).optional(),
});
export type TriggerInput = z.infer<typeof triggerInputSchema>;

/**
 * An automation trigger (ת4): "when <name>" — the extension's server fires it with a signed
 * `POST /automations/triggers/<extension>.<key>/fire`; the JSON body's `payload` becomes `{payload.*}`. `inputs`
 * fields each automation fills; it then runs only for fires whose payload has the same values.
 */
export const automationTriggerFeatureSchema = z.object({
  type: z.literal('automation_trigger'),
  key: featureKeySchema,
  name: text(60),
  name_en: text(60).optional(),
  description: longText(300).optional(),
  /** Fields the payload carries (shown in the builder as `{payload.…}` hints). */
  payload_fields: z
    .array(z.object({ key: z.string().max(60), label: text(60) }))
    .max(30)
    .default([]),
  inputs: z.array(triggerInputSchema).max(10).default([]),
});

export const extensionFeatureSchema = z.discriminatedUnion('type', [
  boardViewFeatureSchema,
  itemViewFeatureSchema,
  boardMenuActionFeatureSchema,
  batchActionFeatureSchema,
  dashboardWidgetFeatureSchema,
  accountSettingsPageFeatureSchema,
  userSettingsPageFeatureSchema,
  panelFeatureSchema,
  appPageFeatureSchema,
  automationActionFeatureSchema,
  automationTriggerFeatureSchema,
]);
export type ExtensionFeature = z.infer<typeof extensionFeatureSchema>;
export type BoardViewFeature = z.infer<typeof boardViewFeatureSchema>;
export type AutomationActionFeature = z.infer<typeof automationActionFeatureSchema>;
export type AutomationTriggerFeature = z.infer<typeof automationTriggerFeatureSchema>;

/** Features shown as a page in a sandboxed iframe — as opposed to automation blocks (server calls). */
export const FRAME_FEATURE_TYPES = [
  'board_view',
  'item_view',
  'board_menu_action',
  'batch_action',
  'dashboard_widget',
  'account_settings_page',
  'user_settings_page',
  'panel',
  'app_page',
] as const;
export type FrameFeatureType = (typeof FRAME_FEATURE_TYPES)[number];
export type FrameFeature = Extract<ExtensionFeature, { type: FrameFeatureType }>;
export const isFrameFeature = (f: ExtensionFeature): f is FrameFeature =>
  (FRAME_FEATURE_TYPES as readonly string[]).includes(f.type);

/** The origin a feature is served from / called at (null for a trigger, which has no URL). */
export const featureOrigin = (f: ExtensionFeature): string | null => {
  if (!('url' in f)) return null;
  try {
    return new URL(f.url).origin;
  } catch {
    return null;
  }
};

/** `<extension key>.<feature key>` — how an automation names an extension's block (`run_extension.block`). */
export const blockKey = (extensionKey: string, featureKey: string) => `${extensionKey}.${featureKey}`;
export const parseBlockKey = (block: string): { extension: string; feature: string } | null => {
  const m = /^([a-z][a-z0-9-]{1,47})\.([a-z][a-z0-9_-]{0,39})$/.exec(block);
  return m ? { extension: m[1]!, feature: m[2]! } : null;
};

/** A board template inside a data pack: the shape of `seed/templates/*.json` (validated fully on install). */
const packTemplateSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/), name: text(255) }).loose();

/** A kit's dashboard (phase B). */
export const kitDashboardSchema = z.object({
  name: text(120),
  folder: z.string().max(120).optional(),
  boards: z.array(z.string().max(64)).max(50).default([]),
  widgets: z
    .array(
      z.object({
        type: z.string().min(1).max(40),
        title: z.string().max(255).default(''),
        settings: z.record(z.string(), z.unknown()).default({}),
      }),
    )
    .max(60)
    .default([]),
});
/** A kit's doc (phase B): rich content (as saved) or Markdown. */
export const kitDocSchema = z.object({
  name: text(200),
  folder: z.string().max(120).optional(),
  content: z.record(z.string(), z.unknown()).optional(),
  markdown: z.string().max(50_000).optional(),
});

/**
 * A starter kit: one workspace with folders and boards made from templates (the pack's own or the built-in ones).
 * `all_builtin_templates`: every built-in template (seed/templates) except the listed keys — each into the folder
 * whose name starts with its template's `folder` code.
 */
export const starterKitSchema = z.object({
  /** The platform's default kit (the first account, `template_set: 'default'`) — one pack in the catalog. */
  default: z.boolean().default(false),
  /** The first workspace's name; omitted = the new account's own name (no name fixed in a kit file). */
  workspace_name: text(120).optional(),
  folders: z.array(text(120)).max(50).default([]),
  boards: z
    .array(z.object({ template: z.string().max(64), folder: z.string().max(120).optional() }))
    .max(100)
    .default([]),
  all_builtin_templates: z.object({ except: z.array(z.string().max(64)).max(200).default([]) }).optional(),
  /** Its card on the start screen; none = not shown there. */
  gallery: kitGallerySchema.optional(),
  /**
   * Phase B: dashboards over the kit's boards (`boards` = template keys; a widget's `settings.board_ids` may name
   * `@<template key>`; columns by type + title, as widgets always name them).
   */
  dashboards: z.array(kitDashboardSchema).max(10).default([]),
  /** Phase B: docs the kit makes (a saved doc's content, or Markdown). */
  docs: z.array(kitDocSchema).max(20).default([]),
});
export type StarterKit = z.infer<typeof starterKitSchema>;

/**
 * An automation recipe: loaded, **inactive** (D21), onto the kit's board made from template `board`.
 * `recipe` = `{trigger, conditions, actions}` (04-AUTOMATIONS), validated by the automations module.
 */
export const packRecipeSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
  board: z.string().max(64),
  title: z.string().max(255).optional(),
  recipe: z.record(z.string(), z.unknown()),
});

/** An agent template (the shape of seed/agents/*.json): offered in the agents' "starter agents" picker. */
export const packAgentSchema = z.object({ key: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), name: text(120) }).loose();

/**
 * An account automation template (a recipe with its board references as slots, picked on install): loaded into the
 * account's template library — the way templates move between accounts.
 */
export const packAutomationTemplateSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,48}$/),
  name: text(255),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(48).nullable().optional(),
  recipe: z.record(z.string(), z.unknown()),
  slots: z.array(templateSlotSchema).max(200).default([]),
});

export const packDataSchema = z.object({
  board_templates: z.array(packTemplateSchema).max(100).default([]),
  starter_kit: starterKitSchema.optional(),
  automation_recipes: z.array(packRecipeSchema).max(500).default([]),
  agent_templates: z.array(packAgentSchema).max(50).default([]),
  automation_templates: z.array(packAutomationTemplateSchema).max(200).default([]),
});
export type PackData = z.infer<typeof packDataSchema>;

/**
 * The extension's own server (ת6, MARKETPLACE §4.3): signed lifecycle webhooks (installed / updated / enabled /
 * disabled / uninstalled) go to `lifecycle_url`, which must be on one of `origins`. An installation of a manifest with
 * `server` gets an extension service user and OAuth client credentials (`client_credentials` at /oauth/token),
 * handed over in the `installed` event.
 */
export const extensionServerSchema = z.object({
  lifecycle_url: httpUrl,
});
export type ExtensionServer = z.infer<typeof extensionServerSchema>;

export const extensionManifestSchema = z
  .object({
    manifest_version: z.literal(MANIFEST_VERSION),
    id: extensionKeySchema,
    name: text(80),
    name_en: text(80).optional(),
    description: longText(1000).optional(),
    description_en: longText(1000).optional(),
    version: semverSchema,
    /** One emoji or a short mark shown next to the name. */
    icon: longText(8).optional(),
    publisher: z.object({
      name: text(120),
      email: z.email().optional(),
      url: httpUrl.optional(),
    }),
    /** Scopes the extension asks for (shown in plain words on the consent screen). */
    permissions: z
      .array(z.enum(EXTENSION_SCOPES as [ExtensionScope, ...ExtensionScope[]]))
      .max(EXTENSION_SCOPES.length)
      .default([]),
    /** Where its code is served from — the only origins framed (CSP) and the only ones it talks to (postMessage). */
    origins: z.array(originSchema).max(5).default([]),
    features: z.array(extensionFeatureSchema).max(20).default([]),
    /** Its own server (ת6): lifecycle webhooks + a service user with OAuth client credentials. */
    server: extensionServerSchema.optional(),
    /** A data pack's content (ת1). */
    data: packDataSchema.optional(),
  })
  .superRefine((m, ctx) => {
    const keys = new Set<string>();
    m.features.forEach((f, i) => {
      if (keys.has(f.key)) ctx.addIssue({ code: 'custom', path: ['features', i, 'key'], message: 'feature_key_taken' });
      keys.add(f.key);
      const origin = featureOrigin(f);
      if (origin && !m.origins.includes(origin))
        ctx.addIssue({ code: 'custom', path: ['features', i, 'url'], message: 'feature_origin_not_listed' });
    });
    if (new Set(m.permissions).size !== m.permissions.length)
      ctx.addIssue({ code: 'custom', path: ['permissions'], message: 'permission_repeated' });
    if ((m.features.length || m.server) && !m.origins.length)
      ctx.addIssue({ code: 'custom', path: ['origins'], message: 'origins_required' });
    if (m.server) {
      let origin: string | null = null;
      try {
        origin = new URL(m.server.lifecycle_url).origin;
      } catch {
        // reported by the url check
      }
      if (origin && m.origins.length && !m.origins.includes(origin))
        ctx.addIssue({ code: 'custom', path: ['server', 'lifecycle_url'], message: 'server_origin_not_listed' });
    }
    if (!m.features.length && !m.data && !m.server)
      ctx.addIssue({ code: 'custom', path: ['features'], message: 'manifest_empty' });
  });
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

/** `data` = no code at all (safe: only data the platform already knows how to load); `code` = it frames a page. */
export type ExtensionKind = 'data' | 'code';
export const extensionKind = (m: Pick<ExtensionManifest, 'features'> & { server?: unknown }): ExtensionKind =>
  m.features.length || m.server ? 'code' : 'data';

/** Origins a manifest's pages are actually framed from (a subset of `origins`; not its automation servers). */
export const frameOriginsOf = (m: Pick<ExtensionManifest, 'features'>): string[] => [
  ...new Set(
    m.features.flatMap((f) => {
      const o = isFrameFeature(f) ? featureOrigin(f) : null;
      return o ? [o] : [];
    }),
  ),
];

/** Is `origin` a local development origin (allowed only outside production)? */
export const isLocalOrigin = (origin: string) => {
  try {
    const h = new URL(origin).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost');
  } catch {
    return false;
  }
};

/**
 * What a new manifest version adds over the approved one — a new scope, origin or feature needs the admin's
 * consent again (§4.5); anything else updates by itself.
 */
export const manifestDelta = (approved: ExtensionManifest, next: ExtensionManifest) => {
  const addedScopes = next.permissions.filter((s) => !approved.permissions.includes(s));
  const addedOrigins = next.origins.filter((o) => !approved.origins.includes(o));
  const known = new Set(approved.features.map((f) => `${f.type}:${f.key}`));
  const addedFeatures = next.features.filter((f) => !known.has(`${f.type}:${f.key}`)).map((f) => f.key);
  // A server where there was none (ת6) is a new capability: a service user that acts without anyone opening it.
  if (next.server && !approved.server) addedFeatures.push('server');
  return {
    addedScopes,
    addedOrigins,
    addedFeatures,
    needsConsent: addedScopes.length > 0 || addedOrigins.length > 0 || addedFeatures.length > 0,
  };
};

/** Validation issues as `path: message` lines (the consent / add-by-URL screens show them). */
export const manifestIssues = (raw: unknown): string[] => {
  const parsed = extensionManifestSchema.safeParse(raw);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
};
