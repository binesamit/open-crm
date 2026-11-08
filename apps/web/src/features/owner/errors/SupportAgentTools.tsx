// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SUPPORT_LOG_KINDS,
  type SupportAgentSettingsDto,
  type SupportLogKind,
  type SupportLogSourceDto,
  type UpdateSupportAgentSettings,
  t,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, Card, Field, Input, Picker, Switch } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { showToast } from '../../../lib/toast';
import { supportAgentKeys, useSupportAgentSettings } from './SupportAgent';
import { OpsTaskTypes } from './SupportAgentOps';

/**
 * Errors & health → Settings → "Support agent — tools" (phase 3): where the agent reads logs (sources
 * of any provider kind, tokens sealed), read-only SQL (the platform owner turns it on), and auto-investigation of new
 * errors. The owner and leads edit; everyone in the console reads.
 */
const useSave = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateSupportAgentSettings) =>
      api().patch<SupportAgentSettingsDto>('/platform/support-agent/settings', patch),
    onSuccess: (res) => {
      qc.setQueryData(supportAgentKeys.settings, res);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
};

export const SupportAgentToolsCard = () => {
  const q = useSupportAgentSettings();
  if (!q.data) return null;
  const s = q.data;
  return (
    <Card className="space-y-4" data-testid="support-agent-tools" data-editable={s.can_edit ? 'true' : 'false'}>
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-fg">{t('supportAgent.tools.title')}</h3>
        <p className="text-xs text-muted">{t('supportAgent.tools.hint')}</p>
      </div>
      <LogSources s={s} />
      <SqlSwitch key={`sql${String(s.sql.enabled)}`} s={s} />
      <AutoSettings key={JSON.stringify(s.auto)} s={s} />
      <OpsTaskTypes s={s} />
    </Card>
  );
};

