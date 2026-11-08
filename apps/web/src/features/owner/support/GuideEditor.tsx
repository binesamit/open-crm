// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import {
  type HelpChapter,
  type HelpGuide,
  type HelpGuideStep,
  type HelpGuideVideo,
  helpAssetPath,
  helpVideoEmbedUrl,
  HELP_LOCALES,
  type HelpLocale,
  t,
  tDynamic,
} from '@bines/shared';
import { Button, cn, Field, Input } from '@bines/ui';
import { errorMessage } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { clock } from '../../support/GuideView';
import { imageFiles } from './help-editor';
import { uploadHelpImage } from './help-console-api';

export const EMPTY_GUIDE: HelpGuide = { video: null, steps: [] };
const EMPTY_VIDEO: HelpGuideVideo = {
  asset_id: null,
  url: null,
  poster_id: null,
  captions: [],
  chapters: [],
  duration: null,
};

/** `m:ss` / `h:mm:ss` / seconds → seconds (null when it is not a time). */
export const parseClock = (raw: string): number | null => {
  const s = raw.trim();
  if (/^\d{1,5}$/.test(s)) return Number(s);
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(s);
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

/** A video file's length in seconds, read by the browser (null when it cannot tell). */
const videoSeconds = (file: File) =>
  new Promise<number | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    el.preload = 'metadata';
    const done = (v: number | null) => {
      URL.revokeObjectURL(url);
      resolve(v);
    };
    el.onloadedmetadata = () => done(Number.isFinite(el.duration) ? Math.round(el.duration) : null);
    el.onerror = () => done(null);
    el.src = url;
  });

const VIDEO_ACCEPT = 'video/mp4,video/webm';
const isVideoFile = (f: File) => /^video\/(mp4|webm)$/i.test(f.type) || /\.(mp4|m4v|webm)$/i.test(f.name);

/**
 * The owner console's guide fields (canvas ב3): the video block — a file (MP4 / WebM, its length read
 * from it) or a YouTube / Vimeo address, a still, captions per language (WebVTT) and chapters — then the numbered
 * steps: a sentence and a screenshot each (pick, paste or drop it), a click on the screenshot puts the marker there.
 * Everything is saved with the article (a new version, published with it).
 */
