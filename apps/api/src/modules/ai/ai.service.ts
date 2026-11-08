// SPDX-License-Identifier: AGPL-3.0-only
import {
  type AccountRole,
  type AiPriceOverride,
  type AiConnection,
  type AiSettings,
  type AiUsageReport,
  AI_PROVIDER_INFO,
  aiCost,
  aiSettingsSchema,
  resolveAiPrice,
  AppError,
  type createAiConnectionSchema,
  type previewAiModelsSchema,
  type McpInfo,
  newId,
  toolsFor,
  TOKEN_SCOPES,
  type UpdateAiSettings,
  type updateAiConnectionSchema,
  updateAiSettingsSchema,
} from '@bines/shared';
import type { AiCompletionRequest } from '@bines/server-ai';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import { assertAiStatusAllows, assertFeature, assertWithinLimit } from '../billing/entitlements';
import { keyHint } from '../../lib/secrets';
import type { AppDeps, RequestMeta } from '../../types';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import { type AdminActor } from '../admin/security.service';
import { recordAudit } from '../audit/audit.repo';
import {
  type AiConnectionRow,
  addUsage,
  connectionNames,
  findConnection,
  insertConnection,
  listConnectionRows,
  updateConnectionRow,
  usageBetween,
} from './ai.repo';
import { assertAiBaseUrl } from './ai-fetch';
import {
  localAiAllowedFor,
  assertListedModel,
  cachedListedPrice,
  connectionDefaultModel,
  connectionModels,
  forgetModels,
  manualOf,
  modelForCall,
  modelList,
  overridesOf,
  readProviderModels,
  rememberModels,
  secretOf,
} from './models.service';
import { loadPriceTable } from './prices.service';
import { apiOrigin } from '../platform/public-address';
import { recordAiFailure } from '../errors/errors.sources';
import { assertAccountAdmin } from '../../lib/account-admin';

/**
 * AI infrastructure (the planning notes "AGENTS-MCP" מ1, D26): the account's AI settings (`settings.ai`), AI connections
 * (provider + encrypted write-only key, admins only), the usage ledger and the MCP connection page. Everything
 * here is account admin territory except `mcpInfo`, which anyone who may connect reads.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'secrets' | 'aiClient'> & Partial<Pick<AppDeps, 'logger'>>;

/** MCP protocol revisions the server answers (the SDK serves the 2025 family statelessly next to 2026-07-28). */
export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

/** `settings.ai` as stored, defaults filled in (a broken value falls back to the defaults). */
export const aiSettingsOf = (settings: Record<string, unknown>): AiSettings => {
  const parsed = aiSettingsSchema.safeParse(settings.ai ?? {});
  return parsed.success ? parsed.data : aiSettingsSchema.parse({});
};

export const loadAiSettings = async (db: Db, accountId: string) =>
  aiSettingsOf(await getAccountSettings(db, accountId));

/** perm.mcp: admins always; members / viewers when the account allows them; guests never (§8). */
export const mayUseMcp = (ai: AiSettings, role: AccountRole) =>
  ai.mcp_enabled && (role === 'admin' || (role !== 'guest' && ai.mcp_roles.includes(role)));

export const getAiSettings = async (deps: Pick<Deps, 'db'>, a: AdminActor) => {
  assertAccountAdmin(a.ctx);
  return loadAiSettings(deps.db, a.ctx.accountId);
};

