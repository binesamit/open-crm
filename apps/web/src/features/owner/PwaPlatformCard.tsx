// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_PWA_THEME, type PlatformSettingsResponse, t, type UpdatePlatformSettings } from '@bines/shared';
import { Button, Card, Field, Input, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * Owner console → the phone app (PWA): the name and colour of accounts with no branding of their own (and of the
 * sign-in page), and the two emergency switches — push for the whole platform, and the service worker's kill switch
 * (off = every installed copy removes itself on its next check and the app loads from the network).
 */
export const PwaPlatformCard = ({ data }: { data: PlatformSettingsResponse }) => {
  const qc = useQueryClient();
  const p = data.settings.pwa;
  const [name, setName] = useState(p.app_name ?? '');
  const [color, setColor] = useState(p.theme_color ?? '');
  const save = useMutation({
    mutationFn: (pwa: NonNullable<UpdatePlatformSettings['pwa']>) =>
      api().patch<PlatformSettingsResponse>('/platform/settings', { pwa }),
    onSuccess: (res) => {
      qc.setQueryData(['platform', 'settings'], res);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const colorOk = !color.trim() || HEX.test(color.trim());
  return (
    <Card className="space-y-3" data-testid="owner-pwa">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-fg">{t('pwa.owner.title')}</h3>
        <p className="text-xs text-muted">{t('pwa.owner.hint')}</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (colorOk) save.mutate({ app_name: name.trim() || null, theme_color: color.trim() || null });
        }}
      >
        <Field label={t('pwa.owner.name')}>
          <Input
            value={name}
            maxLength={30}
            placeholder={data.fallbacks.product_name}
            onChange={(e) => setName(e.target.value)}
            data-testid="owner-pwa-name"
          />
        </Field>
        <Field label={t('pwa.owner.color')}>
          <span className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-7 w-7 shrink-0 rounded-md border border-line"
              style={{ background: colorOk && color.trim() ? color.trim() : DEFAULT_PWA_THEME }}
            />
            <Input
              value={color}
              maxLength={7}
              dir="ltr"
              placeholder={DEFAULT_PWA_THEME}
              aria-invalid={!colorOk || undefined}
              onChange={(e) => setColor(e.target.value)}
              data-testid="owner-pwa-color"
            />
          </span>
        </Field>
        <Button type="submit" size="sm" busy={save.isPending} disabled={!colorOk} data-testid="owner-pwa-save">
          {t('common.save')}
        </Button>
      </form>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={p.push_enabled}
          disabled={save.isPending}
          onChange={(v) => save.mutate({ push_enabled: v })}
          label={t('pwa.owner.push')}
          testId="owner-pwa-push"
        />
        {t('pwa.owner.push')}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={p.sw_enabled}
          disabled={save.isPending}
          onChange={(v) => save.mutate({ sw_enabled: v })}
          label={t('pwa.owner.sw')}
          testId="owner-pwa-sw"
        />
        <span>
          {t('pwa.owner.sw')}
          <span className="block text-xs text-muted">{t('pwa.owner.swHint')}</span>
        </span>
      </label>
    </Card>
  );
};
