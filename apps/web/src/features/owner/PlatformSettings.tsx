// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_DELETION_GRACE_DAYS,
  ACCOUNT_DELETION_GRACE_RANGE,
  ACCOUNT_EXPORT_DAYS,
  ACCOUNT_EXPORT_DAYS_RANGE,
  DEFAULT_PASSWORD_MIN_LENGTH,
  DEFAULT_SOURCE_URL,
  PASSWORD_MIN_CEILING,
  PASSWORD_MIN_FLOOR,
  type PlatformApiLimits,
  INBOUND_LIMIT_FIELDS,
  INBOUND_LIMIT_KEYS,
  type InboundLimitField,
  mailDomainSchema,
  platformApiLimitsSchema,
  type PlatformSettingsResponse,
  t,
  type UpdatePlatformSettings,
  tDynamic,
  DEFAULT_MAIL_STYLE,
  MAIL_STYLES,
  type MailStyle,
} from '@bines/shared';
import { Button, Card, Field, Input, Notice, Segmented, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage, queryKeys } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { LimitField, parseLimit } from '../tokens/TokenLimits';
import { AiLocalEndpointsCard } from './AiPrices';
import { FlowPlatformsCard } from './FlowPlatformsSettings';
import { IntegrationsCard } from './IntegrationsSettings';
import { SupportSettingsCard } from './SupportSettings';
import { SenderRequestsPanel } from './SenderRequests';
import { PwaPlatformCard } from './PwaPlatformCard';
import { PublicAddressCard } from './PublicAddressCard';
import { PlatformSecurityCard } from './PlatformSecurityCard';
import { PlatformCaptchaCard } from '../captcha/CaptchaPanels';
import { RetentionCard } from './RetentionCard';
import { PlatformCalendarCard } from './PlatformCalendarCard';

