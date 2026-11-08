// SPDX-License-Identifier: AGPL-3.0-only
import { AI_STYLE_COUNT_DEFAULT, AI_STYLE_COUNT_MAX, type FilterGroup, t } from '@bines/shared';
import { Field, Notice, Switch } from '@bines/ui';
import { BoardFilterEditor } from '../board/RelationFilterSection';
import { emptyGroup } from '../board/toolbar/filter-model';
import { PickerButton } from '../board/toolbar/parts';

/** The setting as both the AI column and the `generate_image` action save it. */
export type StyleExamplesValue = { column: string; filter: FilterGroup | null; count: number };

const COUNTS = Array.from({ length: AI_STYLE_COUNT_MAX }, (_, i) => i + 1);
const countLabel = (n: number) => (n === 1 ? t('ai2.form.sourceCountOne') : t('ai2.form.sourceCountMany', { n }));

/**
 * "Style examples" (round 3) — off by default: approved images of OTHER items of the board are sent
 * first as the style to follow. A file column of the board, which items supply them (the board filter's editor —
 * no rules = any item with an image there) and how many (the newest). The AI column's form and the automation
 * builder's `generate_image` slot share it.
 */
export const StyleExamplesSection = ({
  accountId,
  boardId,
  fileColumns,
  value,
  onChange,
}: {
  accountId: string;
  boardId: string;
  fileColumns: { id: string; title: string }[];
  value: StyleExamplesValue | null | undefined;
  onChange: (v: StyleExamplesValue | null) => void;
}) => {
  const on = !!value;
  const column = value ? fileColumns.find((c) => c.id === value.column) : undefined;
  return (
    <div className="flex flex-col gap-2.5 rounded-[var(--radius)] border border-line p-3" data-testid="ai-style">
      <label className="flex items-center gap-2 text-sm">
        <Switch
          checked={on}
          testId="ai-style-on"
          onChange={(next) =>
            onChange(
              next && fileColumns[0]
                ? { column: fileColumns[0].id, filter: null, count: AI_STYLE_COUNT_DEFAULT }
                : null,
            )
          }
        />
        {t('ai2.style.title')}
      </label>
      <p className="text-xs text-muted">{t('ai2.style.hint')}</p>
      {!fileColumns.length ? <Notice tone="warn">{t('ai2.form.noFileColumns')}</Notice> : null}
      {value ? (
        <>
          <div className="grid grid-cols-2 gap-2.5 max-sm:grid-cols-1">
            <Field label={t('ai2.style.column')}>
              <PickerButton
                testId="ai-style-column"
                label={column?.title}
                placeholder={t('ai2.form.pickFileColumn')}
                menuLabel={t('ai2.style.column')}
                items={fileColumns.map((c) => ({
                  label: c.title,
                  testId: 'ai-style-column-option',
                  checked: c.id === value.column,
                  onSelect: () => onChange({ ...value, column: c.id }),
                }))}
              />
            </Field>
            <Field label={t('ai2.style.count')}>
              <PickerButton
                testId="ai-style-count"
                label={countLabel(value.count)}
                placeholder={countLabel(AI_STYLE_COUNT_DEFAULT)}
                menuLabel={t('ai2.style.count')}
                items={COUNTS.map((n) => ({
                  label: countLabel(n),
                  testId: `ai-style-count-${n}`,
                  checked: n === value.count,
                  onSelect: () => onChange({ ...value, count: n }),
                }))}
              />
            </Field>
          </div>
          {/* Not a <label> (Field): the filter editor holds many buttons. */}
          <div className="space-y-1.5">
            <span className="text-xs text-fg-2">{t('ai2.style.filter')}</span>
            <BoardFilterEditor
              accountId={accountId}
              boardId={boardId}
              group={value.filter ?? emptyGroup()}
              testId="ai-style-filter"
              onChange={(g) => onChange({ ...value, filter: g.rules.length ? g : null })}
            />
            <span className="block text-xs text-muted">{t('ai2.style.filterHint')}</span>
          </div>
          <p className="text-xs text-muted" data-testid="ai-style-cost">
            {t('ai2.style.costHint')}
          </p>
        </>
      ) : null}
    </div>
  );
};
