// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { t } from '@bines/shared';
import { Badge, Button, Notice, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDialog, promptDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { usePlatformExtensionMutations, usePlatformExtensions } from './extensions-api';
import { CatalogEntryLine, CatalogPublishDialog } from './OwnerCatalogPublish';

/**
 * Owner console → תוספות (D27): every extension in the catalog or installed anywhere, how many accounts use it, and
 * the emergency kill switch — switched off in every account at once (tokens, frames, CORS), with a reason that the
 * accounts' audit logs record.
 */
export const OwnerExtensions = () => {
  const list = usePlatformExtensions();
  const m = usePlatformExtensionMutations();
  const rows = list.data?.data ?? [];
  const [publishing, setPublishing] = useState(false);
  const kill = async (key: string, name: string) => {
    const reason = await promptDialog({
      title: t('ext.owner.killTitle', { name }),
      label: t('ext.owner.reason'),
    });
    if (!reason) return;
    try {
      await m.kill.mutateAsync({ key, reason });
      showToast({ message: t('ext.owner.killed', { name }) });
    } catch (err) {
      showToast({ message: errorMessage(err) });
    }
  };
  const unkill = async (key: string, name: string) => {
    if (!(await confirmDialog({ title: t('ext.owner.unkillTitle', { name }), confirmLabel: t('ext.owner.unkill') })))
      return;
    await m.unkill.mutateAsync(key);
  };
  return (
    <section className="flex flex-col gap-2.5" data-testid="owner-extensions">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-display text-base font-bold text-heading">{t('ext.owner.title')}</h2>
        {/* ת7: publish for every account, with the §8 security review. */}
        <Button size="sm" variant="secondary" onClick={() => setPublishing(true)} data-testid="owner-catalog-publish">
          {t('ext.catalog.publishTitle')}
        </Button>
      </div>
      <p className="max-w-[640px] text-sm text-muted">{t('ext.owner.subtitle')}</p>
      {publishing ? <CatalogPublishDialog onClose={() => setPublishing(false)} /> : null}
      {list.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      {rows.length ? (
        <ul className="overflow-hidden rounded-[12px] border border-line bg-surface">
          {rows.map((e) => (
            <li
              key={e.key}
              className="flex flex-wrap items-center gap-3 border-b border-line-soft px-3.5 py-2.5 last:border-b-0"
              data-testid={`owner-ext-${e.key}`}
            >
              <span className="min-w-0 flex-1 basis-48">
                <span className="font-semibold text-fg">{e.name}</span>{' '}
                <span className="text-xs text-muted" dir="ltr">
                  {e.key}
                </span>
              </span>
              <Badge tone={e.kind === 'code' ? 'violet' : 'info'}>{t(`ext.kind.${e.kind}`)}</Badge>
              {e.catalog ? <Badge>{t('ext.owner.catalog')}</Badge> : null}
              <span className="text-xs text-muted">{t('ext.owner.installs', { n: e.installs })}</span>
              {e.killed ? (
                <>
                  <Badge tone="danger">{t('ext.admin.killed')}</Badge>
                  <Button size="sm" variant="secondary" onClick={() => void unkill(e.key, e.name)}>
                    {t('ext.owner.unkill')}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="danger-outline"
                  onClick={() => void kill(e.key, e.name)}
                  data-testid={`owner-ext-kill-${e.key}`}
                >
                  {t('ext.owner.kill')}
                </Button>
              )}
              {e.catalog ? <CatalogEntryLine ext={e} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};
