// SPDX-License-Identifier: AGPL-3.0-only
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { t, type PlanOffer, type SignupResult } from '@bines/shared';
import { Badge, cn } from '@bines/ui';
import { api } from '../../lib/api';
import { Icon, type IconName } from '../../lib/icons';
import { AuthShell } from '../auth/AuthShell';

/** The sign-up status screens (canvas Verify / Complete): the icon tile, "under review", "closed", "preparing". */

const TILE = {
  warn: 'bg-accent-soft text-accent-fg',
  info: 'bg-info-soft text-info-fg',
  neutral: 'bg-surface-2 text-fg-2',
} as const;

/** A 64px rounded tile with a 30px line icon (the canvas status screens). */
export const StatusIcon = ({ name, tone }: { name: IconName; tone: keyof typeof TILE }) => (
  <span aria-hidden className={cn('grid size-16 place-items-center rounded-[20px]', TILE[tone])}>
    <Icon name={name} size={30} />
  </span>
);

/** A quiet box of short lines (the canvas `#f7faf9` panel): tips, the request's details. */
export const InfoLines = ({ lines, testId }: { lines: ReactNode[]; testId?: string }) => (
  <div
    className="flex w-full flex-col gap-2 rounded-[12px] bg-surface-3 p-3 text-start text-[0.78125rem] text-muted"
    data-testid={testId}
  >
    {lines.map((l, i) => (
      <span key={i}>{l}</span>
    ))}
  </div>
);

const smallLink = 'text-xs text-heading underline-offset-2 hover:underline';

/** Screen 5: sign-up is off (or not available now) — join by invitation, or sign in; the owner's contact link. */
export const SignupClosed = () => {
  // The owner's "contact us" (billing settings → closed screen); none = no link.
  const offer = useQuery({
    queryKey: ['public', 'plans'],
    queryFn: () => api().get<PlanOffer>('/plans/public'),
    retry: false,
    staleTime: 5 * 60_000,
  });
  const contact = offer.data?.contact_url ?? offer.data?.upgrade.url ?? null;
  return (
    <AuthShell
      title={t('signup.closed.title')}
      icon={<StatusIcon name="lock" tone="neutral" />}
      centered
      testId="signup-closed"
    >
      <p className="text-[0.875rem] leading-relaxed text-fg-2">{t('signup.closed.body')}</p>
      <Link
        to="/login"
        className="flex h-11 w-full items-center justify-center rounded-[var(--radius)] bg-accent text-sm text-on-accent hover:brightness-105"
        data-testid="signup-closed-login"
      >
        {t('auth.signIn')}
      </Link>
      {contact ? (
        <a href={contact} target="_blank" rel="noopener" className={smallLink} data-testid="signup-closed-contact">
          {t('signup.closed.contact')}
        </a>
      ) : null}
    </AuthShell>
  );
};

/** Screen 4: the email is verified and the request waits for the platform owner's approval. */
export const SignupPending = ({ request }: { request?: SignupResult['request'] }) => (
  <AuthShell
    title={t('signup.pending.title')}
    icon={<StatusIcon name="clock" tone="info" />}
    centered
    testId="signup-pending"
  >
    <p className="text-[0.875rem] leading-relaxed text-fg-2">{t('signup.pending.body')}</p>
    {request ? (
      <InfoLines
        testId="signup-pending-details"
        lines={[
          t('signup.pending.org', { org: request.org_name }),
          ...(request.plan_name
            ? [
                request.trial_days
                  ? t('signup.pending.planTrial', { plan: request.plan_name, n: request.trial_days })
                  : t('signup.pending.plan', { plan: request.plan_name }),
              ]
            : []),
        ]}
      />
    ) : null}
    <Link to="/login" className={smallLink}>
      {t('signup.pending.home')}
    </Link>
  </AuthShell>
);

type StepState = 'done' | 'active' | 'todo';

const StepMark = ({ state }: { state: StepState }) =>
  state === 'done' ? (
    <span aria-hidden className="grid size-[22px] shrink-0 place-items-center rounded-full bg-ok text-white">
      <Icon name="check" size={12} strokeWidth={3} />
    </span>
  ) : state === 'active' ? (
    <span
      aria-hidden
      className="size-[22px] shrink-0 animate-spin rounded-full border-[2.5px] border-line border-t-accent motion-reduce:animate-none"
    />
  ) : (
    <span aria-hidden className="size-[22px] shrink-0 rounded-full border-[1.5px] border-line-strong" />
  );

/**
 * Screen 3: "preparing your account" — the steps the server runs in one call, shown one after another while it works
 * (`progress` = how many are done), all done once it answered.
 */
export const SignupPreparing = ({
  progress,
  orgName,
  trialDays,
  sampleBoards,
}: {
  progress: number;
  orgName?: string;
  trialDays?: number;
  sampleBoards?: boolean;
}) => {
  const steps = [
    orgName ? t('signup.preparing.accountNamed', { org: orgName }) : t('signup.preparing.account'),
    t('signup.preparing.admin'),
    ...(sampleBoards === false ? [] : [t('signup.preparing.boards')]),
    trialDays ? t('signup.preparing.trial', { n: trialDays }) : t('signup.preparing.ready'),
  ];
  const done = Math.min(progress, steps.length);
  return (
    <AuthShell
      title={t('signup.preparing.title')}
      eyebrow={<Badge tone="ok">{t('signup.preparing.verified')}</Badge>}
      testId="signup-preparing"
    >
      <ol className="flex flex-col gap-3 text-[0.84375rem]" aria-live="polite">
        {steps.map((label, i) => {
          const state: StepState = i < done ? 'done' : i === done ? 'active' : 'todo';
          return (
            <li
              key={i}
              data-state={state}
              className={cn('flex items-center gap-2.5', state === 'todo' ? 'text-muted' : 'text-fg')}
            >
              <StepMark state={state} />
              {label}
            </li>
          );
        })}
      </ol>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" aria-hidden>
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-500"
          style={{ width: `${Math.round(((done + (done < steps.length ? 0.5 : 0)) / steps.length) * 100)}%` }}
        />
      </div>
      <p className="text-xs text-muted">{t('signup.preparing.note')}</p>
    </AuthShell>
  );
};

/** A sign-up link that no longer works (used, expired, unknown) — start again, or sign in. */
export const SignupProblem = ({ message, testId }: { message: string; testId: string }) => (
  <AuthShell
    title={t('signup.problem.title')}
    icon={<StatusIcon name="mail" tone="neutral" />}
    centered
    testId={testId}
  >
    <p className="text-[0.875rem] leading-relaxed text-fg-2" data-testid={`${testId}-message`}>
      {message}
    </p>
    <Link
      to="/signup"
      className="flex h-11 w-full items-center justify-center rounded-[var(--radius)] bg-accent text-sm text-on-accent hover:brightness-105"
    >
      {t('signup.problem.again')}
    </Link>
    <Link to="/login" className={smallLink}>
      {t('signup.haveAccount')}
    </Link>
  </AuthShell>
);
