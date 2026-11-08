// SPDX-License-Identifier: AGPL-3.0-only
import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AI_LIVE_EVENTS,
  type AiCapabilities,
  type AiConnection,
  type AiModelList,
  type AiManualModel,
  type AiModelOption,
  type AiProvider,
  type AiSettings,
  type AiUsageReport,
  type McpConnection,
  type McpInfo,
  t,
  type UpdateAiSettings,
  isChatProvider,
  isTranscriptionProvider,
} from '@bines/shared';
import type { MenuEntry } from '@bines/ui';
import { api } from '../../lib/api';
import { fromThisTab, useEventStream } from '../../lib/realtime';

/** Administration → AI ו-MCP (the planning notes "AGENTS-MCP" מ1 + מ3). */
export const aiKeys = {
  settings: (accountId: string) => ['account', accountId, 'ai', 'settings'] as const,
  connections: (accountId: string) => ['account', accountId, 'ai', 'connections'] as const,
  usage: (accountId: string) => ['account', accountId, 'ai', 'usage'] as const,
  mcp: (accountId: string) => ['account', accountId, 'ai', 'mcp'] as const,
  models: (accountId: string, connectionId: string) => ['account', accountId, 'ai', 'models', connectionId] as const,
};

/**
 * Every cached answer that depends on the account's AI connections or AI settings (sync-ai, product owner: "after connecting AI
 * the assistant still said it was not connected"): the admin page, the agents' and AI columns' connection pickers,
 * the assistant's availability (its button on boards and items) and its settings, the model lists, MCP info.
 */
export const AI_DEPENDENT_KEYS = (accountId: string) =>
  [
    ['account', accountId, 'ai'],
    ['account', accountId, 'agents', 'connections'],
    ['account', accountId, 'agents', 'list'],
    ['account', accountId, 'agents', 'one'],
    ['account', accountId, 'ai-columns'],
    ['account', accountId, 'assistant', 'status'],
  ] as const;

/** Refetch everything AI-related now (active screens at once; the rest the next time they are shown). */
export const invalidateAi = (qc: QueryClient, accountId: string) =>
  Promise.all(AI_DEPENDENT_KEYS(accountId).map((queryKey) => qc.invalidateQueries({ queryKey: [...queryKey] })));

/** The last AI event acted on per account — every AI hook listens, one refresh per event is enough. */
const handled = new Map<string, string>();

/**
 * Live AI state (sync-ai): a connection added / changed / removed or the AI settings changed — by me in another
 * tab or by another admin — reaches every open screen over `/me/events`, and they refetch. Mounted by every hook that
 * reads AI state, so no screen needs to remember it; the stream is shared (one connection per tab).
 */
export const useAiLive = (accountId: string) => {
  const qc = useQueryClient();
  useEventStream('/me/events', accountId, (e) => {
    const relevant = AI_LIVE_EVENTS.has(e.type) || e.type === 'resync';
    if (!relevant || fromThisTab(e)) return;
    const key = e.id ?? `${e.type}:${Date.now()}`;
    if (e.id && handled.get(accountId) === key) return;
    handled.set(accountId, key);
    void invalidateAi(qc, accountId);
  });
};

/**
 * The models of an AI connection (Fix: ; — every provider): live from the provider through the API
 * (cached there an hour), tool-calling models first, newest and most capable first, with prices, capabilities and the
 * connection's default model. Every model picker uses it — agents, AI columns, the assistant, AI images, the flows
 * AI, the connection's default.
 */
export const useAiModels = (accountId: string, connectionId: string | null | undefined) =>
  useQuery({
    queryKey: aiKeys.models(accountId, connectionId ?? ''),
    queryFn: () => api(accountId).get<AiModelList>(`/ai/connections/${connectionId}/models`),
    enabled: !!connectionId,
    staleTime: 10 * 60_000,
  });

/**
 * "רענון מודלים": asks the provider again now (admins) and hands the fresh list to every picker of this
 * connection.
 */