const LogSources = ({ s }: { s: SupportAgentSettingsDto }) => {
  const save = useSave();
  const [editing, setEditing] = useState<SupportLogSourceDto | 'new' | null>(null);
  return (
    <section className="space-y-2" data-testid="support-agent-logs">
      <h4 className="text-xs text-fg-2">{t('supportAgent.logs.title')}</h4>
      <p className="text-xs text-muted">{t('supportAgent.logs.hint')}</p>
      {s.log_sources.length ? (
        <ul className="space-y-1.5">
          {s.log_sources.map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-center gap-2 rounded-[8px] bg-surface-2 px-2.5 py-1.5 text-sm"
              data-testid="support-agent-log-source"
            >
              <span className="flex-1">{l.name}</span>
              <Badge>{tDynamic(`supportAgent.logs.kind.${l.kind}`)}</Badge>
              {l.has_token ? null : <Badge tone="danger">{t('supportAgent.logs.noToken')}</Badge>}
              {s.can_edit ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(l)}>
                    {t('common.edit')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={save.isPending}
                    onClick={() => save.mutate({ remove_log_source: l.id })}
                    data-testid="support-agent-log-remove"
                  >
                    {t('common.delete')}
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">{t('supportAgent.logs.none')}</p>
      )}
      {editing ? (
        <SourceForm
          key={editing === 'new' ? 'new' : editing.id}
          source={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : s.can_edit ? (
        <Button size="sm" variant="secondary" onClick={() => setEditing('new')} data-testid="support-agent-log-add">
          {t('supportAgent.logs.add')}
        </Button>
      ) : null}
    </section>
  );
};

const SourceForm = ({ source, onDone }: { source: SupportLogSourceDto | null; onDone: () => void }) => {
  const qc = useQueryClient();
  const [kind, setKind] = useState<SupportLogKind>(source?.kind ?? 'railway');
  const [name, setName] = useState(source?.name ?? '');
  const [token, setToken] = useState('');
  const [env, setEnv] = useState(source?.environment_id ?? '');
  const [service, setService] = useState(source?.service_id ?? '');
  const [base, setBase] = useState(source?.base_url ?? '');
  const [org, setOrg] = useState(source?.org ?? '');
  const [project, setProject] = useState(source?.project ?? '');
  const save = useMutation({
    mutationFn: () =>
      api().patch<SupportAgentSettingsDto>('/platform/support-agent/settings', {
        log_source: {
          ...(source ? { id: source.id } : {}),
          kind,
          name: name.trim(),
          ...(token.trim() ? { token: token.trim() } : {}),
          ...(kind === 'railway'
            ? { environment_id: env.trim() || null, service_id: service.trim() || null }
            : { base_url: base.trim() || null, org: org.trim() || null, project: project.trim() || null }),
        },
      }),
    onSuccess: (res) => {
      qc.setQueryData(supportAgentKeys.settings, res);
      showToast({ message: t('admin.general.saved') });
      onDone();
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const field = (label: string, value: string, set: (v: string) => void, testId: string, wide = false) => (
    <Field label={label}>
      <Input
        dir="ltr"
        className={wide ? 'w-72' : 'w-48'}
        value={value}
        onChange={(e) => set(e.target.value)}
        data-testid={testId}
      />
    </Field>
  );
  return (
    <div className="space-y-2 rounded-[10px] border border-line p-2.5" data-testid="support-agent-log-form">
      <div className="flex flex-wrap gap-3">
        <Field label={t('supportAgent.logs.kind')}>
          <Picker
            label={t('supportAgent.logs.kind')}
            className="w-56"
            value={kind}
            onChange={setKind}
            testId="support-agent-log-kind"
            options={SUPPORT_LOG_KINDS.map((k) => ({ value: k, label: tDynamic(`supportAgent.logs.kind.${k}`) }))}
          />
        </Field>
        <Field label={t('supportAgent.logs.name')}>
          <Input
            className="w-48"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="support-agent-log-name"
          />
        </Field>
      </div>
      <p className="text-xs text-muted">{tDynamic(`supportAgent.logs.kindHint.${kind}`)}</p>
      <div className="flex flex-wrap gap-3">
        {kind === 'railway' ? (
          <>
            {field(t('supportAgent.logs.environment'), env, setEnv, 'support-agent-log-env', true)}
            {field(t('supportAgent.logs.service'), service, setService, 'support-agent-log-service', true)}
          </>
        ) : (
          <>
            {field(t('supportAgent.logs.baseUrl'), base, setBase, 'support-agent-log-base', true)}
            {field(t('supportAgent.logs.org'), org, setOrg, 'support-agent-log-org')}
            {field(t('supportAgent.logs.project'), project, setProject, 'support-agent-log-project')}
          </>
        )}
        <Field
          label={t('supportAgent.logs.token')}
          hint={
            source?.has_token ? t('supportAgent.settings.tokenSaved', { hint: source.token_hint ?? '' }) : undefined
          }
        >
          <Input
            type="password"
            autoComplete="off"
            dir="ltr"
            className="w-72"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            data-testid="support-agent-log-token"
          />
        </Field>
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="accent"
          busy={save.isPending}
          disabled={!name.trim() || (!source && !token.trim())}
          onClick={() => save.mutate()}
          data-testid="support-agent-log-save"
        >
          {t('common.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};

const SqlSwitch = ({ s }: { s: SupportAgentSettingsDto }) => {
  const save = useSave();
  return (
    <section className="space-y-1.5" data-testid="support-agent-sql">
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-fg">{t('supportAgent.sql.title')}</span>
        <Switch
          checked={s.sql.enabled}
          onChange={(v) => save.mutate({ sql_enabled: v })}
          label={t('supportAgent.sql.title')}
          disabled={!s.may_sql || save.isPending}
          testId="support-agent-sql-enabled"
        />
      </label>
      <p className="text-xs text-muted">{t(s.may_sql ? 'supportAgent.sql.hint' : 'supportAgent.sql.ownerOnly')}</p>
    </section>
  );
};

const SEVERITIES = ['warning', 'error', 'critical'] as const;

const AutoSettings = ({ s }: { s: SupportAgentSettingsDto }) => {
  const save = useSave();
  const [enabled, setEnabled] = useState(s.auto.enabled);
  const [severities, setSeverities] = useState<(typeof SEVERITIES)[number][]>(s.auto.severities);
  const [perDay, setPerDay] = useState(String(s.auto.max_per_day));
  const ok = /^\d+$/.test(perDay) && Number(perDay) >= 1 && Number(perDay) <= 200 && severities.length > 0;
  return (
    <section className="space-y-2" data-testid="support-agent-auto">
      <label className="flex items-center justify-between gap-3">
        <span className="text-sm text-fg">{t('supportAgent.auto.title')}</span>
        <Switch
          checked={enabled}
          onChange={setEnabled}
          label={t('supportAgent.auto.title')}
          disabled={!s.can_edit}
          testId="support-agent-auto-enabled"
        />
      </label>
      <p className="text-xs text-muted">{t('supportAgent.auto.hint')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('supportAgent.auto.severities')}>
          {SEVERITIES.map((v) => {
            const on = severities.includes(v);
            return (
              <button
                key={v}
                type="button"
                aria-pressed={on}
                disabled={!s.can_edit}
                onClick={() => setSeverities(on ? severities.filter((x) => x !== v) : [...severities, v])}
                className={
                  on
                    ? 'min-h-6 rounded-full border border-primary bg-primary-soft px-2.5 text-xs text-heading'
                    : 'min-h-6 rounded-full border border-line px-2.5 text-xs text-fg-2 hover:bg-surface-2'
                }
                data-testid={`support-agent-auto-${v}`}
              >
                {tDynamic(`errors.severity.${v}`)}
              </button>
            );
          })}
        </div>
        <Field label={t('supportAgent.auto.perDay')}>
          <Input
            inputMode="numeric"
            dir="ltr"
            className="w-24 text-end tabular-nums"
            value={perDay}
            disabled={!s.can_edit}
            onChange={(e) => setPerDay(e.target.value)}
            data-testid="support-agent-auto-per-day"
          />
        </Field>
        {s.can_edit ? (
          <Button
            size="sm"
            variant="accent"
            disabled={!ok}
            busy={save.isPending}
            onClick={() => save.mutate({ auto: { enabled, severities, max_per_day: Number(perDay) } })}
            data-testid="support-agent-auto-save"
          >
            {t('common.save')}
          </Button>
        ) : null}
      </div>
    </section>
  );
};
