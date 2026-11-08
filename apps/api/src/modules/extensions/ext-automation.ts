// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import {
  type Action,
  AppError,
  type AutomationActionFeature,
  type BlockField,
  blockKey,
  extensionTriggerInputsMatch,
  type ExtensionManifest,
  featureOrigin,
  newId,
  parseBlockKey,
  recipeSchema,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { automationRuns, automations, items } from '../../db/schema';
import type { Env } from '../../env';
import { enqueueJob } from '../../lib/jobs';
import { allowPrivateOutbound, outboundRequest } from '../../lib/outbound';
import { RateLimiter } from '../../lib/rate-limit';
import { ipBucket } from '../../lib/client-ip';
import type { AppDeps } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { findRun } from '../automations/automations.repo';
import type { ActionOutcome, RunCtx } from '../automations/engine/actions';
import { findInstallationById, findInstallationByKey, type InstallationRow } from './extensions.repo';
import { signExtBody, signingSecretOf, verifyExtSignature } from './ext-signing';
import { liveInstallation, newClaims, signExtToken } from './ext-token';
import { apiOrigin } from '../platform/public-address';
import { recordError } from '../errors/errors.writer';
import { boardInScope } from './scope';

/**
 * Automation blocks of extensions (D27 ת4 — also the `run_extension` part of AGENTS-MCP מ10):
 * - `run_extension`: a signed POST (HMAC + timestamp, the installation's secret) to the extension's server URL,
 *   through the SSRF-guarded outbound helper (no redirects, public addresses only in production), 30 s, at most
 *   3 attempts — retries go through the queue with backoff, and every outcome lands in the run's `actions_log`
 *   (`automation_runs`). The body carries a short-lived extension token for the board, as the automation's owner,
 *   so what the extension writes back is "via app X", undoable, and part of the automation chain (loop guard).
 * - extension triggers: the extension's server fires `<ext>.<trigger>` with a signed call; every active
 *   automation with that trigger on the installation's boards hears it.
 * A killed, disabled or uninstalled extension does neither.
 */
export const CALL_TIMEOUT_MS = 30_000;
export const MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and 3. */
export const RETRY_BACKOFF_MS = [30_000, 120_000];
export const RETRY_TASK = 'extension.call_retry';
const RESPONSE_MAX = 8 * 1024;

type Deps = Pick<AppDeps, 'db' | 'env'>;

export type ResolvedBlock<T extends 'automation_action' | 'automation_trigger'> = {
  row: InstallationRow;
  manifest: ExtensionManifest;
  feature: Extract<ExtensionManifest['features'][number], { type: T }>;
};

/** A block of a live installation in this account, allowed on the board (null otherwise). */
export const resolveBlock = async <T extends 'automation_action' | 'automation_trigger'>(
  db: Db,
  accountId: string,
  block: string,
  type: T,
  boardId: string | null,
): Promise<ResolvedBlock<T> | null> => {
  const parsed = parseBlockKey(block);
  if (!parsed) return null;
  const row = await findInstallationByKey(db, accountId, parsed.extension);
  if (!row) return null;
  const live = await liveInstallation(db, row.id, accountId);
  if (!live) return null;
  if (boardId && !(await boardInScope(db, live.row, boardId))) return null;
  const feature = live.manifest.features.find((f) => f.key === parsed.feature && f.type === type);
  if (!feature) return null;
  return { row: live.row, manifest: live.manifest, feature: feature as ResolvedBlock<T>['feature'] };
};

