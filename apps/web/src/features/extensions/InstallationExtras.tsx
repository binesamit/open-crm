// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { isLocalOrigin, t, type ExtensionInstallation } from '@bines/shared';
import { Badge, Button, Dialog, Notice, SkeletonRows, Switch } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { useExtensionServerMutations, useExtensionVersions } from './extensions-server-api';

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—');

/** Development origins (localhost) are allowed only outside production — say so plainly on the installation. */
export const isDevInstallation = (i: Pick<ExtensionInstallation, 'frame_origins' | 'server'>) =>
  i.frame_origins.some(isLocalOrigin) ||
  (!!i.server &&
    (() => {
      try {
        return isLocalOrigin(new URL(i.server!.lifecycle_url).origin);
      } catch {
        return false;
      }
    })());

/**
 * An installed extension's ת6 controls (Administration → תוספות): its own server (connected / failed, "reconnect" =
 * new credentials in a fresh signed `installed` call), automatic updates, a version lock, the version history with
 * "back to this version", and a development-mode badge.
 */
export const InstallationExtras = ({ accountId, inst: i }: { accountId: string; inst: ExtensionInstallation }) => {
  const m = useExtensionServerMutations(accountId);
  const [versions, setVersions] = useState(false);
  const busy = m.versioning.isPending || m.reconnect.isPending;
  const reconnect = async () => {
    if (
      !(await confirmDialog({
        title: t('ext.server.reconnectTitle', { name: i.name }),
        message: t('ext.server.reconnectBody'),
        confirmLabel: t('ext.server.reconnect'),
      }))
    )
      return;
    try {
      const r = await m.reconnect.mutateAsync(i.id);
      showToast({
        message: t(r.server?.status === 'connected' ? 'ext.server.reconnected' : 'ext.server.failedToast'),
      });
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  return (
    <div className="space-y-2 text-xs" data-testid={`ext-extras-${i.key}`}>
      {isDevInstallation(i) ? (
        <div data-testid={`ext-dev-${i.key}`}>
          <Notice tone="warn">{t('ext.dev.notice')}</Notice>
        </div>
      ) : null}
      {i.server ? (
        <div className="flex flex-wrap items-center gap-2" data-testid={`ext-server-${i.key}`}>
          <span className="text-muted">{t('ext.server.title')}</span>
          <Badge tone={i.server.status === 'connected' ? 'ok' : i.server.status === 'failed' ? 'danger' : 'warn'}>
            {t(`ext.server.status.${i.server.status}`)}
          </Badge>
          {i.server.last_event ? (
            <span className="text-muted">
              {t('ext.server.lastEvent', { event: i.server.last_event, at: when(i.server.last_event_at) })}
            </span>
          ) : null}
          {i.server.last_error ? <span className="text-danger-fg">{i.server.last_error}</span> : null}
          {i.status === 'enabled' && !i.killed ? (
            <Button size="sm" variant="ghost" busy={m.reconnect.isPending} onClick={() => void reconnect()}>
              {t('ext.server.reconnect')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {i.source !== 'manifest' ? (
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-1.5">
            <Switch
              checked={i.auto_update}
              disabled={busy}
              onChange={(on) => m.versioning.mutate({ id: i.id, auto_update: on })}
              testId={`ext-auto-update-${i.key}`}
            />
            <span className="text-muted">{t('ext.versions.auto')}</span>
          </label>
          <label className="inline-flex items-center gap-1.5">
            <Switch
              checked={i.version_locked}
              disabled={busy}
              onChange={(on) => m.versioning.mutate({ id: i.id, version_locked: on })}
              testId={`ext-locked-${i.key}`}
            />
            <span className="text-muted">{t('ext.versions.lock', { version: i.version })}</span>
          </label>
          <span className="text-muted">
            {i.check_error
              ? t('ext.versions.checkFailed', { error: i.check_error })
              : t('ext.versions.lastChecked', { at: when(i.last_checked_at) })}
          </span>
          <Button size="sm" variant="ghost" onClick={() => setVersions(true)} data-testid={`ext-versions-${i.key}`}>
            {t('ext.versions.history')}
          </Button>
        </div>
      ) : null}
      {versions ? <VersionsDialog accountId={accountId} inst={i} onClose={() => setVersions(false)} /> : null}
    </div>
  );
};

const VersionsDialog = ({
  accountId,
  inst: i,
  onClose,
}: {
  accountId: string;
  inst: ExtensionInstallation;
  onClose: () => void;
}) => {
  const list = useExtensionVersions(accountId, i.id);
  const m = useExtensionServerMutations(accountId);
  const rollback = async (versionId: string, version: string) => {
    if (
      !(await confirmDialog({
        title: t('ext.versions.rollbackTitle', { version }),
        message: t('ext.versions.rollbackBody'),
        confirmLabel: t('ext.versions.rollback'),
      }))
    )
      return;
    try {
      const r = await m.rollback.mutateAsync({ id: i.id, version_id: versionId });
      showToast({ message: t(`ext.versions.rolled.${r.status}`, { version }) });
      onClose();
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('ext.versions.title', { name: i.name })}
      subtitle={t('ext.versions.subtitle')}
      footer={
        <div className="flex w-full justify-end">
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      {list.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      <ul className="divide-y divide-line-soft" data-testid="ext-versions-list">
        {(list.data?.data ?? []).map((v) => (
          <li key={v.id} className="flex flex-wrap items-center gap-2.5 py-2" data-testid={`ext-version-${v.version}`}>
            <span dir="ltr" className="font-mono text-sm font-semibold text-fg">
              v{v.version}
            </span>
            <Badge tone={v.via === 'auto' ? 'info' : v.via === 'rollback' ? 'warn' : 'neutral'}>
              {t(`ext.versions.via.${v.via}`)}
            </Badge>
            {v.current ? <Badge tone="ok">{t('ext.versions.current')}</Badge> : null}
            <span className="min-w-0 flex-1 text-xs text-muted">
              {when(v.created_at)}
              {v.applied_by_name ? ` · ${v.applied_by_name}` : ''}
            </span>
            {!v.current && v.version !== i.version ? (
              <Button size="sm" variant="ghost" onClick={() => void rollback(v.id, v.version)}>
                {t('ext.versions.rollback')}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </Dialog>
  );
};
