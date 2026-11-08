// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CHECKLIST_EVENTS,
  HELP_LOCALES,
  HELP_ROUTE_KEYS,
  type HelpConsoleConfig,
  type HelpLocale,
  type HelpRouteKey,
  helpAssetPath,
  t,
  tDynamic,
  type Tour,
  TOUR_AUDIENCES,
  TOUR_STARTS,
  type TourAudience,
  type TourStart,
  type TourStep,
} from '@bines/shared';
import {
  Badge,
  Button,
  Card,
  cn,
  Dialog,
  EmptyState,
  Field,
  Input,
  Notice,
  Picker,
  Segmented,
  SkeletonRows,
  Switch,
} from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { confirmDialog } from '../../../lib/dialogs';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { anchorLabel } from '../../tours/TourAuthorBar';
import { PICKED_KEY, setAuthorMode } from '../../tours/tour-store';
import { tourKeys } from '../../tours/tours-api';
import { uploadHelpImage } from './help-console-api';

export const useConsoleTours = () =>
  useQuery({
    queryKey: tourKeys.console,
    queryFn: () => api().get<{ data: Tour[] }>('/platform/support/help/tours'),
  });

const routeLabel = (r: string) => tDynamic(`tour.route.${r}`);
const newStepId = () => `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * Owner console → Support → Knowledge → Tours (canvas א4): the guided tours — content, never code.
 * A tour names its screen, who it is for, its language and how it starts; each step a title, a sentence, an optional
 * clip and the element it points at, picked on the app's own screen ("pick on the screen" opens the app in another
 * tab: a click on an outlined element sets it). "Preview in the app" runs it there as it is, a draft too. Writing is
 * for the knowledge center's writers; publishing for its publishers (the same roles as articles).
 */
export const ToursTab = ({
  config,
  importDialog,
}: {
  config: HelpConsoleConfig;
  importDialog?: (close: () => void) => ReactNode;
}) => {
  const list = useConsoleTours();
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const rows = list.data?.data ?? [];
  return (
    <div className="flex items-start gap-4 max-lg:flex-col" data-testid="tours-console">
      <aside
        aria-label={t('tour.console.tab')}
        className="w-[280px] shrink-0 space-y-1.5 rounded-[12px] border border-line bg-surface p-3 max-lg:w-full"
      >
        <div className="mb-1.5 flex gap-2">
          {config.may_write ? (
            <Button
              size="sm"
              variant="primary"
              className="flex-1 font-normal"
              onClick={() => setCreating(true)}
              data-testid="tour-new"
            >
              {t('tour.console.new')}
            </Button>
          ) : null}
          {config.may_write && importDialog ? (
            <Button size="sm" variant="secondary" className="font-normal" onClick={() => setImporting(true)}>
              {t('help.import.button')}
            </Button>
          ) : null}
        </div>
        {list.isPending ? (
          <SkeletonRows rows={5} label={t('app.loading')} />
        ) : rows.length ? (
          <ul className="space-y-1">
            {rows.map((x) => (
              <li key={x.id}>
                <button
                  type="button"
                  onClick={() => setSelected(x.id)}
                  data-testid="tour-row"
                  data-title={x.title}
                  data-status={x.status}
                  className={cn(
                    'flex w-full flex-col gap-0.5 rounded-[9px] px-2.5 py-2 text-start hover:bg-surface-2',
                    selected === x.id && 'bg-[var(--primary-soft)] hover:bg-[var(--primary-soft)]',
                  )}
                >
                  <span className="text-sm text-fg" dir="auto">
                    {x.title}
                  </span>
                  <span className="text-xs text-muted">
                    {t('tour.console.rowMeta', {
                      screen: routeLabel(x.route),
                      steps: x.steps.length,
                      audience: tDynamic(`tour.audience.${x.audience}`),
                    })}
                    {x.status === 'published' ? '' : ` · ${t('help.status.draft')}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={t('tour.console.empty')} testId="tours-console-empty" />
        )}
      </aside>
      <div className="min-w-0 flex-1 max-lg:w-full">
        {selected ? (
          <TourEditor key={selected} id={selected} config={config} onClose={() => setSelected(null)} />
        ) : (
          <Card className="text-sm text-muted">{t('tour.console.pick')}</Card>
        )}
      </div>
      {creating ? (
        <NewTourDialog
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setSelected(id);
          }}
        />
      ) : null}
      {importing && importDialog ? importDialog(() => setImporting(false)) : null}
    </div>
  );
};

