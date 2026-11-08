// SPDX-License-Identifier: AGPL-3.0-only
import { checklistSettingsSchema } from './checklist';
import { z } from 'zod';
import { AI_PROVIDERS } from '../ai/models';
import { richNodeSchema } from '../rich';
import { SUPPORT_STAFF_ROLES } from './tickets';

/**
 * The knowledge center (stages 1–6): help articles written by the platform's support staff in the
 * owner console (Support → Knowledge), searched with Hebrew-aware full text, offered in the "?" help panel (by the
 * screen the person is on) and while typing a ticket subject, and the only source of the help assistant ("ask the
 * assistant": no tools, answers only from published articles, with citations). Platform-level data — never an
 * account's doc. Every behaviour is a setting (`help_center` in the owner console, `help_ai` in the account).
 */

export const HELP_LOCALES = ['he', 'en'] as const;
export type HelpLocale = (typeof HELP_LOCALES)[number];
export const HELP_VISIBILITIES = ['public', 'signed_in'] as const;
export type HelpVisibility = (typeof HELP_VISIBILITIES)[number];
export const HELP_STATUSES = ['draft', 'published'] as const;
export type HelpStatus = (typeof HELP_STATUSES)[number];

/** What the knowledge center measures (help_events.kind). */
export const HELP_EVENT_KINDS = [
  'search',
  'search_no_result',
  'view',
  'helpful_yes',
  'helpful_no',
  'deflected',
  'ticket_opened',
  'ai_answer',
  'ai_not_found',
] as const;
export type HelpEventKind = (typeof HELP_EVENT_KINDS)[number];
/** The events the app reports itself (the rest are recorded by the server as they happen). */
export const HELP_CLIENT_EVENTS = ['deflected', 'ticket_opened'] as const;

/**
 * The screens of the app the "?" panel can suggest articles for (route key → the tags the owner maps to it). The
 * keys name the app's own screens (not content); which tags each one suggests is the owner's setting.
 */
export const HELP_ROUTE_KEYS = [
  'home',
  'board',
  'item',
  'doc',
  'dashboard',
  'workspace',
  'automations',
  'flows',
  'agents',
  'my_work',
  'inbox',
  'admin',
  'profile',
  'support',
  'trash',
  'archive',
] as const;
export type HelpRouteKey = (typeof HELP_ROUTE_KEYS)[number];

/** The route key of an app path (`/a/<slug>/b/<id>` → board). Unknown paths are `home`. */
export const helpRouteOf = (pathname: string): HelpRouteKey => {
  const rest = pathname.replace(/^\/a\/[^/]+/, '');
  // An item's card opens over its board (`/b/<board>/i/<item>`): that screen is the item's.
  if (/^\/b\/[^/]+\/i\/[^/]+/.test(rest)) return 'item';
  const first = rest.split('/').filter(Boolean)[0] ?? '';
  const map: Record<string, HelpRouteKey> = {
    b: 'board',
    i: 'item',
    d: 'doc',
    dash: 'dashboard',
    w: 'workspace',
    automations: 'automations',
    flows: 'flows',
    agents: 'agents',
    'my-work': 'my_work',
    inbox: 'inbox',
    admin: 'admin',
    settings: 'profile',
    profile: 'profile',
    me: 'profile',
    support: 'support',
    // The knowledge center page (`/a/<slug>/help`) and the guided tours' list (`/a/<slug>/tours`) are part of support.
    help: 'support',
    tours: 'support',
    trash: 'trash',
    archive: 'archive',
  };
  return map[first] ?? 'home';
};

const tagSchema = z.string().trim().min(1).max(40);
const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u, 'invalid_slug');

