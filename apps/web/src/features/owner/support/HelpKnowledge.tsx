// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Editor } from '@tiptap/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AI_CHAT_PROVIDERS,
  type AiProvider,
  type AccountHelpAiDto,
  type AiModelList,
  formatDateTime,
  HELP_LOCALES,
  HELP_ROUTE_KEYS,
  type HelpArticleDetail,
  type HelpArticleKind,
  type HelpCategory,
  type HelpGuide,
  type HelpImportFile,
  type HelpImportReport,
  type HelpConsoleConfig,
  type HelpLocale,
  type HelpRouteKey,
  type HelpVisibility,
  type MessageKey,
  type PlatformAccount,
  type RichNode,
  SUPPORT_STAFF_ROLES,
  type UpdateHelpCenterSettings,
  t,
  tDynamic,
} from '@bines/shared';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  Picker,
  Segmented,
  SkeletonRows,
  Switch,
  Tabs,
} from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { confirmDialog } from '../../../lib/dialogs';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { RichEditorView, ToolButton, useRichEditor } from '../../item/RichEditor';
import { helpEditorExtensions, imageFiles } from './help-editor';
import { EMPTY_GUIDE, GuideFields } from './GuideEditor';
import { ToursTab, useConsoleTours } from './ToursTab';
import { ChecklistTab } from './ChecklistTab';
import { TEXTAREA } from '../../support/NewTicketDialog';
import { defaultChoiceLabel, modelChoices, modelPickerOptions } from '../../ai/ai-api';
import {
  exportHelpPackage,
  helpConsoleKeys,
  importHelpPackage,
  uploadHelpImage,
  useHelpArticleDetail,
  useHelpArticles,
  useHelpConsoleConfig,
  useHelpMetrics,
} from './help-console-api';

type Tab = 'articles' | 'tours' | 'firstSteps' | 'categories' | 'settings' | 'metrics';

/**
 * Owner console → Support → Knowledge: help articles (drafts, versions, publish, he / en), categories
 * the help center's settings (the path before a ticket, screen → tags, who writes / publishes, branding, the help
 * assistant's platform AI connection and caps, per-account overrides) and the metrics. Articles are platform data —
 * never an account's doc; the editor offers no people, items, boards or files of an account.
 */
export const HelpKnowledge = () => {
  const config = useHelpConsoleConfig();
  const [tab, setTab] = useState<Tab>('articles');
  if (config.isPending) return <SkeletonRows rows={5} label={t('app.loading')} />;
  if (config.isError) return <Notice tone="error">{errorMessage(config.error)}</Notice>;
  const c = config.data;
  const tabs: { value: Tab; label: string; testId: string }[] = [
    { value: 'articles', label: t('help.console.articles'), testId: 'help-tab-articles' },
    // Guided tours: content of the knowledge center, written and published like articles.
    { value: 'tours', label: t('tour.console.tab'), testId: 'help-tab-tours' },
    ...(c.may_configure
      ? [
          // "First steps": the self-ticking checklist and its steps.
          { value: 'firstSteps' as const, label: t('checklist.console.tab'), testId: 'help-tab-first-steps' },
          { value: 'categories' as const, label: t('help.console.categories'), testId: 'help-tab-categories' },
          { value: 'settings' as const, label: t('help.console.settings'), testId: 'help-tab-settings' },
        ]
      : []),
    { value: 'metrics', label: t('help.console.metrics'), testId: 'help-tab-metrics' },
  ];
  return (
    <section className="space-y-3" data-testid="help-console" data-role={c.role}>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'articles' ? <ArticlesTab config={c} /> : null}
      {tab === 'tours' ? <ToursTab config={c} importDialog={(close) => <ImportDialog onClose={close} />} /> : null}
      {tab === 'firstSteps' ? <ChecklistTab key={JSON.stringify(c.settings.first_steps)} config={c} /> : null}
      {tab === 'categories' ? <CategoriesTab config={c} /> : null}
      {tab === 'settings' ? <SettingsTab key={JSON.stringify(c.settings)} config={c} /> : null}
      {tab === 'metrics' ? <MetricsTab /> : null}
    </section>
  );
};

const localeLabel = (l: string) => tDynamic(`help.locale.${l}`);

// ---------------------------------------------------------------------------------------------------- articles

