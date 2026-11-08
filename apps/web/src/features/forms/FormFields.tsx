// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import {
  t,
  type FormAnswer,
  type FormFileLimits,
  type Locale,
  type MessageKey,
  type PublicQuestion,
} from '@bines/shared';
import { Calendar, cn, formatIsoDate, Input } from '@bines/ui';
import { Popover } from '../board/cells/Popover';
import { Icon } from '../../lib/icons';
import { fill } from '../../lib/label-color';
import { formatSize } from '../../lib/upload';

/** A text of the form page in the form's language (not the visitor's UI language). */
export const ft = (lang: Locale, key: string, vars?: Record<string, string | number>) =>
  t(`forms.${key}` as MessageKey, vars, lang);

const FIELD =
  'w-full rounded-[12px] border border-line-strong bg-surface px-3 text-[0.9375rem] text-fg placeholder:text-muted focus:border-primary focus:outline-none focus:ring-3 focus:ring-[var(--accent-soft)]';

/** An uploaded file of a file question: the id the server gave, and what to show. */
export type UploadedFormFile = { id: string; name: string; size: number };

type Props = {
  question: PublicQuestion;
  value: FormAnswer | undefined;
  onChange: (v: FormAnswer) => void;
  lang: Locale;
  invalid?: boolean;
  /** File questions: uploads one file and returns its id (the public page; the editor never asks for files). */
  upload?: (file: File) => Promise<string>;
  files?: UploadedFormFile[];
  onFiles?: (files: UploadedFormFile[]) => void;
};

/** The input of one question, by its kind (text, choice, date …) — our own controls, never a native picker. */
export const FormFieldInput = (p: Props) => {
  const { question: q, value, onChange, lang, invalid } = p;
  const id = `q-${q.id}`;
  const aria = { 'aria-invalid': invalid || undefined, 'aria-describedby': q.help ? `${id}-help` : undefined };
  const str = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  switch (q.input) {
    case 'long_text':
      return (
        <textarea
          id={id}
          {...aria}
          rows={4}
          value={str}
          maxLength={20000}
          onChange={(e) => onChange(e.target.value)}
          className={cn(FIELD, 'min-h-28 py-2.5', invalid && 'border-danger')}
          data-testid={`form-input-${q.id}`}
        />
      );
    case 'text':
    case 'location':
    case 'email':
    case 'phone':
    case 'link':
    case 'number':
      return (
        <Input
          id={id}
          {...aria}
          value={str}
          onChange={(e) => onChange(e.target.value)}
          type={q.input === 'email' ? 'email' : q.input === 'phone' ? 'tel' : q.input === 'link' ? 'url' : 'text'}
          inputMode={q.input === 'number' ? 'decimal' : undefined}
          dir={
            q.input === 'email' || q.input === 'link' || q.input === 'phone' || q.input === 'number' ? 'ltr' : undefined
          }
          autoComplete={q.input === 'email' ? 'email' : q.input === 'phone' ? 'tel' : 'off'}
          maxLength={q.input === 'text' ? 2000 : 500}
          placeholder={q.input === 'link' ? 'https://' : undefined}
          className={cn('h-11 text-[0.9375rem]', invalid && 'border-danger')}
          data-testid={`form-input-${q.id}`}
        />
      );
    case 'choice':
      return (
        <div role="radiogroup" aria-labelledby={`${id}-label`} className="flex flex-wrap gap-2">
          {(q.choices ?? []).map((c) => {
            const on = String(value) === String(c.value) && value !== undefined && value !== null;
            return (
              <button
                key={String(c.value)}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange(on ? null : c.value)}
                data-testid={`form-choice-${q.id}-${c.value}`}
                className={cn(
                  'press inline-flex min-h-10 items-center gap-2 rounded-full border px-3.5 text-sm',
                  on
                    ? 'border-primary bg-primary font-semibold text-on-primary'
                    : 'border-line-strong bg-surface text-fg',
                )}
              >
                {c.color ? <span className="size-2.5 shrink-0 rounded-full" style={fill(c.color)} aria-hidden /> : null}
                {c.label}
              </button>
            );
          })}
        </div>
      );
    case 'multi_choice':
    case 'people': {
      const picked = new Set((Array.isArray(value) ? value : []).map(String));
      const toggle = (v: string | number) => {
        const next = picked.has(String(v))
          ? (Array.isArray(value) ? value : []).filter((x) => String(x) !== String(v))
          : [...(Array.isArray(value) ? value : []), v];
        onChange(next);
      };
      return <ChipList q={q} picked={picked} onToggle={toggle} lang={lang} />;
    }
    case 'secret':
      return <SecretField q={q} value={value} onChange={onChange} lang={lang} invalid={invalid} aria={aria} />;
    case 'checkbox':
      return (
        <button
          type="button"
          role="checkbox"
          aria-checked={value === true}
          aria-labelledby={`${id}-label`}
          onClick={() => onChange(value === true ? false : true)}
          data-testid={`form-input-${q.id}`}
          className={cn(
            'press grid size-7 place-items-center rounded-[8px] border-2',
            value === true ? 'border-primary bg-primary text-on-primary' : 'border-line-strong bg-surface',
          )}
        >
          {value === true ? <Icon name="check" size={16} strokeWidth={2.5} /> : null}
        </button>
      );
    case 'rating': {
      const n = typeof value === 'number' ? value : Number(value) || 0;
      return (
        <div role="radiogroup" aria-labelledby={`${id}-label`} className="flex gap-1" dir="ltr">
          {Array.from({ length: q.rating_max ?? 5 }, (_, i) => i + 1).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={n === s}
              aria-label={String(s)}
              onClick={() => onChange(n === s ? null : s)}
              data-testid={`form-rating-${q.id}-${s}`}
              className={cn('press text-2xl leading-none', s <= n ? 'text-[var(--rating)]' : 'text-line-strong')}
            >
              ★
            </button>
          ))}
        </div>
      );
    }
    case 'date':
      return <DateField id={id} value={str} onChange={onChange} lang={lang} invalid={invalid} testId={q.id} />;
    case 'files':
      return <FilesField {...p} />;
    default:
      return null;
  }
};

