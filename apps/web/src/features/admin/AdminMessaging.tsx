// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  type AccountDetail,
  type AccountSenderStatus,
  formatDateTime,
  type SenderKind,
  type SenderRequest,
  DEFAULT_EMAIL_ACCENT,
  DEFAULT_MAIL_STYLE,
  MAIL_STYLES,
  type EmailPreview,
  type Locale,
  MAIL_TEMPLATE_KEYS,
  type MailTemplateKey,
  type MyAccount,
  t,
  type TestEmailResult,
  type UpdateAccount,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, Card, Dialog, Input, Picker, Segmented } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { api, errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { LimitField, parseLimit } from '../tokens/TokenLimits';
import { MAX_LOGO_BYTES, senderStatusKey, useAccountEmailLogo } from './account-settings';
import { h2, Row } from './admin-parts';

type Patch = NonNullable<UpdateAccount['settings']>;

const Section = ({
  title,
  hint,
  children,
  testId,
}: {
  title: string;
  hint: string;
  children: ReactNode;
  testId: string;
}) => (
  <Card className="p-0">
    <div className="space-y-0.5 border-b border-line-soft px-3.5 pt-3.5 pb-3" data-testid={testId}>
      <h2 className={h2}>{title}</h2>
      <p className="text-xs text-muted">{hint}</p>
    </div>
    <div>{children}</div>
  </Card>
);

/** A text setting saved with its own button; empty = back to the default (`null`). */
export const TextSetting = ({
  value,
  pending,
  placeholder,
  label,
  maxLength,
  ltr,
  busy,
  valid = () => true,
  onSave,
  testId,
}: {
  value: string | undefined;
  /** A value waiting for the platform owner's approval (S-46): shown in the field instead of the one in force. */
  pending?: string;
  placeholder: string;
  label: string;
  maxLength: number;
  ltr?: boolean;
  busy: boolean;
  valid?: (v: string) => boolean;
  onSave: (v: string | null) => void;
  testId: string;
}) => {
  const shown = pending ?? value ?? '';
  const [text, setText] = useState(shown);
  const trimmed = text.trim();
  const ok = !trimmed || valid(trimmed);
  return (
    <form
      className="flex items-center gap-2 max-sm:w-full"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok && trimmed !== shown) onSave(trimmed || null);
      }}
    >
      <Input
        value={text}
        maxLength={maxLength}
        placeholder={placeholder}
        dir={ltr ? 'ltr' : undefined}
        onChange={(e) => setText(e.target.value)}
        aria-label={label}
        aria-invalid={!ok || undefined}
        className="w-64 text-start max-sm:w-auto max-sm:flex-1"
        data-testid={`${testId}-input`}
      />
      <Button type="submit" size="sm" busy={busy} disabled={!ok || trimmed === shown} data-testid={`${testId}-save`}>
        {t('common.save')}
      </Button>
    </form>
  );
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENDER = /^[^\r\n"<>]+$/;
const SMS_SENDER = /^(?:[A-Za-z0-9 .-]{2,11}|\+?\d{3,15})$/;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** The approval state of the account's custom senders (S-46), admins only. */
const useSenderStatus = (accountId: string) =>
  useQuery({
    queryKey: senderStatusKey(accountId),
    queryFn: () => api(accountId).get<AccountSenderStatus>('/accounts/me/sender-requests'),
  });

/**
 * One custom sender's state under its field (S-46): waiting for approval (the value in force meanwhile), rejected
 * (with the owner's reason), or approved — the latter only while it is the value in force.
 */
const SenderState = ({
  req,
  current,
  fallback,
  kind,
}: {
  req: SenderRequest | undefined;
  current: string | undefined;
  fallback: string;
  kind: SenderKind;
}) => {
  if (!req) return null;
  const testId = `admin-sender-state-${kind}`;
  const line = 'flex flex-wrap items-center gap-1.5 text-xs text-fg-2';
  if (req.status === 'pending')
    return (
      <p className={line} data-testid={testId} data-state="pending">
        <Badge tone="warn">{t('admin.messaging.sender.pending')}</Badge>
        <span>
          {t('admin.messaging.sender.pendingHint', {
            value: req.value,
            current: current || fallback,
            date: formatDateTime(req.created_at),
          })}
        </span>
      </p>
    );
  if (req.status === 'rejected')
    return (
      <p className={line} data-testid={testId} data-state="rejected">
        <Badge tone="danger">{t('admin.messaging.sender.rejected')}</Badge>
        <span>{t('admin.messaging.sender.rejectedHint', { value: req.value, reason: req.reason ?? '—' })}</span>
      </p>
    );
  if (req.status === 'approved' && req.value === current)
    return (
      <p className={line} data-testid={testId} data-state="approved">
        <Badge tone="ok">{t('admin.messaging.sender.approved')}</Badge>
      </p>
    );
  return null;
};

/**
 * Administration → General → Emails & SMS (ANSWERS 6א.3/8): who the account's emails come from (sender name,
 * Reply-To, a logo for emails) and the SMS sender id. Empty = the account's name / the platform's default. A
 * custom sender name / Reply-To / SMS sender may wait for the platform owner's approval (S-46): its state shows
 * under the field, and the value in force stays until it is approved.
 */
export const MessagingSection = ({
  account,
  detail,
  busy,
  onSave,
}: {
  account: MyAccount;
  detail: AccountDetail;
  busy: boolean;
  onSave: (s: Patch) => void;
}) => {
  const b = detail.settings.branding;
  const sms = detail.settings.sms;
  const logo = useAccountEmailLogo(account);
  const fileInput = useRef<HTMLInputElement>(null);
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file)
      logo.mutate(file, {
        onSuccess: () => showToast({ message: t('admin.general.saved') }),
        onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
      });
  };
  const platformSms = detail.platform_defaults?.sms_sender_id;
  const platformAccent = detail.platform_defaults?.email_accent_color ?? DEFAULT_EMAIL_ACCENT;
  const senders = useSenderStatus(account.id).data;
  const req = (kind: SenderKind) => senders?.data.find((r) => r.kind === kind);
  const pendingOf = (kind: SenderKind) => {
    const r = req(kind);
    return r?.status === 'pending' ? r.value : undefined;
  };
  const keyOf = (kind: SenderKind, value: string | undefined) => `${value ?? ''}|${pendingOf(kind) ?? ''}`;
  return (
    <Section title={t('admin.messaging.title')} hint={t('admin.messaging.hint')} testId="admin-general-messaging">
      {senders?.require_approval ? (
        <p
          className="border-b border-line-soft px-3.5 py-2 text-xs text-muted"
          data-testid="admin-sender-approval-note"
        >
          {t('admin.messaging.sender.approvalNote')}
        </p>
      ) : null}
      <Row
        label={t('admin.messaging.senderName')}
        hint={t('admin.messaging.senderNameHint')}
        below={
          <SenderState
            kind="email_sender_name"
            req={req('email_sender_name')}
            current={b.email_sender_name}
            fallback={detail.name}
          />
        }
      >
        <TextSetting
          key={keyOf('email_sender_name', b.email_sender_name)}
          value={b.email_sender_name}
          pending={pendingOf('email_sender_name')}
          placeholder={detail.name}
          label={t('admin.messaging.senderName')}
          maxLength={80}
          busy={busy}
          valid={(v) => SENDER.test(v)}
          onSave={(v) => onSave({ branding: { email_sender_name: v } })}
          testId="admin-sender-name"
        />
      </Row>
      <Row
        label={t('admin.messaging.replyTo')}
        hint={t('admin.messaging.replyToHint')}
        below={
          <SenderState
            kind="email_reply_to"
            req={req('email_reply_to')}
            current={b.email_reply_to}
            fallback={t('admin.messaging.sender.noReplyTo')}
          />
        }
      >
        <TextSetting
          key={keyOf('email_reply_to', b.email_reply_to)}
          value={b.email_reply_to}
          pending={pendingOf('email_reply_to')}
          placeholder="name@example.com"
          label={t('admin.messaging.replyTo')}
          maxLength={254}
          ltr
          busy={busy}
          valid={(v) => EMAIL.test(v)}
          onSave={(v) => onSave({ branding: { email_reply_to: v } })}
          testId="admin-reply-to"
        />
      </Row>
      <Row label={t('admin.messaging.accent')} hint={t('admin.messaging.accentHint')} testId="admin-email-accent">
        <span
          aria-hidden
          className="h-7 w-7 shrink-0 rounded-md border border-line"
          style={{ background: b.email_accent_color ?? platformAccent }}
          data-testid="admin-email-accent-swatch"
        />
        <TextSetting
          key={b.email_accent_color ?? ''}
          value={b.email_accent_color}
          placeholder={platformAccent}
          label={t('admin.messaging.accent')}
          maxLength={7}
          ltr
          busy={busy}
          valid={(v) => HEX.test(v)}
          onSave={(v) => onSave({ branding: { email_accent_color: v } })}
          testId="admin-email-accent"
        />
      </Row>
      <Row label={t('admin.messaging.style')} hint={t('admin.messaging.styleHint')} testId="admin-email-style">
        <Segmented
          label={t('admin.messaging.style')}
          testId="admin-email-style-choice"
          value={b.email_style ?? detail.platform_defaults?.email_style ?? DEFAULT_MAIL_STYLE}
          onChange={(email_style) => onSave({ branding: { email_style } })}
          options={MAIL_STYLES.map((s) => ({
            value: s,
            label: t(`admin.messaging.style.${s}`),
            testId: `admin-email-style-${s}`,
          }))}
        />
      </Row>
      <Row
        label={t('admin.messaging.emailLogo')}
        hint={t('admin.messaging.emailLogoHint', { mb: MAX_LOGO_BYTES / 1024 / 1024 })}
        testId="admin-email-logo"
      >
        {detail.email_logo_url ? (
          <img
            src={detail.email_logo_url}
            alt=""
            aria-hidden
            className="h-8 max-w-[120px] rounded-[6px] object-contain"
            data-testid="admin-email-logo-img"
          />
        ) : (
          <span className="text-xs text-muted" data-testid="admin-email-logo-default">
            {t('admin.messaging.emailLogoDefault')}
          </span>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={onFile}
          data-testid="admin-email-logo-input"
        />
        <Button
          variant="secondary"
          size="sm"
          busy={logo.isPending}
          onClick={() => fileInput.current?.click()}
          data-testid="admin-email-logo-upload"
        >
          <Icon name="upload" size={14} />
          {detail.email_logo_url ? t('admin.general.logoReplace') : t('admin.general.logoUpload')}
        </Button>
        {detail.email_logo_url ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={logo.isPending}
            onClick={() => logo.mutate(null)}
            data-testid="admin-email-logo-remove"
          >
            {t('admin.general.logoRemove')}
          </Button>
        ) : null}
      </Row>
      <Row
        label={t('admin.messaging.smsSender')}
        hint={t('admin.messaging.smsSenderHint')}
        below={
          <SenderState
            kind="sms_sender_id"
            req={req('sms_sender_id')}
            current={sms?.sender_id}
            fallback={platformSms ?? t('admin.messaging.platformDefault')}
          />
        }
      >
        <TextSetting
          key={keyOf('sms_sender_id', sms?.sender_id)}
          value={sms?.sender_id}
          pending={pendingOf('sms_sender_id')}
          placeholder={platformSms ?? t('admin.messaging.platformDefault')}
          label={t('admin.messaging.smsSender')}
          maxLength={15}
          ltr
          busy={busy}
          valid={(v) => SMS_SENDER.test(v)}
          onSave={(v) => onSave({ sms: { sender_id: v } })}
          testId="admin-sms-sender"
        />
      </Row>
      <EmailPreviewRow account={account} />
    </Section>
  );
};

