// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '@bines/sdk';
import {
  getLocale,
  type BoardDetail,
  type Form,
  type FormSettings,
  type UpdateFormInput,
  t,
  tDynamic,
  LANGUAGE_NAMES,
} from '@bines/shared';
import { Button, cn, Field, Input, Notice, Picker, Segmented, SkeletonRows, Switch } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { copyText } from '../../lib/entity-menu';
import { Icon } from '../../lib/icons';
import { uploadFile } from '../../lib/upload';
import { DateField } from './FormFields';
import { embedSnippet, publicFormUrl, useForm, useFormMutations } from './forms-api';
import { downloadQr, QrCode } from './QrCode';
import { QuestionList } from './QuestionList';
import { FormTemplatePanel } from './FormTemplatePanel';
import { CaptchaKeys, CaptchaModePicker } from '../captcha/CaptchaControls';

/**
 * The "Form" board view (M11): the form's questions (board columns), texts, access, limits
 * and anti-spam, and its public link with a QR code and an embed snippet. Everything is a setting here.
 */
export const FormView = ({ accountId, board, viewId }: { accountId: string; board: BoardDetail; viewId: string }) => {
  const query = useForm(accountId, viewId);
  if (query.isPending) return <SkeletonRows rows={6} label={t('forms.editor.loading')} />;
  if (query.isError) return <Notice tone="error">{errorMessage(query.error)}</Notice>;
  return <FormEditor key={query.data.id} accountId={accountId} board={board} viewId={viewId} form={query.data} />;
};

/** A card of the editor (F4 `.card`). */
const Panel = ({ className, testId, children }: { className?: string; testId?: string; children: ReactNode }) => (
  <section
    data-testid={testId}
    className={cn('rounded-[var(--radius-lg)] border border-line bg-surface p-4', className)}
  >
    {children}
  </section>
);

type Draft = Pick<Form, 'title' | 'description' | 'enabled' | 'access' | 'target_group_id' | 'questions' | 'settings'>;

const FormEditor = ({
  accountId,
  board,
  viewId,
  form,
}: {
  accountId: string;
  board: BoardDetail;
  viewId: string;
  form: Form;
}) => {
  const m = useFormMutations(accountId, viewId);
  const [draft, setDraft] = useState<Draft>(() => ({
    title: form.title,
    description: form.description,
    enabled: form.enabled,
    access: form.access,
    target_group_id: form.target_group_id,
    questions: form.questions,
    settings: form.settings,
  }));
  const pending = useRef<UpdateFormInput>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const readOnly = !form.can_manage;

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    m.save.mutate(patch, {
      onSuccess: () => setError(null),
      onError: (err) => {
        const reason = err instanceof ApiError ? (err.body.details?.reason as string | undefined) : undefined;
        setError(reason ? tDynamic(`forms.editor.invalid.${reason}`) : errorMessage(err));
      },
    });
  };
  // Leaving the view saves what is still waiting.
  useEffect(() => () => flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  /** Changes the draft at once and saves shortly after (typing is batched into one save). */
  const change = (patch: Omit<UpdateFormInput, 'settings'> & { settings?: Partial<FormSettings> }) => {
    setDraft((d) => ({
      ...d,
      ...(patch as Partial<Draft>),
      settings: patch.settings ? { ...d.settings, ...patch.settings } : d.settings,
    }));
    const prev = pending.current;
    pending.current = {
      ...prev,
      ...patch,
      ...(patch.settings || prev.settings ? { settings: { ...prev.settings, ...patch.settings } } : {}),
    };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 700);
  };
  const setSettings = (s: Partial<FormSettings>) => change({ settings: s });

  return (
    <div className="grid gap-6 pb-10 lg:grid-cols-[minmax(0,1fr)_340px]" data-testid="form-view">
      <div className="min-w-0 space-y-5">
        {readOnly ? <Notice>{t('forms.editor.readOnly')}</Notice> : null}
        {error ? <Notice tone="error">{error}</Notice> : null}
        <fieldset disabled={readOnly} className="space-y-5">
          <Panel className="space-y-3">
            <Field label={t('forms.editor.title')}>
              <Input
                value={draft.title}
                maxLength={255}
                onChange={(e) => change({ title: e.target.value })}
                onBlur={() => !draft.title.trim() && change({ title: form.title })}
                data-testid="form-title"
              />
            </Field>
            <Field label={t('forms.editor.description')}>
              <textarea
                value={draft.description}
                maxLength={5000}
                rows={3}
                onChange={(e) => change({ description: e.target.value })}
                className="w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm focus:border-primary focus:outline-none"
                data-testid="form-description"
              />
            </Field>
          </Panel>
          <QuestionList
            accountId={accountId}
            board={board}
            formUrl={publicFormUrl(form.token)}
            questions={draft.questions}
            columns={board.columns}
            access={draft.access}
            disabled={readOnly}
            onChange={(questions) => change({ questions })}
          />
          <Panel className="space-y-3">
            <h3 className="text-sm font-bold text-heading">{t('forms.editor.afterSubmit')}</h3>
            <Field label={t('forms.editor.submitLabel')}>
              <Input
                value={draft.settings.submit_label}
                maxLength={60}
                placeholder={t('forms.editor.submitDefault')}
                onChange={(e) => setSettings({ submit_label: e.target.value })}
              />
            </Field>
            <Field label={t('forms.editor.successMessage')}>
              <textarea
                value={draft.settings.success_message}
                maxLength={2000}
                rows={2}
                placeholder={t('forms.editor.successDefault')}
                onChange={(e) => setSettings({ success_message: e.target.value })}
                className="w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm focus:border-primary focus:outline-none"
              />
            </Field>
            <RedirectField value={draft.settings.redirect_url} onChange={(v) => setSettings({ redirect_url: v })} />
            <Field label={t('forms.editor.privacyNotice')} hint={t('forms.editor.privacyNoticeHint')}>
              <textarea
                value={draft.settings.privacy_notice ?? ''}
                maxLength={2000}
                rows={3}
                dir="auto"
                placeholder={t('forms.editor.privacyNoticePlaceholder')}
                onChange={(e) => setSettings({ privacy_notice: e.target.value })}
                data-testid="form-privacy-notice"
                className="w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm focus:border-primary focus:outline-none"
              />
            </Field>
          </Panel>
        </fieldset>
      </div>
      <aside className="min-w-0 space-y-4">
        <SharePanel
          form={form}
          draft={draft}
          readOnly={readOnly}
          change={change}
          onRegenerate={() => m.regenerate.mutate()}
        />
        <fieldset disabled={readOnly} className="space-y-4">
          <SettingsPanel accountId={accountId} board={board} draft={draft} change={change} setSettings={setSettings} />
          <TurnstilePanel
            form={form}
            draft={draft}
            setSettings={setSettings}
            saveSecret={(secret) => m.save.mutate({ turnstile_secret: secret })}
            busy={m.save.isPending}
          />
        </fieldset>
      </aside>
    </div>
  );
};

