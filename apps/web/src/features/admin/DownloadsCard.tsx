// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { downloadSettingsSchema, type DownloadSettings, type MyAccount, t } from '@bines/shared';
import { Button, Card, Field, Input, Switch } from '@bines/ui';
import { showToast } from '../../lib/toast';
import { reasonMessage } from '../account/CopyLink';
import { useAccountDetail, useUpdateAccount } from './account-settings';
import { h2 } from './admin-parts';

const DEFAULTS = downloadSettingsSchema.parse({});
const WHOLE = /^\d{1,4}$/;

/**
 * Administration → General → downloading several files: whether "download all" on a files cell or
 * an update offers one ZIP, and its limits. An empty field = the built-in limit.
 */
export const DownloadsCard = ({ account }: { account: MyAccount }) => {
  const saved = useAccountDetail(account).data?.settings.downloads;
  if (!saved) return null;
  return <Form account={account} saved={saved} />;
};

const Form = ({ account, saved }: { account: MyAccount; saved: DownloadSettings }) => {
  const update = useUpdateAccount(account);
  const [enabled, setEnabled] = useState(saved.zip_enabled);
  const [files, setFiles] = useState(String(saved.zip_max_files));
  const [mb, setMb] = useState(String(saved.zip_max_mb));
  const num = (v: string, fallback: number) => (v.trim() ? Number(v.trim()) : fallback);
  const next: DownloadSettings = {
    zip_enabled: enabled,
    zip_max_files: num(files, DEFAULTS.zip_max_files),
    zip_max_mb: num(mb, DEFAULTS.zip_max_mb),
  };
  const ok =
    [files, mb].every((v) => !v.trim() || WHOLE.test(v.trim())) && downloadSettingsSchema.safeParse(next).success;
  const dirty =
    next.zip_enabled !== saved.zip_enabled ||
    next.zip_max_files !== saved.zip_max_files ||
    next.zip_max_mb !== saved.zip_max_mb;
  const save = () =>
    update.mutate(
      { settings: { downloads: next } },
      {
        onSuccess: () => showToast({ message: t('admin.general.saved') }),
        onError: (err) => showToast({ message: reasonMessage(err), tone: 'error' }),
      },
    );
  return (
    <section data-testid="admin-downloads">
      <Card className="flex flex-col gap-3">
        <div className="space-y-0.5">
          <h2 className={h2}>{t('admin.downloads.title')}</h2>
          <p className="text-xs text-muted">{t('admin.downloads.hint')}</p>
        </div>
        <label className="flex items-center gap-2.5 text-sm text-fg">
          <Switch checked={enabled} onChange={setEnabled} testId="admin-downloads-enabled" />
          {t('admin.downloads.enabled')}
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('admin.downloads.maxFiles')} hint={t('admin.downloads.maxFilesHint')}>
            <Input
              value={files}
              maxLength={4}
              inputMode="numeric"
              dir="ltr"
              className="text-start"
              placeholder={String(DEFAULTS.zip_max_files)}
              disabled={!enabled}
              onChange={(e) => setFiles(e.target.value)}
              data-testid="admin-downloads-max-files"
            />
          </Field>
          <Field label={t('admin.downloads.maxMb')} hint={t('admin.downloads.maxMbHint')}>
            <Input
              value={mb}
              maxLength={4}
              inputMode="numeric"
              dir="ltr"
              className="text-start"
              placeholder={String(DEFAULTS.zip_max_mb)}
              disabled={!enabled}
              onChange={(e) => setMb(e.target.value)}
              data-testid="admin-downloads-max-mb"
            />
          </Field>
        </div>
        <div className="flex justify-end">
          <Button
            variant="accent"
            size="sm"
            disabled={!ok || !dirty}
            busy={update.isPending}
            onClick={save}
            data-testid="admin-downloads-save"
          >
            {t('common.save')}
          </Button>
        </div>
      </Card>
    </section>
  );
};
