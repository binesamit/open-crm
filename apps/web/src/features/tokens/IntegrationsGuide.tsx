// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { t, type IntegrationsGuide as Guide } from '@bines/shared';
import { Button, Card, Notice } from '@bines/ui';
import { api, errorMessage, type MyAccount } from '../../lib/api';
import { copyText } from '../../lib/entity-menu';
import { Icon } from '../../lib/icons';

const linkClass =
  'press inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-2.5 text-[0.8125rem] whitespace-nowrap text-heading hover:bg-surface-2';

/** A value people paste elsewhere (an address, a package name), with a copy button. */
const CopyValue = ({ value, label, testId }: { value: string; label: string; testId: string }) => (
  <span className="flex min-w-0 items-center gap-2">
    <code
      className="block max-w-full min-w-0 overflow-x-auto rounded-[8px] border border-line bg-surface px-2 py-1 text-start font-mono text-xs whitespace-nowrap text-fg-2"
      dir="ltr"
      data-testid={testId}
    >
      {value}
    </code>
    <Button
      variant="secondary"
      size="sm"
      onClick={() => copyText(value)}
      aria-label={`${t('integrations.copy')} — ${label}`}
      data-testid={`${testId}-copy`}
    >
      <Icon name="copy" size={14} />
      {t('integrations.copy')}
    </Button>
  </span>
);

const Steps = ({ children }: { children: ReactNode }) => (
  <ol className="list-decimal space-y-1 ps-5 text-sm text-fg-2">{children}</ol>
);

/**
 * "n8n and Make": how to connect the platform's own n8n community nodes and Make app — the steps
 * the n8n package and the Make invitation link from the owner's Platform settings (empty link = "ask your
 * administrator"), and the instance URL with a copy button. Lives next to the API tokens it needs.
 */
export const IntegrationsGuide = ({ account, onCreateToken }: { account: MyAccount; onCreateToken?: () => void }) => {
  const guide = useQuery({
    queryKey: ['account', account.id, 'integrations-guide'],
    queryFn: () => api(account.id).get<Guide>('/auth/integrations'),
    staleTime: 5 * 60_000,
  });
  if (guide.isError) return <Notice tone="error">{errorMessage(guide.error)}</Notice>;
  const g = guide.data;
  if (!g) return null;
  const product = g.product_name;
  const createToken = onCreateToken ? (
    <Button variant="secondary" size="sm" onClick={onCreateToken} data-testid="integrations-create-token">
      <Icon name="key" size={14} />
      {t('integrations.createToken')}
    </Button>
  ) : null;
  return (
    <Card className="space-y-4" data-testid="integrations-guide">
      <div className="space-y-1">
        <h2 className="font-display text-[1rem] leading-snug font-extrabold text-heading">{t('integrations.title')}</h2>
        <p className="max-w-[640px] text-sm text-muted">{t('integrations.intro', { product })}</p>
      </div>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-fg">{t('integrations.baseUrl')}</h3>
        <CopyValue value={g.base_url} label={t('integrations.baseUrl')} testId="integrations-base-url" />
        <p className="text-xs text-muted">{t('integrations.baseUrlHint')}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="space-y-2" data-testid="integrations-n8n">
          <h3 className="text-sm font-semibold text-fg">{t('integrations.n8n.title')}</h3>
          <Steps>
            <li>{t('integrations.n8n.step1')}</li>
            <li>
              {t('integrations.n8n.step2')}
              <div className="mt-1">
                <CopyValue
                  value={g.n8n_package}
                  label={t('integrations.n8n.package')}
                  testId="integrations-n8n-package"
                />
              </div>
            </li>
            <li>{t('integrations.n8n.step3', { product })}</li>
            <li>{t('integrations.n8n.step4')}</li>
          </Steps>
        </section>
        <section className="space-y-2" data-testid="integrations-make">
          <h3 className="text-sm font-semibold text-fg">{t('integrations.make.title')}</h3>
          {g.make_invitation_url ? (
            <>
              <Steps>
                <li>{t('integrations.make.step1', { product })}</li>
                <li>{t('integrations.make.step2', { product })}</li>
                <li>{t('integrations.make.step3')}</li>
              </Steps>
              <a
                className={linkClass}
                href={g.make_invitation_url}
                target="_blank"
                rel="noreferrer"
                data-testid="integrations-make-link"
              >
                {t('integrations.make.open')}
                <Icon name="ext" size={14} />
              </a>
            </>
          ) : (
            <div data-testid="integrations-make-no-link">
              <Notice tone="info">{t('integrations.make.noLink')}</Notice>
            </div>
          )}
        </section>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-[1_1_260px] text-xs text-muted">{t('integrations.tokenHint')}</p>
        {createToken}
      </div>
    </Card>
  );
};
