// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { AUTOCOMPLETE_MODES, t, type MyAccount, msgKey } from '@bines/shared';
import { Button, Card, Field, Input, Notice, Segmented } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { Icon } from '../../lib/icons';
import { useGeoConfig, useSaveGeoSettings } from './map-api';
import { h2 } from '../admin/admin-parts';

/**
 * Administration → Connections → Maps (M8 ד10, D25): the map style (free OpenFreeMap by default; any MapLibre style
 * URL — MapTiler, Protomaps…), the origins it loads from (they join the page's CSP), geocoding on / off, and an
 * optional Google Maps key (address completion + geocoding; write-only, only its last characters are shown).
 */

export const MapSettingsCard = ({ account }: { account: MyAccount }) => {
  const cfg = useGeoConfig(account.id).data;
  const save = useSaveGeoSettings(account.id);
  const [style, setStyle] = useState<string | null>(null);
  const [origins, setOrigins] = useState<string | null>(null);
  const [key, setKey] = useState('');
  if (!cfg) return null;
  const styleValue = style ?? cfg.settings.style_url ?? '';
  const originsValue = origins ?? cfg.settings.extra_origins.join('\n');
  const submit = (body: Parameters<typeof save.mutate>[0]) =>
    save.mutate(body, {
      onSuccess: () => {
        setStyle(null);
        setOrigins(null);
        setKey('');
        showToast({ message: t('maps.saved') });
      },
    });
  return (
    <Card>
      <div className="space-y-3.5" data-testid="admin-maps">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="grid size-9 shrink-0 place-items-center rounded-[11px] bg-surface-2 text-heading"
          >
            <Icon name="map" size={18} />
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <h2 className={h2}>{t('maps.title')}</h2>
            <p className="text-sm text-muted">{t('maps.body')}</p>
          </div>
        </div>
        <Field label={t('maps.style')} hint={t('maps.styleHint')}>
          <Input
            dir="ltr"
            value={styleValue}
            placeholder={cfg.style_url}
            data-testid="maps-style"
            onChange={(e) => setStyle(e.target.value)}
          />
        </Field>
        <Field label={t('maps.origins')} hint={t('maps.originsHint')}>
          <textarea
            dir="ltr"
            value={originsValue}
            data-testid="maps-origins"
            onChange={(e) => setOrigins(e.target.value)}
            className="h-16 w-full resize-y rounded-[10px] border border-line-strong bg-surface p-2.5 text-sm focus:border-primary focus:outline-none"
          />
        </Field>
        <Field label={t('maps.geocoding')}>
          <Segmented
            label={t('maps.geocoding')}
            value={cfg.settings.geocoder}
            testId="maps-geocoder"
            onChange={(geocoder) => submit({ geocoder })}
            options={[
              { value: 'auto', label: t('maps.geocoder.auto') },
              { value: 'off', label: t('maps.geocoder.off') },
            ]}
          />
        </Field>
        <Field label={t('maps.autocomplete')} hint={t('maps.autocompleteHint')}>
          <Segmented
            label={t('maps.autocomplete')}
            value={cfg.settings.autocomplete}
            testId="maps-autocomplete"
            onChange={(autocomplete) => submit({ autocomplete })}
            options={AUTOCOMPLETE_MODES.map((m) => ({
              value: m,
              label: t(msgKey(`maps.autocomplete.${m}`)),
              testId: `maps-autocomplete-${m}`,
            }))}
          />
        </Field>
        <Field label={t('maps.googleKey')} hint={t('maps.googleKeyHint')}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              dir="ltr"
              type="password"
              autoComplete="off"
              value={key}
              placeholder={cfg.google_key_hint ?? ''}
              data-testid="maps-google-key"
              onChange={(e) => setKey(e.target.value)}
              className="min-w-0 flex-1"
            />
            {cfg.google_key_hint ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => submit({ google_key: null })}
                data-testid="maps-key-remove"
              >
                {t('maps.removeKey')}
              </Button>
            ) : null}
          </div>
        </Field>
        {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
        <Button
          busy={save.isPending}
          data-testid="maps-save"
          onClick={() =>
            submit({
              style_url: styleValue.trim() || null,
              extra_origins: originsValue
                .split(/[\s,]+/)
                .map((o) => o.trim())
                .filter(Boolean),
              ...(key.trim() ? { google_key: key.trim() } : {}),
            })
          }
        >
          {t('common.save')}
        </Button>
      </div>
    </Card>
  );
};
