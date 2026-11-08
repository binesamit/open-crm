// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ALERT_AUDIENCES,
  type ErrorAlertRule,
  type ErrorHubConfig,
  type ErrorHubSettings,
  type ErrorMute,
  ERROR_SEVERITIES,
  ERROR_SOURCES,
  type ErrorSeverity,
  type ErrorSource,
  formatDateTime,
  type UpdateErrorHubSettings,
  t,
} from '@bines/shared';
import { Button, Card, cn, Field, Input, Picker, Segmented, Switch } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { timeZones, zoneLabel } from '../../../lib/timezones';
import { errorKeys, severityLabel, sourceLabel } from './errors-api';
import { SupportAgentSettingsCard } from './SupportAgent';
import { SupportAgentToolsCard } from './SupportAgentTools';

/**
 * Owner console → Errors & health → Settings: every behaviour of the hub — which sources record and
 * at what severity, which automation skips are problems, retention and auto-resolve, alert rules (instant / daily
 * digest, recipients, channels), mutes, the accounts' Health page and its admin alerts, browser errors, spikes, the
 * writer and GlitchTip. Each card saves its own part. Leads and the owner change them; agents read them.
 */
const useSave = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateErrorHubSettings) => api().patch<ErrorHubConfig>('/platform/errors/settings', patch),
    onSuccess: (res) => {
      qc.setQueryData(errorKeys.config, res);
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
  onSave,
  canSave,
  busy,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  testId: string;
  onSave?: () => void;
  canSave: boolean;
  busy?: boolean;
}) => (
  <Card className="space-y-3" data-testid={testId}>
    <div className="space-y-0.5">
      <h3 className="text-sm font-semibold text-fg">{title}</h3>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
    {children}
    {onSave ? (
      <div className="flex justify-end">
        <Button
          size="sm"
          variant="accent"
          disabled={!canSave}
          busy={busy}
          onClick={onSave}
          data-testid={`${testId}-save`}
        >
          {t('common.save')}
        </Button>
      </div>
    ) : null}
  </Card>
);

const Toggle = ({
  label,
  value,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  testId?: string;
}) => (
  <label className="flex items-center justify-between gap-3">
    <span className="text-sm text-fg">{label}</span>
    <Switch checked={value} onChange={onChange} label={label} disabled={disabled} testId={testId} />
  </label>
);

/** A whole-number field kept as text while typed (empty / out of range = not savable). */
const Num = ({
  label,
  value,
  onChange,
  min,
  max,
  disabled,
  testId,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min: number;
  max: number;
  disabled?: boolean;
  testId?: string;
  hint?: string;
}) => {
  const bad = !numOk(value, min, max);
  return (
    <Field label={label} hint={hint}>
      <Input
        inputMode="decimal"
        dir="ltr"
        className={cn('w-28 text-end tabular-nums', bad && 'border-danger')}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </Field>
  );
};
const numOk = (v: string, min: number, max: number) => /^\d+(\.\d+)?$/.test(v) && Number(v) >= min && Number(v) <= max;

/** Toggle chips for a set of sources. */
const SourceChips = ({
  value,
  onChange,
  disabled,
  testId,
}: {
  value: ErrorSource[];
  onChange: (v: ErrorSource[]) => void;
  disabled?: boolean;
  testId: string;
}) => (
  <div className="flex flex-wrap gap-1.5" data-testid={testId}>
    {ERROR_SOURCES.map((s) => {
      const on = value.includes(s);
      return (
        <button
          key={s}
          type="button"
          disabled={disabled}
          aria-pressed={on}
          data-source={s}
          onClick={() => onChange(on ? value.filter((x) => x !== s) : [...value, s])}
          className={cn(
            'h-7 rounded-full border px-2.5 text-xs',
            on ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line text-fg-2 hover:bg-surface-2',
          )}
        >
          {sourceLabel(s)}
        </button>
      );
    })}
  </div>
);

const severityOptions = ERROR_SEVERITIES.map((s) => ({ value: s, label: severityLabel(s) }));