export const useRefreshModels = (accountId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      api(accountId).get<AiModelList>(`/ai/connections/${connectionId}/models?refresh=true`),
    onSuccess: (fresh, connectionId) => qc.setQueryData(aiKeys.models(accountId, connectionId), fresh),
  });
};

/** A provider's live models for a key before the connection is saved (the new-connection dialog; nothing is kept). */
export const usePreviewModels = (accountId: string) =>
  useMutation({
    mutationFn: (input: {
      provider: AiProvider;
      api_key: string;
      base_url: string | null;
      manual_models?: AiManualModel[];
    }) =>
      api(accountId).post<AiModelList>('/ai/connections/models', {
        provider: input.provider,
        api_key: input.api_key,
        ...(input.base_url ? { base_url: input.base_url } : {}),
        ...(input.manual_models?.length ? { manual_models: input.manual_models } : {}),
      }),
  });

const usd = (n: number) => `$${Number.isInteger(n) ? n : n.toFixed(2).replace(/0$/, '')}`;

/** "$4/$20" per 1M tokens (in / out), or "מחיר לא ידוע". */
export const modelPrice = (m: Pick<AiModelOption, 'price'>) =>
  m.price ? `${usd(m.price.input)}/${usd(m.price.output)}` : t('ai.models.unknownPrice');

/** A context window as a short count: 200K, 1M, 1.05M. */
export const contextSize = (n: number) =>
  n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(2))}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

/**
 * A model's capability badges in a picker line: "no tools" (agents, assistant writes and the flows builder
 * refuse it), reads images, makes images, and its context window when the provider says it.
 */
export const capabilityBadges = (caps: AiCapabilities | undefined): string[] => {
  if (!caps) return [];
  const out: string[] = [];
  if (!caps.tools) out.push(t('ai.caps.noTools'));
  if (caps.vision) out.push(t('ai.caps.vision'));
  if (caps.image_generation) out.push(t('ai.caps.image_generation'));
  if (caps.max_context) out.push(contextSize(caps.max_context));
  return out;
};

/**
 * A picker line: the provider's display name, the price ("מחיר לא ידוע" when none — never hidden) and the badges.
 * The name and the price are isolated: in a Hebrew line a Latin name followed by a Latin price would
 * otherwise merge into one run and land in the middle, after the Hebrew badges.
 */
export const modelLabel = (
  m: Pick<AiModelOption, 'display_name' | 'price'> & Partial<Pick<AiModelOption, 'capabilities'>>,
) =>
  [
    `${FSI}${m.display_name}${PDI}`,
    m.price ? `${LRI}${modelPrice(m)}${PDI}` : modelPrice(m),
    ...capabilityBadges(m.capabilities),
  ].join(' · ');

/** Unicode bidi isolates: first-strong (the name's own direction), left-to-right (a price), and their end. */
const FSI = '\u2068';
const LRI = '\u2066';
const PDI = '\u2069';

/**
 * Who makes a model, as a long multi-maker list names it (OpenRouter: "Anthropic: Claude …" and
 * `anthropic/claude-…`): the display name's "Maker:" prefix, else the id's `maker/` prefix. Null = none.
 */
export const modelMaker = (m: Pick<AiModelOption, 'id' | 'display_name'>): string | null => {
  const named = /^([^:]{1,40}):\s+\S/.exec(m.display_name);
  if (named) return named[1]!.trim();
  const slash = m.id.indexOf('/');
  if (slash <= 0) return null;
  const maker = m.id.slice(0, slash);
  return maker.charAt(0).toLocaleUpperCase() + maker.slice(1);
};

/** Lists this long, from this many makers, are shown grouped by maker (one provider's own list is not). */
const GROUP_MIN_MODELS = 15;
const GROUP_MIN_MAKERS = 3;

