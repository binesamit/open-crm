// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { DEFAULT_REGION } from '../locale';
import { SUPPORT_MODES, supportHoursSchema } from './support';

/**
 * Support tickets (stages 1–5): customers (account members) open tickets from the app; the platform's
 * support staff (agent / lead) work them in the owner console's "Support" section. Platform-level data, never an
 * account board. Staff see what the customer wrote and attached — never the account's data without a support grant,
 * which an account admin approves from the ticket (one click, the existing grant mechanism, linked to the ticket).
 * Every behaviour is a setting (helpdesk settings in the owner console, `support_tickets` in the account settings).
 */

export const TICKET_STATUSES = ['new', 'open', 'pending_customer', 'on_hold', 'solved', 'closed'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
/** Statuses that stop the resolution timer (waiting for the customer, or on hold). */
export const SLA_PAUSED_STATUSES: readonly TicketStatus[] = ['pending_customer', 'on_hold'];
/** Statuses that end support access given from the ticket. */
export const TICKET_DONE_STATUSES: readonly TicketStatus[] = ['solved', 'closed'];

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

/** Platform support roles: an agent works tickets; a lead also manages queues, SLA, replies, tags and settings. */
export const SUPPORT_STAFF_ROLES = ['agent', 'lead'] as const;
export type SupportStaffRole = (typeof SUPPORT_STAFF_ROLES)[number];
/** Who opened the console: the platform owner (everything), or a support person by role. */
export type SupportConsoleRole = 'owner' | SupportStaffRole;

export const TICKET_MESSAGE_KINDS = ['customer', 'staff', 'system'] as const;
export const TICKET_VISIBILITIES = ['public', 'internal'] as const;
export type TicketVisibility = (typeof TICKET_VISIBILITIES)[number];

export const ACCESS_REQUEST_STATUSES = ['pending', 'approved', 'declined', 'cancelled', 'expired'] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'invalid_time');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'invalid_date');

export const businessHoursSchema = z.object({
  timezone: z.string().min(1).max(64).default(DEFAULT_REGION.timezone),
  days: z
    .array(z.object({ day: z.number().int().min(0).max(6), start: hhmm, end: hhmm }))
    .max(21)
    .default(() => [0, 1, 2, 3, 4].map((day) => ({ day, start: '09:00', end: '17:00' }))),
  holidays: z.array(isoDate).max(366).default([]),
});

const accessDefaultsSchema = z.object({
  /** What a support person's request starts on (the request form; edit only on explicit choice). */
  default_mode: z.enum(SUPPORT_MODES).default('view'),
  default_duration_hours: supportHoursSchema.default(4),
  /** An unanswered request lapses after this many hours. */
  request_expires_hours: z.number().int().min(1).max(720).default(72),
});

const ticketEmailSchema = z.object({
  customer_on_create: z.boolean().default(true),
  customer_on_reply: z.boolean().default(true),
  customer_on_status: z.boolean().default(true),
  staff_on_new: z.boolean().default(true),
  staff_on_customer_reply: z.boolean().default(true),
  staff_on_breach: z.boolean().default(true),
});

/** What the app may attach to a new ticket by itself (the person still sees and can remove each item). */
const ticketContextSettingsSchema = z.object({
  page: z.boolean().default(true),
  browser: z.boolean().default(true),
  errors: z.boolean().default(true),
  max_errors: z.number().int().min(0).max(20).default(10),
});

/** Owner console → Support → Settings (`platform_settings` row `helpdesk`). */
export const helpdeskSettingsSchema = z.object({
  /** Off = the "?" menu offers no "open a ticket" and the API refuses new tickets. */
  enabled: z.boolean().default(true),
  /** The first ticket number (numbers are sequential per platform). */
  number_start: z.number().int().min(1).max(1_000_000_000).default(1000),
  default_priority: z.enum(TICKET_PRIORITIES).default('normal'),
  business_hours: businessHoursSchema.default(() => businessHoursSchema.parse({})),
  access: accessDefaultsSchema.default(() => accessDefaultsSchema.parse({})),
  email: ticketEmailSchema.default(() => ticketEmailSchema.parse({})),
  csat: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  context: ticketContextSettingsSchema.default(() => ticketContextSettingsSchema.parse({})),
  /** Added under every public staff reply in emails (empty = none). */
  signature: z.string().max(1000).default(''),
  /** Show help articles before the ticket form (the knowledge center plugs in here; no-op until it exists). */
  suggest_articles: z.boolean().default(true),
});
export type HelpdeskSettings = z.infer<typeof helpdeskSettingsSchema>;