/** Recipe checks on save (automations.service): the block exists here, and its required inputs are filled. */
export const extensionRecipeIssues = async (
  db: Db,
  accountId: string,
  boardId: string,
  recipe: { trigger: { type: string; block?: unknown; inputs?: unknown }; actions: Action[] },
) => {
  const issues: { path: string; code: string; detail?: string }[] = [];
  if (recipe.trigger.type === 'extension_trigger') {
    const block = String(recipe.trigger.block ?? '');
    const found = await resolveBlock(db, accountId, block, 'automation_trigger', boardId);
    if (!found) issues.push({ path: 'trigger.block', code: 'extension_block_not_found', detail: block });
    else {
      // only the trigger's own inputs (its manifest).
      const known = new Set(found.feature.inputs.map((f) => f.key));
      const given = recipe.trigger.inputs && typeof recipe.trigger.inputs === 'object' ? recipe.trigger.inputs : {};
      for (const k of Object.keys(given))
        if (!known.has(k)) issues.push({ path: `trigger.inputs.${k}`, code: 'extension_input_unknown', detail: k });
    }
  }
  for (const [i, a] of recipe.actions.entries()) {
    if (a.type !== 'run_extension' || a.block.startsWith('mcp:')) continue;
    const found = await resolveBlock(db, accountId, a.block, 'automation_action', boardId);
    if (!found) {
      issues.push({ path: `actions.${i}.block`, code: 'extension_block_not_found', detail: a.block });
      continue;
    }
    for (const f of found.feature.inputs) {
      const v = a.input?.[f.key];
      if (f.required && (v === undefined || v === null || v === ''))
        issues.push({ path: `actions.${i}.input.${f.key}`, code: 'extension_input_missing', detail: f.key });
    }
  }
  return issues;
};

/** The block's inputs for this item: templates rendered, numbers and switches typed, unknown keys dropped. */
const renderInputs = (fields: BlockField[], input: Record<string, unknown>, render: (t: string) => string) => {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = input[f.key];
    if (v === undefined || v === null) continue;
    if (f.type === 'template' || f.type === 'text') out[f.key] = render(String(v));
    else if (f.type === 'number') out[f.key] = Number(v);
    else if (f.type === 'boolean') out[f.key] = v === true || v === 'true';
    else out[f.key] = String(v);
  }
  return out;
};

/** Calls from tests and development may reach local servers; production dials public addresses only. */
export const allowPrivateCalls = (env: Pick<Env, 'NODE_ENV' | 'OUTBOUND_ALLOW_PRIVATE'>) => allowPrivateOutbound(env);

type CallRef = {
  account_id: string;
  installation_id: string;
  feature: string;
  run_id: string;
  automation_id: string;
  action_index: number;
  /** For the callback token: the automation's owner, its board and the run's place in the chain. */
  user_id: string;
  board_id: string;
  depth: number;
  chain: string[];
};

export type CallResult =
  | { ok: true; status: number; output: Record<string, unknown> | null }
  | { ok: false; retry: boolean; error: string; status: number | null };

/**
 * One attempt: a fresh callback token, the body signed now, POST through the SSRF guard. Never throws — the
 * outcome says whether another attempt makes sense (5xx, 408, 429, timeout, network; not 4xx, not a blocked URL).
 */
export const callExtension = async (
  deps: Deps,
  ref: CallRef,
  body: Record<string, unknown>,
  attempt: number,
): Promise<CallResult> => {
  const r = await callExtensionOnce(deps, ref, body, attempt);
  // Errors hub: a failed call to the extension's server (each attempt; the code says why).
  if (!r.ok)
    recordError(deps.db, {
      source: 'extension',
      code: /^[a-z][a-z0-9_]{2,60}$/.test(r.error) ? r.error : 'extension_call_failed',
      message: `${ref.feature}: ${r.error}`,
      accountId: ref.account_id,
      severity: r.retry ? 'warning' : 'error',
      links: {
        installation_id: ref.installation_id,
        automation_id: ref.automation_id,
        run_id: ref.run_id,
        board_id: ref.board_id,
      },
    });
  return r;
};

