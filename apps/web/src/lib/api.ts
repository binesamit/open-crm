// SPDX-License-Identifier: AGPL-3.0-only
import { ApiError, createClient } from '@bines/sdk';
import { conditionFailureText, he, t, type ConditionFailure, type MessageKey } from '@bines/shared';
import type {
  invitationPreviewSchema,
  invitationSchema,
  inviteResultSchema,
  Me,
  memberSchema,
  MyAccount,
  myInvitationSchema,
  PlatformAccount,
} from '@bines/shared';
import type { z } from 'zod';
import { nextRequestId } from './realtime';
import { applyLocale } from './locale';
import { applyUserRegion } from './region';

/** Unscoped calls (/auth/me, /me/*, /platform/*) and account-scoped calls (X-Account-Id, D12). */
export const api = (accountId?: string) => createClient({ baseUrl: '', accountId, requestId: nextRequestId });
/** For a request sent while the page unloads (pagehide): the browser keeps it going after the page is gone. */
export const keepaliveApi = (accountId?: string) =>
  createClient({
    baseUrl: '',
    accountId,
    requestId: nextRequestId,
    fetch: (url, init) => fetch(url, { ...init, keepalive: true }),
  });

export type Invitation = z.infer<typeof invitationSchema>;
export type MyInvitation = z.infer<typeof myInvitationSchema>;
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;
export type InviteResult = z.infer<typeof inviteResultSchema>;
export type Member = z.infer<typeof memberSchema>;
export type { Me, MyAccount, PlatformAccount };

export const queryKeys = {
  me: ['me'] as const,
  myAccounts: ['me', 'accounts'] as const,
  myInvitations: ['me', 'invitations'] as const,
  authConfig: ['auth', 'config'] as const,
  platformAccounts: ['platform', 'accounts'] as const,
  members: (accountId: string) => ['account', accountId, 'members'] as const,
  invitations: (accountId: string) => ['account', accountId, 'invitations'] as const,
};

/** Signed-in identity or null (401 is a normal answer, not an error). The user's language becomes the UI's (fix3). */
export const fetchMe = async (): Promise<Me | null> => {
  try {
    const me = await api().get<Me>('/auth/me');
    applyLocale(me.user.locale);
    applyUserRegion(me.user);
    return me;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
};

/** Human message for an API/auth error: `error.<code>` when we have one, otherwise a generic line. */
/** An error's numeric details as text variables (`{limit}` in "עד {limit} תווים"), grouped like 100,000. */
const numericDetails = (err: unknown): Record<string, string> => {
  const d = err instanceof ApiError ? err.body.details : undefined;
  if (!d || typeof d !== 'object') return {};
  return Object.fromEntries(
    Object.entries(d as Record<string, unknown>)
      .filter((e): e is [string, number] => typeof e[1] === 'number')
      .map(([k, v]) => [k, v.toLocaleString('en-US')]),
  );
};

export const errorMessage = (err: unknown): string => {
  const code = err instanceof ApiError ? err.body.code : (err as { code?: string } | null)?.code;
  // A specific reason (the message is a short code like `manifest_changed`) wins over the generic code's text.
  const reason = err instanceof ApiError ? err.body.message : undefined;
  const reasonKey = `error.${reason}` as MessageKey;
  // phase 2: a popup button's required fields, by name.
  if (reason === 'popup_required' && err instanceof ApiError) {
    const cols = ((err.body.details ?? {}) as { columns?: { title: string }[] }).columns ?? [];
    return t('error.popup_required', { columns: cols.map((c) => c.title).join(', ') });
  }
  if (reason && /^[a-z0-9_]+$/.test(reason) && reasonKey in he) return t(reasonKey, numericDetails(err));
  // Plans: which limit ran out, with its numbers ("8 / 10 users").
  if (code === 'plan_limit_reached' && err instanceof ApiError) {
    const d = (err.body.details ?? {}) as { kind?: string; limit?: number; used?: number };
    const kindKey = `error.plan_limit_reached.${d.kind}` as MessageKey;
    if (d.kind && kindKey in he) return t(kindKey, { limit: d.limit ?? 0, used: d.used ?? 0 });
  }
  // Plans: which feature the plan lacks ("AI is not included in your plan").
  if (code === 'plan_feature_unavailable' && err instanceof ApiError) {
    const f = ((err.body.details ?? {}) as { feature?: string }).feature;
    const labelKey = `plan.feature.${f}` as MessageKey;
    if (f && labelKey in he) return t('error.plan_feature_unavailable.named', { feature: t(labelKey) });
  }
  // r19relfilter: which items the relation column's filter does not offer.
  if (code === 'relation_not_in_filter' && err instanceof ApiError) {
    const names = ((err.body.details ?? {}) as { names?: string[] }).names ?? [];
    return t('error.relation_not_in_filter', { names: names.join(', ') });
  }
  // why the status workflow stopped a move — the fields it still needs, by name.
  if (code === 'workflow_blocked' && err instanceof ApiError) {
    const d = (err.body.details ?? {}) as { reason?: string; columns?: { title: string }[]; message?: string };
    // round 2: the move's own words first, then what is missing.
    const detail = workflowBlockDetail(d);
    return d.message ? (detail ? `${d.message}. ${detail}` : d.message) : (detail ?? t('error.workflow_blocked'));
  }
  const key = `error.${code}` as MessageKey;
  return code && key in he ? t(key) : t('error.generic');
};

/** What a blocked workflow move still needs, in words (null = nothing more to say than "not allowed"). */
const workflowBlockDetail = (d: {
  reason?: string;
  columns?: { title: string }[];
  failed?: ConditionFailure[];
  any?: boolean;
}): string | null => {
  if (d.reason === 'conditions' && d.failed?.length) {
    const list = d.failed.map((f) => conditionFailureText(f)).join('; ');
    return t(d.any ? 'error.workflow_blocked.conditionsAny' : 'error.workflow_blocked.conditionsList', { list });
  }
  if (d.reason === 'required')
    return t('error.workflow_blocked.required', { columns: (d.columns ?? []).map((c) => c.title).join(', ') });
  // how many subitems the move needs, and with which values.
  if (d.reason === 'subitems') {
    const s = d as { min?: number; have?: number; incomplete?: number; all?: boolean; failing?: number };
    const columns = (d.columns ?? []).map((c) => c.title).join(', ');
    if ((s.failing ?? 0) > 0 && (s.have ?? 0) + (s.failing ?? 0) >= (s.min ?? 0))
      return t('error.workflow_blocked.subitemsEach', { n: s.failing ?? 0 });
    if (s.all && (s.incomplete ?? 0) > 0 && (s.have ?? 0) >= (s.min ?? 0))
      return t('error.workflow_blocked.subitemsAll', { columns });
    return columns
      ? t('error.workflow_blocked.subitems', { min: s.min ?? 1, columns })
      : t('error.workflow_blocked.subitemsCount', { min: s.min ?? 1 });
  }
  const reasonKey = `error.workflow_blocked.${d.reason}` as MessageKey;
  return d.reason && reasonKey in he ? t(reasonKey) : null;
};
