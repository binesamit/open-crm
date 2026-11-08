// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FLOW_PLATFORMS, type FlowPlatform, type PlatformSettingsResponse, t } from '@bines/shared';
import { Card, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';

/**
 * Owner console → which external automation platforms accounts may connect ("זרימות"). A platform
 * switched off here disappears from every account's "new connection"; existing connections keep working.
 */
export const FlowPlatformsCard = ({ data }: { data: PlatformSettingsResponse }) => {
  const qc = useQueryClient();
  const on = data.settings.flows?.platforms ?? [...FLOW_PLATFORMS];
  const save = useMutation({
    mutationFn: (platforms: FlowPlatform[]) =>
      api().patch<PlatformSettingsResponse>('/platform/settings', { flows: { platforms } }),
    onSuccess: (res) => {
      qc.setQueryData(['platform', 'settings'], res);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  return (
    <Card className="space-y-2">
      <div data-testid="owner-flow-platforms" className="space-y-2">
        <h3 className="text-sm font-semibold text-fg">{t('flows.owner.title')}</h3>
        <p className="text-xs text-muted">{t('flows.owner.hint')}</p>
        <div className="flex flex-wrap gap-4">
          {FLOW_PLATFORMS.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm">
              <Switch
                checked={on.includes(p)}
                disabled={save.isPending}
                onChange={(v) => save.mutate(v ? [...on, p] : on.filter((x) => x !== p))}
                testId={`owner-flow-platform-${p}`}
              />
              {t(`flows.platform.${p}`)}
            </label>
          ))}
        </div>
      </div>
    </Card>
  );
};
