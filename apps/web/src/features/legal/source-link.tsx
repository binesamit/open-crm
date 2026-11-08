// SPDX-License-Identifier: AGPL-3.0-only
import { SOURCE_LICENSE, t } from '@bines/shared';
import { Button, cn, Dialog } from '@bines/ui';
import { useBranding, useSourceInfo } from '../../lib/branding';

/**
 * AGPL section 13 (docs/LICENSING.md): a person using the software over a network can reach its source. The link
 * is the owner's `source_url` (their modified version, when they host one) or the project's repository; it shows
 * on every sign-in screen (`SourceLink`) and in the help menu's "About" (`AboutDialog`), with the version and build.
 */
export const SourceLink = ({ className }: { className?: string }) => {
  const source = useSourceInfo();
  if (!source) return null;
  return (
    <p className={cn('text-center text-xs text-shell-muted', className)} data-testid="auth-source">
      <a href={source.url} target="_blank" rel="noopener" className="underline underline-offset-2">
        {t('auth.source')}
      </a>{' '}
      <span dir="ltr">v{source.version}</span>
    </p>
  );
};

const Row = ({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) => (
  <div className="grid grid-cols-[120px_1fr] gap-3 text-sm" data-testid={testId}>
    <span className="text-muted">{label}</span>
    <span className="min-w-0 break-words">{children}</span>
  </div>
);

export const AboutDialog = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { productName } = useBranding();
  const source = useSourceInfo();
  if (!open) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('about.title')}
      subtitle={productName}
      footer={
        <Button variant="ghost" onClick={onClose} data-testid="about-close">
          {t('common.close')}
        </Button>
      }
    >
      <div className="space-y-3" data-testid="about-dialog">
        <Row label={t('about.version')} testId="about-version">
          <span dir="ltr">{source?.version ?? '—'}</span>
        </Row>
        {source?.commit ? (
          <Row label={t('about.commit')} testId="about-commit">
            <span dir="ltr" className="font-mono text-xs">
              {source.commit}
            </span>
          </Row>
        ) : null}
        <Row label={t('about.license')} testId="about-license">
          <span dir="ltr">{SOURCE_LICENSE}</span>
          <span className="mt-1 block text-xs text-muted">{t('about.licenseText')}</span>
        </Row>
        <Row label={t('about.source')} testId="about-source">
          {source ? (
            <a
              href={source.url}
              target="_blank"
              rel="noopener"
              dir="ltr"
              className="text-primary underline underline-offset-2"
            >
              {source.url}
            </a>
          ) : (
            '—'
          )}
          {source ? (
            <a
              href={`${source.url.replace(/\/+$/, '')}/blob/main/THIRD-PARTY-NOTICES.md`}
              target="_blank"
              rel="noopener"
              className="mt-1 block text-xs text-primary underline underline-offset-2"
              data-testid="about-notices"
            >
              {t('about.notices')}
            </a>
          ) : null}
        </Row>
        <p className="text-xs text-muted">{t('about.trademark')}</p>
      </div>
    </Dialog>
  );
};
