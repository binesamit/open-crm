// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, useRef, useState, type ReactNode } from 'react';
import { keysOf } from '../idocs-api';
import { Button, cn, Input, Menu, Picker, Switch, useActionMenu, type MenuEntry } from '@bines/ui';
import type { Column } from '../../board/board-api';
import { Icon } from '../../../lib/icons';
import { uploadFile } from '../../../lib/upload';
import { errorMessage } from '../../../lib/api';
import { columnTypeLabel } from '../../../lib/locale';
import { showToast } from '../../../lib/toast';

/** Small building blocks of the document builder's forms. Words: `idoc.b.*`. */
export const B = keysOf('idoc.b.');

/** Column types each kind of setting accepts. */
export const COLS = {
  amount: ['numbers', 'formula', 'mirror'],
  number: ['numbers'],
  checkbox: ['checkbox'],
  requires: ['dependency', 'board_relation'],
  text: [
    'text',
    'long_text',
    'status',
    'dropdown',
    'tags',
    'email',
    'phone',
    'link',
    'numbers',
    'date',
    'mirror',
    'formula',
  ],
  label: ['status', 'dropdown', 'text', 'tags'],
  relation: ['board_relation'],
  people: ['people'],
  file: ['file'],
  date: ['date', 'timeline'],
  email: ['email', 'text', 'mirror'],
  status: ['status'],
  signature: ['signature'],
  input: ['text', 'long_text', 'email', 'phone', 'numbers', 'date', 'checkbox', 'link'],
} as const;

/** The accessible name a field inside a `Row` takes when it has none of its own (the row's visible label). */
const RowLabel = createContext<string | undefined>(undefined);

export const Row = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <div className="grid gap-1">
    <span className="text-xs text-fg-2">{label}</span>
    <RowLabel.Provider value={label}>{children}</RowLabel.Provider>
    {hint ? <span className="text-[0.7rem] text-muted">{hint}</span> : null}
  </div>
);

export const Toggle = ({
  label,
  checked,
  onChange,
  testId,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId?: string;
}) => (
  <label className="flex items-center justify-between gap-3 text-[0.8125rem] text-fg-2">
    <span>{label}</span>
    <Switch checked={checked} onChange={onChange} label={label} testId={testId} />
  </label>
);

export const Text = ({
  value,
  onChange,
  placeholder,
  dir,
  testId,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  dir?: 'ltr';
  testId?: string;
}) => {
  const label = useContext(RowLabel);
  return (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      dir={dir}
      data-testid={testId}
      aria-label={label ?? placeholder}
    />
  );
};

export const NumberField = ({
  value,
  onChange,
  min = 0,
  max = 1_000_000,
  testId,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  testId?: string;
}) => {
  const label = useContext(RowLabel);
  return (
    <Input
      value={value === null ? '' : String(value)}
      inputMode="decimal"
      dir="ltr"
      data-testid={testId}
      aria-label={label}
      onChange={(e) => {
        const raw = e.target.value.replace(/[^\d.]/g, '');
        if (!raw) return onChange(null);
        const n = Number(raw);
        if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
      }}
    />
  );
};

/** A text area that also offers the merge fields ({col:…}) of the item's board. */
export const LongText = ({
  value,
  onChange,
  rows = 5,
  tokens,
  testId,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  tokens?: { label: string; token: string }[];
  testId?: string;
  ariaLabel?: string;
}) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const rowLabel = useContext(RowLabel);
  const label = ariaLabel ?? rowLabel;
  const insert = (token: string) => {
    const el = ref.current;
    const at = el ? el.selectionStart : value.length;
    onChange(value.slice(0, at) + token + value.slice(at));
    requestAnimationFrame(() => el?.focus());
  };
  return (
    <div className="grid gap-1">
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        dir="auto"
        aria-label={label}
        data-testid={testId}
        onChange={(e) => onChange(e.target.value)}
        className="w-full resize-y rounded-[10px] border border-[var(--control-line)] bg-surface px-2.5 py-2 text-sm leading-6 text-fg focus:border-primary focus:outline-none"
      />
      {tokens?.length ? <TokenMenu tokens={tokens} onPick={insert} /> : null}
    </div>
  );
};