const callExtensionOnce = async (
  deps: Deps,
  ref: CallRef,
  body: Record<string, unknown>,
  attempt: number,
): Promise<CallResult> => {
  const live = await liveInstallation(deps.db, ref.installation_id, ref.account_id);
  const feature = live?.manifest.features.find((f) => f.key === ref.feature && f.type === 'automation_action') as
    AutomationActionFeature | undefined;
  if (!live || !feature) return { ok: false, retry: false, error: 'extension_unavailable', status: null };
  const origin = featureOrigin(feature)!;
  const claims = newClaims({
    i: live.row.id,
    a: ref.account_id,
    u: ref.user_id,
    b: ref.board_id,
    f: feature.key,
    s: live.row.grantedScopes,
    o: origin,
    r: { a: ref.automation_id, r: ref.run_id, d: ref.depth, c: ref.chain },
  });
  const payload = JSON.stringify({
    ...body,
    attempt,
    token: {
      token: signExtToken(deps.env, claims),
      expires_at: new Date(claims.e * 1000).toISOString(),
      api_base: `${await apiOrigin(deps)}/api/v1`,
      scopes: claims.s,
    },
  });
  const secret = await signingSecretOf(deps, live.row);
  const timestamp = String(Date.now());
  try {
    const res = await outboundRequest(feature.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'BinesOS-Extensions/1',
        'x-bines-delivery': `${ref.run_id}:${ref.action_index}`,
        'x-bines-installation': live.row.id,
        'x-bines-attempt': String(attempt),
        'x-bines-timestamp': timestamp,
        'x-bines-signature': signExtBody(secret, timestamp, payload),
      },
      body: payload,
      timeoutMs: CALL_TIMEOUT_MS,
      allowPrivate: allowPrivateCalls(deps.env),
      maxBytes: RESPONSE_MAX,
    });
    if (res.ok) {
      let output: Record<string, unknown> | null = null;
      try {
        const parsed = JSON.parse(res.body) as { output?: unknown };
        if (parsed && typeof parsed.output === 'object' && parsed.output && !Array.isArray(parsed.output))
          output = parsed.output as Record<string, unknown>;
      } catch {
        // not JSON: fine, nothing to keep
      }
      return { ok: true, status: res.status, output };
    }
    const retry = res.status >= 500 || res.status === 408 || res.status === 429;
    return { ok: false, retry, error: `http_${res.status}`, status: res.status };
  } catch (e) {
    if (e instanceof AppError) return { ok: false, retry: false, error: e.message, status: null };
    const timeout = (e as Error).name === 'TimeoutError';
    return { ok: false, retry: true, error: timeout ? 'timeout' : 'unreachable', status: null };
  }
};

const outcomeOf = (r: CallResult, attempts: number, retrying: boolean): ActionOutcome =>
  r.ok
    ? { status: 'ok', output: { http_status: r.status, attempts, ...(r.output ? { result: r.output } : {}) } }
    : {
        status: 'error',
        error: retrying ? `${r.error} (retrying)` : r.error,
        code: retrying ? 'extension_retrying' : 'extension_failed',
      };

/** Queues the next attempt (with backoff); false where there is no queue (tests drive retries by hand). */
const queueRetry = (db: Db, ref: CallRef, body: Record<string, unknown>, attempt: number) =>
  enqueueJob(
    db,
    RETRY_TASK,
    { ref, body, attempt },
    { runAt: new Date(Date.now() + (RETRY_BACKOFF_MS[attempt - 2] ?? 120_000)), maxAttempts: 1 },
  );

/** The `run_extension` runner (engine/actions.ts). */
export const runExtensionAction = async (
  ctx: RunCtx,
  x: Extract<Action, { type: 'run_extension' }>,
  render: (t: string) => string,
): Promise<ActionOutcome> => {
  // `mcp:<tool>` names an outbound MCP tool (מ10): engine/actions.ts routes it to mcp-servers, never here.
  if (x.block.startsWith('mcp:')) return { status: 'skipped', reason: 'not_available' };
  const boardId = ctx.board.parentBoardId ?? ctx.board.id;
  const found = await resolveBlock(ctx.db, ctx.a.ctx.accountId, x.block, 'automation_action', boardId);
  if (!found) throw new AppError('not_found', 'extension_unavailable');
  const ref: CallRef = {
    account_id: ctx.a.ctx.accountId,
    installation_id: found.row.id,
    feature: found.feature.key,
    run_id: ctx.scope.run_id,
    automation_id: ctx.scope.automation_id ?? '',
    action_index: ctx.actionIndex ?? 0,
    user_id: ctx.a.user.id,
    board_id: boardId,
    depth: ctx.scope.depth,
    chain: ctx.scope.chain,
  };
  const body = {
    type: 'automation_action',
    block: blockKey(found.row.key, found.feature.key),
    delivery_id: `${ref.run_id}:${ref.action_index}`,
    installation_id: found.row.id,
    account_id: ref.account_id,
    automation_id: ref.automation_id,
    run_id: ref.run_id,
    board: { id: ctx.board.id, name: ctx.board.name },
    item: ctx.snap ? { ...ctx.snap.item, url: ctx.itemUrl(ctx.board.id, ctx.snap.row.id) } : null,
    input: renderInputs(found.feature.inputs, x.input ?? {}, render),
    trigger_time: ctx.now.toISOString(),
  };
  // A dry run (the test dialog) never calls out.
  if (ctx.scope.run_id === 'preview') return { status: 'skipped', reason: 'preview' };
  const r = await callExtension(ctx.deps, ref, body, 1);
  const retrying = !r.ok && r.retry && MAX_ATTEMPTS > 1 && (await queueRetry(ctx.db, ref, body, 2));
  return outcomeOf(r, 1, retrying);
};