/** A slug from a title: letters (any script) and digits joined by dashes. */
export const helpSlugOf = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'article';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const helpAiPlatformSchema = z.object({
  /** The platform's own AI connection answers the help assistant (paid by the platform). */
  enabled: z.boolean().default(false),
  provider: z.enum(AI_PROVIDERS).nullable().default(null),
  /** Sealed (lib/secrets) — never sent to the browser. */
  key_enc: z.string().nullable().default(null),
  key_hint: z.string().nullable().default(null),
  base_url: z.string().max(500).nullable().default(null),
  model: z.string().max(120).nullable().default(null),
  /** The id usage is logged under (`ai_usage.connection_id`, source `help`); made when the key is first saved. */
  connection_id: z.string().nullable().default(null),
  /** USD per account per month the platform pays for help answers (an account may have its own cap). */
  default_cap_usd: z.number().min(0).max(100_000).default(1),
  /** Shown when an account used its cap (empty = the app's default text); the panel then goes to the form. */
  cap_message: z.string().max(500).default(''),
  /** How many article passages the assistant reads per question. */
  max_passages: z.number().int().min(1).max(20).default(6),
  /** Accounts may answer with their own AI connection instead (their admin chooses, unless the owner locked it). */
  own_connection_allowed: z.boolean().default(true),
});

const helpFlowSchema = z.object({
  /** Offer articles before the ticket form (search + suggestions while typing). */
  show_articles: z.boolean().default(true),
  /** Offer "ask the assistant" (only where the plan includes AI and a connection is available). */
  show_assistant: z.boolean().default(true),
  /** How many articles are suggested. */
  max_suggestions: z.number().int().min(1).max(10).default(3),
});

export const helpRouteTagsSchema = z.object({ route: z.enum(HELP_ROUTE_KEYS), tags: z.array(tagSchema).max(30) });

export const helpAiKnowledgeSchema = z.object({
  ai_only_tag: z.string().trim().min(1).max(40).nullable().default(null),
  guide_category_id: z.string().max(26).nullable().default(null),
});

/** Owner console → Support → Knowledge → Settings (`platform_settings` row `help_center`). */
export const helpCenterSettingsSchema = z.object({
  /** Off = no help panel, no suggestions, no public help center. */
  enabled: z.boolean().default(true),
  /** The public help center (articles marked "everyone", no sign-in). */
  public_enabled: z.boolean().default(true),
  flow: helpFlowSchema.default(() => helpFlowSchema.parse({})),
  /** Screen → tags: the "?" panel suggests articles with these tags on that screen. */
  route_tags: z.array(helpRouteTagsSchema).max(HELP_ROUTE_KEYS.length).default([]),
  /** Support roles that may write articles (the owner always may). */
  write_roles: z.array(z.enum(SUPPORT_STAFF_ROLES)).default(['agent', 'lead']),
  /** Support roles that may publish (the owner always may). */
  publish_roles: z.array(z.enum(SUPPORT_STAFF_ROLES)).default(['lead']),
  /** White-label of the public help center (empty = the platform's product name / no logo / the app's address). */
  logo_url: z.string().url().max(500).nullable().default(null),
  base_url: z.string().url().max(500).nullable().default(null),
  ai: helpAiPlatformSchema.default(() => helpAiPlatformSchema.parse({})),
  /** "First steps": the self-ticking checklist and its steps. */
  first_steps: checklistSettingsSchema.default(() => checklistSettingsSchema.parse({})),
  /**
   * Product knowledge for AI: published articles carrying `ai_only_tag` are read by the AI (the
   * assistant, agents, AI apps) and hidden from people; `guide_category_id` = the category an AI app gets as its
   * "how to work with the product" guide.
   */
  ai_knowledge: helpAiKnowledgeSchema.default(() => helpAiKnowledgeSchema.parse({})),
});
export type HelpCenterSettings = z.infer<typeof helpCenterSettingsSchema>;

/** The settings as the console sees them: the key is never sent back (only whether there is one, and its hint). */
export const helpCenterSettingsDtoSchema = helpCenterSettingsSchema
  .extend({
    ai: helpAiPlatformSchema.omit({ key_enc: true }).extend({ has_key: z.boolean() }),
  })
  .meta({ id: 'HelpCenterSettings' });
