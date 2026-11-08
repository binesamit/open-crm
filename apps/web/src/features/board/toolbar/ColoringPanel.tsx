// SPDX-License-Identifier: AGPL-3.0-only
import { MAX_COLORING_RULES, newId, normalizeLabelColor, paint, t, type ColoringRule } from '@bines/shared';
import { cn } from '@bines/ui';
import { RuleEditor, type FilterCtx } from './FilterPanel';
import { newRule } from './filter-model';
import { PickerButton } from './parts';
import { columnTypeLabel } from '../../../lib/locale';
import { ColorGrid } from '../../../lib/label-color';

/**
 * Conditional coloring: "when <condition>, colour <the item | a column's cell> <colour>". The
 * condition is a filter rule (same editor); rules apply top to bottom, the first match wins.
 */
export const ColoringPanel = ({
  rules,
  ctx,
  onChange,
}: {
  rules: ColoringRule[];
  ctx: FilterCtx;
  onChange: (rules: ColoringRule[]) => void;
}) => {
  const columns = ctx.columns.filter((c) => c.type !== 'name');
  const set = (i: number, next: ColoringRule | null) =>
    onChange(next ? rules.map((r, j) => (j === i ? next : r)) : rules.filter((_, j) => j !== i));
  const titleOf = (id: string) => ctx.columns.find((c) => c.id === id)?.title ?? id;

  return (
    <div className="w-[min(760px,92vw)] space-y-3" data-testid="coloring-panel">
      <div>
        <h2 className="text-sm font-semibold">{t('coloring.title')}</h2>
        <p className="text-xs text-muted">{t('coloring.hint')}</p>
      </div>
      {rules.map((r, i) => (
        <div
          key={r.id}
          className="space-y-2 rounded-[var(--radius-sm)] border border-line p-2"
          style={{ borderInlineStartColor: paint(r.color), borderInlineStartWidth: 4 }}
          data-testid="coloring-rule"
        >
          <div className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-muted">{t('coloring.when')}</span>
            <RuleEditor
              rule={r.rule}
              ctx={ctx}
              onChange={(rule) => set(i, { ...r, rule })}
              onRemove={() => set(i, null)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="w-12 shrink-0 text-xs text-muted">{t('coloring.paint')}</span>
            <PickerButton
              testId="coloring-target"
              menuLabel={t('coloring.paint')}
              placeholder={t('coloring.row')}
              className="w-48"
              label={
                r.target === 'row'
                  ? t('coloring.row')
                  : t('coloring.cell', { column: titleOf(r.column_id ?? r.rule.column_id) })
              }
              items={[
                {
                  label: t('coloring.row'),
                  checked: r.target === 'row',
                  onSelect: () => set(i, { ...r, target: 'row', column_id: undefined }),
                },
                ...columns.map((c) => ({
                  label: t('coloring.cell', { column: c.title }),
                  keywords: columnTypeLabel(c.type),
                  checked: r.target === 'cell' && (r.column_id ?? r.rule.column_id) === c.id,
                  onSelect: () => set(i, { ...r, target: 'cell' as const, column_id: c.id }),
                })),
              ]}
            />
            {/* pal40: all forty colours, the app's colour picker. */}
            <ColorGrid
              kind="radio"
              label={t('coloring.color')}
              itemTestId="coloring-color"
              className="self-start"
              selected={(color) => normalizeLabelColor(r.color) === color}
              onPick={(color) => set(i, { ...r, color })}
              itemClassName={(_, on) => cn('border border-black/10', on && 'ring-2 ring-primary ring-offset-1')}
            />
          </div>
        </div>
      ))}
      {rules.length < MAX_COLORING_RULES ? (
        <button
          type="button"
          data-testid="coloring-add"
          className="text-sm text-primary hover:underline"
          onClick={() =>
            onChange([...rules, { id: newId(), rule: newRule(ctx.columns, ctx.env), target: 'row', color: 'yellow' }])
          }
        >
          + {t('coloring.add')}
        </button>
      ) : null}
    </div>
  );
};
