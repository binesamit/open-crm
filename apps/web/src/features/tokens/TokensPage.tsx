// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ApiError } from '@bines/sdk';
import {
  ADMIN_ONLY_SCOPES,
  exactTime,
  relativeTime,
  SECRET_TOKEN_STEP_UP_MINUTES,
  t,
  TOKEN_SCOPES,
  type ApiToken,
  type CreatedToken,
  formatInstantDate,
  type MessageKey,
  type SecretStatus,
  type TokenScope,
} from '@bines/shared';
import { Badge, Button, Card, Dialog, EmptyState, Field, Input, Notice, Picker, SkeletonRows } from '@bines/ui';
import { CodeInput } from '../account/TwoFactor';
import { Icon } from '../../lib/icons';
import { PlanUpgradeLink, usePlanGate } from '../../lib/plan-gate';
import { planGateAttrs } from '../../lib/plan-limit';
import { api, errorMessage, type MyAccount } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { copyText } from '../../lib/entity-menu';
import { publicApiOrigin } from '../../lib/public-address';
import { showToast } from '../../lib/toast';
import { CheckRow } from '../board/toolbar/parts';
import { useAllBoards } from '../automations/automations-api';
import { McpConnections } from '../ai/McpConnections';
import { IntegrationsGuide } from './IntegrationsGuide';
import { LimitField, limitsSummary, parseLimit, TokenLimitsDialog } from './TokenLimits';

/** Scopes a new token starts with: what Make / n8n need to read and write items. */
const DEFAULT_SCOPES: TokenScope[] = ['boards:read', 'items:write', 'updates:write'];

const SECRETS_SCOPE: TokenScope = 'secrets:read';

/** My last code still counts for minting (a little margin, so it does not run out on the way to the server). */
const codeStillCounts = (verifiedAt: string | null) => {
  const at = verifiedAt ? new Date(verifiedAt).getTime() : 0;
  return !!at && Date.now() - at < SECRET_TOKEN_STEP_UP_MINUTES * 60_000 - 15_000;
};

/**
 * S-85: a personal token with `secrets:read` stands in for the secret step-up, so the server mints one only after a
 * fresh two-factor code (SECRET_TOKEN_STEP_UP_MINUTES). The dialog asks the same way the secret column does
 * (/secrets/status, then /secrets/verify): no 2FA → the scope is off with a notice and the way to turn 2FA on; no
 * fresh code → the code field in the dialog, then the token is created. A `secret_step_up_required` /
 * `secret_two_factor_required` answer from the server opens the same step (the server decides).
 */