export const GuideFields = ({
  guide,
  onChange,
  readOnly,
}: {
  guide: HelpGuide;
  onChange: (next: HelpGuide) => void;
  readOnly: boolean;
}) => {
  const [busy, setBusy] = useState<string | null>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const v = guide.video;
  const setVideo = (patch: Partial<HelpGuideVideo> | null) =>
    onChange({ ...guide, video: patch === null ? null : { ...(v ?? EMPTY_VIDEO), ...patch } });
  const setSteps = (steps: HelpGuideStep[]) => onChange({ ...guide, steps });

  const upload = async (key: string, file: File) => {
    setBusy(key);
    try {
      return await uploadHelpImage(file);
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
      return null;
    } finally {
      setBusy(null);
    }
  };
  const uploadVideo = async (file: File) => {
    if (!isVideoFile(file)) return showToast({ message: t('guide.edit.videoType'), tone: 'error' });
    const [asset, seconds] = await Promise.all([upload('video', file), videoSeconds(file)]);
    if (asset) setVideo({ asset_id: asset.id, url: null, duration: seconds ?? v?.duration ?? null });
  };
  const [urlDraft, setUrlDraft] = useState(v?.url ?? '');
  const urlOk = !urlDraft.trim() || !!helpVideoEmbedUrl(urlDraft.trim());

  return (
    <div className="space-y-4" data-testid="guide-editor">
      {/* ---- the video */}
      <section className="space-y-3 rounded-[12px] border border-line p-3.5" data-testid="guide-video-block">
        <div className="flex items-start gap-3.5 max-sm:flex-col">
          <div className="relative grid aspect-video w-[220px] shrink-0 place-items-center overflow-hidden rounded-[8px] bg-[var(--shell)] max-sm:w-full">
            {v?.poster_id ? (
              <img src={helpAssetPath(v.poster_id)} alt="" className="absolute inset-0 size-full object-cover" />
            ) : null}
            <span
              aria-hidden
              className="relative grid size-[34px] place-items-center rounded-full bg-[var(--accent)] text-[#13221f]"
            >
              <Icon name="play" size={13} />
            </span>
          </div>
          <div className="min-w-0 flex-1 space-y-2 text-[0.8125rem]">
            {v?.asset_id ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-sm text-fg" data-testid="guide-video-file">
                  {t('guide.edit.videoFile')}
                  {v.duration ? ` · ${clock(v.duration)}` : ''}
                </span>
                {readOnly ? null : (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="font-normal"
                      busy={busy === 'video'}
                      onClick={() => videoInput.current?.click()}
                    >
                      {t('guide.edit.replace')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="font-normal"
                      onClick={() => setVideo(null)}
                      data-testid="guide-video-remove"
                    >
                      {t('guide.edit.remove')}
                    </Button>
                  </>
                )}
              </div>
            ) : readOnly ? (
              <p className="text-muted">{v?.url ?? t('guide.edit.noVideo')}</p>
            ) : (
              <div className="space-y-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="font-normal"
                  busy={busy === 'video'}
                  onClick={() => videoInput.current?.click()}
                  data-testid="guide-video-upload"
                >
                  <Icon name="upload" size={14} />
                  {t('guide.edit.uploadVideo')}
                </Button>
                <Field
                  label={t('guide.edit.videoUrl')}
                  hint={urlOk ? t('guide.edit.videoUrlHint') : t('guide.edit.videoUrlBad')}
                >
                  <Input
                    value={urlDraft}
                    dir="ltr"
                    placeholder="https://www.youtube.com/watch?v=…"
                    onChange={(e) => setUrlDraft(e.target.value)}
                    onBlur={() => {
                      const url = urlDraft.trim();
                      if (!url)
                        return v?.url
                          ? setVideo(v.chapters.length || v.captions.length ? { url: null } : null)
                          : undefined;
                      if (helpVideoEmbedUrl(url)) setVideo({ url, asset_id: null });
                    }}
                    aria-invalid={!urlOk || undefined}
                    data-testid="guide-video-url"
                  />
                </Field>
              </div>
            )}
            <input
              ref={videoInput}
              type="file"
              hidden
              accept={VIDEO_ACCEPT}
              data-testid="guide-video-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void uploadVideo(f);
              }}
            />
            {v?.asset_id ? (
              <>
                <FileSlot
                  label={t('guide.edit.poster')}
                  value={v.poster_id}
                  accept="image/png,image/jpeg,image/webp"
                  busy={busy === 'poster'}
                  readOnly={readOnly}
                  testId="guide-poster"
                  onPick={async (f) => {
                    const a = await upload('poster', f);
                    if (a) setVideo({ poster_id: a.id });
                  }}
                  onClear={() => setVideo({ poster_id: null })}
                />
                {HELP_LOCALES.map((locale) => {
                  const cap = v.captions.find((c) => c.locale === locale);
                  return (
                    <FileSlot
                      key={locale}
                      label={t('guide.edit.captions', { language: tDynamic(`help.locale.${locale}`) })}
                      value={cap?.asset_id ?? null}
                      accept=".vtt,text/vtt"
                      busy={busy === `cap-${locale}`}
                      readOnly={readOnly}
                      testId={`guide-captions-${locale}`}
                      onPick={async (f) => {
                        const a = await upload(`cap-${locale}`, f);
                        if (a)
                          setVideo({
                            captions: [
                              ...v.captions.filter((c) => c.locale !== locale),
                              { locale: locale as HelpLocale, asset_id: a.id },
                            ],
                          });
                      }}
                      onClear={() => setVideo({ captions: v.captions.filter((c) => c.locale !== locale) })}
                    />
                  );
                })}
              </>
            ) : null}
          </div>
        </div>
        {v ? (
          <Chapters chapters={v.chapters} readOnly={readOnly} onChange={(chapters) => setVideo({ chapters })} />
        ) : null}
      </section>

      {/* ---- the steps */}
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="flex-1 font-display text-base font-extrabold text-heading">{t('guide.steps')}</h3>
        {readOnly ? null : <span className="text-xs text-muted">{t('guide.edit.stepsHint')}</span>}
      </div>
      <ol className="space-y-2.5" data-testid="guide-edit-steps">
        {guide.steps.map((s, i) => (
          <StepRow
            key={i}
            n={i + 1}
            step={s}
            readOnly={readOnly}
            first={i === 0}
            last={i === guide.steps.length - 1}
            onChange={(next) => setSteps(guide.steps.map((x, j) => (j === i ? next : x)))}
            onMove={(d) => {
              const next = [...guide.steps];
              const [moved] = next.splice(i, 1);
              next.splice(i + d, 0, moved!);
              setSteps(next);
            }}
            onRemove={() => setSteps(guide.steps.filter((_, j) => j !== i))}
          />
        ))}
      </ol>
      {readOnly || guide.steps.length >= 40 ? null : (
        <button
          type="button"
          onClick={() => setSteps([...guide.steps, { text: '', image_id: null, marker: null }])}
          className="h-[38px] w-full rounded-[12px] border-[1.5px] border-dashed border-line-strong text-sm text-heading hover:bg-surface-2"
          data-testid="guide-add-step"
        >
          {t('guide.edit.addStep')}
        </button>
      )}
    </div>
  );
};