export const ErrorSettings = ({ config }: { config: ErrorHubConfig }) => {
  const key = JSON.stringify(config.settings);
  const edit = config.can_edit_settings;
  return (
    <div className="space-y-4" data-testid="errors-settings" data-editable={edit ? 'true' : 'false'}>
      <SourcesCard key={`s${key}`} s={config.settings} edit={edit} />
      <SkipsCard key={`k${key}`} s={config.settings} edit={edit} />
      <RetentionCard key={`r${key}`} s={config.settings} edit={edit} />
      <AlertsCard key={`a${key}`} s={config.settings} edit={edit} config={config} />
      <MutesCard key={`m${key}`} s={config.settings} edit={edit} config={config} />
      <AccountPageCard key={`p${key}`} s={config.settings} edit={edit} />
      <ClientCard key={`c${key}`} s={config.settings} edit={edit} />
      <GlitchtipCard key={`g${key}`} s={config.settings} edit={edit} />
      <SupportAgentSettingsCard />
      <SupportAgentToolsCard />
    </div>
  );
};

type CardProps = { s: ErrorHubSettings; edit: boolean };

const SourcesCard = ({ s, edit }: CardProps) => {
  const save = useSave();
  const [v, setV] = useState(s.sources);
  return (
    <Section
      title={t('errors.settings.sources')}
      hint={t('errors.settings.sourcesHint')}
      testId="errors-settings-sources"
      canSave={edit}
      busy={save.isPending}
      onSave={() => save.mutate({ sources: v })}
    >
      <ul className="divide-y divide-line-soft">
        {ERROR_SOURCES.map((src) => (
          <li key={src} className="flex items-center gap-3 py-1.5" data-source={src}>
            <span className="min-w-0 flex-1 text-sm">{sourceLabel(src)}</span>
            <Picker
              label={t('errors.field.severity')}
              className="w-32"
              value={v[src].severity}
              onChange={(severity: ErrorSeverity) => setV({ ...v, [src]: { ...v[src], severity } })}
              options={severityOptions}
              testId={`errors-source-severity-${src}`}
            />
            <Switch
              checked={v[src].enabled}
              disabled={!edit}
              label={sourceLabel(src)}
              onChange={(enabled) => setV({ ...v, [src]: { ...v[src], enabled } })}
              testId={`errors-source-enabled-${src}`}
            />
          </li>
        ))}
      </ul>
    </Section>
  );
};