export const CreateDialog = ({
  account,
  service = false,
  onClose,
}: {
  account: MyAccount;
  /** A service token (admins): a service member with its own role. */
  service?: boolean;
  onClose: (created?: CreatedToken) => void;
}) => {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [chosen, setChosen] = useState<TokenScope[]>(DEFAULT_SCOPES);
  // The step-up applies to my own token (a service token acts as its service member, never as me).
  const guarded = !service && account.role === 'admin';
  const status = useQuery({
    queryKey: ['account', account.id, 'secrets', 'status'],
    queryFn: () => api(account.id).get<SecretStatus>('/secrets/status'),
    enabled: guarded,
    staleTime: 0,
  });
  /** The step before creating: null, the code field, or "turn on 2FA first". */
  const [stepUp, setStepUp] = useState<null | 'code' | 'no2fa'>(null);
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const no2fa = guarded && (stepUp === 'no2fa' || status.data?.two_factor_enabled === false);
  // Without 2FA the scope cannot be given: it is never sent.
  const scopes = no2fa ? chosen.filter((s) => s !== SECRETS_SCOPE) : chosen;
  const wantsSecrets = guarded && scopes.includes(SECRETS_SCOPE);
  const [expiry, setExpiry] = useState<'30' | '90' | '365' | 'never'>('90');
  const boards = useAllBoards(account.id);
  const [limit, setLimit] = useState<string[] | null>(null);
  const [role, setRole] = useState<'member' | 'admin'>('member');
  // Its own budgets (ANSWERS 6א.9): empty = the account's default.
  const [minute, setMinute] = useState('');
  const [day, setDay] = useState('');
  const perMinute = parseLimit(minute, 'per_minute');
  const daily = parseLimit(day, 'daily');
  const create = useMutation({
    mutationFn: () =>
      api(account.id).post<CreatedToken>(service ? '/auth/service-tokens' : '/auth/tokens', {
        name: name.trim(),
        scopes,
        ...(service ? { role } : {}),
        ...(limit ? { board_ids: limit } : {}),
        expires_in_days: expiry === 'never' ? null : Number(expiry),
        ...(typeof perMinute === 'number' ? { rate_limit_per_minute: perMinute } : {}),
        ...(typeof daily === 'number' ? { daily_quota: daily } : {}),
      }),
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['account', account.id, 'tokens'] });
      onClose(c);
    },
    onError: (err) => {
      // The server's own check (a code that ran out on the way, or a status we did not see): the same step.
      const errCode = err instanceof ApiError ? err.body.code : null;
      if (errCode === 'secret_step_up_required') setStepUp('code');
      else if (errCode === 'secret_two_factor_required') setStepUp('no2fa');
    },
  });
  const stepUpError =
    create.error instanceof ApiError &&
    (create.error.body.code === 'secret_step_up_required' || create.error.body.code === 'secret_two_factor_required');
  const allowed = TOKEN_SCOPES.filter(
    (s) => (account.role === 'admin' && (!service || role === 'admin')) || !ADMIN_ONLY_SCOPES.includes(s),
  );
  const toggleScope = (s: TokenScope) => {
    if (s === SECRETS_SCOPE) {
      if (no2fa) return;
      setStepUp(null);
      setCode('');
      setCodeError(null);
    }
    create.reset();
    setChosen((x) => (x.includes(s) ? x.filter((y) => y !== s) : [...x, s]));
  };

  /** Creates at once unless `secrets:read` needs a fresh code first (checked here; the server checks again). */
  const submit = async () => {
    if (stepUp === 'code') return verifyAndCreate();
    if (!wantsSecrets) return create.mutate();
    setChecking(true);
    setCodeError(null);
    try {
      const s = await api(account.id).get<SecretStatus>('/secrets/status');
      if (!s.two_factor_enabled) return setStepUp('no2fa');
      if (codeStillCounts(s.verified_at)) return create.mutate();
      setStepUp('code');
    } catch {
      // The status could not be read: let the server decide (its answer opens the step if needed).
      create.mutate();
    } finally {
      setChecking(false);
    }
  };

  const verifyAndCreate = async () => {
    if (code.length < 6) return;
    setChecking(true);
    setCodeError(null);
    try {
      await api(account.id).post('/secrets/verify', { code });
    } catch (err) {
      setCodeError(errorMessage(err));
      setChecking(false);
      return;
    }
    setChecking(false);
    setCode('');
    setStepUp(null);
    create.mutate();
  };
  return (
    <Dialog
      open
      onClose={() => onClose()}
      title={service ? t('tokens.create_service') : t('tokens.create')}
      footer={
        <>
          <Button variant="secondary" onClick={() => onClose()}>
            {t('common.cancel')}
          </Button>
          <Button
            busy={create.isPending || checking}
            disabled={
              !name.trim() ||
              !scopes.length ||
              (limit !== null && !limit.length) ||
              perMinute === 'invalid' ||
              daily === 'invalid' ||
              (stepUp === 'code' && code.length < 6)
            }
            onClick={() => void submit()}
            data-testid="token-create-confirm"
          >
            {stepUp === 'code' ? t('tokens.secrets.submit') : t('tokens.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="token-create-dialog">
        <Field label={t('tokens.name')} hint={t('tokens.name_hint')}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} data-testid="token-name" />
        </Field>
        {service ? (
          <Field label={t('tokens.role')} hint={t('tokens.role_hint')}>
            <div className="w-48">
              <Picker
                label={t('tokens.role')}
                value={role}
                onChange={setRole}
                testId="token-role"
                options={[
                  { value: 'member', label: t('role.member') },
                  { value: 'admin', label: t('role.admin') },
                ]}
              />
            </div>
          </Field>
        ) : null}
        <section className="space-y-1">
          <h3 className="text-sm font-semibold">{t('tokens.scopes')}</h3>
          <div className="grid gap-1 sm:grid-cols-2" data-testid="token-scopes">
            {allowed.map((s) => (
              <CheckRow
                key={s}
                checked={scopes.includes(s)}
                disabled={s === SECRETS_SCOPE && no2fa}
                testId={`token-scope-${s}`}
                onToggle={() => toggleScope(s)}
              >
                <span className="text-sm">{t(`tokens.scope.${s.replace(':', '_')}` as MessageKey)}</span>
                <code className="ms-2 text-xs text-muted" dir="ltr">
                  {s}
                </code>
              </CheckRow>
            ))}
          </div>
          {no2fa && allowed.includes(SECRETS_SCOPE) ? (
            <Notice tone="warn">
              <span data-testid="token-secrets-no2fa">{t('tokens.secrets.no2fa')}</span>{' '}
              <Link
                to="/a/$accountSlug/profile"
                params={{ accountSlug: account.slug }}
                search={{ tab: 'security' }}
                onClick={() => onClose()}
                className="font-semibold text-primary hover:underline"
              >
                {t('secret.no2fa.link')}
              </Link>
            </Notice>
          ) : null}
          {stepUp === 'code' && wantsSecrets ? (
            <form
              className="flex flex-col gap-2 rounded-[10px] border border-line p-3"
              data-testid="token-secrets-code"
              onSubmit={(e) => {
                e.preventDefault();
                void verifyAndCreate();
              }}
            >
              <p className="text-sm font-semibold">{t('tokens.secrets.codeTitle')}</p>
              <p className="text-xs text-muted">{t('tokens.secrets.codeHint')}</p>
              <CodeInput value={code} onChange={setCode} testId="token-secrets-code-input" />
              {codeError ? (
                <p role="alert" className="text-xs text-danger-fg" data-testid="token-secrets-code-error">
                  {codeError}
                </p>
              ) : null}
            </form>
          ) : null}
        </section>
        <section className="space-y-1" data-testid="token-boards">
          <h3 className="text-sm font-semibold">{t('tokens.boards')}</h3>
          <CheckRow checked={limit === null} onToggle={() => setLimit(limit === null ? [] : null)}>
            {t('tokens.boards_all')}
          </CheckRow>
          {limit !== null ? (
            <div className="grid max-h-40 gap-1 overflow-y-auto ps-4 sm:grid-cols-2">
              {boards.map((b) => (
                <CheckRow
                  key={b.id}
                  checked={limit.includes(b.id)}
                  onToggle={() => setLimit((x) => (x!.includes(b.id) ? x!.filter((y) => y !== b.id) : [...x!, b.id]))}
                >
                  <span className="text-sm">{b.name}</span>
                </CheckRow>
              ))}
            </div>
          ) : null}
        </section>
        <Field label={t('tokens.expiry')}>
          <div className="w-48">
            <Picker
              label={t('tokens.expiry')}
              value={expiry}
              onChange={setExpiry}
              testId="token-expiry"
              options={[
                { value: '30', label: t('tokens.expiry.days', { n: 30 }) },
                { value: '90', label: t('tokens.expiry.days', { n: 90 }) },
                { value: '365', label: t('tokens.expiry.year') },
                { value: 'never', label: t('tokens.expiry.never') },
              ]}
            />
          </div>
        </Field>
        <section className="space-y-1.5" data-testid="token-create-limits">
          <h3 className="text-sm font-semibold">{t('tokens.limits.title')}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            <LimitField
              label={t('limits.perMinute')}
              kind="per_minute"
              value={minute}
              onChange={setMinute}
              fallback={t('tokens.limits.accountDefault')}
              testId="token-create-limit-minute"
            />
            <LimitField
              label={t('limits.perDay')}
              kind="daily"
              value={day}
              onChange={setDay}
              fallback={t('tokens.limits.accountDefault')}
              testId="token-create-limit-day"
            />
          </div>
        </section>
        {create.isError && !stepUpError ? <Notice tone="error">{errorMessage(create.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};

/** The secret, once (06 §1.2): copy it now — only its prefix is kept. */
const ShowOnce = ({ created, onClose }: { created: CreatedToken; onClose: () => void }) => (
  <Dialog
    open
    onClose={onClose}
    title={t('tokens.created_title')}
    footer={<Button onClick={onClose}>{t('tokens.done')}</Button>}
  >
    <div className="flex flex-col gap-3.5" data-testid="token-created">
      <Notice tone="warn">{t('tokens.once')}</Notice>
      <div className="flex items-center gap-2">
        <code
          className="flex h-9 min-w-0 flex-1 items-center overflow-x-auto rounded-[10px] border border-line-strong bg-surface-3 px-2.5 font-mono text-xs whitespace-nowrap text-fg"
          dir="ltr"
          data-testid="token-secret"
        >
          {created.token}
        </code>
        <Button variant="accent" onClick={() => copyText(created.token)} data-testid="token-copy">
          <Icon name="copy" size={15} />
          {t('tokens.copy')}
        </Button>
      </div>
    </div>
  </Dialog>
);

/**
 * "טוקני API" (06 §1.2): personal tokens for Make, n8n and scripts — create (scopes, expiry), see when each was
 * last used, revoke. Admins see every member's token and can revoke it.
 */
/**
 * `embedded`: inside Administration → חיבורים (the hub owns the page title): a section with an h2, no page padding.
 * For admins /settings/tokens redirects there (A3); members keep this page for their own tokens.
 */
/**
 * `personal` (fix5): "הפרופיל שלי" → טוקני API — my own tokens only (no service tokens, no "everyone's tokens"),
 * a section under the profile's tabs. /settings/tokens redirects there; the account-wide management stays in
 * Administration → חיבורים.
 */
export const TokensPage = ({
  account,
  embedded = false,
  personal = false,
}: {
  account: MyAccount;
  embedded?: boolean;
  personal?: boolean;
}) => {
  const qc = useQueryClient();
  const isAdmin = account.role === 'admin' && !personal;
  // New tokens need the plan's `api`; existing tokens stay listed (and revocable) either way.
  const apiGate = usePlanGate(account.id, 'api');
  // In Administration → חיבורים (the home of API tokens) an admin starts with every member's tokens.
  const [all, setAll] = useState(embedded && isAdmin);
  const allBoards = useAllBoards(account.id);
  const [creating, setCreating] = useState<false | 'personal' | 'service'>(false);
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const [limitsOf, setLimitsOf] = useState<ApiToken | null>(null);
  const [now] = useState(() => Date.now());
  const key = ['account', account.id, 'tokens', all];
  const tokens = useQuery({
    queryKey: key,
    queryFn: () => api(account.id).get<{ data: ApiToken[] }>(`/auth/tokens${all ? '?all=true' : ''}`),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(account.id).delete(`/auth/tokens/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['account', account.id, 'tokens'] }),
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const ask = async (tok: ApiToken) => {
    if (
      await confirmDialog({
        title: t('tokens.revoke_title'),
        message: tok.name,
        danger: true,
        confirmLabel: t('tokens.revoke'),
      })
    )
      revoke.mutate(tok.id);
  };
  const when = (iso: string | null) => (iso ? formatInstantDate(iso) : '—');
  const Root = embedded || personal ? 'section' : 'main';

  return (
    <Root
      className={embedded || personal ? 'space-y-4' : 'w-full space-y-4 px-4 py-5 md:px-6'}
      data-testid="tokens-page"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 max-md:flex-col max-md:items-stretch">
        <div className="space-y-1">
          {personal ? null : embedded ? (
            <h2 className="font-display text-[1.25rem] leading-snug font-extrabold text-heading">
              {t('tokens.title')}
            </h2>
          ) : (
            <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-md:text-2xl">
              {t('tokens.title')}
            </h1>
          )}
          <p className="max-w-[640px] text-sm text-muted">{t('tokens.intro')}</p>
        </div>
        {account.role !== 'viewer' ? (
          <div className="flex flex-wrap items-center gap-2">
            {isAdmin ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => apiGate.allowed && setCreating('service')}
                data-testid="token-new-service"
                {...planGateAttrs(apiGate)}
              >
                {t('tokens.create_service')}
              </Button>
            ) : null}
            <Button
              variant="accent"
              onClick={() => apiGate.allowed && setCreating('personal')}
              data-testid="token-new"
              {...planGateAttrs(apiGate)}
            >
              <Icon name="plus" size={15} strokeWidth={2.4} />
              {t('tokens.create')}
            </Button>
            <PlanUpgradeLink gate={apiGate} />
          </div>
        ) : null}
      </header>
      {isAdmin ? (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-fg-2">
          <input
            type="checkbox"
            checked={all}
            onChange={() => setAll((v) => !v)}
            data-testid="tokens-show-all"
            className="size-[0.9375rem] accent-[var(--check)]"
          />
          {t('tokens.show_all')}
        </label>
      ) : null}
      {tokens.isError ? <Notice tone="error">{errorMessage(tokens.error)}</Notice> : null}
      {tokens.isLoading ? (
        <SkeletonRows rows={3} label={t('app.loading')} />
      ) : !tokens.data?.data.length ? (
        <EmptyState icon={<Icon name="key" size={28} />} title={t('tokens.empty')} testId="tokens-empty" />
      ) : (
        <ul className="overflow-hidden rounded-[14px] border border-line">
          {tokens.data.data.map((tok) => (
            <li
              key={tok.id}
              className="flex items-start gap-3 border-b border-line-soft bg-surface px-3.5 py-3 last:border-b-0"
              data-testid="token-row"
              data-name={tok.name}
            >
              <span className="grid size-7 shrink-0 place-items-center rounded-[10px] bg-surface-2 text-heading">
                <Icon name="key" size={15} />
              </span>
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-fg">{tok.name}</span>
                  <code className="font-mono text-[0.6875rem] text-muted" dir="ltr">
                    {tok.prefix}…
                  </code>
                  {tok.service ? (
                    <span data-testid="token-service">
                      <Badge tone="violet">{t('tokens.service')}</Badge>
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-fg-2">
                  {tok.scopes.map((sc) => t(`tokens.scope.${sc.replace(':', '_')}` as MessageKey)).join(' · ')}
                </p>
                <p className="flex flex-wrap gap-x-1.5 text-[0.6875rem] text-muted">
                  {all && tok.user_name ? (
                    <>
                      <span>{tok.user_name}</span>
                      <span aria-hidden>·</span>
                    </>
                  ) : null}
                  {tok.board_ids ? (
                    <>
                      <span data-testid="token-board-limit">
                        {t('tokens.only_boards', {
                          boards: tok.board_ids.map((id) => allBoards.find((b) => b.id === id)?.name ?? '…').join(', '),
                        })}
                      </span>
                      <span aria-hidden>·</span>
                    </>
                  ) : null}
                  <span>
                    {t('tokens.last_used')}:{' '}
                    {tok.last_used_at ? (
                      <time dateTime={tok.last_used_at} title={exactTime(tok.last_used_at)}>
                        {relativeTime(tok.last_used_at, now)}
                      </time>
                    ) : (
                      '—'
                    )}
                  </span>
                  <span aria-hidden>·</span>
                  <span>
                    {t('tokens.expires')}: {tok.expires_at ? when(tok.expires_at) : t('tokens.expiry.never')}
                  </span>
                  <span aria-hidden>·</span>
                  <span data-testid="token-limits-summary">{limitsSummary(tok)}</span>
                </p>
              </div>
              <Button variant="secondary" size="sm" onClick={() => setLimitsOf(tok)} data-testid="token-limits">
                {t('tokens.limits.edit')}
              </Button>
              <Button variant="danger-outline" size="sm" onClick={() => void ask(tok)} data-testid="token-revoke">
                {t('tokens.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {/* AI apps connected over OAuth (Claude.ai, ChatGPT — מ5): the other kind of key to this account. */}
      <McpConnections account={account} all={all} />
      <Card soft className="flex flex-wrap items-center gap-3.5">
        <span className="grid size-10 shrink-0 place-items-center rounded-[12px] bg-accent text-on-accent">
          <Icon name="link" size={18} />
        </span>
        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5 text-sm">
          <h2 className="font-display text-[0.9375rem] font-bold text-heading">{t('tokens.guide_title')}</h2>
          <p className="text-muted">
            {/* The header is LTR inside a Hebrew sentence: isolate it so bidi keeps its order. */}
            {t('tokens.guide')
              .split(/(Authorization: Bearer <[^>]*>)/)
              .map((part, i) =>
                i % 2 ? (
                  <bdi key={i} dir="ltr" className="font-mono text-xs text-fg-2">
                    {part}
                  </bdi>
                ) : (
                  part
                ),
              )}
          </p>
          <code
            className="mt-1 block max-w-full overflow-x-auto rounded-[8px] border border-line bg-surface px-2 py-1 text-start font-mono text-xs whitespace-nowrap text-fg-2"
            dir="ltr"
          >
            {`${publicApiOrigin()}/api/v1/boards/<board id>/items`}
          </code>
        </div>
        <a
          className="press inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-2.5 text-[0.8125rem] whitespace-nowrap text-heading hover:bg-surface-2"
          href="/api/docs"
          target="_blank"
          rel="noreferrer"
        >
          {t('tokens.docs')}
          <Icon name="ext" size={14} />
        </a>
      </Card>
      {/* our own n8n nodes and Make app — the steps, the package / invitation link and the URL. */}
      <IntegrationsGuide
        account={account}
        onCreateToken={account.role !== 'viewer' && apiGate.allowed ? () => setCreating('personal') : undefined}
      />
      {creating ? (
        <CreateDialog
          account={account}
          service={creating === 'service'}
          onClose={(c) => {
            setCreating(false);
            if (c) setCreated(c);
          }}
        />
      ) : null}
      {created ? <ShowOnce created={created} onClose={() => setCreated(null)} /> : null}
      {limitsOf ? <TokenLimitsDialog account={account} token={limitsOf} onClose={() => setLimitsOf(null)} /> : null}
    </Root>
  );
};