/** PATCH /ai/settings — only what was sent; one `account.updated` event + an `ai.settings_changed` audit row. */
export const updateAiSettings = async (
  deps: Pick<Deps, 'db'>,
  a: AdminActor,
  raw: UpdateAiSettings,
  meta: RequestMeta,
) => {
  assertAccountAdmin(a.ctx);
  const input = updateAiSettingsSchema.parse(raw);
  return deps.db.transaction(async (tx) => {
    const settings = await getAccountSettings(tx, a.ctx.accountId);
    const before = aiSettingsOf(settings);
    const after = aiSettingsSchema.parse({ ...before, ...input });
    const changed = (Object.keys(after) as (keyof AiSettings)[]).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    if (!changed.length) return after;
    await upsertAccountSettings(tx, a.ctx.accountId, { ...settings, ai: after }, a.user.id);
    const b = Object.fromEntries(changed.map((k) => [k, before[k]]));
    const n = Object.fromEntries(changed.map((k) => [k, after[k]]));
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'account.updated',
      actorId: a.user.id,
      requestId: a.requestId ?? meta.requestId,
      before: { ai: b },
      after: { ai: n },
    });
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'ai.settings_changed',
      targetType: 'account',
      targetId: a.ctx.accountId,
      payload: { fields: changed, before: b, after: n },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return after;
  });
};

// ---- connections ----

const connectionDto = (r: AiConnectionRow & { createdByName?: string | null }): AiConnection => ({
  id: r.id,
  name: r.name,
  provider: r.provider as AiConnection['provider'],
  key_hint: r.keyHint,
  default_model: r.defaultModel,
  base_url: r.baseUrl ?? null,
  manual_models: manualOf(r),
  price_overrides: overridesOf(r),
  last_test: r.lastTest ?? null,
  last_used_at: r.lastUsedAt?.toISOString() ?? null,
  created_at: r.createdAt.toISOString(),
  created_by_name: r.createdByName ?? null,
});

const connectionEvent = (
  db: Db,
  a: AdminActor,
  meta: RequestMeta,
  action: 'created' | 'updated' | 'deleted',
  row: AiConnectionRow,
  payload: Record<string, unknown> = {},
) =>
  Promise.all([
    recordEvent(db, {
      accountId: a.ctx.accountId,
      type: `ai_connection.${action}`,
      actorId: a.user.id,
      requestId: a.requestId ?? meta.requestId,
      meta: { connection_id: row.id, name: row.name, provider: row.provider, ...payload },
    }),
    recordAudit(db, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: `ai.connection_${action}`,
      targetType: 'ai_connection',
      targetId: row.id,
      payload: { name: row.name, provider: row.provider, ...payload },
      ip: meta.ip,
      userAgent: meta.userAgent,
    }),
  ]);

export const listConnections = async (deps: Pick<Deps, 'db'>, a: AdminActor) => {
  assertAccountAdmin(a.ctx);
  const rows = await listConnectionRows(deps.db, a.ctx.accountId);
  return { data: rows.map((r) => connectionDto({ ...r.c, createdByName: r.createdByName })) };
};

/**
 * S-65: remote support access never adds or re-points an AI connection — a server it chooses would receive the
 * account's prompts (and, re-pointed, the saved key) after the access ends (like webhooks, S-54).
 */
const assertNotSupport = (a: AdminActor) => {
  if (a.ctx.support) throw new AppError('forbidden', 'support_not_allowed', { reason: 'ai_connection' });
};
const originOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

export const createConnection = async (
  deps: Deps,
  a: AdminActor,
  input: z.infer<typeof createAiConnectionSchema>,
  meta: RequestMeta,
) => {
  assertAccountAdmin(a.ctx);
  assertNotSupport(a);
  const info = AI_PROVIDER_INFO[input.provider];
  if (info.keyRequired && input.api_key.length < 10) throw new AppError('invalid_value', 'ai_key_required');
  const baseUrl = info.baseUrl ? (input.base_url ?? null) : null;
  if (info.baseUrl && !baseUrl) throw new AppError('invalid_value', 'ai_base_url_required');
  const allowPrivate = await localAiAllowedFor(deps.db, baseUrl);
  // SSRF guard (lib/outbound): a public address unless the owner allowed local AI endpoints.
  if (baseUrl) await assertAiBaseUrl(baseUrl, allowPrivate);
  // The provider's own list, read with the new key (Fix: ) — the default model must be on it (or added by hand).
  const models = await readProviderModels(deps, {
    provider: input.provider,
    apiKey: input.api_key,
    baseUrl,
    allowPrivate,
  });
  assertListedModel(models, input.default_model, input.manual_models);
  const created = await deps.db.transaction(async (tx) => {
    const [row] = await insertConnection(tx, {
      id: newId(),
      accountId: a.ctx.accountId,
      name: input.name,
      provider: input.provider,
      keyEnc: deps.secrets.seal(input.api_key),
      keyHint: input.api_key ? keyHint(input.api_key) : '—',
      baseUrl,
      manualModels: input.manual_models ?? [],
      defaultModel: input.default_model ?? null,
      createdBy: a.user.id,
    });
    await connectionEvent(tx, a, meta, 'created', row!);
    return row!;
  });
  rememberModels(created, models);
  return connectionDto({ ...created, createdByName: a.user.name });
};