/** A redirect after submitting: an http(s) address, saved once it is one (or empty). */
const RedirectField = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  const [text, setText] = useState(value);
  const valid = !text.trim() || /^https?:\/\/[^\s]+\.[^\s]+/.test(text.trim());
  return (
    <Field
      label={t('forms.editor.redirectUrl')}
      hint={valid ? t('forms.editor.redirectHint') : t('forms.editor.redirectInvalid')}
    >
      <Input
        value={text}
        dir="ltr"
        placeholder="https://"
        maxLength={2000}
        aria-invalid={!valid || undefined}
        onChange={(e) => {
          setText(e.target.value);
          const v = e.target.value.trim();
          if (!v || /^https?:\/\/[^\s]+\.[^\s]+/.test(v)) onChange(v);
        }}
      />
    </Field>
  );
};

const Row = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <div className="space-y-1">
    <label className="flex items-center justify-between gap-3 text-sm text-fg">
      <span>{label}</span>
      {children}
    </label>
    {hint ? <p className="text-xs text-muted">{hint}</p> : null}
  </div>
);

type Change = (patch: Omit<UpdateFormInput, 'settings'> & { settings?: Partial<FormSettings> }) => void;

const SharePanel = ({
  form,
  draft,
  readOnly,
  change,
  onRegenerate,
}: {
  form: Form;
  draft: Draft;
  readOnly: boolean;
  change: Change;
  onRegenerate: () => void;
}) => {
  const url = publicFormUrl(form.token);
  return (
    <Panel className="space-y-3" testId="form-share">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-heading">{t('forms.editor.share')}</h3>
        <span className="text-xs text-muted" data-testid="form-submissions">
          {t('forms.editor.submissions', { n: form.submissions_count })}
        </span>
      </div>
      <Row label={t('forms.editor.enabled')} hint={draft.enabled ? undefined : t('forms.editor.disabledHint')}>
        <Switch
          checked={draft.enabled}
          disabled={readOnly}
          onChange={(on) => change({ enabled: on })}
          testId="form-enabled"
        />
      </Row>
      <div className="flex items-center gap-1.5">
        <Input
          value={url}
          readOnly
          dir="ltr"
          className="text-xs"
          aria-label={t('forms.editor.link')}
          data-testid="form-link"
        />
        <Button
          size="sm"
          variant="secondary"
          onClick={() => copyText(url)}
          title={t('forms.editor.copyLink')}
          data-testid="form-copy-link"
        >
          <Icon name="copy" size={14} />
        </Button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          title={t('forms.editor.open')}
          aria-label={t('forms.editor.open')}
          className="inline-flex h-8 items-center rounded-[10px] border border-line-strong px-2.5 text-heading hover:bg-surface-2"
          data-testid="form-open-link"
        >
          <Icon name="link" size={14} />
        </a>
      </div>
      <div className="flex items-end gap-3">
        <QrCode value={url} size={120} label={t('forms.editor.qr')} />
        <div className="space-y-1.5">
          <Button size="sm" variant="ghost" onClick={() => downloadQr(url, `${form.title || 'form'}-qr.svg`)}>
            <Icon name="download" size={14} />
            {t('forms.editor.downloadQr')}
          </Button>
          {!readOnly ? (
            <Button
              size="sm"
              variant="ghost"
              data-testid="form-regenerate"
              onClick={async () => {
                if (
                  await confirmDialog({
                    title: t('forms.editor.regenerateTitle'),
                    message: t('forms.editor.regenerateMessage'),
                    confirmLabel: t('forms.editor.regenerate'),
                    danger: true,
                  })
                )
                  onRegenerate();
              }}
            >
              <Icon name="restore" size={14} />
              {t('forms.editor.regenerate')}
            </Button>
          ) : null}
        </div>
      </div>
      <div className="space-y-1.5">
        <Row label={t('forms.editor.allowEmbed')} hint={t('forms.editor.allowEmbedHint')}>
          <Switch
            checked={draft.settings.allow_embed}
            disabled={readOnly}
            onChange={(on) => change({ settings: { allow_embed: on } })}
            testId="form-allow-embed"
          />
        </Row>
        {draft.settings.allow_embed ? (
          <div className="flex items-start gap-1.5">
            <textarea
              readOnly
              value={embedSnippet(form.token, draft.title)}
              rows={3}
              dir="ltr"
              aria-label={t('forms.editor.embed')}
              className="w-full rounded-[10px] border border-line bg-surface-3 px-2 py-1.5 font-[family-name:var(--font-mono)] text-[0.6875rem]"
              data-testid="form-embed"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => copyText(embedSnippet(form.token, draft.title))}
              title={t('forms.editor.copyEmbed')}
            >
              <Icon name="copy" size={14} />
            </Button>
          </div>
        ) : null}
      </div>
    </Panel>
  );
};