/** A file of the guide (the still, a captions file): its name, "choose" and "remove". */
const FileSlot = ({
  label,
  value,
  accept,
  busy,
  readOnly,
  testId,
  onPick,
  onClear,
}: {
  label: string;
  value: string | null;
  accept: string;
  busy: boolean;
  readOnly: boolean;
  testId: string;
  onPick: (f: File) => void | Promise<void>;
  onClear: () => void;
}) => {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId} data-set={!!value || undefined}>
      <span className="min-w-0 flex-1 text-muted">
        {label}: {value ? t('guide.edit.fileSet') : t('guide.edit.fileNone')}
      </span>
      {readOnly ? null : (
        <>
          <Button size="sm" variant="ghost" className="font-normal" busy={busy} onClick={() => input.current?.click()}>
            {value ? t('guide.edit.replace') : t('guide.edit.choose')}
          </Button>
          {value ? (
            <Button size="sm" variant="ghost" className="font-normal" onClick={onClear}>
              {t('guide.edit.remove')}
            </Button>
          ) : null}
          <input
            ref={input}
            type="file"
            hidden
            accept={accept}
            data-testid={`${testId}-input`}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onPick(f);
            }}
          />
        </>
      )}
    </div>
  );
};

/** The video's chapters: a time (`m:ss`) and a title each, kept in time order. */
const Chapters = ({
  chapters,
  readOnly,
  onChange,
}: {
  chapters: HelpChapter[];
  readOnly: boolean;
  onChange: (next: HelpChapter[]) => void;
}) => {
  const [drafts, setDrafts] = useState(() => chapters.map((c) => ({ time: clock(c.at), title: c.title })));
  const commit = (rows: { time: string; title: string }[]) => {
    setDrafts(rows);
    onChange(
      rows
        .map((r) => ({ at: parseClock(r.time), title: r.title.trim() }))
        .filter((c): c is HelpChapter => c.at !== null && !!c.title)
        .sort((a, b) => a.at - b.at),
    );
  };
  return (
    <div className="space-y-2" data-testid="guide-chapters-edit">
      <span className="text-xs text-muted">{t('guide.chapters')}</span>
      {drafts.map((r, i) => (
        <div key={i} className="flex items-center gap-2" data-testid="guide-chapter-row">
          <Input
            value={r.time}
            dir="ltr"
            className={cn('w-20 text-center', parseClock(r.time) === null && 'border-[var(--danger)]')}
            aria-label={t('guide.edit.chapterTime')}
            disabled={readOnly}
            onChange={(e) => commit(drafts.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))}
          />
          <Input
            value={r.title}
            maxLength={120}
            className="min-w-0 flex-1"
            aria-label={t('guide.edit.chapterTitle')}
            disabled={readOnly}
            dir="auto"
            onChange={(e) => commit(drafts.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))}
          />
          {readOnly ? null : (
            <Button
              size="sm"
              variant="ghost"
              aria-label={t('guide.edit.remove')}
              onClick={() => commit(drafts.filter((_, j) => j !== i))}
            >
              <Icon name="x" size={14} />
            </Button>
          )}
        </div>
      ))}
      {readOnly || drafts.length >= 30 ? null : (
        <Button
          size="sm"
          variant="ghost"
          className="font-normal"
          onClick={() => setDrafts([...drafts, { time: '', title: '' }])}
          data-testid="guide-add-chapter"
        >
          <Icon name="plus" size={14} />
          {t('guide.edit.addChapter')}
        </Button>
      )}
    </div>
  );
};

