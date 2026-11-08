// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type GuideLocale, LANGUAGE_NAMES, markdownToDocHtml, type OwnerGuide, t } from '@bines/shared';
import { Badge, Button, Card, cn, EmptyState, Field, Input, Notice, Segmented, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { DocReader } from '../docs/DocReader';
import { InstallGuideView, uiGuideLocale } from './InstallGuide';

const KEY = ['platform', 'guides'] as const;
/** The bundled installation guide in the list (the owner's own guides are by id). */
export const INSTALL_GUIDE = 'install';

const other = (l: GuideLocale): GuideLocale => (l === 'he' ? 'en' : 'he');

/** A guide's title in this language, else in the other one. */
export const guideTitle = (g: Pick<OwnerGuide, 'title'>, locale: GuideLocale) =>
  g.title[locale].trim() || g.title[other(locale)].trim();

/** The language a guide is shown in: the asked one when it has a body (or nothing has one), else the other one. */
export const guideShownLocale = (g: Pick<OwnerGuide, 'body'>, locale: GuideLocale): GuideLocale =>
  g.body[locale].trim() || !g.body[other(locale)].trim() ? locale : other(locale);

/** The ids in their new order after moving one a step up (-1) or down (+1); null at the edge. */
export const moveGuide = (ids: string[], id: string, by: -1 | 1): string[] | null => {
  const i = ids.indexOf(id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= ids.length) return null;
  const next = [...ids];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
};

/**
 * Owner console → Guides: the public installation and licensing guide (the same as /api/docs/guide)
 * and the owner's own guides — private Markdown pages kept in the database (never in the repository), shown only
 * here. Add, edit (title and body per language, with a preview), reorder and delete them.
 */
export const OwnerGuidesSection = ({ guide, anchor }: { guide?: string; anchor?: string }) => {
  const guides = useQuery({
    queryKey: KEY,
    queryFn: async () => (await api().get<{ data: OwnerGuide[] }>('/platform/guides')).data,
  });
  const [selected, setSelected] = useState<string>(guide ?? INSTALL_GUIDE);
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [locale, setLocale] = useState<GuideLocale>(uiGuideLocale);
  const [section, setSection] = useState<string | undefined>(anchor);
  const list = guides.data ?? [];
  const current = list.find((g) => g.id === selected);
  const select = (id: string) => {
    setSelected(id);
    setEditing(null);
    setSection(undefined);
  };

  return (
    <section className="space-y-2.5" data-testid="owner-guides">
      <header className="space-y-0.5">
        <h2 className="font-display text-base font-bold text-heading">{t('guides.owner.title')}</h2>
        <p className="max-w-[640px] text-xs text-muted">{t('guides.owner.hint')}</p>
      </header>
      <div className="flex gap-4 max-md:flex-col">
        <Card className="shrink-0 space-y-3 self-start md:w-64 max-md:self-stretch">
          <div className="space-y-1">
            <div className="text-[0.6875rem] font-semibold text-muted">{t('guides.owner.public')}</div>
            <ListButton
              active={selected === INSTALL_GUIDE && !editing}
              onClick={() => select(INSTALL_GUIDE)}
              testId="owner-guides-item-install"
            >
              <Icon name="book" size={14} />
              <span className="truncate">{t('guides.install.title')}</span>
            </ListButton>
          </div>
          <div className="space-y-1">
            <div className="text-[0.6875rem] font-semibold text-muted">{t('guides.owner.private')}</div>
            {guides.isPending ? <SkeletonRows rows={2} label={t('app.loading')} /> : null}
            {guides.isError ? <Notice tone="error">{errorMessage(guides.error)}</Notice> : null}
            {guides.data && !list.length ? (
              <p className="px-2 py-1 text-xs text-muted">{t('guides.owner.empty')}</p>
            ) : null}
            <ul className="space-y-1" data-testid="owner-guides-list">
              {list.map((g, i) => (
                <li key={g.id} className="group flex items-center gap-1">
                  <ListButton
                    active={selected === g.id && editing !== 'new'}
                    onClick={() => select(g.id)}
                    testId={`owner-guides-item-${g.id}`}
                  >
                    <Icon name="lock" size={13} />
                    <span className="truncate">{guideTitle(g, uiGuideLocale()) || t('guides.owner.untitled')}</span>
                  </ListButton>
                  <Reorder ids={list.map((x) => x.id)} id={g.id} first={i === 0} last={i === list.length - 1} />
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              variant="ghost"
              className="w-full"
              onClick={() => setEditing('new')}
              data-testid="owner-guides-new"
            >
              <Icon name="plus" size={14} />
              {t('guides.owner.new')}
            </Button>
          </div>
        </Card>
        <Card className="min-w-0 flex-1">
          {editing ? (
            <GuideEditor
              key={editing}
              guide={editing === 'new' ? null : current}
              locale={locale}
              onDone={(id) => {
                setEditing(null);
                if (id) setSelected(id);
              }}
            />
          ) : selected === INSTALL_GUIDE ? (
            <InstallGuideView
              locale={locale}
              section={section}
              testId="owner-install-guide"
              onLocale={(l, s) => {
                setLocale(l);
                setSection(s);
              }}
            />
          ) : current ? (
            <GuideView
              guide={current}
              locale={locale}
              onLocale={setLocale}
              onEdit={() => setEditing(current.id)}
              onDeleted={() => select(INSTALL_GUIDE)}
            />
          ) : guides.data ? (
            <EmptyState icon={<Icon name="book" size={28} />} title={t('guides.owner.gone')} />
          ) : (
            <SkeletonRows rows={6} label={t('app.loading')} />
          )}
        </Card>
      </div>
    </section>
  );
};

const ListButton = ({
  active,
  onClick,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'true' : undefined}
    data-testid={testId}
    className={cn(
      'flex w-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm',
      active ? 'bg-primary-soft font-bold text-primary' : 'hover:bg-surface-3',
    )}
  >
    {children}
  </button>
);

/** Up / down buttons beside a guide in the list. */
const Reorder = ({ ids, id, first, last }: { ids: string[]; id: string; first: boolean; last: boolean }) => {
  const qc = useQueryClient();
  const move = useMutation({
    mutationFn: (order: string[]) => api().put<{ data: OwnerGuide[] }>('/platform/guides/order', { ids: order }),
    onSuccess: (res) => qc.setQueryData(KEY, res.data),
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const btn = (by: -1 | 1, disabled: boolean, label: string) => (
    <button
      type="button"
      disabled={disabled || move.isPending}
      aria-label={label}
      data-tip={label}
      data-testid={`owner-guides-${by < 0 ? 'up' : 'down'}-${id}`}
      onClick={() => {
        const order = moveGuide(ids, id, by);
        if (order) move.mutate(order);
      }}
      className="grid size-6 place-items-center rounded-md text-muted hover:bg-surface-3 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent"
    >
      <Icon name="chevronDown" size={13} className={by < 0 ? 'rotate-180' : undefined} />
    </button>
  );
  return (
    <span className="flex shrink-0 opacity-60 group-hover:opacity-100 focus-within:opacity-100">
      {btn(-1, first, t('guides.owner.moveUp'))}
      {btn(1, last, t('guides.owner.moveDown'))}
    </span>
  );
};

const LangSwitch = ({
  value,
  onChange,
  testId,
}: {
  value: GuideLocale;
  onChange: (l: GuideLocale) => void;
  testId: string;
}) => (
  <Segmented
    label={t('guides.language')}
    value={value}
    onChange={onChange}
    testId={testId}
    options={[
      { value: 'he', label: LANGUAGE_NAMES.he, testId: `${testId}-he` },
      { value: 'en', label: LANGUAGE_NAMES.en, testId: `${testId}-en` },
    ]}
  />
);

/** One owner guide, rendered (the shared Markdown renderer) with the reader's contents list and search. */
const GuideView = ({
  guide,
  locale,
  onLocale,
  onEdit,
  onDeleted,
}: {
  guide: OwnerGuide;
  locale: GuideLocale;
  onLocale: (l: GuideLocale) => void;
  onEdit: () => void;
  onDeleted: () => void;
}) => {
  const qc = useQueryClient();
  const shown = guideShownLocale(guide, locale);
  const doc = useMemo(() => markdownToDocHtml(guide.body[shown]), [guide.body, shown]);
  const remove = useMutation({
    mutationFn: () => api().delete(`/platform/guides/${guide.id}`),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KEY });
      showToast({ message: t('guides.owner.deleted') });
      onDeleted();
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const onDelete = async () => {
    const ok = await confirmDialog({
      title: t('guides.owner.deleteTitle'),
      message: t('guides.owner.deleteBody', { title: guideTitle(guide, locale) }),
      confirmLabel: t('guides.owner.delete'),
      danger: true,
    });
    if (ok) remove.mutate();
  };
  return (
    <div className="space-y-4" data-testid="owner-guide-view" data-guide={guide.id}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="min-w-0 truncate font-display text-lg font-bold text-heading" dir="auto">
          {guideTitle(guide, shown) || t('guides.owner.untitled')}
        </h3>
        <Badge tone="violet">{t('guides.owner.privateBadge')}</Badge>
        <span className="flex-1" />
        <LangSwitch value={locale} onChange={onLocale} testId="owner-guide-lang" />
        <Button size="sm" variant="secondary" onClick={onEdit} data-testid="owner-guide-edit">
          <Icon name="edit" size={14} />
          {t('guides.owner.edit')}
        </Button>
        <Button
          size="sm"
          variant="danger-outline"
          busy={remove.isPending}
          onClick={() => void onDelete()}
          data-testid="owner-guide-delete"
        >
          {t('guides.owner.delete')}
        </Button>
      </div>
      {shown !== locale ? <Notice>{t('guides.owner.fallback')}</Notice> : null}
      {guide.body[shown].trim() ? (
        <DocReader
          html={doc.html}
          headings={doc.headings}
          testId="owner-guide"
          dir={shown === 'he' ? 'rtl' : 'ltr'}
          lang={shown}
        />
      ) : (
        <EmptyState icon={<Icon name="file" size={28} />} title={t('guides.owner.noBody')} />
      )}
    </div>
  );
};

/** Add or edit a guide: a title and a Markdown body per language (either may stay empty), with a preview. */
const GuideEditor = ({
  guide,
  locale,
  onDone,
}: {
  guide: OwnerGuide | null | undefined;
  locale: GuideLocale;
  onDone: (id?: string) => void;
}) => {
  const qc = useQueryClient();
  const [lang, setLang] = useState<GuideLocale>(locale);
  const [title, setTitle] = useState(guide?.title ?? { he: '', en: '' });
  const [body, setBody] = useState(guide?.body ?? { he: '', en: '' });
  const [preview, setPreview] = useState(false);
  const html = useMemo(() => (preview ? markdownToDocHtml(body[lang]).html : ''), [preview, body, lang]);
  const hasTitle = !!(title.he.trim() || title.en.trim());
  const save = useMutation({
    mutationFn: () =>
      guide
        ? api().patch<OwnerGuide>(`/platform/guides/${guide.id}`, { title, body })
        : api().post<OwnerGuide>('/platform/guides', { title, body }),
    onSuccess: async (g) => {
      await qc.invalidateQueries({ queryKey: KEY });
      showToast({ message: t(guide ? 'guides.owner.saved' : 'guides.owner.created') });
      onDone(g.id);
    },
  });
  const dir = lang === 'he' ? 'rtl' : 'ltr';
  return (
    <form
      className="space-y-3"
      data-testid="owner-guide-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (hasTitle) save.mutate();
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-base font-bold text-heading">
          {guide ? t('guides.owner.editTitle') : t('guides.owner.new')}
        </h3>
        <LangSwitch value={lang} onChange={setLang} testId="owner-guide-editor-lang" />
      </div>
      <Field label={t('guides.owner.titleField')} hint={t('guides.owner.titleHint')}>
        <Input
          value={title[lang]}
          dir={dir}
          maxLength={160}
          data-testid="owner-guide-title"
          onChange={(e) => setTitle({ ...title, [lang]: e.target.value })}
        />
      </Field>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-fg-2">{t('guides.owner.body')}</span>
        <Button
          size="sm"
          variant="ghost"
          type="button"
          onClick={() => setPreview((p) => !p)}
          data-testid="owner-guide-preview"
        >
          {preview ? t('guides.owner.write') : t('guides.owner.preview')}
        </Button>
      </div>
      {preview ? (
        <div
          dir={dir}
          className="dev-doc max-h-[560px] overflow-auto rounded-[var(--radius)] border border-line p-4"
          // The shared renderer escapes raw HTML and keeps only safe links.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <textarea
          value={body[lang]}
          dir={dir}
          rows={20}
          spellCheck={false}
          data-testid="owner-guide-body"
          onChange={(e) => setBody({ ...body, [lang]: e.target.value })}
          className="w-full rounded-[var(--radius)] border border-line bg-surface p-3 font-mono text-[0.8125rem] leading-relaxed outline-none focus:border-primary"
        />
      )}
      {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" busy={save.isPending} disabled={!hasTitle} data-testid="owner-guide-save">
          {t('guides.owner.save')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onDone()} data-testid="owner-guide-cancel">
          {t('guides.owner.cancel')}
        </Button>
        {!hasTitle ? <span className="text-xs text-muted">{t('guides.owner.needTitle')}</span> : null}
      </div>
    </form>
  );
};