export type HelpCenterSettingsDto = z.infer<typeof helpCenterSettingsDtoSchema>;

export const updateHelpCenterSettingsSchema = z
  .object({
    enabled: z.boolean(),
    public_enabled: z.boolean(),
    flow: helpFlowSchema.partial(),
    route_tags: z.array(helpRouteTagsSchema).max(HELP_ROUTE_KEYS.length),
    write_roles: z.array(z.enum(SUPPORT_STAFF_ROLES)),
    publish_roles: z.array(z.enum(SUPPORT_STAFF_ROLES)),
    logo_url: z.string().url().max(500).nullable(),
    base_url: z.string().url().max(500).nullable(),
    ai: z
      .object({
        enabled: z.boolean(),
        provider: z.enum(AI_PROVIDERS).nullable(),
        /** Write-only; null removes the key. */
        api_key: z.string().max(500).nullable(),
        base_url: z.string().url().max(500).nullable(),
        model: z.string().max(120).nullable(),
        default_cap_usd: z.number().min(0).max(100_000),
        cap_message: z.string().max(500),
        max_passages: z.number().int().min(1).max(20),
        own_connection_allowed: z.boolean(),
      })
      .partial(),
    first_steps: checklistSettingsSchema.partial(),
    ai_knowledge: helpAiKnowledgeSchema.partial(),
  })
  .partial()
  .meta({ id: 'UpdateHelpCenterSettings' });
export type UpdateHelpCenterSettings = z.infer<typeof updateHelpCenterSettingsSchema>;

export const HELP_AI_SOURCES = ['platform', 'own'] as const;
export type HelpAiSource = (typeof HELP_AI_SOURCES)[number];

/** `settings.help_ai` of an account: which AI connection answers its help assistant. */
export const accountHelpAiSchema = z.object({
  /** `platform` = the platform's connection with a monthly cap (default); `own` = one of the account's connections. */
  source: z.enum(HELP_AI_SOURCES).default('platform'),
  connection_id: z.string().nullable().default(null),
  /** The owner's cap for this account (USD / month); null = the platform's default cap. */
  cap_usd: z.number().min(0).max(100_000).nullable().default(null),
  /** The owner may fix the source so the account's admins cannot change it. */
  locked: z.boolean().default(false),
  /**
   * The account admin's own switch for the help assistant (decision b): off = no help assistant in this account, even
   * on the platform's connection. Default on — the account's general AI switch (`settings.ai.enabled`, default off)
   * cannot tell "turned off" from "never decided", so it gates only the account's own connection.
   */
  allowed: z.boolean().default(true),
});
export type AccountHelpAi = z.infer<typeof accountHelpAiSchema>;

export const accountHelpAiDtoSchema = accountHelpAiSchema
  .extend({
    /** The cap in force (the account's, else the platform's). */
    effective_cap_usd: z.number(),
    /** Spent this month on the platform's connection. */
    used_usd: z.number(),
    /** May the account's admins switch to their own connection? */
    own_allowed: z.boolean(),
  })
  .meta({ id: 'AccountHelpAi' });
export type AccountHelpAiDto = z.infer<typeof accountHelpAiDtoSchema>;

/** An account admin: the source and the connection (only when the owner allows and did not lock it). */
export const updateAccountHelpAiSchema = z
  .object({ source: z.enum(HELP_AI_SOURCES), connection_id: z.string().nullable(), allowed: z.boolean() })
  .partial()
  .meta({ id: 'UpdateAccountHelpAi' });