const SkipsCard = ({ s, edit }: CardProps) => {
  const save = useSave();
  const [list, setList] = useState(s.problem_skips);
  const [draft, setDraft] = useState('');
  const add = () => {
    const k = draft.trim().toLowerCase();
    if (/^[a-z0-9_]{1,60}$/.test(k) && !list.includes(k)) setList([...list, k]);
    setDraft('');
  };
  return (
    <Section
      title={t('errors.settings.skips')}
      hint={t('errors.settings.skipsHint')}
      testId="errors-settings-skips"
      canSave={edit}
      busy={save.isPending}
      onSave={() => save.mutate({ problem_skips: list })}
    >
      <div className="flex flex-wrap gap-1.5">
        {list.map((k) => (
          <span
            key={k}
            className="inline-flex h-7 items-center gap-1 rounded-full bg-surface-2 ps-2.5 pe-1 font-mono text-xs"
            dir="ltr"
            data-skip={k}
          >
            {k}
            {edit ? (
              <button
                type="button"
                className="grid size-5 place-items-center rounded-full hover:bg-surface-3"
                onClick={() => setList(list.filter((x) => x !== k))}
                aria-label={t('common.delete')}
                title={t('common.delete')}
              >
                <Icon name="x" size={11} />
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {edit ? (
        <div className="flex gap-2">
          <Input
            dir="ltr"
            className="w-56 font-mono"
            value={draft}
            placeholder="no_recipients"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                add();
              }
            }}
            data-testid="errors-skip-input"
          />
          <Button size="sm" variant="secondary" onClick={add} data-testid="errors-skip-add">
            {t('errors.settings.add')}
          </Button>
        </div>
      ) : null}
    </Section>
  );
};

const RetentionCard = ({ s, edit }: CardProps) => {
  const save = useSave();
  const [days, setDays] = useState(
    Object.fromEntries(ERROR_SEVERITIES.map((x) => [x, String(s.retention_days[x])])) as Record<ErrorSeverity, string>,
  );
  const [resolve, setResolve] = useState(String(s.auto_resolve_hours));
  const [spike, setSpike] = useState({ factor: String(s.spike.factor), min: String(s.spike.min_count) });
  const [writer, setWriter] = useState({ queue: String(s.writer.max_queue), flush: String(s.writer.flush_seconds) });
  const ok =
    ERROR_SEVERITIES.every((x) => numOk(days[x], 1, 3650)) &&
    numOk(resolve, 0, 8760) &&
    numOk(spike.factor, 1, 100) &&
    numOk(spike.min, 1, 100_000) &&
    numOk(writer.queue, 10, 100_000) &&
    numOk(writer.flush, 1, 60);
  return (
    <Section
      title={t('errors.settings.retention')}
      hint={t('errors.settings.retentionHint')}
      testId="errors-settings-retention"
      canSave={edit && ok}
      busy={save.isPending}
      onSave={() =>
        save.mutate({
          retention_days: Object.fromEntries(ERROR_SEVERITIES.map((x) => [x, Math.round(Number(days[x]))])),
          auto_resolve_hours: Math.round(Number(resolve)),
          spike: { factor: Number(spike.factor), min_count: Math.round(Number(spike.min)) },
          writer: { max_queue: Math.round(Number(writer.queue)), flush_seconds: Math.round(Number(writer.flush)) },
        })
      }
    >
      <div className="flex flex-wrap gap-3">
        {ERROR_SEVERITIES.map((x) => (
          <Num
            key={x}
            label={t('errors.settings.retentionOf', { severity: severityLabel(x) })}
            value={days[x]}
            onChange={(v) => setDays({ ...days, [x]: v })}
            min={1}
            max={3650}
            disabled={!edit}
            testId={`errors-retention-${x}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-3">
        <Num
          label={t('errors.settings.autoResolve')}
          hint={t('errors.settings.autoResolveHint')}
          value={resolve}
          onChange={setResolve}
          min={0}
          max={8760}
          disabled={!edit}
          testId="errors-auto-resolve"
        />
        <Num
          label={t('errors.settings.spikeFactor')}
          value={spike.factor}
          onChange={(factor) => setSpike({ ...spike, factor })}
          min={1}
          max={100}
          disabled={!edit}
        />
        <Num
          label={t('errors.settings.spikeMin')}
          value={spike.min}
          onChange={(min) => setSpike({ ...spike, min })}
          min={1}
          max={100_000}
          disabled={!edit}
        />
        <Num
          label={t('errors.settings.queue')}
          value={writer.queue}
          onChange={(queue) => setWriter({ ...writer, queue })}
          min={10}
          max={100_000}
          disabled={!edit}
        />
        <Num
          label={t('errors.settings.flush')}
          value={writer.flush}
          onChange={(flush) => setWriter({ ...writer, flush })}
          min={1}
          max={60}
          disabled={!edit}
        />
      </div>
    </Section>
  );
};

const newRuleId = () => `r${Date.now().toString(36)}`;

const AlertsCard = ({ s, edit, config }: CardProps & { config: ErrorHubConfig }) => {
  const save = useSave();
  const [rules, setRules] = useState<ErrorAlertRule[]>(s.alerts.rules);
  const [hour, setHour] = useState(s.alerts.digest_hour);
  const [zone, setZone] = useState(s.alerts.timezone);
  const update = (i: number, patch: Partial<ErrorAlertRule>) =>
    setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const ok = rules.every((r) => r.name.trim() && r.threshold >= 1 && r.window_hours >= 1 && r.window_hours <= 168);
  return (
    <Section
      title={t('errors.settings.alerts')}
      hint={t('errors.settings.alertsHint')}
      testId="errors-settings-alerts"
      canSave={edit && ok}
      busy={save.isPending}
      onSave={() => save.mutate({ alerts: { rules, digest_hour: hour, timezone: zone, mutes: s.alerts.mutes } })}
    >
      <div className="flex flex-wrap gap-3">
        <Field label={t('errors.settings.digestHour')}>
          <Picker
            label={t('errors.settings.digestHour')}
            className="w-28"
            value={String(hour)}
            onChange={(v) => setHour(Number(v))}
            options={Array.from({ length: 24 }, (_, h) => ({
              value: String(h),
              label: `${String(h).padStart(2, '0')}:00`,
            }))}
            testId="errors-digest-hour"
          />
        </Field>
        <Field label={t('errors.settings.timezone')}>
          <Picker
            label={t('errors.settings.timezone')}
            className="w-56"
            value={zone}
            onChange={setZone}
            options={timeZones(zone).map((z) => ({ value: z, label: zoneLabel(z) }))}
          />
        </Field>
      </div>
      <ul className="space-y-3">
        {rules.map((r, i) => (
          <li
            key={r.id}
            className="space-y-2 rounded-[12px] border border-line p-3"
            data-testid="errors-rule"
            data-rule={r.id}
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="w-48"
                value={r.name}
                disabled={!edit}
                onChange={(e) => update(i, { name: e.target.value })}
                aria-label={t('errors.rule.name')}
                data-testid="errors-rule-name"
              />
              <Segmented
                label={t('errors.rule.mode')}
                value={r.mode}
                onChange={(mode) => update(i, { mode })}
                options={[
                  { value: 'instant', label: t('errors.rule.instant') },
                  { value: 'digest', label: t('errors.rule.digest') },
                ]}
              />
              <Switch
                checked={r.enabled}
                disabled={!edit}
                label={t('errors.rule.enabled')}
                onChange={(enabled) => update(i, { enabled })}
                testId="errors-rule-enabled"
              />
              {edit ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ms-auto"
                  onClick={() => setRules(rules.filter((_, j) => j !== i))}
                  data-testid="errors-rule-delete"
                >
                  <Icon name="trash" size={14} />
                </Button>
              ) : null}
            </div>
            <SourceChips
              value={r.sources}
              onChange={(sources) => update(i, { sources })}
              disabled={!edit}
              testId="errors-rule-sources"
            />
            <p className="text-xs text-muted">{t('errors.rule.sourcesHint')}</p>
            <div className="flex flex-wrap items-end gap-3">
              <Field label={t('errors.rule.minSeverity')}>
                <Picker
                  label={t('errors.rule.minSeverity')}
                  className="w-32"
                  value={r.min_severity}
                  onChange={(min_severity: ErrorSeverity) => update(i, { min_severity })}
                  options={severityOptions}
                />
              </Field>
              <Num
                label={t('errors.rule.threshold')}
                value={String(r.threshold)}
                onChange={(v) => update(i, { threshold: Number(v) || 0 })}
                min={1}
                max={100_000}
                disabled={!edit}
                testId="errors-rule-threshold"
              />
              <Num
                label={t('errors.rule.window')}
                value={String(r.window_hours)}
                onChange={(v) => update(i, { window_hours: Number(v) || 0 })}
                min={1}
                max={168}
                disabled={!edit}
              />
              <Field label={t('errors.rule.account')}>
                <Picker
                  label={t('errors.rule.account')}
                  className="w-40"
                  value={r.account_id ?? ''}
                  onChange={(v) => update(i, { account_id: v || null })}
                  options={[
                    { value: '', label: t('errors.filter.all') },
                    ...config.accounts.map((a) => ({ value: a.id, label: a.name })),
                  ]}
                />
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-4">
              <Field label={t('errors.rule.audience')}>
                <Picker
                  label={t('errors.rule.audience')}
                  className="w-40"
                  value={r.audience}
                  onChange={(audience) => update(i, { audience })}
                  options={ALERT_AUDIENCES.map((a) => ({ value: a, label: t(`errors.audience.${a}`) }))}
                  testId="errors-rule-audience"
                />
              </Field>
              <Toggle
                label={t('errors.channel.bell')}
                value={r.channels.bell}
                disabled={!edit}
                onChange={(bell) => update(i, { channels: { ...r.channels, bell } })}
              />
              <Toggle
                label={t('errors.channel.email')}
                value={r.channels.email}
                disabled={!edit}
                onChange={(email) => update(i, { channels: { ...r.channels, email } })}
              />
            </div>
            {r.audience === 'people' ? (
              <div className="flex flex-wrap gap-1.5">
                {config.agents.map((a) => {
                  const on = r.user_ids.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      type="button"
                      disabled={!edit}
                      aria-pressed={on}
                      onClick={() =>
                        update(i, { user_ids: on ? r.user_ids.filter((x) => x !== a.id) : [...r.user_ids, a.id] })
                      }
                      className={cn(
                        'h-7 rounded-full border px-2.5 text-xs',
                        on ? 'border-accent bg-accent-soft text-accent-fg' : 'border-line text-fg-2',
                      )}
                    >
                      {a.name}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {edit ? (
        <Button
          size="sm"
          variant="dashed"
          onClick={() =>
            setRules([
              ...rules,
              {
                id: newRuleId(),
                name: t('errors.rule.new'),
                enabled: true,
                sources: [],
                min_severity: 'error',
                account_id: null,
                threshold: 1,
                window_hours: 1,
                mode: 'instant',
                channels: { bell: true, email: true },
                audience: 'support_team',
                user_ids: [],
              },
            ])
          }
          data-testid="errors-rule-add"
        >
          <Icon name="plus" size={14} />
          {t('errors.rule.add')}
        </Button>
      ) : null}
    </Section>
  );
};

const MUTE_DAYS = [1, 7, 30, 90];

const MutesCard = ({ s, edit, config }: CardProps & { config: ErrorHubConfig }) => {
  const save = useSave();
  const [mutes, setMutes] = useState<ErrorMute[]>(s.alerts.mutes);
  const [draft, setDraft] = useState<{ source: string; account: string; text: string; days: string }>({
    source: '',
    account: '',
    text: '',
    days: '7',
  });
  const add = () =>
    setMutes([
      ...mutes,
      {
        id: `m${Date.now().toString(36)}`,
        source: (draft.source || null) as ErrorSource | null,
        account_id: draft.account || null,
        text: draft.text.trim() || null,
        until: new Date(Date.now() + Number(draft.days) * 86_400_000).toISOString(),
      },
    ]);
  const accountName = (id: string | null) => config.accounts.find((a) => a.id === id)?.name;
  return (
    <Section
      title={t('errors.settings.mutes')}
      hint={t('errors.settings.mutesHint')}
      testId="errors-settings-mutes"
      canSave={edit}
      busy={save.isPending}
      onSave={() => save.mutate({ alerts: { ...s.alerts, mutes } })}
    >
      <ul className="space-y-1">
        {mutes.map((m) => (
          <li key={m.id} className="flex items-center gap-2 text-sm" data-testid="errors-mute">
            <span className="min-w-0 flex-1 truncate">
              {[m.source ? sourceLabel(m.source) : null, accountName(m.account_id), m.text ? `"${m.text}"` : null]
                .filter(Boolean)
                .join(' · ') || t('errors.filter.all')}
            </span>
            <span className="text-xs text-muted">{t('errors.mutedUntil', { date: formatDateTime(m.until) })}</span>
            {edit ? (
              <Button size="sm" variant="ghost" onClick={() => setMutes(mutes.filter((x) => x.id !== m.id))}>
                <Icon name="trash" size={14} />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {edit ? (
        <div className="flex flex-wrap items-end gap-2">
          <Picker
            label={t('errors.field.source')}
            className="w-32"
            value={draft.source}
            onChange={(source) => setDraft({ ...draft, source })}
            options={[
              { value: '', label: t('errors.filter.all') },
              ...ERROR_SOURCES.map((x) => ({ value: x, label: sourceLabel(x) })),
            ]}
          />
          <Picker
            label={t('errors.field.account')}
            className="w-40"
            value={draft.account}
            onChange={(account) => setDraft({ ...draft, account })}
            options={[
              { value: '', label: t('errors.filter.all') },
              ...config.accounts.map((a) => ({ value: a.id, label: a.name })),
            ]}
          />
          <Input
            className="w-40"
            value={draft.text}
            placeholder={t('errors.mute.text')}
            onChange={(e) => setDraft({ ...draft, text: e.target.value })}
          />
          <Picker
            label={t('errors.mute.for')}
            className="w-28"
            value={draft.days}
            onChange={(days) => setDraft({ ...draft, days })}
            options={MUTE_DAYS.map((d) => ({ value: String(d), label: t('errors.mute.days', { n: d }) }))}
          />
          <Button size="sm" variant="secondary" onClick={add} data-testid="errors-mute-add">
            {t('errors.settings.add')}
          </Button>
        </div>
      ) : null}
    </Section>
  );
};

const AccountPageCard = ({ s, edit }: CardProps) => {
  const save = useSave();
  const [p, setP] = useState(s.account_page);
  const [threshold, setThreshold] = useState(String(s.account_page.admin_alerts.threshold));
  const [windowHours, setWindowHours] = useState(String(s.account_page.admin_alerts.window_hours));
  const ok = numOk(threshold, 1, 100_000) && numOk(windowHours, 1, 168);
  return (
    <Section
      title={t('errors.settings.accountPage')}
      hint={t('errors.settings.accountPageHint')}
      testId="errors-settings-account"
      canSave={edit && ok}
      busy={save.isPending}
      onSave={() =>
        save.mutate({
          account_page: {
            ...p,
            admin_alerts: { ...p.admin_alerts, threshold: Number(threshold), window_hours: Number(windowHours) },
          },
        })
      }
    >
      <Toggle
        label={t('errors.settings.accountPageOn')}
        value={p.enabled}
        disabled={!edit}
        onChange={(enabled) => setP({ ...p, enabled })}
        testId="errors-account-page"
      />
      <SourceChips
        value={p.sources}
        onChange={(sources) => setP({ ...p, sources })}
        disabled={!edit}
        testId="errors-account-sources"
      />
      <Toggle
        label={t('errors.settings.adminAlerts')}
        value={p.admin_alerts.enabled}
        disabled={!edit}
        onChange={(enabled) => setP({ ...p, admin_alerts: { ...p.admin_alerts, enabled } })}
        testId="errors-admin-alerts"
      />
      <div className="flex flex-wrap items-end gap-3">
        <Field label={t('errors.rule.minSeverity')}>
          <Picker
            label={t('errors.rule.minSeverity')}
            className="w-32"
            value={p.admin_alerts.min_severity}
            onChange={(min_severity: ErrorSeverity) =>
              setP({ ...p, admin_alerts: { ...p.admin_alerts, min_severity } })
            }
            options={severityOptions}
          />
        </Field>
        <Num
          label={t('errors.rule.threshold')}
          value={threshold}
          onChange={setThreshold}
          min={1}
          max={100_000}
          disabled={!edit}
        />
        <Num
          label={t('errors.rule.window')}
          value={windowHours}
          onChange={setWindowHours}
          min={1}
          max={168}
          disabled={!edit}
        />
      </div>
    </Section>
  );
};

const ClientCard = ({ s, edit }: CardProps) => {
  const save = useSave();
  const [on, setOn] = useState(s.client.enabled);
  const [rate, setRate] = useState(String(Math.round(s.client.sample_rate * 100)));
  const [perHour, setPerHour] = useState(String(s.client.per_user_per_hour));
  const ok = numOk(rate, 0, 100) && numOk(perHour, 1, 1000);
  return (
    <Section
      title={t('errors.settings.client')}
      hint={t('errors.settings.clientHint')}
      testId="errors-settings-client"
      canSave={edit && ok}
      busy={save.isPending}
      onSave={() =>
        save.mutate({
          client: { enabled: on, sample_rate: Number(rate) / 100, per_user_per_hour: Math.round(Number(perHour)) },
        })
      }
    >
      <Toggle
        label={t('errors.settings.clientOn')}
        value={on}
        disabled={!edit}
        onChange={setOn}
        testId="errors-client-on"
      />
      <div className="flex flex-wrap gap-3">
        <Num
          label={t('errors.settings.sampleRate')}
          value={rate}
          onChange={setRate}
          min={0}
          max={100}
          disabled={!edit}
        />
        <Num
          label={t('errors.settings.perHour')}
          value={perHour}
          onChange={setPerHour}
          min={1}
          max={1000}
          disabled={!edit}
        />
      </div>
    </Section>
  );
};

const GlitchtipCard = ({ s, edit }: CardProps) => {
  const save = useSave();
  const [url, setUrl] = useState(s.glitchtip.base_url ?? '');
  const [org, setOrg] = useState(s.glitchtip.organization ?? '');
  return (
    <Section
      title={t('errors.settings.glitchtip')}
      hint={t('errors.settings.glitchtipHint')}
      testId="errors-settings-glitchtip"
      canSave={edit}
      busy={save.isPending}
      onSave={() => save.mutate({ glitchtip: { base_url: url.trim() || null, organization: org.trim() || null } })}
    >
      <div className="flex flex-wrap gap-3">
        <Field label={t('errors.settings.glitchtipUrl')}>
          <Input
            dir="ltr"
            className="w-72"
            value={url}
            disabled={!edit}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
          />
        </Field>
        <Field label={t('errors.settings.glitchtipOrg')}>
          <Input dir="ltr" className="w-48" value={org} disabled={!edit} onChange={(e) => setOrg(e.target.value)} />
        </Field>
      </div>
    </Section>
  );
};
