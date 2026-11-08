// SPDX-License-Identifier: AGPL-3.0-only
import { forwardRef, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FORMULA_CATALOG, t } from '@bines/shared';
import { cn, useLayer } from '@bines/ui';
import { CaretPopup } from '../../lib/caret-popup';
import { columnTypeLabel } from '../../lib/locale';
import { filterTokenOptions, insertToken, tokenQuery, type TokenOption } from './formula-tokens';

/** The caret's box inside a textarea (a hidden copy with the same text and styles, measured at the caret). */
const caretRect = (el: HTMLTextAreaElement, pos: number): DOMRect => {
  const style = getComputedStyle(el);
  const div = document.createElement('div');
  for (const p of [
    'boxSizing',
    'width',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'borderTopWidth',
    'borderRightWidth',
    'borderBottomWidth',
    'borderLeftWidth',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'tabSize',
    'direction',
    'textAlign',
  ] as const)
    div.style[p] = style[p];
  div.style.position = 'fixed';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.overflowWrap = 'break-word';
  div.style.top = '0';
  div.style.left = '0';
  div.textContent = el.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = el.value.slice(pos) || '​';
  div.appendChild(mark);
  document.body.appendChild(div);
  const box = el.getBoundingClientRect();
  const left = box.left + mark.offsetLeft - el.scrollLeft;
  const top = box.top + mark.offsetTop - el.scrollTop;
  const height = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  document.body.removeChild(div);
  return new DOMRect(left, top, 1, height);
};

export type FormulaEditorHandle = {
  /** Inserts at the caret (or the end); the caret ends `caretBack` characters before the inserted text's end. */
  insert: (text: string, caretBack?: number) => void;
};

/**
 * r15cols — the formula text with a "{" list: typing "{" opens the board's columns (and the functions) at the
 * caret; typing on filters it, ↑/↓ move, Enter / Tab / a click insert `{key}` (or `NAME()`), Esc closes.
 */
export const FormulaEditor = forwardRef<
  FormulaEditorHandle,
  {
    value: string;
    onChange: (value: string) => void;
    columns: { id: string; title: string; type: string }[];
  }
>(({ value, onChange, columns }, handle) => {
  const area = useRef<HTMLTextAreaElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<number | null>(null);

  const options = useMemo<TokenOption[]>(
    () => [
      ...columns.map((c) => ({ kind: 'column' as const, key: c.id, title: c.title, type: c.type })),
      ...FORMULA_CATALOG.map((f) => ({ kind: 'function' as const, name: f.name, he: f.he, syntax: f.syntax })),
    ],
    [columns],
  );
  const q = caret === null ? null : tokenQuery(value, caret);
  const open = !!q && dismissed !== q.start;
  const shown = open ? filterTokenOptions(options, q.query) : [];
  const close = () => setDismissed(q?.start ?? null);
  useLayer(panel, open, close, undefined, () => area.current);

  const setText = (text: string, pos: number) => {
    onChange(text);
    requestAnimationFrame(() => {
      const el = area.current;
      el?.focus();
      el?.setSelectionRange(pos, pos);
      setCaret(pos);
    });
  };
  useImperativeHandle(handle, () => ({
    insert: (text, caretBack = 0) => {
      const el = area.current;
      const at = el ? el.selectionStart : value.length;
      const end = el ? el.selectionEnd : value.length;
      setText(value.slice(0, at) + text + value.slice(end), at + text.length - caretBack);
    },
  }));

  const pick = (o: TokenOption) => {
    if (!q || caret === null) return;
    const next = insertToken(value, q.start, caret, o);
    setDismissed(null);
    setText(next.text, next.caret);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || !shown.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + d + shown.length) % shown.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      pick(shown[Math.min(active, shown.length - 1)]!);
    }
    // Esc: the layer (useLayer) closes the list before the dialog.
  };
  const track = () => {
    const el = area.current;
    if (el) setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  };

  return (
    <>
      <textarea
        ref={area}
        dir="ltr"
        value={value}
        data-testid="formula-input"
        aria-autocomplete="list"
        aria-expanded={open}
        onChange={(e) => {
          const pos = e.target.selectionStart;
          onChange(e.target.value);
          setCaret(pos);
          setActive(0);
          // A newly typed "{" opens the list again, even where an earlier one was closed with Esc.
          if (e.target.value[pos - 1] === '{') setDismissed(null);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key) || !open) track();
        }}
        onClick={track}
        onBlur={() => setCaret(null)}
        className="h-24 w-full rounded-[10px] border border-line-strong bg-surface p-2.5 font-mono text-sm focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
      />
      {open && area.current && caret !== null ? (
        <CaretPopup
          rect={caretRect(area.current, q.start)}
          host={() => area.current}
          label={t('r15cols.formula.suggest')}
          testId="formula-suggest"
          className="max-h-64 w-72"
        >
          <div ref={panel}>
            {shown.length ? (
              shown.map((o, i) => (
                <button
                  key={o.kind === 'column' ? `c:${o.key}` : `f:${o.name}`}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-testid="formula-suggest-option"
                  data-kind={o.kind}
                  data-key={o.kind === 'column' ? o.key : o.name}
                  // Keep the focus (and the caret) in the text.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(o)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded-[8px] px-2 py-1.5 text-start text-sm',
                    i === active ? 'bg-surface-2' : '',
                  )}
                >
                  {o.kind === 'column' ? (
                    <>
                      <span className="truncate" dir="auto">
                        {o.title}
                      </span>
                      <span className="shrink-0 text-xs text-muted">{o.type ? columnTypeLabel(o.type) : ''}</span>
                    </>
                  ) : (
                    <>
                      <span className="truncate font-mono text-xs font-semibold" dir="ltr">
                        {o.syntax ?? `${o.name}()`}
                      </span>
                      <span className="shrink-0 text-xs text-muted">{o.he}</span>
                    </>
                  )}
                </button>
              ))
            ) : (
              <p className="px-2 py-1.5 text-sm text-muted" data-testid="formula-suggest-empty">
                {t('r15cols.formula.noMatch')}
              </p>
            )}
          </div>
        </CaretPopup>
      ) : null}
    </>
  );
});
FormulaEditor.displayName = 'FormulaEditor';