export const updateHelpdeskSettingsSchema = z
  .object({
    enabled: z.boolean(),
    number_start: z.number().int().min(1).max(1_000_000_000),
    default_priority: z.enum(TICKET_PRIORITIES),
    business_hours: z.object({
      timezone: z.string().min(1).max(64),
      days: z.array(z.object({ day: z.number().int().min(0).max(6), start: hhmm, end: hhmm })).max(21),
      holidays: z.array(isoDate).max(366),
    }),
    access: accessDefaultsSchema.partial(),
    email: ticketEmailSchema.partial(),
    csat: z.object({ enabled: z.boolean() }).partial(),
    context: ticketContextSettingsSchema.partial(),
    signature: z.string().max(1000),
    suggest_articles: z.boolean(),
  })
  .partial()
  .meta({ id: 'UpdateHelpdeskSettings' });
export type UpdateHelpdeskSettings = z.infer<typeof updateHelpdeskSettingsSchema>;

export const TICKET_OPENERS = ['admins', 'members'] as const;
/** Administration → Security → Support tickets (`settings.support_tickets` of the account). */
export const accountTicketSettingsSchema = z.object({
  /** Who may open tickets: every member (default) or admins only. Guests never. */
  who_can_open: z.enum(TICKET_OPENERS).default('members'),
  /** Members see their own tickets (`own`) or every ticket of the account (`all`); admins always see all. */
  members_see: z.enum(['own', 'all']).default('own'),
});
export type AccountTicketSettings = z.infer<typeof accountTicketSettingsSchema>;
export const updateAccountTicketSettingsSchema = accountTicketSettingsSchema.partial();

// ---------------------------------------------------------------------------
// Customer side
// ---------------------------------------------------------------------------
export const clientErrorSchema = z.object({
  message: z.string().max(500),
  at: z.string().max(40),
  source: z.string().max(300).optional(),
  area: z.string().max(40).optional(),
});
export type ClientError = z.infer<typeof clientErrorSchema>;

/** What the app attaches by itself — only what the person saw in the form and kept. Never board content. */
export const ticketContextSchema = z
  .object({
    page_url: z.string().max(2000),
    user_agent: z.string().max(500),
    browser: z.string().max(80),
    os: z.string().max(80),
    screen: z.string().max(40),
    app_version: z.string().max(80),
    errors: z.array(clientErrorSchema).max(20),
  })
  .partial();
export type TicketContext = z.infer<typeof ticketContextSchema>;

export const createTicketSchema = z
  .object({
    subject: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(20_000),
    category_id: z.string().nullable().optional(),
    priority: z.enum(TICKET_PRIORITIES).optional(),
    /** Files uploaded with POST /files/presign (+ complete) by the same person. */
    attachment_ids: z.array(z.string()).max(10).default([]),
    context: ticketContextSchema.optional(),
  })
  .meta({ id: 'CreateTicket' });
export type CreateTicket = z.input<typeof createTicketSchema>;

export const ticketReplySchema = z
  .object({
    body: z.string().trim().min(1).max(20_000),
    attachment_ids: z.array(z.string()).max(10).default([]),
  })
  .meta({ id: 'TicketReply' });

export const ticketRatingSchema = z
  .object({ rating: z.number().int().min(1).max(5), comment: z.string().trim().max(2000).optional() })
  .meta({ id: 'TicketRating' });

const person = z.object({ id: z.string().nullable(), name: z.string() });

export const ticketAttachmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  size: z.number(),
  mime: z.string(),
});

