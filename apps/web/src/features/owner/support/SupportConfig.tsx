// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  colorKeyFromHex,
  GROUP_COLORS,
  GROUP_PALETTE,
  paint,
  type HelpdeskSettings,
  type SlaPolicy,
  type SupportConsoleConfig,
  type SupportMode,
  TICKET_PRIORITIES,
  type TicketPriority,
  type UpdateHelpdeskSettings,
  t,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, Card, Dialog, Field, Input, Picker, Segmented, Switch, TimeField } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { confirmDialog, promptDialog } from '../../../lib/dialogs';
import { Icon } from '../../../lib/icons';
import { colorName } from '../../../lib/label-color';
import { showToast } from '../../../lib/toast';
import { timeZones, zoneLabel } from '../../../lib/timezones';
import { TEXTAREA } from '../../support/NewTicketDialog';
import { priorityLabel } from '../../support/support-api';
import { consoleKeys } from './console-api';

/**
 * Owner console → Support → Settings: everything the helpdesk does is set here — queues, categories
 * (routing to a queue, a default priority), SLA targets per priority, business hours and holidays, canned replies,
 * tags, and the general settings (on/off, numbering, emails, CSAT, what the app attaches, access-request defaults,
 * the signature). Leads and the owner; agents see the tickets only.
 */
const useSave = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { method: 'post' | 'patch' | 'put' | 'del'; path: string; body?: unknown }) =>
      v.method === 'del'
        ? api().delete<SupportConsoleConfig>(v.path)
        : api()[v.method]<SupportConsoleConfig>(v.path, v.body ?? {}),
    onSuccess: (res) => {
      qc.setQueryData(consoleKeys.config, res);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
};

const Section = ({
  title,
  hint,
  children,
  testId,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  testId: string;
}) => (
  <Card className="space-y-3">
    <div className="space-y-0.5" data-testid={testId}>
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
    {children}
  </Card>
);

