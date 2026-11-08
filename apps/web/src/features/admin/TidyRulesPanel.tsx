// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  type MyAccount,
  t,
  TIDY_RULE_DEFS,
  TIDY_RULE_KEYS,
  type TidyPreview,
  type TidyRule,
  type TidyRuleKey,
  type TidyRun,
  type TidySettings,
  type UpdateTidyRules,
} from '@bines/shared';
import { Badge, Button, Input, Menu, Notice, SkeletonRows, Switch, useActionMenu } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { downloadFrom } from '../../lib/download';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { useWorkspaces } from '../board/board-api';
import { reasonMessage } from '../account/CopyLink';
import { Ago } from '../trash/TrashPage';
import { Panel, Row } from './admin-parts';

/**
 * Administration → סדר וניקיון → ניקוי מתוזמן (M8 ד13): the account's cleaning rules, run every night. Rules that touch
 * people's content are off until an admin turns them on; technical retention is on. "בדיקה" shows what a run would do
 * now (counts and examples, nothing changes); "הרצה עכשיו" runs the enabled rules; each run has a report and a CSV.
 */
const keys = {
  rules: (accountId: string) => ['account', accountId, 'admin', 'tidy', 'rules'] as const,
  runs: (accountId: string) => ['account', accountId, 'admin', 'tidy', 'runs'] as const,
};
const fail = (err: unknown) => showToast({ message: reasonMessage(err), tone: 'error' });
const statusTone = (s: TidyRun['status']) => (s === 'succeeded' ? 'ok' : s === 'partial' ? 'warn' : 'danger');

const DaysField = ({ rule, value, onSave }: { rule: TidyRuleKey; value: number; onSave: (days: number) => void }) => {
  const def = TIDY_RULE_DEFS[rule];
  const [draft, setDraft] = useState(String(value));
  const n = Number(draft);
  const valid = Number.isInteger(n) && n >= def.min && n <= def.max;
  const commit = () => {
    if (valid && n !== value) onSave(n);
    else if (!valid) setDraft(String(value));
  };
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 4))}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        inputMode="numeric"
        dir="ltr"
        className="h-8 w-16 text-center"
        aria-label={t('sec2.tidy.days')}
        title={t('sec2.tidy.range', { min: def.min, max: def.max })}
        data-testid={`tidy-days-${rule}`}
      />
      {t('sec2.tidy.daysUnit')}
    </label>
  );
};

const ExcludeWorkspaces = ({
  account,
  rule,
  value,
  onSave,
}: {
  account: MyAccount;
  rule: TidyRuleKey;
  value: string[];
  onSave: (ids: string[]) => void;
}) => {
  const workspaces = useWorkspaces(account.id);
  const menu = useActionMenu();
  const list = workspaces.data?.data ?? [];
  const toggle = (id: string) => onSave(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={menu.fromTrigger}
        disabled={!list.length}
        data-testid={`tidy-exclude-${rule}`}
        data-count={value.length}
      >
        {value.length ? t('sec2.tidy.excluded', { n: value.length }) : t('sec2.tidy.excludeNone')}
      </Button>
      <Menu
        at={menu.at}
        onClose={menu.close}
        label={t('sec2.tidy.exclude')}
        items={[
          { kind: 'label', label: t('sec2.tidy.exclude') },
          ...list.map((w) => ({
            label: w.name,
            checked: value.includes(w.id),
            onSelect: () => toggle(w.id),
            testId: 'tidy-exclude-option',
          })),
        ]}
      />
    </>
  );
};