/**
 * A knowledge-center article support attached to a reply: read live from the article (its published
 * title and excerpt), and only while the customer may read it — an unpublished or deleted article drops out.
 */
export const ticketArticleSchema = z
  .object({
    id: z.string(),
    slug: z.string(),
    locale: z.string(),
    title: z.string(),
    excerpt: z.string(),
    /** The article's address in the help center (emails); the app opens it in its knowledge center by id. */
    url: z.string(),
  })
  .meta({ id: 'TicketArticle' });
export type TicketArticle = z.infer<typeof ticketArticleSchema>;

/** Articles one reply may carry. */
export const TICKET_REPLY_MAX_ARTICLES = 5;

/** The console's "attach an article" picker: what the ticket's customer may read (`enabled` = the help center is on). */
export const ticketArticleListSchema = z
  .object({ enabled: z.boolean(), data: z.array(ticketArticleSchema) })
  .meta({ id: 'TicketArticleList' });
export type TicketArticleList = z.infer<typeof ticketArticleListSchema>;

export const ticketMessageSchema = z
  .object({
    id: z.string(),
    kind: z.enum(TICKET_MESSAGE_KINDS),
    visibility: z.enum(TICKET_VISIBILITIES),
    body: z.string(),
    author: person.nullable(),
    created_at: z.string(),
    attachments: z.array(ticketAttachmentSchema),
    articles: z.array(ticketArticleSchema),
  })
  .meta({ id: 'TicketMessage' });
export type TicketMessage = z.infer<typeof ticketMessageSchema>;

export const accessRequestSchema = z
  .object({
    id: z.string(),
    ticket_id: z.string(),
    mode: z.enum(SUPPORT_MODES),
    duration_hours: z.number().int(),
    reason: z.string(),
    status: z.enum(ACCESS_REQUEST_STATUSES),
    requested_by: person,
    created_at: z.string(),
    expires_at: z.string(),
    decided_at: z.string().nullable(),
    decided_by_name: z.string().nullable(),
    grant_id: z.string().nullable(),
    /** The grant's own state once approved (it may have been revoked or expired since). */
    grant_status: z.enum(['active', 'expired', 'revoked']).nullable(),
    grant_expires_at: z.string().nullable(),
  })
  .meta({ id: 'TicketAccessRequest' });
export type AccessRequest = z.infer<typeof accessRequestSchema>;

const named = z.object({ id: z.string(), name: z.string() });

export const ticketSlaSchema = z.object({
  first_response_due_at: z.string().nullable(),
  resolution_due_at: z.string().nullable(),
  first_responded_at: z.string().nullable(),
  first_response_breached: z.boolean(),
  resolution_breached: z.boolean(),
  paused: z.boolean(),
});
export type TicketSla = z.infer<typeof ticketSlaSchema>;

export const ticketSummarySchema = z
  .object({
    id: z.string(),
    number: z.number().int(),
    subject: z.string(),
    status: z.enum(TICKET_STATUSES),
    priority: z.enum(TICKET_PRIORITIES),
    category: named.nullable(),
    requester: z.object({ id: z.string().nullable(), name: z.string(), email: z.string() }),
    created_at: z.string(),
    updated_at: z.string(),
    solved_at: z.string().nullable(),
    closed_at: z.string().nullable(),
    csat_rating: z.number().int().nullable(),
    /** Staff only (the console). */
    account: z.object({ id: z.string(), name: z.string(), slug: z.string() }).optional(),
    assignee: named.nullable().optional(),
    queue: named.nullable().optional(),
    tags: z.array(z.object({ id: z.string(), name: z.string(), color: z.string().nullable() })).optional(),
    sla: ticketSlaSchema.optional(),
  })
  .meta({ id: 'TicketSummary' });
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

export const ticketListSchema = z
  .object({ data: z.array(ticketSummarySchema), next_cursor: z.string().nullable() })
  .meta({ id: 'TicketList' });

export const ticketEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  actor: person.nullable(),
  data: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