const Toggle = ({
  label,
  hint,
  value,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) => (
  <label className="flex items-center justify-between gap-3">
    <span className="space-y-0.5">
      <span className="block text-sm text-fg">{label}</span>
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </span>
    <Switch checked={value} onChange={onChange} label={label} testId={testId} />
  </label>
);

export const SupportConfig = ({ config }: { config: SupportConsoleConfig }) => (
  <div className="space-y-4" data-testid="support-config">
    <GeneralSettings key={JSON.stringify(config.settings)} settings={config.settings} />
    <BusinessHoursCard key={`bh${JSON.stringify(config.settings.business_hours)}`} settings={config.settings} />
    <SlaCard key={JSON.stringify(config.sla)} sla={config.sla} />
    <QueuesCard config={config} />
    <CategoriesCard config={config} />
    <CannedCard config={config} />
    <TagsCard config={config} />
  </div>
);

const INT = /^\d{1,9}$/;

const GeneralSettings = ({ settings }: { settings: HelpdeskSettings }) => {
  const save = useSave();
  const [s, setS] = useState(settings);
  const [start, setStart] = useState(String(settings.number_start));
  const [expiry, setExpiry] = useState(String(settings.access.request_expires_hours));
  const [hours, setHours] = useState(String(settings.access.default_duration_hours));
  const [maxErrors, setMaxErrors] = useState(String(settings.context.max_errors));
  const email = (k: keyof HelpdeskSettings['email']) => (v: boolean) => setS({ ...s, email: { ...s.email, [k]: v } });
  const ctx = (k: 'page' | 'browser' | 'errors') => (v: boolean) => setS({ ...s, context: { ...s.context, [k]: v } });
  const ok = INT.test(start) && INT.test(expiry) && INT.test(hours) && INT.test(maxErrors) && Number(maxErrors) <= 20;
  const patch: UpdateHelpdeskSettings = {
    enabled: s.enabled,
    number_start: Number(start),
    default_priority: s.default_priority,
    signature: s.signature,
    suggest_articles: s.suggest_articles,
    csat: { enabled: s.csat.enabled },
    email: s.email,
    context: { ...s.context, max_errors: Number(maxErrors) },
    access: {
      default_mode: s.access.default_mode,
      default_duration_hours: Number(hours),
      request_expires_hours: Number(expiry),
    },
  };
  return (
    <Section title={t('tickets.cfg.general')} hint={t('tickets.cfg.generalHint')} testId="support-cfg-general">
      <Toggle
        label={t('tickets.cfg.enabled')}
        value={s.enabled}
        onChange={(v) => setS({ ...s, enabled: v })}
        testId="support-cfg-enabled"
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('tickets.cfg.numberStart')} hint={t('tickets.cfg.numberStartHint')}>
          <Input
            value={start}
            onChange={(e) => setStart(e.target.value)}
            inputMode="numeric"
            dir="ltr"
            className="text-start"
          />
        </Field>
        <Field label={t('tickets.cfg.defaultPriority')}>
          <Picker
            label={t('tickets.cfg.defaultPriority')}
            value={s.default_priority}
            onChange={(v) => setS({ ...s, default_priority: v })}
            options={TICKET_PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) }))}
          />
        </Field>
      </div>
      <Field label={t('tickets.cfg.signature')} hint={t('tickets.cfg.signatureHint')}>
        <textarea
          className={TEXTAREA}
          value={s.signature}
          maxLength={1000}
          data-testid="support-cfg-signature"
          onChange={(e) => setS({ ...s, signature: e.target.value })}
        />
      </Field>
      <div className="space-y-2">
        <span className="text-xs font-semibold text-fg-2">{t('tickets.cfg.emails')}</span>
        <Toggle
          label={t('tickets.cfg.email.customer_on_create')}
          value={s.email.customer_on_create}
          onChange={email('customer_on_create')}
        />
        <Toggle
          label={t('tickets.cfg.email.customer_on_reply')}
          value={s.email.customer_on_reply}
          onChange={email('customer_on_reply')}
          testId="support-cfg-email-reply"
        />
        <Toggle
          label={t('tickets.cfg.email.customer_on_status')}
          value={s.email.customer_on_status}
          onChange={email('customer_on_status')}
        />
        <Toggle
          label={t('tickets.cfg.email.staff_on_new')}
          value={s.email.staff_on_new}
          onChange={email('staff_on_new')}
        />
        <Toggle
          label={t('tickets.cfg.email.staff_on_customer_reply')}
          value={s.email.staff_on_customer_reply}
          onChange={email('staff_on_customer_reply')}
        />
        <Toggle
          label={t('tickets.cfg.email.staff_on_breach')}
          value={s.email.staff_on_breach}
          onChange={email('staff_on_breach')}
        />
      </div>
      <Toggle
        label={t('tickets.cfg.csat')}
        hint={t('tickets.cfg.csatHint')}
        value={s.csat.enabled}
        onChange={(v) => setS({ ...s, csat: { enabled: v } })}
        testId="support-cfg-csat"
      />
      <div className="space-y-2">
        <span className="text-xs font-semibold text-fg-2">{t('tickets.cfg.context')}</span>
        <Toggle label={t('tickets.context.page')} value={s.context.page} onChange={ctx('page')} />
        <Toggle label={t('tickets.context.browser')} value={s.context.browser} onChange={ctx('browser')} />
        <Toggle label={t('tickets.cfg.contextErrors')} value={s.context.errors} onChange={ctx('errors')} />
        <Field label={t('tickets.cfg.maxErrors')}>
          <Input
            value={maxErrors}
            onChange={(e) => setMaxErrors(e.target.value)}
            inputMode="numeric"
            dir="ltr"
            className="w-24 text-start"
          />
        </Field>
      </div>
      <div className="space-y-2">
        <span className="text-xs font-semibold text-fg-2">{t('tickets.cfg.access')}</span>
        <p className="text-xs text-muted">{t('tickets.cfg.accessHint')}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('support.access')}>
            <Segmented
              label={t('support.access')}
              value={s.access.default_mode}
              onChange={(v: SupportMode) => setS({ ...s, access: { ...s.access, default_mode: v } })}
              options={[
                { value: 'view' as const, label: t('support.mode.view') },
                { value: 'edit' as const, label: t('support.mode.edit') },
              ]}
            />
          </Field>
          <Field label={t('tickets.cfg.accessHours')}>
            <Input
              value={hours}
              onChange={(e) => setHours(e.target.value)}
              inputMode="numeric"
              dir="ltr"
              className="text-start"
            />
          </Field>
          <Field label={t('tickets.cfg.requestExpiry')}>
            <Input
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              inputMode="numeric"
              dir="ltr"
              className="text-start"
            />
          </Field>
        </div>
      </div>
      <Toggle
        label={t('tickets.cfg.suggest')}
        hint={t('tickets.cfg.suggestHint')}
        value={s.suggest_articles}
        onChange={(v) => setS({ ...s, suggest_articles: v })}
      />
      <div className="flex justify-end">
        <Button
          disabled={!ok}
          busy={save.isPending}
          onClick={() => save.mutate({ method: 'patch', path: '/platform/support/settings', body: patch })}
          data-testid="support-cfg-save"
        >
          {t('common.save')}
        </Button>
      </div>
    </Section>
  );
};

