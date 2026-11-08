// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_LEGAL_SLUGS,
  LEGAL_COMPANY_FIELDS,
  LEGAL_PLACEHOLDERS,
  markdownToDocHtml,
  type LegalDocAdmin,
  type LegalLocale,
  type LegalVersion,
  type PlatformLegal,
  type PlatformSettingsResponse,
  type SubProcessor,
  t,
  LANGUAGE_NAMES,
} from '@bines/shared';
import { Badge, Button, Card, Field, Input, Notice, Segmented, SkeletonRows, Switch } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { downloadFrom } from '../../lib/download';
import { showToast } from '../../lib/toast';
import { legalListKey } from '../legal/legal-links';

const KEY = ['platform', 'legal'] as const;
const SETTINGS_KEY = ['platform', 'settings'] as const;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Owner console → Legal documents: the operator's details every document fills in (`{{company_name}}` …)
 * and the documents themselves — a draft per language (Markdown) with a preview, "requires consent", publish (a new
 * version, people accept it again), the published versions with "restore into the draft", and new documents.
 */
export const LegalDocumentsPanel = () => {
  const docs = useQuery({
    queryKey: KEY,
    queryFn: async () => (await api().get<{ data: LegalDocAdmin[] }>('/platform/legal')).data,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const current = docs.data?.find((d) => d.slug === selected) ?? docs.data?.[0];
  return (
    <section className="space-y-2.5" data-testid="owner-legal">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-0.5">
          <h2 className="font-display text-base font-bold text-heading">{t('legal.owner.title')}</h2>
          <p className="max-w-[640px] text-xs text-muted">{t('legal.owner.hint')}</p>
        </div>
        <span className="flex flex-wrap items-center gap-3">
          <ExportLink path="/platform/legal/consents.csv" file="consents.csv" label={t('legal.owner.exportConsents')} />
          <ExportLink
            path="/platform/legal/marketing.csv"
            file="marketing-opt-ins.csv"
            label={t('legal.owner.exportMarketing')}
          />
          <a
            href="/legal"
            target="_blank"
            rel="noopener"
            className="text-xs font-semibold text-primary hover:underline"
          >
            {t('legal.owner.open')}
          </a>
        </span>
      </header>
      <CompanyCard />
      <SubProcessorsCard />
      <CollectionNoticeCard />
      <MarketingOptInCard />
      {docs.isPending ? <SkeletonRows rows={4} label={t('legal.loading')} /> : null}
      {docs.isError ? <Notice tone="error">{errorMessage(docs.error)}</Notice> : null}
      {docs.data ? (
        <div className="flex gap-4 max-md:flex-col">
          <Card className="shrink-0 space-y-1 md:w-64">
            <ul className="space-y-1" data-testid="owner-legal-list">
              {docs.data.map((d) => (
                <li key={d.slug}>
                  <button
                    type="button"
                    onClick={() => setSelected(d.slug)}
                    aria-current={d.slug === current?.slug ? 'true' : undefined}
                    data-testid={`owner-legal-doc-${d.slug}`}
                    className={`w-full rounded-md px-2 py-1.5 text-start text-sm ${
                      d.slug === current?.slug ? 'bg-primary-soft font-bold text-primary' : 'hover:bg-surface-3'
                    }`}
                  >
                    <span className="block truncate">{d.draft.title.he || d.slug}</span>
                    <span className="flex flex-wrap gap-1 pt-0.5">
                      {d.published_version ? (
                        <Badge tone="ok">{t('legal.owner.versionN', { n: d.published_version })}</Badge>
                      ) : (
                        <Badge tone="warn">{t('legal.owner.unpublished')}</Badge>
                      )}
                      {d.draft_changed && d.published_version ? (
                        <Badge tone="info">{t('legal.owner.changed')}</Badge>
                      ) : null}
                      {d.requires_consent ? <Badge tone="violet">{t('legal.owner.consent')}</Badge> : null}
                      {d.purchase_consent ? <Badge tone="violet">{t('legal.owner.purchase')}</Badge> : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <NewDocument onCreated={setSelected} />
          </Card>
          {current ? <DocEditor key={`${current.slug}-${current.updated_at}`} doc={current} /> : null}
        </div>
      ) : null}
    </section>
  );
};

const CompanyCard = () => {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api().get<PlatformSettingsResponse>('/platform/settings'),
  });
  const legal: Partial<PlatformLegal> = settings.data?.settings.legal ?? {};
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const v = values ?? Object.fromEntries(LEGAL_COMPANY_FIELDS.map((k) => [k, legal[k] ?? '']));
  const [checkbox, setCheckbox] = useState<boolean | null>(null);
  const box = checkbox ?? !!legal.consent_checkbox;
  const save = useMutation({
    mutationFn: () =>
      api().patch('/platform/settings', {
        legal: {
          ...Object.fromEntries(LEGAL_COMPANY_FIELDS.map((k) => [k, v[k]?.trim() ? v[k]!.trim() : null])),
          consent_checkbox: box,
        },
      }),
    onSuccess: async () => {
      setValues(null);
      setCheckbox(null);
      await qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      await qc.invalidateQueries({ queryKey: legalListKey });
      showToast({ message: t('legal.owner.saved') });
    },
  });
  if (!settings.data) return null;
  return (
    <Card className="space-y-3" data-testid="owner-legal-company">
      <h3 className="text-sm font-bold text-heading">{t('legal.owner.company')}</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        {LEGAL_COMPANY_FIELDS.map((k) => (
          <Field key={k} label={t(`legal.field.${k}`)} hint={`{{${k}}}`}>
            <Input
              value={v[k] ?? ''}
              dir={k.endsWith('email') ? 'ltr' : 'auto'}
              data-testid={`owner-legal-${k}`}
              onChange={(e) => setValues({ ...v, [k]: e.target.value })}
            />
          </Field>
        ))}
      </div>
      <div className="space-y-1">
        <Switch checked={box} onChange={setCheckbox} label={t('legal.owner.checkbox')} testId="owner-legal-checkbox" />
        <p className="text-xs text-muted">{t('legal.owner.checkboxHint')}</p>
      </div>
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      <Button
        size="sm"
        onClick={() => save.mutate()}
        busy={save.isPending}
        disabled={!values && checkbox === null}
        data-testid="owner-legal-company-save"
      >
        {t('legal.owner.save')}
      </Button>
    </Card>
  );
};

/** The privacy notice at sign-up (privacy — Israel Privacy Law §11), per language. */
const CollectionNoticeCard = () => {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api().get<PlatformSettingsResponse>('/platform/settings'),
  });
  const saved = settings.data?.settings.legal?.collection_notice ?? {};
  const [v, setV] = useState<{ he: string; en: string } | null>(null);
  const cur = v ?? { he: saved.he ?? '', en: saved.en ?? '' };
  const save = useMutation({
    mutationFn: () =>
      api().patch('/platform/settings', { legal: { collection_notice: { he: cur.he.trim(), en: cur.en.trim() } } }),
    onSuccess: async () => {
      setV(null);
      await qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      await qc.invalidateQueries({ queryKey: legalListKey });
      showToast({ message: t('legal.owner.saved') });
    },
  });
  if (!settings.data) return null;
  const area =
    'w-full rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm focus:border-primary focus:outline-none';
  return (
    <Card className="space-y-3" data-testid="owner-legal-notice">
      <div className="space-y-0.5">
        <h3 className="text-sm font-bold text-heading">{t('legal.owner.notice')}</h3>
        <p className="text-xs text-muted">{t('legal.owner.noticeHint')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('legal.owner.noticeHe')}>
          <textarea
            rows={3}
            dir="rtl"
            maxLength={1000}
            className={area}
            value={cur.he}
            onChange={(e) => setV({ ...cur, he: e.target.value })}
            data-testid="owner-legal-notice-he"
          />
        </Field>
        <Field label={t('legal.owner.noticeEn')}>
          <textarea
            rows={3}
            dir="ltr"
            maxLength={1000}
            className={area}
            value={cur.en}
            onChange={(e) => setV({ ...cur, en: e.target.value })}
            data-testid="owner-legal-notice-en"
          />
        </Field>
      </div>
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      <Button
        size="sm"
        onClick={() => save.mutate()}
        busy={save.isPending}
        disabled={!v}
        data-testid="owner-legal-notice-save"
      >
        {t('legal.owner.save')}
      </Button>
    </Card>
  );
};

/** A CSV the owner downloads: who accepted which version, who agreed to marketing email. */
const ExportLink = ({ path, file, label }: { path: string; file: string; label: string }) => (
  <button
    type="button"
    className="text-xs font-semibold text-primary hover:underline"
    data-testid={`owner-legal-export-${file.replace('.csv', '')}`}
    onClick={() =>
      void downloadFrom('', path, file).catch((err: unknown) =>
        showToast({ message: errorMessage(err), tone: 'error' }),
      )
    }
  >
    {label}
  </button>
);

/**
 * The marketing box at sign-up (Israel Communications Law §30A): a separate box, never ticked by
 * default, offered only when the owner writes its label; people withdraw it from their profile.
 */
const MarketingOptInCard = () => {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api().get<PlatformSettingsResponse>('/platform/settings'),
  });
  const saved = settings.data?.settings.legal?.marketing_opt_in ?? {};
  const [v, setV] = useState<{ he: string; en: string } | null>(null);
  const cur = v ?? { he: saved.he ?? '', en: saved.en ?? '' };
  const save = useMutation({
    mutationFn: () =>
      api().patch('/platform/settings', { legal: { marketing_opt_in: { he: cur.he.trim(), en: cur.en.trim() } } }),
    onSuccess: async () => {
      setV(null);
      await qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      await qc.invalidateQueries({ queryKey: legalListKey });
      showToast({ message: t('legal.owner.saved') });
    },
  });
  if (!settings.data) return null;
  return (
    <Card className="space-y-3" data-testid="owner-legal-marketing">
      <div className="space-y-0.5">
        <h3 className="text-sm font-bold text-heading">{t('legal.owner.marketing')}</h3>
        <p className="text-xs text-muted">{t('legal.owner.marketingHint')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('legal.owner.noticeHe')}>
          <Input
            value={cur.he}
            dir="rtl"
            maxLength={300}
            onChange={(e) => setV({ ...cur, he: e.target.value })}
            data-testid="owner-legal-marketing-he"
          />
        </Field>
        <Field label={t('legal.owner.noticeEn')}>
          <Input
            value={cur.en}
            dir="ltr"
            maxLength={300}
            onChange={(e) => setV({ ...cur, en: e.target.value })}
            data-testid="owner-legal-marketing-en"
          />
        </Field>
      </div>
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      <Button
        size="sm"
        onClick={() => save.mutate()}
        busy={save.isPending}
        disabled={!v}
        data-testid="owner-legal-marketing-save"
      >
        {t('legal.owner.save')}
      </Button>
    </Card>
  );
};

