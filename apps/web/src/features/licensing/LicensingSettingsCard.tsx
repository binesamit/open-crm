// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { getLocale, type LicensingSettings, t, type UpdateLicensingSettings } from '@bines/shared';
import { Badge, Button, Card, Field, Input, Notice, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { licensingKeys, useLicensingSettings, useRegistrationForm } from './licensing-api';

/**
 * Owner console → Licensing → settings (docs/LICENSING.md): the license server this installation registers with
 * (empty = registration unavailable; nothing is built in), the registration state, and telemetry — OFF unless turned
 * on here, never sent with `BINES_TELEMETRY=false`, and the exact heartbeat shown before anyone opts in.
 */
export const LicensingSettingsCard = () => {
  const qc = useQueryClient();
  const settings = useLicensingSettings();
  const s = settings.data;
  const form = useRegistrationForm(!!s?.server_url);
  const save = useMutation({
    mutationFn: (patch: UpdateLicensingSettings) => api().patch<LicensingSettings>('/platform/licensing', patch),
    onSuccess: (res) => {
      qc.setQueryData(licensingKeys.settings, res);
      void qc.invalidateQueries({ queryKey: licensingKeys.form });
      showToast({ message: t('licensing.settings.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const reset = useMutation({
    mutationFn: () => api().post<LicensingSettings>('/platform/registration/reset'),
    onSuccess: (res) => qc.setQueryData(licensingKeys.settings, res),
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  return (
    <Card className="space-y-4" data-testid="licensing-settings">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-fg">{t('licensing.settings.title')}</h3>
        <p className="max-w-[640px] text-xs text-muted">{t('licensing.settings.hint')}</p>
      </div>
      {settings.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {settings.isError ? <Notice tone="error">{errorMessage(settings.error)}</Notice> : null}
      {s ? (
        <ServerUrl
          key={s.server_url_setting ?? ''}
          s={s}
          busy={save.isPending}
          onSave={(v) => save.mutate({ server_url: v })}
        />
      ) : null}
      {s?.server_url ? (
        <ProviderKey
          key={s.server_key_fingerprint ?? ''}
          s={s}
          busy={save.isPending}
          onSave={(pem) => save.mutate({ server_public_key: pem })}
        />
      ) : null}
      {s ? (
        <div className="space-y-1 text-sm" data-testid="licensing-registration" data-status={s.registration.status}>
          <span className="text-muted">{t('licensing.settings.registration')}</span>{' '}
          <Badge tone={s.registration.status === 'registered' ? 'ok' : 'neutral'}>
            {t(`licensing.registration.${s.registration.status}`)}
          </Badge>
          {s.registration.email ? (
            <span dir="ltr" className="ms-2 text-xs text-muted">
              {s.registration.email}
            </span>
          ) : null}
          {s.registration.status !== 'unasked' ? (
            <Button
              size="sm"
              variant="ghost"
              className="ms-2"
              busy={reset.isPending}
              onClick={() => reset.mutate()}
              data-testid="licensing-registration-reset"
            >
              {t('licensing.settings.askAgain')}
            </Button>
          ) : null}
          {/* Only when the license server sells licenses online (its payment provider is set up). */}
          {form.data?.purchase_available ? (
            <a
              href={`${s.server_url}/buy?instance=${encodeURIComponent(s.instance_id)}`}
              target="_blank"
              rel="noreferrer"
              className="ms-2 text-xs font-semibold text-primary hover:underline"
              data-testid="licensing-buy"
            >
              {t('licensing.settings.buy')}
            </a>
          ) : null}
        </div>
      ) : null}
      {s ? (
        <div className="space-y-2 border-t border-line pt-3" data-testid="licensing-telemetry">
          <label className="flex items-center justify-between gap-3">
            <span className="space-y-0.5">
              <span className="block text-sm font-semibold text-fg">{t('licensing.telemetry.title')}</span>
              <span className="block max-w-[600px] text-xs text-muted">{t('licensing.telemetry.hint')}</span>
            </span>
            <Switch
              checked={s.telemetry.enabled && !s.telemetry.forced_off}
              disabled={s.telemetry.forced_off || save.isPending}
              onChange={(on) => save.mutate({ telemetry: on })}
              label={t('licensing.telemetry.title')}
              testId="licensing-telemetry-switch"
            />
          </label>
          {s.telemetry.forced_off ? <Notice tone="info">{t('licensing.telemetry.forcedOff')}</Notice> : null}
          <div className="text-xs text-muted">{t('licensing.telemetry.sends')}</div>
          <pre
            dir="ltr"
            className="overflow-x-auto rounded-[10px] bg-surface-2 px-3 py-2 text-start font-mono text-xs text-fg-2"
            data-testid="licensing-telemetry-preview"
          >
            {JSON.stringify(s.telemetry.preview, null, 2)}
          </pre>
          <div className="text-xs text-muted">
            {s.telemetry.last_sent_at
              ? t('licensing.telemetry.lastSent', {
                  date: new Date(s.telemetry.last_sent_at).toLocaleString(getLocale()),
                })
              : t('licensing.telemetry.neverSent')}
          </div>
          {s.update_check_forced_off ? <Notice tone="info">{t('licensing.updateCheck.forcedOff')}</Notice> : null}
        </div>
      ) : null}
    </Card>
  );
};

const ServerUrl = ({
  s,
  busy,
  onSave,
}: {
  s: LicensingSettings;
  busy: boolean;
  onSave: (v: string | null) => void;
}) => {
  const [value, setValue] = useState(s.server_url_setting ?? '');
  const trimmed = value.trim();
  const valid = !trimmed || /^https?:\/\/[^\s/]+/i.test(trimmed);
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave(trimmed || null);
      }}
    >
      <Field
        label={t('licensing.settings.server')}
        hint={
          s.server_url_source === 'env'
            ? t('licensing.settings.serverFromEnv', { url: s.server_url })
            : s.server_url
              ? undefined
              : t('licensing.settings.serverNone')
        }
      >
        <Input
          dir="ltr"
          value={value}
          placeholder="https://…"
          onChange={(e) => setValue(e.target.value)}
          data-testid="licensing-server-url"
        />
      </Field>
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        busy={busy}
        disabled={!valid}
        data-testid="licensing-server-save"
      >
        {t('licensing.settings.save')}
      </Button>
    </form>
  );
};

/**
 * The provider's key: keys the license server issues are trusted here only with its public key. It is fetched when
 * the address is saved; when the server could not be reached, the key is pasted by hand (PEM).
 */
const ProviderKey = ({ s, busy, onSave }: { s: LicensingSettings; busy: boolean; onSave: (pem: string) => void }) => {
  const [pem, setPem] = useState('');
  const trimmed = pem.trim();
  if (s.server_key_fingerprint)
    return (
      <div className="text-sm" data-testid="licensing-provider-key" data-fingerprint={s.server_key_fingerprint}>
        <span className="text-muted">{t('licensing.settings.providerKey')}</span>{' '}
        <code dir="ltr" className="font-mono text-xs text-fg">
          {s.server_key_fingerprint}
        </code>
      </div>
    );
  return (
    <form
      className="space-y-2"
      data-testid="licensing-provider-key-missing"
      onSubmit={(e) => {
        e.preventDefault();
        if (trimmed) onSave(trimmed);
      }}
    >
      <Notice tone="warn">{t('licensing.settings.providerKeyMissing')}</Notice>
      <Field label={t('licensing.settings.pasteKey')} hint={t('licensing.settings.pasteKeyHint')}>
        <textarea
          dir="ltr"
          rows={4}
          value={pem}
          placeholder="-----BEGIN PUBLIC KEY-----"
          onChange={(e) => setPem(e.target.value)}
          className="w-full rounded-[10px] border border-line-strong bg-surface px-3 py-2 text-start font-mono text-xs text-fg"
          data-testid="licensing-provider-key-input"
        />
      </Field>
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        busy={busy}
        disabled={!trimmed}
        data-testid="licensing-provider-key-save"
      >
        {t('licensing.settings.save')}
      </Button>
    </form>
  );
};
