// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDateTime,
  SECURITY_INCIDENT_SEVERITIES,
  SECURITY_INCIDENT_STATUSES,
  type SecurityIncident,
  type SecurityIncidentInput,
  t,
} from '@bines/shared';
import {
  Badge,
  Button,
  Calendar,
  Card,
  Field,
  Input,
  Notice,
  Picker,
  SkeletonRows,
  Switch,
  TimeField,
} from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { Popover } from '../board/cells/Popover';

const KEY = ['platform', 'security-incidents'] as const;

/** The local calendar day and HH:mm of an instant, and back (the owner's own clock). */
const pad = (n: number) => String(n).padStart(2, '0');
const partsOf = (iso: string) => {
  const d = new Date(iso);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
};
const instantOf = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();

/** A date + time chooser made of the app's own calendar and time field (never the browser's native picker). */
const WhenField = ({
  value,
  onChange,
  testId,
  clearable,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  testId: string;
  clearable?: boolean;
}) => {
  const [open, setOpen] = useState(false);
  const p = value ? partsOf(value) : null;
  return (
    <span className="relative flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid={testId}
        className="flex h-9 min-w-[190px] items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-2.5 text-sm text-fg hover:bg-surface-2"
      >
        <Icon name="calendar" size={16} />
        {value ? formatDateTime(value) : '—'}
      </button>
      {clearable && value ? (
        <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
          ✕
        </Button>
      ) : null}
      <Popover open={open} onClose={() => setOpen(false)} align="start" className="space-y-2 p-2">
        <Calendar
          mode="single"
          value={(p?.date ?? null) as never}
          onChange={(d) => d && onChange(instantOf(d, p?.time ?? '09:00'))}
        />
        <TimeField
          value={p?.time ?? '09:00'}
          onChange={(time) => onChange(instantOf(p?.date ?? partsOf(new Date().toISOString()).date, time))}
          label={t('incidents.field.detected_at')}
          hourLabel={t('time.hours')}
          minuteLabel={t('time.minutes')}
        />
      </Popover>
    </span>
  );
};

const blank = (): SecurityIncidentInput => ({
  title: '',
  description: '',
  severity: 'medium',
  status: 'open',
  personal_data: false,
  detected_at: new Date().toISOString(),
  occurred_at: null,
  account_ids: [],
  people_affected: null,
  data_categories: '',
  measures: '',
  authority_notified_at: null,
  authority_reference: null,
  subjects_notified_at: null,
});

const toInput = (i: SecurityIncident): SecurityIncidentInput => ({
  title: i.title,
  description: i.description,
  severity: i.severity,
  status: i.status,
  personal_data: i.personal_data,
  detected_at: i.detected_at,
  occurred_at: i.occurred_at,
  account_ids: i.account_ids,
  people_affected: i.people_affected,
  data_categories: i.data_categories,
  measures: i.measures,
  authority_notified_at: i.authority_notified_at,
  authority_reference: i.authority_reference,
  subjects_notified_at: i.subjects_notified_at,
});

const TEXTAREA =
  'w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none';