const emptyProcessor = (): SubProcessor => ({ name: '', purpose: { he: '', en: '' }, location: '' });

/**
 * The sub-processors list (privacy): who processes personal data for the operator, published at
 * `/legal/sub-processors`. Saved as a whole; an empty list hides the page.
 */
const SubProcessorsCard = () => {
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api().get<PlatformSettingsResponse>('/platform/settings'),
  });
  const saved = settings.data?.settings.legal?.sub_processors ?? [];
  const [rows, setRows] = useState<SubProcessor[] | null>(null);
  const list = rows ?? saved;
  const edit = (i: number, patch: Partial<SubProcessor>) =>
    setRows(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = useMutation({
    mutationFn: () =>
      api().patch('/platform/settings', {
        legal: {
          sub_processors: list
            .filter((r) => r.name.trim())
            .map((r) => ({ ...r, ...(r.dpa_url?.trim() ? { dpa_url: r.dpa_url.trim() } : { dpa_url: undefined }) })),
        },
      }),
    onSuccess: async () => {
      setRows(null);
      await qc.invalidateQueries({ queryKey: SETTINGS_KEY });
      await qc.invalidateQueries({ queryKey: legalListKey });
      showToast({ message: t('legal.owner.saved') });
    },
  });
  if (!settings.data) return null;
  return (
    <Card className="space-y-3" data-testid="owner-legal-subprocessors">
      <div className="space-y-0.5">
        <h3 className="text-sm font-bold text-heading">{t('legal.owner.sub.title')}</h3>
        <p className="text-xs text-muted">{t('legal.owner.sub.hint')}</p>
      </div>
      {list.map((r, i) => (
        <div
          key={i}
          className="grid gap-2 rounded-[var(--radius)] border border-line p-3 sm:grid-cols-2"
          data-testid="owner-legal-sub-row"
        >
          <Field label={t('legal.subProcessors.name')}>
            <Input value={r.name} dir="auto" onChange={(e) => edit(i, { name: e.target.value })} />
          </Field>
          <Field label={t('legal.subProcessors.location')}>
            <Input value={r.location} dir="auto" onChange={(e) => edit(i, { location: e.target.value })} />
          </Field>
          <Field label={t('legal.owner.sub.purposeHe')}>
            <Input
              value={r.purpose.he}
              dir="rtl"
              onChange={(e) => edit(i, { purpose: { ...r.purpose, he: e.target.value } })}
            />
          </Field>
          <Field label={t('legal.owner.sub.purposeEn')}>
            <Input
              value={r.purpose.en}
              dir="ltr"
              onChange={(e) => edit(i, { purpose: { ...r.purpose, en: e.target.value } })}
            />
          </Field>
          <Field label={t('legal.subProcessors.dpa')}>
            <Input value={r.dpa_url ?? ''} dir="ltr" onChange={(e) => edit(i, { dpa_url: e.target.value })} />
          </Field>
          <div className="flex items-end">
            <Button size="sm" variant="ghost" onClick={() => setRows(list.filter((_, j) => j !== i))}>
              {t('legal.owner.sub.remove')}
            </Button>
          </div>
        </div>
      ))}
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setRows([...list, emptyProcessor()])}
          data-testid="owner-legal-sub-add"
        >
          {t('legal.owner.sub.add')}
        </Button>
        <Button
          size="sm"
          onClick={() => save.mutate()}
          busy={save.isPending}
          disabled={!rows}
          data-testid="owner-legal-sub-save"
        >
          {t('legal.owner.save')}
        </Button>
      </div>
    </Card>
  );
};

