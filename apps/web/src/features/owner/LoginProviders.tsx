// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDateTime,
  type LoginProvider,
  type LoginProvidersResponse,
  type LoginProviderState,
  type LoginProviderTest,
  MICROSOFT_DEFAULT_TENANT,
  t,
  type UpdateLoginProvider,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, Card, Field, Input, Notice, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { copyText } from '../../lib/entity-menu';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { GoogleMark, MicrosoftMark } from '../auth/AuthShell';

const KEY = ['platform', 'login-providers'] as const;

/** How many numbered steps each provider's guide has (texts: i18n `sso.guide.<provider>.<n>`). */
const GUIDE_STEPS: Record<LoginProvider, number> = { google: 7, microsoft: 8 };

/**
 * Owner console → "ספקי התחברות": "Continue with Google / Microsoft". Per provider: on / off, the
 * client id, the secret (write-only — after saving only "saved ••••1234"), Microsoft's tenant, the exact return
 * address to register (with a copy button), a short step guide and "test connection". Nothing saved = the server's
 * environment variables, when it has them. Applies at once, no restart.
 */
export const LoginProvidersPanel = () => {
  const list = useQuery({
    queryKey: KEY,
    queryFn: () => api().get<LoginProvidersResponse>('/platform/login-providers'),
  });
  return (
    <section className="flex flex-col gap-2.5" data-testid="owner-login-providers">
      <div className="space-y-0.5">
        <h2 className="font-display text-base font-bold text-heading">{t('sso.owner.title')}</h2>
        <p className="text-xs text-muted">{t('sso.owner.hint')}</p>
      </div>
      {list.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      <div className="grid gap-3 lg:grid-cols-2">
        {list.data?.data.map((p) => (
          <ProviderCard key={`${p.provider}-${p.client_id ?? ''}-${p.tenant_id ?? ''}`} state={p} />
        ))}
      </div>
    </section>
  );
};

const StatusBadge = ({ state }: { state: LoginProviderState }) =>
  state.active ? (
    <Badge tone="ok">{t('sso.owner.status.active')}</Badge>
  ) : !state.enabled ? (
    <Badge>{t('sso.owner.status.off')}</Badge>
  ) : (
    <Badge tone="warn">{t('sso.owner.status.incomplete')}</Badge>
  );

const TestLine = ({ test }: { test: LoginProviderTest | null }) =>
  test ? (
    <p
      className={test.ok ? 'text-xs text-ok-fg' : 'text-xs text-danger-fg'}
      data-testid="login-provider-test-result"
      data-ok={test.ok ? '1' : '0'}
    >
      {test.ok
        ? t('sso.owner.test.ok', { at: formatDateTime(test.at) })
        : t('sso.owner.test.failed', {
            at: formatDateTime(test.at),
            reason: tDynamic(`sso.owner.test.error.${test.error ?? 'other'}`),
          })}
    </p>
  ) : (
    <p className="text-xs text-muted">{t('sso.owner.test.never')}</p>
  );

const ProviderCard = ({ state }: { state: LoginProviderState }) => {
  const qc = useQueryClient();
  const id = state.provider;
  const testId = `login-provider-${id}`;
  const [clientId, setClientId] = useState(state.client_id ?? '');
  const [secret, setSecret] = useState('');
  const [tenant, setTenant] = useState(state.tenant_id ?? '');
  const [guide, setGuide] = useState(!state.active);

  const save = useMutation({
    mutationFn: (patch: UpdateLoginProvider) =>
      api().patch<LoginProvidersResponse>(`/platform/login-providers/${id}`, patch),
    onSuccess: (res) => {
      qc.setQueryData(KEY, res);
      // The sign-in screen's buttons follow at once.
      void qc.invalidateQueries({ queryKey: queryKeys.authConfig });
      setSecret('');
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const test = useMutation({
    mutationFn: () =>
      api().post<LoginProvidersResponse & { result: LoginProviderTest }>(`/platform/login-providers/${id}/test`),
    onSuccess: (res) => {
      qc.setQueryData(KEY, { data: res.data });
      showToast({
        message: res.result.ok ? t('sso.owner.test.okToast') : t('sso.owner.test.failedToast'),
        tone: res.result.ok ? undefined : 'error',
      });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });

  const dirty =
    clientId.trim() !== (state.client_id ?? '') ||
    !!secret.trim() ||
    (id === 'microsoft' && tenant.trim() !== (state.tenant_id ?? ''));
  const submit = () => {
    const patch: UpdateLoginProvider = {};
    if (clientId.trim() !== (state.client_id ?? '')) patch.client_id = clientId.trim() || null;
    if (secret.trim()) patch.client_secret = secret.trim();
    if (id === 'microsoft' && tenant.trim() !== (state.tenant_id ?? '')) patch.tenant_id = tenant.trim() || null;
    save.mutate(patch);
  };

  return (
    <Card className="space-y-3" data-testid={testId} data-active={state.active ? '1' : '0'}>
      <div className="flex items-center gap-2">
        {id === 'google' ? <GoogleMark /> : <MicrosoftMark />}
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-fg">{t(`sso.provider.${id}`)}</h3>
        <span data-testid={`${testId}-status`}>
          <StatusBadge state={state} />
        </span>
        <Switch
          checked={state.enabled}
          disabled={save.isPending}
          onChange={(on) => save.mutate({ enabled: on })}
          label={t('sso.owner.enabled')}
          testId={`${testId}-enabled`}
        />
      </div>
      <p className="text-xs text-muted" data-testid={`${testId}-source`}>
        {t(`sso.owner.source.${state.source}`)}
      </p>

      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-fg-2">{t('sso.owner.redirect')}</p>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            dir="ltr"
            value={state.redirect_uri}
            aria-label={t('sso.owner.redirect')}
            onFocus={(e) => e.currentTarget.select()}
            className="h-9 min-w-0 flex-1 text-xs text-fg-2"
            data-testid={`${testId}-redirect`}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => copyText(state.redirect_uri)}
            data-testid={`${testId}-redirect-copy`}
          >
            <Icon name="copy" size={14} />
            {t('link.copy')}
          </Button>
        </div>
        <p className="text-xs text-muted">{t(`sso.owner.redirectHint.${id}`)}</p>
      </div>

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) submit();
        }}
      >
        <Field label={t(`sso.owner.clientId.${id}`)}>
          <Input
            value={clientId}
            dir="ltr"
            maxLength={300}
            autoComplete="off"
            onChange={(e) => setClientId(e.target.value)}
            data-testid={`${testId}-client-id`}
          />
        </Field>
        <Field
          label={t(`sso.owner.secret.${id}`)}
          hint={state.has_secret ? t('sso.owner.secretSaved', { hint: state.secret_hint ?? '' }) : undefined}
        >
          <Input
            type="password"
            value={secret}
            dir="ltr"
            maxLength={500}
            autoComplete="new-password"
            placeholder={state.has_secret ? `•••• ${state.secret_hint ?? ''}` : ''}
            onChange={(e) => setSecret(e.target.value)}
            data-testid={`${testId}-secret`}
          />
        </Field>
        {id === 'microsoft' ? (
          <Field label={t('sso.owner.tenant')} hint={t('sso.owner.tenantHint')}>
            <Input
              value={tenant}
              dir="ltr"
              maxLength={100}
              placeholder={MICROSOFT_DEFAULT_TENANT}
              onChange={(e) => setTenant(e.target.value)}
              data-testid={`${testId}-tenant`}
            />
          </Field>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" busy={save.isPending} disabled={!dirty} data-testid={`${testId}-save`}>
            {t('common.save')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            busy={test.isPending}
            disabled={state.source === 'none' || dirty}
            onClick={() => test.mutate()}
            data-testid={`${testId}-test`}
          >
            {t('sso.owner.test')}
          </Button>
          {state.has_secret || state.client_id ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={save.isPending}
              onClick={() => {
                setClientId('');
                setSecret('');
                setTenant('');
                save.mutate({
                  client_id: null,
                  client_secret: null,
                  ...(id === 'microsoft' ? { tenant_id: null } : {}),
                });
              }}
              data-testid={`${testId}-clear`}
            >
              {t('sso.owner.clear')}
            </Button>
          ) : null}
        </div>
        <TestLine test={state.last_test} />
      </form>

      <div className="border-t border-line pt-2">
        <button
          type="button"
          className="flex items-center gap-1 text-xs font-semibold text-heading hover:underline"
          aria-expanded={guide}
          onClick={() => setGuide((v) => !v)}
          data-testid={`${testId}-guide-toggle`}
        >
          <Icon name={guide ? 'chevronDown' : 'chevronEnd'} size={14} />
          {t('sso.owner.guide')}
        </button>
        {guide ? (
          <ol className="mt-2 list-decimal space-y-1 ps-5 text-xs text-fg-2" data-testid={`${testId}-guide`}>
            {Array.from({ length: GUIDE_STEPS[id] }, (_, i) => (
              <li key={i}>{tDynamic(`sso.guide.${id}.${i + 1}`)}</li>
            ))}
          </ol>
        ) : null}
      </div>
    </Card>
  );
};
