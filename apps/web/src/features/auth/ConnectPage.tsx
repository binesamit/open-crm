// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '@bines/sdk';
import { type McpScopeGroup, type OauthRequest, t, tDynamic } from '@bines/shared';
import { Badge, Button, Input, Notice, RadioCard, SkeletonRows } from '@bines/ui';
import { api, errorMessage, type Me } from '../../lib/api';
import { CheckRow } from '../board/toolbar/parts';
import { useAllBoards } from '../automations/automations-api';
import { AuthShell } from './AuthShell';

/**
 * The OAuth consent screen (the planning notes "AGENTS-MCP" §4, מ5; F4 auth layout, RTL): an AI app (Claude.ai, ChatGPT…)
 * asks to act as me over MCP. I pick ONE account (D12 — a connection is bound to one account), what it may do
 * (read always; edit; automations) and optionally which boards. The decision goes to the API, which answers with
 * the app's redirect URI (code + state + iss, or access_denied); the browser follows it. Reached from
 * `/oauth/authorize` as `/connect?request=<id>`, or `/connect?error=<code>` when the app itself is not valid.
 */
const ERRORS = new Set(['invalid_client', 'invalid_redirect_uri']);

export const ConnectError = ({ code }: { code: string }) => (
  <AuthShell title={t('connect.errorTitle')}>
    <Notice tone="error">
      <span data-testid="connect-error">
        {tDynamic(ERRORS.has(code) ? `connect.error.${code}` : 'connect.error.generic')}
      </span>
    </Notice>
  </AuthShell>
);

export const ConnectPage = ({ requestId, me }: { requestId: string; me: Me }) => {
  const request = useQuery({
    queryKey: ['oauth-request', requestId],
    queryFn: () => api().get<OauthRequest>(`/oauth-requests/${requestId}`),
    retry: false,
    staleTime: Infinity,
  });
  if (request.isPending)
    return (
      <AuthShell title={t('connect.loading')}>
        <SkeletonRows rows={4} label={t('app.loading')} />
      </AuthShell>
    );
  if (request.isError) {
    const gone = request.error instanceof ApiError && request.error.status === 404;
    return (
      <AuthShell title={t('connect.errorTitle')}>
        <Notice tone="error">
          <span data-testid="connect-expired">{gone ? t('connect.expired') : errorMessage(request.error)}</span>
        </Notice>
      </AuthShell>
    );
  }
  return <ConsentForm request={request.data} me={me} />;
};

/** The boards of the chosen account I can see (the server checks again), with a name filter. */
const BoardChecklist = ({
  accountId,
  picked,
  onToggle,
}: {
  accountId: string;
  picked: Set<string>;
  onToggle: (id: string) => void;
}) => {
  const boards = useAllBoards(accountId);
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return boards.filter((b) => !q || b.name.toLowerCase().includes(q));
  }, [boards, filter]);
  return (
    <div className="flex flex-col gap-1.5 rounded-[12px] border border-line p-2">
      <Input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder={t('connect.boards.search')}
        aria-label={t('connect.boards.search')}
        data-testid="connect-boards-search"
      />
      <div className="max-h-48 overflow-y-auto" data-testid="connect-board-list">
        {shown.length ? (
          shown.map((b) => (
            <div key={b.id} data-testid="connect-board" data-name={b.name}>
              <CheckRow checked={picked.has(b.id)} onToggle={() => onToggle(b.id)}>
                <span className="truncate">{b.name}</span>
              </CheckRow>
            </div>
          ))
        ) : (
          <p className="px-2 py-1 text-xs text-muted">{t('connect.boards.empty')}</p>
        )}
      </div>
      {!picked.size ? <p className="px-1 text-xs text-muted">{t('connect.boards.pick')}</p> : null}
    </div>
  );
};

