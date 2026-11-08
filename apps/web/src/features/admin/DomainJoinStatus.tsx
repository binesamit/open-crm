// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type DomainJoinResponse, t } from '@bines/shared';
import { Badge, Button, Notice } from '@bines/ui';
import { api } from '../../lib/api';
import { copyText } from '../../lib/entity-menu';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { reasonMessage } from '../account/CopyLink';
import { CopyLinkField } from '../account/CopyLink';

const key = (accountId: string, domains: string[]) => ['account', accountId, 'admin', 'domain-join', domains] as const;

/**
 * Domain join (plan ה7) under the account's domains (admin → security): each domain's verification — a ✓, or a
 * "verify" button with the DNS TXT record to add (verified at once when the admin's own address is at the domain) —
 * and, with "auto join" on, the page to share and whether the platform's sign-up is open at all.
 */
export const DomainJoinStatus = ({
  accountId,
  domains,
  autoJoin,
}: {
  accountId: string;
  domains: string[];
  autoJoin: boolean;
}) => {
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: key(accountId, domains),
    queryFn: () => api(accountId).get<DomainJoinResponse>('/security/domain-join'),
    enabled: domains.length > 0,
  });
  const [open, setOpen] = useState<string | null>(null);
  const verify = useMutation({
    mutationFn: (domain: string) =>
      api(accountId).post<DomainJoinResponse>(`/security/domain-join/domains/${encodeURIComponent(domain)}/verify`),
    onSuccess: (data, domain) => {
      qc.setQueryData(key(accountId, domains), data);
      setOpen(null);
      showToast({ message: t('domainJoin.verified', { domain }) });
    },
    onError: (err) => showToast({ message: reasonMessage(err), tone: 'error' }),
  });
  if (!domains.length || !status.data) return null;
  const d = status.data;
  const anyVerified = d.domains.some((x) => x.verified);
  return (
    <div className="flex flex-col gap-2" data-testid="domain-join">
      <ul className="flex flex-col gap-1.5">
        {d.domains.map((x) => (
          <li key={x.domain} className="flex flex-col gap-1.5" data-testid="domain-join-row" data-domain={x.domain}>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span dir="ltr" className="font-mono text-fg">
                {x.domain}
              </span>
              {x.verified ? (
                <span data-testid="domain-join-verified">
                  <Badge tone="ok">
                    <Icon name="check" size={12} />
                    {t('domainJoin.verifiedBadge')}
                  </Badge>
                </span>
              ) : x.free_mail ? (
                <span className="text-xs text-muted" data-testid="domain-join-free">
                  {t('domainJoin.freeMail')}
                </span>
              ) : (
                <>
                  <Badge tone="warn">{t('domainJoin.notVerified')}</Badge>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOpen(open === x.domain ? null : x.domain)}
                    data-testid="domain-join-open"
                  >
                    {t('domainJoin.verify')}
                  </Button>
                </>
              )}
            </div>
            {open === x.domain ? (
              <div
                className="flex flex-col gap-2 rounded-[10px] border border-line bg-surface-2 p-3 text-xs"
                data-testid="domain-join-panel"
              >
                <p className="text-fg-2">{t('domainJoin.howEmail')}</p>
                <p className="text-fg-2">{t('domainJoin.howDns')}</p>
                <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-2 gap-y-1" dir="ltr">
                  <span className="text-muted">Type</span>
                  <code>TXT</code>
                  <span />
                  <span className="text-muted">Name</span>
                  <code>{x.record.name}</code>
                  <span />
                  <span className="text-muted">Value</span>
                  <code className="break-all" data-testid="domain-join-record">
                    {x.record.value}
                  </code>
                  <button
                    type="button"
                    className="grid size-6 place-items-center rounded hover:bg-surface"
                    aria-label={t('link.copy')}
                    onClick={() => copyText(x.record.value)}
                  >
                    <Icon name="copy" size={14} />
                  </button>
                </div>
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    busy={verify.isPending}
                    onClick={() => verify.mutate(x.domain)}
                    data-testid="domain-join-check"
                  >
                    {t('domainJoin.check')}
                  </Button>
                </div>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {autoJoin ? (
        !d.available ? (
          <Notice>{t('domainJoin.unavailable')}</Notice>
        ) : !anyVerified ? (
          <Notice>{t('domainJoin.noneVerified')}</Notice>
        ) : (
          <div className="flex flex-col gap-1">
            <p className="text-xs text-muted">{t('domainJoin.share')}</p>
            <CopyLinkField url={d.join_url} testId="domain-join-link" />
          </div>
        )
      ) : null}
    </div>
  );
};
