// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { t, type ExtensionManifest, type ExtensionPreview, type MyAccount } from '@bines/shared';
import { Button, Dialog, Field, Input, Notice, Picker, Segmented, Switch } from '@bines/ui';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { downloadPost } from '../../lib/download';
import { showToast } from '../../lib/toast';
import { BoardPickerDialog } from '../board/BoardPickerDialog';
import { ConsentDialog, fromPreview } from './ConsentDialog';
import { previewExtension } from './extensions-api';

const keyOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

/** The other accounts where I am an admin (round 13: "copy to another account" installs the pack there). */
const useOtherAdminAccounts = (accountId: string) => {
  const q = useQuery({
    queryKey: queryKeys.myAccounts,
    queryFn: () => api().get<{ data: MyAccount[] }>('/me/accounts'),
  });
  return (q.data?.data ?? []).filter((a) => a.id !== accountId && a.role === 'admin' && a.status === 'active');
};

/**
 * "Save as pack" (D27 ת1): boards (as templates, without items) + a starter kit that makes them, and their
 * automations as recipes. Round 13: either downloaded as a manifest file (another account imports it from
 * "למפתחים → paste"), or copied straight to another account I administer — through that account's normal install
 * path: the preview and the consent screen of THAT account, confirmed by me as its admin (the server checks the
 * role there again); nothing is written in the other account before that confirmation.
 */
export const ExportPackDialog = ({ accountId, onClose }: { accountId: string; onClose: () => void }) => {
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [boards, setBoards] = useState<{ id: string; name: string }[]>([]);
  const [withAutomations, setWithAutomations] = useState(true);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dest, setDest] = useState<'file' | 'account'>('file');
  const others = useOtherAdminAccounts(accountId);
  const [targetId, setTargetId] = useState('');
  const target = others.find((a) => a.id === targetId) ?? null;
  const [consent, setConsent] = useState<{
    manifest: ExtensionManifest;
    preview: ExtensionPreview;
    target: MyAccount;
  } | null>(null);
  const finalKey = key || keyOf(name);
  const valid =
    /^[a-z][a-z0-9-]{1,47}$/.test(finalKey) && !!name.trim() && boards.length > 0 && (dest === 'file' || !!target);
  const body = () => ({
    key: finalKey,
    name: name.trim(),
    board_ids: boards.map((b) => b.id),
    include_automations: withAutomations,
  });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (dest === 'file') {
        await downloadPost(accountId, '/extensions/packs/export', body(), `${finalKey}.json`);
        onClose();
        return;
      }
      // Copy: the pack from this account, then the other account's own preview → its consent screen.
      const manifest = await api(accountId).post<ExtensionManifest>('/extensions/packs/export', body());
      const preview = await previewExtension(target!.id, { manifest: manifest as unknown as Record<string, unknown> });
      if (preview.existing) {
        setError(t('r13.copy.exists', { account: target!.name, version: preview.existing.version }));
        return;
      }
      setConsent({ manifest, preview, target: target! });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (consent)
    return (
      <ConsentDialog
        accountId={consent.target.id}
        subject={fromPreview(consent.preview)}
        note={t('r13.copy.note', { account: consent.target.name })}
        confirmLabel={t('r13.copy.confirm', { account: consent.target.name })}
        onClose={onClose}
        onConfirm={async (c) => {
          // EXT-RT3: exactly the manifest shown; installed by the target account's own install route.
          await api(consent.target.id).post('/extensions/install', {
            source: { manifest: consent.manifest },
            consent: c,
            manifest_digest: consent.preview.digest,
          });
          showToast({ message: t('r13.copy.done', { name: consent.manifest.name, account: consent.target.name }) });
          onClose();
        }}
      />
    );

  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title={t('ext.export.title')}
        subtitle={t('ext.export.subtitle')}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="accent"
              busy={busy}
              disabled={!valid}
              onClick={() => void save()}
              data-testid="ext-export-save"
            >
              {dest === 'file' ? t('ext.export.save') : t('r13.copy.next')}
            </Button>
          </div>
        }
      >
        <div className="space-y-3" data-testid="ext-export">
          <Field label={t('ext.export.name')}>
            <Input value={name} onChange={(e) => setName(e.target.value)} data-testid="ext-export-name" />
          </Field>
          <Field label={t('ext.export.key')} hint={t('ext.export.keyHint')}>
            <Input dir="ltr" value={finalKey} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <div className="flex flex-wrap items-center gap-1.5">
            {boards.map((b) => (
              <button
                type="button"
                key={b.id}
                className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 px-2.5 text-xs"
                title={t('ext.consent.removeBoard')}
                onClick={() => setBoards((prev) => prev.filter((x) => x.id !== b.id))}
              >
                {b.name} ×
              </button>
            ))}
            <Button size="sm" variant="dashed" onClick={() => setPicking(true)} data-testid="ext-export-add-board">
              {t('ext.consent.addBoard')}
            </Button>
          </div>
          <label className="flex items-center gap-3">
            <span className="min-w-0 flex-1 text-sm">{t('ext.export.automations')}</span>
            <Switch checked={withAutomations} onChange={setWithAutomations} />
          </label>
          <Field label={t('r13.copy.dest')}>
            <Segmented
              label={t('r13.copy.dest')}
              value={dest}
              onChange={setDest}
              className="flex w-full [&>button]:flex-1"
              options={[
                { value: 'file', label: t('r13.copy.file'), testId: 'ext-export-dest-file' },
                { value: 'account', label: t('r13.copy.account'), testId: 'ext-export-dest-account' },
              ]}
            />
          </Field>
          {dest === 'account' ? (
            others.length ? (
              <Field label={t('r13.copy.target')} hint={t('r13.copy.targetHint')}>
                <Picker
                  label={t('r13.copy.target')}
                  value={targetId}
                  placeholder={t('r13.copy.pick')}
                  onChange={setTargetId}
                  testId="ext-export-target"
                  options={others.map((a) => ({ value: a.id, label: a.name, testId: `ext-export-target-${a.slug}` }))}
                />
              </Field>
            ) : (
              <div data-testid="ext-export-no-accounts">
                <Notice tone="info">{t('r13.copy.noAccounts')}</Notice>
              </div>
            )
          ) : null}
          {error ? (
            <div data-testid="ext-export-error">
              <Notice tone="error">{error}</Notice>
            </div>
          ) : null}
        </div>
      </Dialog>
      {picking ? (
        <BoardPickerDialog
          accountId={accountId}
          title={t('ext.consent.addBoard')}
          confirmLabel={t('ext.consent.addBoard')}
          exclude={boards.map((b) => b.id)}
          onClose={() => setPicking(false)}
          onPick={async (b) => setBoards((prev) => [...prev, { id: b.id, name: b.name }])}
        />
      ) : null}
    </>
  );
};
