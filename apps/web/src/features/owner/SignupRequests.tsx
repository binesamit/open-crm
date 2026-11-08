// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { relativeTime, type SignupRequest, type SignupRequestStatus, formatDateTime, t } from '@bines/shared';
import {
  Avatar,
  Badge,
  Button,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  Segmented,
  SkeletonRows,
  Switch,
} from '@bines/ui';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { usePlans } from './Plans';
import { useSignupSettings } from './SignupSettings';

type Tab = 'pending_approval' | 'provisioned' | 'rejected' | 'expired';
const TABS: Tab[] = ['pending_approval', 'provisioned', 'rejected', 'expired'];
type Page = { data: SignupRequest[]; next: string | null };

export const signupRequestsKey = ['platform', 'signup-requests'] as const;
const listOf = (status?: SignupRequestStatus, limit = 50) =>
  api().get<Page>(
    `/platform/signup-requests?${new URLSearchParams({ ...(status ? { status } : {}), limit: String(limit) })}`,
  );

/** The requests waiting for the owner's approval (the panel's "waiting" line and the console nav's count). */
export const usePendingSignupRequests = (enabled = true) =>
  useQuery({
    queryKey: [...signupRequestsKey, 'pending_approval'],
    queryFn: () => listOf('pending_approval', 200),
    enabled,
  });

/**
 * Owner console → "בקשות הרשמה" (canvas OwnerQueue, screen 11): shown while manual approval is on, or once any
 * request exists. Tabs: waiting / approved / rejected / expired. Approve opens the account (and emails the person);
 * reject ends the request — with an optional reason in the email and "block this domain".
 */
