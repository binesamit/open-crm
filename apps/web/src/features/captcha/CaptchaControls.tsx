// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { type CaptchaMode, t } from '@bines/shared';
import { Button, Field, Input, Segmented, Switch } from '@bines/ui';
import { Icon } from '../../lib/icons';

/**
 * Cloudflare Turnstile controls shared by the account (Administration → Security), the owner console and a form's
 * settings: a mode picker (inherit / on / off — "on" only with keys, and the reason shown), the
 * keys (the secret write-only) and a settings body with the master switch and the list of public places.
 */

export const CaptchaModePicker = ({
  value,
  onChange,
  keysReady,
  inherited,
  inheritFrom,
  testId,
  disabled,
}: {
  value: CaptchaMode;
  onChange: (mode: CaptchaMode) => void;
  /** Keys are there (own or inherited): "on" can be picked. */
  keysReady: boolean;
  /** What `inherit` means right now. */
  inherited: boolean;
  /** Where `inherit` comes from ("the account" / "the master switch"). */
  inheritFrom: string;
  testId: string;
  disabled?: boolean;
}) => {
  const effective = value === 'on' ? true : value === 'off' ? false : inherited;
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <Segmented<CaptchaMode>
        label={t('captcha.mode.label')}
        value={value}
        onChange={(m) => !disabled && onChange(m)}
        options={[
          { value: 'inherit', label: t('captcha.mode.inherit'), testId: `${testId}-inherit`, disabled },
          {
            value: 'on',
            label: t('captcha.mode.on'),
            testId: `${testId}-on`,
            disabled: disabled || (!keysReady && value !== 'on'),
          },
          { value: 'off', label: t('captcha.mode.off'), testId: `${testId}-off`, disabled },
        ]}
      />
      <p className="text-xs text-muted" data-testid={`${testId}-state`}>
        {value === 'inherit' ? `${t('captcha.mode.inheritFrom', { from: inheritFrom })} · ` : ''}
        {effective && keysReady
          ? t('captcha.state.on')
          : effective
            ? t('captcha.state.noKeys')
            : t('captcha.state.off')}
      </p>
      {!keysReady && value !== 'on' ? (
        <p className="text-xs text-muted" data-testid={`${testId}-why`}>
          {t('captcha.mode.onNeedsKeys')}
        </p>
      ) : null}
    </div>
  );
};

/** The site key (saved on blur / Enter) and the write-only secret. */
export const CaptchaKeys = ({
  siteKey,
  secretSet,
  onSiteKey,
  onSecret,
  busy,
  removeLocked,
  testId,
}: {
  siteKey: string;
  secretSet: boolean;
  onSiteKey: (value: string) => void;
  onSecret: (secret: string | null) => void;
  busy: boolean;
  /** Something is on with these keys: switch it off before removing the secret. */
  removeLocked?: boolean;
  testId: string;
}) => {
  const [site, setSite] = useState(siteKey);
  const [secret, setSecret] = useState('');
  // A saved site key comes back from the server: show it, but keep a secret typed meanwhile (remounting the
  // fields on every save wiped a secret typed while the site key was still saving).
  const [savedSite, setSavedSite] = useState(siteKey);
  if (savedSite !== siteKey) {
    setSavedSite(siteKey);
    setSite(siteKey);
  }
  const commitSite = () => site.trim() !== siteKey && onSiteKey(site.trim());
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid={testId}>
      <Field label={t('captcha.siteKey')}>
        <Input
          value={site}
          dir="ltr"
          maxLength={100}
          autoComplete="off"
          onChange={(e) => setSite(e.target.value)}
          onBlur={commitSite}
          onKeyDown={(e) => e.key === 'Enter' && commitSite()}
          data-testid={`${testId}-site`}
        />
      </Field>
      <Field label={t('captcha.secret')} hint={secretSet ? t('captcha.secretSaved') : t('captcha.secretHint')}>
        <div className="flex gap-1.5">
          <Input
            type="password"
            value={secret}
            dir="ltr"
            maxLength={200}
            autoComplete="off"
            placeholder={secretSet ? '••••••••' : ''}
            onChange={(e) => setSecret(e.target.value)}
            data-testid={`${testId}-secret`}
          />
          <Button
            size="sm"
            variant="secondary"
            busy={busy}
            disabled={!secret.trim()}
            onClick={() => {
              onSecret(secret.trim());
              setSecret('');
            }}
            data-testid={`${testId}-secret-save`}
          >
            {t('captcha.saveSecret')}
          </Button>
          {secretSet ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={removeLocked}
              onClick={() => onSecret(null)}
              aria-label={t('captcha.removeSecret')}
              data-tip={removeLocked ? t('captcha.removeLocked') : t('captcha.removeSecret')}
              data-testid={`${testId}-secret-remove`}
            >
              <Icon name="x" size={14} />
            </Button>
          ) : null}
        </div>
      </Field>
    </div>
  );
};

