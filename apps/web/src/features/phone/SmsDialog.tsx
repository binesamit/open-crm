// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { phoneActionLink, smsSegments, t, type PhonePlatform, type SendItemSmsResult, tDynamic } from '@bines/shared';
import { Button, Dialog, Field, Notice, Picker } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { useSendSms, useSmsStatus } from './phone-api';
import { smsErrorKey } from './phone-logic';

const FREE = '__free__';

const failure = (err: unknown) => {
  const key = smsErrorKey(err);
  return key ? tDynamic(key) : errorMessage(err);
};

/**
 * Send an SMS to the number of a phone cell: a saved template (filled from the item by a dry run)
 * or free text, a live parts counter, a preview of exactly what goes out (dry run: number + filled text), then the
 * send — the copy is logged as an update on the item. On a phone `deviceHref` also offers the device's own SMS app.
 */
export const SmsDialog = ({
  accountId,
  itemId,
  columnId,
  phone,
  e164,
  platform,
  device,
  onClose,
}: {
  accountId: string;
  itemId: string;
  columnId: string;
  phone: string;
  e164: string | null;
  platform: PhonePlatform;
  /** The sms: link of the device (null on a computer, or when the user chose "from the system"). */
  device: string | null;
  onClose: () => void;
}) => {
  const status = useSmsStatus(accountId);
  const send = useSendSms(accountId, itemId);
  const [template, setTemplate] = useState<string>(FREE);
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<SendItemSmsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = status.data;
  const templates = s?.templates ?? [];
  const max = s?.max_length ?? 1005;
  const parts = smsSegments(text);
  const canSend = !!s?.can_send && text.trim().length > 0 && text.length <= max;

  const pickTemplate = (id: string) => {
    setTemplate(id);
    setPreview(null);
    setError(null);
    if (id === FREE) return;
    // The template is filled from this item on the server; the result stays editable here.
    send.mutate(
      { column_id: columnId, template_id: id, dry_run: true },
      {
        onSuccess: (res) => setText(res.text),
        onError: (err) => setError(failure(err)),
      },
    );
  };
  const runPreview = () => {
    setError(null);
    send.mutate(
      { column_id: columnId, text: text.trim(), dry_run: true },
      { onSuccess: setPreview, onError: (err) => setError(failure(err)) },
    );
  };
  const runSend = () => {
    setError(null);
    send.mutate(
      { column_id: columnId, text: text.trim() },
      {
        onSuccess: (res) => {
          showToast({ message: t('phone.sms.sent', { to: res.to }) });
          onClose();
        },
        onError: (err) => setError(failure(err)),
      },
    );
  };
  const deviceLink = device ? (phoneActionLink('sms', { phone, e164 }, { text, platform }) ?? device) : null;

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('phone.sms.title')}
      subtitle={phone}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {deviceLink ? (
            <a
              href={deviceLink}
              data-testid="sms-device"
              onClick={onClose}
              className="inline-flex h-9 items-center rounded-[10px] border border-line-strong px-3 text-[0.8125rem] text-fg hover:border-primary"
            >
              {t('phone.sms.fromDevice')}
            </a>
          ) : null}
          {s?.can_send ? (
            <>
              <Button
                variant="secondary"
                disabled={!text.trim() || send.isPending}
                onClick={runPreview}
                data-testid="sms-preview"
              >
                {t('phone.sms.preview')}
              </Button>
              <Button busy={send.isPending} disabled={!canSend} onClick={runSend} data-testid="sms-send">
                {t('phone.sms.send')}
              </Button>
            </>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="sms-dialog">
        {s && !s.can_send ? <Notice tone="warn">{t(`phone.sms.denied.${s.reason ?? 'disabled'}`)}</Notice> : null}
        {templates.length ? (
          <Field label={t('phone.sms.template')}>
            <Picker
              value={template}
              label={t('phone.sms.template')}
              testId="sms-template"
              onChange={pickTemplate}
              options={[
                { value: FREE, label: t('phone.sms.freeText'), testId: 'sms-template-free' },
                ...templates.map((x) => ({ value: x.id, label: x.name, testId: `sms-template-${x.id}` })),
              ]}
            />
          </Field>
        ) : null}
        <Field label={t('phone.sms.message')}>
          <textarea
            autoFocus
            value={text}
            maxLength={max}
            data-testid="sms-text"
            placeholder={t('phone.sms.placeholder')}
            onChange={(e) => {
              setText(e.target.value);
              setPreview(null);
            }}
            className="h-28 w-full resize-y rounded-[10px] border border-line-strong bg-surface p-2.5 text-sm placeholder:text-muted focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
          />
        </Field>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span data-testid="sms-counter" data-parts={parts}>
            {t('phone.sms.counter', { chars: text.length, max, parts })}
          </span>
          {s ? (
            <span data-testid="sms-usage">
              {t('phone.sms.usage', { used: s.usage.user_last_hour, limit: s.limits.per_user_per_hour })}
            </span>
          ) : null}
        </div>
        {preview ? (
          <div
            className="space-y-1 rounded-[10px] border border-line bg-surface-2 p-2.5 text-sm"
            data-testid="sms-preview-box"
          >
            <p className="text-xs text-muted">
              {t('phone.sms.previewTo')}{' '}
              <span dir="ltr" data-testid="sms-preview-to">
                {preview.to}
              </span>{' '}
              · {t('phone.sms.parts', { n: preview.segments })}
            </p>
            <p className="whitespace-pre-wrap" dir="auto" data-testid="sms-preview-text">
              {preview.text}
            </p>
          </div>
        ) : null}
        {error ? (
          <Notice tone="error">
            <span data-testid="sms-error">{error}</span>
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
};
