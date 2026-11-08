// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import {
  AI_CAPABILITY_FLAGS,
  AI_COMPATIBLE_PRESETS,
  AI_PROVIDER_INFO,
  AI_PROVIDERS,
  type AiCapabilities,
  type AiConnection,
  type AiManualModel,
  type AiModelList,
  type AiModelOption,
  aiToolLabel,
  type AiProvider,
  type AiSettings,
  type MyAccount,
  t,
  tDynamic,
} from '@bines/shared';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  Picker,
  Segmented,
  SkeletonRows,
  Switch,
} from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { copyText } from '../../lib/entity-menu';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { McpServersPanel } from '../mcp-servers/McpServersPanel';
import { Panel, Row, SectionHeader } from '../admin/admin-parts';
import {
  type ConnectionInput,
  defaultChoiceLabel,
  modelChoices,
  modelPickerOptions,
  modelPrice,
  useAiConnections,
  useAiModels,
  useAiSettings,
  useAiUsage,
  useConnectionMutations,
  useMcpInfo,
  usePreviewModels,
  useRefreshModels,
  useUpdateAiSettings,
} from './ai-api';
import { McpConnections } from './McpConnections';
import { AssistantSettings } from '../ai2/AssistantSettings';
import { ImageSettings } from './ImageSettings';
import { VoiceSettings } from './VoiceSettings';
import { brandText } from '../../lib/branding';
import { WebSearchCard } from './WebSearchCard';

const fail = (err: unknown) => showToast({ message: errorMessage(err), tone: 'error' });
const saved = () => showToast({ message: t('admin.general.saved') });

/**
 * Administration → AI ו-MCP (the planning notes "AGENTS-MCP" §6, מ1 + מ3; D26): the MCP address with connection
 * instructions generated from this account's address (Claude Code, Cursor, VS Code), who may connect and the
 * sensitive-tool policy; AI connections (provider + write-only key, tested with one click); AI on / off, budget,
 * who creates agents; this month's AI spend. Everything here is data — nothing per client in code.
 */
export const AdminAi = ({ account }: { account: MyAccount }) => {
  const settings = useAiSettings(account.id);
  const update = useUpdateAiSettings(account.id);
  const save = (patch: Partial<AiSettings>) => update.mutate(patch, { onSuccess: saved, onError: fail });
  return (
    <div className="flex flex-col gap-4 pb-12" data-testid="admin-ai">
      <SectionHeader title={t('admin.section.ai')} subtitle={t('ai.subtitle')} />
      {settings.isError ? <Notice tone="error">{errorMessage(settings.error)}</Notice> : null}
      <McpPanel account={account} settings={settings.data} busy={update.isPending} onSave={save} />
      {/* Every member's AI apps connected over OAuth, with "disconnect" (מ5). */}
      <McpConnections account={account} all />
      <ConnectionsPanel account={account} />
      {/* External MCP servers: their tools for agents and automations (מ10). */}
      <McpServersPanel account={account} />
      {/* Web search for agents: the search service, its key and the limits. */}
      <WebSearchCard account={account} />
      {settings.data ? (
        <>
          <AiSettingsPanel settings={settings.data} busy={update.isPending} onSave={save} />
          <AssistantSettings account={account} settings={settings.data} busy={update.isPending} onSave={save} />
          <ImageSettings account={account} settings={settings.data} busy={update.isPending} onSave={save} />
          <VoiceSettings account={account} settings={settings.data} busy={update.isPending} onSave={save} />
        </>
      ) : !settings.isError ? (
        <SkeletonRows rows={3} label={t('app.loading')} />
      ) : null}
      <UsagePanel account={account} />
    </div>
  );
};

// ---- MCP ----

type Who = 'admins' | 'members' | 'members_viewers';
const whoOf = (roles: string[]): Who =>
  roles.includes('viewer') ? 'members_viewers' : roles.includes('member') ? 'members' : 'admins';
const rolesOf = (who: Who): AiSettings['mcp_roles'] =>
  who === 'admins' ? [] : who === 'members' ? ['member'] : ['member', 'viewer'];

type Client = 'claude_code' | 'cursor' | 'vscode' | 'claude_ai';

/** Config snippets: a header for Claude Code / Cursor / VS Code; Claude.ai / ChatGPT connect over OAuth (מ5). */
const snippet = (client: Client, name: string, url: string) => {
  const header = 'Bearer <TOKEN>';
  switch (client) {
    case 'claude_code':
      return `claude mcp add --transport http ${name} ${url} --header "Authorization: ${header}"`;
    case 'cursor':
      return JSON.stringify({ mcpServers: { [name]: { url, headers: { Authorization: header } } } }, null, 2);
    case 'vscode':
      return JSON.stringify(
        { servers: { [name]: { type: 'http', url, headers: { Authorization: header } } } },
        null,
        2,
      );
    default:
      // Claude.ai / ChatGPT (OAuth, מ5): only the address is pasted — no token.
      return url;
  }
};

