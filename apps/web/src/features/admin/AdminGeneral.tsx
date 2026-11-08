// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import {
  type AccountDetail,
  COMMON_CURRENCIES,
  COUNTRY_CODES,
  countryName,
  flagEmoji,
  getRegion,
  currencySymbol,
  DATE_FORMATS,
  type DateFormat,
  type DefaultStatusLabel,
  labelColorKey,
  type GroupColor,
  type MessageKey,
  type MyAccount,
  t,
  todayIn,
  type UpdateAccount,
} from '@bines/shared';
import {
  Badge,
  Button,
  Calendar,
  Card,
  cn,
  Field,
  formatIsoDate,
  Input,
  Notice,
  Picker,
  Segmented,
  SkeletonRows,
  Switch,
} from '@bines/ui';
import { Icon } from '../../lib/icons';
import { timeZones, zoneLabel } from '../../lib/timezones';
import { ColorGrid, tagVars } from '../../lib/label-color';
import { errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { Popover } from '../board/cells/Popover';
import { LabelEditor } from '../board/cells/LabelEditor';
import { AccountLogo } from './AccountLogo';
import { AccountDataSection } from './AccountData';
import { EmailOpenPicker } from '../account/EmailOpenPicker';
import { IconStylePicker } from '../account/IconStylePicker';
import { CardWidthDefaults } from './CardWidthDefaults';
import { ThemeEditor } from '../idocs/ThemeEditor';
import { ApiLimitsSection, MessagingSection } from './AdminMessaging';
import { AdminSmsSection } from '../phone/AdminSmsSection';
import { AdminPwaAppSection } from '../../pwa/AdminPwaSection';
import { GuestsSection } from './AdminGuests';
import { MAX_LOGO_BYTES, useAccountDetail, useAccountLogo, useUpdateAccount } from './account-settings';
import { h2, Row } from './admin-parts';
import { DownloadsCard } from './DownloadsCard';
import { CalendarSection } from './CalendarSection';
import { ToursAdminCard } from '../tours/TourSettings';

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
  <Card className="p-0">
    <div className="space-y-0.5 border-b border-line-soft px-3.5 pt-3.5 pb-3" data-testid={testId}>
      <h2 className={h2}>{title}</h2>
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
    <div>{children}</div>
  </Card>
);

/** "24/12/2026" in the chosen pattern — the example next to each date format. */
const sampleDate = (f: DateFormat) => f.replace('DD', '24').replace('MM', '12').replace('YYYY', '2026');

type Patch = NonNullable<UpdateAccount['settings']>;

/**
 * Administration → כללי (08 §2, account admin A3): the account's name and logo, dates and currency, what new
 * boards / groups / status columns start with, and the system announcement. Every control saves on its own.
 */
export const AdminGeneral = ({ account }: { account: MyAccount }) => {
  const detail = useAccountDetail(account);
  const update = useUpdateAccount(account);
  if (detail.isError) return <Notice tone="error">{errorMessage(detail.error)}</Notice>;
  if (!detail.data) return <SkeletonRows rows={6} label={t('app.loading')} />;
  const save = (patch: UpdateAccount, done?: () => void) =>
    update.mutate(patch, {
      onSuccess: () => {
        showToast({ message: t('admin.general.saved') });
        done?.();
      },
      onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
    });
  const settings = (s: Patch, done?: () => void) => save({ settings: s }, done);
  const d = detail.data;
  return (
    <div className="space-y-4" data-testid="admin-general">
      <ProfileSection account={account} detail={d} busy={update.isPending} onSave={save} />
      <AdminPwaAppSection account={account} />
      <LocaleSection detail={d} onSave={settings} />
      <CalendarSection detail={d} busy={update.isPending} onSave={settings} />
      <DefaultsSection detail={d} busy={update.isPending} onSave={settings} />
      <DocThemeSection detail={d} onSave={settings} />
      <UpdatesSection detail={d} busy={update.isPending} onSave={settings} />
      <DownloadsCard account={account} />
      <ToursAdminCard account={account} />
      <GuestsSection
        editStructure={d.settings.permissions.guests_edit_structure}
        busy={update.isPending}
        onChange={(guests_edit_structure) => settings({ permissions: { guests_edit_structure } })}
      />
      <MessagingSection account={account} detail={d} busy={update.isPending} onSave={settings} />
      <AdminSmsSection
        key={JSON.stringify(d.settings.sms.limits)}
        detail={d}
        busy={update.isPending}
        onSave={settings}
      />
      <ApiLimitsSection
        key={JSON.stringify(d.settings.api_limits)}
        detail={d}
        busy={update.isPending}
        onSave={settings}
      />
      <AnnouncementSection
        key={d.settings.announcement?.id ?? 'none'}
        detail={d}
        busy={update.isPending}
        onSave={settings}
      />
      <AccountDataSection account={account} />
    </div>
  );
};

