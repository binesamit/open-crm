// SPDX-License-Identifier: AGPL-3.0-only
import { type AiToolDef, asSensitive, recipeSendsOut } from '@bines/shared';
import type { AppDeps } from '../../../types';
import { getAutomation } from '../../automations/automations.service';
import type { Actor } from '../../items/items.service';

/**
 * The tool as this one call should be treated (AI-RT9, docs/AI-SECURITY-REVIEW.md): creating an automation that
 * sends data out (webhook / email), or switching such an automation on, is sensitive — the MCP server, the agents
 * and the assistant ask this before they decide on approval / the sensitive-tools policy. Everything else keeps the
 * registry's risk. An automation the caller cannot read stays as it is (the runner answers its 404).
 */
export const callTool = async (
  deps: Pick<AppDeps, 'db'>,
  actor: Actor,
  def: AiToolDef,
  input: unknown,
): Promise<AiToolDef> => {
  const x = (input ?? {}) as Record<string, unknown>;
  if (def.name === 'create_automation' && recipeSendsOut(x.recipe)) return asSensitive(def);
  // changing who sees a dashboard (private / shareable with guests / everyone) waits for a person.
  if (def.name === 'update_dashboard' && x.kind !== undefined) return asSensitive(def);
  if (def.name === 'set_automation_active' && x.is_active === true && typeof x.automation_id === 'string') {
    const found = await getAutomation(deps.db, actor, x.automation_id).catch(() => null);
    if (found && recipeSendsOut(found.recipe)) return asSensitive(def);
  }
  return def;
};
