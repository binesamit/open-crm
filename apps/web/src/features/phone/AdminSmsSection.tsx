// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  type AccountDetail,
  SMS_MAX_LENGTH,
  SMS_SEND_POLICIES,
  smsSegments,
  type SmsTemplate,
  t,
  type UpdateAccount,
} from '@bines/shared';
import { Button, Card, Dialog, Field, Input, Segmented } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { nextTemplateId, parseSmsLimit } from './sms-admin-logic';
import { h2, Row } from '../admin/admin-parts';

type Patch = NonNullable<UpdateAccount['settings']>;

/**
 * Administration → General → SMS: who may send SMS from items (guests never), the saved texts
 * everyone picks from in the SMS dialog and in automations, and the budgets (SMS costs money).
 */
export const AdminSmsSection = ({
  detail,
  busy,
  onSave,
}: {
  detail: AccountDetail;
  busy: boolean;
  onSave: (s: Patch, done?: () => void) => void;
}) => {
  const sms = detail.settings.sms;
  const [perUser, setPerUser] = useState(String(sms.limits.per_user_per_hour));
  const [perAccount, setPerAccount] = useState(String(sms.limits.per_account_per_day));
  const [editing, setEditing] = useState<SmsTemplate | 'new' | null>(null);
  const user = parseSmsLimit(perUser, 10_000);
  const account = parseSmsLimit(perAccount, 1_000_000);
  const limitsChanged = user !== sms.limits.per_user_per_hour || account !== sms.limits.per_account_per_day;
  const saveTemplates = (templates: SmsTemplate[], done?: () => void) => onSave({ sms: { templates } }, done);

  return (
    <Card className="p-0">
      <div className="space-y-0.5 border-b border-line-soft px-3.5 pt-3.5 pb-3" data-testid="admin-general-sms">
        <h2 className={h2}>{t('admin.sms.title')}</h2>
        <p className="text-xs text-muted">{t('admin.sms.hint')}</p>
      </div>
      <Row label={t('admin.sms.policy')} hint={t('admin.sms.policyHint')}>
        <Segmented
          value={sms.send_policy}
          label={t('admin.sms.policy')}
          testId="admin-sms-policy"
          onChange={(send_policy) => onSave({ sms: { send_policy } })}
          options={SMS_SEND_POLICIES.map((p) => ({
            value: p,
            label: t(`admin.sms.policy.${p}`),
            testId: `admin-sms-policy-${p}`,
          }))}
        />
      </Row>
      <Row label={t('admin.sms.limits')} hint={t('admin.sms.limitsHint')} testId="admin-sms-limits">
        <label className="flex items-center gap-1.5 text-xs text-muted">
          {t('admin.sms.perUserPerHour')}
          <Input
            value={perUser}
            inputMode="numeric"
            dir="ltr"
            className="w-20"
            aria-invalid={user == null || undefined}
            onChange={(e) => setPerUser(e.target.value)}
            data-testid="admin-sms-per-user"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          {t('admin.sms.perAccountPerDay')}
          <Input
            value={perAccount}
            inputMode="numeric"
            dir="ltr"
            className="w-24"
            aria-invalid={account == null || undefined}
            onChange={(e) => setPerAccount(e.target.value)}
            data-testid="admin-sms-per-account"
          />
        </label>
        <Button
          size="sm"
          busy={busy}
          disabled={user == null || account == null || !limitsChanged}
          onClick={() => onSave({ sms: { limits: { per_user_per_hour: user!, per_account_per_day: account! } } })}
          data-testid="admin-sms-limits-save"
        >
          {t('common.save')}
        </Button>
      </Row>
      <div className="space-y-2 px-3.5 py-3" data-testid="admin-sms-templates">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0 space-y-0.5">
            <div className="text-sm font-semibold text-fg">{t('admin.sms.templates')}</div>
            <p className="text-xs text-muted">{t('admin.sms.templatesHint')}</p>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={sms.templates.length >= 100}
            onClick={() => setEditing('new')}
            data-testid="admin-sms-template-add"
          >
            <Icon name="plus" size={14} />
            {t('admin.sms.templateAdd')}
          </Button>
        </div>
        {sms.templates.length ? (
          <ul className="divide-y divide-line-soft rounded-[10px] border border-line">
            {sms.templates.map((tpl) => (
              <li
                key={tpl.id}
                className="flex items-start gap-2 px-3 py-2"
                data-testid="admin-sms-template"
                data-id={tpl.id}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{tpl.name}</p>
                  <p className="line-clamp-2 text-xs whitespace-pre-wrap text-muted" dir="auto">
                    {tpl.text}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('admin.sms.templateEdit')}
                  onClick={() => setEditing(tpl)}
                  data-testid="admin-sms-template-edit"
                >
                  <Icon name="edit" size={14} />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t('admin.sms.templateDelete')}
                  disabled={busy}
                  onClick={() => saveTemplates(sms.templates.filter((x) => x.id !== tpl.id))}
                  data-testid="admin-sms-template-delete"
                >
                  <Icon name="trash" size={14} />
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-muted" data-testid="admin-sms-templates-empty">
            {t('admin.sms.templatesEmpty')}
          </p>
        )}
      </div>
      {editing ? (
        <TemplateDialog
          initial={editing === 'new' ? null : editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(tpl) => {
            const list =
              editing === 'new'
                ? [...sms.templates, { ...tpl, id: nextTemplateId(sms.templates.map((x) => x.id)) }]
                : sms.templates.map((x) => (x.id === editing.id ? { ...x, ...tpl } : x));
            saveTemplates(list, () => setEditing(null));
          }}
        />
      ) : null}
    </Card>
  );
};

const TemplateDialog = ({
  initial,
  busy,
  onClose,
  onSave,
}: {
  initial: SmsTemplate | null;
  busy: boolean;
  onClose: () => void;
  onSave: (t: { name: string; text: string }) => void;
}) => {
  const [name, setName] = useState(initial?.name ?? '');
  const [text, setText] = useState(initial?.text ?? '');
  const ok = name.trim().length > 0 && text.trim().length > 0 && text.length <= SMS_MAX_LENGTH;
  return (
    <Dialog
      open
      onClose={onClose}
      title={initial ? t('admin.sms.templateEdit') : t('admin.sms.templateAdd')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            busy={busy}
            disabled={!ok}
            onClick={() => onSave({ name: name.trim(), text: text.trim() })}
            data-testid="admin-sms-template-save"
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="admin-sms-template-dialog">
        <Field label={t('admin.sms.templateName')}>
          <Input
            autoFocus
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            data-testid="admin-sms-template-name"
          />
        </Field>
        <Field label={t('admin.sms.templateText')} hint={t('admin.sms.templateTextHint')}>
          <textarea
            value={text}
            maxLength={SMS_MAX_LENGTH}
            onChange={(e) => setText(e.target.value)}
            data-testid="admin-sms-template-text"
            className="h-28 w-full resize-y rounded-[10px] border border-line-strong bg-surface p-2.5 text-sm focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
          />
        </Field>
        <p className="text-xs text-muted">
          {t('phone.sms.counter', { chars: text.length, max: SMS_MAX_LENGTH, parts: smsSegments(text) })}
        </p>
      </div>
    </Dialog>
  );
};