// ---- updates: who saw them ("seen by") ----
const UpdatesSection = ({
  detail,
  busy,
  onSave,
}: {
  detail: AccountDetail;
  busy: boolean;
  onSave: (s: Patch) => void;
}) => (
  <Section title={t('admin.updates.title')} testId="admin-general-updates">
    <Row label={t('admin.updates.showViews')} hint={t('admin.updates.showViewsHint')}>
      <Switch
        checked={detail.settings.permissions.show_update_views}
        disabled={busy}
        label={t('admin.updates.showViews')}
        testId="admin-show-update-views"
        onChange={(show_update_views) => onSave({ permissions: { show_update_views } })}
      />
    </Row>
    {/* r18boardviews: "צפו בבורד" in every board's header. */}
    <Row label={t('admin.boards.showViewers')} hint={t('admin.boards.showViewersHint')}>
      <Switch
        checked={detail.settings.permissions.show_board_viewers}
        disabled={busy}
        label={t('admin.boards.showViewers')}
        testId="admin-show-board-viewers"
        onChange={(show_board_viewers) => onSave({ permissions: { show_board_viewers } })}
      />
    </Row>
    {/* the header's faces are who opened the board in the last X hours; the rest are "earlier". */}
    {detail.settings.permissions.show_board_viewers ? (
      <Row label={t('admin.boards.viewersRecentHours')} hint={t('admin.boards.viewersRecentHint')}>
        <HoursSetting
          value={detail.settings.permissions.board_viewers_recent_hours}
          disabled={busy}
          onSave={(board_viewers_recent_hours) => onSave({ permissions: { board_viewers_recent_hours } })}
        />
      </Row>
    ) : null}
  </Section>
);

/** A whole number of hours (1–720), saved on Enter / leaving the field (an invalid value goes back). */
const HoursSetting = ({
  value,
  disabled,
  onSave,
}: {
  value: number;
  disabled: boolean;
  onSave: (n: number) => void;
}) => {
  const [draft, setDraft] = useState(String(value));
  const n = Number(draft);
  const valid = draft !== '' && Number.isInteger(n) && n >= 1 && n <= 720;
  const commit = () => {
    if (valid && n !== value) onSave(n);
    else if (!valid) setDraft(String(value));
  };
  return (
    <Input
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value.replace(/\D/g, '').slice(0, 3))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      inputMode="numeric"
      dir="ltr"
      className="h-8 w-[4.5rem] text-center"
      aria-label={t('admin.boards.viewersRecentHours')}
      aria-invalid={!valid || undefined}
      data-testid="admin-board-viewers-hours"
    />
  );
};