export const ticketDetailSchema = ticketSummarySchema
  .extend({
    messages: z.array(ticketMessageSchema),
    context: ticketContextSchema.nullable(),
    access_requests: z.array(accessRequestSchema),
    csat_comment: z.string().nullable(),
    /** What this person may do now. */
    can: z.object({
      reply: z.boolean(),
      close: z.boolean(),
      reopen: z.boolean(),
      rate: z.boolean(),
      approve_access: z.boolean(),
    }),
    /** Staff only: the ticket's history (status, assignment, tags, access). */
    events: z.array(ticketEventSchema).optional(),
    /** Staff only: what an access request may ask for in the ticket's account (its grant rules). */
    access_options: z
      .object({
        durations_hours: z.array(z.number().int()),
        allow_edit: z.boolean(),
        default_mode: z.enum(SUPPORT_MODES),
        default_duration_hours: z.number().int(),
      })
      .optional(),
  })
  .meta({ id: 'TicketDetail' });
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

export const ticketOptionsSchema = z
  .object({
    enabled: z.boolean(),
    /** May this person open a ticket in this account (the account's setting, the role)? */
    may_open: z.boolean(),
    categories: z.array(named.extend({ default_priority: z.enum(TICKET_PRIORITIES).nullable() })),
    priorities: z.array(z.enum(TICKET_PRIORITIES)),
    default_priority: z.enum(TICKET_PRIORITIES),
    context: z.object({ page: z.boolean(), browser: z.boolean(), errors: z.boolean(), max_errors: z.number() }),
    csat: z.boolean(),
    /** The knowledge center hook: show article suggestions before the form (none exist until it is built). */
    suggest_articles: z.boolean(),
    settings: accountTicketSettingsSchema,
    is_admin: z.boolean(),
  })
  .meta({ id: 'TicketOptions' });
export type TicketOptions = z.infer<typeof ticketOptionsSchema>;

// ---------------------------------------------------------------------------
// Staff side (owner console → Support)
// ---------------------------------------------------------------------------
export const staffReplySchema = z
  .object({
    /** May be empty when the reply carries an article. */
    body: z.string().trim().max(20_000).default(''),
    visibility: z.enum(TICKET_VISIBILITIES).default('public'),
    /** Move the ticket on together with the reply (e.g. pending_customer). */
    status: z.enum(TICKET_STATUSES).optional(),
    /** Knowledge-center articles to show the customer as cards (published ones the customer may read). */
    article_ids: z.array(z.string().min(1).max(40)).max(TICKET_REPLY_MAX_ARTICLES).default([]),
  })
  .refine((r) => r.body.length > 0 || r.article_ids.length > 0, { message: 'ticket_reply_empty', path: ['body'] })
  .meta({ id: 'StaffTicketReply' });

export const updateTicketSchema = z
  .object({
    status: z.enum(TICKET_STATUSES),
    priority: z.enum(TICKET_PRIORITIES),
    category_id: z.string().nullable(),
    queue_id: z.string().nullable(),
    /** `null` unassigns. */
    assignee_id: z.string().nullable(),
    tag_ids: z.array(z.string()).max(30),
  })
  .partial()
  .meta({ id: 'UpdateTicket' });

export const createAccessRequestSchema = z
  .object({
    mode: z.enum(SUPPORT_MODES).optional(),
    duration_hours: supportHoursSchema.optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .meta({ id: 'CreateTicketAccessRequest' });

export const ticketFilterSchema = z.object({
  status: z.string().optional(),
  priority: z.string().optional(),
  category_id: z.string().optional(),
  queue_id: z.string().optional(),
  /** `me`, `none`, or a user id. */
  assignee: z.string().optional(),
  tag_id: z.string().optional(),
  account_id: z.string().optional(),
  breached: z.enum(['any', 'first_response', 'resolution']).optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const supportQueueSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    is_default: z.boolean(),
    position: z.number().int(),
    archived: z.boolean(),
  })
  .meta({ id: 'SupportQueue' });
export const upsertQueueSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  is_default: z.boolean().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  archived: z.boolean().optional(),
});