const loadConnection = async (db: Db, a: AdminActor, id: string) => {
  const row = await findConnection(db, a.ctx.accountId, id);
  if (!row) throw new AppError('not_found', 'AI connection not found');
  return row;
};

export const updateConnection = async (
  deps: Deps,
  a: AdminActor,
  id: string,
  input: z.infer<typeof updateAiConnectionSchema>,
  meta: RequestMeta,
) => {
  assertAccountAdmin(a.ctx);
  const row = await loadConnection(deps.db, a, id);
  const info = AI_PROVIDER_INFO[row.provider as keyof typeof AI_PROVIDER_INFO];
  // A new server (OpenAI-compatible only): guarded like a new connection's.
  const baseUrl = info?.baseUrl && input.base_url ? input.base_url : undefined;
  if (info?.baseUrl && input.base_url === null) throw new AppError('invalid_value', 'ai_base_url_required');
  if (baseUrl) {
    assertNotSupport(a);
    await assertAiBaseUrl(baseUrl, await localAiAllowedFor(deps.db, baseUrl));
    // S-65: the saved key is write-only — it never goes to a new server unless it is given again with it.
    if (!input.api_key && row.keyEnc && originOf(baseUrl) !== originOf(row.baseUrl))
      throw new AppError('invalid_value', 'ai_key_required_for_new_server');
  }
  if (input.api_key) assertNotSupport(a);
  const manual = input.manual_models ?? manualOf(row);
  if (input.default_model) {
    // With a new key or server, the list they see; else the connection's (cached) list.
    const models =
      input.api_key || baseUrl
        ? await readProviderModels(deps, {
            ...(await secretOf(deps, row)),
            ...(input.api_key ? { apiKey: input.api_key } : {}),
            ...(baseUrl ? { baseUrl } : {}),
          })
        : await connectionModels(deps, row);
    assertListedModel(models, input.default_model, manual);
  }
  let priceOverrides: Record<string, AiPriceOverride> | undefined;
  if (input.price_overrides) {
    priceOverrides = { ...overridesOf(row) };
    for (const [model, price] of Object.entries(input.price_overrides)) {
      if (price)
        priceOverrides[model] = {
          input: price.input,
          output: price.output,
          ...(price.cache_read !== undefined ? { cache_read: price.cache_read } : {}),
          ...(price.cache_write !== undefined ? { cache_write: price.cache_write } : {}),
        };
      else delete priceOverrides[model];
    }
  }
  const updated = await deps.db.transaction(async (tx) => {
    const [next] = await updateConnectionRow(tx, row.id, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.default_model !== undefined ? { defaultModel: input.default_model } : {}),
      ...(priceOverrides ? { priceOverrides } : {}),
      ...(baseUrl ? { baseUrl, lastTest: null } : {}),
      ...(input.manual_models ? { manualModels: input.manual_models } : {}),
      // A new key: the old test result no longer says anything.
      ...(input.api_key
        ? { keyEnc: deps.secrets.seal(input.api_key), keyHint: keyHint(input.api_key), lastTest: null }
        : {}),
    });
    await connectionEvent(tx, a, meta, 'updated', next!, {
      fields: Object.keys(input).map((k) => (k === 'api_key' ? 'key' : k)),
    });
    return connectionDto(next!);
  });
  // A new key or server may see other models: the next picker reads the provider again (sync-ai).
  if (input.api_key || baseUrl) forgetModels(row.id);
  return updated;
};