// ---- the account: name, logo, address, your role ----
const ProfileSection = ({
  account,
  detail,
  busy,
  onSave,
}: {
  account: MyAccount;
  detail: AccountDetail;
  busy: boolean;
  onSave: (patch: UpdateAccount, done?: () => void) => void;
}) => {
  const [name, setName] = useState(detail.name);
  const logo = useAccountLogo(account);
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
  const trimmed = name.trim();
  return (
    <Section title={t('admin.general.profile')} testId="admin-general-profile">
      <Row label={t('admin.general.logo')} hint={t('admin.general.logoHint', { mb: MAX_LOGO_BYTES / 1024 / 1024 })}>
        <AccountLogo account={{ ...account, name: detail.name }} src={detail.logo_url} size={44} />
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,image/avif,image/bmp"
          className="hidden"
          onChange={onFile}
          data-testid="admin-logo-input"
        />
        <Button
          variant="secondary"
          size="sm"
          busy={logo.isPending}
          onClick={() => fileInput.current?.click()}
          data-testid="admin-logo-upload"
        >
          <Icon name="upload" size={14} />
          {detail.logo_url ? t('admin.general.logoReplace') : t('admin.general.logoUpload')}
        </Button>
        {detail.logo_url ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={logo.isPending}
            onClick={() => logo.mutate(null)}
            data-testid="admin-logo-remove"
          >
            {t('admin.general.logoRemove')}
          </Button>
        ) : null}
      </Row>
      <Row label={t('admin.general.name')}>
        <form
          className="flex items-center gap-2 max-sm:w-full"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmed && trimmed !== detail.name) onSave({ name: trimmed });
          }}
        >
          <Input
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
            aria-label={t('admin.general.name')}
            className="w-64 max-sm:w-auto max-sm:flex-1"
            data-testid="admin-name-input"
          />
          <Button
            type="submit"
            size="sm"
            busy={busy}
            disabled={!trimmed || trimmed === detail.name}
            data-testid="admin-name-save"
          >
            {t('common.save')}
          </Button>
        </form>
      </Row>
      <Row label={t('admin.general.slug')}>
        <span className="font-semibold text-fg" dir="ltr" data-testid="admin-general-slug">
          /a/{account.slug}
        </span>
      </Row>
      <Row label={t('admin.general.yourRole')}>
        <span className="font-semibold text-fg" data-testid="admin-general-role">
          {t(`role.${account.role}` as MessageKey)}
        </span>
      </Row>
    </Section>
  );
};

// ---- dates, time and currency ----
const LocaleSection = ({ detail, onSave }: { detail: AccountDetail; onSave: (s: Patch) => void }) => {
  const l = detail.settings.locale;
  const currencies = (COMMON_CURRENCIES as readonly string[]).includes(l.currency)
    ? [...COMMON_CURRENCIES]
    : [...COMMON_CURRENCIES, l.currency];
  return (
    <Section title={t('admin.locale.title')} hint={t('admin.locale.hint')} testId="admin-general-locale">
      <Row label={t('admin.locale.timezone')} hint={t('admin.locale.timezoneHint')}>
        <Picker<string>
          label={t('admin.locale.timezone')}
          testId="admin-timezone"
          className="w-64"
          value={l.timezone}
          onChange={(timezone) => onSave({ locale: { timezone } })}
          options={timeZones(l.timezone).map((z) => ({ value: z, label: zoneLabel(z) }))}
        />
      </Row>
      <Row label={t('admin.locale.weekend')}>
        <Segmented
          label={t('admin.locale.weekend')}
          value={l.weekend}
          onChange={(weekend) => onSave({ locale: { weekend } })}
          options={(['fri_sat', 'sat_sun'] as const).map((w) => ({
            value: w,
            label: t(`admin.locale.weekend.${w}`),
            testId: `admin-weekend-${w}`,
          }))}
        />
      </Row>
      <Row label={t('admin.locale.firstDay')} hint={t('admin.locale.firstDayHint')}>
        <Picker
          label={t('admin.locale.firstDay')}
          testId="admin-first-day"
          className="w-40"
          value={String(l.first_day)}
          onChange={(v) => onSave({ locale: { first_day: Number(v) } })}
          options={[0, 1, 2, 3, 4, 5, 6].map((d) => ({ value: String(d), label: t(`weekday.${d}` as MessageKey) }))}
        />
      </Row>
      <Row label={t('admin.locale.dateFormat')}>
        <Picker
          label={t('admin.locale.dateFormat')}
          testId="admin-date-format"
          className="w-56"
          value={(DATE_FORMATS as readonly string[]).includes(l.date_format) ? l.date_format : 'DD/MM/YYYY'}
          onChange={(date_format) => onSave({ locale: { date_format: date_format as DateFormat } })}
          options={DATE_FORMATS.map((f) => ({ value: f, label: `${f} · ${sampleDate(f)}` }))}
        />
      </Row>
      <Row label={t('admin.locale.timeFormat')}>
        <Segmented
          label={t('admin.locale.timeFormat')}
          value={l.time_format}
          onChange={(time_format) => onSave({ locale: { time_format } })}
          options={(['24h', '12h'] as const).map((f) => ({
            value: f,
            label: t(`admin.locale.time.${f}`),
            testId: `admin-time-${f}`,
          }))}
        />
      </Row>
      <Row label={t('admin.locale.country')} hint={t('admin.locale.countryHint')}>
        <Picker
          label={t('admin.locale.country')}
          testId="admin-country"
          className="w-56"
          searchable
          value={l.country}
          onChange={(country) => onSave({ locale: { country } })}
          options={[...COUNTRY_CODES]
            .map((c) => ({ value: c, label: `${flagEmoji(c)} ${countryName(c, getRegion().language)}`, keywords: c }))
            .sort((a, b) => a.label.localeCompare(b.label))}
        />
      </Row>
      <Row label={t('admin.locale.currency')} hint={t('admin.locale.currencyHint')}>
        <Picker
          label={t('admin.locale.currency')}
          testId="admin-currency"
          className="w-40"
          value={l.currency}
          onChange={(currency) => onSave({ locale: { currency } })}
          options={currencies.map((c) => ({ value: c, label: `${c} · ${currencySymbol(c)}` }))}
        />
      </Row>
    </Section>
  );
};