const SettingsPanel = ({
  accountId,
  board,
  draft,
  change,
  setSettings,
}: {
  accountId: string;
  board: BoardDetail;
  draft: Draft;
  change: Change;
  setSettings: (s: Partial<FormSettings>) => void;
}) => {
  const s = draft.settings;
  const FIRST = '__first__';
  const closeDate = s.close_at ? toLocalDate(s.close_at) : '';
  return (
    <Panel className="space-y-3" testId="form-settings">
      <h3 className="text-sm font-bold text-heading">{t('forms.editor.settings')}</h3>
      <Field label={t('forms.editor.access')}>
        <Segmented
          label={t('forms.editor.access')}
          value={draft.access}
          onChange={(v) => change({ access: v })}
          options={[
            { value: 'public', label: t('forms.editor.accessPublic'), testId: 'form-access-public' },
            { value: 'members', label: t('forms.editor.accessMembers'), testId: 'form-access-members' },
          ]}
        />
      </Field>
      <Field label={t('forms.editor.language')} hint={t('forms.editor.languageHint')}>
        <Segmented
          label={t('forms.editor.language')}
          value={s.language}
          onChange={(v) => setSettings({ language: v })}
          options={[
            { value: 'he', label: LANGUAGE_NAMES.he },
            { value: 'en', label: LANGUAGE_NAMES.en },
          ]}
        />
      </Field>
      <Field label={t('forms.editor.targetGroup')}>
        <Picker
          label={t('forms.editor.targetGroup')}
          value={draft.target_group_id ?? FIRST}
          options={[
            { value: FIRST, label: t('forms.editor.firstGroup') },
            ...board.groups.map((g) => ({ value: g.id, label: g.title })),
          ]}
          onChange={(v) => change({ target_group_id: v === FIRST ? null : v })}
          testId="form-target-group"
        />
      </Field>
      <FormTemplatePanel
        accountId={accountId}
        board={board}
        questions={draft.questions}
        value={s.item_template ?? null}
        onChange={(item_template) => setSettings({ item_template })}
      />
      <Field label={t('forms.editor.closeAt')} hint={t('forms.editor.closeAtHint')}>
        <DateField
          id="form-close-at"
          value={closeDate}
          lang={getLocale()}
          testId="close-at"
          onChange={(d) => setSettings({ close_at: d ? new Date(`${d}T23:59:59`).toISOString() : null })}
        />
      </Field>
      <Field label={t('forms.editor.maxSubmissions')} hint={t('forms.editor.maxSubmissionsHint')}>
        <Input
          inputMode="numeric"
          value={s.max_submissions === null ? '' : String(s.max_submissions)}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            setSettings({ max_submissions: e.target.value.trim() && n >= 1 ? Math.min(n, 1_000_000) : null });
          }}
        />
      </Field>
      <Row label={t('forms.editor.showBranding')} hint={t('forms.editor.showBrandingHint')}>
        <Switch checked={s.show_account_branding} onChange={(on) => setSettings({ show_account_branding: on })} />
      </Row>
      <ImageSetting
        accountId={accountId}
        label={t('forms.editor.logo')}
        assetId={s.logo_asset_id}
        onChange={(id) => setSettings({ logo_asset_id: id })}
      />
      <ImageSetting
        accountId={accountId}
        label={t('forms.editor.cover')}
        assetId={s.cover_asset_id}
        onChange={(id) => setSettings({ cover_asset_id: id })}
      />
    </Panel>
  );
};

