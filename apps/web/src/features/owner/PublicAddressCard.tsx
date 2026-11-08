// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MAX_PREVIOUS_ORIGINS,
  normalizeOrigin,
  type PlatformSettingsResponse,
  t,
  type UpdatePlatformSettings,
  tDynamic,
} from '@bines/shared';
import { Button, Card, Field, Input, Notice } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';

/**
 * Owner console → the platform's public address (prod fix M11): the domain every link in an email, push message,
 * SMS, the API reference and the MCP / OAuth issuer is built on. Empty = WEB_ORIGIN. Shows what is in effect and
 * where it came from; earlier addresses stay accepted for sign-in while people move. Applies without a redeploy —
 * only Google sign-in's return address (BETTER_AUTH_URL) is fixed when the server starts.
 */
export const PublicAddressCard = ({ data }: { data: PlatformSettingsResponse }) => {
  const qc = useQueryClient();
  const saved = data.settings.public_address;
  const effective = data.public_address;
  const [web, setWeb] = useState(saved.web_origin ?? '');
  const [apiOrigin, setApiOrigin] = useState(saved.api_origin ?? '');
  const [previous, setPrevious] = useState<string[]>(saved.previous_origins ?? []);
  const [adding, setAdding] = useState('');

  const save = useMutation({
    mutationFn: (public_address: NonNullable<UpdatePlatformSettings['public_address']>) =>
      api().patch<PlatformSettingsResponse>('/platform/settings', { public_address }),
    onSuccess: (res) => {
      qc.setQueryData(['platform', 'settings'], res);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });

  const ok = (v: string) => !v.trim() || normalizeOrigin(v) !== null;
  const webOk = ok(web);
  const apiOk = ok(apiOrigin);
  const addOk = !!adding.trim() && normalizeOrigin(adding) !== null;
  const authOrigin = (() => {
    try {
      return new URL(effective?.auth_base_url ?? '').origin;
    } catch {
      return null;
    }
  })();
  const authDiffers = !!effective && !!authOrigin && authOrigin !== effective.web;
  const sourceLabel = (s: string) => tDynamic(`s37domain.source.${s}`);

  return (
    <Card className="space-y-3" data-testid="owner-public-address">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-fg">{t('s37domain.title')}</h3>
        <p className="text-xs text-muted">{t('s37domain.hint')}</p>
      </div>

      {effective ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid="owner-public-address-effective">
          <dt className="text-muted">{t('s37domain.effectiveWeb')}</dt>
          <dd>
            <code dir="ltr" data-testid="owner-public-address-web-value">
              {effective.web}
            </code>{' '}
            <span className="text-muted" data-testid="owner-public-address-web-source">
              ({sourceLabel(effective.web_source)})
            </span>
          </dd>
          <dt className="text-muted">{t('s37domain.effectiveApi')}</dt>
          <dd>
            <code dir="ltr" data-testid="owner-public-address-api-value">
              {effective.api}
            </code>{' '}
            <span className="text-muted">({sourceLabel(effective.api_source)})</span>
          </dd>
        </dl>
      ) : null}

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!webOk || !apiOk) return;
          save.mutate({
            web_origin: web.trim() ? normalizeOrigin(web) : null,
            api_origin: apiOrigin.trim() ? normalizeOrigin(apiOrigin) : null,
          });
        }}
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label={t('s37domain.web')} hint={t('s37domain.webHint')}>
            <Input
              value={web}
              dir="ltr"
              maxLength={200}
              placeholder={effective?.env_web_origin ?? 'https://'}
              aria-invalid={!webOk || undefined}
              onChange={(e) => setWeb(e.target.value)}
              data-testid="owner-public-address-web"
            />
          </Field>
          <Field label={t('s37domain.api')} hint={t('s37domain.apiHint')}>
            <Input
              value={apiOrigin}
              dir="ltr"
              maxLength={200}
              placeholder={effective?.web ?? 'https://'}
              aria-invalid={!apiOk || undefined}
              onChange={(e) => setApiOrigin(e.target.value)}
              data-testid="owner-public-address-api"
            />
          </Field>
          <Button
            type="submit"
            size="sm"
            busy={save.isPending}
            disabled={!webOk || !apiOk}
            data-testid="owner-public-address-save"
          >
            {t('common.save')}
          </Button>
        </div>
        {!webOk || !apiOk ? (
          <p className="text-xs text-danger-fg" data-testid="owner-public-address-invalid">
            {t('s37domain.invalid')}
          </p>
        ) : null}
      </form>

      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-fg-2">{t('s37domain.previous')}</p>
        <p className="text-xs text-muted">{t('s37domain.previousHint')}</p>
        <ul className="flex flex-wrap gap-1.5" data-testid="owner-public-address-previous">
          {previous.map((o) => (
            <li key={o} className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-xs">
              <code dir="ltr">{o}</code>
              <button
                type="button"
                className="text-muted hover:text-fg"
                aria-label={t('s37domain.remove')}
                data-tip={t('s37domain.remove')}
                onClick={() => {
                  const next = previous.filter((x) => x !== o);
                  setPrevious(next);
                  save.mutate({ previous_origins: next });
                }}
              >
                ×
              </button>
            </li>
          ))}
          {!previous.length ? <li className="text-xs text-muted">{t('s37domain.noPrevious')}</li> : null}
        </ul>
        {previous.length < MAX_PREVIOUS_ORIGINS ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const o = normalizeOrigin(adding);
              if (!o || previous.includes(o)) return;
              const next = [...previous, o];
              setPrevious(next);
              setAdding('');
              save.mutate({ previous_origins: next });
            }}
          >
            <Input
              value={adding}
              dir="ltr"
              maxLength={200}
              placeholder="https://"
              aria-label={t('s37domain.add')}
              onChange={(e) => setAdding(e.target.value)}
              data-testid="owner-public-address-previous-input"
            />
            <Button
              type="submit"
              size="sm"
              variant="secondary"
              disabled={!addOk}
              data-testid="owner-public-address-add"
            >
              {t('s37domain.add')}
            </Button>
          </form>
        ) : null}
      </div>

      {authDiffers ? (
        <Notice tone="warn">
          <span data-testid="owner-public-address-auth-warning">
            {t('s37domain.authRestart', { url: effective!.auth_base_url })}
          </span>
        </Notice>
      ) : null}
    </Card>
  );
};
