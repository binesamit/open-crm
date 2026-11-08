// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gte, inArray, isNull, sum } from 'drizzle-orm';
import {
  AppError,
  supportAgentSettingsSchema,
  type SupportAgentConnection,
  type SupportAgentConnections,
  type SupportAgentSettings,
  type SupportConsoleRole,
  type SupportAgentSettingsDto,
  type SupportLogSource,
  type SupportLogSourceInput,
  newId,
  type UpdateSupportAgentSettings,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accountMembers, accounts, aiConnections, supportAgentRuns } from '../../db/schema';
import { keyHint } from '../../lib/secrets';
import type { AppDeps } from '../../types';
import { insertPlatformAudit } from '../account-deletion/account-deletion.repo';
import { platformAiRow } from '../help/help.ai';
import { loadHelpSettings } from '../help/help.settings';
import { readSettingsRow, writeSettingsRow } from '../license/license.repo';
import { normalizeOpsTypes, opsTypesDto } from './ops-tasks';

/**
 * The support agent's settings, row `support_agent` of platform_settings: the kill switch, the
 * AI connection (an existing one — no key of its own), the model and cost caps, the GitHub repository and its read-only token (sealed; the console only learns it is set).
 * The owner and support leads change them; every change is in the platform's audit log.
 */
export const SUPPORT_AGENT_ROW = 'support_agent';

export const loadSupportAgentSettings = async (db: Db): Promise<SupportAgentSettings> =>
  supportAgentSettingsSchema.parse((await readSettingsRow(db, SUPPORT_AGENT_ROW)) ?? {});

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** What this month's runs cost (kept on the runs; through a chosen connection, also in that account's AI usage). */
export const supportAgentMonthSpend = async (db: Db, now = new Date()) =>
  Number(
    (
      await db
        .select({ v: sum(supportAgentRuns.costUsd) })
        .from(supportAgentRuns)
        .where(gte(supportAgentRuns.createdAt, monthStart(now)))
    )[0]?.v ?? 0,
  );

export const mayEditSupportAgent = (role: SupportConsoleRole) => role === 'owner' || role === 'lead';

/** Who may send the agent to write a fix: the owner, and the roles the settings name — with a write token set. */
export const mayDevelop = (role: SupportConsoleRole, s: SupportAgentSettings) =>
  !!s.github.write_token_enc && !!s.github.repo && (role === 'owner' || s.develop_roles.includes(role));

/** The accounts where this person is an active admin (live accounts only). */
const adminAccounts = async (db: Db, userId: string) =>
  db
    .select({ id: accounts.id, name: accounts.name })
    .from(accountMembers)
    .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
    .where(
      and(
        eq(accountMembers.userId, userId),
        eq(accountMembers.role, 'admin'),
        eq(accountMembers.status, 'active'),
        isNull(accounts.deletedAt),
      ),
    )
    .orderBy(asc(accounts.name));

/**
 * The AI connections a person may give the agent: the live connections of the accounts where they are an active
 * admin (they could use them anyway) — so nobody re-enters a key the account already has. With the internal-accounts
 * marker on, only the marked accounts' connections.
 */
export const connectionsFor = async (
  db: Db,
  userId: string,
  internal: SupportAgentSettings['internal_accounts'],
): Promise<SupportAgentConnection[]> => {
  const marked = new Set(internal.account_ids);
  const mine = (await adminAccounts(db, userId)).filter((a) => !internal.only || marked.has(a.id));
  if (!mine.length) return [];
  const names = new Map(mine.map((a) => [a.id, a.name]));
  const rows = await db
    .select({
      id: aiConnections.id,
      accountId: aiConnections.accountId,
      name: aiConnections.name,
      provider: aiConnections.provider,
    })
    .from(aiConnections)
    .where(and(inArray(aiConnections.accountId, [...names.keys()]), isNull(aiConnections.deletedAt)))
    .orderBy(asc(aiConnections.name));
  return rows.map((r) => ({
    account_id: r.accountId,
    account_name: names.get(r.accountId) ?? '',
    connection_id: r.id,
    name: r.name,
    provider: r.provider,
    internal: marked.has(r.accountId),
  }));
};

/** GET /platform/support-agent/connections — what the settings' picker offers this person. */
export const supportAgentConnections = async (db: Db, userId: string): Promise<SupportAgentConnections> => {
  const { internal_accounts } = await loadSupportAgentSettings(db);
  const marked = new Set(internal_accounts.account_ids);
  return {
    data: await connectionsFor(db, userId, internal_accounts),
    help_center: !!platformAiRow((await loadHelpSettings(db)).ai),
    accounts: (await adminAccounts(db, userId)).map((a) => ({ ...a, internal: marked.has(a.id) })),
  };
};