/** YYYY-MM-DD of an ISO moment, in this browser's zone. */
const toLocalDate = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** Logo / cover: an image uploaded through the files module. */
const ImageSetting = ({
  accountId,
  label,
  assetId,
  onChange,
}: {
  accountId: string;
  label: string;
  assetId: string | null;
  onChange: (id: string | null) => void;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span>{label}</span>
      <span className="flex items-center gap-1.5">
        <input
          ref={input}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          className="sr-only"
          tabIndex={-1}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            setBusy(true);
            setFailed(false);
            try {
              onChange((await uploadFile(accountId, file)).id);
            } catch {
              setFailed(true);
            } finally {
              setBusy(false);
              e.target.value = '';
            }
          }}
        />
        {assetId ? <span className="text-xs text-ok-fg">{t('forms.editor.imageSet')}</span> : null}
        {failed ? <span className="text-xs text-danger-fg">{t('forms.editor.uploadFailed')}</span> : null}
        <Button size="sm" variant="secondary" busy={busy} onClick={() => input.current?.click()}>
          <Icon name="upload" size={14} />
          {assetId ? t('forms.editor.replace') : t('forms.editor.upload')}
        </Button>
        {assetId ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange(null)}
            title={t('forms.editor.removeImage')}
            aria-label={t('forms.editor.removeImage')}
          >
            <Icon name="x" size={14} />
          </Button>
        ) : null}
      </span>
    </div>
  );
};

/**
 * Cloudflare Turnstile on this form: its mode — the account's setting (Administration → Security)
 * on or off — and, optionally, keys of its own that win over the account's. The secret is write-only.
 */
const TurnstilePanel = ({
  form,
  draft,
  setSettings,
  saveSecret,
  busy,
}: {
  form: Form;
  draft: Draft;
  setSettings: (s: Partial<FormSettings>) => void;
  saveSecret: (secret: string | null) => void;
  busy: boolean;
}) => {
  const ownKeys = !!draft.settings.turnstile_site_key && form.turnstile_secret_set;
  const [showOwn, setShowOwn] = useState(ownKeys);
  return (
    <Panel className="space-y-3" testId="form-turnstile">
      <div className="space-y-1">
        <h3 className="text-sm font-bold text-heading">{t('forms.editor.antiSpam')}</h3>
        <p className="text-xs text-muted">{t('captcha.form.hint')}</p>
      </div>
      <CaptchaModePicker
        value={draft.settings.captcha_mode ?? 'inherit'}
        onChange={(captcha_mode) => setSettings({ captcha_mode })}
        keysReady={ownKeys || form.account_captcha.keys_ready}
        inherited={form.account_captcha.inherited}
        inheritFrom={t('captcha.from.account')}
        testId="form-captcha-mode"
      />
      {showOwn ? (
        <CaptchaKeys
          siteKey={draft.settings.turnstile_site_key}
          secretSet={form.turnstile_secret_set}
          onSiteKey={(turnstile_site_key) => setSettings({ turnstile_site_key })}
          onSecret={saveSecret}
          busy={busy}
          testId="form-captcha-keys"
        />
      ) : (
        <button
          type="button"
          className="text-xs font-semibold text-heading hover:underline"
          onClick={() => setShowOwn(true)}
          data-testid="form-captcha-own"
        >
          {t('captcha.form.ownKeys')}
        </button>
      )}
    </Panel>
  );
};
