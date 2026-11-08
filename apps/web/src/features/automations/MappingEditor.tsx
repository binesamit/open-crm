// SPDX-License-Identifier: AGPL-3.0-only
import { useContext } from 'react';
import { columnTypes, t } from '@bines/shared';
import { Button, Input, SkeletonRows } from '@bines/ui';
import { BoardAccountContext } from '../board/board-context';
import { useBoard, type BoardDetail } from '../board/board-api';
import { PickerButton } from '../board/toolbar/parts';
import { columnTypeLabel } from '../../lib/locale';

/**
 * Column mapping of a cross-board action (04 §6.2): for each column of the target board — copy a column of this
 * board (`mapping` = {target: source}), a fixed value / template (`fixed`, create_item only), or nothing.
 * "Map by name" fills same-title-and-type pairs.
 */
type Props = {
  board: BoardDetail;
  /** r18board 5: the run item's columns (a subitem trigger's are the sub-board's); default the board's. */
  sourceColumns?: BoardDetail['columns'];
  targetBoardId: string;
  mapping: Record<string, string> | undefined;
  fixed?: Record<string, unknown> | undefined;
  allowFixed: boolean;
  onChange: (next: { mapping?: Record<string, string>; fixed?: Record<string, unknown> }) => void;
};

const writable = (type: string) => {
  const def = columnTypes.get(type);
  return !!def && !def.readOnly && (def.storage === 'cell' || def.storage === 'item' || def.engine === 'links');
};

export const MappingEditor = ({ board, sourceColumns, targetBoardId, mapping, fixed, allowFixed, onChange }: Props) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const target = useBoard(accountId, targetBoardId === '@self' ? board.id : targetBoardId);
  if (target.isLoading) return <SkeletonRows rows={3} label={t('app.loading')} />;
  if (!target.data) return null;
  const targets = target.data.columns.filter((c) => writable(c.type));
  const sources = [
    { id: 'name', title: t('auto.word.name'), type: 'name' },
    ...(sourceColumns ?? board.columns).filter((c) => c.type !== 'name'),
  ];
  const m = mapping ?? {};
  const f = (fixed ?? {}) as Record<string, unknown>;
  const set = (key: string, source: string | null, value?: string) => {
    const nextMapping = { ...m };
    const nextFixed = { ...f };
    delete nextMapping[key];
    delete nextFixed[key];
    if (source === '@fixed') nextFixed[key] = value ?? '';
    else if (source) nextMapping[key] = source;
    onChange({
      mapping: Object.keys(nextMapping).length ? nextMapping : undefined,
      ...(allowFixed ? { fixed: Object.keys(nextFixed).length ? nextFixed : undefined } : {}),
    });
  };
  const byName = () => {
    const next = { ...m };
    for (const c of targets)
      if (!next[c.id] && !(c.id in f)) {
        const src = sources.find((s) => s.title.trim() === c.title.trim() && (s.type === c.type || c.type === 'name'));
        if (src) next[c.id] = src.id;
      }
    onChange({ mapping: next, ...(allowFixed ? { fixed: Object.keys(f).length ? f : undefined } : {}) });
  };
  const label = (key: string) =>
    key in f
      ? t('auto.mapping.fixed')
      : m[key]
        ? (sources.find((s) => s.id === m[key])?.title ?? m[key])
        : t('auto.mapping.none');

  return (
    <div className="w-[28rem] max-w-full space-y-2" data-testid="mapping-editor">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold">{t('auto.mapping.title', { board: target.data.name })}</p>
        <Button variant="ghost" className="h-7 px-2 text-xs" onClick={byName} data-testid="mapping-by-name">
          {t('auto.mapping.by_name')}
        </Button>
      </div>
      <ul className="max-h-80 space-y-1 overflow-y-auto">
        {targets.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-sm" data-testid="mapping-target" data-column={c.id}>
            <span className="w-32 shrink-0 truncate">{c.title}</span>
            <span className="text-muted">←</span>
            <PickerButton
              className="w-40"
              menuLabel={c.title}
              placeholder={t('auto.mapping.none')}
              label={label(c.id)}
              testId="mapping-source"
              items={[
                { label: t('auto.mapping.none'), onSelect: () => set(c.id, null) },
                ...sources.map((s) => ({
                  label: s.title,
                  keywords: columnTypeLabel(s.type),
                  checked: m[c.id] === s.id,
                  onSelect: () => set(c.id, s.id),
                })),
                ...(allowFixed && c.type !== 'name'
                  ? [
                      {
                        label: t('auto.mapping.fixed'),
                        checked: c.id in f,
                        onSelect: () => set(c.id, '@fixed', String(f[c.id] ?? '')),
                      },
                    ]
                  : []),
              ]}
            />
            {c.id in f ? (
              <Input
                className="h-8 flex-1"
                value={String(f[c.id] ?? '')}
                placeholder={t('auto.mapping.fixed_hint')}
                onChange={(e) => set(c.id, '@fixed', e.target.value)}
                data-testid="mapping-fixed"
              />
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">{t('auto.mapping.hint')}</p>
    </div>
  );
};
