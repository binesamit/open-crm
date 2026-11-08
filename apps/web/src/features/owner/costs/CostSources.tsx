// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  COST_ADAPTER_DEFS,
  COST_ADAPTERS,
  type CostAdapter,
  type CostFieldDef,
  type CostSource,
  type CostSourceInput,
  type CostTestResult,
  formatDateTime,
  t,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, Calendar, Card, Dialog, Field, Input, Notice, Picker, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { confirmDialog } from '../../../lib/dialogs';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { Popover } from '../../board/cells/Popover';
import {
  adapterLabel,
  COSTS_KEY,
  metricLabel,
  sourceLabel,
  syncErrorText,
  useCostSettings,
  useCostSources,
} from './costs-api';

const fail = (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' });

/** A day picked from the app's own calendar (never the browser's). */
const DayField = ({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId: string }) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative flex items-center gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid={testId}
        className="flex h-9 min-w-[160px] items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-2.5 text-sm text-fg hover:bg-surface-2"
      >
        <Icon name="calendar" size={16} />
        {value || '—'}
      </button>
      {value ? (
        <Button size="sm" variant="ghost" onClick={() => onChange('')}>
          ✕
        </Button>
      ) : null}
      <Popover open={open} onClose={() => setOpen(false)} align="start" className="p-2">
        <Calendar
          mode="single"
          value={(value || null) as never}
          onChange={(d) => {
            onChange(d ?? '');
            setOpen(false);
          }}
        />
      </Popover>
    </span>
  );
};

/** One adapter setting, by its kind (labels and options from i18n `costs.field.*` / `costs.option.*`). */
const ConfigField = ({ def, value, onChange }: { def: CostFieldDef; value: string; onChange: (v: string) => void }) => {
  const label = tDynamic(`costs.field.${def.key}`);
  return (
    <Field label={def.required ? `${label} *` : label}>
      {def.kind === 'select' ? (
        <Picker
          value={value}
          label={label}
          onChange={onChange}
          options={(def.options ?? []).map((o) => ({
            value: o,
            label: tDynamic(`costs.option.${def.key}.${o}`),
            testId: `cost-field-${def.key}-${o}`,
          }))}
          testId={`cost-field-${def.key}`}
        />
      ) : def.kind === 'date' ? (
        <DayField value={value} onChange={onChange} testId={`cost-field-${def.key}`} />
      ) : (
        <Input
          value={value}
          dir="ltr"
          className="text-start"
          placeholder={def.example}
          inputMode={def.kind === 'number' ? 'decimal' : undefined}
          onChange={(e) =>
            onChange(def.kind === 'currency' ? e.target.value.toUpperCase().slice(0, 3) : e.target.value)
          }
          data-testid={`cost-field-${def.key}`}
        />
      )}
    </Field>
  );
};