const Editor = ({ incident, onDone }: { incident: SecurityIncident | null; onDone: () => void }) => {
  const qc = useQueryClient();
  const [v, setV] = useState<SecurityIncidentInput>(incident ? toInput(incident) : blank());
  const set = (p: Partial<SecurityIncidentInput>) => setV({ ...v, ...p });
  const save = useMutation({
    mutationFn: () =>
      incident
        ? api().patch<SecurityIncident>(`/platform/security-incidents/${incident.id}`, v)
        : api().post<SecurityIncident>('/platform/security-incidents', v),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KEY });
      showToast({ message: t('legal.owner.saved') });
      onDone();
    },
  });
  return (
    <Card className="space-y-3" data-testid="incident-editor">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('incidents.field.title')}>
          <Input
            value={v.title}
            dir="auto"
            onChange={(e) => set({ title: e.target.value })}
            data-testid="incident-title"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('incidents.field.severity')}>
            <Picker
              value={v.severity}
              label={t('incidents.field.severity')}
              onChange={(severity) => set({ severity })}
              options={SECURITY_INCIDENT_SEVERITIES.map((s) => ({ value: s, label: t(`incidents.severity.${s}`) }))}
              testId="incident-severity"
            />
          </Field>
          <Field label={t('incidents.field.status')}>
            <Picker
              value={v.status}
              label={t('incidents.field.status')}
              onChange={(status) => set({ status })}
              options={SECURITY_INCIDENT_STATUSES.map((s) => ({ value: s, label: t(`incidents.status.${s}`) }))}
              testId="incident-status"
            />
          </Field>
        </div>
      </div>
      <Field label={t('incidents.field.description')}>
        <textarea
          rows={3}
          dir="auto"
          className={TEXTAREA}
          value={v.description}
          onChange={(e) => set({ description: e.target.value })}
        />
      </Field>
      <Switch
        checked={v.personal_data}
        onChange={(personal_data) => set({ personal_data })}
        label={t('incidents.field.personal_data')}
        testId="incident-personal-data"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('incidents.field.detected_at')}>
          <WhenField value={v.detected_at} onChange={(d) => d && set({ detected_at: d })} testId="incident-detected" />
        </Field>
        <Field label={t('incidents.field.occurred_at')}>
          <WhenField
            value={v.occurred_at ?? null}
            onChange={(d) => set({ occurred_at: d })}
            testId="incident-occurred"
            clearable
          />
        </Field>
        <Field label={t('incidents.field.people_affected')}>
          <Input
            value={v.people_affected === null || v.people_affected === undefined ? '' : String(v.people_affected)}
            inputMode="numeric"
            dir="ltr"
            className="text-start"
            onChange={(e) => {
              const n = e.target.value.trim();
              set({ people_affected: /^\d+$/.test(n) ? Number(n) : null });
            }}
          />
        </Field>
        <Field label={t('incidents.field.data_categories')}>
          <Input value={v.data_categories} dir="auto" onChange={(e) => set({ data_categories: e.target.value })} />
        </Field>
      </div>
      <Field label={t('incidents.field.measures')}>
        <textarea
          rows={3}
          dir="auto"
          className={TEXTAREA}
          value={v.measures}
          onChange={(e) => set({ measures: e.target.value })}
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('incidents.field.authority_notified_at')}>
          <WhenField
            value={v.authority_notified_at ?? null}
            onChange={(d) => set({ authority_notified_at: d })}
            testId="incident-authority"
            clearable
          />
        </Field>
        <Field label={t('incidents.field.authority_reference')}>
          <Input
            value={v.authority_reference ?? ''}
            dir="auto"
            onChange={(e) => set({ authority_reference: e.target.value || null })}
          />
        </Field>
        <Field label={t('incidents.field.subjects_notified_at')}>
          <WhenField
            value={v.subjects_notified_at ?? null}
            onChange={(d) => set({ subjects_notified_at: d })}
            testId="incident-subjects"
            clearable
          />
        </Field>
      </div>
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => save.mutate()}
          busy={save.isPending}
          disabled={!v.title.trim()}
          data-testid="incident-save"
        >
          {t('incidents.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </Card>
  );
};

/**
 * Owner console → Security incidents (privacy): the register — every incident with its severity
 * status and the authority deadline (72 hours from detection for a personal data breach); an overdue notice is
 * marked. New / edit open the editor in place.
 */
export const SecurityIncidentsPanel = () => {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: KEY,
    queryFn: async () => (await api().get<{ data: SecurityIncident[] }>('/platform/security-incidents')).data,
  });
  const [editing, setEditing] = useState<SecurityIncident | 'new' | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api().delete(`/platform/security-incidents/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  return (
    <section className="space-y-2.5" data-testid="owner-incidents">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-0.5">
          <h2 className="font-display text-base font-bold text-heading">{t('incidents.title')}</h2>
          <p className="max-w-[640px] text-xs text-muted">{t('incidents.hint')}</p>
        </div>
        {editing === null ? (
          <Button size="sm" variant="accent" onClick={() => setEditing('new')} data-testid="incident-new">
            {t('incidents.new')}
          </Button>
        ) : null}
      </header>
      {editing ? (
        <Editor
          key={editing === 'new' ? 'new' : editing.id}
          incident={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {list.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      {list.data && !list.data.length && !editing ? <p className="text-sm text-muted">{t('incidents.none')}</p> : null}
      {list.data?.length ? (
        <Card className="divide-y divide-line-soft p-0">
          {list.data.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center gap-3 px-3.5 py-3" data-testid="incident-row">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-sm text-fg" dir="auto">
                  {i.title}
                </div>
                <div className="flex flex-wrap gap-1.5 text-xs text-muted">
                  <Badge tone={i.severity === 'critical' || i.severity === 'high' ? 'danger' : 'neutral'}>
                    {t(`incidents.severity.${i.severity}`)}
                  </Badge>
                  <Badge tone={i.status === 'closed' ? 'ok' : 'warn'}>{t(`incidents.status.${i.status}`)}</Badge>
                  <span>{formatDateTime(i.detected_at)}</span>
                  {i.overdue ? (
                    <Badge tone="danger" data-testid="incident-overdue">
                      {t('incidents.overdue')}
                    </Badge>
                  ) : i.authority_notified_at ? (
                    <span>{t('incidents.notified', { date: formatDateTime(i.authority_notified_at) })}</span>
                  ) : i.authority_due_at ? (
                    <span>{t('incidents.due', { date: formatDateTime(i.authority_due_at) })}</span>
                  ) : null}
                </div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEditing(i)}>
                {t('legal.owner.edit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void confirmDialog({
                    title: t('incidents.deleteConfirm'),
                    confirmLabel: t('incidents.delete'),
                    danger: true,
                  }).then((ok) => ok && remove.mutate(i.id))
                }
              >
                {t('incidents.delete')}
              </Button>
            </div>
          ))}
        </Card>
      ) : null}
    </section>
  );
};
