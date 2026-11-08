// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { Link } from '@tanstack/react-router';
import { ApiError } from '@bines/sdk';
import { t } from '@bines/shared';
import { Button, Dialog } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { CodeInput } from '../account/TwoFactor';

type Ask = { kind: 'code' | 'no2fa'; change: boolean; resolve: (ok: boolean) => void };

/**
 * The two-factor step-up of secret updates, around any request: when the server answers
 * `secret_step_up_required`, a dialog asks for a fresh code (POST /secrets/verify) and the request is sent again;
 * `secret_two_factor_required` says how to turn 2FA on. `run` resolves to the answer, or `undefined` when the person
 * closed the dialog (nothing was done). Never a browser prompt.
 */
export const useSecretStepUp = (account: { id: string; slug: string }) => {
  const [ask, setAsk] = useState<Ask | null>(null);
  const askRef = useRef<Ask | null>(null);
  const open = (kind: Ask['kind'], change: boolean) =>
    new Promise<boolean>((resolve) => {
      const next = { kind, change, resolve };
      askRef.current = next;
      setAsk(next);
    });
  const done = (ok: boolean) => {
    askRef.current?.resolve(ok);
    askRef.current = null;
    setAsk(null);
  };

  /** `change`: the request edits / deletes (the dialog says so); a reveal otherwise. */
  const run = async <T,>(fn: () => Promise<T>, opts: { change?: boolean } = {}): Promise<T | undefined> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const code = err instanceof ApiError ? err.body.code : null;
        if (code === 'secret_step_up_required' && attempt < 2) {
          if (!(await open('code', !!opts.change))) return undefined;
          continue;
        }
        if (code === 'secret_two_factor_required') {
          await open('no2fa', !!opts.change);
          return undefined;
        }
        throw err;
      }
    }
  };

  const dialog = ask ? <StepUpDialog account={account} ask={ask} onDone={done} /> : null;
  return { run, dialog };
};

const StepUpDialog = ({
  account,
  ask,
  onDone,
}: {
  account: { id: string; slug: string };
  ask: Ask;
  onDone: (ok: boolean) => void;
}) => {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (code.length < 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(account.id).post('/secrets/verify', { code });
      onDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (ask.kind === 'no2fa')
    return (
      <Dialog
        open
        onClose={() => onDone(false)}
        title={t('secret.no2fa.title')}
        footer={
          <Button variant="secondary" onClick={() => onDone(false)} data-testid="secret-stepup-close">
            {t('common.close')}
          </Button>
        }
      >
        <div className="flex flex-col gap-2" data-testid="secret-stepup-no2fa">
          <p className="text-sm text-fg-2">{t('secretUpdates.no2fa.hint')}</p>
          <Link
            to="/a/$accountSlug/profile"
            params={{ accountSlug: account.slug }}
            search={{ tab: 'security' }}
            className="text-sm font-semibold text-primary hover:underline"
            onClick={() => onDone(false)}
          >
            {t('secret.no2fa.link')}
          </Link>
        </div>
      </Dialog>
    );

  return (
    <Dialog
      open
      onClose={() => onDone(false)}
      title={ask.change ? t('secretUpdates.stepUp.titleChange') : t('secretUpdates.stepUp.title')}
      footer={
        <>
          {/* type="button": Enter in the code field submits the form, never "cancel". */}
          <Button type="button" variant="secondary" onClick={() => onDone(false)} data-testid="secret-stepup-cancel">
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            busy={busy}
            disabled={code.length < 6}
            onClick={() => void submit()}
            data-testid="secret-stepup-submit"
          >
            {t('secretUpdates.stepUp.submit')}
          </Button>
        </>
      }
    >
      <form className="flex flex-col gap-2" onSubmit={(e) => void submit(e)} data-testid="secret-stepup-code">
        <p className="text-sm text-fg-2">{t('secret.code.hint')}</p>
        <CodeInput value={code} onChange={setCode} testId="secret-stepup-input" />
        {error ? (
          <p role="alert" className="text-xs text-danger-fg" data-testid="secret-stepup-error">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
};

// --- the same step-up from anywhere (a board's delete-with-code) ----

type GlobalAsk = { accountId: string; kind: Ask['kind']; change: boolean; resolve: (ok: boolean) => void };
let pending: GlobalAsk | null = null;
const hostListeners = new Set<() => void>();
const emitHost = () => hostListeners.forEach((l) => l());
const subscribeHost = (l: () => void) => {
  hostListeners.add(l);
  return () => hostListeners.delete(l);
};
const askGlobally = (accountId: string, kind: Ask['kind'], change: boolean) =>
  new Promise<boolean>((resolve) => {
    pending?.resolve(false);
    pending = { accountId, kind, change, resolve };
    emitHost();
  });

/** The person closed the code dialog: nothing was done (shown as "cancelled, no code"). */
export class StepUpCancelled extends Error {
  constructor() {
    super(t('secret.stepUp.cancelled'));
  }
}

/**
 * a request sent through `withStepUp`, as a mutation — a closed dialog rejects with `StepUpCancelled`
 * (the mutation's error handling shows it), so callers always get the server's answer or an error.
 */
export const stepUpRequest = async <T,>(accountId: string, fn: () => Promise<T>): Promise<T> => {
  const res = await withStepUp(accountId, async () => ({ value: await fn() }));
  if (!res) throw new StepUpCancelled();
  return res.value;
};

/**
 * `useSecretStepUp().run` without a component of its own: any request (a delete from a menu, the batch bar, the Delete
 * key) that the server answers with `secret_step_up_required` asks for the code in the app's one dialog
 * (`<StepUpHost />`) and is sent again. Resolves to the answer, or `undefined` when the person closed the dialog.
 */
export const withStepUp = async <T,>(
  accountId: string,
  fn: () => Promise<T>,
  opts: { change?: boolean } = { change: true },
): Promise<T | undefined> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = err instanceof ApiError ? err.body.code : null;
      if (code === 'secret_step_up_required' && attempt < 2) {
        if (!(await askGlobally(accountId, 'code', !!opts.change))) return undefined;
        continue;
      }
      if (code === 'secret_two_factor_required') {
        await askGlobally(accountId, 'no2fa', !!opts.change);
        return undefined;
      }
      throw err;
    }
  }
};

/** Mounted once at the app root, next to `<DialogHost />`. */
export const StepUpHost = () => {
  const ask = useSyncExternalStore(subscribeHost, () => pending);
  if (!ask) return null;
  // The account's address for "turn on 2FA" (the page the person is on).
  const slug = /^\/a\/([^/]+)/.exec(window.location.pathname)?.[1] ?? '';
  const done = (ok: boolean) => {
    ask.resolve(ok);
    pending = null;
    emitHost();
  };
  return (
    <StepUpDialog
      key={`${ask.kind}-${ask.change}`}
      account={{ id: ask.accountId, slug }}
      ask={{ kind: ask.kind, change: ask.change, resolve: () => {} }}
      onDone={done}
    />
  );
};
