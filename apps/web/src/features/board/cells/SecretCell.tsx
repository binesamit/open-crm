// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useEffect, useRef, useState, type FormEvent, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ApiError } from '@bines/sdk';
import {
  type EditedItem,
  SECRET_CHECKED,
  SECRET_UNCHECKED,
  secretSettingsOf,
  t,
  type SecretReveal,
} from '@bines/shared';
import { Button, cn, Input } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { showToast } from '../../../lib/toast';
import { CodeInput } from '../../account/TwoFactor';
import { BoardAccountContext } from '../board-context';
import type { CellProps } from './index';
import { Popover } from './Popover';

type Revealed = { value: string; left: number; copyAllowed: boolean };
type Panel = null | 'edit' | 'code' | 'no2fa';
/** What the code panel unlocks: the reveal, or a replace / clear that the column guards with the same code. */
type AfterCode = { kind: 'reveal' } | { kind: 'save'; value: string | null };

/**
 * Secret column: "••••" when a value exists, an eye to reveal it. The eye asks for a fresh 2FA code
 * when none counts any more (a panel, never a browser prompt), shows the value for the column's seconds with a
 * countdown and offers copy (the clipboard is emptied after the same time where the browser allows). People
 * without 2FA see that a value exists and how to turn 2FA on. Editors set / clear the value in a panel — through
 * the secret endpoint, never PUT /cells; the value never sits in the board's data. Replacing or clearing a value asks
 * for the same code when the column says so (the server decides: 403 secret_step_up_required → the code panel, then
 * the change is sent again); setting an empty cell never does.
 *
 * Prod ("typed 3 times", "entered the code twice"): every button in the panels that does not submit has
 * type="button" — a <button> without a type is a submit button, and Enter in a field "clicks" the form's FIRST
 * submit button: Cancel (the value / code was dropped) or, when replacing, Clear (the secret was deleted).
 */