/** The owner / a lead: everything, the cap and the lock too. */
export const updateAccountHelpAiByOwnerSchema = z
  .object({
    source: z.enum(HELP_AI_SOURCES),
    connection_id: z.string().nullable(),
    cap_usd: z.number().min(0).max(100_000).nullable(),
    locked: z.boolean(),
    allowed: z.boolean(),
  })
  .partial()
  .meta({ id: 'UpdateAccountHelpAiByOwner' });

// ---------------------------------------------------------------------------
// Practical guides: an article of kind `guide` carries a short video (a help video, or a YouTube /
// Vimeo address), its captions and chapters, and numbered steps — one sentence and one screenshot with a marker
// each. Stored beside the rich text (`guide` the working copy, `published_guide` what readers see).
// ---------------------------------------------------------------------------
export const HELP_ARTICLE_KINDS = ['article', 'guide'] as const;
export type HelpArticleKind = (typeof HELP_ARTICLE_KINDS)[number];

/** A YouTube / Vimeo address → the player address shown in the guide (null = not one we embed). */
export const helpVideoEmbedUrl = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const id = (s: string | null | undefined) => (s && /^[\w-]{6,20}$/.test(s) ? s : null);
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = id(u.searchParams.get('v')) ?? id(/^\/(?:embed|shorts)\/([\w-]+)/.exec(u.pathname)?.[1]);
    return v ? `https://www.youtube-nocookie.com/embed/${v}?rel=0` : null;
  }
  if (host === 'youtu.be') {
    const v = id(u.pathname.slice(1));
    return v ? `https://www.youtube-nocookie.com/embed/${v}?rel=0` : null;
  }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const v = /\/(?:video\/)?(\d{5,12})(?:$|[/?#])/.exec(u.pathname + '/')?.[1];
    return v ? `https://player.vimeo.com/video/${v}` : null;
  }
  return null;
};

export const helpChapterSchema = z.object({
  /** Seconds from the start. */
  at: z.number().int().min(0).max(36_000),
  title: z.string().trim().min(1).max(120),
});
export type HelpChapter = z.infer<typeof helpChapterSchema>;

export const helpGuideVideoSchema = z.object({
  /** A help video (mp4 / webm) — or `url`, a YouTube / Vimeo address. */
  asset_id: z.string().nullable().default(null),
  url: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .default(null)
    .refine((v) => v === null || !!helpVideoEmbedUrl(v), 'help_video_url'),
  /** The still shown before it plays (a help image). */
  poster_id: z.string().nullable().default(null),
  /** WebVTT captions per language (help files). */
  captions: z
    .array(z.object({ locale: z.enum(HELP_LOCALES), asset_id: z.string() }))
    .max(HELP_LOCALES.length)
    .default([]),
  chapters: z.array(helpChapterSchema).max(30).default([]),
  /** Seconds (the editor reads it from the file). */
  duration: z.number().int().min(0).max(36_000).nullable().default(null),
});
export type HelpGuideVideo = z.infer<typeof helpGuideVideoSchema>;

export const helpGuideStepSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  /** A help image (the screenshot). */
  image_id: z.string().nullable().default(null),
  /** Where on the screenshot the numbered marker stands (0–1 from the left / top). */
  marker: z
    .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
    .nullable()
    .default(null),
});
export type HelpGuideStep = z.infer<typeof helpGuideStepSchema>;

export const helpGuideSchema = z
  .object({
    video: helpGuideVideoSchema.nullable().default(null),
    steps: z.array(helpGuideStepSchema).max(40).default([]),
  })
  .meta({ id: 'HelpGuide' });
export type HelpGuide = z.infer<typeof helpGuideSchema>;
export type HelpGuideInput = z.input<typeof helpGuideSchema>;