type LogEntry = { index: number; status: string; error?: string; code?: string; output?: unknown };

/** A later attempt's outcome replaces the action's entry in the run's log, and the run's status follows. */
export const recordRetryOutcome = async (db: Db, runId: string, index: number, outcome: ActionOutcome) => {
  const run = await findRun(db, runId);
  if (!run) return;
  const log = (run.actionsLog as LogEntry[]).map((e) => {
    if (e.index !== index) return e;
    const { error: _e, code: _c, output: _o, ...rest } = e;
    void _e;
    void _c;
    void _o;
    return outcome.status === 'ok'
      ? { ...rest, status: 'ok', ...(outcome.output ? { output: outcome.output } : {}) }
      : outcome.status === 'error'
        ? { ...rest, status: 'error', error: outcome.error, code: outcome.code }
        : { ...rest, status: 'skipped' };
  });
  const oks = log.filter((l) => l.status === 'ok').length;
  const errors = log.filter((l) => l.status === 'error');
  const status = errors.length === 0 ? (oks ? 'succeeded' : 'skipped') : oks ? 'partial' : 'failed';
  await db
    .update(automationRuns)
    .set({ actionsLog: log as never, status, error: errors[0]?.error ?? null, finishedAt: new Date() })
    .where(eq(automationRuns.id, runId));
};

/** `extension.call_retry` (the automation runner's queue): attempt 2 or 3 of a failed call. */
export const retryExtensionCall = async (
  deps: Deps,
  job: { ref: CallRef; body: Record<string, unknown>; attempt: number },
) => {
  const r = await callExtension(deps, job.ref, job.body, job.attempt);
  const retrying =
    !r.ok && r.retry && job.attempt < MAX_ATTEMPTS && (await queueRetry(deps.db, job.ref, job.body, job.attempt + 1));
  await recordRetryOutcome(deps.db, job.ref.run_id, job.ref.action_index, outcomeOf(r, job.attempt, retrying));
  return r;
};

// ---- triggers fired by the extension's server ----

/** Accepted fires per installation per minute; failed attempts per client address and per installation. */
const fires = new RateLimiter(120, 60_000);
const failuresByIp = new RateLimiter(20, 10 * 60_000);
export const MAX_FIRE_BYTES = 64 * 1024;
/** How deep a trigger's payload may nest (EXT-RT13): it becomes `{payload.*}` and is stored in the activity log. */
export const MAX_PAYLOAD_DEPTH = 8;

const depthOf = (v: unknown, limit: number, d = 0): number => {
  if (d > limit || !v || typeof v !== 'object') return d;
  let max = d;
  for (const x of Object.values(v as Record<string, unknown>)) max = Math.max(max, depthOf(x, limit, d + 1));
  return max;
};

/**
 * POST /automations/triggers/:block/fire — no session: `X-Bines-Installation` + a signature with that
 * installation's secret (timestamp ±5 min, no replay). One event per board of the installation that has an
 * active automation listening to this trigger (or just `board_id`); the payload is `{payload.*}`.
 */