const DocEditor = ({ doc }: { doc: LegalDocAdmin }) => {
  const qc = useQueryClient();
  const [lang, setLang] = useState<LegalLocale>('he');
  const [title, setTitle] = useState(doc.draft.title);
  const [body, setBody] = useState(doc.draft.body);
  const [consent, setConsent] = useState(doc.requires_consent);
  const [purchase, setPurchase] = useState(doc.purchase_consent);
  // A new version is material by default (people accept it again); a minor one asks nobody.
  const [material, setMaterial] = useState(true);
  const [preview, setPreview] = useState(false);
  const dirty =
    JSON.stringify(title) !== JSON.stringify(doc.draft.title) ||
    JSON.stringify(body) !== JSON.stringify(doc.draft.body) ||
    consent !== doc.requires_consent ||
    purchase !== doc.purchase_consent;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: KEY });
    await qc.invalidateQueries({ queryKey: ['legal'] });
  };
  const patch = () => ({ draft: { title, body }, requires_consent: consent, purchase_consent: purchase });
  const save = useMutation({
    mutationFn: () => api().patch<LegalDocAdmin>(`/platform/legal/${doc.slug}`, patch()),
    onSuccess: async () => {
      await refresh();
      showToast({ message: t('legal.owner.saved') });
    },
  });
  const publish = useMutation({
    mutationFn: async () => {
      if (dirty) await api().patch(`/platform/legal/${doc.slug}`, patch());
      return api().post<LegalDocAdmin>(`/platform/legal/${doc.slug}/publish`, {
        material: !doc.published_version || material,
      });
    },
    onSuccess: async (d) => {
      await refresh();
      showToast({ message: t('legal.owner.published', { n: d.published_version ?? 1 }) });
    },
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useMutation({
    mutationFn: () => api().delete(`/platform/legal/${doc.slug}`),
    onSuccess: async () => {
      await refresh();
      showToast({ message: t('legal.owner.deleted') });
    },
  });
  const builtin = (DEFAULT_LEGAL_SLUGS as readonly string[]).includes(doc.slug);
  const html = useMemo(() => (preview ? markdownToDocHtml(body[lang]).html : ''), [preview, body, lang]);
  return (
    <Card className="min-w-0 flex-1 space-y-3" data-testid="owner-legal-editor">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label={t('legal.owner.language')}
          value={lang}
          onChange={setLang}
          options={[
            { value: 'he', label: LANGUAGE_NAMES.he, testId: 'owner-legal-lang-he' },
            { value: 'en', label: LANGUAGE_NAMES.en, testId: 'owner-legal-lang-en' },
          ]}
        />
        <a
          href={`/legal/${doc.slug}?locale=${lang}`}
          target="_blank"
          rel="noopener"
          className="text-xs font-semibold text-primary hover:underline"
        >
          /legal/{doc.slug}
        </a>
      </div>
      <Field label={t('legal.owner.docTitle')}>
        <Input
          value={title[lang]}
          dir={lang === 'he' ? 'rtl' : 'ltr'}
          data-testid="owner-legal-title"
          onChange={(e) => setTitle({ ...title, [lang]: e.target.value })}
        />
      </Field>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-fg-2">{t('legal.owner.body')}</span>
        <Button size="sm" variant="ghost" onClick={() => setPreview((p) => !p)} data-testid="owner-legal-preview">
          {preview ? t('legal.owner.edit') : t('legal.owner.preview')}
        </Button>
      </div>
      {preview ? (
        <div
          dir={lang === 'he' ? 'rtl' : 'ltr'}
          className="rich-content legal-content max-h-[480px] overflow-auto rounded-[var(--radius)] border border-line p-4"
          // The shared renderer escapes raw HTML and keeps only safe links; placeholders show as written.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <textarea
          value={body[lang]}
          dir={lang === 'he' ? 'rtl' : 'ltr'}
          rows={18}
          // The document's text, named for a screen reader (axe label).
          aria-label={`${t('legal.owner.body')} · ${title[lang] || doc.slug}`}
          data-testid="owner-legal-body"
          onChange={(e) => setBody({ ...body, [lang]: e.target.value })}
          className="w-full rounded-[var(--radius)] border border-line bg-surface p-3 font-mono text-[0.8125rem] leading-relaxed outline-none focus:border-primary"
        />
      )}
      <p className="text-xs text-muted">
        {t('legal.owner.placeholders')}{' '}
        <span dir="ltr" className="font-mono">
          {LEGAL_PLACEHOLDERS.map((p) => `{{${p}}}`).join(' ')}
        </span>
      </p>
      <Switch
        checked={consent}
        onChange={setConsent}
        label={t('legal.owner.requiresConsent')}
        testId="owner-legal-consent"
      />
      <div className="space-y-1">
        <Switch
          checked={purchase}
          onChange={setPurchase}
          label={t('legal.owner.purchaseConsent')}
          testId="owner-legal-purchase"
        />
        <p className="text-xs text-muted">{t('legal.owner.purchaseConsentHint')}</p>
      </div>
      {doc.published_version ? (
        <div className="space-y-1">
          <Switch
            checked={material}
            onChange={setMaterial}
            label={t('legal.owner.material')}
            testId="owner-legal-material"
          />
          <p className="text-xs text-muted">{t('legal.owner.materialHint')}</p>
        </div>
      ) : null}
      <p className="text-xs text-muted">
        {doc.published_version
          ? t('legal.owner.status', { n: doc.published_version, consents: doc.consents })
          : t('legal.owner.unpublished')}
      </p>
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      {publish.isError ? <Notice tone="error">{errorMessage(publish.error)}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => save.mutate()}
          busy={save.isPending}
          disabled={!dirty}
          data-testid="owner-legal-save"
        >
          {t('legal.owner.saveDraft')}
        </Button>
        <Button
          size="sm"
          onClick={() => publish.mutate()}
          busy={publish.isPending}
          disabled={!dirty && !doc.draft_changed && !!doc.published_version}
          data-testid="owner-legal-publish"
        >
          {t('legal.owner.publish')}
        </Button>
        {builtin ? null : (
          <Button
            size="sm"
            variant="danger-outline"
            busy={remove.isPending}
            onClick={() => (confirmDelete ? remove.mutate() : setConfirmDelete(true))}
            data-testid="owner-legal-delete"
          >
            {confirmDelete ? t('legal.owner.deleteConfirm') : t('legal.owner.delete')}
          </Button>
        )}
      </div>
      {remove.isError ? <Notice tone="error">{errorMessage(remove.error)}</Notice> : null}
      {doc.published_version ? <Versions slug={doc.slug} /> : null}
    </Card>
  );
};

const Versions = ({ slug }: { slug: string }) => {
  const qc = useQueryClient();
  const versions = useQuery({
    queryKey: [...KEY, slug, 'versions'],
    queryFn: async () => (await api().get<{ data: LegalVersion[] }>(`/platform/legal/${slug}/versions`)).data,
  });
  const restore = useMutation({
    mutationFn: (v: number) => api().post(`/platform/legal/${slug}/versions/${v}/restore`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KEY });
      showToast({ message: t('legal.owner.restored') });
    },
  });
  const date = (iso: string) =>
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  return (
    <details className="rounded-[var(--radius)] border border-line p-3 text-sm" data-testid="owner-legal-versions">
      <summary className="cursor-pointer font-semibold text-fg-2">{t('legal.owner.versions')}</summary>
      <ul className="mt-2 space-y-1.5">
        {(versions.data ?? []).map((v) => (
          <li key={v.version} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {t('legal.owner.versionN', { n: v.version })} · {date(v.published_at)} ·{' '}
              {t('legal.owner.consents', { n: v.consents })}
              {v.material ? null : (
                <>
                  {' '}
                  <Badge tone="neutral">{t('legal.owner.minor')}</Badge>
                </>
              )}
            </span>
            <Button size="sm" variant="ghost" onClick={() => restore.mutate(v.version)} busy={restore.isPending}>
              {t('legal.owner.restore')}
            </Button>
          </li>
        ))}
      </ul>
    </details>
  );
};

