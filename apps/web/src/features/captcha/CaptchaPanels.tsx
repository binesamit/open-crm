// SPDX-License-Identifier: AGPL-3.0-only
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_CAPTCHA_SURFACES,
  type AccountCaptcha,
  PLATFORM_CAPTCHA_SURFACES,
  type PlatformCaptcha,
  t,
} from '@bines/shared';
import { Card, Notice, SkeletonRows } from '@bines/ui';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { reasonMessage } from '../account/CopyLink';
import { Panel } from '../admin/admin-parts';
import { type CaptchaPatch, CaptchaSettingsBody } from './CaptchaControls';

export const captchaKeys = {
  account: (accountId: string) => ['account', accountId, 'admin', 'captcha'] as const,
  platform: ['platform', 'captcha'] as const,
};

const saved = () => showToast({ message: t('admin.general.saved') });
const failed = (err: unknown) => showToast({ message: reasonMessage(err), tone: 'error' });

/** Administration → Security → Cloudflare Turnstile: the account's keys, master switch and public places. */
export const AccountCaptchaPanel = ({ accountId }: { accountId: string }) => {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: captchaKeys.account(accountId),
    queryFn: () => api(accountId).get<AccountCaptcha>('/security/captcha'),
  });
  const save = useMutation({
    mutationFn: (patch: CaptchaPatch) => api(accountId).patch<AccountCaptcha>('/security/captcha', patch),
    onSuccess: (data) => {
      qc.setQueryData(captchaKeys.account(accountId), data);
      // Forms show what `inherit` means for them.
      void qc.invalidateQueries({ queryKey: ['account', accountId, 'form'] });
      saved();
    },
    onError: failed,
  });
  return (
    <Panel title={t('captcha.account.title')} hint={t('captcha.account.hint')} testId="security-captcha">
      {q.isError ? <Notice tone="error">{errorMessage(q.error)}</Notice> : null}
      {q.data ? (
        <CaptchaSettingsBody
          data={q.data}
          surfaces={ACCOUNT_CAPTCHA_SURFACES.map((key) => ({
            key,
            label: t(`captcha.surface.${key}`),
            hint: t(`captcha.surface.${key}.hint`),
          }))}
          onSave={(patch) => save.mutate(patch)}
          busy={save.isPending}
          testId="account-captcha"
        />
      ) : q.isPending ? (
        <SkeletonRows rows={2} label={t('app.loading')} />
      ) : null}
    </Panel>
  );
};

/** Owner console → Platform settings → Turnstile on the sign-in screens (no account yet). */
export const PlatformCaptchaCard = () => {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: captchaKeys.platform,
    queryFn: () => api().get<PlatformCaptcha>('/platform/captcha'),
  });
  const save = useMutation({
    mutationFn: (patch: CaptchaPatch) => api().patch<PlatformCaptcha>('/platform/captcha', patch),
    onSuccess: (data) => {
      qc.setQueryData(captchaKeys.platform, data);
      void qc.invalidateQueries({ queryKey: queryKeys.authConfig });
      saved();
    },
    onError: failed,
  });
  return (
    <Card className="p-0" data-testid="owner-captcha">
      <div className="space-y-0.5 border-b border-line-soft px-3.5 pt-3.5 pb-3">
        <h3 className="text-sm font-semibold text-fg">{t('captcha.platform.title')}</h3>
        <p className="text-xs text-muted">{t('captcha.platform.hint')}</p>
      </div>
      {q.isError ? <Notice tone="error">{errorMessage(q.error)}</Notice> : null}
      {q.data ? (
        <CaptchaSettingsBody
          data={q.data}
          surfaces={PLATFORM_CAPTCHA_SURFACES.map((key) => ({ key, label: t(`captcha.surface.${key}`) }))}
          onSave={(patch) => save.mutate(patch)}
          busy={save.isPending}
          testId="platform-captcha"
        />
      ) : q.isPending ? (
        <SkeletonRows rows={2} label={t('app.loading')} />
      ) : null}
    </Card>
  );
};