type Config = {
  enabled: boolean;
  site_key: string;
  secret_set: boolean;
  keys_ready: boolean;
  surfaces: Record<string, CaptchaMode>;
};
export type CaptchaPatch = {
  enabled?: boolean;
  site_key?: string;
  secret?: string | null;
  surfaces?: Record<string, CaptchaMode>;
};

/** Master switch, keys and the public places of one level (account or platform). */
export const CaptchaSettingsBody = ({
  data,
  surfaces,
  onSave,
  busy,
  testId,
}: {
  data: Config;
  surfaces: { key: string; label: string; hint?: string }[];
  onSave: (patch: CaptchaPatch) => void;
  busy: boolean;
  testId: string;
}) => {
  const anyOn = data.enabled || Object.values(data.surfaces).includes('on');
  return (
    <div className="space-y-4 p-3.5">
      <CaptchaKeys
        siteKey={data.site_key}
        secretSet={data.secret_set}
        onSiteKey={(site_key) => onSave({ site_key })}
        onSecret={(secret) => onSave({ secret })}
        busy={busy}
        removeLocked={anyOn}
        testId={`${testId}-keys`}
      />
      <div className="flex items-start gap-3 border-t border-line-soft pt-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="text-sm font-semibold text-fg">{t('captcha.master')}</div>
          <p className="text-xs text-muted" data-testid={`${testId}-master-hint`}>
            {data.keys_ready ? t('captcha.masterHint') : t('captcha.mode.onNeedsKeys')}
          </p>
        </div>
        <Switch
          checked={data.enabled}
          disabled={busy || (!data.keys_ready && !data.enabled)}
          onChange={(enabled) => onSave({ enabled })}
          label={t('captcha.master')}
          testId={`${testId}-master`}
        />
      </div>
      <div className="space-y-3 border-t border-line-soft pt-3">
        <div className="text-sm font-semibold text-fg">{t('captcha.places')}</div>
        {surfaces.map((s) => (
          <div key={s.key} className="flex flex-wrap items-start gap-3" data-testid={`${testId}-place-${s.key}`}>
            <div className="min-w-0 flex-1 basis-48 space-y-0.5">
              <div className="text-sm text-fg">{s.label}</div>
              {s.hint ? <p className="text-xs text-muted">{s.hint}</p> : null}
            </div>
            <CaptchaModePicker
              value={data.surfaces[s.key] ?? 'inherit'}
              onChange={(mode) => onSave({ surfaces: { [s.key]: mode } })}
              keysReady={data.keys_ready}
              inherited={data.enabled}
              inheritFrom={t('captcha.from.master')}
              disabled={busy}
              testId={`${testId}-mode-${s.key}`}
            />
          </div>
        ))}
      </div>
      <p className="text-xs text-muted">{t('captcha.alwaysOn')}</p>
    </div>
  );
};
