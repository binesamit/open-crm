// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { docToHtml, formatDateTime, t } from '@bines/shared';
import { Badge, Button, cn, Dialog, Notice, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDialog, promptDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { useDocVersion, useDocVersionMutations, useDocVersions } from './doc-api';


/**
 * Version history (M8 ד3): automatic versions (after editing) and named ones, newest first; a click previews one
 * (rendered by the shared allowlist renderer); "restore" makes its content the doc's for everyone — as a new
 * version, the history stays. Whoever edits may save a named version and restore.
 */
export const DocVersions = ({
  accountId,
  docId,
  canEdit,
  onClose,
}: {
  accountId: string;
  docId: string;
  canEdit: boolean;
  onClose: () => void;
}) => {
  const versions = useDocVersions(accountId, docId);
  const [selected, setSelected] = useState<string | null>(null);
  const list = versions.data?.data ?? [];
  const current = selected ?? list[0]?.id ?? null;
  const preview = useDocVersion(accountId, docId, current);
  const mut = useDocVersionMutations(accountId, docId);
  const error = mut.save.error ?? mut.restore.error;

  const save = async () => {
    const label = await promptDialog({
      title: t('docs2.versions.save'),
      label: t('docs2.versions.name'),
      confirmLabel: t('common.save'),
    });
    if (label) mut.save.mutate(label, { onSuccess: (v) => setSelected(v.id) });
  };
  const restore = async () => {
    if (!current) return;
    const ok = await confirmDialog({
      title: t('docs2.versions.restore'),
      message: t('docs2.versions.restoreConfirm'),
      confirmLabel: t('docs2.versions.restore'),
    });
    if (!ok) return;
    mut.restore.mutate(current, {
      onSuccess: (v) => {
        setSelected(v.id);
        showToast({ message: t('docs2.versions.restored') });
      },
    });
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('docs2.versions')}
      className="max-w-4xl!"
      footer={
        <>
          {canEdit ? (
            <Button variant="secondary" onClick={() => void save()} busy={mut.save.isPending} data-testid="doc-version-save">
              {t('docs2.versions.save')}
            </Button>
          ) : null}
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          {canEdit ? (
            <Button
              onClick={() => void restore()}
              // The latest version too: the doc usually changed after it (automatic ones come when editing ends).
              disabled={!current}
              busy={mut.restore.isPending}
              data-testid="doc-version-restore"
            >
              {t('docs2.versions.restore')}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-[240px_minmax(0,1fr)]" data-testid="doc-versions">
        <div className="max-h-[60vh] overflow-y-auto md:border-e md:border-line-soft md:pe-2">
          {versions.isPending ? (
            <SkeletonRows rows={4} label={t('app.loading')} />
          ) : !list.length ? (
            <p className="py-6 text-center text-sm text-muted" data-testid="doc-versions-empty">
              {t('docs2.versions.none')}
            </p>
          ) : (
            <ul className="space-y-0.5" role="listbox" aria-label={t('docs2.versions')}>
              {list.map((v, i) => (
                <li key={v.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={v.id === current}
                    data-testid="doc-version"
                    data-label={v.label ?? ''}
                    data-auto={v.auto ? 'true' : 'false'}
                    onClick={() => setSelected(v.id)}
                    className={cn(
                      'flex w-full flex-col items-start gap-0.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-start',
                      v.id === current ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2',
                    )}
                  >
                    <span className="flex w-full items-center gap-1.5">
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                        {v.label ?? t('docs2.versions.auto')}
                      </span>
                      {i === 0 ? <Badge tone="ok">{t('docs2.versions.latest')}</Badge> : null}
                    </span>
                    <span className="text-xs text-muted">
                      {formatDateTime(v.created_at)}
                      {v.created_by ? ` · ${v.created_by.name}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="max-h-[60vh] min-h-[200px] overflow-y-auto rounded-[var(--radius)] border border-line-soft bg-surface-3 px-4 py-3">
          {error ? (
            <div className="mb-2">
              <Notice tone="error">{errorMessage(error)}</Notice>
            </div>
          ) : null}
          {preview.data ? (
            <div
              className="rich-content text-[0.875rem]"
              data-testid="doc-version-preview"
              // The shared allowlist renderer (docs/export.ts) — never HTML from the browser.
              dangerouslySetInnerHTML={{ __html: docToHtml(preview.data.content) || `<p>${t('docs2.versions.empty')}</p>` }}
            />
          ) : current ? (
            <SkeletonRows rows={5} label={t('app.loading')} />
          ) : null}
        </div>
      </div>
    </Dialog>
  );
};