/**
 * Emails & SMS → preview (M11): any email the platform sends, with sample data, in Hebrew or English, as the
 * account's members get it (sender, logo, accent); and the same email sent to the admin's own address as a test.
 */
const EmailPreviewRow = ({ account }: { account: MyAccount }) => {
  const [template, setTemplate] = useState<MailTemplateKey>('invitation');
  const [locale, setLocale] = useState<Locale>('he');
  const [view, setView] = useState<'html' | 'text'>('html');
  const [shown, setShown] = useState<EmailPreview | null>(null);
  const query = `template=${template}&locale=${locale}`;
  const preview = useMutation({
    mutationFn: () => api(account.id).get<EmailPreview>(`/accounts/me/email-preview?${query}`),
    onSuccess: (data) => {
      setView('html');
      setShown(data);
    },
    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
  });
  const test = useMutation({
    mutationFn: () => api(account.id).post<TestEmailResult>('/accounts/me/email-test', { template, locale }),
    onSuccess: (res) =>
      showToast(
        res.sent
          ? { message: t('admin.messaging.testSent', { email: res.to }) }
          : { message: t('admin.messaging.testSkipped', { email: res.to }), tone: 'error' },
      ),
    onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
  });
  return (
    <Row label={t('admin.messaging.preview')} hint={t('admin.messaging.previewHint')} testId="admin-email-preview">
      <Picker
        value={template}
        options={MAIL_TEMPLATE_KEYS.map((k) => ({
          value: k,
          label: t(`admin.messaging.template.${k}`),
          testId: `admin-email-template-${k}`,
        }))}
        onChange={setTemplate}
        label={t('admin.messaging.template')}
        className="w-48 max-sm:w-full"
        testId="admin-email-template"
      />
      <Segmented
        value={locale}
        options={[
          { value: 'he', label: t('admin.messaging.lang.he'), testId: 'admin-email-lang-he' },
          { value: 'en', label: t('admin.messaging.lang.en'), testId: 'admin-email-lang-en' },
        ]}
        onChange={setLocale}
        label={t('admin.messaging.language')}
        testId="admin-email-lang"
      />
      <Button
        variant="secondary"
        size="sm"
        busy={preview.isPending}
        onClick={() => preview.mutate()}
        data-testid="admin-email-preview-open"
      >
        {t('admin.messaging.previewOpen')}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        busy={test.isPending}
        onClick={() => test.mutate()}
        data-testid="admin-email-test-send"
      >
        {t('admin.messaging.testSend')}
      </Button>
      <Dialog
        open={!!shown}
        onClose={() => setShown(null)}
        title={shown?.subject ?? ''}
        subtitle={shown ? t('admin.messaging.previewFrom', { name: shown.from_name }) : undefined}
        className="max-w-[680px]"
      >
        {shown ? (
          <div className="space-y-2.5" data-testid="admin-email-preview-dialog">
            <Segmented
              value={view}
              options={[
                { value: 'html', label: t('admin.messaging.previewHtml'), testId: 'admin-email-view-html' },
                { value: 'text', label: t('admin.messaging.previewText'), testId: 'admin-email-view-text' },
              ]}
              onChange={setView}
              label={t('admin.messaging.preview')}
            />
            {view === 'html' ? (
              // No scripts, no forms, no navigation: the email's HTML only, as a mail client shows it.
              <iframe
                title={shown.subject}
                srcDoc={shown.html}
                sandbox=""
                className="h-[60vh] w-full rounded-[10px] border border-line bg-white"
                data-testid="admin-email-preview-frame"
              />
            ) : (
              <pre
                dir={locale === 'he' ? 'rtl' : 'ltr'}
                className="max-h-[60vh] overflow-auto rounded-[10px] border border-line bg-surface-2 p-3 text-start text-xs whitespace-pre-wrap text-fg"
                data-testid="admin-email-preview-text"
              >
                {shown.text}
              </pre>
            )}
          </div>
        ) : null}
      </Dialog>
    </Row>
  );
};

