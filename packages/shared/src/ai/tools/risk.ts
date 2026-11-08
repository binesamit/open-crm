// SPDX-License-Identifier: AGPL-3.0-only
import type { AiToolDef } from './types';

/**
 * A call's risk can be higher than its tool's (docs/AI-SECURITY-REVIEW.md AI-RT9): an automation whose actions send
 * data out of the platform (a webhook to any URL, an email to any address) is an exfiltration channel that keeps
 * working after the call — so creating one, or switching one on, counts as a sensitive call (approval for agents,
 * the account's sensitive-tools policy for MCP and the assistant), whatever the plain tool says.
 */
export const OUTBOUND_ACTION_TYPES = [
  'webhook',
  'send_email',
  'send_sms',
  'send_document',
  'run_extension',
  'send_to_integrations',
] as const; // run_extension: extension servers (ת4) and MCP tools (מ10)

/**
 * Tools that change something on an external automation platform ("זרימות"): always
 * sensitive — they reach outside the platform, so an agent's call always waits for a person, the assistant proposes
 * it as a card, and an account that blocks sensitive AI tools blocks them too. A created flow is switched off, an
 * edited one is saved switched off unless the person said otherwise; the AI never deletes a flow (no such tool).
 */
export const EXTERNAL_PLATFORM_TOOLS = [
  'flows_draft_create',
  'flows_set_active',
  'flows_rerun',
  'flows_update_draft',
] as const;

/** Does this recipe (as a model sent it, or as stored) have an action that sends data out? */
export const recipeSendsOut = (recipe: unknown): boolean => {
  const actions = (recipe as { actions?: unknown } | null | undefined)?.actions;
  return (
    Array.isArray(actions) &&
    actions.some(
      (x) =>
        !!x &&
        typeof x === 'object' &&
        (OUTBOUND_ACTION_TYPES as readonly string[]).includes(String((x as { type?: unknown }).type)),
    )
  );
};

/** The same tool, treated as sensitive for this one call. */
export const asSensitive = (tool: AiToolDef): AiToolDef =>
  tool.risk === 'sensitive'
    ? tool
    : { ...tool, risk: 'sensitive', annotations: { ...tool.annotations, readOnlyHint: false, openWorldHint: true } };
