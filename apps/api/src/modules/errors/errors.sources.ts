// SPDX-License-Identifier: AGPL-3.0-only
import type { Db } from '../../db/client';
import { errorCodeOf, recordError } from './errors.writer';

/**
 * The errors hub's adapters for sources with a shape of their own. Each one turns an outcome into
 * `recordError` calls — synchronous, never throwing, ids only in the links.
 */

type RunLogEntry = { index?: number; type?: string; status?: string; reason?: string; error?: string; code?: string };

/**
 * An automation run that ended: a failed / partial run records each failed action (and the run's own error when no
 * action carried it); a skip — of the run or of one action — is recorded as a skip and kept only when its reason is
 * a problem (`problem_skips`, decided at flush): "condition not met" never reaches the hub.
 */
export const recordAutomationRun = (
  db: Db,
  run: {
    accountId: string;
    automationId: string;
    boardId?: string | null;
    runId: string;
    itemId?: string | null;
    status: 'succeeded' | 'partial' | 'failed' | 'skipped';
    skipReason?: string | null;
    error?: string | null;
    actionsLog?: unknown[];
  },
) => {
  const links = {
    automation_id: run.automationId,
    run_id: run.runId,
    ...(run.boardId ? { board_id: run.boardId } : {}),
    ...(run.itemId ? { item_id: run.itemId } : {}),
  };
  const log = (run.actionsLog ?? []) as RunLogEntry[];
  let errorSeen = false;
  for (const entry of log) {
    if (entry.status === 'error') {
      errorSeen = true;
      recordError(db, {
        source: 'automation',
        // The reason in the error text (`group_not_found:…`) is more precise than the HTTP-ish code (`not_found`).
        code: codeOfText(entry.error) ?? (entry.code && entry.code !== 'internal' ? entry.code : 'action_failed'),
        message: `${entry.type ?? 'action'}: ${entry.error ?? ''}`,
        accountId: run.accountId,
        links,
      });
    } else if (entry.status === 'skipped' && entry.reason && entry.type !== 'conditions')
      recordError(db, {
        source: 'automation',
        code: entry.reason,
        message: `${entry.type ?? 'action'}: ${entry.reason}`,
        accountId: run.accountId,
        severity: 'warning',
        links,
        skip: true,
      });
  }
  if ((run.status === 'failed' || run.status === 'partial') && !errorSeen)
    recordError(db, {
      source: 'automation',
      code: codeOfText(run.error) ?? 'run_failed',
      message: run.error ?? 'run_failed',
      accountId: run.accountId,
      links,
    });
  if (run.status === 'skipped' && run.skipReason)
    recordError(db, {
      source: 'automation',
      code: run.skipReason,
      message: run.skipReason,
      accountId: run.accountId,
      severity: 'warning',
      links,
      skip: true,
    });
};

/** `column_not_found:abc` → `column_not_found`; a plain reason stays; prose → null. */
export const codeOfText = (text: string | null | undefined) => {
  const m = /^([a-z][a-z0-9_]{2,60})(?::|$|\s\()/.exec(text ?? '');
  return m ? m[1]! : null;
};

/** A failed agent run (source `agent`). */
export const recordAgentRun = (
  db: Db,
  run: { accountId: string; agentId: string; runId: string; itemId?: string | null; error?: string | null },
) =>
  recordError(db, {
    source: 'agent',
    code: codeOfText(run.error) ?? 'agent_run_failed',
    message: run.error ?? 'agent_run_failed',
    accountId: run.accountId,
    links: { agent_id: run.agentId, agent_run_id: run.runId, ...(run.itemId ? { item_id: run.itemId } : {}) },
  });

/** A failed model / image call (source `ai`): `ai_usage` keeps tokens only, so failures live here. */
export const recordAiFailure = (
  db: Db,
  call: { accountId: string; connectionId: string; source: string; model?: string | null; err: unknown },
) =>
  recordError(db, {
    source: 'ai',
    code: errorCodeOf(call.err),
    message: `${call.source}${call.model ? ` (${call.model})` : ''}: ${call.err instanceof Error ? call.err.message : String(call.err)}`,
    accountId: call.accountId,
    links: { ai_connection_id: call.connectionId },
  });
