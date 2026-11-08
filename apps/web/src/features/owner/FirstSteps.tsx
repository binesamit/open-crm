// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FirstStepKey, type FirstSteps, t } from '@bines/shared';
import { Button, cn, Notice } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { type ConsoleTarget, useConsoleJump } from './console-links';

export const firstStepsKey = ['platform', 'first-steps'] as const;

/** Where each step is done. */
const TARGET: Record<FirstStepKey, ConsoleTarget> = {
  email: 'email',
  legal: 'legal',
  plan: 'plans',
  signup: 'signup',
};

/**
 * Owner console → the top of the platform section: "first steps" (SIGNUP plan, decision 12) — outbound email,
 * published legal documents, a first public plan, self sign-up on and ready. Each step is read from the real
 * settings (GET /platform/first-steps), shows ✓ once done and links to where it is done. The card is gone when
 * every step is done, or once the owner closes it (stored on the server).
 */
export const FirstStepsCard = () => {
  const qc = useQueryClient();
  const jump = useConsoleJump();
  const steps = useQuery({
    queryKey: firstStepsKey,
    queryFn: () => api().get<FirstSteps>('/platform/first-steps'),
  });
  const dismiss = useMutation({
    mutationKey: firstStepsKey,
    mutationFn: () => api().post<FirstSteps>('/platform/first-steps/dismiss', {}),
    onSuccess: (res) => qc.setQueryData(firstStepsKey, res),
  });
  // Any setting saved anywhere in the console (a plan, a document, sign-up…) may tick a step.
  useEffect(
    () =>
      qc.getMutationCache().subscribe((e) => {
        if (e.type === 'updated' && e.action.type === 'success' && e.mutation.options.mutationKey !== firstStepsKey)
          void qc.invalidateQueries({ queryKey: firstStepsKey });
      }),
    [qc],
  );
  const data = steps.data;
  if (!data || data.dismissed || data.steps.every((s) => s.done)) return null;
  const done = data.steps.filter((s) => s.done).length;
  return (
    <section
      className="flex flex-col gap-3 rounded-[16px] border border-line bg-surface p-4"
      data-testid="first-steps"
      aria-labelledby="first-steps-title"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 id="first-steps-title" className="text-[0.8125rem] text-fg">
              {t('firstSteps.title')}
            </h2>
            <span className="text-xs text-muted" data-testid="first-steps-progress">
              {t('firstSteps.progress', { done, total: data.steps.length })}
            </span>
          </div>
          <p className="mt-0.5 max-w-[640px] text-xs leading-normal text-muted">{t('firstSteps.hint')}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          busy={dismiss.isPending}
          onClick={() => dismiss.mutate()}
          data-testid="first-steps-dismiss"
        >
          {t('firstSteps.dismiss')}
        </Button>
      </div>
      <ol className="grid grid-cols-2 gap-x-4 gap-y-1.5 max-md:grid-cols-1">
        {data.steps.map((s) => (
          <li
            key={s.key}
            data-testid={`first-step-${s.key}`}
            data-done={s.done}
            className={cn('flex items-center gap-2 text-[0.78125rem]', s.done ? 'text-ok-fg' : 'text-fg')}
          >
            <span
              className={cn(
                'grid size-[18px] shrink-0 place-items-center rounded-full',
                s.done ? 'bg-ok-soft' : 'border border-line-strong',
              )}
            >
              {s.done ? <Icon name="check" size={12} strokeWidth={3} /> : null}
            </span>
            <span className="min-w-0">{t(`firstSteps.step.${s.key}`)}</span>
            {s.done ? null : (
              <button
                type="button"
                onClick={() => jump(TARGET[s.key])}
                data-testid={`first-step-go-${s.key}`}
                className="text-primary underline-offset-2 hover:underline"
              >
                {t('firstSteps.go')}
              </button>
            )}
          </li>
        ))}
      </ol>
      {dismiss.isError ? <Notice tone="error">{errorMessage(dismiss.error)}</Notice> : null}
    </section>
  );
};
