// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * Web search for agents. Three switches, all off by default
 * - the platform owner's master switch (owner console → AI): may any account use it at all;
 * - the account's search service (account admin → AI): Brave Search or Tavily, with its key (write-only, sealed on
 *   the server) and the limits per run and per day;
 * - per agent: "web search" in the agent's editor — an admin turning it on approves it at once; anyone else asks,
 *   and the agent does not search until an admin approves. Revocable any time; every decision is recorded.
 */
export const WEB_SEARCH_PROVIDERS = ['brave', 'tavily'] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export const WEB_SEARCH_DEFAULT_LIMITS = { max_per_run: 10, max_per_day: 200 } as const;

export const platformWebSearchSchema = z.object({ enabled: z.boolean() }).meta({ id: 'PlatformWebSearch' });
export type PlatformWebSearch = z.infer<typeof platformWebSearchSchema>;

export const accountWebSearchSchema = z
  .object({
    /** The platform owner allows web search (else nothing here takes effect). */
    platform_enabled: z.boolean(),
    provider: z.enum(WEB_SEARCH_PROVIDERS).nullable(),
    key_set: z.boolean(),
    key_hint: z.string().nullable(),
    max_per_run: z.number().int(),
    max_per_day: z.number().int(),
    /** Searches (and pages read) by this account's agents today. */
    used_today: z.number().int(),
    /** Ready: the platform allows it, a provider and its key are set. */
    ready: z.boolean(),
  })
  .meta({ id: 'AccountWebSearch' });
export type AccountWebSearch = z.infer<typeof accountWebSearchSchema>;

export const updateAccountWebSearchSchema = z.object({
  provider: z.enum(WEB_SEARCH_PROVIDERS).optional(),
  /** Write-only: a new key, or null to remove it. */
  key: z.string().trim().min(8).max(300).nullable().optional(),
  max_per_run: z.number().int().min(1).max(50).optional(),
  max_per_day: z.number().int().min(1).max(10_000).optional(),
});
export type UpdateAccountWebSearch = z.infer<typeof updateAccountWebSearchSchema>;

export const AGENT_WEB_SEARCH_STATUSES = ['off', 'requested', 'approved'] as const;
export type AgentWebSearchStatus = (typeof AGENT_WEB_SEARCH_STATUSES)[number];

/** An agent's web search: off, asked for (waits for an admin) or approved — and by whom. */
export const agentWebSearchSchema = z
  .object({
    status: z.enum(AGENT_WEB_SEARCH_STATUSES),
    requested_by: z.string().nullable(),
    decided_by: z.string().nullable(),
    at: z.string().nullable(),
  })
  .meta({ id: 'AgentWebSearch' });
export type AgentWebSearch = z.infer<typeof agentWebSearchSchema>;