/** New source / edit one: kind, name, its settings, the key (write-only), a budget; step-by-step help for the key. */
const SourceDialog = ({ source, onClose }: { source: CostSource | null; onClose: () => void }) => {
  const qc = useQueryClient();
  const settings = useCostSettings();
  const kinds = COST_ADAPTERS.filter((a) => !COST_ADAPTER_DEFS[a].single);
  const [adapter, setAdapter] = useState<CostAdapter>(source?.adapter ?? 'railway');
  const def = COST_ADAPTER_DEFS[adapter];
  const [name, setName] = useState(source?.name ?? '');
  const [config, setConfig] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(source?.config ?? {}).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]),
    ),
  );
  const [secret, setSecret] = useState('');
  const [budget, setBudget] = useState(source?.budget_monthly === null || !source ? '' : String(source.budget_monthly));
  const fieldValue = (f: CostFieldDef) => config[f.key] ?? (f.kind === 'select' ? (f.options?.[0] ?? '') : '');
  const save = useMutation({
    mutationFn: () => {
      const cfg = Object.fromEntries(
        def.fields
          .map((f) => [f.key, fieldValue(f)] as const)
          .filter(([, v]) => v !== '')
          .map(([k, v]) => [k, def.fields.find((f) => f.key === k)?.kind === 'number' ? Number(v) : v]),
      );
      const budgetValue = budget.trim() === '' ? null : Number(budget);
      const body: Partial<CostSourceInput> = {
        name: name.trim() || null,
        config: cfg,
        budget_monthly: budgetValue,
        ...(secret.trim() ? { secret: secret.trim() } : {}),
      };
      return source
        ? api().patch<CostSource>(`/platform/costs/sources/${source.id}`, body)
        : api().post<CostSource>('/platform/costs/sources', { ...body, adapter });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: COSTS_KEY });
      showToast({ message: t('costs.settings.saved') });
      onClose();
    },
    onError: fail,
  });
  const missing =
    def.fields.some((f) => f.required && !fieldValue(f).trim()) || (!source && def.secret && !secret.trim());
  return (
    <Dialog
      open
      onClose={onClose}
      title={source ? t('costs.source.edit') : t('costs.source.add')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => save.mutate()} busy={save.isPending} disabled={missing} data-testid="cost-source-save">
            {t('costs.source.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="cost-source-dialog">
        {source ? null : (
          <Field label={t('costs.source.adapter')}>
            <Picker
              value={adapter}
              label={t('costs.source.adapter')}
              onChange={(a) => {
                setAdapter(a);
                setConfig({});
              }}
              options={kinds.map((a) => ({
                value: a,
                label: adapterLabel(a),
                hint: tDynamic(`costs.adapterHint.${a}`),
                testId: `cost-source-adapter-${a}`,
              }))}
              testId="cost-source-adapter"
            />
          </Field>
        )}
        <p className="text-xs text-muted">{tDynamic(`costs.adapterHint.${adapter}`)}</p>
        {def.single ? null : (
          <Field label={t('costs.source.name')}>
            <Input value={name} dir="auto" onChange={(e) => setName(e.target.value)} data-testid="cost-source-name" />
          </Field>
        )}
        {def.fields.map((f) => (
          <ConfigField
            key={f.key}
            def={f}
            value={fieldValue(f)}
            onChange={(v) => setConfig({ ...config, [f.key]: v })}
          />
        ))}
        {def.secret ? (
          <Field
            label={t('costs.source.key')}
            hint={source?.secret_set ? t('costs.source.keySet', { hint: source.secret_hint ?? '' }) : undefined}
          >
            <Input
              type="password"
              autoComplete="off"
              value={secret}
              dir="ltr"
              className="text-start"
              onChange={(e) => setSecret(e.target.value)}
              data-testid="cost-source-key"
            />
          </Field>
        ) : null}
        <Notice tone="info">
          <span className="block">{tDynamic(`costs.help.${adapter}`)}</span>
          {def.key_url ? (
            <a
              href={def.key_url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-primary hover:underline"
              data-testid="cost-source-key-page"
            >
              {t('costs.help.openKeyPage')}
            </a>
          ) : null}
        </Notice>
        {def.single ? null : (
          <Field label={t('costs.source.budget')}>
            <Input
              value={budget}
              inputMode="decimal"
              dir="ltr"
              className="text-start"
              onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))}
              data-testid="cost-source-budget"
            />
          </Field>
        )}
        {source ? null : (
          <p className="text-xs text-muted">
            {def.backfill
              ? t('costs.source.backfillNote', { days: settings.data?.backfill_days ?? 30 })
              : t('costs.source.todayOnly')}
          </p>
        )}
      </div>
    </Dialog>
  );
};

const testText = (r: CostTestResult) => {
  if (!r.ok) return syncErrorText(r.error);
  const entries = Object.entries(r.sample ?? {});
  return entries.length
    ? t('costs.source.testOk', { sample: entries.map(([m, v]) => `${metricLabel(m)}: ${v}`).join(' · ') })
    : t('costs.source.testOkEmpty');
};