/** Soft delete: its usage rows keep their history; agents using it will need another (מ6). */
export const deleteConnection = async (deps: Deps, a: AdminActor, id: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  const row = await loadConnection(deps.db, a, id);
  await deps.db.transaction(async (tx) => {
    await updateConnectionRow(tx, row.id, { deletedAt: new Date() });
    await connectionEvent(tx, a, meta, 'deleted', row);
  });
  forgetModels(row.id);
  return { ok: true as const };
};

/**
 * GET /ai/connections/:id/models — the models the connection may use, live from the provider (cached an hour),
 * newest first, with prices. Every model picker reads it (agents, AI columns, the assistant), so not only admins:
 * anyone who may set up AI (members and admins; never viewers or guests).
 */
export const listConnectionModels = async (deps: Deps, a: AdminActor, id: string, refresh = false) => {
  if (a.ctx.role !== 'admin' && a.ctx.role !== 'member') throw new AppError('forbidden', 'ai_models_forbidden');
  const row = await loadConnection(deps.db, a, id);
  // Asking the provider again is an admin's button; others get the cached list.
  const entry = await connectionModels(deps, row, { refresh: refresh && a.ctx.role === 'admin' });
  return modelList(entry, row, await loadPriceTable(deps.db));
};

/**
 * POST /ai/connections/models — the models a provider lists for a key, before the connection is saved (admins): the
 * new-connection dialog picks its default model from the live list, as an existing connection does. Nothing is kept.
 */
export const previewModels = async (deps: Deps, a: AdminActor, input: z.infer<typeof previewAiModelsSchema>) => {
  assertAccountAdmin(a.ctx);
  const info = AI_PROVIDER_INFO[input.provider];
  if (info.keyRequired && input.api_key.length < 10) throw new AppError('invalid_value', 'ai_key_required');
  const baseUrl = info.baseUrl ? (input.base_url ?? null) : null;
  if (info.baseUrl && !baseUrl) throw new AppError('invalid_value', 'ai_base_url_required');
  const allowPrivate = await localAiAllowedFor(deps.db, baseUrl);
  if (baseUrl) await assertAiBaseUrl(baseUrl, allowPrivate);
  const read = await readProviderModels(deps, {
    provider: input.provider,
    apiKey: input.api_key,
    baseUrl,
    allowPrivate,
  });
  const row = {
    provider: input.provider,
    manualModels: input.manual_models ?? [],
    defaultModel: null,
    priceOverrides: {},
  };
  return modelList({ ...read, at: Date.now() }, row, await loadPriceTable(deps.db));
};

/** POST /ai/connections/:id/test — a cheap call that proves the key works; the result is kept on the row. */
export const testConnection = async (deps: Deps, a: AdminActor, id: string) => {
  assertAccountAdmin(a.ctx);
  const row = await loadConnection(deps.db, a, id);
  const client = deps.aiClient(await secretOf(deps, row));
  const result = await client.test();
  await updateConnectionRow(deps.db, row.id, { lastTest: { ...result, at: new Date().toISOString() } });
  return result;
};

/**
 * Whether the account may spend on AI now: AI on, the plan's `ai` feature (not for a key test), the plan's monthly
 * AI budget and the account's own. Every model call (`completeWith`) and every image (AI images) asks it first.
 */