type LimitKey = 'token_per_minute' | 'service_token_per_minute' | 'personal_daily' | 'service_daily';
const LIMITS: { key: LimitKey; kind: 'per_minute' | 'daily'; label: string }[] = [
  { key: 'token_per_minute', kind: 'per_minute', label: 'limits.personalPerMinute' },
  { key: 'personal_daily', kind: 'daily', label: 'limits.personalPerDay' },
  { key: 'service_token_per_minute', kind: 'per_minute', label: 'limits.servicePerMinute' },
  { key: 'service_daily', kind: 'daily', label: 'limits.servicePerDay' },
];

/**
 * Administration → General → API limits (ANSWERS 6א.9): the budgets of this account's tokens, per minute and per
 * day, personal and service apart. Empty = the platform's (owner console); a token may still have its own.
 */
export const ApiLimitsSection = ({
  detail,
  busy,
  onSave,
}: {
  detail: AccountDetail;
  busy: boolean;
  onSave: (s: Patch) => void;
}) => {
  const own: Partial<Record<LimitKey, number>> = detail.settings.api_limits;
  const platform = detail.platform_defaults?.api_limits;
  const [values, setValues] = useState<Record<LimitKey, string>>(
    () => Object.fromEntries(LIMITS.map((l) => [l.key, own[l.key]?.toString() ?? ''])) as Record<LimitKey, string>,
  );
  const parsed = Object.fromEntries(LIMITS.map((l) => [l.key, parseLimit(values[l.key], l.kind)])) as Record<
    LimitKey,
    number | null | 'invalid'
  >;
  const invalid = Object.values(parsed).includes('invalid');
  const changed = LIMITS.some((l) => (parsed[l.key] ?? null) !== (own[l.key] ?? null));
  return (
    <Section title={t('admin.apiLimits.title')} hint={t('admin.apiLimits.hint')} testId="admin-general-api-limits">
      <div className="space-y-3 p-3.5" data-testid="admin-api-limits">
        <div className="grid gap-3 sm:grid-cols-2">
          {LIMITS.map((l) => (
            <LimitField
              key={l.key}
              label={tDynamic(l.label)}
              kind={l.kind}
              value={values[l.key]}
              onChange={(v) => setValues((x) => ({ ...x, [l.key]: v }))}
              fallback={platform ? platform[l.key] : t('admin.messaging.platformDefault')}
              testId={`admin-limit-${l.key}`}
            />
          ))}
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            busy={busy}
            disabled={invalid || !changed}
            onClick={() =>
              onSave({
                api_limits: Object.fromEntries(
                  LIMITS.map((l) => [l.key, parsed[l.key] === 'invalid' ? null : parsed[l.key]]),
                ) as Record<LimitKey, number | null>,
              })
            }
            data-testid="admin-api-limits-save"
          >
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Section>
  );
};
