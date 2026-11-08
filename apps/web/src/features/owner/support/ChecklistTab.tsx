// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CHECKLIST_EVENTS, type ChecklistStep, type HelpConsoleConfig, t, tDynamic, type Tour } from '@bines/shared';
import { Button, Card, Field, Input, Notice, Picker, Segmented, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { confirmDialog } from '../../../lib/dialogs';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { helpConsoleKeys } from './help-console-api';

const stepsKey = ['platform', 'help', 'first-steps'] as const;
const newId = () => `s${Date.now().toString(36)}`;

/**
 * Owner console → Support → Knowledge → First steps: the self-ticking checklist people get in an
 * account — on / off, how long it opens by itself, and its steps: what each waits for, its words, its "show me"
 * tour and who sees it. Until saved, the built-in steps (in the reader's language) are in force.
 */
export const ChecklistTab = ({ config }: { config: HelpConsoleConfig }) => {
  const qc = useQueryClient();
  const s = config.settings.first_steps;
  const current = useQuery({
    queryKey: stepsKey,
    queryFn: () => api().get<{ custom: boolean; steps: ChecklistStep[] }>('/platform/support/help/first-steps'),
  });
  const tours = useQuery({
    queryKey: ['platform', 'help', 'tours'],
    queryFn: () => api().get<{ data: Tour[] }>('/platform/support/help/tours'),
  });
  const [enabled, setEnabled] = useState(s.enabled);
  const [days, setDays] = useState(String(s.auto_days));
  const [steps, setSteps] = useState<ChecklistStep[] | null>(null);
  const list = steps ?? current.data?.steps ?? [];
  const save = useMutation({
    mutationFn: (stepsToSave: ChecklistStep[] | null | undefined) =>
      api().patch('/platform/support/help/settings', {
        first_steps: {
          enabled,
          auto_days: Math.max(0, Math.min(365, Number(days) || 0)),
          ...(stepsToSave !== undefined ? { steps: stepsToSave } : {}),
        },
      }),
    onSuccess: async () => {
      setSteps(null);
      await qc.invalidateQueries({ queryKey: helpConsoleKeys.config });
      await qc.invalidateQueries({ queryKey: stepsKey });
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  if (current.isPending) return <SkeletonRows rows={5} label={t('app.loading')} />;
  if (current.isError) return <Notice tone="error">{errorMessage(current.error)}</Notice>;
  const readOnly = !config.may_configure;
  const edit = (i: number, patch: Partial<ChecklistStep>) =>
    setSteps(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setSteps(next);
  };
  const tourOptions = [
    { value: '', label: t('checklist.console.noTour') },
    ...(tours.data?.data ?? [])
      .filter((x, i, all) => all.findIndex((y) => y.slug === x.slug) === i)
      .map((x) => ({ value: x.slug, label: `${x.title} (${x.slug})` })),
  ];
  const valid = list.every((x) => x.title.trim());

  return (
    <div className="space-y-3" data-testid="checklist-console">
      <Card>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={enabled} onChange={setEnabled} disabled={readOnly} testId="checklist-enabled" />
            {t('checklist.console.enabled')}
          </label>
          <Field label={t('checklist.console.days')} hint={t('checklist.console.daysHint')}>
            <Input
              inputMode="numeric"
              dir="ltr"
              className="w-24 text-end"
              value={days}
              disabled={readOnly}
              onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
        </div>
        <p className="mt-2 text-xs text-muted">
          {current.data.custom ? t('checklist.console.custom') : t('checklist.console.builtin')}
        </p>
      </Card>
      <ol className="space-y-2" data-testid="checklist-steps">
        {list.map((step, i) => (
          <li
            key={step.id}
            className="rounded-[12px] border border-line bg-surface p-3"
            data-testid={`checklist-step-${step.id}`}
          >
            <div className="grid gap-2 md:grid-cols-2">
              <Field label={t('checklist.console.stepTitle')}>
                <Input
                  value={step.title}
                  maxLength={80}
                  disabled={readOnly}
                  onChange={(e) => edit(i, { title: e.target.value })}
                />
              </Field>
              <Field label={t('checklist.console.stepDescription')}>
                <Input
                  value={step.description}
                  maxLength={200}
                  disabled={readOnly}
                  onChange={(e) => edit(i, { description: e.target.value })}
                />
              </Field>
              <Field label={t('checklist.console.event')}>
                <Picker
                  label={t('checklist.console.event')}
                  value={step.event}
                  onChange={(v) => edit(i, { event: v })}
                  options={CHECKLIST_EVENTS.map((e) => ({ value: e, label: tDynamic(`checklist.event.${e}`) }))}
                />
              </Field>
              <Field label={t('checklist.console.tour')}>
                <Picker
                  label={t('checklist.console.tour')}
                  value={step.tour_slug ?? ''}
                  onChange={(v) => edit(i, { tour_slug: v || null })}
                  options={tourOptions}
                  searchable
                />
              </Field>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <Segmented
                label={t('checklist.console.audience')}
                value={step.audience}
                onChange={(v) => edit(i, { audience: v })}
                options={[
                  { value: 'all', label: t('checklist.console.audienceAll') },
                  { value: 'admins', label: t('checklist.console.audienceAdmins') },
                ]}
              />
              <label className="flex items-center gap-1.5 text-sm">
                <Switch checked={step.enabled} onChange={(v) => edit(i, { enabled: v })} disabled={readOnly} />
                {t('checklist.console.stepOn')}
              </label>
              {readOnly ? null : (
                <span className="ms-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('checklist.console.up')}
                    onClick={() => move(i, -1)}
                    disabled={i === 0}
                  >
                    <Icon name="back" size={14} className="rotate-90" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('checklist.console.down')}
                    onClick={() => move(i, 1)}
                    disabled={i === list.length - 1}
                  >
                    <Icon name="back" size={14} className="-rotate-90" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('checklist.console.remove')}
                    onClick={() => setSteps(list.filter((_, j) => j !== i))}
                  >
                    <Icon name="trash" size={14} />
                  </Button>
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
      {readOnly ? null : (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="dashed"
            disabled={list.length >= 30}
            onClick={() =>
              setSteps([
                ...list,
                {
                  id: newId(),
                  event: 'item_created',
                  title: '',
                  description: '',
                  tour_slug: null,
                  audience: 'all',
                  enabled: true,
                },
              ])
            }
            data-testid="checklist-add"
          >
            <Icon name="plus" size={14} />
            {t('checklist.console.add')}
          </Button>
          <Button
            variant="ghost"
            onClick={async () => {
              if (
                await confirmDialog({
                  title: t('checklist.console.restore'),
                  message: t('checklist.console.restoreConfirm'),
                  confirmLabel: t('checklist.console.restore'),
                })
              )
                save.mutate(null);
            }}
            disabled={!current.data.custom}
          >
            {t('checklist.console.restore')}
          </Button>
          <Button
            className="ms-auto"
            busy={save.isPending}
            disabled={!valid}
            // Untouched steps stay as they are (only the switch and the days are saved).
            onClick={() => save.mutate(steps ?? undefined)}
            data-testid="checklist-save"
          >
            {t('checklist.console.save')}
          </Button>
        </div>
      )}
    </div>
  );
};