/** The chosen connection, live (null when none is chosen, or it was deleted). */
export const chosenConnection = async (db: Db, s: SupportAgentSettings) => {
  if (!s.ai_connection) return null;
  const [row] = await db
    .select({
      id: aiConnections.id,
      name: aiConnections.name,
      provider: aiConnections.provider,
      accountName: accounts.name,
    })
    .from(aiConnections)
    .innerJoin(accounts, eq(accounts.id, aiConnections.accountId))
    .where(
      and(
        eq(aiConnections.id, s.ai_connection.connection_id),
        eq(aiConnections.accountId, s.ai_connection.account_id),
        isNull(aiConnections.deletedAt),
        isNull(accounts.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
};

/** Whether the agent has an AI to call: the chosen connection (when one is chosen), else the help center's. */
export const supportAgentAiReady = async (db: Db, s: SupportAgentSettings) =>
  s.ai_connection ? !!(await chosenConnection(db, s)) : !!platformAiRow((await loadHelpSettings(db)).ai);

export const supportAgentSettingsDto = async (
  db: Db,
  role: SupportConsoleRole,
  s?: SupportAgentSettings,
): Promise<SupportAgentSettingsDto> => {
  const settings = s ?? (await loadSupportAgentSettings(db));
  const { github, ai_connection, log_sources, ops_tasks, ...rest } = settings;
  const chosen = await chosenConnection(db, settings);
  return {
    ...rest,
    ai_connection: ai_connection
      ? {
          ...ai_connection,
          account_name: chosen?.accountName ?? '',
          name: chosen?.name ?? '',
          provider: chosen?.provider ?? '',
          missing: !chosen,
        }
      : null,
    github: {
      repo: github.repo,
      has_read_token: !!github.read_token_enc,
      read_token_hint: github.read_token_hint,
      has_write_token: !!github.write_token_enc,
      write_token_hint: github.write_token_hint,
      base_branch: github.base_branch,
    },
    may_develop: mayDevelop(role, settings),
    log_sources: log_sources.map(({ token_enc, ...l }) => ({ ...l, has_token: !!token_enc })),
    may_sql: role === 'owner',
    ops_tasks: await opsTypesDto(db, ops_tasks),
    ai_ready: await supportAgentAiReady(db, settings),
    can_edit: mayEditSupportAgent(role),
    month_usd: Math.round((await supportAgentMonthSpend(db)) * 100) / 100,
  };
};

/** PATCH /platform/support-agent/settings — the owner and leads. */
export const updateSupportAgentSettings = async (
  deps: Pick<AppDeps, 'db' | 'secrets'>,
  actor: { userId: string; role: SupportConsoleRole },
  patch: UpdateSupportAgentSettings,
) => {
  if (!mayEditSupportAgent(actor.role)) throw new AppError('forbidden', 'support_agent_settings_lead_only');
  // Read-only SQL reaches every account's tables: the platform owner alone turns it on.
  if (patch.sql_enabled !== undefined && actor.role !== 'owner')
    throw new AppError('forbidden', 'support_agent_sql_owner_only');
  const cur = await loadSupportAgentSettings(deps.db);
  let logSources = cur.log_sources;
  if (patch.log_source) logSources = upsertLogSource(deps, logSources, patch.log_source);
  if (patch.remove_log_source) logSources = logSources.filter((l) => l.id !== patch.remove_log_source);
  // The marker: this person sets it on the accounts where they are an admin; the other marked accounts stay.
  let internal = cur.internal_accounts;
  if (patch.internal_accounts) {
    const theirs = new Set((await adminAccounts(deps.db, actor.userId)).map((a) => a.id));
    internal = {
      only: patch.internal_accounts.only,
      account_ids: [
        ...new Set([
          ...cur.internal_accounts.account_ids.filter((id) => !theirs.has(id)),
          ...patch.internal_accounts.account_ids.filter((id) => theirs.has(id)),
        ]),
      ].slice(0, 200),
    };
  }
  // A connection only from an account where this person is an admin (never someone else's key) — and, with the
  // marker on, a marked one.
  if (
    patch.ai_connection &&
    !(await connectionsFor(deps.db, actor.userId, internal)).some(
      (c) => c.account_id === patch.ai_connection!.account_id && c.connection_id === patch.ai_connection!.connection_id,
    )
  )
    throw new AppError('forbidden', 'support_agent_connection_not_yours');
  const next: SupportAgentSettings = {
    ...cur,
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.ai_connection !== undefined ? { ai_connection: patch.ai_connection } : {}),
    internal_accounts: internal,
    ...(patch.model !== undefined ? { model: patch.model || null } : {}),
    ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
    ...(patch.max_steps !== undefined ? { max_steps: patch.max_steps } : {}),
    ...(patch.max_usd_per_run !== undefined ? { max_usd_per_run: patch.max_usd_per_run } : {}),
    ...(patch.max_usd_per_month !== undefined ? { max_usd_per_month: patch.max_usd_per_month } : {}),
    ...(patch.develop_roles !== undefined ? { develop_roles: [...new Set(patch.develop_roles)] } : {}),
    log_sources: logSources,
    ...(patch.ops_tasks !== undefined
      ? { ops_tasks: await normalizeOpsTypes(deps.db, actor.userId, cur.ops_tasks, patch.ops_tasks) }
      : {}),
    ...(patch.sql_enabled !== undefined ? { sql: { enabled: patch.sql_enabled } } : {}),
    ...(patch.auto !== undefined
      ? {
          auto: {
            ...patch.auto,
            severities: [...new Set(patch.auto.severities)],
            // Runs as whoever turned it on (their access decides what it may read); kept while it stays on.
            run_as: patch.auto.enabled ? (cur.auto.enabled && cur.auto.run_as ? cur.auto.run_as : actor.userId) : null,
          },
        }
      : {}),
    github: {
      ...cur.github,
      ...(patch.github_repo !== undefined ? { repo: patch.github_repo } : {}),
      ...(patch.github_base_branch !== undefined ? { base_branch: patch.github_base_branch } : {}),
      ...(patch.github_write_token === undefined
        ? {}
        : patch.github_write_token === null
          ? { write_token_enc: null, write_token_hint: null }
          : {
              write_token_enc: deps.secrets.seal(patch.github_write_token),
              write_token_hint: keyHint(patch.github_write_token),
            }),
      ...(patch.github_read_token === undefined
        ? {}
        : patch.github_read_token === null
          ? { read_token_enc: null, read_token_hint: null }
          : {
              read_token_enc: deps.secrets.seal(patch.github_read_token),
              read_token_hint: keyHint(patch.github_read_token),
            }),
    },
  };
  await writeSettingsRow(deps.db, SUPPORT_AGENT_ROW, next, actor.userId);
  // What changed — never a token's value.
  const changed = Object.keys(patch).map((k) =>
    k.endsWith('_token') || (k === 'log_source' && patch.log_source?.token !== undefined) ? `${k}(token changed)` : k,
  );
  await insertPlatformAudit(deps.db, {
    action: 'support_agent.settings',
    targetType: 'platform',
    targetId: SUPPORT_AGENT_ROW,
    actorId: actor.userId,
    payload: { fields: changed, enabled: next.enabled },
  });
  return supportAgentSettingsDto(deps.db, actor.role, next);
};

/** Adds or changes one log source: the fields its kind needs, the token sealed (absent = kept, null = removed). */
const upsertLogSource = (
  deps: Pick<AppDeps, 'secrets'>,
  list: SupportLogSource[],
  input: SupportLogSourceInput,
): SupportLogSource[] => {
  const cur = input.id ? list.find((l) => l.id === input.id) : undefined;
  if (input.id && !cur) throw new AppError('not_found', 'support_agent_log_source_not_found');
  if (!input.id && list.length >= 10) throw new AppError('invalid_value', 'support_agent_log_sources_max');
  const next: SupportLogSource = {
    id: cur?.id ?? newId(),
    kind: input.kind,
    name: input.name,
    token_enc: cur?.token_enc ?? null,
    token_hint: cur?.token_hint ?? null,
    environment_id: input.environment_id !== undefined ? input.environment_id || null : (cur?.environment_id ?? null),
    service_id: input.service_id !== undefined ? input.service_id || null : (cur?.service_id ?? null),
    base_url: input.base_url !== undefined ? input.base_url || null : (cur?.base_url ?? null),
    org: input.org !== undefined ? input.org || null : (cur?.org ?? null),
    project: input.project !== undefined ? input.project || null : (cur?.project ?? null),
  };
  if (input.token === null) Object.assign(next, { token_enc: null, token_hint: null });
  else if (input.token)
    Object.assign(next, { token_enc: deps.secrets.seal(input.token), token_hint: keyHint(input.token) });
  if (!next.token_enc) throw new AppError('invalid_value', 'support_agent_log_source_token');
  if (next.kind === 'railway' && !next.environment_id)
    throw new AppError('invalid_value', 'support_agent_log_source_environment');
  if (next.kind === 'sentry' && !(next.base_url && next.org && next.project))
    throw new AppError('invalid_value', 'support_agent_log_source_sentry');
  return cur ? list.map((l) => (l.id === cur.id ? next : l)) : [...list, next];
};

/** A log source's token, opened. */
export const logSourceToken = (deps: Pick<AppDeps, 'secrets'>, l: SupportLogSource) => openSealed(deps, l.token_enc);

const openSealed = (deps: Pick<AppDeps, 'secrets'>, sealed: string | null) => {
  if (!sealed) return null;
  try {
    return deps.secrets.open(sealed);
  } catch {
    return null;
  }
};

/** The read-only GitHub token, opened (null when unset or sealed with another key). */
export const githubReadToken = (deps: Pick<AppDeps, 'secrets'>, s: SupportAgentSettings) =>
  openSealed(deps, s.github.read_token_enc);

/** The write token ("approve development"), opened. */
export const githubWriteToken = (deps: Pick<AppDeps, 'secrets'>, s: SupportAgentSettings) =>
  openSealed(deps, s.github.write_token_enc);
