// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_N8N_PACKAGE,
  makeInvitationUrlSchema,
  npmPackageNameSchema,
  type PlatformSettingsResponse,
  t,
  type UpdatePlatformSettings,
} from '@bines/shared';
import { Button, Card, Field, Input } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';

/**
 * Owner console → Platform settings → n8n and Make: the n8n community-node package people install
 * and the Make app's invitation link. Every account sees them with the install steps (API tokens) and so does the
 * public API guide. Empty package = the built-in name; empty link = accounts are told to ask their administrator.
 */
export const IntegrationsCard = ({ data }: { data: PlatformSettingsResponse }) => {
  const qc = useQueryClient();
  const saved = data.settings.integrations ?? {};
  const [pkg, setPkg] = useState(saved.n8n_package ?? '');
  const [link, setLink] = useState(saved.make_invitation_url ?? '');
  const save = useMutation({
    mutationFn: (integrations: NonNullable<UpdatePlatformSettings['integrations']>) =>
      api().patch<PlatformSettingsResponse>('/platform/settings', { integrations }),
    onSuccess: (res) => {
      qc.setQueryData(['platform', 'settings'], res);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const pkgOk = !pkg.trim() || npmPackageNameSchema.safeParse(pkg).success;
  const linkOk = !link.trim() || makeInvitationUrlSchema.safeParse(link.trim()).success;
  return (
    <Card className="space-y-3" data-testid="owner-integrations">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-fg">{t('integrations.owner.title')}</h3>
        <p className="text-xs text-muted">{t('integrations.owner.hint')}</p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (pkgOk && linkOk)
            save.mutate({ n8n_package: pkg.trim() || null, make_invitation_url: link.trim() || null });
        }}
      >
        <Field label={t('integrations.owner.n8n')}>
          <Input
            value={pkg}
            maxLength={214}
            dir="ltr"
            placeholder={data.fallbacks.n8n_package ?? DEFAULT_N8N_PACKAGE}
            aria-invalid={!pkgOk || undefined}
            onChange={(e) => setPkg(e.target.value)}
            data-testid="owner-integrations-n8n"
          />
        </Field>
        <Field label={t('integrations.owner.make')} hint={t('integrations.owner.makeHint')}>
          <Input
            value={link}
            maxLength={500}
            dir="ltr"
            type="url"
            placeholder="https://"
            aria-invalid={!linkOk || undefined}
            onChange={(e) => setLink(e.target.value)}
            data-testid="owner-integrations-make"
          />
        </Field>
        <Button
          type="submit"
          size="sm"
          busy={save.isPending}
          disabled={!pkgOk || !linkOk}
          data-testid="owner-integrations-save"
        >
          {t('common.save')}
        </Button>
      </form>
    </Card>
  );
};