// --- interactive documents' default look ----
const DocThemeSection = ({
  detail,
  onSave,
}: {
  detail: AccountDetail;
  onSave: (s: Patch, done?: () => void) => void;
}) => {
  const themes = detail.settings.idoc_themes;
  return (
    <Section title={t('idoc.theme.adminTitle')} hint={t('idoc.theme.adminHint')} testId="admin-general-idoc-theme">
      <div className="grid gap-6 lg:grid-cols-2">
        {(['guests', 'members'] as const).map((who) => (
          <div key={who} className="grid content-start gap-2">
            <h3 className="text-sm font-semibold text-heading">{t(`idoc.theme.${who}`)}</h3>
            <ThemeEditor
              theme={themes[who]}
              testId={`admin-idoc-theme-${who}`}
              onChange={(theme) => onSave({ idoc_themes: { [who]: theme } })}
            />
          </div>
        ))}
      </div>
    </Section>
  );
};

// ---- defaults for new boards, groups and status columns ----
const DefaultsSection = ({
  detail,
  busy,
  onSave,
}: {
  detail: AccountDetail;
  busy: boolean;
  onSave: (s: Patch, done?: () => void) => void;
}) => {
  const defaults = detail.settings.defaults;
  const [term, setTerm] = useState(defaults.item_terminology === 'item' ? '' : defaults.item_terminology);
  const [editing, setEditing] = useState(false);
  const termValue = term.trim() || 'item';
  const colors = defaults.group_colors;
  const toggleColor = (c: GroupColor) =>
    onSave({ defaults: { group_colors: colors.includes(c) ? colors.filter((x) => x !== c) : [...colors, c] } });
  const saveLabels = (labels: DefaultStatusLabel[], leaving = false) => {
    if (!labels.length) {
      showToast({ message: t('admin.defaults.statusEmpty'), tone: 'error' });
      return;
    }
    // Saved on leaving: the editor is closed already and may be open again by now.
    onSave({ defaults: { status_labels: labels } }, leaving ? undefined : () => setEditing(false));
  };
  return (
    <Section title={t('admin.defaults.title')} hint={t('admin.defaults.hint')} testId="admin-general-defaults">
      <Row label={t('admin.defaults.terminology')} hint={t('admin.defaults.terminologyHint')}>
        <form
          className="flex items-center gap-2 max-sm:w-full"
          onSubmit={(e) => {
            e.preventDefault();
            if (termValue !== defaults.item_terminology) onSave({ defaults: { item_terminology: termValue } });
          }}
        >
          <Input
            value={term}
            maxLength={40}
            placeholder={t('board.itemDefault')}
            onChange={(e) => setTerm(e.target.value)}
            aria-label={t('admin.defaults.terminology')}
            className="w-44 max-sm:w-auto max-sm:flex-1"
            data-testid="admin-terminology-input"
          />
          <Button
            type="submit"
            size="sm"
            busy={busy}
            disabled={termValue === defaults.item_terminology}
            data-testid="admin-terminology-save"
          >
            {t('common.save')}
          </Button>
        </form>
      </Row>
      <Row label={t('admin.defaults.status')} hint={t('admin.defaults.statusHint')} testId="admin-status-defaults">
        <ul className="flex max-w-[420px] flex-wrap gap-1.5" aria-label={t('admin.defaults.status')}>
          {defaults.status_labels.map((l, i) => (
            <li
              key={i}
              data-testid="admin-status-label"
              data-label={l.label}
              data-color={l.color}
              className="label-tag h-7 min-w-16 justify-center text-xs"
              style={tagVars(l.color)}
            >
              {l.label || ' '}
              {l.is_done ? <span aria-label={t('labels.done')}>✓</span> : null}
            </li>
          ))}
        </ul>
        <span className="relative">
          <Button variant="secondary" size="sm" onClick={() => setEditing((v) => !v)} data-testid="admin-status-edit">
            <Icon name="edit" size={14} />
            {t('admin.defaults.statusEdit')}
          </Button>
          <Popover open={editing} onClose={() => setEditing(false)} align="end" className="p-3">
            <LabelEditor
              labels={defaults.status_labels.map((l, i) => ({ ...l, id: i, index: i }))}
              withColor
              maxLength={30}
              busy={busy}
              onCancel={() => setEditing(false)}
              onSave={(rows, o) =>
                saveLabels(
                  rows.map((r) => ({
                    label: r.label.trim(),
                    color: labelColorKey(r.color),
                    ...(r.is_done ? { is_done: true } : {}),
                  })),
                  o?.leaving,
                )
              }
            />
          </Popover>
        </span>
      </Row>
      <Row
        label={t('admin.defaults.groupColors')}
        hint={t('admin.defaults.groupColorsHint')}
        testId="admin-group-colors"
      >
        <div className="flex max-w-[440px] flex-col items-end gap-2 max-sm:items-stretch">
          {/* pal40: all forty colours, the app's colour picker; the number is the order new groups take them. */}
          <ColorGrid
            kind="pressed"
            size="lg"
            label={t('admin.defaults.groupColors')}
            itemTestId="admin-group-color"
            selected={(c) => colors.includes(c)}
            onPick={toggleColor}
            itemClassName={(_, on) =>
              cn(
                'grid place-items-center text-[0.6875rem] font-bold text-[var(--on-c)] ring-offset-2 ring-offset-[var(--surface)]',
                on ? 'ring-2 ring-[var(--heading)]' : 'opacity-70 hover:opacity-100',
              )
            }
            renderItem={(c) => (colors.includes(c) ? colors.indexOf(c) + 1 : '')}
          />
          <p className="text-xs text-muted" data-testid="admin-group-colors-summary">
            {colors.length
              ? t('admin.defaults.groupColorsChosen', { n: colors.length })
              : t('admin.defaults.groupColorsNone')}
            {colors.length ? (
              <button
                type="button"
                onClick={() => onSave({ defaults: { group_colors: [] } })}
                className="ms-2 font-semibold text-heading underline underline-offset-2 hover:no-underline"
                data-testid="admin-group-colors-reset"
              >
                {t('admin.defaults.groupColorsReset')}
              </button>
            ) : null}
          </p>
        </div>
      </Row>
      {/* new numbers columns start with the thousands separator on (each column can change it). */}
      <Row label={t('admin.defaults.numberThousands')} hint={t('admin.defaults.numberThousandsHint')}>
        <Switch
          checked={defaults.number_thousands}
          disabled={busy}
          label={t('admin.defaults.numberThousands')}
          testId="admin-number-thousands"
          onChange={(number_thousands) => onSave({ defaults: { number_thousands } })}
        />
      </Row>
      <CardWidthDefaults defaults={defaults} onSave={onSave} />
      {/*: the icon style of members who never chose their own (they see it after the next sign-in / reload). */}
      <Row label={t('iconStyle.adminTitle')} hint={t('iconStyle.adminHint')} className="flex-col items-stretch">
        <IconStylePicker
          value={defaults.icon_style}
          onChange={(icon_style) => onSave({ defaults: { icon_style } })}
          label={t('iconStyle.adminTitle')}
          testId="admin-icon-style"
        />
      </Row>
      {/*: what a click on an email address does for members who never chose their own. */}
      <Row label={t('emailOpen.adminTitle')} hint={t('emailOpen.adminHint')} className="flex-col items-stretch">
        <EmailOpenPicker
          value={defaults.email_open}
          onChange={(email_open) => onSave({ defaults: { email_open } })}
          label={t('emailOpen.adminTitle')}
          testId="admin-email-open"
        />
      </Row>
    </Section>
  );
};