/** A guide as readers get it: every file as its address (videos and images by redirect, captions as text). */
export const helpGuideViewSchema = z
  .object({
    video: z
      .object({
        src: z.string().nullable(),
        /** The YouTube / Vimeo player address (instead of `src`). */
        embed_url: z.string().nullable(),
        poster: z.string().nullable(),
        captions: z.array(z.object({ locale: z.enum(HELP_LOCALES), src: z.string() })),
        chapters: z.array(helpChapterSchema),
        duration: z.number().int().nullable(),
      })
      .nullable(),
    steps: z.array(
      z.object({
        text: z.string(),
        image: z.string().nullable(),
        marker: z.object({ x: z.number(), y: z.number() }).nullable(),
      }),
    ),
  })
  .meta({ id: 'HelpGuideView' });
export type HelpGuideView = z.infer<typeof helpGuideViewSchema>;

// ---------------------------------------------------------------------------
// Categories & articles (console)
// ---------------------------------------------------------------------------
export const helpCategorySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    name_en: z.string().nullable(),
    icon: z.string().nullable(),
    position: z.number().int(),
    archived: z.boolean(),
  })
  .meta({ id: 'HelpCategory' });
export type HelpCategory = z.infer<typeof helpCategorySchema>;

export const upsertHelpCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    name_en: z.string().trim().max(80).nullable().optional(),
    icon: z.string().trim().max(40).nullable().optional(),
    position: z.number().int().min(0).max(10_000).optional(),
    archived: z.boolean().optional(),
  })
  .meta({ id: 'UpsertHelpCategory' });

export const helpArticleSummarySchema = z
  .object({
    id: z.string(),
    group_id: z.string(),
    locale: z.enum(HELP_LOCALES),
    slug: z.string(),
    title: z.string(),
    excerpt: z.string(),
    category_id: z.string().nullable(),
    tags: z.array(z.string()),
    visibility: z.enum(HELP_VISIBILITIES),
    status: z.enum(HELP_STATUSES),
    /** Saved changes not yet published. */
    unpublished_changes: z.boolean(),
    version: z.number().int(),
    published_version: z.number().int().nullable(),
    published_at: z.string().nullable(),
    updated_at: z.string(),
    helpful_yes: z.number().int(),
    helpful_no: z.number().int(),
    views: z.number().int(),
    source_ticket_id: z.string().nullable(),
    kind: z.enum(HELP_ARTICLE_KINDS),
    /** The guided tour "show me in the app" starts. */
    tour_id: z.string().nullable(),
  })
  .meta({ id: 'HelpArticleSummary' });
export type HelpArticleSummary = z.infer<typeof helpArticleSummarySchema>;

export const helpArticleDetailSchema = helpArticleSummarySchema
  .extend({
    content: richNodeSchema,
    /** The working copy of a guide's video and steps (kind `guide`). */
    guide: helpGuideSchema.nullable(),
    /** The other languages of the same article (translation group). */
    translations: z.array(z.object({ id: z.string(), locale: z.enum(HELP_LOCALES), title: z.string() })),
  })
  .meta({ id: 'HelpArticleDetail' });
export type HelpArticleDetail = z.infer<typeof helpArticleDetailSchema>;

export const createHelpArticleSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    slug: slugSchema.optional(),
    locale: z.enum(HELP_LOCALES).default('he'),
    excerpt: z.string().trim().max(300).optional(),
    category_id: z.string().nullable().optional(),
    tags: z.array(tagSchema).max(30).optional(),
    visibility: z.enum(HELP_VISIBILITIES).default('signed_in'),
    content: richNodeSchema.optional(),
    kind: z.enum(HELP_ARTICLE_KINDS).default('article'),
    guide: helpGuideSchema.nullable().optional(),
    tour_id: z.string().nullable().optional(),
    /** A translation of this article (same group, the other language). */
    translation_of: z.string().optional(),
  })
  .meta({ id: 'CreateHelpArticle' });
export type CreateHelpArticle = z.input<typeof createHelpArticleSchema>;

