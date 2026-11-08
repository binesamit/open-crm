// SPDX-License-Identifier: AGPL-3.0-only
import { emptyIdocTheme, type IdocSettings } from '@bines/shared';
import { ThemeEditor } from '../ThemeEditor';
import { Picker, Segmented } from '@bines/ui';
import type { Column } from '../../board/board-api';
import { B, COLS, ColumnPick, LongText, NumberField, Row, Text, Toggle, UploadButton } from './fields';

/** The document's own settings (builder, "document" tab): look, money, link, contact, notifications, email. */
const CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP'];
const SWATCHES = ['', '#0d3b35', '#1d4ea8', '#5b3cc4', '#a51d33', '#8a5200', '#13221f'];

export const DocSettingsForm = ({
  accountId,
  settings,
  columns,
  onChange,
}: {
  accountId: string;
  settings: IdocSettings;
  columns: Column[];
  onChange: (s: IdocSettings) => void;
}) => {
  const set = (patch: Partial<IdocSettings>) => onChange({ ...settings, ...patch });
  return (
    <div className="grid gap-3" data-testid="idoc-doc-settings">
      <span className="text-xs text-muted">{B('look')}</span>
      <Row label={B('color')}>
        <div className="flex flex-wrap items-center gap-1.5">
          {SWATCHES.map((c) => (
            <button
              key={c || 'default'}
              type="button"
              aria-label={c || B('accountColor')}
              aria-pressed={settings.color === c}
              onClick={() => set({ color: c })}
              className="size-7 rounded-full border-2"
              style={{
                background: c || 'var(--shell)',
                borderColor: settings.color === c ? 'var(--accent)' : 'transparent',
              }}
            />
          ))}
          <Text
            value={settings.color}
            onChange={(v) =>
              set({ color: /^#?[0-9a-f]{0,6}$/i.test(v) ? (v && !v.startsWith('#') ? `#${v}` : v) : settings.color })
            }
            dir="ltr"
            placeholder="#0d3b35"
          />
        </div>
      </Row>
      <Row label={B('logo')}>
        <div className="flex items-center gap-2">
          <UploadButton
            accountId={accountId}
            accept="image/*"
            label={settings.logo_asset_id ? B('replace') : B('upload')}
            onDone={([id]) => set({ logo_asset_id: id ?? null })}
          />
          <span className="text-xs text-muted">{settings.logo_asset_id ? B('ownLogo') : B('accountLogo')}</span>
        </div>
      </Row>
      <Row label={B('language')}>
        <Segmented
          label={B('language')}
          value={settings.language}
          onChange={(v) => set({ language: v })}
          options={[
            { value: 'he' as const, label: 'עברית' },
            { value: 'en' as const, label: 'English' },
          ]}
        />
      </Row>

      <span className="mt-2 text-xs text-muted">{B('theme')}</span>
      <Segmented
        label={B('theme')}
        value={settings.theme ? 'own' : 'account'}
        onChange={(v) => set({ theme: v === 'own' ? (settings.theme ?? emptyIdocTheme()) : null })}
        options={[
          { value: 'account' as const, label: B('themeAccount'), testId: 'idoc-theme-account' },
          { value: 'own' as const, label: B('themeOwn'), testId: 'idoc-theme-own' },
        ]}
      />
      {settings.theme ? (
        <ThemeEditor theme={settings.theme} onChange={(theme) => set({ theme })} />
      ) : (
        <p className="text-xs text-muted">{B('themeAccountHint')}</p>
      )}

      <span className="mt-2 text-xs text-muted">{B('money')}</span>
      <div className="grid grid-cols-2 gap-2">
        <Row label={B('currency')}>
          <Picker
            label={B('currency')}
            value={settings.currency}
            options={CURRENCIES.map((c) => ({ value: c, label: c }))}
            onChange={(v) => set({ currency: v })}
          />
        </Row>
        <Row label={B('vat')}>
          <NumberField value={settings.vat_percent} max={100} onChange={(v) => set({ vat_percent: v ?? 0 })} />
        </Row>
      </div>
      <Toggle
        label={B('includeVat')}
        checked={settings.prices_include_vat}
        onChange={(v) => set({ prices_include_vat: v })}
      />
      <Row label={B('totalOneColumn')}>
        <ColumnPick
          columns={columns}
          types={COLS.number}
          value={settings.total_one_time_column_key}
          onChange={(v) => set({ total_one_time_column_key: v })}
          label={B('totalOneColumn')}
        />
      </Row>
      <Row label={B('totalRecColumn')}>
        <ColumnPick
          columns={columns}
          types={COLS.number}
          value={settings.total_recurring_column_key}
          onChange={(v) => set({ total_recurring_column_key: v })}
          label={B('totalRecColumn')}
        />
      </Row>

      <span className="mt-2 text-xs text-muted">{B('link')}</span>
      <Row label={B('expires')} hint={B('expiresHint')}>
        <NumberField value={settings.expires_days} min={1} max={3650} onChange={(v) => set({ expires_days: v })} />
      </Row>
      <Row label={B('verify')}>
        <Segmented
          label={B('verify')}
          value={settings.verify}
          onChange={(v) => set({ verify: v })}
          options={[
            { value: 'none' as const, label: B('verifyNone') },
            { value: 'email_code' as const, label: B('verifyCode') },
          ]}
        />
      </Row>
      <Toggle
        label={B('lockAfterSign')}
        checked={settings.lock_after_sign}
        onChange={(v) => set({ lock_after_sign: v })}
      />

      <span className="mt-2 text-xs text-muted">{B('contact')}</span>
      <Row label={B('contactEmail')}>
        <ColumnPick
          columns={columns}
          types={COLS.email}
          value={settings.contact_email_column_key}
          onChange={(v) => set({ contact_email_column_key: v })}
          label={B('contactEmail')}
          testId="idoc-contact-email"
          fixed={{ value: settings.contact_email, onChange: (v) => set({ contact_email: v }), type: 'email' }}
        />
      </Row>
      <Row label={B('contactName')}>
        <ColumnPick
          columns={columns}
          types={COLS.text}
          value={settings.contact_name_column_key}
          onChange={(v) => set({ contact_name_column_key: v })}
          label={B('contactName')}
          fixed={{ value: settings.contact_name, onChange: (v) => set({ contact_name: v }) }}
        />
      </Row>

      <span className="mt-2 text-xs text-muted">{B('notifications')}</span>
      <Row label={B('notifyWho')} hint={B('notifyWhoHint')}>
        <ColumnPick
          columns={columns}
          types={COLS.people}
          value={settings.notify_column_key}
          onChange={(v) => set({ notify_column_key: v })}
          label={B('notifyWho')}
        />
      </Row>
      {(['viewed', 'selected', 'signed'] as const).map((k) => (
        <Toggle
          key={k}
          label={B(`notify.${k}`)}
          checked={settings.notify[k]}
          onChange={(v) => set({ notify: { ...settings.notify, [k]: v } })}
        />
      ))}

      <span className="mt-2 text-xs text-muted">{B('email')}</span>
      <Row label={B('emailSubject')} hint={B('emailHint')}>
        <Text value={settings.email_subject} onChange={(v) => set({ email_subject: v })} />
      </Row>
      <Row label={B('emailBody')}>
        <LongText value={settings.email_body} onChange={(v) => set({ email_body: v })} rows={4} />
      </Row>
    </div>
  );
};