const DAYS = [0, 1, 2, 3, 4, 5, 6];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

const BusinessHoursCard = ({ settings }: { settings: HelpdeskSettings }) => {
  const save = useSave();
  const [tz, setTz] = useState(settings.business_hours.timezone);
  const [days, setDays] = useState(settings.business_hours.days);
  const [holidays, setHolidays] = useState(settings.business_hours.holidays);
  const [holiday, setHoliday] = useState('');
  const windowOf = (d: number) => days.find((w) => w.day === d);
  const setDay = (d: number, w: { start: string; end: string } | null) =>
    setDays((cur) =>
      [...cur.filter((x) => x.day !== d), ...(w ? [{ day: d, ...w }] : [])].sort((a, b) => a.day - b.day),
    );
  const addHoliday = (e: FormEvent) => {
    e.preventDefault();
    if (ISO.test(holiday) && !holidays.includes(holiday)) setHolidays([...holidays, holiday].sort());
    setHoliday('');
  };
  return (
    <Section title={t('tickets.cfg.hours')} hint={t('tickets.cfg.hoursHint')} testId="support-cfg-hours">
      <Field label={t('tickets.cfg.timezone')}>
        <Picker
          label={t('tickets.cfg.timezone')}
          value={tz}
          onChange={setTz}
          searchable
          options={timeZones(tz).map((z) => ({ value: z, label: zoneLabel(z) }))}
        />
      </Field>
      <ul className="space-y-1.5">
        {DAYS.map((d) => {
          const w = windowOf(d);
          return (
            <li key={d} className="flex flex-wrap items-center gap-2" data-testid="support-cfg-day" data-day={d}>
              <Switch
                checked={!!w}
                label={tDynamic(`tickets.day.${d}`)}
                onChange={(on) => setDay(d, on ? { start: '09:00', end: '17:00' } : null)}
              />
              <span className="w-20 text-sm text-fg">{tDynamic(`tickets.day.${d}`)}</span>
              {w ? (
                <>
                  <TimeField
                    value={w.start}
                    onChange={(v) => setDay(d, { ...w, start: v })}
                    label={t('tickets.cfg.from')}
                    hourLabel={t('tickets.cfg.hour')}
                    minuteLabel={t('tickets.cfg.minute')}
                  />
                  <span className="text-xs text-muted">–</span>
                  <TimeField
                    value={w.end}
                    onChange={(v) => setDay(d, { ...w, end: v })}
                    label={t('tickets.cfg.to')}
                    hourLabel={t('tickets.cfg.hour')}
                    minuteLabel={t('tickets.cfg.minute')}
                  />
                </>
              ) : (
                <span className="text-xs text-muted">{t('tickets.cfg.dayOff')}</span>
              )}
            </li>
          );
        })}
      </ul>
      <div className="space-y-1.5">
        <span className="text-xs font-semibold text-fg-2">{t('tickets.cfg.holidays')}</span>
        <div className="flex flex-wrap gap-1.5">
          {holidays.map((h) => (
            <span
              key={h}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 ps-2.5 pe-1 text-xs"
              dir="ltr"
            >
              {h}
              <button
                type="button"
                aria-label={t('tickets.cfg.removeHoliday', { date: h })}
                onClick={() => setHolidays(holidays.filter((x) => x !== h))}
                className="grid size-5 place-items-center rounded-full text-muted hover:bg-surface-3"
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
        <form onSubmit={addHoliday} className="flex gap-2">
          <Input
            value={holiday}
            onChange={(e) => setHoliday(e.target.value)}
            placeholder="2026-12-25"
            dir="ltr"
            className="w-36 text-start"
          />
          <Button type="submit" variant="secondary" size="sm" disabled={!ISO.test(holiday)}>
            <Icon name="plus" size={14} />
            {t('tickets.cfg.addHoliday')}
          </Button>
        </form>
      </div>
      <div className="flex justify-end">
        <Button
          busy={save.isPending}
          disabled={days.some((w) => w.end <= w.start)}
          onClick={() =>
            save.mutate({
              method: 'patch',
              path: '/platform/support/settings',
              body: { business_hours: { timezone: tz, days, holidays } },
            })
          }
          data-testid="support-cfg-hours-save"
        >
          {t('common.save')}
        </Button>
      </div>
    </Section>
  );
};

const SlaCard = ({ sla }: { sla: SlaPolicy[] }) => {
  const save = useSave();
  const [rows, setRows] = useState(() =>
    TICKET_PRIORITIES.map((p) => {
      const r = sla.find((x) => x.priority === p);
      return {
        priority: p,
        first: String(r?.first_response_minutes ?? ''),
        resolution: String(r?.resolution_minutes ?? ''),
        business: r?.business_hours ?? true,
      };
    }),
  );
  const set = (p: TicketPriority, v: Partial<(typeof rows)[number]>) =>
    setRows((cur) => cur.map((r) => (r.priority === p ? { ...r, ...v } : r)));
  const filled = rows.filter((r) => r.first && r.resolution);
  const ok =
    filled.length > 0 &&
    filled.every((r) => INT.test(r.first) && INT.test(r.resolution) && Number(r.resolution) >= Number(r.first));
  return (
    <Section title={t('tickets.cfg.sla')} hint={t('tickets.cfg.slaHint')} testId="support-cfg-sla">
      <div className="space-y-2">
        {rows.map((r) => (
          <div
            key={r.priority}
            className="grid items-end gap-2 sm:grid-cols-[8rem_1fr_1fr_auto]"
            data-testid="support-cfg-sla-row"
            data-priority={r.priority}
          >
            <span className="pb-2 text-sm font-semibold text-fg">{priorityLabel(r.priority)}</span>
            <Field label={t('tickets.cfg.slaFirst')}>
              <Input
                value={r.first}
                onChange={(e) => set(r.priority, { first: e.target.value })}
                inputMode="numeric"
                dir="ltr"
                className="text-start"
              />
            </Field>
            <Field label={t('tickets.cfg.slaResolution')}>
              <Input
                value={r.resolution}
                onChange={(e) => set(r.priority, { resolution: e.target.value })}
                inputMode="numeric"
                dir="ltr"
                className="text-start"
              />
            </Field>
            <label className="flex items-center gap-2 pb-2 text-xs text-fg-2">
              <Switch
                checked={r.business}
                onChange={(v) => set(r.priority, { business: v })}
                label={t('tickets.cfg.slaBusiness')}
              />
              {t('tickets.cfg.slaBusiness')}
            </label>
          </div>
        ))}
      </div>
      <div className="flex justify-end">
        <Button
          disabled={!ok}
          busy={save.isPending}
          onClick={() =>
            save.mutate({
              method: 'put',
              path: '/platform/support/sla',
              body: {
                policies: filled.map((r) => ({
                  priority: r.priority,
                  first_response_minutes: Number(r.first),
                  resolution_minutes: Number(r.resolution),
                  business_hours: r.business,
                })),
              },
            })
          }
          data-testid="support-cfg-sla-save"
        >
          {t('common.save')}
        </Button>
      </div>
    </Section>
  );
};

const AddByName = ({ label, onAdd, testId }: { label: string; onAdd: (name: string) => void; testId: string }) => {
  const [name, setName] = useState('');
  return (
    <form
      className="flex gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onAdd(name.trim());
        setName('');
      }}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={label}
        data-testid={`${testId}-name`}
      />
      <Button type="submit" variant="secondary" size="sm" disabled={!name.trim()} data-testid={`${testId}-add`}>
        <Icon name="plus" size={14} />
        {t('tickets.cfg.add')}
      </Button>
    </form>
  );
};

const rename = async (initial: string) =>
  promptDialog({
    title: t('tickets.cfg.rename'),
    label: t('tickets.cfg.name'),
    initial,
    confirmLabel: t('common.save'),
  });

const QueuesCard = ({ config }: { config: SupportConsoleConfig }) => {
  const save = useSave();
  return (
    <Section title={t('tickets.cfg.queues')} hint={t('tickets.cfg.queuesHint')} testId="support-cfg-queues">
      <ul className="divide-y divide-line-soft rounded-[10px] border border-line">
        {config.queues.map((q) => (
          <li
            key={q.id}
            className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
            data-testid="support-cfg-queue"
            data-name={q.name}
          >
            <span className={q.archived ? 'flex-1 text-muted line-through' : 'flex-1 text-fg'}>{q.name}</span>
            {q.is_default ? <Badge tone="info">{t('tickets.cfg.default')}</Badge> : null}
            {!q.is_default && !q.archived ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  save.mutate({
                    method: 'patch',
                    path: `/platform/support/queues/${q.id}`,
                    body: { name: q.name, is_default: true },
                  })
                }
              >
                {t('tickets.cfg.makeDefault')}
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                void rename(q.name).then(
                  (name) =>
                    name && save.mutate({ method: 'patch', path: `/platform/support/queues/${q.id}`, body: { name } }),
                )
              }
            >
              {t('tickets.cfg.rename')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                save.mutate({
                  method: 'patch',
                  path: `/platform/support/queues/${q.id}`,
                  body: { name: q.name, archived: !q.archived },
                })
              }
            >
              {t(q.archived ? 'tickets.cfg.restore' : 'tickets.cfg.archive')}
            </Button>
          </li>
        ))}
      </ul>
      <AddByName
        label={t('tickets.cfg.queueName')}
        testId="support-cfg-queue"
        onAdd={(name) => save.mutate({ method: 'post', path: '/platform/support/queues', body: { name } })}
      />
    </Section>
  );
};

