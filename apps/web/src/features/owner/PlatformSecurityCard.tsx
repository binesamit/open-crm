// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type PlatformSettingsResponse, t } from '@bines/shared';
import { Badge, Card, Notice, Switch } from '@bines/ui';
import { api, errorMessage, fetchMe, queryKeys } from '../../lib/api';
import { showToast } from '../../lib/toast';

/**
 * Owner console → Platform settings → Security (S-77, optional, off by default, recommended): "two-factor sign-in for
 * the owner console". On: the platform owner and support staff open the console only with 2FA on. The server refuses
 * to turn it on for someone without 2FA (never locks out the person saving it); the switch says so up front.
 */
export const ConsoleTwoFactorSetting = ({
  on,
  myTwoFactor,
  busy,
  onChange,
}: {
  on: boolean;
  /** Whether the person looking has two-factor sign-in on. */
  myTwoFactor: boolean;
  busy: boolean;
  onChange: (on: boolean) => void;
}) => (
  <div data-testid="owner-console-security" className="space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <h3 className="text-sm font-semibold text-fg">{t('owner.security.title')}</h3>
      {!on ? (
        <span data-testid="owner-console-2fa-recommended">
          <Badge tone="info">{t('owner.security.recommended')}</Badge>
        </span>
      ) : null}
    </div>
    <p className="text-xs text-muted">{t('owner.security.hint')}</p>
    <label className="flex items-center gap-2 text-sm">
      <Switch
        checked={on}
        disabled={busy || (!on && !myTwoFactor)}
        onChange={onChange}
        label={t('owner.security.consoleTwoFactor')}
        testId="owner-console-2fa"
      />
      {t('owner.security.consoleTwoFactor')}
    </label>
    {!on && !myTwoFactor ? (
      <Notice tone="warn">
        <span data-testid="owner-console-2fa-needs-yours">{t('owner.security.needsYours')}</span>
      </Notice>
    ) : null}
  </div>
);

export const PlatformSecurityCard = ({ data }: { data: PlatformSettingsResponse }) => {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe });
  const save = useMutation({
    mutationFn: (on: boolean) =>
      api().patch<PlatformSettingsResponse>('/platform/settings', { security: { console_two_factor: on } }),
    onSuccess: (res) => {
      qc.setQueryData(['platform', 'settings'], res);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  return (
    <Card className="space-y-2">
      <ConsoleTwoFactorSetting
        on={data.settings.security?.console_two_factor ?? false}
        myTwoFactor={!!me.data?.user.two_factor?.enabled}
        busy={save.isPending}
        onChange={(on) => save.mutate(on)}
      />
    </Card>
  );
};