/**
 * A model picker's options: every model of the list, searchable by its name, id and maker; a long list of
 * several makers (OpenRouter's hundreds) is grouped under each maker's name — the makers in the order of their
 * best-ranked model, each maker's models in the list's own order — and the "Maker:" prefix leaves the row's label.
 */
export const modelPickerOptions = (models: AiModelOption[], testId: string) => {
  const makers = models.map(modelMaker);
  const distinct = new Set(makers.filter(Boolean));
  const grouped = models.length >= GROUP_MIN_MODELS && distinct.size >= GROUP_MIN_MAKERS;
  const rows = models.map((m, i) => {
    const maker = makers[i] ?? null;
    const name = grouped && maker ? m.display_name.replace(new RegExp(`^${escapeRe(maker)}:\\s*`), '') : m.display_name;
    return {
      value: m.id,
      label: modelLabel({ ...m, display_name: name }),
      keywords: [m.id, maker].filter(Boolean).join(' '),
      testId,
      ...(grouped ? { group: maker ?? t('ai.models.otherMaker') } : {}),
    };
  });
  if (!grouped) return rows;
  const order = [...new Set(rows.map((r) => r.group!))];
  return order.flatMap((g) => rows.filter((r) => r.group === g));
};

/** The same options as menu rows (a `PickerButton`): each maker's heading, then its models; `current` is checked. */
export const modelMenuEntries = (
  models: AiModelOption[],
  current: string | null,
  onPick: (id: string) => void,
  testId: string,
): MenuEntry[] => {
  const out: MenuEntry[] = [];
  let group: string | undefined;
  for (const o of modelPickerOptions(models, testId)) {
    const g = (o as { group?: string }).group;
    if (g && g !== group) out.push({ kind: 'label', label: g });
    group = g;
    out.push({
      label: o.label,
      keywords: o.keywords,
      testId,
      checked: o.value === current,
      onSelect: () => onPick(o.value),
    });
  }
  return out;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The "connection's default" choice of a picker, naming the model it stands for when the list is loaded. */
export const defaultChoiceLabel = (base: string, list: AiModelList | undefined) => {
  const def = list?.data.find((m) => m.id === list.default_model);
  return def ? `${base} · ${def.display_name}` : base;
};

/** Whether a picked model can call tools (unknown = assume yes; the server refuses with a clear reason anyway). */
export const modelHasTools = (list: AiModelList | undefined, id: string | null | undefined) =>
  !id || list?.data.find((m) => m.id === id)?.capabilities.tools !== false;

/**
 * The choices of a model picker: the connection's live list (any provider), nothing before it loads or
 * without a connection (never another provider's catalogue). A saved model the list no longer has stays shown, by
 * its id, so it is not lost silently.
 */
/** A saved model the list does not have: assumed to work as chosen (the server refuses with a reason if not). */
const UNKNOWN_CAPABILITIES: AiCapabilities = {
  tools: true,
  vision: false,
  json: true,
  streaming: true,
  max_context: null,
  image_generation: false,
};

export const modelChoices = (list: AiModelList | undefined, current?: string | null): AiModelOption[] => {
  const base: AiModelOption[] = list?.data ?? [];
  if (current && !base.some((m) => m.id === current))
    return [
      ...base,
      {
        id: current,
        display_name: current,
        created_at: null,
        price: null,
        price_source: null,
        default: false,
        capabilities: UNKNOWN_CAPABILITIES,
        manual: false,
      },
    ];
  return base;
};

export const useAiSettings = (accountId: string) => {
  useAiLive(accountId);
  return useQuery({
    queryKey: aiKeys.settings(accountId),
    queryFn: () => api(accountId).get<AiSettings>('/ai/settings'),
  });
};

export const useUpdateAiSettings = (accountId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateAiSettings) => api(accountId).patch<AiSettings>('/ai/settings', patch),
    onSuccess: async (data) => {
      qc.setQueryData(aiKeys.settings(accountId), data);
      // AI on / off and the assistant's connection change what every AI screen shows (sync-ai).
      await invalidateAi(qc, accountId);
    },
  });
};