const SourceCard = ({ source, onEdit }: { source: CostSource; onEdit: () => void }) => {
  const qc = useQueryClient();
  const [test, setTest] = useState<CostTestResult | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: COSTS_KEY });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api().patch(`/platform/costs/sources/${source.id}`, { enabled }),
    onSuccess: refresh,
    onError: fail,
  });
  const sync = useMutation({
    mutationFn: () => api().post('/platform/costs/sync', { source_id: source.id }),
    onSuccess: async () => {
      await refresh();
      showToast({ message: t('costs.source.syncQueued') });
    },
    onError: fail,
  });
  const runTest = useMutation({
    mutationFn: () => api().post<CostTestResult>(`/platform/costs/sources/${source.id}/test`),
    onSuccess: setTest,
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api().delete(`/platform/costs/sources/${source.id}`),
    onSuccess: refresh,
    onError: fail,
  });
  const single = COST_ADAPTER_DEFS[source.adapter].single;
  const status = !source.enabled ? (
    <Badge tone="neutral">{t('costs.source.off')}</Badge>
  ) : source.syncing ? (
    <Badge tone="neutral">{t('costs.source.syncing')}</Badge>
  ) : source.last_sync_ok === false ? (
    <Badge tone="danger">{t('costs.source.failed')}</Badge>
  ) : source.last_sync_ok ? (
    <Badge tone="ok">{t('costs.source.ok')}</Badge>
  ) : null;
  return (
    <Card className="space-y-2" data-testid="cost-source" data-adapter={source.adapter}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-fg" dir="auto">
            {sourceLabel(source)}
          </div>
          <div className="text-xs text-muted">
            {source.name ? `${adapterLabel(source.adapter)} · ` : ''}
            {source.last_sync_at
              ? t('costs.source.lastSync', { when: formatDateTime(source.last_sync_at) })
              : t('costs.source.neverSynced')}
          </div>
        </div>
        {status}
        <Switch
          checked={source.enabled}
          onChange={(on) => toggle.mutate(on)}
          label={t('costs.source.enabled')}
          testId="cost-source-enabled"
        />
      </div>
      {source.last_sync_ok === false && source.last_error ? (
        <Notice tone="error">
          <div data-testid="cost-source-error">{syncErrorText(source.last_error)}</div>
        </Notice>
      ) : null}
      {test ? (
        <Notice tone={test.ok ? 'success' : 'error'}>
          <div data-testid="cost-source-test-result">{testText(test)}</div>
        </Notice>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => sync.mutate()}
          busy={sync.isPending}
          disabled={!source.enabled || source.syncing}
          data-testid="cost-source-sync"
        >
          {t('costs.source.syncNow')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => runTest.mutate()}
          busy={runTest.isPending}
          data-testid="cost-source-test"
        >
          {t('costs.source.test')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onEdit} data-testid="cost-source-edit">
          {t('costs.source.edit')}
        </Button>
        {single ? null : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void confirmDialog({
                title: t('costs.source.deleteConfirm'),
                confirmLabel: t('costs.source.delete'),
                danger: true,
              }).then((ok) => ok && remove.mutate())
            }
            data-testid="cost-source-delete"
          >
            {t('costs.source.delete')}
          </Button>
        )}
      </div>
    </Card>
  );
};

/** Costs → Sources: the platform's own measurements and every connected provider, with its last sync. */
export const CostSources = ({ addOpen, onAddClosed }: { addOpen?: boolean; onAddClosed?: () => void }) => {
  const qc = useQueryClient();
  const list = useCostSources();
  const [editing, setEditing] = useState<CostSource | 'new' | null>(addOpen ? 'new' : null);
  const syncAll = useMutation({
    mutationFn: () => api().post('/platform/costs/sync', {}),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: COSTS_KEY });
      showToast({ message: t('costs.source.syncQueued') });
    },
    onError: fail,
  });
  const close = () => {
    setEditing(null);
    onAddClosed?.();
  };
  return (
    <div className="space-y-2.5" data-testid="cost-sources">
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => syncAll.mutate()}
          busy={syncAll.isPending}
          data-testid="cost-sync-all"
        >
          {t('costs.source.syncAll')}
        </Button>
        <Button size="sm" variant="accent" onClick={() => setEditing('new')} data-testid="cost-source-new">
          {t('costs.source.add')}
        </Button>
      </div>
      {list.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {list.isError ? <Notice tone="error">{errorMessage(list.error)}</Notice> : null}
      {(list.data ?? []).map((s) => (
        <SourceCard key={s.id} source={s} onEdit={() => setEditing(s)} />
      ))}
      {editing ? (
        <SourceDialog
          key={editing === 'new' ? 'new' : editing.id}
          source={editing === 'new' ? null : editing}
          onClose={close}
        />
      ) : null}
    </div>
  );
};