const ChipList = ({
  q,
  picked,
  onToggle,
  lang,
}: {
  q: PublicQuestion;
  picked: Set<string>;
  onToggle: (v: string | number) => void;
  lang: Locale;
}) => {
  const [filter, setFilter] = useState('');
  const choices = q.choices ?? [];
  const needle = filter.trim().toLocaleLowerCase();
  const shown = needle ? choices.filter((c) => c.label.toLocaleLowerCase().includes(needle)) : choices;
  return (
    <div className="space-y-2">
      {choices.length > 12 ? (
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={ft(lang, 'search')}
          aria-label={ft(lang, 'search')}
          className="h-10"
        />
      ) : null}
      <div role="group" aria-labelledby={`q-${q.id}-label`} className="flex flex-wrap gap-2">
        {shown.map((c) => {
          const on = picked.has(String(c.value));
          return (
            <button
              key={String(c.value)}
              type="button"
              role="checkbox"
              aria-checked={on}
              onClick={() => onToggle(c.value)}
              data-testid={`form-choice-${q.id}-${c.value}`}
              className={cn(
                'press inline-flex min-h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm',
                on
                  ? 'border-primary bg-primary-soft font-semibold text-heading'
                  : 'border-line-strong bg-surface text-fg',
              )}
            >
              {on ? <Icon name="check" size={14} strokeWidth={2.5} /> : null}
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

/** Our calendar in a popover (no native date picker). The value is YYYY-MM-DD. */
export const DateField = ({
  id,
  value,
  onChange,
  lang,
  invalid,
  testId,
}: {
  id: string;
  value: string;
  onChange: (v: string | null) => void;
  lang: Locale;
  invalid?: boolean;
  testId: string;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex w-full max-w-xs items-center gap-2">
      <button
        id={id}
        type="button"
        aria-haspopup="dialog"
        aria-invalid={invalid || undefined}
        onClick={() => setOpen((o) => !o)}
        data-testid={`form-date-${testId}`}
        className={cn(
          FIELD,
          'flex h-11 items-center justify-between gap-2 text-start',
          !value && 'text-muted',
          invalid && 'border-danger',
        )}
      >
        <span>{value ? formatIsoDate(value) : ft(lang, 'pickDate')}</span>
        <Icon name="calendar" size={16} />
      </button>
      {value ? (
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-label={ft(lang, 'clear')}
          title={ft(lang, 'clear')}
          className="grid size-8 place-items-center rounded-full text-muted hover:bg-surface-2"
        >
          <Icon name="x" size={14} />
        </button>
      ) : null}
      <Popover open={open} onClose={() => setOpen(false)} className="p-3">
        <Calendar
          mode="single"
          value={value || null}
          onChange={(v) => {
            onChange(v);
            setOpen(false);
          }}
        />
      </Popover>
    </span>
  );
};

const kindsAccept: Record<string, string> = {
  image: 'image/*',
  pdf: 'application/pdf,.pdf',
  video: 'video/*',
  audio: 'audio/*',
  document: '.doc,.docx,.odt,.rtf,.txt,.md',
  spreadsheet: '.xls,.xlsx,.ods,.csv',
  presentation: '.ppt,.pptx,.odp,.key',
};

const FilesField = ({ question: q, lang, upload, files = [], onFiles, onChange, invalid }: Props) => {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const limits: FormFileLimits = q.files ?? { max_mb: 10, kinds: [], max_files: 5 };
  const accept =
    limits.kinds
      .map((k) => kindsAccept[k])
      .filter(Boolean)
      .join(',') || undefined;
  const setAll = (next: UploadedFormFile[]) => {
    onFiles?.(next);
    onChange(next.map((f) => f.id));
  };
  const pick = async (list: FileList | null) => {
    if (!list?.length || !upload) return;
    setError(null);
    const room = limits.max_files - files.length;
    const chosen = [...list].slice(0, Math.max(0, room));
    if (list.length > room) setError(ft(lang, 'error.tooManyFiles', { n: limits.max_files }));
    const tooBig = chosen.find((f) => f.size > limits.max_mb * 1024 * 1024);
    if (tooBig) return setError(ft(lang, 'error.fileTooLarge', { mb: limits.max_mb }));
    setBusy(true);
    const added: UploadedFormFile[] = [];
    try {
      for (const f of chosen) added.push({ id: await upload(f), name: f.name, size: f.size });
    } catch {
      setError(ft(lang, 'error.upload'));
    } finally {
      setBusy(false);
      if (added.length) setAll([...files, ...added]);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <div className="space-y-2">
      <input
        ref={input}
        type="file"
        multiple={limits.max_files > 1}
        accept={accept}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => void pick(e.target.files)}
        data-testid={`form-file-${q.id}`}
      />
      <button
        type="button"
        disabled={busy || files.length >= limits.max_files}
        onClick={() => input.current?.click()}
        aria-invalid={invalid || undefined}
        className={cn(
          'press flex min-h-14 w-full items-center justify-center gap-2 rounded-[12px] border border-dashed bg-surface-3 px-3 text-sm text-fg-2 disabled:opacity-50',
          invalid ? 'border-danger' : 'border-line-strong',
        )}
      >
        <Icon name="upload" size={16} />
        {busy ? ft(lang, 'uploading') : ft(lang, 'chooseFiles')}
      </button>
      <p className="text-xs text-muted">{ft(lang, 'fileLimits', { mb: limits.max_mb, n: limits.max_files })}</p>
      {files.length ? (
        <ul className="space-y-1">
          {files.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-[10px] bg-surface-2 px-3 py-2 text-sm">
              <Icon name="file" size={14} />
              <span className="min-w-0 flex-1 truncate">{f.name}</span>
              <span className="text-xs text-muted" dir="ltr">
                {formatSize(f.size)}
              </span>
              <button
                type="button"
                onClick={() => setAll(files.filter((x) => x.id !== f.id))}
                aria-label={ft(lang, 'remove')}
                title={ft(lang, 'remove')}
                className="grid size-7 place-items-center rounded-full text-muted hover:bg-surface"
              >
                <Icon name="x" size={13} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="text-xs text-danger-fg">{error}</p> : null}
    </div>
  );
};

/**
 * a secret question — hidden while typed (an eye shows it), never kept by the browser or a password
 * manager; a check box like any other. The answer goes encrypted onto the new item only.
 */
const SecretField = ({
  q,
  value,
  onChange,
  lang,
  invalid,
  aria,
}: {
  q: PublicQuestion;
  value: FormAnswer | undefined;
  onChange: (v: FormAnswer) => void;
  lang: Locale;
  invalid?: boolean;
  aria: Record<string, unknown>;
}) => {
  const [shown, setShown] = useState(false);
  const id = `q-${q.id}`;
  const str = typeof value === 'string' ? value : '';
  const noKeep = { autoComplete: 'off', spellCheck: false, 'data-1p-ignore': true, 'data-lpignore': 'true' } as const;
  const note = (
    <p className="mt-1.5 flex items-center gap-1 text-xs text-muted" data-testid={`form-secret-note-${q.id}`}>
      <Icon name="lock" size={12} />
      {ft(lang, 'secret.note')}
    </p>
  );
  if (q.secret === 'checkbox')
    return (
      <div>
        <button
          type="button"
          role="checkbox"
          aria-checked={value === true}
          aria-labelledby={`${id}-label`}
          onClick={() => onChange(value === true ? false : true)}
          data-testid={`form-input-${q.id}`}
          className={cn(
            'press grid size-7 place-items-center rounded-[8px] border-2',
            value === true ? 'border-primary bg-primary text-on-primary' : 'border-line-strong bg-surface',
          )}
        >
          {value === true ? <Icon name="check" size={16} strokeWidth={2.5} /> : null}
        </button>
        {note}
      </div>
    );
  if (q.secret === 'multiline')
    return (
      <div>
        <textarea
          id={id}
          {...aria}
          {...noKeep}
          rows={4}
          dir="ltr"
          value={str}
          maxLength={10000}
          onChange={(e) => onChange(e.target.value)}
          className={cn(FIELD, 'min-h-28 py-2.5 font-mono', !shown && 'secret-mask', invalid && 'border-danger')}
          data-testid={`form-input-${q.id}`}
        />
        <button
          type="button"
          className="mt-1 text-xs font-semibold text-primary"
          onClick={() => setShown((v) => !v)}
          data-testid={`form-secret-toggle-${q.id}`}
        >
          {shown ? ft(lang, 'secret.hide') : ft(lang, 'secret.show')}
        </button>
        {note}
      </div>
    );
  return (
    <div>
      <span className="relative flex items-center">
        <Input
          id={id}
          {...aria}
          {...noKeep}
          // A password field hides what is typed everywhere; "new-password" keeps browsers from filling a saved one in.
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          value={str}
          dir="ltr"
          maxLength={10000}
          onChange={(e) => onChange(e.target.value)}
          className={cn('h-11 pe-10 font-mono text-[0.9375rem]', invalid && 'border-danger')}
          data-testid={`form-input-${q.id}`}
        />
        <button
          type="button"
          aria-label={shown ? ft(lang, 'secret.hide') : ft(lang, 'secret.show')}
          className="absolute end-2 grid size-7 place-items-center rounded text-muted hover:text-fg"
          onClick={() => setShown((v) => !v)}
          data-testid={`form-secret-toggle-${q.id}`}
        >
          <Icon name={shown ? 'eyeOff' : 'eye'} size={16} />
        </button>
      </span>
      {note}
    </div>
  );
};
