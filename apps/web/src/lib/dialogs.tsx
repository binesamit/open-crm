// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useSyncExternalStore, type FormEvent } from 'react';
import { t } from '@bines/shared';
import { Button, Dialog, Field, Input, RadioCard } from '@bines/ui';

/**
 * Promise-based confirm/prompt on the system Dialog — never window.confirm/prompt/alert (M1.1 #9).
 * `<DialogHost />` is mounted once at the app root; requests queue and show one at a time.
 */
type ConfirmRequest = {
  kind: 'confirm';
  title: string;
  message?: string;
  confirmLabel?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
};
type PromptRequest = {
  kind: 'prompt';
  title: string;
  label: string;
  initial?: string;
  type?: 'text' | 'email';
  confirmLabel?: string;
  resolve: (value: string | null) => void;
};
/** A confirmation with a choice between a few options (cards with an explanation); the first is the default. */
type ChoiceRequest = {
  kind: 'choice';
  title: string;
  message?: string;
  options: { value: string; label: string; hint?: string; testId?: string }[];
  confirmLabel?: string;
  danger?: boolean;
  resolve: (value: string | null) => void;
};
type Request = (ConfirmRequest | PromptRequest | ChoiceRequest) & { id: number };

let queue: Request[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const push = (r: ConfirmRequest | PromptRequest | ChoiceRequest) => {
  queue = [...queue, { ...r, id: ++nextId }];
  emit();
};
const shift = () => {
  queue = queue.slice(1);
  emit();
};

export const confirmDialog = (opts: Omit<ConfirmRequest, 'kind' | 'resolve'>): Promise<boolean> =>
  new Promise((resolve) => push({ ...opts, kind: 'confirm', resolve }));

/** Resolves with the trimmed value, or null when cancelled. */
export const promptDialog = (opts: Omit<PromptRequest, 'kind' | 'resolve'>): Promise<string | null> =>
  new Promise((resolve) => push({ ...opts, kind: 'prompt', resolve }));

/** Resolves with the chosen option's value, or null when cancelled. */
export const choiceDialog = (opts: Omit<ChoiceRequest, 'kind' | 'resolve'>): Promise<string | null> =>
  new Promise((resolve) => push({ ...opts, kind: 'choice', resolve }));

/** The shared "delete → trash" confirmation. */
export const confirmDelete = (what: string) =>
  confirmDialog({ title: t('dialog.delete.title', { what }), message: t('board.confirmDelete'), danger: true });

const PromptBody = ({ req, done }: { req: PromptRequest; done: (v: string | null) => void }) => {
  const [value, setValue] = useState(req.initial ?? '');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (value.trim()) done(value.trim());
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <Field label={req.label}>
        <Input
          autoFocus
          type={req.type ?? 'text'}
          dir={req.type === 'email' ? 'ltr' : undefined}
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </Field>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => done(null)}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" disabled={!value.trim()}>
          {req.confirmLabel ?? t('common.ok')}
        </Button>
      </div>
    </form>
  );
};

const ChoiceBody = ({ req, done }: { req: ChoiceRequest & { id: number }; done: (v: string | null) => void }) => {
  const [value, setValue] = useState(req.options[0]?.value ?? '');
  return (
    <Dialog
      open
      role="alertdialog"
      title={req.title}
      onClose={() => done(null)}
      footer={
        <>
          <Button variant="secondary" onClick={() => done(null)}>
            {t('common.cancel')}
          </Button>
          <Button
            autoFocus
            variant={req.danger ? 'danger' : 'primary'}
            onClick={() => done(value)}
            data-testid="choice-dialog-confirm"
          >
            {req.confirmLabel ?? (req.danger ? t('common.delete') : t('common.ok'))}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="choice-dialog">
        {req.message ? <p className="text-sm text-muted">{req.message}</p> : null}
        <div className="space-y-2">
          {req.options.map((o) => (
            <RadioCard
              key={o.value}
              name={`choice-${req.id}`}
              checked={value === o.value}
              onSelect={() => setValue(o.value)}
              title={o.label}
              hint={o.hint}
              testId={o.testId}
            />
          ))}
        </div>
      </div>
    </Dialog>
  );
};

export const DialogHost = () => {
  const req = useSyncExternalStore(subscribe, () => queue[0]);
  if (!req) return null;
  const done = (v: boolean | string | null) => {
    shift();
    (req.resolve as (v: boolean | string | null) => void)(v);
  };
  if (req.kind === 'choice') return <ChoiceBody key={req.id} req={req} done={done} />;
  if (req.kind === 'prompt') {
    return (
      <Dialog key={req.id} open title={req.title} onClose={() => done(null)}>
        <PromptBody req={req} done={done} />
      </Dialog>
    );
  }
  return (
    <Dialog
      key={req.id}
      open
      role="alertdialog"
      title={req.title}
      onClose={() => done(false)}
      footer={
        <>
          <Button variant="secondary" onClick={() => done(false)}>
            {t('common.cancel')}
          </Button>
          <Button autoFocus variant={req.danger ? 'danger' : 'primary'} onClick={() => done(true)}>
            {req.confirmLabel ?? (req.danger ? t('common.delete') : t('common.ok'))}
          </Button>
        </>
      }
    >
      {req.message ? <p className="text-sm text-muted">{req.message}</p> : null}
    </Dialog>
  );
};
