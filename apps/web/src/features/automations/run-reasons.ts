// SPDX-License-Identifier: AGPL-3.0-only
import { hasMessage, t } from '@bines/shared';

/**
 * Why a run or an action was skipped, as people read it (r16name). The engine writes codes — one, or several for a
 * timer action that touches many people (`guest: Dana; no_edit_rights: Ron`). Each code reads from
 * `auto.runs.reason.<code>` (then the run-level `auto.runs.skip.<code>`); an unknown code stays as written.
 */
export type ReasonPart = { code: string; name?: string };

export const parseRunReason = (reason: string | null | undefined): ReasonPart[] =>
  (reason ?? '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = /^([a-z0-9_]+):\s*(.+)$/.exec(p);
      return m ? { code: m[1]!, name: m[2]! } : { code: p };
    });

export const reasonCodeText = (code: string): string => {
  for (const key of [`auto.runs.reason.${code}`, `auto.runs.skip.${code}`]) if (hasMessage(key)) return t(key);
  return code;
};

export const runReasonText = (reason: string | null | undefined): string =>
  parseRunReason(reason)
    .map((p) => (p.name ? `${reasonCodeText(p.code)}: ${p.name}` : reasonCodeText(p.code)))
    .join(' · ');