export const SecretCell = ({ column, value, editable, accountId, itemId, boardId }: CellProps) => {
  const { slug } = useContext(BoardAccountContext);
  const qc = useQueryClient();
  const has = !!(value as { set?: boolean } | null)?.set;
  const [panel, setPanel] = useState<Panel>(null);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [afterCode, setAfterCode] = useState<AfterCode>({ kind: 'reveal' });
  const clearTimer = useRef<number | null>(null);
  const base = `/items/${itemId}/cells/${column.id}/secret`;
  const settings = secretSettingsOf(column.settings);
  // a column of long values — a text area to edit, the whole text when revealed.
  const multiline = settings.multiline && settings.kind !== 'checkbox';
  // a check box behind the same guard; with `checkbox_visible` its state shows without a code.
  const checkbox = settings.kind === 'checkbox';
  const shownChecked =
    checkbox && settings.checkbox_visible ? (value as { checked?: boolean } | null)?.checked === true : null;

  // The countdown: the value leaves the screen (and the component's state) when it ends.
  useEffect(() => {
    if (!revealed) return;
    const id = window.setTimeout(() => setRevealed((r) => (r && r.left > 1 ? { ...r, left: r.left - 1 } : null)), 1000);
    return () => window.clearTimeout(id);
  }, [revealed]);
  useEffect(
    () => () => {
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
    },
    [],
  );

  const close = () => {
    setPanel(null);
    setCode('');
    setDraft('');
    setError(null);
    setAfterCode({ kind: 'reveal' });
  };

  const doReveal = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api(accountId).post<SecretReveal>(`${base}/reveal`);
      setRevealed({ value: r.value, left: r.reveal_seconds, copyAllowed: r.copy_allowed });
      close();
    } catch (err) {
      const code = err instanceof ApiError ? err.body.code : null;
      if (code === 'secret_step_up_required' || code === 'secret_two_factor_required') {
        setAfterCode({ kind: 'reveal' });
        setPanel(code === 'secret_step_up_required' ? 'code' : 'no2fa');
      } else showToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length < 6 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(accountId).post('/secrets/verify', { code });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    setCode('');
    if (afterCode.kind === 'save') await save(afterCode.value);
    else await doReveal();
  };

  const copy = async () => {
    if (!revealed) return;
    try {
      await api(accountId).post(`${base}/copy`);
      await navigator.clipboard.writeText(revealed.value);
      showToast({ message: t('secret.copied', { n: revealed.left }), seconds: 3 });
      const seconds = revealed.left;
      if (clearTimer.current) window.clearTimeout(clearTimer.current);
      // Best effort: empty the clipboard when the reveal time is over (browsers may refuse when the tab is hidden).
      clearTimer.current = window.setTimeout(
        () => void navigator.clipboard?.writeText('').catch(() => {}),
        seconds * 1000,
      );
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };

  /** The saved item goes straight into the board's and the item card's caches (the dots show at once). */
  const putItem = (item: EditedItem | undefined) => {
    if (!item?.id) return;
    qc.setQueryData<{ data: EditedItem[] }>(['account', accountId, 'board', boardId, 'items'], (old) =>
      old?.data ? { ...old, data: old.data.map((i) => (i.id === item.id ? item : i)) } : old,
    );
    qc.setQueryData<EditedItem>(['account', accountId, 'item', itemId], (old) => (old ? item : old));
  };

  const save = async (next: string | null) => {
    setBusy(true);
    setError(null);
    try {
      putItem(await api(accountId).put<EditedItem>(base, { value: next }));
      setRevealed(null);
      close();
      void qc.invalidateQueries({ queryKey: ['account', accountId, 'board', boardId, 'items'] });
      void qc.invalidateQueries({ queryKey: ['account', accountId, 'item', itemId] });
    } catch (err) {
      const code = err instanceof ApiError ? err.body.code : null;
      // Replacing / clearing: the column asks for a fresh code (or 2FA first); the change waits for it.
      if (code === 'secret_step_up_required' || code === 'secret_two_factor_required') {
        setAfterCode({ kind: 'save', value: next });
        setCode('');
        setPanel(code === 'secret_step_up_required' ? 'code' : 'no2fa');
      } else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Prod ("the secret column doesn't let me enter a value"): the only way into the set-value panel was
  // the masked button, which is empty — 0 px tall — while the cell has no value, so an empty cell had nothing to
  // click (and Enter on the active cell clicked the cell's outer element, which did nothing). Now the whole cell
  // opens the panel for editors, like every other cell; the eye / copy / hide buttons keep their own clicks.
  const openEdit = () => {
    if (!editable || revealed || panel) return;
    setError(null);
    setPanel('edit');
  };
  // The cell's own buttons never also open the panel (the cell's click).
  const stop = (e: MouseEvent) => e.stopPropagation();

  return (
    <div
      className={cn(
        'group/secret relative flex h-full w-full items-center gap-1 px-2 text-sm',
        editable && !revealed && 'cursor-pointer hover:bg-surface-2',
      )}
      data-testid="secret-cell"
      data-editable={editable || undefined}
      onClick={openEdit}
    >
      {shownChecked !== null ? (
        // A check box shown without a code: click to flip it (the change may still ask for the code).
        <button
          type="button"
          disabled={!editable || busy}
          role="checkbox"
          aria-checked={shownChecked}
          aria-label={t('secret.checkbox.toggle')}
          className={cn(
            'flex flex-1 items-center justify-center self-stretch',
            editable ? 'cursor-pointer' : 'cursor-default',
          )}
          data-cell-edit={editable || undefined}
          data-testid="secret-checkbox"
          data-checked={shownChecked || undefined}
          onClick={(e) => {
            stop(e);
            if (editable) void save(shownChecked ? SECRET_UNCHECKED : SECRET_CHECKED);
          }}
        >
          <CheckBox checked={shownChecked} />
        </button>
      ) : revealed && checkbox ? (
        <>
          <button
            type="button"
            disabled={!editable || busy}
            role="checkbox"
            aria-checked={revealed.value === SECRET_CHECKED}
            aria-label={t('secret.checkbox.toggle')}
            className="flex flex-1 items-center self-stretch"
            data-testid="secret-value"
            data-checked={revealed.value === SECRET_CHECKED || undefined}
            onClick={(e) => {
              stop(e);
              if (editable) void save(revealed.value === SECRET_CHECKED ? SECRET_UNCHECKED : SECRET_CHECKED);
            }}
          >
            <CheckBox checked={revealed.value === SECRET_CHECKED} />
          </button>
          <span className="shrink-0 text-xs text-muted tabular-nums" data-testid="secret-countdown">
            {revealed.left}
          </span>
          <button
            type="button"
            className="grid size-6 shrink-0 place-items-center rounded hover:bg-surface-2"
            aria-label={t('secret.hide')}
            data-tip={t('secret.hide')}
            data-testid="secret-hide"
            onClick={(e) => {
              stop(e);
              setRevealed(null);
            }}
          >
            <Icon name="x" size={14} />
          </button>
        </>
      ) : revealed ? (
        <>
          <span className="min-w-0 flex-1 truncate font-mono" dir="ltr" data-testid="secret-value">
            {multiline ? revealed.value.split('\n')[0] : revealed.value}
          </span>
          <span className="shrink-0 text-xs text-muted tabular-nums" data-testid="secret-countdown">
            {revealed.left}
          </span>
          {revealed.copyAllowed ? (
            <button
              type="button"
              className="grid size-6 shrink-0 place-items-center rounded hover:bg-surface-2"
              aria-label={t('secret.copy')}
              data-tip={t('secret.copy')}
              data-testid="secret-copy"
              onClick={(e) => {
                stop(e);
                void copy();
              }}
            >
              <Icon name="copy" size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className="grid size-6 shrink-0 place-items-center rounded hover:bg-surface-2"
            aria-label={t('secret.hide')}
            data-tip={t('secret.hide')}
            data-testid="secret-hide"
            onClick={(e) => {
              stop(e);
              setRevealed(null);
            }}
          >
            <Icon name="x" size={14} />
          </button>
        </>
      ) : (
        <>
          {/* Fills the cell's height (an empty button is 0 px tall), so there is always something to click. */}
          <button
            type="button"
            disabled={!editable}
            data-cell-edit={editable || undefined}
            className={cn(
              'flex min-w-0 flex-1 items-center self-stretch truncate text-start',
              editable ? 'cursor-pointer' : 'cursor-default',
              has ? 'tracking-[0.2em] text-fg-2' : 'text-muted',
            )}
            aria-label={editable ? (has ? t('secret.edit.replace') : t('secret.edit.set')) : undefined}
            data-tip={editable ? (has ? t('secret.edit.replace') : t('secret.edit.set')) : undefined}
            data-testid="secret-masked"
            onClick={(e) => {
              stop(e);
              openEdit();
            }}
          >
            {has ? (
              '••••••'
            ) : editable ? (
              // Empty cell, editor: a faint key on hover / focus says "a value goes here".
              <span
                aria-hidden
                className="opacity-0 transition-opacity group-hover/secret:opacity-60 group-focus-within/secret:opacity-60"
                data-testid="secret-empty-hint"
              >
                <Icon name="key" size={14} />
              </span>
            ) : null}
          </button>
          {has ? (
            <button
              type="button"
              disabled={busy}
              className="grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-surface-2 hover:text-fg"
              aria-label={t('secret.reveal')}
              data-tip={t('secret.reveal')}
              data-testid="secret-reveal"
              onClick={(e) => {
                stop(e);
                void doReveal();
              }}
            >
              <Icon name="eye" size={14} />
            </button>
          ) : null}
        </>
      )}

      {multiline ? (
        <Popover open={!!revealed && panel === null} onClose={() => setRevealed(null)} className="w-96 p-3">
          <pre
            dir="ltr"
            className="max-h-72 overflow-auto font-mono text-sm break-words whitespace-pre-wrap"
            data-testid="secret-value-full"
          >
            {revealed?.value}
          </pre>
        </Popover>
      ) : null}
      <Popover open={panel !== null} onClose={close} className={cn('p-3', multiline ? 'w-96' : 'w-72')}>
        {panel === 'code' ? (
          <form className="flex flex-col gap-2" onSubmit={(e) => void submitCode(e)} data-testid="secret-code-panel">
            <p className="text-sm font-semibold">
              {afterCode.kind === 'save' ? t('secret.code.titleChange') : t('secret.code.title')}
            </p>
            <p className="text-xs text-muted">{t('secret.code.hint')}</p>
            <CodeInput value={code} onChange={setCode} testId="secret-code" />
            {error ? (
              <p role="alert" className="text-xs text-danger-fg" data-testid="secret-error">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={close} data-testid="secret-code-cancel">
                {t('common.cancel')}
              </Button>
              <Button size="sm" type="submit" busy={busy} disabled={code.length < 6} data-testid="secret-code-submit">
                {afterCode.kind === 'save' ? t('secret.code.submitChange') : t('secret.code.submit')}
              </Button>
            </div>
          </form>
        ) : panel === 'no2fa' ? (
          <div className="flex flex-col gap-2" data-testid="secret-no2fa-panel">
            <p className="text-sm font-semibold">{t('secret.no2fa.title')}</p>
            <p className="text-xs text-muted">
              {afterCode.kind === 'save' ? t('secret.no2fa.hintChange') : t('secret.no2fa.hint')}
            </p>
            <Link
              to="/a/$accountSlug/profile"
              params={{ accountSlug: slug }}
              search={{ tab: 'security' }}
              className="text-sm font-semibold text-primary hover:underline"
              data-testid="secret-enable-2fa"
              onClick={close}
            >
              {t('secret.no2fa.link')}
            </Link>
          </div>
        ) : panel === 'edit' ? (
          <form
            className="flex flex-col gap-2"
            data-testid="secret-edit-panel"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft) void save(draft);
            }}
          >
            <p className="text-sm font-semibold">{has ? t('secret.edit.replace') : t('secret.edit.set')}</p>
            {checkbox ? (
              // a check box is set by choosing, not typing.
              <div className="flex gap-2" data-testid="secret-checkbox-choice">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  busy={busy}
                  data-testid="secret-check"
                  onClick={() => void save(SECRET_CHECKED)}
                >
                  {t('secret.checkbox.checked')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  busy={busy}
                  data-testid="secret-uncheck"
                  onClick={() => void save(SECRET_UNCHECKED)}
                >
                  {t('secret.checkbox.unchecked')}
                </Button>
              </div>
            ) : multiline ? (
              // Enter is a new line here; Ctrl / ⌘ + Enter saves.
              <textarea
                autoFocus
                rows={6}
                value={draft}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                maxLength={10000}
                data-1p-ignore
                data-lpignore="true"
                className="w-full resize-y rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 font-mono text-sm text-fg focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
                data-testid="secret-input"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    if (draft) void save(draft);
                  }
                }}
              />
            ) : (
              <Input
                autoFocus
                value={draft}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                maxLength={10000}
                data-1p-ignore
                data-lpignore="true"
                className="font-mono"
                data-testid="secret-input"
                onChange={(e) => setDraft(e.target.value)}
              />
            )}
            {checkbox ? null : (
              <p className="text-xs text-muted">{multiline ? t('secret.edit.hintMultiline') : t('secret.edit.hint')}</p>
            )}
            {error ? (
              <p role="alert" className="text-xs text-danger-fg" data-testid="secret-error">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              {has ? (
                <Button
                  type="button"
                  variant="danger-outline"
                  size="sm"
                  busy={busy}
                  data-testid="secret-clear"
                  onClick={() => void save(null)}
                >
                  {t('secret.edit.clear')}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={close} data-testid="secret-cancel">
                  {t('common.cancel')}
                </Button>
                {checkbox ? null : (
                  <Button size="sm" type="submit" busy={busy} disabled={!draft} data-testid="secret-save">
                    {t('common.save')}
                  </Button>
                )}
              </div>
            </div>
          </form>
        ) : null}
      </Popover>
    </div>
  );
};

/** The check box of a secret check box — the same look as the check box column (display only; the button acts). */
const CheckBox = ({ checked }: { checked: boolean }) => (
  <input
    type="checkbox"
    aria-hidden
    tabIndex={-1}
    readOnly
    checked={checked}
    className="pointer-events-none size-4 accent-[var(--check)]"
  />
);
