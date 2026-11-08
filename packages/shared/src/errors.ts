// SPDX-License-Identifier: AGPL-3.0-only
/** Error codes shared by api/web/sdk (06-API §1.4). Extend here, never ad hoc strings. */
export const ERROR_STATUS = {
  bad_request: 400,
  validation_failed: 400,
  guest_domain_not_external: 400,
  unauthenticated: 401,
  forbidden: 403,
  insufficient_scope: 403,
  account_mismatch: 403,
  invitation_email_mismatch: 403,
  not_found: 404,
  invitation_invalid: 404,
  conflict: 409,
  license_server_key_exists: 409,
  /** First-run setup: someone already created the owner account (the installation has users). */
  setup_done: 409,
  revision_mismatch: 409,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  slug_taken: 409,
  already_member: 409,
  last_group: 409,
  column_id_taken: 409,
  workspace_not_empty: 409,
  no_running_timer: 409,
  last_workspace: 409,
  parent_in_trash: 409,
  changed_since: 409,
  /** D28: the column changed since the conversion preview — preview again. */
  preview_stale: 409,
  already_undone: 409,
  last_owner: 409,
  /** The account must keep one active admin (08 §3). */
  last_admin: 409,
  /** "Delete details" needs a deactivated member first (08 §3.2). */
  not_deactivated: 409,
  /** Anonymising a person who is still active in another account would change that account too. */
  user_active_elsewhere: 409,
  /** M11: a public form past its close date or submission limit. */
  form_closed: 409,
  /** the board computes item names from columns — change those columns instead (details.refs). */
  item_name_computed: 409,
  /** the column feeds the board's computed item name (change the name source first). */
  column_in_name_source: 409,
  payload_too_large: 413,
  unprocessable: 422,
  slug_reserved: 422,
  confirm_mismatch: 422,
  column_read_only: 422,
  invalid_value: 422,
  /** A two-way relation that cannot be set up (details.reason: one_target_board, partner_must_point_back, …). */
  two_way_unavailable: 422,
  /** a name source that cannot be saved (details.reason: unknown_column, column_not_allowed). */
  name_source_invalid: 422,
  label_not_found: 422,
  /** r19relfilter: a new relation link the column's filter does not offer (details: column_id, item_ids, names). */
  relation_not_in_filter: 422,
  /** D28: this column type pair cannot be converted (details.reason). */
  conversion_unsupported: 422,
  /** An automation recipe the board cannot satisfy (details.issues: path + code per problem). */
  invalid_recipe: 422,
  unknown_column_type: 422,
  depth_exceeded: 422,
  // M8 ד7: a dependency that closes a loop (or points at the item itself).
  dependency_cycle: 422,
  invalid_time: 422,
  time_in_future: 422,
  time_end_before_start: 422,
  time_too_long: 422,
  invalid_query: 422,
  unknown_column: 422,
  invalid_operator: 422,
  query_too_complex: 422,
  not_undoable: 422,
  undo_expired: 422,
  /** Remote support access in view mode (08 §6): reads only. */
  support_read_only: 405,
  account_suspended: 423,
  /**
   * Plan (plan-lock): the owner closed the account — nothing of it answers but the current user, the plan
   * the offered plans and support (contact us).
   */
  account_closed: 403,
  /**
   * the account is scheduled for deletion — nothing of it answers but its deletion status, the
   * admins' cancel and export download, and support (details.due_at).
   */
  account_deletion_scheduled: 403,
  /** This step needs two-factor sign-in turned on (deleting an account, the owner's "delete now"). */
  step_up_two_factor_required: 403,
  /** The two-factor code was wrong or expired. */
  step_up_code_invalid: 422,
  /** An account export is already being built — wait for it. */
  export_in_progress: 409,
  /** Plan: the account's subscription is read-only (unpaid / cancelled) — reads work, writes wait. */
  plan_read_only: 423,
  /** Plan: the account's subscription is suspended — only its admins' "My plan" page answers. */
  plan_suspended: 423,
  /** Plan: the next action would pass a plan limit (details: kind, limit, used, upgrade: true). */
  plan_limit_reached: 402,
  /** Plan: the account's plan does not include this feature (details: feature, upgrade: true). */
  plan_feature_unavailable: 402,
  /** Enterprise license key (LICENSING-OPTIONS B): the key is unreadable, not signed by the licensor, or expired. */
  license_invalid: 400,
  /**
   * Licensing: no license server is configured (registration unavailable), or this installation is not one (no
   * `LICENSE_SIGNING_KEY`) — its Installations / Licenses screens say "not a license server".
   */
  license_server_unavailable: 503,
  /** Licensing: an online check that `BINES_UPDATE_CHECK=false` turned off. */
  update_check_disabled: 409,
  /** Registration: the email verification link is unknown, used or expired. */
  verification_invalid: 404,
  /** A route that exists but has nothing behind it yet (e.g. a billing webhook with no provider registered). */
  not_implemented: 501,
  /** D28: the column is being converted (a background job) — edits wait until it ends. */
  column_converting: 423,
  /** the status workflow does not allow this move (details.reason: not_allowed | who | required | conditions). */
  workflow_blocked: 409,
  /** The Turnstile check failed: the token Cloudflare was sent is not valid (400, not 422). */
  captcha_failed: 400,
  /** This place asks for the Turnstile check and no token came with the request. */
  captcha_required: 400,
  /**
   * Plan: the SMS provider cannot send to this number (details.reason: empty | invalid |
   * unsupported_destination — TextMe sends to Israeli mobiles only; details.e164 when known).
   */
  sms_unsupported_number: 422,
  /** SMS is not set up in this environment / account (no provider keys or no sender id). */
  sms_not_configured: 503,
  /** Secret columns: revealing needs two-factor authentication turned on. */
  secret_two_factor_required: 403,
  /** Secret columns: a fresh two-factor code is needed first (details.verify_minutes). */
  secret_step_up_required: 403,
  /** Secret columns: the two-factor code was wrong. */
  secret_code_invalid: 422,
  /** Secret columns: the server has no SECRET_MASTER_KEY (deploy setting). */
  secret_master_key_missing: 503,
  /** Self sign-up (D32): turning it on while something is missing (details.missing — SignupMissing keys). */
  signup_not_ready: 422,
  /** Self sign-up is switched on but cannot work right now (e.g. the license key was removed) — "try later". */
  signup_unavailable: 503,
  /** This address may not sign up (details.reason: domain_blocked | domain_not_allowed | disposable | work_email_required). */
  signup_email_not_allowed: 422,
  /** Domain join (ה7): the address's domain is not joinable here (`domain_join` mode, or the account stopped it). */
  signup_domain_not_joinable: 422,
  /** The sign-up method (password / Google / Microsoft) is not offered. */
  signup_method_unavailable: 422,
  /** The platform's daily sign-up cap was reached — try tomorrow. */
  signup_daily_cap: 429,
  /** Finishing a Google / Microsoft sign-up as a person who already had an account (sign in instead). */
  signup_already_registered: 409,
  /** A Google / Microsoft sign-up still lacks the organisation or the consent (details.missing — SIGNUP_DETAILS). */
  signup_details_required: 422,
  /** Joining needs consent to the current version of every document that asks for it (details.slugs). */
  legal_consent_required: 422,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
  /** An outside system (webhook target, mail provider) failed. */
  external_error: 502,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string = code,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_STATUS[code];
  }
}

export type ErrorEnvelope = {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown>; request_id: string };
};