const NewTourDialog = ({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) => {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [locale, setLocale] = useState<HelpLocale>('he');
  const [route, setRoute] = useState<HelpRouteKey>('home');
  const create = useMutation({
    mutationFn: () => api().post<Tour>('/platform/support/help/tours', { title: title.trim(), locale, route }),
    onSuccess: async (tour) => {
      await qc.invalidateQueries({ queryKey: tourKeys.console });
      onCreated(tour.id);
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('tour.console.new')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="accent"
            busy={create.isPending}
            disabled={!title.trim()}
            onClick={() => create.mutate()}
            data-testid="tour-create"
          >
            {t('tour.console.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('tour.field.title')}>
          <Input
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
            data-testid="tour-new-title"
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('tour.field.route')}>
            <Picker
              label={t('tour.field.route')}
              value={route}
              onChange={(v) => setRoute(v as HelpRouteKey)}
              options={HELP_ROUTE_KEYS.map((r) => ({ value: r, label: routeLabel(r) }))}
            />
          </Field>
          <Field label={t('help.field.locale')}>
            <Picker
              label={t('help.field.locale')}
              value={locale}
              onChange={(v) => setLocale(v as HelpLocale)}
              options={HELP_LOCALES.map((l) => ({ value: l, label: tDynamic(`help.locale.${l}`) }))}
            />
          </Field>
        </div>
      </div>
    </Dialog>
  );
};

const TourEditor = ({ id, config, onClose }: { id: string; config: HelpConsoleConfig; onClose: () => void }) => {
  const qc = useQueryClient();
  const tour = useQuery({
    queryKey: tourKeys.consoleOne(id),
    queryFn: () => api().get<Tour>(`/platform/support/help/tours/${encodeURIComponent(id)}`),
  });
  // The app's tab picked an element for a step: load the tour again (its form starts over from what is stored).
  useEffect(() => {
    const on = (e: StorageEvent) => {
      if (e.key !== PICKED_KEY || !e.newValue) return;
      try {
        const picked = JSON.parse(e.newValue) as { tourId?: string; anchor?: string };
        if (picked.tourId !== id) return;
        void qc.invalidateQueries({ queryKey: tourKeys.consoleOne(id) });
        void qc.invalidateQueries({ queryKey: tourKeys.console });
        showToast({ message: t('tour.author.picked', { name: anchorLabel(picked.anchor ?? '') }) });
      } catch {
        // not ours
      }
    };
    window.addEventListener('storage', on);
    return () => window.removeEventListener('storage', on);
  }, [id, qc]);
  if (tour.isPending) return <SkeletonRows rows={6} label={t('app.loading')} />;
  if (tour.isError) return <Notice tone="error">{errorMessage(tour.error)}</Notice>;
  return <TourForm key={tour.data.updated_at} tour={tour.data} config={config} onClose={onClose} />;
};

const TourForm = ({ tour, config, onClose }: { tour: Tour; config: HelpConsoleConfig; onClose: () => void }) => {
  const qc = useQueryClient();
  const readOnly = !config.may_write || (tour.status === 'published' && !config.may_publish);
  const [title, setTitle] = useState(tour.title);
  const [route, setRoute] = useState<HelpRouteKey>(tour.route);
  const [audience, setAudience] = useState<TourAudience>(tour.audience);
  const [start, setStart] = useState<TourStart>(tour.start);
  const [steps, setSteps] = useState<TourStep[]>(tour.steps);
  const [initial] = useState(() =>
    JSON.stringify({
      title: tour.title,
      route: tour.route,
      audience: tour.audience,
      start: tour.start,
      steps: tour.steps,
    }),
  );
  const dirty = JSON.stringify({ title, route, audience, start, steps }) !== initial;
  const fail = (e: unknown) => showToast({ message: errorMessage(e), tone: 'error' });
  const done = async (next: Tour, message?: string) => {
    qc.setQueryData(tourKeys.consoleOne(next.id), next);
    await qc.invalidateQueries({ queryKey: tourKeys.console });
    if (message) showToast({ message });
  };
  const save = useMutation({
    mutationFn: (extra: { status?: 'draft' | 'published' } = {}) =>
      api().patch<Tour>(`/platform/support/help/tours/${tour.id}`, {
        title: title.trim(),
        route,
        audience,
        start,
        // A step needs its title: an empty one is left out.
        steps: steps.filter((s) => s.title.trim()),
        ...extra,
      }),
    onError: fail,
  });
  const saveNow = async (extra: { status?: 'draft' | 'published' } = {}, message?: string) => {
    const next = await save.mutateAsync(extra);
    await done(next, message);
    return next;
  };
  /** Opens the app in another tab, after saving what is on screen (the other tab reads the stored tour). */
  const openApp = async (mode: 'pick' | 'preview', stepId?: string) => {
    try {
      if (dirty) await saveNow();
      const step = steps.find((s) => s.id === stepId);
      setAuthorMode({ mode, tourId: tour.id, stepId, title: mode === 'pick' ? step?.title : title });
      window.open('/', '_blank', 'noopener');
    } catch {
      // the toast said why
    }
  };
  const remove = async () => {
    if (
      !(await confirmDialog({
        title: t('tour.console.delete'),
        message: t('tour.console.deleteConfirm'),
        confirmLabel: t('tour.console.delete'),
      }))
    )
      return;
    try {
      await api().delete(`/platform/support/help/tours/${tour.id}`);
      await qc.invalidateQueries({ queryKey: tourKeys.console });
      onClose();
    } catch (e) {
      fail(e);
    }
  };
  const setStep = (i: number, patch: Partial<TourStep>) =>
    setSteps((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const move = (i: number, d: -1 | 1) =>
    setSteps((all) => {
      const next = [...all];
      const [m] = next.splice(i, 1);
      next.splice(i + d, 0, m!);
      return next;
    });

  return (
    <Card className="space-y-4" data-testid="tour-editor" data-id={tour.id}>
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="min-w-0 flex-1 truncate font-display text-[1.375rem] font-extrabold text-heading" dir="auto">
          {title || tour.title}
        </h2>
        <Badge tone={tour.status === 'published' ? 'ok' : 'neutral'}>{t(`help.status.${tour.status}`)}</Badge>
        <Badge>{tDynamic(`help.locale.${tour.locale}`)}</Badge>
        <Button
          size="sm"
          variant="secondary"
          className="font-normal"
          onClick={() => void openApp('preview')}
          data-testid="tour-preview"
        >
          {t('tour.console.preview')}
        </Button>
        {readOnly ? null : (
          <Button
            size="sm"
            variant="accent"
            className="font-normal"
            busy={save.isPending}
            onClick={() => void saveNow({}, t('help.saved'))}
            data-testid="tour-save"
          >
            {t('tour.console.save')}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="x" size={14} />
        </Button>
      </div>

      <Field label={t('tour.field.title')}>
        <Input
          value={title}
          maxLength={120}
          disabled={readOnly}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="tour-title"
        />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('tour.field.route')}>
          <Picker
            label={t('tour.field.route')}
            value={route}
            onChange={(v) => setRoute(v as HelpRouteKey)}
            testId="tour-route"
            options={HELP_ROUTE_KEYS.map((r) => ({ value: r, label: routeLabel(r) }))}
          />
        </Field>
        <Field label={t('tour.field.audience')}>
          <Picker
            label={t('tour.field.audience')}
            value={audience}
            onChange={(v) => setAudience(v as TourAudience)}
            testId="tour-audience"
            options={TOUR_AUDIENCES.map((a) => ({ value: a, label: tDynamic(`tour.audience.${a}`) }))}
          />
        </Field>
      </div>
      <Field label={t('tour.field.start')}>
        <Segmented
          label={t('tour.field.start')}
          value={start}
          onChange={setStart}
          testId="tour-start"
          options={TOUR_STARTS.map((s) => ({
            value: s,
            label: tDynamic(`tour.start.${s}`),
            testId: `tour-start-${s}`,
          }))}
        />
      </Field>

      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="flex-1 font-display text-base font-extrabold text-heading">{t('tour.console.steps')}</h3>
        <span className="text-xs text-muted">{t('tour.console.stepsHint')}</span>
      </div>
      <ol className="space-y-2" data-testid="tour-steps">
        {steps.map((s, i) => (
          <TourStepRow
            key={s.id}
            n={i + 1}
            step={s}
            readOnly={readOnly}
            first={i === 0}
            last={i === steps.length - 1}
            onChange={(patch) => setStep(i, patch)}
            onMove={(d) => move(i, d)}
            onRemove={() => setSteps((all) => all.filter((_, j) => j !== i))}
            onPick={() => void openApp('pick', s.id)}
          />
        ))}
      </ol>
      {readOnly || steps.length >= 20 ? null : (
        <button
          type="button"
          onClick={() =>
            setSteps((all) => [
              ...all,
              {
                id: newStepId(),
                anchor: null,
                title: '',
                body: '',
                media_id: null,
                wait_click: false,
                wait_event: null,
              },
            ])
          }
          className="h-[38px] w-full rounded-[12px] border-[1.5px] border-dashed border-line-strong text-sm text-heading hover:bg-surface-2"
          data-testid="tour-add-step"
        >
          {t('tour.console.addStep')}
        </button>
      )}

      <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
        {config.may_write && (tour.status !== 'published' || config.may_publish) ? (
          <Button variant="ghost" onClick={() => void remove()} data-testid="tour-delete">
            <Icon name="trash" size={14} />
            {t('tour.console.delete')}
          </Button>
        ) : null}
        {config.may_publish && tour.status === 'published' ? (
          <Button
            variant="secondary"
            busy={save.isPending}
            onClick={() => void saveNow({ status: 'draft' }, t('help.unpublishedToast'))}
            data-testid="tour-unpublish"
          >
            {t('help.unpublish')}
          </Button>
        ) : null}
        {config.may_publish && tour.status !== 'published' ? (
          <Button
            variant="accent"
            busy={save.isPending}
            onClick={() => void saveNow({ status: 'published' }, t('help.publishedToast'))}
            data-testid="tour-publish"
          >
            <Icon name="send" size={14} />
            {t('help.publish')}
          </Button>
        ) : null}
      </div>
    </Card>
  );
};

const TourStepRow = ({
  n,
  step,
  readOnly,
  first,
  last,
  onChange,
  onMove,
  onRemove,
  onPick,
}: {
  n: number;
  step: TourStep;
  readOnly: boolean;
  first: boolean;
  last: boolean;
  onChange: (patch: Partial<TourStep>) => void;
  onMove: (d: -1 | 1) => void;
  onRemove: () => void;
  onPick: () => void;
}) => {
  const media = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      const a = await uploadHelpImage(file);
      onChange({ media_id: a.id });
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li
      className="flex items-start gap-3 rounded-[12px] border border-line p-3"
      data-testid="tour-step"
      data-anchor={step.anchor ?? undefined}
    >
      <span
        aria-hidden
        className="mt-1 grid size-[26px] shrink-0 place-items-center rounded-full bg-primary text-xs text-on-primary"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <Input
          value={step.title}
          maxLength={120}
          disabled={readOnly}
          placeholder={t('tour.field.stepTitle')}
          aria-label={t('tour.field.stepTitle')}
          onChange={(e) => onChange({ title: e.target.value })}
          data-testid="tour-step-title"
        />
        <textarea
          value={step.body}
          maxLength={600}
          rows={2}
          disabled={readOnly}
          placeholder={t('tour.field.stepBody')}
          aria-label={t('tour.field.stepBody')}
          onChange={(e) => onChange({ body: e.target.value })}
          className="w-full resize-y rounded-[9px] border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-fg focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
          dir="auto"
          data-testid="tour-step-body"
        />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-[6px] bg-surface-2 px-2 py-1 text-fg-2" data-testid="tour-step-anchor">
            {step.anchor ? t('tour.console.pointsAt', { name: anchorLabel(step.anchor) }) : t('tour.console.noAnchor')}
          </span>
          {step.anchor && !readOnly ? (
            <button
              type="button"
              className="text-muted underline-offset-2 hover:underline"
              onClick={() => onChange({ anchor: null })}
            >
              {t('tour.console.clearAnchor')}
            </button>
          ) : null}
          {step.media_id ? (
            <span className="inline-flex items-center gap-1.5 text-muted">
              <img
                src={helpAssetPath(step.media_id)}
                alt=""
                className="h-6 w-10 rounded-[4px] bg-surface-2 object-cover"
                onError={(e) => (e.currentTarget.style.display = 'none')}
              />
              {t('tour.console.media')}
              {readOnly ? null : (
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() => onChange({ media_id: null })}
                >
                  {t('guide.edit.remove')}
                </button>
              )}
            </span>
          ) : readOnly ? null : (
            <button
              type="button"
              className="text-link underline-offset-2 hover:underline"
              disabled={busy}
              onClick={() => media.current?.click()}
              data-testid="tour-step-media"
            >
              {busy ? t('help.image.uploading') : t('tour.console.addMedia')}
            </button>
          )}
          <input
            ref={media}
            type="file"
            hidden
            accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void upload(f);
            }}
          />
          <label className="ms-auto inline-flex items-center gap-1.5 text-fg-2">
            <Switch
              checked={step.wait_click}
              onChange={(v) => onChange({ wait_click: v })}
              disabled={readOnly || !step.anchor}
              testId="tour-step-wait"
            />
            {t('tour.field.waitClick')}
          </label>
          {/* go on by itself once the person really did it ("creates an item"). */}
          <div className="w-[200px]">
            <Picker
              label={t('tour.field.waitEvent')}
              value={step.wait_event ?? ''}
              placeholder={t('tour.field.waitEvent')}
              onChange={(v) => onChange({ wait_event: (v || null) as TourStep['wait_event'] })}
              testId="tour-step-wait-event"
              options={[
                { value: '', label: t('tour.field.waitEventNone') },
                ...CHECKLIST_EVENTS.filter((e) => e !== 'joined').map((e) => ({
                  value: e,
                  label: tDynamic(`checklist.event.${e}`),
                })),
              ]}
            />
          </div>
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5">
        {readOnly ? null : (
          <Button size="sm" variant="secondary" className="font-normal" onClick={onPick} data-testid="tour-step-pick">
            <Icon name="place" size={14} />
            {t('tour.console.pickOnScreen')}
          </Button>
        )}
        {readOnly ? null : (
          <div className="flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('guide.edit.moveUp')}
              disabled={first}
              onClick={() => onMove(-1)}
            >
              <Icon name="chevronStart" size={14} className="rotate-90" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('guide.edit.moveDown')}
              disabled={last}
              onClick={() => onMove(1)}
            >
              <Icon name="chevronDown" size={14} />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('tour.console.removeStep')}
              onClick={onRemove}
              data-testid="tour-step-remove"
            >
              <Icon name="trash" size={14} />
            </Button>
          </div>
        )}
      </div>
    </li>
  );
};