export const updateHelpArticleSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    slug: slugSchema,
    excerpt: z.string().trim().max(300),
    category_id: z.string().nullable(),
    tags: z.array(tagSchema).max(30),
    visibility: z.enum(HELP_VISIBILITIES),
    content: richNodeSchema,
    kind: z.enum(HELP_ARTICLE_KINDS),
    guide: helpGuideSchema.nullable(),
    tour_id: z.string().nullable(),
  })
  .partial()
  .meta({ id: 'UpdateHelpArticle' });
export type UpdateHelpArticle = z.infer<typeof updateHelpArticleSchema>;

export const helpArticleFilterSchema = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(HELP_STATUSES).optional(),
  locale: z.enum(HELP_LOCALES).optional(),
  category_id: z.string().optional(),
  kind: z.enum(HELP_ARTICLE_KINDS).optional(),
});

export const helpArticleVersionSchema = z
  .object({
    id: z.string(),
    version: z.number().int(),
    kind: z.enum(['save', 'publish', 'restore']),
    title: z.string(),
    created_at: z.string(),
    created_by_name: z.string().nullable(),
  })
  .meta({ id: 'HelpArticleVersion' });

export const helpConsoleConfigSchema = z
  .object({
    role: z.enum(['owner', 'agent', 'lead']),
    may_write: z.boolean(),
    may_publish: z.boolean(),
    may_configure: z.boolean(),
    settings: helpCenterSettingsDtoSchema,
    categories: z.array(helpCategorySchema),
    /** Every tag used by an article (the pickers offer them). */
    tags: z.array(z.string()),
  })
  .meta({ id: 'HelpConsoleConfig' });
export type HelpConsoleConfig = z.infer<typeof helpConsoleConfigSchema>;

