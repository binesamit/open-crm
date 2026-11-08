// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { type AiSettings, type MyAccount, t } from '@bines/shared';
import { Input, Notice, Picker, Segmented, Switch } from '@bines/ui';
import { Panel, Row } from '../admin/admin-parts';
import {
  defaultChoiceLabel,
  modelChoices,
  modelPickerOptions,
  modelHasTools,
  chatConnections,
  useAiConnections,
  useAiModels,
} from '../ai/ai-api';

/**
 * Administration → AI ו-MCP → "AI assistant" (מ12): on / off, which AI connection + model it uses, who besides
 * admins may chat, and its limits (model calls and dollars per message, messages a day per person). All data —
 * the account's choice, never code.
 */
type Assistant = AiSettings['assistant'];
type Who = 'members' | 'members_viewers' | 'all';
const whoOf = (roles: Assistant['roles']): Who =>
  roles.includes('guest') ? 'all' : roles.includes('viewer') ? 'members_viewers' : 'members';
const rolesOf = (who: Who): Assistant['roles'] =>
  who === 'all' ? ['member', 'viewer', 'guest'] : who === 'members_viewers' ? ['member', 'viewer'] : ['member'];

export const AssistantSettings = ({
  account,
  settings,
  busy,
  onSave,
}: {
  account: MyAccount;
  settings: AiSettings;
  busy: boolean;
  onSave: (patch: Partial<AiSettings>) => void;
}) => {
  const s = settings.assistant;
  const connections = chatConnections(useAiConnections(account.id).data?.data);
  const save = (patch: Partial<Assistant>) => onSave({ assistant: { ...s, ...patch } });
  const [limits, setLimits] = useState({
    steps: String(s.max_steps),
    usd: String(s.max_usd_per_message),
    daily: String(s.daily_messages_per_user),
  });
  const saveLimit = (key: 'max_steps' | 'max_usd_per_message' | 'daily_messages_per_user', raw: string) => {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n <= 0 || n === s[key]) return;
    save({ [key]: key === 'max_usd_per_message' ? n : Math.round(n) });
  };
  const conn = connections.find((c) => c.id === s.connection_id);
  // The connection's live model list (any provider); nothing else is offered.
  const models = useAiModels(account.id, conn?.id ?? null);
  return (
    <Panel title={t('ai2.admin.title')} hint={t('ai2.admin.hint')} testId="ai-assistant-settings">
      <Row label={t('ai2.admin.enabled')}>
        <Switch
          checked={s.enabled}
          disabled={busy}
          onChange={(enabled) => save({ enabled })}
          label={t('ai2.admin.enabled')}
          testId="ai-assistant-enabled"
        />
      </Row>
      <Row label={t('ai2.form.connection')} hint={t('ai2.admin.connectionHint')}>
        <Picker
          value={s.connection_id ?? ''}
          label={t('ai2.form.connection')}
          placeholder={t('ai2.form.pickConnection')}
          testId="ai-assistant-connection"
          onChange={(id) => save({ connection_id: id || null })}
          options={connections.map((c) => ({ value: c.id, label: c.name, testId: 'ai-assistant-connection-option' }))}
        />
      </Row>
      <Row label={t('ai2.form.model')}>
        <Picker
          value={s.model ?? ''}
          label={t('ai2.form.model')}
          placeholder={t('ai2.form.connectionDefault')}
          testId="ai-assistant-model"
          onChange={(model) => save({ model: model || null })}
          options={[
            {
              value: '',
              label: defaultChoiceLabel(t('ai2.form.connectionDefault'), models.data),
              testId: 'ai-assistant-model-default',
            },
            ...modelPickerOptions(modelChoices(models.data, s.model), 'ai-assistant-model-option'),
          ]}
        />
      </Row>
      {/* The assistant reads and writes through tools: a model without tool calling cannot serve it. */}
      {modelHasTools(models.data, s.model ?? models.data?.default_model) ? null : (
        <div className="px-3.5 py-2" data-testid="ai-assistant-model-no-tools">
          <Notice tone="warn">{t('error.ai_model_no_tools')}</Notice>
        </div>
      )}
      <Row label={t('ai2.admin.who')} hint={t('ai2.admin.whoHint')}>
        <Segmented
          value={whoOf(s.roles)}
          label={t('ai2.admin.who')}
          testId="ai-assistant-who"
          onChange={(v) => save({ roles: rolesOf(v) })}
          options={[
            { value: 'members', label: t('ai2.admin.who.members') },
            { value: 'members_viewers', label: t('ai2.admin.who.membersViewers') },
            { value: 'all', label: t('ai2.admin.who.all') },
          ]}
        />
      </Row>
      <Row label={t('ai2.admin.limits')} hint={t('ai2.admin.limitsHint')}>
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
          <Input
            dir="ltr"
            inputMode="numeric"
            className="w-16"
            aria-label={t('ai2.admin.maxSteps')}
            title={t('ai2.admin.maxSteps')}
            value={limits.steps}
            data-testid="ai-assistant-steps"
            onChange={(e) => setLimits((l) => ({ ...l, steps: e.target.value }))}
            onBlur={() => saveLimit('max_steps', limits.steps)}
          />
          {t('ai2.admin.steps')}
          <Input
            dir="ltr"
            inputMode="decimal"
            className="w-20"
            aria-label={t('ai2.admin.maxUsd')}
            title={t('ai2.admin.maxUsd')}
            value={limits.usd}
            data-testid="ai-assistant-usd"
            onChange={(e) => setLimits((l) => ({ ...l, usd: e.target.value }))}
            onBlur={() => saveLimit('max_usd_per_message', limits.usd)}
          />
          {t('ai2.admin.usd')}
          <Input
            dir="ltr"
            inputMode="numeric"
            className="w-20"
            aria-label={t('ai2.admin.daily')}
            title={t('ai2.admin.daily')}
            value={limits.daily}
            data-testid="ai-assistant-daily"
            onChange={(e) => setLimits((l) => ({ ...l, daily: e.target.value }))}
            onBlur={() => saveLimit('daily_messages_per_user', limits.daily)}
          />
          {t('ai2.admin.dailyUnit')}
        </div>
      </Row>
    </Panel>
  );
};