export const TokenMenu = ({
  tokens,
  onPick,
}: {
  tokens: { label: string; token: string }[];
  onPick: (token: string) => void;
}) => {
  const menu = useActionMenu();
  return (
    <>
      <button
        type="button"
        onClick={menu.fromTrigger}
        className="justify-self-start text-xs text-info-fg hover:underline"
        data-testid="idoc-token-menu"
      >
        + {B('insertField')}
      </button>
      <Menu
        at={menu.at}
        onClose={menu.close}
        label={B('insertField')}
        items={tokens.map((x) => ({ label: x.label, hint: x.token, onSelect: () => onPick(x.token) }))}
      />
    </>
  );
};

const MANUAL = '__manual__';

/**
 * A value the document shows: from the item (a merge field, dynamic) or typed by hand (fixed) — the product owner: "allow
 * typing manually when you don't want something dynamic". Generic: every bindable value of the builder uses it. The
 * stored value stays one text either way (a token like `{col:x}`, or the typed words, which may still mix in fields).
 */
export const BoundValue = ({
  value,
  tokens,
  onChange,
  label,
  testId = 'idoc-bound',
}: {
  value: string;
  tokens: { label: string; token: string }[];
  /** `picked` = the field's name when one was picked from the list. */
  onChange: (value: string, picked?: string) => void;
  label: string;
  testId?: string;
}) => {
  const isToken = (v: string) => tokens.some((x) => x.token === v);
  const [manual, setManual] = useState(() => value !== '' && !isToken(value));
  if (manual)
    return (
      <div className="grid gap-1" data-testid={testId} data-mode="manual">
        <div className="flex items-center gap-1">
          <Input
            value={value}
            dir="auto"
            onChange={(e) => onChange(e.target.value)}
            placeholder={B('typeValuePlaceholder')}
            aria-label={label}
            className="min-w-0 flex-1"
            data-testid={`${testId}-text`}
          />
          <button
            type="button"
            onClick={() => {
              setManual(false);
              if (!isToken(value)) onChange('');
            }}
            title={B('fromField')}
            aria-label={`${label}: ${B('fromField')}`}
            className="grid size-8 shrink-0 place-items-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-fg"
            data-testid={`${testId}-to-field`}
          >
            <Icon name="link" size={14} />
          </button>
        </div>
        {tokens.length ? (
          <TokenMenu tokens={tokens} onPick={(t) => onChange(`${value}${value ? ' ' : ''}${t}`)} />
        ) : null}
      </div>
    );
  return (
    <div data-testid={testId} data-mode="field">
      <Picker
        label={label}
        value={isToken(value) ? value : ''}
        valueLabel={() => tokens.find((x) => x.token === value)?.label ?? value}
        placeholder={value || B('pickField')}
        options={[
          { value: MANUAL, label: B('typeValue'), hint: B('typeValueHint') },
          ...tokens.map((x) => ({ value: x.token, label: x.label })),
        ]}
        onChange={(v) => {
          if (v === MANUAL) {
            setManual(true);
            onChange(isToken(value) ? '' : value);
          } else onChange(v, tokens.find((x) => x.token === v)?.label);
        }}
      />
    </div>
  );
};

/**
 * Picks a column of a board, limited to some types; "—" = none. With `fixed`, the value may also be typed by hand
 * instead (the product owner): the list offers "type a fixed value", which clears the column and shows a text field.
 */
