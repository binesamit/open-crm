// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { DEP_KINDS, t, type DepKind, type MessageKey } from '@bines/shared';
import { Icon } from '../../../lib/icons';
import { PickerButton } from '../toolbar/parts';
import type { CellProps } from './index';
import { Popover } from './Popover';
import { RelationCell } from './RelationCell';
import { linkedNames } from './linked-names';

type Value = { item_ids: string[]; kind?: Record<string, DepKind>; lag_days?: Record<string, number> };

/** Keeps only the kinds / lags of ids still linked; drops empty records. */
const prune = (ids: string[], v: Value | null): Value => {
  const keep = <T,>(r: Record<string, T> | undefined) => {
    const out = Object.fromEntries(Object.entries(r ?? {}).filter(([id]) => ids.includes(id)));
    return Object.keys(out).length ? out : undefined;
  };
  const kind = keep(v?.kind);
  const lag = keep(v?.lag_days);
  return { item_ids: ids, ...(kind ? { kind } : {}), ...(lag ? { lag_days: lag } : {}) };
};

/**
 * dependency (M8 ד7, 03 §3.2): the items of this board this item depends on — the relation picker limited to the
 * board itself (never the item). A second button edits each link's kind (FS / SS / FF / SF) and lag in days.
 */
export const DependencyCell = (props: CellProps) => {
  const { column, value, text, names: cellNames, editable, onChange, boardId, itemId } = props;
  const v = value as Value | null;
  const ids = v?.item_ids ?? [];
  const names = linkedNames(ids, cellNames, text);
  const [open, setOpen] = useState(false);
  const limited = { ...column, settings: { ...column.settings, board_ids: [boardId], allow_multiple: true } };
  return (
    <div className="group/dep relative flex h-full w-full items-center" data-testid="dependency-cell">
      <div className="min-w-0 flex-1">
        <RelationCell
          {...props}
          column={limited}
          exclude={itemId}
          onChange={(next) => {
            const list = (next as { item_ids?: string[] } | null)?.item_ids ?? [];
            onChange(list.length ? prune(list, v) : null);
          }}
        />
      </div>
      {editable && ids.length ? (
        <button
          type="button"
          data-testid="dependency-links"
          aria-label={t('dependency.edit')}
          title={t('dependency.edit')}
          onClick={() => setOpen(true)}
          className="me-1 grid size-6 shrink-0 place-items-center rounded text-muted opacity-0 group-hover/dep:opacity-100 hover:bg-surface-2 focus:opacity-100"
        >
          <Icon name="gear" size={13} />
        </button>
      ) : null}
      <Popover open={open} onClose={() => setOpen(false)} className="w-80" align="end">
        <div className="flex flex-col gap-2" data-testid="dependency-editor">
          {ids.map((id, i) => {
            const kind = v?.kind?.[id] ?? 'FS';
            const lag = v?.lag_days?.[id] ?? 0;
            return (
              <div key={id} className="flex items-center gap-2" data-testid="dependency-link" data-item-name={names[i]}>
                <span className="min-w-0 flex-1 truncate text-sm">{names[i] ?? id}</span>
                <PickerButton
                  testId="dependency-kind"
                  label={kind}
                  placeholder="FS"
                  menuLabel={t('dependency.kind')}
                  className="w-20 shrink-0"
                  items={DEP_KINDS.map((k) => ({
                    label: `${k} · ${t(`dependency.kind.${k}` as MessageKey)}`,
                    checked: k === kind,
                    onSelect: () => {
                      const next = { ...v?.kind, [id]: k };
                      if (k === 'FS') delete next[id];
                      onChange(prune(ids, { ...prune(ids, v), kind: next }));
                    },
                  }))}
                />
                <LagField
                  value={lag}
                  label={t('dependency.lag')}
                  onCommit={(n) => {
                    const next = { ...v?.lag_days, [id]: n };
                    if (!n) delete next[id];
                    onChange(prune(ids, { ...prune(ids, v), lag_days: next }));
                  }}
                />
              </div>
            );
          })}
          <p className="text-xs text-muted">{t('dependency.hint')}</p>
        </div>
      </Popover>
    </div>
  );
};

/** Lag in days (−365…365), saved on blur / Enter. */
const LagField = ({ value, label, onCommit }: { value: number; label: string; onCommit: (n: number) => void }) => {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const n = Number(text.trim() || '0');
    if (Number.isInteger(n) && n >= -365 && n <= 365) {
      if (n !== value) onCommit(n);
    } else setText(String(value));
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      dir="ltr"
      aria-label={label}
      title={label}
      data-testid="dependency-lag"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      className="h-8 w-14 shrink-0 rounded-[10px] border border-line-strong bg-surface px-2 text-center text-sm tabular-nums focus:border-primary focus:outline-none"
    />
  );
};