const ArticlesTab = ({ config }: { config: HelpConsoleConfig }) => {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const runExport = async () => {
    setExporting(true);
    try {
      await exportHelpPackage();
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setExporting(false);
    }
  };
  const list = useHelpArticles(filters);
  const rows = list.data?.data ?? [];
  const set = (k: string) => (v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const all = { value: '', label: t('tickets.filter.all') };
  return (
    <div className="flex items-start gap-4 max-lg:flex-col">
      <div className={selected ? 'min-w-0 flex-[1_1_360px] space-y-2 max-lg:w-full' : 'w-full space-y-2'}>
        <div className="flex flex-wrap items-center gap-2" data-testid="help-filters">
          <Input
            value={filters.q ?? ''}
            onChange={(e) => set('q')(e.target.value)}
            placeholder={t('help.search')}
            className="w-44"
            data-testid="help-console-search"
          />
          <Picker
            label={t('help.field.status')}
            className="w-32"
            value={filters.status ?? ''}
            onChange={set('status')}
            options={[
              all,
              { value: 'draft', label: t('help.status.draft') },
              { value: 'published', label: t('help.status.published') },
            ]}
          />
          <Picker
            label={t('help.field.locale')}
            className="w-28"
            value={filters.locale ?? ''}
            onChange={set('locale')}
            options={[all, ...HELP_LOCALES.map((l) => ({ value: l, label: localeLabel(l) }))]}
          />
          <Picker
            label={t('help.field.category')}
            className="w-36"
            value={filters.category_id ?? ''}
            onChange={set('category_id')}
            options={[all, ...config.categories.map((x) => ({ value: x.id, label: x.name }))]}
          />
          {config.may_write ? (
            <Button size="sm" variant="accent" onClick={() => setCreating(true)} data-testid="help-new-article">
              <Icon name="plus" size={14} />
              {t('help.new')}
            </Button>
          ) : null}
          {config.may_write ? (
            <Button size="sm" variant="secondary" onClick={() => setImporting(true)} data-testid="help-import">
              <Icon name="upload" size={14} />
              {t('help.import.button')}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" busy={exporting} onClick={() => void runExport()} data-testid="help-export">
            <Icon name="download" size={14} />
            {t('help.export.button')}
          </Button>
        </div>
        {list.isPending ? (
          <SkeletonRows rows={5} label={t('app.loading')} />
        ) : rows.length ? (
          <ul className="divide-y divide-line rounded-[var(--radius)] border border-line">
            {rows.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  data-testid="help-article-row"
                  data-title={a.title}
                  data-status={a.status}
                  onClick={() => setSelected(a.id)}
                  className={
                    selected === a.id
                      ? 'flex w-full items-center gap-2 bg-surface-2 px-3 py-2 text-start'
                      : 'flex w-full items-center gap-2 px-3 py-2 text-start hover:bg-surface-2'
                  }
                >
                  <span className="min-w-0 flex-1 truncate text-sm text-fg" dir="auto">
                    {a.title}
                  </span>
                  <Badge>{a.locale.toUpperCase()}</Badge>
                  <Badge tone={a.status === 'published' ? 'ok' : 'neutral'}>{t(`help.status.${a.status}`)}</Badge>
                  {a.unpublished_changes ? <Badge tone="warn">{t('help.unpublishedChanges')}</Badge> : null}
                  <span className="text-xs text-muted tabular-nums" title={t('help.helpfulCounts')}>
                    {t('help.helpful.yes')} {a.helpful_yes} · {t('help.helpful.no')} {a.helpful_no}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={t('help.empty')} testId="help-articles-empty" />
        )}
      </div>
      {selected ? (
        <div className="min-w-0 flex-[2_1_520px] max-lg:w-full">
          <ArticleEditor
            key={selected}
            id={selected}
            config={config}
            onClose={() => setSelected(null)}
            onOpen={setSelected}
          />
        </div>
      ) : null}
      {importing ? <ImportDialog onClose={() => setImporting(false)} /> : null}
      {creating ? (
        <NewArticleDialog
          config={config}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      ) : null}
    </div>
  );
};

const useInvalidate = () => {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: helpConsoleKeys.all });
};

// ---------------------------------------------------------------------------------------------------- import

/** What the file picker offers: a package (.zip), articles (.md) and their images / categories / screens. */
const IMPORT_ACCEPT = '.zip,.md,.markdown,.json,.png,.jpg,.jpeg,.webp,.gif';

/** An import code (`help_import_image_missing:images/a.png`) → its text, the part after ":" as {detail}. */
const importText = (code: string) => {
  const i = code.indexOf(':');
  const key = i < 0 ? code : code.slice(0, i);
  return tDynamic(`help.import.msg.${key}`, { detail: i < 0 ? '' : code.slice(i + 1) });
};

const OUTCOME_TONE: Record<HelpImportFile['outcome'], 'ok' | 'info' | 'neutral' | 'danger' | 'warn'> = {
  new: 'ok',
  updated: 'info',
  unchanged: 'neutral',
  error: 'danger',
  skipped: 'warn',
};

const ImportReportView = ({ report }: { report: HelpImportReport }) => {
  const c = report.counts;
  const stats: [string, number, string][] = [
    ['help.import.count.new', c.new, 'new'],
    ['help.import.count.updated', c.updated, 'updated'],
    ['help.import.count.unchanged', c.unchanged, 'unchanged'],
    ['help.import.count.errors', c.errors, 'errors'],
    ['help.import.count.published', c.published, 'published'],
  ];
  return (
    <div className="space-y-3" data-testid="help-import-report" data-dry-run={report.dry_run ? 'true' : 'false'}>
      <div className="flex flex-wrap gap-2">
        {stats.map(([label, n, key]) => (
          <span
            key={key}
            className="rounded-[var(--radius)] border border-line px-2.5 py-1 text-sm"
            data-testid={`help-import-count-${key}`}
            data-count={n}
          >
            <span className="font-semibold tabular-nums">{n}</span>{' '}
            <span className="text-muted">{tDynamic(label)}</span>
          </span>
        ))}
      </div>
      <p className="text-xs text-muted">
        {t('help.import.extras', {
          categories: report.categories.created,
          matched: report.categories.matched,
          images: report.images.new,
          reused: report.images.reused,
          screens: report.screens.length,
        })}
      </p>
      {/* Guided tours of the package. */}
      {report.tours.new + report.tours.updated + report.tours.unchanged + report.tours.errors ? (
        <p className="text-xs text-muted" data-testid="help-import-tours">
          {t('help.import.tours', {
            new: report.tours.new,
            updated: report.tours.updated,
            unchanged: report.tours.unchanged,
            errors: report.tours.errors,
          })}
        </p>
      ) : null}
      {report.warnings.length ? (
        <Notice tone="warn">
          <ul className="list-disc ps-4">
            {report.warnings.map((w) => (
              <li key={w}>{importText(w)}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <ul className="max-h-[22rem] divide-y divide-line overflow-auto rounded-[var(--radius)] border border-line">
        {report.files.map((f) => (
          <li
            key={f.path}
            className="space-y-0.5 px-3 py-2"
            data-testid="help-import-file"
            data-path={f.path}
            data-outcome={f.outcome}
          >
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-fg" dir="auto" title={f.path}>
                {f.title ?? f.path}
              </span>
              {f.locale ? <Badge>{f.locale.toUpperCase()}</Badge> : null}
              {f.published ? <Badge tone="ok">{t('help.import.willPublish')}</Badge> : null}
              <Badge tone={OUTCOME_TONE[f.outcome]}>{t(`help.import.outcome.${f.outcome}`)}</Badge>
            </div>
            <div className="truncate text-xs text-muted" dir="ltr">
              {f.path}
              {f.slug ? ` · ${f.slug}` : ''}
            </div>
            {f.error ? <div className="text-xs text-danger-fg">{importText(f.error)}</div> : null}
            {f.warnings.map((w) => (
              <div key={w} className="text-xs text-accent-fg">
                {importText(w)}
              </div>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * "Import" (kb-import): the system file picker (a .zip package, or .md files with their images), a preview of what
 * would change (new / updated / unchanged / errors per file, nothing written), then the import and its report.
 */
const ImportDialog = ({ onClose }: { onClose: () => void }) => {
  const invalidate = useInvalidate();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const preview = useMutation({ mutationFn: (list: File[]) => importHelpPackage(list, true) });
  const run = useMutation({
    mutationFn: () => importHelpPackage(files, false),
    onSuccess: async (r) => {
      await invalidate();
      showToast({ message: t('help.import.done', { count: r.counts.new + r.counts.updated }) });
    },
  });
  const choose = (list: File[]) => {
    if (!list.length) return;
    setFiles(list);
    run.reset();
    preview.mutate(list);
  };
  const report = run.data ?? preview.data;
  const nothing =
    !!preview.data && preview.data.counts.new + preview.data.counts.updated + preview.data.counts.published === 0;
  const close = () => {
    if (run.data) void invalidate();
    onClose();
  };
  return (
    <Dialog
      open
      onClose={close}
      title={t(run.data ? 'help.import.resultTitle' : 'help.import.title')}
      className="w-[min(46rem,calc(100vw-2rem))]"
    >
      <div className="space-y-3" data-testid="help-import-dialog">
        {!run.data ? (
          <div
            className={
              dragging
                ? 'rounded-[var(--radius-lg)] border-2 border-dashed border-primary bg-primary-soft p-4 text-center'
                : 'rounded-[var(--radius-lg)] border-2 border-dashed border-line p-4 text-center'
            }
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              choose(Array.from(e.dataTransfer.files));
            }}
            data-testid="help-import-drop"
          >
            <p className="mb-2 text-sm text-fg-2">{t('help.import.hint')}</p>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => input.current?.click()}
              data-testid="help-import-choose"
            >
              <Icon name="upload" size={14} />
              {t('help.import.choose')}
            </Button>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              accept={IMPORT_ACCEPT}
              data-testid="help-import-input"
              onChange={(e) => {
                const list = Array.from(e.target.files ?? []);
                e.target.value = '';
                choose(list);
              }}
            />
            {files.length ? (
              <p className="mt-2 truncate text-xs text-muted" dir="auto">
                {files.map((f) => f.name).join(', ')}
              </p>
            ) : null}
          </div>
        ) : null}
        {preview.isPending ? <SkeletonRows rows={3} label={t('help.import.previewing')} /> : null}
        {preview.isError ? <Notice tone="error">{errorMessage(preview.error)}</Notice> : null}
        {run.isError ? <Notice tone="error">{errorMessage(run.error)}</Notice> : null}
        {report && !preview.isPending ? (
          <>
            {!run.data ? <p className="text-sm font-semibold text-fg">{t('help.import.previewTitle')}</p> : null}
            <ImportReportView report={report} />
          </>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close} data-testid="help-import-close">
            {t(run.data ? 'common.close' : 'common.cancel')}
          </Button>
          {!run.data ? (
            <Button
              variant="accent"
              busy={run.isPending}
              disabled={!preview.data || nothing}
              onClick={() => run.mutate()}
              data-testid="help-import-run"
            >
              {t('help.import.run')}
            </Button>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
};

const NewArticleDialog = ({
  config,
  onClose,
  onCreated,
  translationOf,
}: {
  config: HelpConsoleConfig;
  onClose: () => void;
  onCreated: (id: string) => void;
  translationOf?: { id: string; locale: HelpLocale };
}) => {
  const invalidate = useInvalidate();
  const [title, setTitle] = useState('');
  const [locale, setLocale] = useState<HelpLocale>(
    translationOf ? (translationOf.locale === 'he' ? 'en' : 'he') : 'he',
  );
  const [category, setCategory] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api().post<HelpArticleDetail>('/platform/support/help/articles', {
        title,
        locale,
        category_id: category || null,
        ...(translationOf ? { translation_of: translationOf.id } : {}),
      }),
    onSuccess: async (a) => {
      await invalidate();
      onCreated(a.id);
    },
  });
  return (
    <Dialog open onClose={onClose} title={t(translationOf ? 'help.newTranslation' : 'help.new')}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create.mutate();
        }}
      >
        <Field label={t('help.field.title')}>
          <Input
            value={title}
            maxLength={200}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            data-testid="help-new-title"
          />
        </Field>
        <div className="flex flex-wrap gap-3">
          <Field label={t('help.field.locale')}>
            <Segmented
              label={t('help.field.locale')}
              value={locale}
              onChange={setLocale}
              options={HELP_LOCALES.map((l) => ({ value: l, label: localeLabel(l), testId: `help-new-locale-${l}` }))}
            />
          </Field>
          <Field label={t('help.field.category')}>
            <Picker
              label={t('help.field.category')}
              className="w-44"
              value={category}
              onChange={setCategory}
              options={[
                { value: '', label: t('help.category.none') },
                ...config.categories.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.name })),
              ]}
            />
          </Field>
        </div>
        {create.isError ? <Notice tone="error">{errorMessage(create.error)}</Notice> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant="accent"
            busy={create.isPending}
            disabled={!title.trim()}
            data-testid="help-new-create"
          >
            {t('help.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
};

const tagsOf = (raw: string) => [
  ...new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];

const ArticleEditor = ({
  id,
  config,
  onClose,
  onOpen,
}: {
  id: string;
  config: HelpConsoleConfig;
  onClose: () => void;
  onOpen: (id: string) => void;
}) => {
  const detail = useHelpArticleDetail(id);
  if (detail.isPending) return <SkeletonRows rows={6} label={t('app.loading')} />;
  if (detail.isError) return <Notice tone="error">{errorMessage(detail.error)}</Notice>;
  return (
    <ArticleForm
      key={`${detail.data.id}:${detail.data.version}`}
      article={detail.data}
      config={config}
      onClose={onClose}
      onOpen={onOpen}
    />
  );
};

const ArticleForm = ({
  article,
  config,
  onClose,
  onOpen,
}: {
  article: HelpArticleDetail;
  config: HelpConsoleConfig;
  onClose: () => void;
  onOpen: (id: string) => void;
}) => {
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  const [title, setTitle] = useState(article.title);
  const [slug, setSlug] = useState(article.slug);
  const [excerpt, setExcerpt] = useState(article.excerpt);
  const [category, setCategory] = useState(article.category_id ?? '');
  const [tags, setTags] = useState(article.tags.join(', '));
  const [visibility, setVisibility] = useState<HelpVisibility>(article.visibility);
  // A practical guide: its kind, video and steps, and the tour "show me in the app" starts.
  const [kind, setKind] = useState<HelpArticleKind>(article.kind);
  const [guide, setGuide] = useState<HelpGuide>(article.guide ?? EMPTY_GUIDE);
  const [tourId, setTourId] = useState(article.tour_id ?? '');
  const tours = useConsoleTours();
  const [versions, setVersions] = useState(false);
  const [translating, setTranslating] = useState(false);
  const readOnly = !config.may_write;
  const fail = (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' });
  // Images (kb-import): the image button, a paste or a drop uploads to the platform's help storage and inserts.
  const editorRef = useRef<Editor | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const insertImages = async (files: File[]) => {
    const images = imageFiles(files);
    if (!images.length) return showToast({ message: t('help.image.onlyImages'), tone: 'error' });
    setUploading((n) => n + images.length);
    for (const file of images) {
      try {
        const a = await uploadHelpImage(file);
        editorRef.current
          ?.chain()
          .focus()
          .insertContent({ type: 'image', attrs: { src: a.id, alt: file.name.replace(/\.[^.]+$/, '') } })
          .run();
      } catch (e) {
        fail(e);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const [extensions] = useState(helpEditorExtensions);
  const { editor, mention } = useRichEditor({
    members: [],
    placeholder: t('help.field.body'),
    initial: article.content as never,
    onSubmit: () => undefined,
    onFiles: readOnly ? undefined : (files) => void insertImages(files),
    extensions,
    editable: !readOnly,
    contentClass: 'min-h-[18rem] p-3 text-sm',
  });
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);
  const imageTools = readOnly ? undefined : (
    <>
      <ToolButton
        label={'help.image.insert' as MessageKey}
        testId="help-image-button"
        onClick={() => imageInput.current?.click()}
      >
        <Icon name="image" size={15} />
      </ToolButton>
      {uploading ? (
        <span className="ms-1 text-xs text-muted" data-testid="help-image-uploading">
          {t('help.image.uploading')}
        </span>
      ) : null}
      <input
        ref={imageInput}
        type="file"
        hidden
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif"
        data-testid="help-image-input"
        onChange={(e) => {
          const list = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (list.length) void insertImages(list);
        }}
      />
    </>
  );
  const done = async (a: HelpArticleDetail, message: string) => {
    qc.setQueryData(helpConsoleKeys.article(a.id), a);
    await invalidate();
    showToast({ message });
  };
  const save = useMutation({
    mutationFn: () =>
      api().patch<HelpArticleDetail>(`/platform/support/help/articles/${article.id}`, {
        title,
        slug,
        excerpt,
        category_id: category || null,
        tags: tagsOf(tags),
        visibility,
        ...(editor ? { content: editor.getJSON() as RichNode } : {}),
        kind,
        tour_id: tourId || null,
        // A step needs its sentence: an empty one is left out.
        ...(kind === 'guide' ? { guide: { ...guide, steps: guide.steps.filter((s) => s.text.trim()) } } : {}),
      }),
    onSuccess: (a) => done(a, t('help.saved')),
    onError: fail,
  });
  const act = useMutation({
    mutationFn: async (kind: 'publish' | 'unpublish') => {
      // Publishing publishes what is on screen: save first.
      if (kind === 'publish' && config.may_write) await save.mutateAsync();
      return api().post<HelpArticleDetail>(`/platform/support/help/articles/${article.id}/${kind}`, {});
    },
    onSuccess: (a, kind) => done(a, t(kind === 'publish' ? 'help.publishedToast' : 'help.unpublishedToast')),
    onError: fail,
  });
  const remove = async () => {
    if (
      !(await confirmDialog({
        title: t('help.delete'),
        message: t('help.deleteConfirm'),
        confirmLabel: t('help.delete'),
      }))
    )
      return;
    try {
      await api().delete(`/platform/support/help/articles/${article.id}`);
      await invalidate();
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  const other = article.locale === 'he' ? 'en' : 'he';
  const translation = article.translations.find((x) => x.locale === other);
  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2" data-testid="help-editor" data-id={article.id}>
        <Badge>{localeLabel(article.locale)}</Badge>
        <Badge tone={article.status === 'published' ? 'ok' : 'neutral'}>{t(`help.status.${article.status}`)}</Badge>
        <span className="text-xs text-muted">
          {t('help.versionOf', { version: article.version })}
          {article.published_at ? ` · ${t('help.publishedAt', { date: formatDateTime(article.published_at) })}` : ''}
        </span>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setVersions(true)} data-testid="help-versions">
          <Icon name="history" size={14} />
          {t('help.versions')}
        </Button>
        {translation ? (
          <Button size="sm" variant="ghost" onClick={() => onOpen(translation.id)} data-testid="help-open-translation">
            {localeLabel(other)}
          </Button>
        ) : config.may_write ? (
          <Button size="sm" variant="ghost" onClick={() => setTranslating(true)} data-testid="help-add-translation">
            <Icon name="plus" size={14} />
            {localeLabel(other)}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="x" size={14} />
        </Button>
      </div>
      <Field label={t('help.field.title')}>
        <Input
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          disabled={readOnly}
          data-testid="help-title"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('help.field.slug')} hint={t('help.field.slugHint')}>
          <Input
            value={slug}
            maxLength={120}
            onChange={(e) => setSlug(e.target.value)}
            disabled={readOnly}
            dir="auto"
          />
        </Field>
        <Field label={t('help.field.category')}>
          <Picker
            label={t('help.field.category')}
            value={category}
            onChange={setCategory}
            testId="help-category"
            options={[
              { value: '', label: t('help.category.none') },
              ...config.categories.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        </Field>
        <Field label={t('help.field.tags')} hint={t('help.field.tagsHint')}>
          <Input value={tags} onChange={(e) => setTags(e.target.value)} disabled={readOnly} data-testid="help-tags" />
        </Field>
        <Field label={t('help.field.visibility')}>
          <Segmented
            label={t('help.field.visibility')}
            value={visibility}
            onChange={setVisibility}
            testId="help-visibility"
            options={[
              { value: 'public' as const, label: t('help.visibility.public'), testId: 'help-visibility-public' },
              { value: 'signed_in' as const, label: t('help.visibility.signed_in'), testId: 'help-visibility-signed' },
            ]}
          />
        </Field>
        <Field label={t('guide.edit.kind')}>
          <Segmented
            label={t('guide.edit.kind')}
            value={kind}
            onChange={setKind}
            testId="help-kind"
            options={[
              { value: 'article' as const, label: t('guide.edit.kindArticle'), testId: 'help-kind-article' },
              { value: 'guide' as const, label: t('guide.edit.kindGuide'), testId: 'help-kind-guide' },
            ]}
          />
        </Field>
        <Field label={t('guide.edit.tour')} hint={t('guide.edit.tourHint')}>
          <Picker
            label={t('guide.edit.tour')}
            value={tourId}
            onChange={setTourId}
            testId="help-tour"
            options={[
              { value: '', label: t('guide.edit.tourNone') },
              ...(tours.data?.data ?? [])
                .filter((x) => x.locale === article.locale || x.id === tourId)
                .map((x) => ({
                  value: x.id,
                  label: x.status === 'published' ? x.title : `${x.title} (${t('help.status.draft')})`,
                })),
            ]}
          />
        </Field>
      </div>
      {config.tags.length ? (
        <p className="text-xs text-muted">
          {t('help.field.tagsInUse')} {config.tags.join(', ')}
        </p>
      ) : null}
      <Field label={t('help.field.excerpt')}>
        <textarea
          className={TEXTAREA}
          style={{ minHeight: '3.5rem' }}
          maxLength={300}
          value={excerpt}
          disabled={readOnly}
          onChange={(e) => setExcerpt(e.target.value)}
        />
      </Field>
      {kind === 'guide' ? <GuideFields guide={guide} onChange={setGuide} readOnly={readOnly} /> : null}
      <div data-testid="help-body" className="space-y-1.5">
        {kind === 'guide' ? <span className="text-xs text-muted">{t('guide.edit.body')}</span> : null}
        <RichEditorView editor={editor} mention={mention} members={[]} readOnly={readOnly} tools={imageTools} />
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        {config.may_write ? (
          <Button variant="ghost" onClick={() => void remove()} data-testid="help-delete">
            <Icon name="trash" size={14} />
            {t('help.delete')}
          </Button>
        ) : null}
        {config.may_write ? (
          <Button variant="secondary" busy={save.isPending} onClick={() => save.mutate()} data-testid="help-save">
            {t('help.saveDraft')}
          </Button>
        ) : null}
        {config.may_publish && article.status === 'published' ? (
          <Button
            variant="secondary"
            busy={act.isPending}
            onClick={() => act.mutate('unpublish')}
            data-testid="help-unpublish"
          >
            {t('help.unpublish')}
          </Button>
        ) : null}
        {config.may_publish ? (
          <Button
            variant="accent"
            busy={act.isPending}
            onClick={() => act.mutate('publish')}
            data-testid="help-publish"
          >
            <Icon name="send" size={14} />
            {t('help.publish')}
          </Button>
        ) : null}
      </div>
      {versions ? (
        <VersionsDialog article={article} mayRestore={config.may_write} onClose={() => setVersions(false)} />
      ) : null}
      {translating ? (
        <NewArticleDialog
          config={config}
          translationOf={{ id: article.id, locale: article.locale }}
          onClose={() => setTranslating(false)}
          onCreated={(id) => {
            setTranslating(false);
            onOpen(id);
          }}
        />
      ) : null}
    </Card>
  );
};

const VersionsDialog = ({
  article,
  mayRestore,
  onClose,
}: {
  article: HelpArticleDetail;
  mayRestore: boolean;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: helpConsoleKeys.versions(article.id),
    queryFn: () =>
      api().get<{
        data: {
          id: string;
          version: number;
          kind: string;
          title: string;
          created_at: string;
          created_by_name: string | null;
        }[];
      }>(`/platform/support/help/articles/${article.id}/versions`),
  });
  const restore = useMutation({
    mutationFn: (versionId: string) =>
      api().post<HelpArticleDetail>(`/platform/support/help/articles/${article.id}/versions/${versionId}/restore`, {}),
    onSuccess: async (a) => {
      qc.setQueryData(helpConsoleKeys.article(a.id), a);
      await qc.invalidateQueries({ queryKey: helpConsoleKeys.all });
      showToast({ message: t('help.restored', { version: a.version }) });
      onClose();
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  return (
    <Dialog open onClose={onClose} title={t('help.versions')} subtitle={article.title}>
      {list.isPending ? (
        <SkeletonRows rows={4} label={t('app.loading')} />
      ) : (
        <ul className="divide-y divide-line" data-testid="help-version-list">
          {(list.data?.data ?? []).map((v) => (
            <li
              key={v.id}
              className="flex items-center gap-2 py-2 text-sm"
              data-testid="help-version"
              data-kind={v.kind}
            >
              <span className="tabular-nums text-fg-2">v{v.version}</span>
              <Badge tone={v.kind === 'publish' ? 'ok' : v.kind === 'restore' ? 'violet' : 'neutral'}>
                {tDynamic(`help.versionKind.${v.kind}`)}
              </Badge>
              <span className="min-w-0 flex-1 truncate" dir="auto">
                {v.title}
              </span>
              <span className="text-xs text-muted">
                {formatDateTime(v.created_at)}
                {v.created_by_name ? ` · ${v.created_by_name}` : ''}
              </span>
              {mayRestore && v.kind !== 'publish' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => restore.mutate(v.id)}
                  data-testid="help-version-restore"
                >
                  {t('help.restore')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
};

// ---------------------------------------------------------------------------------------------------- categories

const CategoriesTab = ({ config }: { config: HelpConsoleConfig }) => {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (v: { id: string | null; body: Record<string, unknown> }) =>
      v.id
        ? api().patch<{ categories: HelpCategory[] }>(`/platform/support/help/categories/${v.id}`, v.body)
        : api().post<{ categories: HelpCategory[] }>('/platform/support/help/categories', v.body),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: helpConsoleKeys.config });
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const [name, setName] = useState('');
  return (
    <Card className="space-y-3">
      <Heading title={t('help.console.categories')} hint={t('help.categoriesHint')} testId="help-categories" />
      <ul className="space-y-2">
        {config.categories.map((c) => (
          <CategoryRow
            key={`${c.id}:${c.name}:${c.name_en}:${c.icon}:${c.position}:${c.archived}`}
            category={c}
            onSave={(body) => save.mutate({ id: c.id, body })}
          />
        ))}
      </ul>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) save.mutate({ id: null, body: { name: name.trim() } }, { onSuccess: () => setName('') });
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('help.category.new')}
          maxLength={80}
          data-testid="help-category-new"
        />
        <Button type="submit" variant="secondary" disabled={!name.trim()} data-testid="help-category-add">
          <Icon name="plus" size={14} />
          {t('help.category.add')}
        </Button>
      </form>
    </Card>
  );
};

const CategoryRow = ({
  category,
  onSave,
}: {
  category: HelpCategory;
  onSave: (body: Record<string, unknown>) => void;
}) => {
  const [name, setName] = useState(category.name);
  const [nameEn, setNameEn] = useState(category.name_en ?? '');
  const [icon, setIcon] = useState(category.icon ?? '');
  const [position, setPosition] = useState(String(category.position));
  return (
    <li className="flex flex-wrap items-center gap-2" data-testid="help-category-row" data-name={category.name}>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-40"
        aria-label={t('help.category.name')}
      />
      <Input
        value={nameEn}
        onChange={(e) => setNameEn(e.target.value)}
        className="w-40"
        aria-label={t('help.category.nameEn')}
        placeholder={t('help.category.nameEn')}
        dir="ltr"
      />
      <Input
        value={icon}
        onChange={(e) => setIcon(e.target.value)}
        className="w-28"
        aria-label={t('help.category.icon')}
        placeholder={t('help.category.icon')}
        dir="ltr"
      />
      <Input
        value={position}
        onChange={(e) => setPosition(e.target.value)}
        className="w-16"
        inputMode="numeric"
        aria-label={t('help.category.position')}
        dir="ltr"
      />
      <Button
        size="sm"
        variant="secondary"
        disabled={!name.trim() || !/^\d{1,4}$/.test(position)}
        onClick={() =>
          onSave({
            name: name.trim(),
            name_en: nameEn.trim() || null,
            icon: icon.trim() || null,
            position: Number(position),
          })
        }
      >
        {t('help.save')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onSave({ name: category.name, archived: !category.archived })}>
        {t(category.archived ? 'help.category.unarchive' : 'help.category.archive')}
      </Button>
      {category.archived ? <Badge>{t('help.category.archived')}</Badge> : null}
    </li>
  );
};

// ---------------------------------------------------------------------------------------------------- settings

const Heading = ({ title, hint, testId }: { title: string; hint?: string; testId?: string }) => (
  <div className="space-y-0.5" data-testid={testId}>
    <h3 className="text-sm font-semibold text-fg">{title}</h3>
    {hint ? <p className="text-xs text-muted">{hint}</p> : null}
  </div>
);

const Row = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div className="flex flex-wrap items-center justify-between gap-3">
    <span className="space-y-0.5">
      <span className="block text-sm text-fg">{label}</span>
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </span>
    {children}
  </div>
);

const SettingsTab = ({ config }: { config: HelpConsoleConfig }) => {
  const qc = useQueryClient();
  const s = config.settings;
  const [draft, setDraft] = useState(s);
  const [routeTags, setRouteTags] = useState<Record<string, string>>(
    Object.fromEntries(s.route_tags.map((r) => [r.route, r.tags.join(', ')])),
  );
  const [cap, setCap] = useState(String(s.ai.default_cap_usd));
  const [maxSug, setMaxSug] = useState(String(s.flow.max_suggestions));
  const [passages, setPassages] = useState(String(s.ai.max_passages));
  const [key, setKey] = useState('');
  const save = useMutation({
    mutationFn: (patch: UpdateHelpCenterSettings) => api().patch('/platform/support/help/settings', patch),
    onSuccess: async () => {
      setKey('');
      await qc.invalidateQueries({ queryKey: helpConsoleKeys.config });
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  // The platform connection's live models (any provider) once a key is saved; typing a model id stays possible.
  const models = useQuery({
    queryKey: [...helpConsoleKeys.config, 'ai-models', s.ai.provider, s.ai.has_key, s.ai.base_url],
    queryFn: () => api().get<AiModelList>('/platform/support/help/ai/models'),
    enabled: !!s.ai.provider && (s.ai.has_key || s.ai.provider === 'openai_compatible'),
    retry: false,
    staleTime: 10 * 60_000,
  });
  const test = useMutation({
    mutationFn: () => api().post<{ ok: boolean; error: string | null }>('/platform/support/help/ai/test', {}),
    onSuccess: (r) =>
      showToast({
        message: r.ok ? t('help.ai.testOk') : (r.error ?? t('help.ai.testFailed')),
        tone: r.ok ? undefined : 'error',
      }),
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const num = (v: string) => /^\d+(\.\d+)?$/.test(v);
  const ok = num(cap) && /^\d{1,2}$/.test(maxSug) && /^\d{1,2}$/.test(passages);
  const toggleRole = (
    field: 'write_roles' | 'publish_roles',
    role: (typeof SUPPORT_STAFF_ROLES)[number],
    on: boolean,
  ) =>
    setDraft({
      ...draft,
      [field]: on ? [...new Set([...draft[field], role])] : draft[field].filter((r) => r !== role),
    });
  const submit = () =>
    save.mutate({
      enabled: draft.enabled,
      public_enabled: draft.public_enabled,
      flow: {
        show_articles: draft.flow.show_articles,
        show_assistant: draft.flow.show_assistant,
        max_suggestions: Number(maxSug),
      },
      route_tags: HELP_ROUTE_KEYS.map((route) => ({ route, tags: tagsOf(routeTags[route] ?? '') })).filter(
        (r) => r.tags.length,
      ),
      write_roles: draft.write_roles,
      publish_roles: draft.publish_roles,
      logo_url: draft.logo_url || null,
      base_url: draft.base_url || null,
      ai: {
        enabled: draft.ai.enabled,
        provider: draft.ai.provider,
        ...(key ? { api_key: key } : {}),
        base_url: draft.ai.base_url || null,
        model: draft.ai.model || null,
        default_cap_usd: Number(cap),
        cap_message: draft.ai.cap_message,
        max_passages: Number(passages),
        own_connection_allowed: draft.ai.own_connection_allowed,
      },
      // the AI's own articles, and the category an AI app gets as its guide.
      ai_knowledge: {
        ai_only_tag: draft.ai_knowledge.ai_only_tag?.trim() || null,
        guide_category_id: draft.ai_knowledge.guide_category_id || null,
      },
    });
  return (
    <div className="space-y-4" data-testid="help-settings">
      <Card className="space-y-3">
        <Heading title={t('help.cfg.general')} hint={t('help.cfg.generalHint')} />
        <Row label={t('help.cfg.enabled')}>
          <Switch
            checked={draft.enabled}
            onChange={(v) => setDraft({ ...draft, enabled: v })}
            label={t('help.cfg.enabled')}
            testId="help-cfg-enabled"
          />
        </Row>
        <Row label={t('help.cfg.public')} hint={t('help.cfg.publicHint')}>
          <Switch
            checked={draft.public_enabled}
            onChange={(v) => setDraft({ ...draft, public_enabled: v })}
            label={t('help.cfg.public')}
            testId="help-cfg-public"
          />
        </Row>
        <Row label={t('help.cfg.showArticles')} hint={t('help.cfg.showArticlesHint')}>
          <Switch
            checked={draft.flow.show_articles}
            onChange={(v) => setDraft({ ...draft, flow: { ...draft.flow, show_articles: v } })}
            label={t('help.cfg.showArticles')}
            testId="help-cfg-show-articles"
          />
        </Row>
        <Row label={t('help.cfg.showAssistant')} hint={t('help.cfg.showAssistantHint')}>
          <Switch
            checked={draft.flow.show_assistant}
            onChange={(v) => setDraft({ ...draft, flow: { ...draft.flow, show_assistant: v } })}
            label={t('help.cfg.showAssistant')}
            testId="help-cfg-show-assistant"
          />
        </Row>
        <Row label={t('help.cfg.maxSuggestions')}>
          <Input
            value={maxSug}
            onChange={(e) => setMaxSug(e.target.value)}
            className="w-20"
            inputMode="numeric"
            dir="ltr"
            data-testid="help-cfg-max"
          />
        </Row>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('help.cfg.logo')} hint={t('help.cfg.logoHint')}>
            <Input
              value={draft.logo_url ?? ''}
              onChange={(e) => setDraft({ ...draft, logo_url: e.target.value })}
              dir="ltr"
            />
          </Field>
          <Field label={t('help.cfg.baseUrl')} hint={t('help.cfg.baseUrlHint')}>
            <Input
              value={draft.base_url ?? ''}
              onChange={(e) => setDraft({ ...draft, base_url: e.target.value })}
              dir="ltr"
            />
          </Field>
        </div>
      </Card>

      <Card className="space-y-3">
        <Heading title={t('help.cfg.roles')} hint={t('help.cfg.rolesHint')} />
        {SUPPORT_STAFF_ROLES.map((role) => (
          <div key={role} className="flex flex-wrap items-center gap-4 text-sm">
            <span className="w-24 text-fg">{t(`tickets.staff.role.${role}`)}</span>
            <label className="flex items-center gap-2">
              <Switch
                checked={draft.write_roles.includes(role)}
                onChange={(v) => toggleRole('write_roles', role, v)}
                label={t('help.cfg.mayWrite')}
                testId={`help-cfg-write-${role}`}
              />
              {t('help.cfg.mayWrite')}
            </label>
            <label className="flex items-center gap-2">
              <Switch
                checked={draft.publish_roles.includes(role)}
                onChange={(v) => toggleRole('publish_roles', role, v)}
                label={t('help.cfg.mayPublish')}
                testId={`help-cfg-publish-${role}`}
              />
              {t('help.cfg.mayPublish')}
            </label>
          </div>
        ))}
      </Card>

      <Card className="space-y-3">
        <Heading title={t('help.cfg.routes')} hint={t('help.cfg.routesHint')} testId="help-cfg-routes" />
        <div className="grid gap-2 sm:grid-cols-2">
          {HELP_ROUTE_KEYS.map((route: HelpRouteKey) => (
            <label key={route} className="flex items-center gap-2 text-sm">
              <span className="w-28 shrink-0 text-fg-2">{t(`help.route.${route}`)}</span>
              <Input
                value={routeTags[route] ?? ''}
                onChange={(e) => setRouteTags({ ...routeTags, [route]: e.target.value })}
                placeholder={t('help.field.tagsHint')}
                data-testid={`help-cfg-route-${route}`}
              />
            </label>
          ))}
        </div>
      </Card>

      <Card className="space-y-3">
        <Heading title={t('help.cfg.ai')} hint={t('help.cfg.aiHint')} testId="help-cfg-ai" />
        <Row label={t('help.cfg.aiEnabled')}>
          <Switch
            checked={draft.ai.enabled}
            onChange={(v) => setDraft({ ...draft, ai: { ...draft.ai, enabled: v } })}
            label={t('help.cfg.aiEnabled')}
            testId="help-cfg-ai-enabled"
          />
        </Row>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('help.cfg.provider')}>
            <Picker
              label={t('help.cfg.provider')}
              value={draft.ai.provider ?? ''}
              placeholder={t('help.cfg.pickProvider')}
              onChange={(v) => setDraft({ ...draft, ai: { ...draft.ai, provider: v as AiProvider } })}
              options={AI_CHAT_PROVIDERS.map((p) => ({ value: p, label: t(`ai.provider.${p}`) }))}
              testId="help-cfg-provider"
            />
          </Field>
          <Field
            label={t('help.cfg.key')}
            hint={draft.ai.has_key ? t('help.cfg.keySaved', { hint: draft.ai.key_hint ?? '' }) : undefined}
          >
            <Input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              dir="ltr"
              data-testid="help-cfg-key"
            />
          </Field>
          {draft.ai.provider === 'openai_compatible' ? (
            <Field label={t('help.cfg.serverUrl')}>
              <Input
                value={draft.ai.base_url ?? ''}
                onChange={(e) => setDraft({ ...draft, ai: { ...draft.ai, base_url: e.target.value } })}
                dir="ltr"
              />
            </Field>
          ) : null}
          <Field label={t('help.cfg.model')} hint={t('help.cfg.modelHint')}>
            {models.data && draft.ai.provider === s.ai.provider ? (
              <div className="mb-1.5">
                <Picker<string>
                  label={t('help.cfg.model')}
                  value={draft.ai.model ?? ''}
                  onChange={(v) => setDraft({ ...draft, ai: { ...draft.ai, model: v || null } })}
                  options={[
                    {
                      value: '',
                      label: defaultChoiceLabel(t('ai.models.auto'), models.data),
                      testId: 'help-cfg-model-auto',
                    },
                    ...modelPickerOptions(modelChoices(models.data, draft.ai.model), 'help-cfg-model-option'),
                  ]}
                  testId="help-cfg-model-picker"
                />
              </div>
            ) : null}
            <Input
              value={draft.ai.model ?? ''}
              onChange={(e) => setDraft({ ...draft, ai: { ...draft.ai, model: e.target.value } })}
              dir="ltr"
              data-testid="help-cfg-model"
            />
          </Field>
          <Field label={t('help.cfg.cap')} hint={t('help.cfg.capHint')}>
            <Input
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              inputMode="decimal"
              dir="ltr"
              data-testid="help-cfg-cap"
            />
          </Field>
          <Field label={t('help.cfg.passages')}>
            <Input value={passages} onChange={(e) => setPassages(e.target.value)} inputMode="numeric" dir="ltr" />
          </Field>
        </div>
        <Field label={t('help.cfg.capMessage')} hint={t('help.cfg.capMessageHint')}>
          <Input
            value={draft.ai.cap_message}
            maxLength={500}
            onChange={(e) => setDraft({ ...draft, ai: { ...draft.ai, cap_message: e.target.value } })}
            data-testid="help-cfg-cap-message"
          />
        </Field>
        <Row label={t('help.cfg.ownAllowed')} hint={t('help.cfg.ownAllowedHint')}>
          <Switch
            checked={draft.ai.own_connection_allowed}
            onChange={(v) => setDraft({ ...draft, ai: { ...draft.ai, own_connection_allowed: v } })}
            label={t('help.cfg.ownAllowed')}
            testId="help-cfg-own-allowed"
          />
        </Row>
        <Field label={t('help.cfg.aiOnlyTag')} hint={t('help.cfg.aiOnlyTagHint')}>
          <Input
            value={draft.ai_knowledge.ai_only_tag ?? ''}
            maxLength={40}
            placeholder="ai"
            onChange={(e) =>
              setDraft({ ...draft, ai_knowledge: { ...draft.ai_knowledge, ai_only_tag: e.target.value || null } })
            }
            data-testid="help-cfg-ai-only-tag"
          />
        </Field>
        <Field label={t('help.cfg.aiGuideCategory')} hint={t('help.cfg.aiGuideCategoryHint')}>
          <Picker
            label={t('help.cfg.aiGuideCategory')}
            value={draft.ai_knowledge.guide_category_id ?? ''}
            placeholder={t('help.cfg.aiGuideNone')}
            onChange={(v) =>
              setDraft({ ...draft, ai_knowledge: { ...draft.ai_knowledge, guide_category_id: v || null } })
            }
            options={[
              { value: '', label: t('help.cfg.aiGuideNone') },
              ...config.categories.map((x) => ({ value: x.id, label: x.name })),
            ]}
            testId="help-cfg-ai-guide"
          />
        </Field>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            busy={test.isPending}
            disabled={!s.ai.has_key && s.ai.provider !== 'openai_compatible'}
            onClick={() => test.mutate()}
            data-testid="help-cfg-ai-test"
          >
            {t('help.cfg.test')}
          </Button>
        </div>
      </Card>

      <div className="flex justify-end">
        <Button variant="accent" busy={save.isPending} disabled={!ok} onClick={submit} data-testid="help-cfg-save">
          {t('help.save')}
        </Button>
      </div>

      {config.role === 'owner' ? <AccountOverrides /> : null}
    </div>
  );
};

/** Per account (the owner): the help assistant's source, the account's monthly cap and the lock. */
const AccountOverrides = () => {
  const qc = useQueryClient();
  const accounts = useQuery({
    queryKey: ['platform', 'accounts', 'help'],
    queryFn: () => api().get<{ data: PlatformAccount[] }>('/platform/accounts'),
  });
  const [accountId, setAccountId] = useState('');
  const current = useQuery({
    queryKey: helpConsoleKeys.accountAi(accountId),
    queryFn: () => api().get<AccountHelpAiDto>(`/platform/support/help/accounts/${accountId}/ai`),
    enabled: !!accountId,
  });
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api().patch<AccountHelpAiDto>(`/platform/support/help/accounts/${accountId}/ai`, patch),
    onSuccess: (r) => {
      qc.setQueryData(helpConsoleKeys.accountAi(accountId), r);
      showToast({ message: t('admin.general.saved') });
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const a = current.data;
  return (
    <Card className="space-y-3">
      <Heading title={t('help.cfg.accounts')} hint={t('help.cfg.accountsHint')} testId="help-cfg-accounts" />
      <Picker
        label={t('help.cfg.account')}
        value={accountId}
        placeholder={t('help.cfg.pickAccount')}
        onChange={setAccountId}
        options={(accounts.data?.data ?? []).map((x) => ({
          value: x.id,
          label: x.name,
          testId: `help-cfg-account-${x.slug}`,
        }))}
        testId="help-cfg-account"
      />
      {a ? (
        <AccountOverrideForm
          key={`${accountId}:${JSON.stringify(a)}`}
          value={a}
          onSave={(p) => save.mutate(p)}
          busy={save.isPending}
        />
      ) : null}
    </Card>
  );
};

const AccountOverrideForm = ({
  value,
  onSave,
  busy,
}: {
  value: AccountHelpAiDto;
  onSave: (patch: Record<string, unknown>) => void;
  busy: boolean;
}) => {
  const [source, setSource] = useState(value.source);
  const [cap, setCap] = useState(value.cap_usd === null ? '' : String(value.cap_usd));
  const [locked, setLocked] = useState(value.locked);
  const capOk = cap === '' || /^\d+(\.\d+)?$/.test(cap);
  return (
    <div className="space-y-3" data-testid="help-cfg-account-form">
      <p className="text-xs text-muted">
        {t('help.aiSettings.usage', { used: value.used_usd.toFixed(2), cap: value.effective_cap_usd.toFixed(2) })}
      </p>
      <Row label={t('help.aiSettings.source')}>
        <Segmented
          label={t('help.aiSettings.source')}
          value={source}
          onChange={setSource}
          options={[
            { value: 'platform' as const, label: t('help.aiSettings.platform') },
            { value: 'own' as const, label: t('help.aiSettings.own') },
          ]}
        />
      </Row>
      <Field label={t('help.cfg.accountCap')} hint={t('help.cfg.accountCapHint')}>
        <Input
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          inputMode="decimal"
          dir="ltr"
          data-testid="help-cfg-account-cap"
        />
      </Field>
      <Row label={t('help.cfg.lock')} hint={t('help.cfg.lockHint')}>
        <Switch checked={locked} onChange={setLocked} label={t('help.cfg.lock')} />
      </Row>
      <div className="flex justify-end">
        <Button
          variant="secondary"
          busy={busy}
          disabled={!capOk}
          onClick={() => onSave({ source, cap_usd: cap === '' ? null : Number(cap), locked })}
          data-testid="help-cfg-account-save"
        >
          {t('help.save')}
        </Button>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------------------------------- metrics

const MetricsTab = () => {
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const m = useHelpMetrics(Number(days));
  const stat = (label: string, value: ReactNode, testId: string) => (
    <div className="rounded-[var(--radius)] bg-surface-2 p-3" data-testid={testId}>
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold text-fg tabular-nums">{value}</div>
    </div>
  );
  return (
    <div className="space-y-3" data-testid="help-metrics">
      <Segmented
        label={t('help.metrics.period')}
        value={days}
        onChange={setDays}
        options={(['7', '30', '90'] as const).map((d) => ({ value: d, label: t('help.metrics.days', { days: d }) }))}
      />
      {m.isPending ? (
        <SkeletonRows rows={4} label={t('app.loading')} />
      ) : m.isError ? (
        <Notice tone="error">{errorMessage(m.error)}</Notice>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-4">
            {stat(
              t('help.metrics.deflection'),
              m.data.deflection_rate === null ? '—' : `${Math.round(m.data.deflection_rate * 100)}%`,
              'help-metric-deflection',
            )}
            {stat(t('help.metrics.deflected'), m.data.deflected, 'help-metric-deflected')}
            {stat(t('help.metrics.tickets'), m.data.tickets_opened, 'help-metric-tickets')}
            {stat(t('help.metrics.searches'), m.data.searches, 'help-metric-searches')}
            {stat(t('help.metrics.zero'), m.data.zero_result_searches, 'help-metric-zero')}
            {stat(t('help.metrics.helpful'), `${m.data.helpful_yes} / ${m.data.helpful_no}`, 'help-metric-helpful')}
            {stat(t('help.metrics.ai'), `${m.data.ai_answers} / ${m.data.ai_not_found}`, 'help-metric-ai')}
            {stat(t('help.metrics.views'), m.data.views, 'help-metric-views')}
          </div>
          <Card className="space-y-2">
            <Heading title={t('help.metrics.missing')} hint={t('help.metrics.missingHint')} />
            {m.data.zero_result_queries.length ? (
              <ul className="space-y-1 text-sm" data-testid="help-missing">
                {m.data.zero_result_queries.map((q) => (
                  <li key={q.query} className="flex justify-between gap-2" data-testid="help-missing-row">
                    <span dir="auto">{q.query}</span>
                    <span className="text-muted tabular-nums">{q.count}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">{t('help.metrics.noMissing')}</p>
            )}
          </Card>
          <Card className="space-y-2">
            <Heading title={t('help.metrics.articles')} />
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted">
                  <th className="text-start font-normal">{t('help.field.title')}</th>
                  <th className="font-normal">{t('help.metrics.views')}</th>
                  <th className="font-normal">{t('help.helpful.yes')}</th>
                  <th className="font-normal">{t('help.helpful.no')}</th>
                </tr>
              </thead>
              <tbody>
                {m.data.articles.map((a) => (
                  <tr key={a.id} data-testid="help-metric-article">
                    <td dir="auto">{a.title}</td>
                    <td className="text-center tabular-nums">{a.views}</td>
                    <td className="text-center tabular-nums">{a.helpful_yes}</td>
                    <td className="text-center tabular-nums">{a.helpful_no}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
};