export const ColumnPick = ({
  columns,
  types,
  value,
  onChange,
  label,
  testId,
  fixed,
}: {
  columns: Column[];
  types: readonly string[];
  value: string | null;
  onChange: (key: string | null) => void;
  label: string;
  testId?: string;
  fixed?: { value: string; onChange: (v: string) => void; type?: 'text' | 'email' };
}) => {
  const [manual, setManual] = useState(() => !!fixed?.value && !value);
  if (fixed && manual)
    return (
      <div className="flex items-center gap-1" data-testid={testId} data-mode="manual">
        <Input
          value={fixed.value}
          type={fixed.type ?? 'text'}
          dir="auto"
          onChange={(e) => fixed.onChange(e.target.value)}
          placeholder={B('typeValuePlaceholder')}
          aria-label={label}
          className="min-w-0 flex-1"
          data-testid={testId ? `${testId}-text` : undefined}
        />
        <button
          type="button"
          onClick={() => {
            setManual(false);
            fixed.onChange('');
          }}
          title={B('fromColumn')}
          aria-label={`${label}: ${B('fromColumn')}`}
          className="grid size-8 shrink-0 place-items-center rounded-[8px] text-muted hover:bg-surface-2 hover:text-fg"
        >
          <Icon name="link" size={14} />
        </button>
      </div>
    );
  return (
    <Picker
      label={label}
      testId={testId}
      value={value ?? ''}
      placeholder={B('none')}
      options={[
        { value: '', label: B('none') },
        ...(fixed ? [{ value: MANUAL, label: B('typeValue'), hint: B('typeValueHint') }] : []),
        ...columns
          .filter((c) => types.includes(c.type))
          .map((c) => ({ value: c.id, label: c.title, hint: columnTypeLabel(c.type) })),
      ]}
      onChange={(v) => {
        if (v === MANUAL) {
          setManual(true);
          onChange(null);
        } else {
          onChange(v || null);
          if (v) fixed?.onChange('');
        }
      }}
    />
  );
};

/** A list of small records (fields, consents, FAQ, schedule…): add, remove, edit in place. */
export const ListEditor = <T,>({
  items,
  onChange,
  blank,
  render,
  addLabel,
  max = 40,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  blank: () => T;
  render: (item: T, set: (next: T) => void, index: number) => ReactNode;
  addLabel: string;
  max?: number;
}) => (
  <div className="grid gap-2">
    {items.map((item, i) => (
      <div key={i} className="grid grid-cols-[1fr_auto] items-start gap-1.5 rounded-[10px] border border-line p-2">
        <div className="grid gap-1.5">
          {render(item, (next) => onChange(items.map((x, j) => (j === i ? next : x))), i)}
        </div>
        <div className="grid gap-0.5">
          <IconBtn
            label={B('up')}
            icon="chevronStart"
            disabled={!i}
            onClick={() => onChange(move(items, i, i - 1))}
            rotate
          />
          <IconBtn label={B('remove')} icon="x" onClick={() => onChange(items.filter((_, j) => j !== i))} />
        </div>
      </div>
    ))}
    {items.length < max ? (
      <Button size="sm" variant="dashed" onClick={() => onChange([...items, blank()])}>
        <Icon name="plus" size={13} />
        {addLabel}
      </Button>
    ) : null}
  </div>
);

const move = <T,>(list: T[], from: number, to: number) => {
  const next = [...list];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x!);
  return next;
};

export const IconBtn = ({
  label,
  icon,
  onClick,
  disabled,
  rotate,
}: {
  label: string;
  icon: 'x' | 'chevronStart' | 'trash' | 'duplicate' | 'eye' | 'eyeOff';
  onClick: () => void;
  disabled?: boolean;
  rotate?: boolean;
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    disabled={disabled}
    onClick={onClick}
    className="grid size-6 place-items-center rounded-[6px] text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30"
  >
    <span className={cn(rotate && 'rotate-90')}>
      <Icon name={icon} size={13} />
    </span>
  </button>
);

/** Uploads images / files for a section (they become the account's files). */
export const UploadButton = ({
  accountId,
  accept,
  multiple,
  onDone,
  label,
}: {
  accountId: string;
  accept?: string;
  multiple?: boolean;
  onDone: (ids: string[]) => void;
  label: string;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button size="sm" variant="secondary" busy={busy} onClick={() => input.current?.click()}>
        <Icon name="upload" size={13} />
        {label}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          if (!files.length) return;
          setBusy(true);
          try {
            const done = [];
            for (const f of files) done.push((await uploadFile(accountId, f)).id);
            onDone(done);
          } catch (err) {
            showToast({ message: errorMessage(err), tone: 'error' });
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
};

export type { MenuEntry };