export const fireExtensionTrigger = async (
  deps: Deps,
  p: {
    block: string;
    installationId: string | undefined;
    timestamp: string | undefined;
    signature: string | undefined;
    rawBody: string;
    clientIp: string | null;
  },
) => {
  const ipKey = ipBucket(p.clientIp);
  const id = p.installationId ?? '';
  // EXT-RT8: failures block the address that made them — never the installation: its id is no secret (it is in
  // the activity log and in every token's claims), so anyone could otherwise lock its real server out. Guessing an
  // HMAC-SHA256 signature is not a brute-force target.
  const blocked = failuresByIp.peek(ipKey);
  if (blocked > 0) throw new AppError('rate_limited', 'Too many failed attempts', { retry_after_ms: blocked });
  const fail = (code: 'not_found' | 'unauthenticated', message: string): never => {
    failuresByIp.hit(ipKey);
    throw new AppError(code, message);
  };
  if (Buffer.byteLength(p.rawBody) > MAX_FIRE_BYTES) throw new AppError('payload_too_large', 'Payload too large');
  const parsed = parseBlockKey(p.block);
  if (!parsed || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return fail('not_found', 'Not found');
  // The installation, as it is now: the same 404 for unknown / other key / disabled / killed (nothing to probe).
  const row = await findInstallationById(deps.db, id);
  if (!row || row.key !== parsed.extension) return fail('not_found', 'Not found');
  const live = await liveInstallation(deps.db, row.id, row.accountId);
  const feature = live?.manifest.features.find((f) => f.key === parsed.feature && f.type === 'automation_trigger');
  if (!live || !feature) return fail('not_found', 'Not found');
  const check = verifyExtSignature(await signingSecretOf(deps, live.row), {
    timestamp: p.timestamp,
    signature: p.signature,
    body: p.rawBody,
  });
  if (check !== 'ok') return fail('unauthenticated', `signature_${check}`);
  const wait = fires.hit(row.id);
  if (wait > 0) throw new AppError('rate_limited', 'Too many requests', { retry_after_ms: wait });

  let input: { board_id?: string; item_id?: string; payload?: Record<string, unknown> };
  try {
    input = p.rawBody ? (JSON.parse(p.rawBody) as typeof input) : {};
  } catch {
    throw new AppError('bad_request', 'body_not_json');
  }
  const payload =
    input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload) ? input.payload : {};
  if (depthOf(payload, MAX_PAYLOAD_DEPTH) > MAX_PAYLOAD_DEPTH)
    throw new AppError('invalid_value', 'payload_too_deep', { max_depth: MAX_PAYLOAD_DEPTH });
  const block = blockKey(row.key, feature.key);
  // Boards with an active automation listening to it, within the installation's boards.
  const rows = await deps.db
    .select({ boardId: automations.boardId, recipe: automations.recipe })
    .from(automations)
    .where(
      and(eq(automations.accountId, row.accountId), eq(automations.isActive, true), isNull(automations.deletedAt)),
    );
  const boards = new Set<string>();
  for (const a of rows) {
    const r = recipeSchema.safeParse(a.recipe);
    if (!a.boardId || !r.success || r.data.trigger.type !== 'extension_trigger' || r.data.trigger.block !== block)
      continue;
    // an automation set to some inputs (e.g. one button) hears only fires carrying them.
    if (!extensionTriggerInputsMatch(r.data.trigger.inputs, payload)) continue;
    if (!(await boardInScope(deps.db, live.row, a.boardId))) continue;
    if (input.board_id && input.board_id !== a.boardId) continue;
    boards.add(a.boardId);
  }
  const events: { board_id: string; event_id: string; item_id: string | null }[] = [];
  for (const boardId of boards) {
    let itemId: string | null = null;
    if (typeof input.item_id === 'string') {
      const hit = (
        await deps.db
          .select({ id: items.id })
          .from(items)
          .where(and(eq(items.id, input.item_id), eq(items.boardId, boardId), isNull(items.deletedAt)))
          .limit(1)
      )[0];
      itemId = hit?.id ?? null;
    }
    const eventId = await recordEvent(deps.db, {
      accountId: row.accountId,
      type: 'extension_trigger.fired',
      actorId: null,
      actorType: 'system',
      boardId,
      itemId,
      batchId: newId(),
      meta: {
        block,
        via: 'app',
        app: { key: row.key, name: live.manifest.name, installation_id: row.id },
        payload,
      },
    });
    // The activity trigger (0046) does not queue `automation.dispatch` for `extension_trigger.fired`; the event
    // queues its own (audit 2026-10-10, automations #1). Tests, with no queue, dispatch by hand.
    await enqueueJob(deps.db, 'automation.dispatch', { event_id: eventId, account_id: row.accountId });
    events.push({ board_id: boardId, event_id: eventId, item_id: itemId });
  }
  return { block, events };
};