const NewDocument = ({ onCreated }: { onCreated: (slug: string) => void }) => {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [slug, setSlug] = useState('');
  const [he, setHe] = useState('');
  const [en, setEn] = useState('');
  const create = useMutation({
    mutationFn: () => api().post<LegalDocAdmin>('/platform/legal', { slug, title: { he, en } }),
    onSuccess: async (d) => {
      await qc.invalidateQueries({ queryKey: KEY });
      setOpen(false);
      setSlug('');
      setHe('');
      setEn('');
      onCreated(d.slug);
    },
  });
  if (!open)
    return (
      <Button size="sm" variant="ghost" className="w-full" onClick={() => setOpen(true)} data-testid="owner-legal-new">
        + {t('legal.owner.new')}
      </Button>
    );
  return (
    <div className="space-y-2 border-t border-line pt-2">
      <Field label={t('legal.owner.slug')} hint="privacy-addendum">
        <Input
          value={slug}
          dir="ltr"
          onChange={(e) => setSlug(e.target.value.toLowerCase())}
          data-testid="owner-legal-new-slug"
        />
      </Field>
      <Field label={t('legal.owner.titleHe')}>
        <Input value={he} dir="rtl" onChange={(e) => setHe(e.target.value)} data-testid="owner-legal-new-he" />
      </Field>
      <Field label={t('legal.owner.titleEn')}>
        <Input value={en} dir="ltr" onChange={(e) => setEn(e.target.value)} data-testid="owner-legal-new-en" />
      </Field>
      {create.isError ? <Notice tone="error">{errorMessage(create.error)}</Notice> : null}
      <Button
        size="sm"
        onClick={() => create.mutate()}
        busy={create.isPending}
        disabled={!SLUG.test(slug) || !he.trim() || !en.trim()}
        data-testid="owner-legal-new-create"
      >
        {t('legal.owner.create')}
      </Button>
    </div>
  );
};