export const SignupRequestsPanel = ({ always = false }: { always?: boolean }) => {
  const settings = useSignupSettings();
  const any = useQuery({ queryKey: [...signupRequestsKey, 'any'], queryFn: () => listOf(undefined, 1) });
  const pending = usePendingSignupRequests();
  const [tab, setTab] = useState<Tab>('pending_approval');
  const list = useQuery({ queryKey: [...signupRequestsKey, tab], queryFn: () => listOf(tab, 200) });
  const approval = !!settings.data?.settings.approval;
  // Its own console section shows it always, with the empty tab's line.
  if (!always && !approval && !any.data?.data.length) return null;
  const waiting = pending.data?.data.length ?? 0;
  const rows = list.data?.data ?? [];
  return (
    <section
      className="flex flex-col gap-3 rounded-[16px] border border-line bg-surface p-4"
      data-testid="signup-requests"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-[0.8125rem] text-fg">{t('signup.requests.title')}</h3>
            {waiting ? (
              <Badge tone="warn">
                <span data-testid="signup-requests-waiting">{t('signup.requests.waiting', { n: waiting })}</span>
              </Badge>
            ) : null}
          </div>
          <p className="mt-0.5 max-w-[640px] text-xs leading-normal text-muted">{t('signup.requests.hint')}</p>
        </div>
        <Segmented<Tab>
          label={t('signup.requests.title')}
          value={tab}
          onChange={setTab}
          testId="signup-requests-tabs"
          options={TABS.map((v) => ({
            value: v,
            label: t(`signup.requests.tab.${v}`),
            testId: `signup-requests-tab-${v}`,
          }))}
        />
      </div>
      {list.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      {list.data && !rows.length ? (
        <EmptyState className="py-6" title={t(`signup.requests.empty.${tab}`)} testId="signup-requests-empty" />
      ) : null}
      {rows.length ? (
        <ul className="overflow-hidden rounded-[12px] border border-line">
          {rows.map((r) => (
            <RequestRow key={r.id} request={r} />
          ))}
        </ul>
      ) : null}
    </section>
  );
};

const RequestRow = ({ request: r }: { request: SignupRequest }) => {
  const qc = useQueryClient();
  const plans = usePlans().data?.data ?? [];
  const plan = plans.find((p) => p.versions.some((v) => v.id === r.plan_version_id));
  const [now] = useState(() => Date.now());
  const [rejecting, setRejecting] = useState(false);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: signupRequestsKey });
    await qc.invalidateQueries({ queryKey: queryKeys.platformAccounts });
  };
  const approve = useMutation({
    mutationFn: () => api().post<SignupRequest>(`/platform/signup-requests/${r.id}/approve`),
    onSuccess: async () => {
      showToast({ message: t('signup.requests.approved', { org: r.org_name }) });
      await refresh();
    },
  });
  const when = r.verified_at ?? r.created_at;
  return (
    <li
      className="flex flex-wrap items-center gap-3 border-t border-line-soft bg-surface px-3 py-3.5 first:border-t-0"
      data-testid={`signup-request-${r.email}`}
    >
      <Avatar name={r.name || r.email} size={34} />
      <span className="flex min-w-[16rem] flex-col gap-0.5">
        <span className="text-[0.8125rem] text-fg">
          {r.org_name} · {r.name}
        </span>
        <span className="text-xs text-muted">
          <span dir="ltr" className="[unicode-bidi:isolate]">
            {r.email}
          </span>
          {r.verified_at ? ` · ${t('signup.requests.verified')}` : ''} ·{' '}
          <span title={formatDateTime(when)}>{relativeTime(when, now)}</span>
          {r.reason && r.status === 'rejected' ? ` · ${t('signup.requests.reason', { reason: r.reason })}` : ''}
        </span>
      </span>
      {plan ? <Badge>{plan.name}</Badge> : null}
      <Badge>{t(`signup.method.${r.method}`)}</Badge>
      {r.status === 'pending_approval' ? (
        <span className="ms-auto flex gap-2">
          <Button
            variant="danger-outline"
            size="sm"
            onClick={() => setRejecting(true)}
            data-testid="signup-request-reject"
          >
            {t('signup.requests.reject')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            className="font-normal"
            busy={approve.isPending}
            onClick={() => approve.mutate()}
            data-testid="signup-request-approve"
          >
            {t('signup.requests.approve')}
          </Button>
        </span>
      ) : null}
      {approve.isError ? (
        <div className="w-full">
          <Notice tone="error">{errorMessage(approve.error)}</Notice>
        </div>
      ) : null}
      {rejecting ? <RejectDialog request={r} onClose={() => setRejecting(false)} onDone={refresh} /> : null}
    </li>
  );
};

const RejectDialog = ({
  request: r,
  onClose,
  onDone,
}: {
  request: SignupRequest;
  onClose: () => void;
  onDone: () => Promise<void>;
}) => {
  const [reason, setReason] = useState('');
  const [block, setBlock] = useState(false);
  const domain = r.email.split('@')[1] ?? '';
  const reject = useMutation({
    mutationFn: () =>
      api().post(`/platform/signup-requests/${r.id}/reject`, {
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        block_domain: block,
      }),
    onSuccess: async () => {
      await onDone();
      onClose();
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('signup.requests.rejectTitle')}
      subtitle={`${r.org_name} · ${r.email}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            busy={reject.isPending}
            onClick={() => reject.mutate()}
            data-testid="signup-reject-confirm"
          >
            {t('signup.requests.reject')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 whitespace-normal" data-testid="signup-reject-dialog">
        <Field label={t('signup.requests.reasonLabel')} hint={t('signup.requests.reasonHint')}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} data-testid="signup-reject-reason" />
        </Field>
        {domain ? (
          <label className="flex items-center gap-2 text-[0.8125rem] text-fg">
            <Switch checked={block} onChange={setBlock} testId="signup-reject-block" />
            <span>
              {t('signup.requests.blockDomain')}{' '}
              <span dir="ltr" className="[unicode-bidi:isolate]">
                {domain}
              </span>
            </span>
          </label>
        ) : null}
        {reject.isError ? <Notice tone="error">{errorMessage(reject.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};