const countStat = z.object({ id: z.string(), title: z.string(), locale: z.string(), count: z.number().int() });
export const helpMetricsSchema = z
  .object({
    days: z.number().int(),
    searches: z.number().int(),
    zero_result_searches: z.number().int(),
    views: z.number().int(),
    helpful_yes: z.number().int(),
    helpful_no: z.number().int(),
    deflected: z.number().int(),
    tickets_opened: z.number().int(),
    /** deflected / (deflected + tickets opened after seeing help); null without either. */
    deflection_rate: z.number().nullable(),
    ai_answers: z.number().int(),
    ai_not_found: z.number().int(),
    /** The "missing articles" list: what people searched for and found nothing. */
    zero_result_queries: z.array(z.object({ query: z.string(), count: z.number().int() })),
    articles: z.array(
      countStat.omit({ count: true }).extend({
        views: z.number().int(),
        helpful_yes: z.number().int(),
        helpful_no: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'HelpMetrics' });
export type HelpMetrics = z.infer<typeof helpMetricsSchema>;

// ---------------------------------------------------------------------------
// Readers (the app's help panel, ticket suggestions, the public help center)
// ---------------------------------------------------------------------------
export const helpHitSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    locale: z.enum(HELP_LOCALES),
    title: z.string(),
    excerpt: z.string(),
    category_id: z.string().nullable(),
    tags: z.array(z.string()),
    /** The article's public address, for links in emails and tickets (the help center's address when set). */
    url: z.string(),
    kind: z.enum(HELP_ARTICLE_KINDS),
    /** A guide's video length (seconds), its still and how many steps it has — the guide cards. */
    duration: z.number().int().nullable(),
    poster: z.string().nullable(),
    step_count: z.number().int(),
  })
  .meta({ id: 'HelpHit' });
export type HelpHit = z.infer<typeof helpHitSchema>;

/**
 * The public address of a help article (decision a): `<base>/help?article=<slug>` (+ `&locale=en`), where the base
 * is the help center's address from its settings (`base_url`) when set, else the app's own address. Every article
 * link the API hands out (search hits, suggestions, articles, the assistant's citations) is built here, so a link
 * copied into an email or a ticket points at the help center's address.
 */
export const helpArticleUrl = (base: string, slug: string, locale: HelpLocale) => {
  const q = new URLSearchParams({ article: slug });
  if (locale === 'en') q.set('locale', 'en');
  return `${base.replace(/\/+$/, '')}/help?${q.toString()}`;
};

export const helpArticleViewSchema = helpHitSchema
  .extend({
    /** Rendered from the published content with the rich-text allowlist (never stored HTML from a browser). */
    html: z.string(),
    visibility: z.enum(HELP_VISIBILITIES),
    published_at: z.string().nullable(),
    translations: z.array(z.object({ slug: z.string(), locale: z.enum(HELP_LOCALES), title: z.string() })),
    /** A guide's video and steps (kind `guide`). */
    guide: helpGuideViewSchema.nullable(),
    /** The published tour "show me in the app" starts (null = none). */
    tour_id: z.string().nullable(),
  })
  .meta({ id: 'HelpArticleView' });
export type HelpArticleView = z.infer<typeof helpArticleViewSchema>;

export const HELP_ASSISTANT_OFF_REASONS = [
  'disabled',
  'plan',
  'not_configured',
  'cap_reached',
  'ai_disabled',
  'account_off',
] as const;

export const helpOptionsSchema = z
  .object({
    enabled: z.boolean(),
    show_articles: z.boolean(),
    max_suggestions: z.number().int(),
    /** May this person ask the help assistant now? */
    assistant: z.boolean(),
    /** Why not (the panel shows the cap message and goes to the form). */
    assistant_off_reason: z.enum(HELP_ASSISTANT_OFF_REASONS).nullable(),
    cap_message: z.string(),
    locale: z.enum(HELP_LOCALES),
    categories: z.array(helpCategorySchema),
    /** Published articles this person may read, per category id (the knowledge center page's category cards). */
    category_counts: z.record(z.string(), z.number().int()),
  })
  .meta({ id: 'HelpOptions' });
export type HelpOptions = z.infer<typeof helpOptionsSchema>;

export const helpSearchQuerySchema = z.object({
  q: z.string().max(200).optional(),
  route: z.enum(HELP_ROUTE_KEYS).optional(),
  category_id: z.string().optional(),
  locale: z.enum(HELP_LOCALES).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  /** `typing` = suggestions while typing a ticket subject (not counted as a search until it is final). */
  mode: z.enum(['search', 'typing']).optional(),
  /** Only guides (the knowledge center's "practical guides" row). */
  kind: z.enum(HELP_ARTICLE_KINDS).optional(),
});

export const helpFeedbackSchema = z.object({ helpful: z.boolean() }).meta({ id: 'HelpFeedback' });
export const helpEventSchema = z
  .object({
    kind: z.enum(HELP_CLIENT_EVENTS),
    article_id: z.string().nullable().optional(),
    query: z.string().max(200).optional(),
  })
  .meta({ id: 'HelpEvent' });

export const helpAskSchema = z.object({ question: z.string().trim().min(3).max(1000) }).meta({ id: 'HelpAsk' });
export const helpAnswerSchema = z
  .object({
    /** False = the articles do not answer it: the panel says so and offers the ticket form. */
    found: z.boolean(),
    answer: z.string().nullable(),
    citations: z.array(z.object({ id: z.string(), slug: z.string(), title: z.string(), url: z.string() })),
  })
  .meta({ id: 'HelpAnswer' });
export type HelpAnswer = z.infer<typeof helpAnswerSchema>;

export const helpCenterInfoSchema = z
  .object({
    enabled: z.boolean(),
    product_name: z.string(),
    logo_url: z.string().nullable(),
    categories: z.array(helpCategorySchema),
  })
  .meta({ id: 'HelpCenterInfo' });
export type HelpCenterInfo = z.infer<typeof helpCenterInfoSchema>;

// ---------------------------------------------------------------------------
// Images & the package import / export (kb-import)
// ---------------------------------------------------------------------------

/** Image types an article may hold (checked by their first bytes, not the name). */
export const HELP_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type HelpImageType = (typeof HELP_IMAGE_TYPES)[number];
/** A guide's video: checked by its first bytes too. */
export const HELP_VIDEO_TYPES = ['video/mp4', 'video/webm'] as const;
export type HelpVideoType = (typeof HELP_VIDEO_TYPES)[number];
/** Every file the knowledge center stores: images, guide videos and their WebVTT captions. */
export const HELP_FILE_TYPES = [...HELP_IMAGE_TYPES, ...HELP_VIDEO_TYPES, 'text/vtt'] as const;
export type HelpFileType = (typeof HELP_FILE_TYPES)[number];

export const HELP_IMPORT_LIMITS = {
  /** One image (an upload in the editor or one file of a package). */
  imageBytes: 4 * 1024 * 1024,
  /** One guide video (a minute or two of a screen recording). */
  videoBytes: 60 * 1024 * 1024,
  /** One captions file (WebVTT). */
  captionBytes: 512 * 1024,
  /** One import request (a .zip or several .md files) — and one video upload. */
  requestBytes: 80 * 1024 * 1024,
  /** Everything a .zip unpacks to. */
  unpackedBytes: 200 * 1024 * 1024,
  /** Files in one package. */
  files: 1000,
  /** Articles in one package. */
  articles: 500,
  /** One article's Markdown (characters). */
  markdownChars: 200_000,
} as const;

/** Where an article's image is served (a public redirect to a short-lived storage link). */
export const helpAssetPath = (id: string) => `/api/v1/help/assets/${encodeURIComponent(id)}`;

export const helpAssetSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    content_type: z.enum(HELP_FILE_TYPES),
    size: z.number().int(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    /** True = the same image was already stored (same bytes): no copy was made. */
    reused: z.boolean(),
  })
  .meta({ id: 'HelpAsset' });