const KEY = ['platform', 'settings'] as const;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SENDER = /^[^\r\n"<>]+$/;
const SMS_SENDER = /^(?:[A-Za-z0-9 .-]{2,11}|\+?\d{3,15})$/;
const LOGO_URL = /^https?:\/\/\S+$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
/** 1–1000 (the shared schema's bounds). */
const PER_HOUR = /^(?:[1-9]\d{0,2}|1000)$/;
/** Invitation emails per inviter per hour (S-12): 0 = no limit, up to 10000. */
const INVITES_PER_HOUR = /^(?:\d{1,4}|10000)$/;
const AUTOMATION_PER_DAY = /^(?:\d{1,5}|100000)$/;
const MAP_ORIGIN = /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/;
/** A site that may embed an extension's panel page: a browser extension or an https site. */
const EMBED_ORIGIN = /^(chrome-extension:\/\/[a-p]{32}|https:\/\/[a-z0-9.-]+(:\d{1,5})?)$/;

type LimitKey = keyof PlatformApiLimits;
const LIMITS: { key: LimitKey; kind: 'per_minute' | 'daily'; label: string }[] = [
  { key: 'token_per_minute', kind: 'per_minute', label: 'limits.personalPerMinute' },
  { key: 'personal_daily', kind: 'daily', label: 'limits.personalPerDay' },
  { key: 'service_token_per_minute', kind: 'per_minute', label: 'limits.servicePerMinute' },
  { key: 'service_daily', kind: 'daily', label: 'limits.servicePerDay' },
];
/** The built-in defaults (what an empty platform field means) — the shared schema's defaults. */
const BUILTIN: PlatformApiLimits = platformApiLimitsSchema.parse({});

/**
 * Owner console → Platform settings (ANSWERS 6א.3/8/9): the product's name (white-label: emails, the
 * authenticator app, the API reference), the sender of emails of no account, the default SMS sender, the API
 * reference's logo and colour, and the API-token budgets every account starts from. Every field empty = the default shown as its placeholder.
 */
/**
 * Email off (no mail transport on this installation — a fresh standalone install): how to turn it on. Password
 * sign-in works meanwhile; invitations give a link to copy.
 */
export const EmailOffNotice = () => {
  const settings = useQuery({
    queryKey: KEY,
    queryFn: () => api().get<PlatformSettingsResponse>('/platform/settings'),
  });
  if (settings.data?.email_enabled !== false) return null;
  return (
    <Notice>
      <span className="block min-w-0" data-testid="owner-email-off">
        <span className="block font-semibold">{t('owner.emailOff.title')}</span>
        <span className="block">{t('owner.emailOff.body')}</span>
        <code dir="ltr" className="mt-1.5 block text-start text-xs break-all whitespace-pre-wrap">
          {t('owner.emailOff.example')}
        </code>
      </span>
    </Notice>
  );
};

/**
 * One console section's share of the platform settings (the cards that were one long stack are spread
 * over General, Security, Email, Connections and Support). Every part reads the same cached settings.
 */
const SettingsPart = ({
  testId,
  children,
}: {
  testId: string;
  children: (data: PlatformSettingsResponse) => ReactNode;
}) => {
  const settings = useQuery({
    queryKey: KEY,
    queryFn: () => api().get<PlatformSettingsResponse>('/platform/settings'),
  });
  return (
    <section className="space-y-2.5" data-testid={testId}>
      {settings.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {settings.isError ? <Notice tone="error">{errorMessage(settings.error)}</Notice> : null}
      {settings.data ? children(settings.data) : null}
    </section>
  );
};

/** General: the public address and the platform settings form (name, emails, limits, sign-in texts…). */
export const PlatformGeneralSettings = () => (
  <SettingsPart testId="owner-platform-settings">
    {(data) => (
      <>
        <header className="space-y-0.5">
          <h2 className="font-display text-base font-bold text-heading">{t('owner.platform.title')}</h2>
          <p className="max-w-[640px] text-xs text-muted">{t('owner.platform.hint')}</p>
        </header>
        <PublicAddressCard key={`address-${JSON.stringify(data.settings.public_address)}`} data={data} />
        <Form key={JSON.stringify(data.settings)} data={data} />
        <PlatformCalendarCard data={data} />
      </>
    )}
  </SettingsPart>
);

/** Security: the platform's sign-in security and the captcha (the login providers sit next to them). */
export const PlatformSecuritySettings = () => (
  <SettingsPart testId="owner-security-settings">
    {(data) => (
      <>
        <PlatformSecurityCard data={data} />
        <RetentionCard key={`retention-${JSON.stringify(data.settings.retention)}`} data={data} />
        <PlatformCaptchaCard />
      </>
    )}
  </SettingsPart>
);

/** Email: how to turn email on when it is off, and the senders accounts asked for. */
export const PlatformEmailSettings = () => (
  <SettingsPart testId="owner-email-settings">
    {(data) => (
      <>
        <EmailOffNotice />
        <SenderRequestsPanel data={data} />
      </>
    )}
  </SettingsPart>
);

/** Connections: Zapier / Make / n8n, the integrations, local AI and the installable app. */
export const PlatformConnectionsSettings = () => (
  <SettingsPart testId="owner-connections-settings">
    {(data) => (
      <>
        <FlowPlatformsCard data={data} />
        <IntegrationsCard key={JSON.stringify(data.settings.integrations ?? {})} data={data} />
        <AiLocalEndpointsCard data={data} />
        <PwaPlatformCard key={JSON.stringify(data.settings.pwa)} data={data} />
      </>
    )}
  </SettingsPart>
);

/** Support's settings, under the support console (the platform owner only). */
export const PlatformSupportSettings = () => (
  <SettingsPart testId="owner-support-settings-part">
    {(data) => <SupportSettingsCard key={`support-${JSON.stringify(data.settings.support)}`} data={data} />}
  </SettingsPart>
);

/**
 * Whether the hourly sweep also purges for good the accounts deleted from the owner console, once the grace period
 * passed (`account_deletion.purge_console_deleted`). Off by default — the hint says it erases data permanently.
 */
export const PurgeConsoleDeletedSetting = ({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) => (
  <div className="space-y-1.5">
    <label className="flex items-center gap-2 text-xs font-semibold text-fg-2">
      <Switch
        checked={on}
        onChange={onChange}
        label={t('owner.platform.purgeConsoleDeleted')}
        testId="owner-purge-console-deleted"
      />
      {t('owner.platform.purgeConsoleDeleted')}
    </label>
    <span className="block text-xs text-muted" data-testid="owner-purge-console-deleted-hint">
      {t('owner.platform.purgeConsoleDeletedHint')}
    </span>
  </div>
);

const Form = ({ data }: { data: PlatformSettingsResponse }) => {
  const qc = useQueryClient();
  const s = data.settings;
  const [product, setProduct] = useState(s.product_name ?? '');
  // AGPL section 13: where this installation's code is (empty = the project's repository).
  const [sourceUrl, setSourceUrl] = useState(s.source_url ?? '');
  // The sign-in screen's tagline per language (s37generic): empty = no line under the title.
  const [taglineHe, setTaglineHe] = useState(s.login_subtitle?.he ?? '');
  const [taglineEn, setTaglineEn] = useState(s.login_subtitle?.en ?? '');
  const [sender, setSender] = useState(s.email.sender_name ?? '');
  const [replyTo, setReplyTo] = useState(s.email.reply_to ?? '');
  // Incoming email: the domain whose MX points at the mail provider; empty = off.
  const [inboundDomain, setInboundDomain] = useState(s.email.inbound_domain ?? '');
  // the limits of one incoming message (empty = the default, shown as the placeholder).
  const [inboundLimits, setInboundLimits] = useState<Record<InboundLimitField, string>>(
    () =>
      Object.fromEntries(INBOUND_LIMIT_KEYS.map((k) => [k, s.email[k]?.toString() ?? ''])) as Record<
        InboundLimitField,
        string
      >,
  );
  const inboundLimitOk = (k: InboundLimitField) => {
    const v = inboundLimits[k].trim();
    const [min, max] = INBOUND_LIMIT_FIELDS[k].range;
    return !v || (/^\d{1,6}$/.test(v) && Number(v) >= min && Number(v) <= max);
  };
  const [sms, setSms] = useState(s.sms.sender_id ?? '');
  const [logo, setLogo] = useState(s.api_docs.logo_url ?? '');
  const [color, setColor] = useState(s.api_docs.brand_color ?? '');
  const [accent, setAccent] = useState(s.email.accent_color ?? '');
  const [mailStyle, setMailStyle] = useState<MailStyle>(s.email.style ?? DEFAULT_MAIL_STYLE);
  const [testPerHour, setTestPerHour] = useState(s.email.test_emails_per_hour?.toString() ?? '');
  const [invitesPerHour, setInvitesPerHour] = useState(s.email.invite_emails_per_hour?.toString() ?? '');
  const [automationPerDay, setAutomationPerDay] = useState(s.email.automation_emails_per_day?.toString() ?? '');
  const [mapOrigins, setMapOrigins] = useState((s.maps?.approved_origins ?? []).join(', '));
  const mapOriginList = mapOrigins
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  const [embedOrigins, setEmbedOrigins] = useState((s.embedding?.allowed_origins ?? []).join(', '));
  const embedOriginList = embedOrigins
    .split(/[\s,]+/)
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
  // The default minimum password length: empty = the built-in default.
  const [passwordMin, setPasswordMin] = useState(
    s.password.min_length === DEFAULT_PASSWORD_MIN_LENGTH ? '' : String(s.password.min_length),
  );
  const passwordMinValue = passwordMin.trim() ? Number(passwordMin.trim()) : DEFAULT_PASSWORD_MIN_LENGTH;
  const passwordMinOk =
    !passwordMin.trim() ||
    (/^\d{1,2}$/.test(passwordMin.trim()) &&
      passwordMinValue >= PASSWORD_MIN_FLOOR &&
      passwordMinValue <= PASSWORD_MIN_CEILING);
  // account deletion's grace period and the export link's life (days; empty = the default).
  const [graceDays, setGraceDays] = useState(
    s.account_deletion.grace_days === ACCOUNT_DELETION_GRACE_DAYS ? '' : String(s.account_deletion.grace_days),
  );
  const [exportDays, setExportDays] = useState(
    s.account_deletion.export_days === ACCOUNT_EXPORT_DAYS ? '' : String(s.account_deletion.export_days),
  );
  const [purgeConsoleDeleted, setPurgeConsoleDeleted] = useState(s.account_deletion.purge_console_deleted);
  const daysOf = (v: string, fallback: number) => (v.trim() ? Number(v.trim()) : fallback);
  const daysOk = (v: string, [min, max]: readonly [number, number]) =>
    !v.trim() || (/^\d{1,3}$/.test(v.trim()) && Number(v.trim()) >= min && Number(v.trim()) <= max);
  const graceOk = daysOk(graceDays, ACCOUNT_DELETION_GRACE_RANGE);
  const exportOk = daysOk(exportDays, ACCOUNT_EXPORT_DAYS_RANGE);
  const [limits, setLimits] = useState<Record<LimitKey, string>>(
    () =>
      Object.fromEntries(
        LIMITS.map((l) => [l.key, s.api_limits[l.key] === BUILTIN[l.key] ? '' : String(s.api_limits[l.key])]),
      ) as Record<LimitKey, string>,
  );
  const parsed = Object.fromEntries(LIMITS.map((l) => [l.key, parseLimit(limits[l.key], l.kind)])) as Record<
    LimitKey,
    number | null | 'invalid'
  >;
  const ok =
    (!sender.trim() || SENDER.test(sender.trim())) &&
    (!replyTo.trim() || EMAIL.test(replyTo.trim())) &&
    (!inboundDomain.trim() || mailDomainSchema.safeParse(inboundDomain.trim()).success) &&
    INBOUND_LIMIT_KEYS.every(inboundLimitOk) &&
    (!sms.trim() || SMS_SENDER.test(sms.trim())) &&
    (!logo.trim() || LOGO_URL.test(logo.trim())) &&
    (!color.trim() || HEX.test(color.trim())) &&
    (!accent.trim() || HEX.test(accent.trim())) &&
    (!testPerHour.trim() || PER_HOUR.test(testPerHour.trim())) &&
    (!invitesPerHour.trim() || INVITES_PER_HOUR.test(invitesPerHour.trim())) &&
    (!automationPerDay.trim() || AUTOMATION_PER_DAY.test(automationPerDay.trim())) &&
    mapOriginList.length <= 50 &&
    mapOriginList.every((o) => MAP_ORIGIN.test(o)) &&
    embedOriginList.length <= 20 &&
    embedOriginList.every((o) => EMBED_ORIGIN.test(o)) &&
    passwordMinOk &&
    graceOk &&
    exportOk &&
    !Object.values(parsed).includes('invalid');
  const save = useMutation({
    mutationFn: () => {
      const body: UpdatePlatformSettings = {
        product_name: product.trim() || null,
        source_url: sourceUrl.trim() || null,
        login_subtitle: { he: taglineHe.trim() || null, en: taglineEn.trim() || null },
        email: {
          sender_name: sender.trim() || null,
          reply_to: replyTo.trim() || null,
          inbound_domain: inboundDomain.trim().toLowerCase() || null,
          ...(Object.fromEntries(
            INBOUND_LIMIT_KEYS.map((k) => [k, inboundLimits[k].trim() ? Number(inboundLimits[k].trim()) : null]),
          ) as Record<InboundLimitField, number | null>),
          accent_color: accent.trim() || null,
          style: mailStyle,
          test_emails_per_hour: testPerHour.trim() ? Number(testPerHour.trim()) : null,
          invite_emails_per_hour: invitesPerHour.trim() ? Number(invitesPerHour.trim()) : null,
          automation_emails_per_day: automationPerDay.trim() ? Number(automationPerDay.trim()) : null,
        },
        maps: { approved_origins: mapOriginList },
        embedding: { allowed_origins: embedOriginList },
        sms: { sender_id: sms.trim() || null },
        api_docs: { logo_url: logo.trim() || null, brand_color: color.trim() || null },
        password: { min_length: passwordMinValue },
        account_deletion: {
          grace_days: daysOf(graceDays, ACCOUNT_DELETION_GRACE_DAYS),
          export_days: daysOf(exportDays, ACCOUNT_EXPORT_DAYS),
          purge_console_deleted: purgeConsoleDeleted,
        },
        api_limits: Object.fromEntries(
          LIMITS.map((l) => [l.key, typeof parsed[l.key] === 'number' ? parsed[l.key] : BUILTIN[l.key]]),
        ) as PlatformApiLimits,
      };
      return api().patch<PlatformSettingsResponse>('/platform/settings', body);
    },
    onSuccess: (res) => {
      qc.setQueryData(KEY, res);
      void qc.invalidateQueries({ queryKey: queryKeys.authConfig }); // the product name / tagline (tab title)
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const f = data.fallbacks;
  // No sender anywhere = every SMS fails (sender_not_configured): say so where it is fixed.
  const noSmsSender = !s.sms.sender_id && !f.sms_sender_id;
  return (
    <Card className="space-y-4">
      {noSmsSender ? (
        <div data-testid="owner-sms-sender-missing">
          <Notice tone="warn">{t('owner.platform.smsSenderMissing')}</Notice>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('owner.platform.productName')} hint={t('owner.platform.productNameHint')}>
          <Input
            value={product}
            maxLength={60}
            placeholder={f.product_name}
            onChange={(e) => setProduct(e.target.value)}
            data-testid="owner-product-name"
          />
        </Field>
        <Field label={t('owner.platform.sourceUrl')} hint={t('owner.platform.sourceUrlHint')}>
          <Input
            value={sourceUrl}
            maxLength={300}
            dir="ltr"
            className="text-start"
            placeholder={DEFAULT_SOURCE_URL}
            onChange={(e) => setSourceUrl(e.target.value)}
            data-testid="owner-source-url"
          />
        </Field>
        <Field label={t('owner.platform.emailAddress')} hint={t('owner.platform.emailAddressHint')}>
          <Input
            value={f.email_address ?? t('owner.platform.notConfigured')}
            readOnly
            dir="ltr"
            className="text-start"
          />
        </Field>
        <Field label={t('owner.platform.loginSubtitleHe')} hint={t('owner.platform.loginSubtitleHint')}>
          <Input
            value={taglineHe}
            maxLength={160}
            dir="rtl"
            onChange={(e) => setTaglineHe(e.target.value)}
            data-testid="owner-login-subtitle-he"
          />
        </Field>
        <Field label={t('owner.platform.loginSubtitleEn')} hint={t('owner.platform.loginSubtitleHint')}>
          <Input
            value={taglineEn}
            maxLength={160}
            dir="ltr"
            className="text-start"
            onChange={(e) => setTaglineEn(e.target.value)}
            data-testid="owner-login-subtitle-en"
          />
        </Field>
        <Field label={t('owner.platform.senderName')} hint={t('owner.platform.senderNameHint')}>
          <Input
            value={sender}
            maxLength={80}
            placeholder={product.trim() || f.product_name}
            onChange={(e) => setSender(e.target.value)}
            data-testid="owner-sender-name"
          />
        </Field>
        <Field label={t('admin.messaging.replyTo')} hint={t('owner.platform.replyToHint')}>
          <Input
            value={replyTo}
            maxLength={254}
            dir="ltr"
            className="text-start"
            placeholder="name@example.com"
            onChange={(e) => setReplyTo(e.target.value)}
            data-testid="owner-reply-to"
          />
        </Field>
        <Field label={t('owner.platform.inboundDomain')} hint={t('owner.platform.inboundDomainHint')}>
          <Input
            value={inboundDomain}
            maxLength={253}
            dir="ltr"
            className="text-start"
            placeholder="in.example.com"
            onChange={(e) => setInboundDomain(e.target.value)}
            data-testid="owner-inbound-domain"
          />
        </Field>
        <Field label={t('owner.platform.inboundLimits')} hint={t('owner.platform.inboundLimitsHint')}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {INBOUND_LIMIT_KEYS.map((k) => (
              <label key={k} className="flex min-w-0 flex-col gap-1 text-xs text-muted">
                {tDynamic(`owner.platform.${k}`)}
                <Input
                  value={inboundLimits[k]}
                  inputMode="numeric"
                  dir="ltr"
                  className="h-8 text-center"
                  placeholder={String(INBOUND_LIMIT_FIELDS[k].fallback)}
                  aria-invalid={!inboundLimitOk(k) || undefined}
                  data-tip={t('owner.platform.inboundLimitRange', {
                    min: INBOUND_LIMIT_FIELDS[k].range[0],
                    max: INBOUND_LIMIT_FIELDS[k].range[1],
                  })}
                  onChange={(e) =>
                    setInboundLimits((v) => ({ ...v, [k]: e.target.value.replace(/\D/g, '').slice(0, 6) }))
                  }
                  data-testid={`owner-${k.replaceAll('_', '-')}`}
                />
              </label>
            ))}
          </div>
        </Field>
        <Field label={t('owner.platform.emailAccent')} hint={t('owner.platform.emailAccentHint')}>
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-7 w-7 shrink-0 rounded-md border border-line"
              style={{ background: HEX.test(accent.trim()) ? accent.trim() : f.email_accent_color }}
            />
            <Input
              value={accent}
              maxLength={7}
              dir="ltr"
              className="text-start"
              placeholder={f.email_accent_color}
              onChange={(e) => setAccent(e.target.value)}
              data-testid="owner-email-accent"
            />
          </div>
        </Field>
        <Field label={t('owner.platform.emailStyle')} hint={t('owner.platform.emailStyleHint')}>
          <Segmented
            label={t('owner.platform.emailStyle')}
            testId="owner-email-style"
            value={mailStyle}
            onChange={setMailStyle}
            options={MAIL_STYLES.map((v) => ({
              value: v,
              label: t(`admin.messaging.style.${v}`),
              testId: `owner-email-style-${v}`,
            }))}
          />
        </Field>
        <Field label={t('owner.platform.testEmails')} hint={t('owner.platform.testEmailsHint')}>
          <Input
            value={testPerHour}
            maxLength={4}
            inputMode="numeric"
            dir="ltr"
            className="text-start"
            placeholder={String(f.test_emails_per_hour)}
            onChange={(e) => setTestPerHour(e.target.value)}
            data-testid="owner-test-emails"
          />
        </Field>
        <Field label={t('owner.platform.inviteEmails')} hint={t('owner.platform.inviteEmailsHint')}>
          <Input
            value={invitesPerHour}
            maxLength={5}
            inputMode="numeric"
            dir="ltr"
            className="text-start"
            placeholder={String(f.invite_emails_per_hour ?? '')}
            onChange={(e) => setInvitesPerHour(e.target.value)}
            data-testid="owner-invite-emails"
          />
        </Field>
        <Field label={t('owner.platform.automationEmails')} hint={t('owner.platform.automationEmailsHint')}>
          <Input
            value={automationPerDay}
            maxLength={6}
            inputMode="numeric"
            dir="ltr"
            className="text-start"
            placeholder={String(f.automation_emails_per_day ?? '')}
            onChange={(e) => setAutomationPerDay(e.target.value)}
            data-testid="owner-automation-emails"
          />
        </Field>
        <Field label={t('owner.platform.mapOrigins')} hint={t('owner.platform.mapOriginsHint')}>
          <Input
            value={mapOrigins}
            dir="ltr"
            className="text-start"
            placeholder="https://api.maptiler.com"
            onChange={(e) => setMapOrigins(e.target.value)}
            data-testid="owner-map-origins"
          />
        </Field>
        <Field label={t('owner.platform.embedOrigins')} hint={t('owner.platform.embedOriginsHint')}>
          <Input
            value={embedOrigins}
            dir="ltr"
            className="text-start"
            placeholder="chrome-extension://abcdefghijklmnopabcdefghijklmnop"
            onChange={(e) => setEmbedOrigins(e.target.value)}
            data-testid="owner-embed-origins"
          />
        </Field>
        <Field
          label={t('pass.owner.minLength')}
          hint={t('pass.owner.minLengthHint', { min: PASSWORD_MIN_FLOOR, max: PASSWORD_MIN_CEILING })}
        >
          <Input
            value={passwordMin}
            maxLength={2}
            inputMode="numeric"
            dir="ltr"
            className="text-start"
            placeholder={String(DEFAULT_PASSWORD_MIN_LENGTH)}
            aria-invalid={!passwordMinOk}
            onChange={(e) => setPasswordMin(e.target.value)}
            data-testid="owner-password-min-length"
          />
        </Field>
        <Field
          label={t('owner.platform.deletionGraceDays')}
          hint={t('owner.platform.deletionGraceDaysHint', {
            min: ACCOUNT_DELETION_GRACE_RANGE[0],
            max: ACCOUNT_DELETION_GRACE_RANGE[1],
          })}
        >
          <Input
            value={graceDays}
            maxLength={3}
            inputMode="numeric"
            dir="ltr"
            className="text-start"
            placeholder={String(ACCOUNT_DELETION_GRACE_DAYS)}
            aria-invalid={!graceOk}
            onChange={(e) => setGraceDays(e.target.value)}
            data-testid="owner-deletion-grace-days"
          />
        </Field>
        <PurgeConsoleDeletedSetting on={purgeConsoleDeleted} onChange={setPurgeConsoleDeleted} />
        <Field
          label={t('owner.platform.exportDays')}
          hint={t('owner.platform.exportDaysHint', {
            min: ACCOUNT_EXPORT_DAYS_RANGE[0],
            max: ACCOUNT_EXPORT_DAYS_RANGE[1],
          })}
        >
          <Input
            value={exportDays}
            maxLength={2}
            inputMode="numeric"
            dir="ltr"
            className="text-start"
            placeholder={String(ACCOUNT_EXPORT_DAYS)}
            aria-invalid={!exportOk}
            onChange={(e) => setExportDays(e.target.value)}
            data-testid="owner-export-days"
          />
        </Field>
        <Field label={t('admin.messaging.smsSender')} hint={t('owner.platform.smsSenderHint')}>
          <Input
            value={sms}
            maxLength={15}
            dir="ltr"
            className="text-start"
            placeholder={f.sms_sender_id ?? ''}
            onChange={(e) => setSms(e.target.value)}
            data-testid="owner-sms-sender"
          />
        </Field>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-fg">{t('owner.platform.apiDocsTitle')}</h3>
        <p className="text-xs text-muted">{t('owner.platform.apiDocsHint')}</p>
        {/*: both references are served by this deployment (same origin, any domain); the internal one
            answers only the platform owner's session. */}
        <div className="flex flex-wrap gap-2" data-testid="owner-api-docs-links">
          {(
            [
              ['/api/docs', 's37intdocs.publicRef', 'owner-api-docs-public'],
              ['/api/docs/internal', 's37intdocs.internalRef', 'owner-api-docs-internal'],
            ] as const
          ).map(([href, key, testId]) => (
            <a
              key={href}
              href={href}
              target="_blank"
              rel="noreferrer"
              data-testid={testId}
              title={key === 's37intdocs.internalRef' ? t('s37intdocs.internalRefHint') : undefined}
              className="press inline-flex h-8 items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-2.5 text-[0.8125rem] whitespace-nowrap text-heading hover:bg-surface-2"
            >
              {t(key)}
            </a>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('owner.platform.apiDocsLogo')} hint={t('owner.platform.apiDocsLogoHint')}>
            <Input
              value={logo}
              maxLength={500}
              dir="ltr"
              className="text-start"
              placeholder={f.api_docs_logo_url ?? 'https://'}
              onChange={(e) => setLogo(e.target.value)}
              data-testid="owner-api-docs-logo"
            />
          </Field>
          <Field label={t('owner.platform.apiDocsColor')} hint={t('owner.platform.apiDocsColorHint')}>
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="h-7 w-7 shrink-0 rounded-md border border-line"
                style={{ background: HEX.test(color.trim()) ? color.trim() : (f.api_docs_brand_color ?? undefined) }}
              />
              <Input
                value={color}
                maxLength={7}
                dir="ltr"
                className="text-start"
                placeholder={f.api_docs_brand_color ?? '#0d3b35'}
                onChange={(e) => setColor(e.target.value)}
                data-testid="owner-api-docs-color"
              />
            </div>
          </Field>
        </div>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-fg">{t('admin.apiLimits.title')}</h3>
        <p className="text-xs text-muted">{t('owner.platform.limitsHint')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {LIMITS.map((l) => (
            <LimitField
              key={l.key}
              label={tDynamic(l.label)}
              kind={l.kind}
              value={limits[l.key]}
              onChange={(v) => setLimits((x) => ({ ...x, [l.key]: v }))}
              fallback={BUILTIN[l.key]}
              testId={`owner-limit-${l.key}`}
            />
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <Button busy={save.isPending} disabled={!ok} onClick={() => save.mutate()} data-testid="owner-platform-save">
          {t('common.save')}
        </Button>
      </div>
    </Card>
  );
};
