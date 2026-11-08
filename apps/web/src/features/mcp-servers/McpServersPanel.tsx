// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { t, type McpServer, type McpServerAuth, type MyAccount } from '@bines/shared';
import { Badge, Button, Dialog, EmptyState, Field, Input, Notice, Segmented, SkeletonRows, Switch } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDelete } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { Panel } from '../admin/admin-parts';
import { testMcpTool, useMcpServerMutations, useMcpServers } from './mcp-servers-api';

type AuthKind = McpServerAuth['kind'];

/**
 * Administration → AI ו-MCP → "שרתי MCP חיצוניים" (the planning notes "AGENTS-MCP" מ10): register a server (address +
 * a token or an OAuth client — public addresses only, secrets write-only), list its tools, enable each one and choose
 * whether an agent's call waits for approval (it does by default), try a tool by hand. Admins only.
 */
export const McpServersPanel = ({ account }: { account: MyAccount }) => {
  const list = useMcpServers(account.id);
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null);
  const [trying, setTrying] = useState<{ server: McpServer; tool: string } | null>(null);
  const servers = list.data?.data ?? [];
  return (
    <Panel
      title={t('mcpsrv.title')}
      hint={t('mcpsrv.hint')}
      testId="mcp-servers"
      actions={
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')} data-testid="mcp-server-add">
          {t('mcpsrv.add')}
        </Button>
      }
    >
      {list.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {list.isError ? (
        <div className="p-3.5">
          <Notice tone="error">{errorMessage(list.error)}</Notice>
        </div>
      ) : null}
      {!list.isPending && !servers.length ? (
        <EmptyState icon={<Icon name="link" size={26} />} title={t('mcpsrv.none')}>
          {t('mcpsrv.noneHint')}
        </EmptyState>
      ) : null}
      <ul>
        {servers.map((s) => (
          <ServerRow
            key={s.id}
            account={account}
            server={s}
            onEdit={() => setEditing(s)}
            onTry={(tool) => setTrying({ server: s, tool })}
          />
        ))}
      </ul>
      {editing ? (
        <ServerDialog account={account} server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />
      ) : null}
      {trying ? (
        <TryToolDialog account={account} server={trying.server} tool={trying.tool} onClose={() => setTrying(null)} />
      ) : null}
    </Panel>
  );
};