const McpPanel = ({
  account,
  settings,
  busy,
  onSave,
}: {
  account: MyAccount;
  settings: AiSettings | undefined;
  busy: boolean;
  onSave: (patch: Partial<AiSettings>) => void;
}) => {
  const info = useMcpInfo(account.id);
  const [client, setClient] = useState<Client>('claude_code');
  const name = `bines-${account.slug}`;
  const url = info.data?.url ?? '';
  const code = snippet(client, name, url);
  return (
    <Panel title={t('ai.mcp.title')} hint={t('ai.mcp.hint')} testId="ai-mcp">
      {info.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {info.isError ? <Notice tone="error">{errorMessage(info.error)}</Notice> : null}
      {info.data ? (
        <>
          <Row label={t('ai.mcp.url')} hint={t('ai.mcp.urlHint')}>
            <code
              dir="ltr"
              className="rounded-[8px] border border-line bg-surface-2 px-2 py-1 text-[0.8125rem] text-heading"
              data-testid="ai-mcp-url"
            >
              {url}
            </code>
            <Button variant="secondary" size="sm" onClick={() => copyText(url)} data-testid="ai-mcp-copy-url">
              <Icon name="link" size={14} />
              {t('ai.copy')}
            </Button>
          </Row>
          {settings ? (
            <>
              <Row label={t('ai.mcp.enabled')} hint={t('ai.mcp.enabledHint')}>
                <Switch
                  checked={settings.mcp_enabled}
                  disabled={busy}
                  onChange={(on) => onSave({ mcp_enabled: on })}
                  label={t('ai.mcp.enabled')}
                  testId="ai-mcp-enabled"
                />
              </Row>
              <Row label={t('ai.mcp.who')} hint={t('ai.mcp.whoHint')}>
                <Segmented
                  value={whoOf(settings.mcp_roles)}
                  label={t('ai.mcp.who')}
                  testId="ai-mcp-who"
                  onChange={(v) => onSave({ mcp_roles: rolesOf(v) })}
                  options={[
                    { value: 'admins', label: t('ai.mcp.who.admins') },
                    { value: 'members', label: t('ai.mcp.who.members') },
                    { value: 'members_viewers', label: t('ai.mcp.who.membersViewers') },
                  ]}
                />
              </Row>
              <Row label={t('ai.mcp.sensitive')} hint={t('ai.mcp.sensitiveHint')}>
                <Segmented
                  value={settings.mcp_sensitive}
                  label={t('ai.mcp.sensitive')}
                  testId="ai-mcp-sensitive"
                  onChange={(v) => onSave({ mcp_sensitive: v })}
                  options={[
                    { value: 'allow', label: t('ai.mcp.sensitive.allow') },
                    { value: 'block', label: t('ai.mcp.sensitive.block') },
                  ]}
                />
              </Row>
            </>
          ) : null}
          <div className="space-y-3 px-3.5 py-3" data-testid="ai-mcp-instructions">
            <div className="text-sm font-semibold text-fg">{t('ai.mcp.howTo')}</div>
            <Segmented
              value={client}
              label={t('ai.mcp.howTo')}
              testId="ai-mcp-client"
              onChange={setClient}
              options={[
                { value: 'claude_code', label: 'Claude Code', testId: 'ai-mcp-client-claude_code' },
                { value: 'cursor', label: 'Cursor', testId: 'ai-mcp-client-cursor' },
                { value: 'vscode', label: 'VS Code', testId: 'ai-mcp-client-vscode' },
                { value: 'claude_ai', label: 'Claude.ai / ChatGPT', testId: 'ai-mcp-client-claude_ai' },
              ]}
            />
            <p className="text-xs text-muted">{brandText(`ai.mcp.step.${client}`)}</p>
            {client === 'claude_ai' ? (
              // OAuth (מ5): the app needs only the address; the person signs in and approves on our consent screen.
              <div className="grid gap-2 md:grid-cols-2" data-testid="ai-mcp-oauth-steps">
                {(['claude', 'chatgpt'] as const).map((app) => (
                  <div key={app} className="rounded-[10px] border border-line bg-surface p-3">
                    <div className="mb-1.5 text-[0.8125rem] font-semibold text-heading">
                      {app === 'claude' ? 'Claude.ai' : 'ChatGPT'}
                    </div>
                    <ol className="list-decimal space-y-1 ps-4 text-xs text-fg-2">
                      {[1, 2, 3].map((n) => (
                        <li key={n}>{brandText(`ai.mcp.oauth.${app}.${n}`)}</li>
                      ))}
                    </ol>
                  </div>
                ))}
              </div>
            ) : null}
            {code ? (
              <div className="relative">
                <pre
                  dir="ltr"
                  className="overflow-x-auto rounded-[10px] border border-line bg-surface-2 p-3 text-start text-[0.7812rem] leading-relaxed whitespace-pre text-heading"
                  data-testid="ai-mcp-snippet"
                >
                  {code}
                </pre>
                <Button
                  variant="secondary"
                  size="sm"
                  className="absolute end-2 top-2"
                  onClick={() => copyText(code)}
                  data-testid="ai-mcp-copy-snippet"
                >
                  {t('ai.copy')}
                </Button>
              </div>
            ) : null}
            {client === 'claude_ai' ? (
              <p className="text-xs text-muted" data-testid="ai-mcp-oauth-hint">
                {t('ai.mcp.oauth.consent')}
              </p>
            ) : (
              <p className="text-xs text-muted">
                {t('ai.mcp.tokenHint')}{' '}
                <Link
                  to="/a/$accountSlug/admin/$section"
                  params={{ accountSlug: account.slug, section: 'connections' }}
                  className="font-semibold text-primary underline"
                  data-testid="ai-mcp-tokens-link"
                >
                  {t('ai.mcp.tokenLink')}
                </Link>
              </p>
            )}
          </div>
          <div className="space-y-2 border-t border-line-soft px-3.5 py-3" data-testid="ai-mcp-tools">
            <div className="text-sm font-semibold text-fg">{t('ai.mcp.tools', { n: info.data.tools.length })}</div>
            <div className="flex flex-wrap gap-1.5">
              {info.data.tools.map((tool) => (
                <span key={tool.name} data-tip={aiToolLabel(tool.name, tool.title)}>
                  <Badge tone={tool.risk === 'read' ? 'neutral' : tool.risk === 'write' ? 'info' : 'warn'}>
                    <span dir="ltr">{tool.name}</span>
                  </Badge>
                </span>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </Panel>
  );
};

// ---- AI connections ----

/** The default-model picker: the connection's live list (a new connection: the catalogue until it is saved). */
/**
 * The default-model picker: "automatic" (no model set — the newest tool-calling model of the live list, named when
 * the list is loaded) and every model of the list.
 */
const modelOptions = (models: AiModelOption[], list?: AiModelList) => [
  {
    value: '',
    label: list?.default_auto ? defaultChoiceLabel(t('ai.models.auto'), list) : t('ai.models.auto'),
    testId: 'ai-connection-model-auto',
  },
  ...modelPickerOptions(models, 'ai-connection-model-option'),
];

/** A model id one may type in the picker's search: no spaces, a sane length. */
const typedModelId = (q: string) => (/^\S{1,200}$/.test(q) ? q : null);

/** How long the dialog waits after the last keystroke before it reads the model list with the typed key. */
const AUTO_LOAD_MS = 700;

/** The key field's placeholder per provider — what its keys look like (a hint only). */
const KEY_PLACEHOLDER: Record<AiProvider, string> = {
  anthropic: 'sk-ant-…',
  openai: 'sk-…',
  gemini: 'AIza…',
  openai_compatible: '—',
  soniox: '—',
};

/** Hand-added model ids, one per line or comma separated. */
const parseModelIds = (text: string) => [
  ...new Set(
    text
      .split(/[\n,]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];

/**
 * The connection dialog: the provider (Anthropic, OpenAI, Google Gemini, or any OpenAI-compatible server)
 * then what that provider needs — a key, and for a compatible server its base URL (a key only if it wants one) and
 * the models to add by hand when it has no model list. The provider is chosen once; everything else can change.
 */
const ConnectionDialog = ({
  accountId,
  open,
  onClose,
  initial,
  busy,
  onSubmit,
}: {
  accountId: string;
  open: boolean;
  onClose: () => void;
  initial: AiConnection | null;
  busy: boolean;
  onSubmit: (input: ConnectionInput) => void;
}) => {
  const [name, setName] = useState(initial?.name ?? '');
  const [provider, setProvider] = useState<AiProvider>(initial?.provider ?? 'anthropic');
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? '');
  const [manual, setManual] = useState('');
  const [model, setModel] = useState(initial?.default_model ?? '');
  // Model ids typed in the picker's search: saved as hand-added models of the connection.
  const [typed, setTyped] = useState<string[]>([]);
  const models = useAiModels(accountId, initial?.id);
  // A new connection: the provider's live list read with the typed key (nothing saved) — pick the default from it.
  const preview = usePreviewModels(accountId);
  const info = AI_PROVIDER_INFO[provider];
  const added = [...new Set([...parseModelIds(manual), ...typed])];
  const canPreview =
    (!info.keyRequired || key.trim().length >= 10) && (!info.baseUrl || /^https?:\/\/\S+$/.test(baseUrl.trim()));
  const loadModels = (quiet = false) =>
    preview.mutate(
      {
        provider,
        api_key: key.trim(),
        base_url: info.baseUrl ? baseUrl.trim() || null : null,
        manual_models: added.map((id) => ({ id })),
      },
      // Read on its own as one types: a failure is shown under the field, not as a toast at every keystroke.
      quiet ? {} : { onError: fail },
    );
  // the list is read by itself once the key (and server) look complete — no button to find first.
  const previewKey = `${provider}|${key.trim()}|${baseUrl.trim()}`;
  useEffect(() => {
    if (initial || !open || !canPreview) return;
    const timer = setTimeout(() => loadModels(true), AUTO_LOAD_MS);
    return () => clearTimeout(timer);
    // Only the inputs the list depends on start a new read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey, open]);
  const pickModel = (id: string) => {
    setModel(id);
    // A typed id the list does not have becomes a hand-added model, so the connection may use it.
    const listed = (initial ? models.data : preview.data)?.data.some((m) => m.id === id);
    if (id && !listed && !added.includes(id) && !(initial?.manual_models ?? []).some((m) => m.id === id))
      setTyped((x) => [...x, id]);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      name: name.trim(),
      provider,
      api_key: key.trim(),
      base_url: info.baseUrl ? baseUrl.trim() || null : null,
      default_model: model || null,
      ...(!initial && added.length ? { manual_models: added.map((id) => ({ id })) } : {}),
      ...(initial && typed.length
        ? { manual_models: [...(initial.manual_models ?? []), ...typed.map((id) => ({ id }))] }
        : {}),
    });
  };
  const valid =
    !!name.trim() &&
    (initial || !info.keyRequired || key.trim().length >= 10) &&
    (!info.baseUrl || /^https?:\/\/\S+$/.test(baseUrl.trim()));
  // Before the connection is saved: the live list once loaded with the typed key, else the models typed here.
  const choices = initial
    ? modelChoices(models.data, model || null)
    : preview.data
      ? modelChoices(preview.data, model || null)
      : modelChoices(
          {
            data: added.map((id) => ({
              id,
              display_name: id,
              created_at: null,
              price: null,
              price_source: null,
              default: false,
              capabilities: {
                tools: true,
                vision: false,
                json: true,
                streaming: true,
                max_context: null,
                image_generation: false,
              },
              manual: true,
            })),
            source: 'fallback',
            fetched_at: '',
            default_model: null,
            default_auto: true,
          },
          model || null,
        );
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={initial ? t('ai.connections.edit') : t('ai.connections.add')}
      subtitle={t('ai.connections.dialogHint')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            form="ai-connection-form"
            busy={busy}
            disabled={!valid}
            data-testid="ai-connection-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id="ai-connection-form" className="space-y-3" onSubmit={submit} data-testid="ai-connection-form">
        <Field label={t('ai.connections.name')}>
          <Input
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            data-testid="ai-connection-name"
            autoFocus
          />
        </Field>
        <Field
          label={t('ai.connections.provider')}
          hint={initial ? t('ai.provider.fixedHint') : t(`ai.provider.${provider}.hint`)}
        >
          {initial ? (
            <Input value={t(`ai.provider.${provider}`)} readOnly disabled data-testid="ai-connection-provider" />
          ) : (
            <Segmented
              value={provider}
              label={t('ai.connections.provider')}
              testId="ai-connection-provider"
              onChange={(v) => {
                setProvider(v);
                setModel('');
                preview.reset();
              }}
              options={AI_PROVIDERS.map((p) => ({
                value: p,
                label: t(`ai.provider.${p}`),
                testId: `ai-provider-${p}`,
              }))}
            />
          )}
        </Field>
        {info.baseUrl ? (
          <Field label={t('ai.connections.baseUrl')} hint={t('ai.connections.baseUrlHint')}>
            <Input
              dir="ltr"
              value={baseUrl}
              maxLength={500}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://…/v1"
              data-testid="ai-connection-base-url"
            />
            {initial ? null : (
              // known servers fill the address (and the name, when empty) — any other stays typed by hand.
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5" data-testid="ai-connection-presets">
                <span className="text-xs text-muted">{t('ai.connections.presets')}</span>
                {AI_COMPATIBLE_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    data-testid={`ai-connection-preset-${p.id}`}
                    aria-pressed={baseUrl.trim() === p.baseUrl}
                    onClick={() => {
                      setBaseUrl(p.baseUrl);
                      if (!name.trim()) setName(p.name);
                    }}
                    className="h-7 rounded-full border border-line-strong bg-surface px-2.5 text-xs hover:border-primary aria-pressed:border-primary aria-pressed:bg-[var(--accent-soft)]"
                  >
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </Field>
        ) : null}
        <Field
          label={info.keyRequired ? t('ai.connections.key') : t('ai.connections.keyOptional')}
          hint={
            initial
              ? t('ai.connections.keyReplaceHint', { hint: initial.key_hint })
              : t(`ai.provider.${provider}.keyHint`)
          }
        >
          <Input
            type="password"
            dir="ltr"
            autoComplete="off"
            value={key}
            maxLength={400}
            onChange={(e) => setKey(e.target.value)}
            placeholder={KEY_PLACEHOLDER[provider]}
            data-testid="ai-connection-key"
          />
        </Field>
        {!initial && provider !== 'anthropic' ? (
          <Field label={t('ai.connections.manualModels')} hint={t('ai.connections.manualModelsHint')}>
            <Input
              dir="ltr"
              value={manual}
              maxLength={2000}
              onChange={(e) => setManual(e.target.value)}
              placeholder="model-a, model-b"
              data-testid="ai-connection-manual-models"
            />
          </Field>
        ) : null}
        <Field
          label={t('ai.connections.model')}
          hint={
            initial
              ? t('ai.models.typeHint')
              : preview.data
                ? t('ai.models.loadedCount', { count: preview.data.data.length })
                : t('ai.models.loadHint')
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <Picker
              value={model}
              options={modelOptions(choices, initial ? models.data : preview.data)}
              onChange={pickModel}
              label={t('ai.connections.model')}
              testId="ai-connection-model"
              custom={{
                label: (q) => (typedModelId(q) ? t('ai.models.useTyped', { id: q }) : null),
                testId: 'ai-connection-model-typed',
              }}
            />
            {initial ? null : (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                busy={preview.isPending}
                disabled={!canPreview}
                onClick={() => loadModels()}
                data-testid="ai-connection-load-models"
              >
                {t('ai.models.load')}
              </Button>
            )}
          </div>
          {!initial && preview.isError ? (
            <p className="mt-1.5 text-xs text-danger-fg" data-testid="ai-connection-models-error">
              {errorMessage(preview.error)}
            </p>
          ) : null}
        </Field>
      </form>
    </Dialog>
  );
};

const ConnectionsPanel = ({ account }: { account: MyAccount }) => {
  const list = useAiConnections(account.id);
  const m = useConnectionMutations(account.id);
  const [dialog, setDialog] = useState<{ open: boolean; edit: AiConnection | null }>({ open: false, edit: null });
  const [modelsOf, setModelsOf] = useState<AiConnection | null>(null);
  const refreshModels = useRefreshModels(account.id);
  const close = () => setDialog({ open: false, edit: null });
  const submit = (input: ConnectionInput) => {
    if (dialog.edit) {
      m.update.mutate(
        {
          id: dialog.edit.id,
          name: input.name,
          default_model: input.default_model,
          ...(input.manual_models ? { manual_models: input.manual_models } : {}),
          ...(input.api_key ? { api_key: input.api_key } : {}),
          ...(input.base_url && input.base_url !== dialog.edit.base_url ? { base_url: input.base_url } : {}),
        },
        { onSuccess: () => (saved(), close()), onError: fail },
      );
    } else m.create.mutate(input, { onSuccess: () => (saved(), close()), onError: fail });
  };
  const test = (c: AiConnection) =>
    m.test.mutate(c.id, {
      onSuccess: (r) =>
        showToast({
          message: r.ok ? t('ai.connections.testOk') : t('ai.connections.testFail', { error: r.error ?? '' }),
          tone: r.ok ? undefined : 'error',
        }),
      onError: fail,
    });
  const remove = async (c: AiConnection) => {
    const ok = await confirmDialog({
      title: t('ai.connections.confirmDelete', { name: c.name }),
      message: t('ai.connections.confirmDeleteHint'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (ok) m.remove.mutate(c.id, { onSuccess: saved, onError: fail });
  };
  const rows = list.data?.data ?? [];
  return (
    <Panel
      title={t('ai.connections.title')}
      hint={t('ai.connections.hint')}
      testId="ai-connections"
      actions={
        <Button size="sm" onClick={() => setDialog({ open: true, edit: null })} data-testid="ai-connection-add">
          <Icon name="plus" size={14} />
          {t('ai.connections.add')}
        </Button>
      }
    >
      {list.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      {list.data && !rows.length ? (
        <EmptyState title={t('ai.connections.empty')} testId="ai-connections-empty" />
      ) : null}
      {rows.map((c) => (
        <Row
          key={c.id}
          testId="ai-connection-row"
          label={c.name}
          hint={
            <span className="flex flex-wrap items-center gap-1.5">
              <span data-testid="ai-connection-provider-label" data-provider={c.provider}>
                {t(`ai.provider.${c.provider}`)} ·
              </span>
              {c.base_url ? <span dir="ltr">{c.base_url} ·</span> : null}
              <span dir="ltr">{c.key_hint}</span>
              <span dir="ltr" data-testid="ai-connection-default-model">
                · {c.default_model ?? t('ai.models.auto')}
              </span>
              {c.last_test ? (
                <Badge tone={c.last_test.ok ? 'ok' : 'danger'}>
                  {c.last_test.ok ? t('ai.connections.works') : t('ai.connections.broken')}
                </Badge>
              ) : null}
            </span>
          }
        >
          <Button
            variant="secondary"
            size="sm"
            busy={m.test.isPending && m.test.variables === c.id}
            onClick={() => test(c)}
            data-testid="ai-connection-test"
          >
            {t('ai.connections.test')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setModelsOf(c)} data-testid="ai-connection-models">
            {t('ai.models.button')}
          </Button>
          {/* Asks the provider again now: new models reach every picker without waiting for the hour's cache. */}
          <Button
            variant="ghost"
            size="sm"
            busy={refreshModels.isPending && refreshModels.variables === c.id}
            onClick={() =>
              refreshModels.mutate(c.id, {
                onSuccess: (r) =>
                  showToast({
                    message:
                      r.source === 'live'
                        ? t('ai.models.refreshed', { count: r.data.length })
                        : t('ai.models.fallback'),
                    tone: r.source === 'live' ? undefined : 'error',
                  }),
                onError: fail,
              })
            }
            data-testid="ai-connection-refresh-models"
          >
            {t('ai.models.refreshModels')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDialog({ open: true, edit: c })}
            data-testid="ai-connection-edit"
          >
            {t('ai.edit')}
          </Button>
          <Button variant="danger-outline" size="sm" onClick={() => void remove(c)} data-testid="ai-connection-delete">
            {t('common.delete')}
          </Button>
        </Row>
      ))}
      {modelsOf ? (
        <ModelsDialog accountId={account.id} connection={modelsOf} onClose={() => setModelsOf(null)} />
      ) : null}
      {dialog.open ? (
        <ConnectionDialog
          key={dialog.edit?.id ?? 'new'}
          accountId={account.id}
          open
          onClose={close}
          initial={dialog.edit}
          busy={m.create.isPending || m.update.isPending}
          onSubmit={submit}
        />
      ) : null}
    </Panel>
  );
};

// ---- the models of a connection (Fix: ) ----

/** "128K" — a context window in tokens, short. */
const tokensShort = (n: number) =>
  n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

/**
 * What a model can do, as badges: each capability it has, and the ones it lacks marked as limited (a
 * model without tools cannot run agents, assistant writes or the flows builder).
 */
export const CapabilityBadges = ({ caps }: { caps: AiCapabilities }) => (
  <span className="flex flex-wrap items-center gap-1" data-testid="ai-model-caps">
    {AI_CAPABILITY_FLAGS.map((f) => (
      <span
        key={f}
        data-testid={`ai-model-cap-${f}`}
        data-on={caps[f] ? 'true' : 'false'}
        title={caps[f] ? t(`ai.caps.${f}.hint`) : t(`ai.caps.${f}.missing`)}
        data-tip={caps[f] ? t(`ai.caps.${f}.hint`) : t(`ai.caps.${f}.missing`)}
      >
        <Badge tone={caps[f] ? 'neutral' : 'warn'}>
          {caps[f] ? t(`ai.caps.${f}`) : t('ai.caps.without', { cap: t(`ai.caps.${f}`) })}
        </Badge>
      </span>
    ))}
    {/* AI images: a model that makes images (not a "limited" badge when absent). */}
    {caps.image_generation ? (
      <span
        data-testid="ai-model-cap-images"
        title={t('ai.caps.image_generation.hint')}
        data-tip={t('ai.caps.image_generation.hint')}
      >
        <Badge tone="info">{t('ai.caps.image_generation')}</Badge>
      </span>
    ) : null}
    {caps.max_context ? (
      <span title={t('ai.caps.context.hint')} data-tip={t('ai.caps.context.hint')}>
        <Badge tone="neutral">
          <bdi dir="ltr">{tokensShort(caps.max_context)}</bdi>
        </Badge>
      </span>
    ) : null}
  </span>
);

/** The connection's hand-added models / corrections with one model's entry replaced (or removed: null). */
const withEntry = (list: AiManualModel[], id: string, entry: AiManualModel | null): AiManualModel[] => [
  ...list.filter((m) => m.id !== id),
  ...(entry ? [entry] : []),
];

/**
 * The connection's models as the provider lists them now (cached an hour; "רענון" asks again), newest first, each
 * with its price — or "מחיר לא ידוע" and a price an admin sets here (USD per 1M tokens in / out).
 */
const ModelsDialog = ({
  accountId,
  connection,
  onClose,
}: {
  accountId: string;
  connection: AiConnection;
  onClose: () => void;
}) => {
  const models = useAiModels(accountId, connection.id);
  const refreshModels = useRefreshModels(accountId);
  const m = useConnectionMutations(accountId);
  const [editing, setEditing] = useState<{ id: string; input: string; output: string } | null>(null);
  const [capsOf, setCapsOf] = useState<string | null>(null);
  const [newModel, setNewModel] = useState('');
  // The connection as saved now (its hand-added models change here).
  const connections = useAiConnections(accountId);
  const manual = (connections.data?.data.find((c) => c.id === connection.id) ?? connection).manual_models ?? [];
  const saveManual = (next: AiManualModel[], then?: () => void) =>
    m.update.mutate(
      { id: connection.id, manual_models: next },
      { onSuccess: () => (then?.(), saved()), onError: fail },
    );
  /** One capability switched on the model: kept as the admin's correction on the connection. */
  const setCap = (x: AiModelOption, flag: keyof AiCapabilities, on: boolean) => {
    const own = manual.find((e) => e.id === x.id);
    saveManual(
      withEntry(manual, x.id, {
        ...(own ?? { id: x.id }),
        capabilities: { ...own?.capabilities, [flag]: on },
      }),
    );
  };
  const addModel = () => {
    const id = newModel.trim();
    if (!id) return;
    if (list?.data.some((x) => x.id === id)) return fail(new Error(t('ai.models.exists')));
    saveManual([...manual, { id }], () => setNewModel(''));
  };
  const refresh = () => refreshModels.mutate(connection.id, { onError: fail });
  /** The connection's default model, chosen from the live list. */
  const makeDefault = (id: string) =>
    m.update.mutate({ id: connection.id, default_model: id }, { onSuccess: saved, onError: fail });
  const setPrice = (id: string, price: { input: number; output: number } | null) =>
    m.update.mutate(
      { id: connection.id, price_overrides: { [id]: price } },
      { onSuccess: () => (setEditing(null), saved()), onError: fail },
    );
  const savePrice = () => {
    if (!editing) return;
    const input = Number(editing.input);
    const output = Number(editing.output);
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0 || !editing.input.trim())
      return fail(new Error(t('ai.models.priceInvalid')));
    setPrice(editing.id, { input, output });
  };
  const list = models.data;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('ai.models.title', { name: connection.name })}
      subtitle={t('ai.models.hint')}
      className="max-w-2xl!"
      footer={
        <Button variant="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="flex flex-col gap-2" data-testid="ai-models-dialog">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          {list ? (
            <span data-testid="ai-models-source" data-source={list.source}>
              <Badge tone={list.source === 'live' ? 'ok' : 'warn'}>
                {list.source === 'live' ? t('ai.models.live') : t('ai.models.fallback')}
              </Badge>
            </span>
          ) : null}
          {list ? (
            <span>{t('ai.models.fetchedAt', { at: new Date(list.fetched_at).toLocaleTimeString() })}</span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="ms-auto"
            busy={refreshModels.isPending}
            onClick={refresh}
            data-testid="ai-models-refresh"
          >
            {t('ai.models.refresh')}
          </Button>
        </div>
        {models.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
        {models.isError ? <Notice tone="error">{errorMessage(models.error)}</Notice> : null}
        <ul className="flex flex-col divide-y divide-line">
          {(list?.data ?? []).map((x) => (
            <li
              key={x.id}
              className="flex flex-wrap items-center gap-2 py-2"
              data-testid="ai-model-row"
              data-model={x.id}
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium text-heading">
                  {x.display_name}
                  {x.default ? (
                    <span
                      className="ms-2"
                      data-testid="ai-model-default"
                      data-auto={list?.default_auto ? 'true' : 'false'}
                    >
                      <Badge tone="ok">
                        {list?.default_auto
                          ? `${t('ai.models.default')} · ${t('ai.models.autoBadge')}`
                          : t('ai.models.default')}
                      </Badge>
                    </span>
                  ) : null}
                  {x.manual ? (
                    <span className="ms-2" data-testid="ai-model-manual">
                      <Badge tone="info">{t('ai.models.manual')}</Badge>
                    </span>
                  ) : null}
                </div>
                <div className="text-xs text-muted" dir="ltr">
                  {x.id}
                  {x.created_at ? ` · ${x.created_at.slice(0, 10)}` : ''}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                  <CapabilityBadges caps={x.capabilities} />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setCapsOf(capsOf === x.id ? null : x.id)}
                    data-testid="ai-model-caps-edit"
                  >
                    {t('ai.caps.edit')}
                  </Button>
                  {!x.default || list?.default_auto ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={m.update.isPending}
                      onClick={() => makeDefault(x.id)}
                      data-testid="ai-model-make-default"
                    >
                      {t('ai.models.makeDefault')}
                    </Button>
                  ) : null}
                  {x.manual ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => saveManual(withEntry(manual, x.id, null))}
                      data-testid="ai-model-remove"
                    >
                      {t('ai.models.remove')}
                    </Button>
                  ) : null}
                </div>
                {capsOf === x.id ? (
                  <div className="mt-2 flex flex-wrap gap-4" data-testid="ai-model-caps-editor">
                    {[...AI_CAPABILITY_FLAGS, 'image_generation' as const].map((f) => (
                      <label key={f} className="flex items-center gap-2 text-sm">
                        <Switch
                          checked={x.capabilities[f]}
                          disabled={m.update.isPending}
                          onChange={(on) => setCap(x, f, on)}
                          label={t(`ai.caps.${f}`)}
                          testId={`ai-model-cap-switch-${f}`}
                        />
                        {t(`ai.caps.${f}`)}
                      </label>
                    ))}
                  </div>
                ) : null}
              </div>
              {editing?.id === x.id ? (
                <span className="flex items-center gap-1 text-sm text-muted">
                  <Input
                    dir="ltr"
                    inputMode="decimal"
                    className="w-20"
                    value={editing.input}
                    placeholder={t('ai.models.input')}
                    aria-label={t('ai.models.input')}
                    onChange={(e) => setEditing({ ...editing, input: e.target.value })}
                    data-testid="ai-model-price-input"
                  />
                  /
                  <Input
                    dir="ltr"
                    inputMode="decimal"
                    className="w-20"
                    value={editing.output}
                    placeholder={t('ai.models.output')}
                    aria-label={t('ai.models.output')}
                    onChange={(e) => setEditing({ ...editing, output: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && savePrice()}
                    data-testid="ai-model-price-output"
                  />
                  USD
                  <Button size="sm" busy={m.update.isPending} onClick={savePrice} data-testid="ai-model-price-save">
                    {t('common.save')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                    {t('common.cancel')}
                  </Button>
                </span>
              ) : (
                <>
                  <span
                    className={x.price ? 'text-sm text-fg-2' : 'text-sm text-accent-fg'}
                    data-testid="ai-model-price"
                    data-known={x.price ? 'true' : 'false'}
                    title={t('ai.models.perMillion')}
                  >
                    {/* "$4/$20" alone in a Hebrew line would read "$20/$4" (bidi): input/output in LTR order. */}
                    {x.price ? <bdi dir="ltr">{modelPrice(x)}</bdi> : modelPrice(x)}
                    {x.price_source === 'override'
                      ? ` (${t('ai.models.overridden')})`
                      : x.price_source === 'provider'
                        ? ` (${t('ai.models.providerPrice')})`
                        : ''}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEditing({
                        id: x.id,
                        input: x.price ? String(x.price.input) : '',
                        output: x.price ? String(x.price.output) : '',
                      })
                    }
                    data-testid="ai-model-price-edit"
                  >
                    {t('ai.models.setPrice')}
                  </Button>
                  {x.price_source === 'override' ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setPrice(x.id, null)}
                      data-testid="ai-model-price-reset"
                    >
                      {t('ai.models.resetPrice')}
                    </Button>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3" data-testid="ai-model-add">
          <Input
            dir="ltr"
            className="max-w-xs"
            value={newModel}
            maxLength={80}
            placeholder={t('ai.models.addPlaceholder')}
            aria-label={t('ai.models.add')}
            onChange={(e) => setNewModel(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addModel()}
            data-testid="ai-model-add-id"
          />
          <Button
            size="sm"
            variant="secondary"
            busy={m.update.isPending}
            onClick={addModel}
            data-testid="ai-model-add-save"
          >
            {t('ai.models.add')}
          </Button>
          <span className="text-xs text-muted">{t('ai.models.addHint')}</span>
        </div>
      </div>
    </Dialog>
  );
};

// ---- AI on / off, budget, agents ----

/** A whole number from 1 to `max`, saved on blur / Enter (an invalid entry goes back to the saved value). */
const WholeNumberInput = ({
  value,
  max,
  label,
  testId,
  onSave,
}: {
  value: number;
  max: number;
  label: string;
  testId: string;
  onSave: (v: number) => void;
}) => {
  const [text, setText] = useState(String(value));
  const save = () => {
    const v = Number(text.trim());
    if (!Number.isInteger(v) || v < 1 || v > max) {
      setText(String(value));
      return fail(new Error(t('ai.settings.rateInvalid', { max })));
    }
    if (v !== value) onSave(v);
  };
  return (
    <Input
      dir="ltr"
      inputMode="numeric"
      className="w-28"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && save()}
      aria-label={label}
      data-testid={testId}
    />
  );
};

const AiSettingsPanel = ({
  settings,
  busy,
  onSave,
}: {
  settings: AiSettings;
  busy: boolean;
  onSave: (patch: Partial<AiSettings>) => void;
}) => {
  const [budget, setBudget] = useState(settings.monthly_budget_usd?.toString() ?? '');
  const saveBudget = () => {
    const v = budget.trim() ? Number(budget) : null;
    if (v !== null && (!Number.isFinite(v) || v < 0)) return fail(new Error(t('ai.settings.budgetInvalid')));
    if (v !== settings.monthly_budget_usd) onSave({ monthly_budget_usd: v });
  };
  return (
    <Panel title={t('ai.settings.title')} hint={t('ai.settings.hint')} testId="ai-settings">
      <Row label={t('ai.settings.enabled')} hint={t('ai.settings.enabledHint')}>
        <Switch
          checked={settings.enabled}
          disabled={busy}
          onChange={(on) => onSave({ enabled: on })}
          label={t('ai.settings.enabled')}
          testId="ai-enabled"
        />
      </Row>
      <Row label={t('ai.settings.markdown')} hint={t('ai.settings.markdownHint')}>
        <Switch
          checked={settings.format_markdown}
          disabled={busy}
          onChange={(on) => onSave({ format_markdown: on })}
          label={t('ai.settings.markdown')}
          testId="ai-format-markdown"
        />
      </Row>
      <Row label={t('ai.settings.budget')} hint={t('ai.settings.budgetHint', { pct: settings.budget_alert_pct })}>
        <Input
          dir="ltr"
          inputMode="decimal"
          className="w-28"
          value={budget}
          placeholder="—"
          onChange={(e) => setBudget(e.target.value)}
          onBlur={saveBudget}
          onKeyDown={(e) => e.key === 'Enter' && saveBudget()}
          aria-label={t('ai.settings.budget')}
          data-testid="ai-budget"
        />
        <span className="text-sm text-muted">USD</span>
      </Row>
      <Row label={t('ai.settings.writeRate')} hint={t('ai.settings.writeRateHint')}>
        <WholeNumberInput
          value={settings.write_rate_per_minute}
          max={10_000}
          label={t('ai.settings.writeRate')}
          testId="ai-write-rate"
          onSave={(v) => onSave({ write_rate_per_minute: v })}
        />
      </Row>
      <Row label={t('ai.settings.accountWriteRate')} hint={t('ai.settings.accountWriteRateHint')}>
        <WholeNumberInput
          value={settings.account_write_rate_per_minute}
          max={100_000}
          label={t('ai.settings.accountWriteRate')}
          testId="ai-account-write-rate"
          onSave={(v) => onSave({ account_write_rate_per_minute: v })}
        />
      </Row>
      <Row label={t('ai.settings.agents')} hint={t('ai.settings.agentsHint')}>
        <Segmented
          value={settings.agent_creators}
          label={t('ai.settings.agents')}
          testId="ai-agent-creators"
          onChange={(v) => onSave({ agent_creators: v })}
          options={[
            { value: 'admins', label: t('ai.settings.agents.admins') },
            { value: 'members', label: t('ai.settings.agents.members') },
          ]}
        />
      </Row>
      <Row label={t('ai.settings.agentMention')} hint={t('ai.settings.agentMentionHint')}>
        <Switch
          checked={settings.agent_mention_default}
          disabled={busy}
          onChange={(on) => onSave({ agent_mention_default: on })}
          label={t('ai.settings.agentMention')}
          testId="ai-agent-mention-default"
        />
      </Row>
    </Panel>
  );
};

// ---- usage ----

const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;

const UsagePanel = ({ account }: { account: MyAccount }) => {
  const usage = useAiUsage(account.id);
  const data = usage.data;
  return (
    <Panel
      title={t('ai.usage.title')}
      hint={data ? t('ai.usage.hint', { month: data.month }) : undefined}
      testId="ai-usage"
      actions={
        data ? (
          <span className="font-display text-xl font-extrabold text-heading tabular-nums" data-testid="ai-usage-total">
            <bdi>{usd(data.total_usd)}</bdi>
            {data.budget_usd !== null ? (
              <span className="text-sm font-semibold text-muted">
                {' '}
                / <bdi>{usd(data.budget_usd)}</bdi>
              </span>
            ) : null}
          </span>
        ) : null
      }
    >
      {usage.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {usage.isError ? <Notice tone="error">{errorMessage(usage.error)}</Notice> : null}
      {data && !data.rows.length ? <EmptyState title={t('ai.usage.empty')} testId="ai-usage-empty" /> : null}
      {data?.unpriced_models.length ? (
        <div className="px-3.5 py-2" data-testid="ai-unpriced">
          <Notice tone="warn">
            <div className="space-y-1">
              <div className="font-semibold">{t('ai.usage.unpriced', { n: data.unpriced_models.length })}</div>
              <div className="text-xs">{t('ai.usage.unpricedHint')}</div>
              <ul className="flex flex-wrap gap-1.5">
                {data.unpriced_models.map((u) => (
                  <li key={`${u.connection_id}-${u.model}`} data-testid="ai-unpriced-model" data-model={u.model}>
                    <Badge tone="warn">
                      <bdi dir="ltr">{u.model}</bdi>
                      {u.connection_name ? ` · ${u.connection_name}` : ''}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          </Notice>
        </div>
      ) : null}
      {data?.rows.map((r) => (
        <Row
          key={`${r.connection_id}-${r.source}-${r.model}`}
          testId="ai-usage-row"
          label={`${r.connection_name ?? '—'} · ${tDynamic(`ai.usage.source.${r.source}`)}`}
          hint={
            <span className="flex flex-wrap items-center gap-1.5">
              <span dir="ltr">
                {r.model} · {r.calls} · {r.input_tokens.toLocaleString()} / {r.output_tokens.toLocaleString()}
              </span>
              {r.price_known ? null : (
                <span data-testid="ai-usage-unknown-price">
                  <Badge tone="warn">{t('ai.models.unknownPrice')}</Badge>
                </span>
              )}
            </span>
          }
        >
          <span className="font-semibold text-heading tabular-nums">
            <bdi>{usd(r.cost_usd)}</bdi>
          </span>
        </Row>
      ))}
    </Panel>
  );
};