export const TidyRulesPanel = ({ account }: { account: MyAccount }) => {
  const qc = useQueryClient();
  const client = api(account.id);
  const settings = useQuery({
    queryKey: keys.rules(account.id),
    queryFn: () => client.get<TidySettings>('/admin/tidy/rules'),
  });
  const runs = useQuery({
    queryKey: keys.runs(account.id),
    queryFn: () => client.get<{ data: TidyRun[] }>('/admin/tidy/runs'),
  });
  const [preview, setPreview] = useState<TidyPreview | null>(null);
  const [now] = useState(() => Date.now());
  const [history, setHistory] = useState(false);
  const save = useMutation({
    mutationFn: (patch: UpdateTidyRules) => client.put<TidySettings>('/admin/tidy/rules', patch),
    onSuccess: (data) => {
      qc.setQueryData(keys.rules(account.id), data);
      setPreview(null);
      showToast({ message: t('admin.general.saved') });
    },
    onError: fail,
  });
  const check = useMutation({
    mutationFn: () => client.post<TidyPreview>('/admin/tidy/preview', {}),
    onSuccess: setPreview,
    onError: fail,
  });
  const run = useMutation({
    mutationFn: () => client.post<TidyRun>('/admin/tidy/run'),
    onSuccess: async (r) => {
      setPreview(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.rules(account.id) }),
        qc.invalidateQueries({ queryKey: keys.runs(account.id) }),
        qc.invalidateQueries({ queryKey: ['account', account.id, 'admin', 'boards'] }),
      ]);
      showToast({ message: t('sec2.tidy.ran', { n: r.results.reduce((s, x) => s + x.count, 0) }) });
    },
    onError: fail,
  });
  const patch = (rule: TidyRuleKey, value: Partial<TidyRule>) => save.mutate({ [rule]: value });
  const runNow = async () => {
    const ok = await confirmDialog({
      title: t('sec2.tidy.runConfirm'),
      message: t('sec2.tidy.runHint'),
      confirmLabel: t('sec2.tidy.runNow'),
    });
    if (ok) run.mutate();
  };
  const csv = (r: TidyRun) =>
    downloadFrom(account.id, `/admin/tidy/runs/${r.id}/export.csv`, `tidy-${r.started_at.slice(0, 10)}.csv`).catch(
      fail,
    );

  if (settings.isPending) return <SkeletonRows rows={4} label={t('app.loading')} />;
  if (settings.isError) return <Notice tone="error">{errorMessage(settings.error)}</Notice>;
  const rules = settings.data.rules;
  const anyOn = TIDY_RULE_KEYS.some((k) => rules[k].enabled);
  const count = (rule: TidyRuleKey) => preview?.results.find((r) => r.rule === rule)?.count;
  const last = settings.data.last_run;

  return (
    <Panel
      title={t('sec2.tidy.title')}
      hint={t('sec2.tidy.hint')}
      testId="tidy-rules"
      actions={
        <>
          <Button
            variant="secondary"
            size="sm"
            busy={check.isPending}
            disabled={!anyOn}
            onClick={() => check.mutate()}
            data-testid="tidy-preview"
          >
            <Icon name="search" size={14} />
            {t('sec2.tidy.preview')}
          </Button>
          <Button
            size="sm"
            busy={run.isPending}
            disabled={!anyOn}
            onClick={() => void runNow()}
            data-testid="tidy-run-now"
          >
            {t('sec2.tidy.runNow')}
          </Button>
        </>
      }
    >
      {TIDY_RULE_KEYS.map((rule) => {
        const r = rules[rule];
        const n = count(rule);
        return (
          <Row
            key={rule}
            label={t(`sec2.tidy.rule.${rule}`)}
            hint={
              <>
                {t(`sec2.tidy.rule.${rule}.hint`)}
                {TIDY_RULE_DEFS[rule].technical ? (
                  <span className="ms-1.5 align-middle">
                    <Badge tone="neutral">{t('sec2.tidy.technical')}</Badge>
                  </span>
                ) : null}
              </>
            }
            testId={`tidy-rule-${rule}`}
          >
            {n !== undefined ? (
              <span data-testid={`tidy-count-${rule}`} data-count={n}>
                <Badge tone={n ? 'warn' : 'neutral'}>{t('sec2.tidy.wouldTouch', { n })}</Badge>
              </span>
            ) : null}
            {TIDY_RULE_DEFS[rule].workspaces ? (
              <ExcludeWorkspaces
                account={account}
                rule={rule}
                value={r.exclude_workspace_ids}
                onSave={(ids) => patch(rule, { exclude_workspace_ids: ids })}
              />
            ) : null}
            <DaysField key={r.days} rule={rule} value={r.days} onSave={(days) => patch(rule, { days })} />
            <Switch
              checked={r.enabled}
              onChange={(on) => patch(rule, { enabled: on })}
              disabled={save.isPending}
              label={t(`sec2.tidy.rule.${rule}`)}
              testId={`tidy-toggle-${rule}`}
            />
          </Row>
        );
      })}
      {preview?.samples.length ? (
        <div className="border-t border-line-soft px-3.5 py-3" data-testid="tidy-samples">
          <div className="mb-1.5 text-xs font-semibold text-muted">{t('sec2.tidy.samples')}</div>
          <ul className="flex flex-wrap gap-1.5">
            {preview.samples.map((s) => (
              <li
                key={`${s.rule}-${s.id}`}
                data-testid="tidy-sample"
                data-rule={s.rule}
                className="rounded-full bg-surface-2 px-2.5 py-0.5 text-xs text-fg-2"
              >
                {s.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="border-t border-line-soft px-3.5 py-3 text-sm" data-testid="tidy-last-run">
        {last ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-muted">{t('sec2.tidy.lastRun')}</span>
            <Badge tone={statusTone(last.status)}>{t(`sec2.tidy.status.${last.status}`)}</Badge>
            <span className="text-xs text-fg-2">
              <Ago iso={last.finished_at} now={now} /> · {t(`sec2.tidy.trigger.${last.trigger}`)}
              {last.actor_name ? ` · ${last.actor_name}` : ''}
            </span>
            <span className="text-xs text-fg-2" data-testid="tidy-last-total">
              {t('sec2.tidy.touched', { n: last.results.reduce((s, x) => s + x.count, 0) })}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void csv(last)} data-testid="tidy-run-csv">
              <Icon name="download" size={14} />
              CSV
            </Button>
          </div>
        ) : (
          <span className="text-xs text-muted">{t('sec2.tidy.never')}</span>
        )}
        {(runs.data?.data.length ?? 0) > 1 ? (
          <div className="mt-2">
            <button
              type="button"
              className="text-xs font-semibold text-heading hover:underline"
              aria-expanded={history}
              onClick={() => setHistory((v) => !v)}
              data-testid="tidy-history"
            >
              {t('sec2.tidy.history')}
            </button>
            {history ? (
              <ul className="mt-1.5 space-y-1">
                {runs.data!.data.slice(1, 10).map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center gap-2 text-xs text-fg-2"
                    data-testid="tidy-run-row"
                  >
                    <Badge tone={statusTone(r.status)}>{t(`sec2.tidy.status.${r.status}`)}</Badge>
                    <Ago iso={r.finished_at} now={now} /> · {t(`sec2.tidy.trigger.${r.trigger}`)} ·{' '}
                    {t('sec2.tidy.touched', { n: r.results.reduce((s, x) => s + x.count, 0) })}
                    <button
                      type="button"
                      className="font-semibold text-heading hover:underline"
                      onClick={() => void csv(r)}
                    >
                      CSV
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </Panel>
  );
};