/** One step: its sentence, its screenshot (pick / paste / drop) and the marker a click on the screenshot sets. */
const StepRow = ({
  n,
  step,
  readOnly,
  first,
  last,
  onChange,
  onMove,
  onRemove,
}: {
  n: number;
  step: HelpGuideStep;
  readOnly: boolean;
  first: boolean;
  last: boolean;
  onChange: (next: HelpGuideStep) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const shot = async (files: File[]) => {
    const [file] = imageFiles(files);
    if (!file) return showToast({ message: t('help.image.onlyImages'), tone: 'error' });
    setBusy(true);
    try {
      const a = await uploadHelpImage(file);
      onChange({ ...step, image_id: a.id, marker: null });
    } catch (e) {
      showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (!readOnly && imageFiles(files).length) {
      e.preventDefault();
      void shot(files);
    }
  };
  const onDrop = (e: DragEvent) => {
    if (readOnly) return;
    e.preventDefault();
    void shot(Array.from(e.dataTransfer.files));
  };
  return (
    <li
      className="flex items-start gap-3 rounded-[12px] border border-line p-3"
      data-testid="guide-edit-step"
      onPaste={onPaste}
      onDragOver={(e) => !readOnly && e.preventDefault()}
      onDrop={onDrop}
    >
      <span
        aria-hidden
        className="mt-1 grid size-[26px] shrink-0 place-items-center rounded-full bg-primary text-xs text-on-primary"
      >
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <textarea
          value={step.text}
          maxLength={1000}
          rows={2}
          disabled={readOnly}
          placeholder={t('guide.edit.stepText')}
          aria-label={t('guide.stepNumber', { n })}
          onChange={(e) => onChange({ ...step, text: e.target.value })}
          className="w-full resize-y rounded-[9px] border border-line-strong bg-surface px-2.5 py-1.5 text-sm text-fg focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
          dir="auto"
          data-testid="guide-step-text"
        />
        {readOnly ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="font-normal"
              busy={busy}
              onClick={() => input.current?.click()}
              data-testid="guide-step-shot"
            >
              <Icon name="image" size={14} />
              {step.image_id ? t('guide.edit.replaceShot') : t('guide.edit.addShot')}
            </Button>
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
              aria-label={t('guide.edit.removeStep')}
              onClick={onRemove}
              data-testid="guide-step-remove"
            >
              <Icon name="trash" size={14} />
            </Button>
            <input
              ref={input}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(e) => {
                const list = Array.from(e.target.files ?? []);
                e.target.value = '';
                if (list.length) void shot(list);
              }}
            />
          </div>
        )}
      </div>
      {step.image_id ? (
        <button
          type="button"
          disabled={readOnly}
          aria-label={t('guide.edit.placeMarker')}
          title={t('guide.edit.placeMarker')}
          data-testid="guide-step-image"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
            const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
            onChange({ ...step, marker: { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 } });
          }}
          className="relative w-[210px] shrink-0 cursor-crosshair overflow-hidden rounded-[8px] border border-line bg-surface-3 disabled:cursor-default max-sm:w-28"
        >
          <img src={helpAssetPath(step.image_id)} alt="" className="block h-auto w-full" draggable={false} />
          {step.marker ? (
            <span
              aria-hidden
              data-testid="guide-step-marker"
              className="absolute grid size-[22px] -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-[var(--accent)] text-[0.6875rem] text-[#13221f]"
              style={{ left: `${step.marker.x * 100}%`, top: `${step.marker.y * 100}%` }}
            >
              {n}
            </span>
          ) : null}
        </button>
      ) : null}
    </li>
  );
};