export const useMcpInfo = (accountId: string) =>
  useQuery({ queryKey: aiKeys.mcp(accountId), queryFn: () => api(accountId).get<McpInfo>('/ai/mcp') });

/** The connections with chat models — what chat features pick from (a speech-only one, Soniox, is left out). */
export const chatConnections = (list: AiConnection[] | undefined) =>
  (list ?? []).filter((c) => isChatProvider(c.provider));

/** The connections that transcribe (voice in updates). */
export const transcriptionConnections = (list: AiConnection[] | undefined) =>
  (list ?? []).filter((c) => isTranscriptionProvider(c.provider));

/** A connection's speech-to-text models, newest first (admins; Administration → AI → voice). */
export const useTranscriptionModels = (accountId: string, connectionId: string | null | undefined) =>
  useQuery({
    queryKey: [...aiKeys.models(accountId, connectionId ?? ''), 'transcription'],
    queryFn: () =>
      api(accountId).get<{ data: { id: string; display_name: string }[] }>(
        `/ai/connections/${connectionId}/transcription-models`,
      ),
    enabled: !!connectionId,
    staleTime: 10 * 60_000,
  });

export const useAiConnections = (accountId: string) => {
  useAiLive(accountId);
  return useQuery({
    queryKey: aiKeys.connections(accountId),
    queryFn: () => api(accountId).get<{ data: AiConnection[] }>('/ai/connections'),
  });
};

export const useAiUsage = (accountId: string) =>
  useQuery({ queryKey: aiKeys.usage(accountId), queryFn: () => api(accountId).get<AiUsageReport>('/ai/usage') });

export type ConnectionInput = {
  name: string;
  provider: AiProvider;
  api_key: string;
  base_url: string | null;
  default_model: string | null;
  manual_models?: AiManualModel[];
};

export type PriceOverrideInput = { input: number; output: number; cache_read?: number; cache_write?: number };

export const useConnectionMutations = (accountId: string) => {
  const qc = useQueryClient();
  // A connection feeds the agents, AI columns, the assistant and the model lists — all refetch (sync-ai).
  const refresh = () => invalidateAi(qc, accountId);
  return {
    create: useMutation({
      mutationFn: (input: ConnectionInput) =>
        api(accountId).post<AiConnection>('/ai/connections', {
          name: input.name,
          provider: input.provider,
          api_key: input.api_key,
          default_model: input.default_model,
          ...(input.base_url ? { base_url: input.base_url } : {}),
          ...(input.manual_models?.length ? { manual_models: input.manual_models } : {}),
        }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({
        id,
        ...patch
      }: {
        id: string;
        name?: string;
        api_key?: string;
        default_model?: string | null;
        base_url?: string | null;
        manual_models?: AiManualModel[];
        price_overrides?: Record<string, PriceOverrideInput | null>;
      }) => api(accountId).patch<AiConnection>(`/ai/connections/${id}`, patch),
      onSuccess: () => refresh(),
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(accountId).delete<{ ok: true }>(`/ai/connections/${id}`),
      onSuccess: refresh,
    }),
    test: useMutation({
      mutationFn: (id: string) =>
        api(accountId).post<{ ok: boolean; error: string | null }>(`/ai/connections/${id}/test`),
      onSuccess: refresh,
    }),
  };
};

/** AI apps connected over OAuth (מ5): mine, or everyone's for an admin (`all`). */
export const useMcpConnections = (accountId: string, all: boolean) =>
  useQuery({
    queryKey: ['account', accountId, 'mcp-connections', all],
    queryFn: () => api(accountId).get<{ data: McpConnection[] }>(`/mcp-connections${all ? '?all=true' : ''}`),
  });

export const useDisconnectMcp = (accountId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api(accountId).delete<{ ok: true }>(`/mcp-connections/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account', accountId, 'mcp-connections'] }),
  });
};
