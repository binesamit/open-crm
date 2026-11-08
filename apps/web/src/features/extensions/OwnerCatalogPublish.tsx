// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  REVIEW_CHECKS,
  t,
  type CatalogSource,
  type PlatformExtension,
  type ReviewCheck,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, Dialog, Field, Input, Notice, Segmented, Switch } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { type CatalogPreview, previewCatalog, useCatalogMutations } from './extensions-server-api';

/**
 * Owner console → תוספות → "פרסום בקטלוג" (D27 ת7, MARKETPLACE §4.6 + §8): an extension by URL or pasted manifest is
 * checked, then published for every account of this platform with the security review — a code extension only
 * when every check is ticked. Accounts still install it themselves, through the consent screen.
 */
export const CatalogPublishDialog = ({ onClose }: { onClose: () => void }) => {
  const m = useCatalogMutations();
  const [mode, setMode] = useState<'url' | 'json'>('url');
  const [url, setUrl] = useState('');
  const [json, setJson] = useState('');
  const [preview, setPreview] = useState<{ source: CatalogSource; p: CatalogPreview } | null>(null);
  const [checks, setChecks] = useState<Partial<Record<ReviewCheck, boolean>>>({});
  const [notes, setNotes] = useState('');
  const [privacy, setPrivacy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setError(null);
    let source: CatalogSource;
    if (mode === 'url') source = { manifest_url: url.trim() };
    else {
      try {
        source = { manifest: JSON.parse(json) as Record<string, unknown> };
      } catch {
        setError(t('ext.admin.notJson'));
        return;
      }
    }
    setBusy(true);
    try {
      setPreview({ source, p: await previewCatalog(source) });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const complete = REVIEW_CHECKS.every((k) => checks[k]);
  const canPublish = !!preview && (!preview.p.review_required || complete);

  const publish = async () => {
    if (!preview) return;
    setError(null);
    try {
      await m.publish.mutateAsync({
        source: preview.source,
        review: { checks, notes: notes.trim(), ...(privacy.trim() ? { privacy_url: privacy.trim() } : {}) },
      });
      showToast({ message: t('ext.catalog.published', { name: preview.p.manifest.name }) });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('ext.catalog.publishTitle')}
      subtitle={t('ext.catalog.publishSubtitle')}
      className="max-w-[720px]"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {preview ? (
            <Button
              variant="accent"
              busy={m.publish.isPending}
              disabled={!canPublish}
              onClick={() => void publish()}
              data-testid="catalog-publish"
            >
              {t('ext.catalog.publish')}
            </Button>
          ) : (
            <Button
              busy={busy}
              disabled={mode === 'url' ? !url.trim() : !json.trim()}
              onClick={() => void check()}
              data-testid="catalog-check"
            >
              {t('ext.admin.check')}
            </Button>
          )}
        </div>
      }
    >
      <div className="space-y-3" data-testid="catalog-dialog">
        {!preview ? (
          <>
            <Segmented
              label={t('ext.admin.add')}
              value={mode}
              onChange={setMode}
              options={[
                { value: 'url', label: t('ext.admin.byUrl'), testId: 'catalog-mode-url' },
                { value: 'json', label: t('ext.admin.byJson'), testId: 'catalog-mode-json' },
              ]}
            />
            {mode === 'url' ? (
              <Input
                dir="ltr"
                value={url}
                placeholder="https://…/manifest.json"
                onChange={(e) => setUrl(e.target.value)}
                data-testid="catalog-url"
              />
            ) : (
              <textarea
                dir="ltr"
                rows={8}
                value={json}
                onChange={(e) => setJson(e.target.value)}
                className="w-full rounded-[10px] border border-line-strong bg-surface p-2.5 font-mono text-xs text-fg focus:border-primary focus:outline-none"
              />
            )}
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-fg">{preview.p.manifest.name}</span>
              <span dir="ltr" className="text-xs text-muted">
                {preview.p.manifest.id} v{preview.p.manifest.version}
              </span>
              <Badge tone={preview.p.kind === 'code' ? 'violet' : 'info'}>{t(`ext.kind.${preview.p.kind}`)}</Badge>
              {preview.p.existing ? (
                <Badge tone="warn">{t('ext.catalog.replaces', { version: preview.p.existing.version })}</Badge>
              ) : null}
            </div>
            {preview.p.warnings.length ? (
              <ul className="space-y-1 text-xs text-muted">
                {preview.p.warnings.map((w) => (
                  <li key={w}>• {tDynamic(`ext.warning.${w}`)}</li>
                ))}
              </ul>
            ) : null}
            <fieldset className="space-y-1.5 rounded-[10px] border border-line-soft p-3" data-testid="catalog-review">
              <legend className="px-1 text-sm font-semibold text-fg">{t('ext.catalog.review')}</legend>
              <p className="text-xs text-muted">
                {preview.p.review_required ? t('ext.catalog.reviewRequired') : t('ext.catalog.reviewOptional')}
              </p>
              {REVIEW_CHECKS.map((k) => (
                <label key={k} className="flex items-start gap-2 text-sm">
                  <Switch
                    className="mt-0.5"
                    checked={!!checks[k]}
                    onChange={(on) => setChecks((c) => ({ ...c, [k]: on }))}
                    testId={`catalog-check-${k}`}
                  />
                  <span>{t(`ext.review.${k}`)}</span>
                </label>
              ))}
            </fieldset>
            <Field label={t('ext.catalog.notes')}>
              <textarea
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full rounded-[10px] border border-line-strong bg-surface p-2.5 text-sm text-fg focus:border-primary focus:outline-none"
                data-testid="catalog-notes"
              />
            </Field>
            <Field label={t('ext.catalog.privacyUrl')}>
              <Input dir="ltr" value={privacy} onChange={(e) => setPrivacy(e.target.value)} />
            </Field>
          </>
        )}
        {error ? <Notice tone="error">{error}</Notice> : null}
      </div>
    </Dialog>
  );
};

/** One catalog entry's publishing details + "remove from the catalog" (the owner console's extension row). */
export const CatalogEntryLine = ({ ext }: { ext: PlatformExtension }) => {
  const m = useCatalogMutations();
  if (!ext.entry) return null;
  const review = ext.entry.review;
  const ticked = review ? Object.values(review.checks).filter(Boolean).length : 0;
  const unpublish = async () => {
    if (
      !(await confirmDialog({
        title: t('ext.catalog.unpublishTitle', { name: ext.name }),
        message: t('ext.catalog.unpublishBody'),
        confirmLabel: t('ext.catalog.unpublish'),
        danger: true,
      }))
    )
      return;
    try {
      await m.unpublish.mutateAsync(ext.key);
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  return (
    <div
      className="flex w-full flex-wrap items-center gap-2 text-xs text-muted"
      data-testid={`owner-ext-entry-${ext.key}`}
    >
      <span dir="ltr">v{ext.entry.version}</span>
      {review ? (
        <Badge tone={ticked === REVIEW_CHECKS.length ? 'ok' : 'warn'}>
          {t('ext.catalog.reviewed', { n: ticked, total: REVIEW_CHECKS.length })}
        </Badge>
      ) : (
        <Badge>{t('ext.catalog.seeded')}</Badge>
      )}
      {review?.reviewed_by_name ? (
        <span>
          {t('ext.catalog.by', {
            name: review.reviewed_by_name,
            at: new Date(review.reviewed_at).toLocaleDateString(),
          })}
        </span>
      ) : null}
      {review?.notes ? (
        <span className="max-w-[360px] truncate" title={review.notes}>
          {review.notes}
        </span>
      ) : null}
      <Button size="sm" variant="ghost" onClick={() => void unpublish()} data-testid={`owner-ext-unpublish-${ext.key}`}>
        {t('ext.catalog.unpublish')}
      </Button>
    </div>
  );
};
