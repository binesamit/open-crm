// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type PlatformRetention, type PlatformSettingsResponse, RETENTION_DAYS_RANGE, t } from '@bines/shared';
import { Button, Card, Field, Input, Notice } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';

const FIELDS = [
  'audit_days',
  'activity_days',
  'notifications_days',
] as const satisfies readonly (keyof PlatformRetention)[];

/** '' = keep (null); a whole number in range; anything else is invalid (undefined). */
const parseDays = (s: string): number | null | undefined => {
  const v = s.trim();
  if (!v) return null;
  if (!/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return n >= RETENTION_DAYS_RANGE.min && n <= RETENTION_DAYS_RANGE.max ? n : undefined;
};

/**
 * Owner console → Platform settings → Log retention (privacy): how many days the audit log, boards'
 * change history and notifications are kept; empty = until deleted by hand. A daily job applies it.
 */
export const RetentionCard = ({ data }: { data: PlatformSettingsResponse }) => {
  const qc = useQueryClient();
  const current = data.settings.retention;
  const initial = Object.fromEntries(FIELDS.map((k) => [k, current[k] === null ? '' : String(current[k])])) as Record<
    (typeof FIELDS)[number],
    string
  >;
  const [values, setValues] = useState(initial);
  const parsed = Object.fromEntries(FIELDS.map((k) => [k, parseDays(values[k])])) as Record<
    (typeof FIELDS)[number],
    number | null | undefined
  >;
  const valid = FIELDS.every((k) => parsed[k] !== undefined);
  const dirty = FIELDS.some((k) => values[k] !== initial[k]);
  const save = useMutation({
    mutationFn: () => api().patch<PlatformSettingsResponse>('/platform/settings', { retention: parsed }),
    onSuccess: (res) => {
      qc.setQueryData(['platform', 'settings'], res);
      showToast({ message: t('admin.general.saved') });
    },
  });
  return (
    <Card className="space-y-3" data-testid="owner-retention">
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-fg">{t('retention.title')}</h3>
        <p className="text-xs text-muted">{t('retention.hint')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {FIELDS.map((k) => (
          <Field key={k} label={t(`retention.${k}`)} hint={t(`retention.${k}.hint`)}>
            <Input
              value={values[k]}
              maxLength={4}
              inputMode="numeric"
              dir="ltr"
              className="text-start"
              placeholder={t('retention.keep')}
              aria-invalid={parsed[k] === undefined}
              onChange={(e) => setValues({ ...values, [k]: e.target.value })}
              data-testid={`owner-retention-${k}`}
            />
          </Field>
        ))}
      </div>
      {!valid ? (
        <Notice tone="error">
          {t('retention.range', { min: RETENTION_DAYS_RANGE.min, max: RETENTION_DAYS_RANGE.max })}
        </Notice>
      ) : null}
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      <Button
        size="sm"
        onClick={() => save.mutate()}
        busy={save.isPending}
        disabled={!dirty || !valid}
        data-testid="owner-retention-save"
      >
        {t('legal.owner.save')}
      </Button>
    </Card>
  );
};