export const supportCategorySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** Routing: tickets of this category land in this queue (null = the default queue). */
    queue_id: z.string().nullable(),
    default_priority: z.enum(TICKET_PRIORITIES).nullable(),
    position: z.number().int(),
    archived: z.boolean(),
  })
  .meta({ id: 'SupportCategory' });
export const upsertCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  queue_id: z.string().nullable().optional(),
  default_priority: z.enum(TICKET_PRIORITIES).nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  archived: z.boolean().optional(),
});

export const slaPolicySchema = z
  .object({
    priority: z.enum(TICKET_PRIORITIES),
    first_response_minutes: z.number().int().min(1).max(525_600),
    resolution_minutes: z.number().int().min(1).max(525_600),
    /** Count only business hours (else around the clock). */
    business_hours: z.boolean(),
  })
  .meta({ id: 'SlaPolicy' });
export type SlaPolicy = z.infer<typeof slaPolicySchema>;
export const putSlaPoliciesSchema = z.object({ policies: z.array(slaPolicySchema).min(1).max(4) });

export const cannedReplySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    body: z.string(),
    queue_id: z.string().nullable(),
    archived: z.boolean(),
  })
  .meta({ id: 'CannedReply' });
export const upsertCannedReplySchema = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(20_000),
  queue_id: z.string().nullable().optional(),
  archived: z.boolean().optional(),
});

export const supportTagSchema = z
  .object({ id: z.string(), name: z.string(), color: z.string().nullable() })
  .meta({ id: 'SupportTag' });
export const upsertSupportTagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
});

export const supportStaffSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string().nullable(),
    user_id: z.string().nullable(),
    role: z.enum(SUPPORT_STAFF_ROLES),
    status: z.enum(['active', 'deactivated']),
    created_at: z.string(),
  })
  .meta({ id: 'SupportStaff' });
export type SupportStaff = z.infer<typeof supportStaffSchema>;
export const inviteSupportStaffSchema = z.object({
  email: z.email().toLowerCase(),
  role: z.enum(SUPPORT_STAFF_ROLES).default('agent'),
});
export const updateSupportStaffSchema = z
  .object({ role: z.enum(SUPPORT_STAFF_ROLES), status: z.enum(['active', 'deactivated']) })
  .partial();

/** GET /platform/support/config — everything the console needs to render pickers and the settings tabs. */
export const supportConsoleConfigSchema = z
  .object({
    role: z.enum(['owner', 'agent', 'lead']),
    me: z.object({ id: z.string(), name: z.string() }),
    settings: helpdeskSettingsSchema,
    queues: z.array(supportQueueSchema),
    categories: z.array(supportCategorySchema),
    sla: z.array(slaPolicySchema),
    canned: z.array(cannedReplySchema),
    tags: z.array(supportTagSchema),
    agents: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['owner', 'agent', 'lead']) })),
  })
  .meta({ id: 'SupportConsoleConfig' });
export type SupportConsoleConfig = z.infer<typeof supportConsoleConfigSchema>;

const minutesStat = z.object({
  count: z.number().int(),
  avg_minutes: z.number().nullable(),
  median_minutes: z.number().nullable(),
});
export const supportReportSchema = z
  .object({
    days: z.number().int(),
    created: z.number().int(),
    solved: z.number().int(),
    open_now: z.number().int(),
    breached_now: z.number().int(),
    first_response: minutesStat,
    resolution: minutesStat,
    csat: z.object({ count: z.number().int(), avg: z.number().nullable(), satisfied_share: z.number().nullable() }),
    by_day: z.array(z.object({ date: z.string(), created: z.number().int(), solved: z.number().int() })),
    by_agent: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        assigned: z.number().int(),
        solved: z.number().int(),
        avg_first_response_minutes: z.number().nullable(),
      }),
    ),
    by_category: z.array(z.object({ id: z.string().nullable(), name: z.string().nullable(), count: z.number().int() })),
  })
  .meta({ id: 'SupportReport' });
export type SupportReport = z.infer<typeof supportReportSchema>;