export const assertAiAvailable = async (db: Db, accountId: string, source: string) => {
  // plan-lock: a read-only / suspended / closed account has no AI at all (the status's own error).
  await assertAiStatusAllows(db, accountId);
  const ai = await loadAiSettings(db, accountId);
  if (!ai.enabled) throw new AppError('forbidden', 'ai_disabled');
  // Plans: every AI feature (assistant, agents, AI columns, images) is the plan's `ai` (a key test is not).
  if (source !== 'test') await assertFeature(db, accountId, 'ai');
  // Plans: the plan's monthly AI budget caps the account's own (402 plan_limit_reached when used up).
  await assertWithinLimit(db, accountId, 'ai_usd', 0);
  if (ai.monthly_budget_usd !== null) {
    const month = new Date().toISOString().slice(0, 7);
    const spent = (await usageBetween(db, accountId, `${month}-01`, nextMonth(month))).reduce(
      (s, r) => s + Number(r.costUsd),
      0,
    );
    if (spent >= ai.monthly_budget_usd) throw new AppError('forbidden', 'ai_budget_exceeded');
  }
  return ai;
};

/**
 * One model call through a connection, recorded in `ai_usage` with its real cost (the base every AI feature
 * uses: agents מ6, AI columns מ11, the assistant מ12). Refuses when AI is off in the account or the month's budget
 * is used up.
 */
export const completeWith = async (
  deps: Deps,
  accountId: string,
  connectionId: string,
  source: 'agent' | 'column' | 'assistant' | 'help' | 'test' | 'support_agent',
  req: Omit<AiCompletionRequest, 'model'> & { model?: string },
) => {
  await assertAiAvailable(deps.db, accountId, source);
  const row = await findConnection(deps.db, accountId, connectionId);
  if (!row) throw new AppError('not_found', 'AI connection not found');
  // None chosen: the connection's default, else the newest tool-calling model of its live list (any provider).
  const model = req.model ?? (await connectionDefaultModel(deps, row));
  if (!model) throw new AppError('invalid_value', 'ai_no_model');
  // Listed for the connection (live, catalogue or by hand); brings what it takes, what it can do and its price.
  const known = await modelForCall(deps, row, model);
  // Features that hand the model tools (agents, assistant writes, the flows builder, MCP tools) need a model that
  // calls tools — a model without them is refused up front with a clear reason.
  if (req.tools?.length && !known.capabilities.tools)
    throw new AppError('invalid_value', 'ai_model_no_tools', { model });
  if (!known.capabilities.vision && hasImages(req.messages))
    throw new AppError('invalid_value', 'ai_model_no_vision', { model });
  const client = deps.aiClient(await secretOf(deps, row));
  let called: Awaited<ReturnType<typeof client.complete>>;
  try {
    called = await client.complete({
      ...req,
      model,
      ...(known.supports ? { supports: known.supports } : {}),
      ...(known.capabilities.streaming ? {} : { stream: false }),
      price: known.price,
    });
  } catch (err) {
    // Errors hub: `ai_usage` keeps tokens only — a failed model call is recorded there.
    recordAiFailure(deps.db, { accountId, connectionId: row.id, source, model, err });
    throw err;
  }
  // A fallback may have served the turn: price it as the model that did, when it has a price of its own.
  const served =
    called.model && called.model !== model
      ? resolveAiPrice(
          row.provider,
          called.model,
          overridesOf(row),
          known.table,
          cachedListedPrice(row.id, called.model),
        )
      : null;
  const out = served ? { ...called, costUsd: aiCost(called.usage, served.price) } : called;
  await addUsage(deps.db, {
    accountId,
    day: new Date().toISOString().slice(0, 10),
    source,
    connectionId: row.id,
    model,
    inputTokens: out.usage.input_tokens,
    outputTokens: out.usage.output_tokens,
    cacheReadTokens: out.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: out.usage.cache_creation_input_tokens ?? 0,
    costUsd: out.costUsd,
  });
  await updateConnectionRow(deps.db, row.id, { lastUsedAt: new Date() });
  return out;
};

/**
 * Whether the model a call would use (the one given, else the connection's default) reads images — chat attachments
 * send an image only to a model that does. False when the connection or model cannot be resolved
 * (the call itself then refuses with its own reason).
 */