const ConsentForm = ({ request, me }: { request: OauthRequest; me: Me }) => {
  const allowed = request.accounts.filter((a) => a.allowed);
  const [accountId, setAccountId] = useState<string | null>(
    () => (allowed.find((a) => a.id === me.last_account_id) ?? allowed[0])?.id ?? null,
  );
  const account = request.accounts.find((a) => a.id === accountId) ?? null;
  const readOnly = !!account?.read_only;
  const [groups, setGroups] = useState<Set<McpScopeGroup>>(() => new Set(request.requested_groups));
  const [limit, setLimit] = useState(false);
  const [boardIds, setBoardIds] = useState<Set<string>>(new Set());
  const [leaving, setLeaving] = useState(false);

  const go = (to: string) => {
    setLeaving(true);
    window.location.assign(to);
  };
  const allow = useMutation({
    mutationFn: () =>
      api().post<{ redirect_to: string }>(`/oauth-requests/${request.id}/approve`, {
        account_id: accountId,
        groups: readOnly ? [] : [...groups].filter((g) => g !== 'read'),
        ...(limit ? { board_ids: [...boardIds] } : {}),
      }),
    onSuccess: (r) => go(r.redirect_to),
  });
  const deny = useMutation({
    mutationFn: () => api().post<{ redirect_to: string }>(`/oauth-requests/${request.id}/deny`),
    onSuccess: (r) => go(r.redirect_to),
  });
  const toggle = (g: McpScopeGroup) =>
    setGroups((s) => {
      const next = new Set(s);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });
  const toggleBoard = (id: string) =>
    setBoardIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const busy = allow.isPending || deny.isPending || leaving;
  const canAllow = !!account?.allowed && (!limit || boardIds.size > 0) && !busy;
  const error = allow.error ?? deny.error;

  return (
    <AuthShell
      eyebrow={<Badge tone="info">{t('connect.eyebrow')}</Badge>}
      // An unverified (self-registered) app is named by where it sends you, not by the name it gave itself
      // (audit 2026-10-10 #3: a client registered as a trusted app's name).
      title={t('connect.title', {
        client: request.client.verified ? request.client.name : request.redirect_host || request.client.name,
        app: t('app.name'),
      })}
      subtitle={t('connect.subtitle')}
      footer={t('connect.footer')}
    >
      <div className="flex flex-col gap-1 rounded-[12px] border border-line bg-surface-2 px-3 py-2.5 text-xs text-fg-2">
        <p data-testid="connect-client">
          <span className="font-semibold text-heading">{request.client.name}</span>{' '}
          <bdi dir="ltr" className="font-mono text-muted">
            {request.client.host}
          </bdi>{' '}
          {request.client.verified ? null : (
            <span data-testid="connect-unverified">
              <Badge tone="warn">{t('connect.unverifiedBadge')}</Badge>
            </span>
          )}
        </p>
        {request.client.verified ? null : <p className="text-muted">{t('connect.unverified')}</p>}
        <p>
          {t('connect.redirect')}{' '}
          <bdi dir="ltr" className="font-mono" data-testid="connect-redirect-host">
            {request.redirect_host}
          </bdi>
        </p>
      </div>

      <fieldset className="flex flex-col gap-2" data-testid="connect-accounts">
        <legend className="mb-1 text-sm font-semibold text-heading">{t('connect.account')}</legend>
        <p className="-mt-1 text-xs text-muted">{t('connect.accountHint')}</p>
        {request.accounts.length ? (
          request.accounts.map((a) => (
            <RadioCard
              key={a.id}
              name="connect-account"
              checked={accountId === a.id}
              disabled={!a.allowed || busy}
              onSelect={() => {
                setAccountId(a.id);
                setBoardIds(new Set());
              }}
              title={
                <>
                  {a.name}
                  {a.read_only ? <Badge tone="neutral">{t('connect.account.readOnly')}</Badge> : null}
                </>
              }
              hint={a.reason ? tDynamic(`connect.reason.${a.reason}`) : undefined}
              testId={`connect-account-${a.slug}`}
            />
          ))
        ) : (
          <Notice tone="info">{t('connect.noAccounts')}</Notice>
        )}
      </fieldset>

      {account?.allowed ? (
        <>
          <fieldset className="flex flex-col gap-0.5" data-testid="connect-scopes">
            <legend className="mb-1 text-sm font-semibold text-heading">{t('connect.scopes')}</legend>
            {(['read', 'write', 'automations'] as const).map((g) => {
              const locked = g === 'read';
              const off = g !== 'read' && readOnly;
              const on = locked || (!off && groups.has(g));
              return (
                <div key={g} data-testid={`connect-scope-${g}`} data-checked={on}>
                  <CheckRow
                    checked={on}
                    onToggle={() => !locked && !off && toggle(g)}
                    className={locked || off ? 'cursor-default opacity-70' : undefined}
                  >
                    <span className="flex flex-col">
                      <span className="font-semibold text-fg">{t(`connect.scope.${g}`)}</span>
                      <span className="text-xs text-muted">
                        {off ? t('connect.scope.viewerOnly') : t(`connect.scope.${g}.hint`)}
                      </span>
                    </span>
                  </CheckRow>
                </div>
              );
            })}
          </fieldset>

          <fieldset className="flex flex-col gap-2" data-testid="connect-boards">
            <legend className="mb-1 text-sm font-semibold text-heading">{t('connect.boards')}</legend>
            <RadioCard
              name="connect-boards"
              checked={!limit}
              onSelect={() => setLimit(false)}
              title={t('connect.boards.all')}
              hint={t('connect.boards.allHint')}
              testId="connect-boards-all"
            />
            <RadioCard
              name="connect-boards"
              checked={limit}
              onSelect={() => setLimit(true)}
              title={t('connect.boards.some')}
              testId="connect-boards-some"
            />
            {limit && accountId ? (
              <BoardChecklist key={accountId} accountId={accountId} picked={boardIds} onToggle={toggleBoard} />
            ) : null}
          </fieldset>
        </>
      ) : null}

      {error ? <Notice tone="error">{errorMessage(error)}</Notice> : null}
      {leaving ? <Notice tone="info">{t('connect.redirecting')}</Notice> : null}

      <div className="flex flex-wrap items-center gap-2 max-md:flex-col-reverse max-md:items-stretch">
        <Button
          variant="accent"
          className="h-11 flex-1"
          disabled={!canAllow}
          onClick={() => allow.mutate()}
          data-testid="connect-allow"
        >
          {t('connect.allow')}
        </Button>
        <Button
          variant="secondary"
          className="h-11"
          disabled={busy}
          onClick={() => deny.mutate()}
          data-testid="connect-deny"
        >
          {t('connect.deny')}
        </Button>
      </div>
    </AuthShell>
  );
};