const CategoriesCard = ({ config }: { config: SupportConsoleConfig }) => {
  const save = useSave();
  const queues = [
    { value: '', label: t('tickets.cfg.defaultQueue') },
    ...config.queues.filter((q) => !q.archived).map((q) => ({ value: q.id, label: q.name })),
  ];
  const priorities = [
    { value: '', label: t('tickets.cfg.platformDefault') },
    ...TICKET_PRIORITIES.map((p) => ({ value: p, label: priorityLabel(p) })),
  ];
  return (
    <Section title={t('tickets.cfg.categories')} hint={t('tickets.cfg.categoriesHint')} testId="support-cfg-categories">
      <ul className="divide-y divide-line-soft rounded-[10px] border border-line">
        {config.categories.map((c) => {
          const update = (body: Record<string, unknown>) =>
            save.mutate({
              method: 'patch',
              path: `/platform/support/categories/${c.id}`,
              body: { name: c.name, ...body },
            });
          return (
            <li
              key={c.id}
              className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
              data-testid="support-cfg-category"
              data-name={c.name}
            >
              <span className={c.archived ? 'min-w-24 flex-1 text-muted line-through' : 'min-w-24 flex-1 text-fg'}>
                {c.name}
              </span>
              <Picker
                label={t('tickets.field.queue')}
                className="w-40"
                value={c.queue_id ?? ''}
                options={queues}
                onChange={(v) => update({ queue_id: v || null })}
              />
              <Picker
                label={t('tickets.field.priority')}
                className="w-36"
                value={c.default_priority ?? ''}
                options={priorities}
                onChange={(v) => update({ default_priority: v || null })}
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void rename(c.name).then((name) => name && update({ name }))}
              >
                {t('tickets.cfg.rename')}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => update({ archived: !c.archived })}>
                {t(c.archived ? 'tickets.cfg.restore' : 'tickets.cfg.archive')}
              </Button>
            </li>
          );
        })}
      </ul>
      <AddByName
        label={t('tickets.cfg.categoryName')}
        testId="support-cfg-category"
        onAdd={(name) => save.mutate({ method: 'post', path: '/platform/support/categories', body: { name } })}
      />
    </Section>
  );
};