export const modelReadsImages = async (
  deps: Deps,
  accountId: string,
  connectionId: string,
  model?: string | null,
): Promise<boolean> => {
  try {
    const row = await findConnection(deps.db, accountId, connectionId);
    if (!row) return false;
    const id = model || (await connectionDefaultModel(deps, row));
    return id ? (await modelForCall(deps, row, id)).capabilities.vision : false;
  } catch {
    return false;
  }
};

const hasImages = (messages: AiCompletionRequest['messages']) =>
  messages.some((m) => typeof m.content !== 'string' && m.content.some((b) => b.type === 'image'));

// ---- usage ----

const nextMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
};

export const aiUsageReport = async (
  deps: Pick<Deps, 'db'>,
  a: AdminActor,
  q: { month?: string },
): Promise<AiUsageReport> => {
  assertAccountAdmin(a.ctx);
  const month = q.month ?? new Date().toISOString().slice(0, 7);
  const [rows, names, ai, table, conns] = await Promise.all([
    usageBetween(deps.db, a.ctx.accountId, `${month}-01`, nextMonth(month)),
    connectionNames(deps.db, a.ctx.accountId),
    loadAiSettings(deps.db, a.ctx.accountId),
    loadPriceTable(deps.db),
    listConnectionRows(deps.db, a.ctx.accountId),
  ]);
  const byId = new Map(conns.map((r) => [r.c.id, r.c]));
  // Whether the model has a price now (the connection's, the table's, else its provider list's) — no price =
  // recorded at 0.
  const priced = (connectionId: string, model: string) => {
    const conn = byId.get(connectionId);
    return !!resolveAiPrice(
      conn?.provider ?? '',
      model,
      conn ? overridesOf(conn) : null,
      table,
      cachedListedPrice(connectionId, model),
    );
  };
  const out = rows
    .map((r) => ({
      connection_id: r.connectionId,
      connection_name: names.get(r.connectionId) ?? null,
      source: r.source,
      model: r.model,
      calls: Number(r.calls),
      input_tokens: Number(r.inputTokens),
      output_tokens: Number(r.outputTokens),
      cost_usd: Math.round(Number(r.costUsd) * 1_000_000) / 1_000_000,
      price_known: priced(r.connectionId, r.model),
    }))
    .sort((x, y) => y.cost_usd - x.cost_usd);
  const unpriced = new Map<string, AiUsageReport['unpriced_models'][number]>();
  for (const r of out)
    if (!r.price_known)
      unpriced.set(`${r.connection_id}|${r.model}`, {
        connection_id: r.connection_id,
        connection_name: r.connection_name,
        model: r.model,
      });
  return {
    month,
    total_usd: Math.round(out.reduce((s, r) => s + r.cost_usd, 0) * 1_000_000) / 1_000_000,
    budget_usd: ai.monthly_budget_usd,
    rows: out,
    unpriced_models: [...unpriced.values()],
  };
};

// ---- MCP page ----

/** The MCP address: on the web origin (D2/D13 — one origin; never hard-coded). */
export const mcpUrl = async (deps: Pick<AppDeps, 'db' | 'env'>) => `${await apiOrigin(deps)}/mcp`;

/** GET /ai/mcp — the address, whether I may connect, and the tools my role would get (with every scope). */
export const mcpInfo = async (deps: Pick<Deps, 'db' | 'env'>, a: AdminActor): Promise<McpInfo> => {
  const ai = await loadAiSettings(deps.db, a.ctx.accountId);
  const allowed = mayUseMcp(ai, a.ctx.role);
  return {
    url: await mcpUrl(deps),
    enabled: ai.mcp_enabled,
    allowed,
    protocol_versions: MCP_PROTOCOL_VERSIONS,
    tools: allowed
      ? toolsFor({ scopes: [...TOKEN_SCOPES], readOnly: a.ctx.role === 'viewer', sensitive: ai.mcp_sensitive }).map(
          (t) => ({ name: t.name, title: t.title, family: t.family, scope: t.scope, risk: t.risk }),
        )
      : [],
  };
};