const ServerRow = ({
  account,
  server: s,
  onEdit,
  onTry,
}: {
  account: MyAccount;
  server: McpServer;
  onEdit: () => void;
  onTry: (tool: string) => void;
}) => {
  const m = useMcpServerMutations(account.id);
  const busy = m.tools.isPending || m.update.isPending || m.refresh.isPending;
  const setTool = (name: string, patch: Partial<{ enabled: boolean; approval: boolean }>) => {
    const cur = s.tools.find((x) => x.name === name)!;
    m.tools.mutate(
      { id: s.id, tools: { [name]: { enabled: cur.enabled, approval: cur.approval, ...patch } } },
      { onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }) },
    );
  };
  return (
    <li className="space-y-2 border-b border-line-soft px-3.5 py-3 last:border-b-0" data-testid={`mcp-server-${s.key}`}>
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="min-w-0 flex-1 basis-60">
          <span className="font-semibold text-fg">{s.name}</span>{' '}
          <span className="text-xs text-muted" dir="ltr">
            {s.key} · {s.url}
          </span>
        </span>
        <Badge tone={s.status === 'ok' ? 'ok' : s.status === 'error' ? 'danger' : 'neutral'}>
          {t(`mcpsrv.status.${s.status}`)}
        </Badge>
        <Badge>{t(`mcpsrv.auth.${s.auth_kind}`)}</Badge>
        <Switch
          checked={s.enabled}
          label={t('mcpsrv.enabled')}
          disabled={busy}
          onChange={(on) => m.update.mutate({ id: s.id, enabled: on })}
          testId={`mcp-server-enabled-${s.key}`}
        />
      </div>
      {s.last_error ? <Notice tone="error">{t('mcpsrv.error', { error: s.last_error })}</Notice> : null}
      {s.tools.length ? (
        <ul className="rounded-[10px] border border-line-soft" data-testid={`mcp-tools-${s.key}`}>
          {s.tools.map((tool) => (
            <li
              key={tool.name}
              className="flex flex-wrap items-center gap-2.5 border-b border-line-soft px-3 py-2 last:border-b-0"
              data-testid={`mcp-tool-${s.key}-${tool.name}`}
            >
              <Switch
                checked={tool.enabled}
                label={t('mcpsrv.tool.enable', { tool: tool.name })}
                disabled={busy}
                onChange={(on) => setTool(tool.name, { enabled: on })}
                testId={`mcp-tool-enable-${s.key}-${tool.name}`}
              />
              <span className="min-w-0 flex-1 basis-48">
                <span dir="ltr" className="font-mono text-xs text-fg">
                  {tool.name}
                </span>
                {tool.description ? (
                  <span className="block truncate text-xs text-muted" title={tool.description}>
                    {tool.description}
                  </span>
                ) : null}
              </span>
              {tool.enabled ? (
                <>
                  <label className="flex items-center gap-1.5 text-xs text-muted">
                    <Switch
                      checked={tool.approval}
                      label={t('mcpsrv.tool.approval')}
                      disabled={busy}
                      onChange={(on) => setTool(tool.name, { approval: on })}
                      testId={`mcp-tool-approval-${s.key}-${tool.name}`}
                    />
                    {t('mcpsrv.tool.approval')}
                  </label>
                  <Button size="sm" variant="ghost" onClick={() => onTry(tool.name)}>
                    {t('mcpsrv.tool.try')}
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">
          {t('mcpsrv.limits', { seconds: Math.round(s.timeout_ms / 1000), calls: s.max_calls_per_hour })}
        </span>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => m.refresh.mutate(s.id)}>
          {t('mcpsrv.refresh')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit} data-testid={`mcp-server-edit-${s.key}`}>
          {t('mcpsrv.edit')}
        </Button>
        <Button
          size="sm"
          variant="danger-outline"
          onClick={async () => {
            if (!(await confirmDelete(s.name))) return;
            await m.remove.mutateAsync(s.id);
          }}
          data-testid={`mcp-server-delete-${s.key}`}
        >
          {t('common.delete')}
        </Button>
      </div>
    </li>
  );
};

const ServerDialog = ({
  account,
  server,
  onClose,
}: {
  account: MyAccount;
  server: McpServer | null;
  onClose: () => void;
}) => {
  const m = useMcpServerMutations(account.id);
  const [key, setKey] = useState(server?.key ?? '');
  const [name, setName] = useState(server?.name ?? '');
  const [url, setUrl] = useState(server?.url ?? '');
  const [kind, setKind] = useState<AuthKind>(server?.auth_kind ?? 'bearer');
  const [changeAuth, setChangeAuth] = useState(!server);
  const [token, setToken] = useState('');
  const [tokenUrl, setTokenUrl] = useState(server?.oauth?.token_url ?? '');
  const [clientId, setClientId] = useState(server?.oauth?.client_id ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [scope, setScope] = useState(server?.oauth?.scope ?? '');
  const [timeout, setTimeoutS] = useState(String(Math.round((server?.timeout_ms ?? 30_000) / 1000)));
  const [calls, setCalls] = useState(String(server?.max_calls_per_hour ?? 120));
  const [error, setError] = useState<string | null>(null);
  const busy = m.create.isPending || m.update.isPending;

  const auth = (): McpServerAuth | null => {
    if (kind === 'none') return { kind: 'none' };
    if (kind === 'bearer') return token.trim() ? { kind: 'bearer', token: token.trim() } : null;
    if (!tokenUrl.trim() || !clientId.trim() || !clientSecret.trim()) return null;
    return {
      kind: 'oauth_client',
      token_url: tokenUrl.trim(),
      client_id: clientId.trim(),
      client_secret: clientSecret.trim(),
      ...(scope.trim() ? { scope: scope.trim() } : {}),
    };
  };
  const limits = {
    timeout_ms: Math.min(30, Math.max(1, Number(timeout) || 30)) * 1000,
    max_calls_per_hour: Math.min(10_000, Math.max(1, Number(calls) || 120)),
  };
  const validKey = /^[a-z][a-z0-9]{1,15}$/.test(key);
  const a = changeAuth ? auth() : undefined;
  const valid = !!name.trim() && !!url.trim() && (server ? true : validKey) && a !== null;

  const save = async () => {
    setError(null);
    try {
      if (server)
        await m.update.mutateAsync({
          id: server.id,
          name: name.trim(),
          url: url.trim(),
          ...limits,
          ...(changeAuth && a ? { auth: a } : {}),
        });
      else await m.create.mutateAsync({ key, name: name.trim(), url: url.trim(), auth: a!, ...limits });
      showToast({ message: t('mcpsrv.saved', { name: name.trim() }) });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={server ? t('mcpsrv.editTitle', { name: server.name }) : t('mcpsrv.addTitle')}
      subtitle={t('mcpsrv.dialogHint')}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} disabled={!valid} onClick={() => void save()} data-testid="mcp-server-save">
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3" data-testid="mcp-server-dialog">
        <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
          <Field label={t('mcpsrv.field.name')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="mcp-server-name" />
          </Field>
          <Field label={t('mcpsrv.field.key')} hint={t('mcpsrv.field.keyHint')}>
            <Input
              dir="ltr"
              value={key}
              disabled={!!server}
              onChange={(e) => setKey(e.target.value.toLowerCase())}
              data-testid="mcp-server-key"
            />
          </Field>
        </div>
        <Field label={t('mcpsrv.field.url')} hint={t('mcpsrv.field.urlHint')}>
          <Input
            dir="ltr"
            value={url}
            placeholder="https://…/mcp"
            onChange={(e) => setUrl(e.target.value)}
            data-testid="mcp-server-url"
          />
        </Field>
        {server && !changeAuth ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-muted">
              {t(`mcpsrv.auth.${server.auth_kind}`)}
              {server.auth_hint ? ` · ${server.auth_hint}` : ''}
            </span>
            <Button size="sm" variant="ghost" onClick={() => setChangeAuth(true)}>
              {t('mcpsrv.changeAuth')}
            </Button>
          </div>
        ) : (
          <>
            <Segmented<AuthKind>
              label={t('mcpsrv.field.auth')}
              value={kind}
              onChange={setKind}
              options={[
                { value: 'bearer', label: t('mcpsrv.auth.bearer'), testId: 'mcp-auth-bearer' },
                { value: 'oauth_client', label: t('mcpsrv.auth.oauth_client'), testId: 'mcp-auth-oauth' },
                { value: 'none', label: t('mcpsrv.auth.none'), testId: 'mcp-auth-none' },
              ]}
            />
            {kind === 'bearer' ? (
              <Field label={t('mcpsrv.field.token')} hint={t('mcpsrv.field.secretHint')}>
                <Input
                  dir="ltr"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  data-testid="mcp-server-token"
                />
              </Field>
            ) : null}
            {kind === 'oauth_client' ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t('mcpsrv.field.tokenUrl')}>
                  <Input dir="ltr" value={tokenUrl} onChange={(e) => setTokenUrl(e.target.value)} />
                </Field>
                <Field label={t('mcpsrv.field.clientId')}>
                  <Input dir="ltr" value={clientId} onChange={(e) => setClientId(e.target.value)} />
                </Field>
                <Field label={t('mcpsrv.field.clientSecret')} hint={t('mcpsrv.field.secretHint')}>
                  <Input
                    dir="ltr"
                    type="password"
                    autoComplete="off"
                    value={clientSecret}
                    onChange={(e) => setClientSecret(e.target.value)}
                  />
                </Field>
                <Field label={t('mcpsrv.field.scope')}>
                  <Input dir="ltr" value={scope} onChange={(e) => setScope(e.target.value)} />
                </Field>
              </div>
            ) : null}
          </>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('mcpsrv.field.timeout')}>
            <Input dir="ltr" inputMode="numeric" value={timeout} onChange={(e) => setTimeoutS(e.target.value)} />
          </Field>
          <Field label={t('mcpsrv.field.calls')}>
            <Input dir="ltr" inputMode="numeric" value={calls} onChange={(e) => setCalls(e.target.value)} />
          </Field>
        </div>
        {server && changeAuth ? <Notice tone="warn">{t('mcpsrv.resetWarning')}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Dialog>
  );
};

const TryToolDialog = ({
  account,
  server,
  tool,
  onClose,
}: {
  account: MyAccount;
  server: McpServer;
  tool: string;
  onClose: () => void;
}) => {
  const [input, setInput] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ text: string; is_error: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    setOut(null);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(input || '{}') as Record<string, unknown>;
    } catch {
      setError(t('mcpsrv.try.notJson'));
      return;
    }
    setBusy(true);
    try {
      setOut(await testMcpTool(account.id, server.id, tool, parsed));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('mcpsrv.try.title', { tool })}
      subtitle={server.name}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button busy={busy} onClick={() => void run()} data-testid="mcp-try-run">
            {t('mcpsrv.try.run')}
          </Button>
        </div>
      }
    >
      <div className="space-y-3" data-testid="mcp-try">
        <Field label={t('mcpsrv.try.input')}>
          <textarea
            dir="ltr"
            rows={5}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-full rounded-[10px] border border-line-strong bg-surface p-2.5 font-mono text-xs text-fg focus:border-primary focus:outline-none"
          />
        </Field>
        {error ? <Notice tone="error">{error}</Notice> : null}
        {out ? (
          <div className="space-y-1.5">
            <Notice tone="warn">{t('mcpsrv.try.untrusted')}</Notice>
            {/* The remote answer is text — never HTML. */}
            <pre
              dir="ltr"
              className="max-h-64 overflow-auto rounded-[10px] bg-surface-2 p-2.5 text-xs whitespace-pre-wrap text-fg"
              data-testid="mcp-try-output"
            >
              {out.text}
            </pre>
          </div>
        ) : null}
      </div>
    </Dialog>
  );
};