const CannedCard = ({ config }: { config: SupportConsoleConfig }) => {
  const save = useSave();
  const [editing, setEditing] = useState<{ id: string | null; title: string; body: string; queue_id: string } | null>(
    null,
  );
  const queues = [
    { value: '', label: t('tickets.cfg.allQueues') },
    ...config.queues.filter((q) => !q.archived).map((q) => ({ value: q.id, label: q.name })),
  ];
  return (
    <Section title={t('tickets.cfg.canned')} hint={t('tickets.cfg.cannedHint')} testId="support-cfg-canned">
      <ul className="divide-y divide-line-soft rounded-[10px] border border-line">
        {config.canned.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-2 px-3 py-2 text-sm"
            data-testid="support-cfg-canned-row"
            data-title={c.title}
          >
            <span className={c.archived ? 'flex-1 text-muted line-through' : 'flex-1 text-fg'}>{c.title}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditing({ id: c.id, title: c.title, body: c.body, queue_id: c.queue_id ?? '' })}
            >
              {t('tickets.cfg.edit')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                save.mutate({
                  method: 'patch',
                  path: `/platform/support/canned-replies/${c.id}`,
                  body: { title: c.title, body: c.body, archived: !c.archived },
                })
              }
            >
              {t(c.archived ? 'tickets.cfg.restore' : 'tickets.cfg.archive')}
            </Button>
          </li>
        ))}
      </ul>
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setEditing({ id: null, title: '', body: '', queue_id: '' })}
        data-testid="support-cfg-canned-new"
      >
        <Icon name="plus" size={14} />
        {t('tickets.cfg.add')}
      </Button>
      {editing ? (
        <Dialog open onClose={() => setEditing(null)} title={t('tickets.cfg.canned')}>
          <div className="space-y-3">
            <Field label={t('tickets.cfg.cannedTitle')}>
              <Input
                value={editing.title}
                maxLength={120}
                onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                data-testid="support-cfg-canned-title"
              />
            </Field>
            <Field label={t('tickets.cfg.cannedBody')}>
              <textarea
                className={TEXTAREA}
                value={editing.body}
                onChange={(e) => setEditing({ ...editing, body: e.target.value })}
                data-testid="support-cfg-canned-body"
              />
            </Field>
            <Field label={t('tickets.field.queue')}>
              <Picker
                label={t('tickets.field.queue')}
                value={editing.queue_id}
                options={queues}
                onChange={(v) => setEditing({ ...editing, queue_id: v })}
              />
            </Field>
            <div className="flex justify-end">
              <Button
                disabled={!editing.title.trim() || !editing.body.trim()}
                busy={save.isPending}
                data-testid="support-cfg-canned-save"
                onClick={() =>
                  save.mutate(
                    {
                      method: editing.id ? 'patch' : 'post',
                      path: editing.id
                        ? `/platform/support/canned-replies/${editing.id}`
                        : '/platform/support/canned-replies',
                      body: { title: editing.title, body: editing.body, queue_id: editing.queue_id || null },
                    },
                    { onSuccess: () => setEditing(null) },
                  )
                }
              >
                {t('common.save')}
              </Button>
            </div>
          </div>
        </Dialog>
      ) : null}
    </Section>
  );
};