export type HelpAsset = z.infer<typeof helpAssetSchema>;

export const HELP_IMPORT_OUTCOMES = ['new', 'updated', 'unchanged', 'error', 'skipped'] as const;
export type HelpImportOutcome = (typeof HELP_IMPORT_OUTCOMES)[number];

export const helpImportFileSchema = z.object({
  /** The file's path inside the package (or its name). */
  path: z.string(),
  outcome: z.enum(HELP_IMPORT_OUTCOMES),
  title: z.string().nullable(),
  slug: z.string().nullable(),
  locale: z.enum(HELP_LOCALES).nullable(),
  article_id: z.string().nullable(),
  /** Published by this import (or would be, in a preview). */
  published: z.boolean(),
  /** An error code (`help_import_*`, `help_slug_taken`, `help_translation_exists` …) when outcome = error. */
  error: z.string().nullable(),
  /** Things done differently than asked (an image missing from the package, a category not found …). */
  warnings: z.array(z.string()),
});
export type HelpImportFile = z.infer<typeof helpImportFileSchema>;

export const helpImportReportSchema = z
  .object({
    dry_run: z.boolean(),
    counts: z.object({
      new: z.number().int(),
      updated: z.number().int(),
      unchanged: z.number().int(),
      errors: z.number().int(),
      published: z.number().int(),
    }),
    categories: z.object({ created: z.number().int(), matched: z.number().int() }),
    images: z.object({ new: z.number().int(), reused: z.number().int() }),
    /** Guided tours of the package's tours.json. */
    tours: z.object({
      new: z.number().int(),
      updated: z.number().int(),
      unchanged: z.number().int(),
      errors: z.number().int(),
    }),
    /** Screens whose tags the package set. */
    screens: z.array(z.string()),
    /** Problems with the package itself (categories.json, screens.json …). */
    warnings: z.array(z.string()),
    files: z.array(helpImportFileSchema),
  })
  .meta({ id: 'HelpImportReport' });
export type HelpImportReport = z.infer<typeof helpImportReportSchema>;