// ---- the system announcement ----
const AnnouncementSection = ({
  detail,
  busy,
  onSave,
}: {
  detail: AccountDetail;
  busy: boolean;
  onSave: (s: Patch, done?: () => void) => void;
}) => {
  const current = detail.settings.announcement;
  const [text, setText] = useState(current?.text ?? '');
  const [url, setUrl] = useState(current?.url ?? '');
  const [until, setUntil] = useState<string | null>(current?.until ?? null);
  const [calendar, setCalendar] = useState(false);
  const [today] = useState(() => todayIn());
  const trimmedUrl = url.trim();
  const urlOk = !trimmedUrl || /^https?:\/\/\S+\.\S+/.test(trimmedUrl);
  const untilOk = !until || until >= today;
  const changed =
    text.trim() !== (current?.text ?? '') || trimmedUrl !== (current?.url ?? '') || until !== (current?.until ?? null);
  const can = !!text.trim() && text.trim().length <= 150 && urlOk && untilOk && changed;
  const expired = !!current?.until && current.until < today;
  return (
    <Section
      title={t('admin.announcement.title')}
      hint={t('admin.announcement.hint')}
      testId="admin-general-announcement"
    >
      <div className="space-y-3 p-3.5" data-testid="admin-announcement">
        {current ? (
          <div className="flex flex-wrap items-center gap-2" data-testid="admin-announcement-status">
            <Badge tone={expired ? 'neutral' : 'ok'}>
              {expired ? t('admin.announcement.expired') : t('admin.announcement.live')}
            </Badge>
            {current.until ? (
              <span className="text-xs text-muted">
                {t('admin.announcement.untilShort', { date: formatIsoDate(current.until) })}
              </span>
            ) : null}
          </div>
        ) : null}
        <Field label={t('admin.announcement.text')} hint={`${text.trim().length}/150`}>
          <Input
            value={text}
            maxLength={150}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('admin.announcement.textPlaceholder')}
            data-testid="admin-announcement-text"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label={t('admin.announcement.url')}
            hint={urlOk ? t('admin.announcement.urlHint') : t('admin.announcement.urlBad')}
          >
            <Input
              value={url}
              dir="ltr"
              inputMode="url"
              placeholder="https://"
              onChange={(e) => setUrl(e.target.value)}
              aria-invalid={!urlOk || undefined}
              className="text-start"
              data-testid="admin-announcement-url"
            />
          </Field>
          <Field
            label={t('admin.announcement.until')}
            hint={untilOk ? t('admin.announcement.untilHint') : t('admin.announcement.untilPast')}
          >
            <span className="relative flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => setCalendar((v) => !v)}
                data-testid="admin-announcement-until"
                className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-[10px] border border-line-strong bg-surface px-3 text-start text-sm text-fg hover:border-primary"
              >
                <Icon name="calendar" size={15} className="shrink-0 text-muted" />
                <span className={cn('truncate', !until && 'text-muted')}>
                  {until ? formatIsoDate(until) : t('admin.announcement.noEnd')}
                </span>
              </button>
              {until ? (
                <button
                  type="button"
                  onClick={() => setUntil(null)}
                  aria-label={t('admin.announcement.clearUntil')}
                  title={t('admin.announcement.clearUntil')}
                  data-testid="admin-announcement-until-clear"
                  className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-line-strong text-fg-2 hover:bg-surface-2"
                >
                  <Icon name="x" size={14} />
                </button>
              ) : null}
              <Popover open={calendar} onClose={() => setCalendar(false)} align="end" className="p-2">
                <Calendar
                  mode="single"
                  weekStartsOn={detail.settings.locale.first_day}
                  value={until}
                  onChange={(v) => {
                    setUntil(v);
                    setCalendar(false);
                  }}
                />
              </Popover>
            </span>
          </Field>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {current ? (
            <Button
              variant="danger-outline"
              size="sm"
              disabled={busy}
              onClick={() => onSave({ announcement: null })}
              data-testid="admin-announcement-remove"
            >
              {t('admin.announcement.remove')}
            </Button>
          ) : null}
          <Button
            size="sm"
            busy={busy}
            disabled={!can}
            onClick={() =>
              onSave({
                announcement: {
                  text: text.trim(),
                  ...(trimmedUrl ? { url: trimmedUrl } : {}),
                  ...(until ? { until } : {}),
                },
              })
            }
            data-testid="admin-announcement-save"
          >
            {current ? t('admin.announcement.update') : t('admin.announcement.publish')}
          </Button>
        </div>
      </div>
    </Section>
  );
};