// The group palette, like every other colour choice in the app.
const TAG_COLORS = GROUP_PALETTE.slice(0, 10).map((k) => GROUP_COLORS[k]);

const TagsCard = ({ config }: { config: SupportConsoleConfig }) => {
  const save = useSave();
  const [color, setColor] = useState(TAG_COLORS[3]!);
  return (
    <Section title={t('tickets.cfg.tags')} testId="support-cfg-tags">
      <div className="flex flex-wrap gap-1.5">
        {config.tags.map((x) => (
          <span
            key={x.id}
            className="inline-flex h-7 items-center gap-1 rounded-full ps-2.5 pe-1 text-xs font-semibold text-white"
            style={{ background: paint(x.color) ?? 'var(--muted)' }}
            data-testid="support-cfg-tag"
          >
            {x.name}
            <button
              type="button"
              aria-label={t('tickets.cfg.deleteTag', { name: x.name })}
              className="grid size-5 place-items-center rounded-full hover:bg-black/20"
              onClick={() =>
                void confirmDialog({
                  title: t('tickets.cfg.deleteTag', { name: x.name }),
                  message: t('tickets.cfg.deleteTagHint'),
                  danger: true,
                }).then((ok) => ok && save.mutate({ method: 'del', path: `/platform/support/tags/${x.id}` }))
              }
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex gap-1" role="radiogroup" aria-label={t('tickets.cfg.color')}>
          {TAG_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={colorName(colorKeyFromHex(c))}
              onClick={() => setColor(c)}
              className="size-5 rounded-full outline-offset-2 aria-checked:outline-2 aria-checked:outline-[var(--focus-ring)]"
              style={{ background: paint(c) }}
            />
          ))}
        </span>
        <div className="min-w-48 flex-1">
          <AddByName
            label={t('tickets.cfg.tagName')}
            testId="support-cfg-tag"
            onAdd={(name) => save.mutate({ method: 'post', path: '/platform/support/tags', body: { name, color } })}
          />
        </div>
      </div>
    </Section>
  );
};
