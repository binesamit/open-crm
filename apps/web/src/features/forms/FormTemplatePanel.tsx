// SPDX-License-Identifier: AGPL-3.0-only
import {
  itemTemplateVarFits,
  proposeItemTemplateSources,
  t,
  type BoardDetail,
  type FormItemTemplate,
  type FormQuestion,
} from '@bines/shared';
import { Field, Picker } from '@bines/ui';
import { useItemTemplates } from '../item-templates/item-templates-api';

const NONE = '__none__';

/**
 * Item templates in forms (phase 2): "each submission creates an item from template X" — one of the
 * board's templates, and which question answers each of its questions (a date question → a date, a people question
 * → a person, any answer's text → a text). Unset = the template's own default. Nothing here is fixed in code.
 */
export const FormTemplatePanel = ({
  accountId,
  board,
  questions,
  value,
  onChange,
}: {
  accountId: string;
  board: BoardDetail;
  questions: FormQuestion[];
  value: FormItemTemplate | null;
  onChange: (next: FormItemTemplate | null) => void;
}) => {
  // Templates live on a main board; a form on a subitems board has none.
  const list = useItemTemplates(accountId, board.id).data ?? [];
  const chosen = value ? list.find((x) => x.id === value.template_id) : undefined;
  const columnOf = (q: FormQuestion) => board.columns.find((c) => c.id === q.column_key);
  const shown = questions.filter((q) => columnOf(q));
  const questionLabel = (q: FormQuestion) => q.label || columnOf(q)?.title || q.column_key;
  if (!list.length && !value) return null;
  return (
    <div className="space-y-3" data-testid="form-item-template">
      <Field label={t('forms.editor.itemTemplate')} hint={t('forms.editor.itemTemplateHint')}>
        <Picker
          label={t('forms.editor.itemTemplate')}
          value={value?.template_id ?? NONE}
          options={[
            { value: NONE, label: t('forms.editor.noItemTemplate') },
            ...list.map((x) => ({ value: x.id, label: x.name, keywords: x.category })),
          ]}
          onChange={(id) => {
            if (id === NONE) return onChange(null);
            const tpl = list.find((x) => x.id === id);
            // A first proposal: each question of the template from the first fitting question of the form.
            const proposal = proposeItemTemplateSources(
              tpl?.variables ?? [],
              shown.map((q) => ({ key: q.id, type: columnOf(q)!.type })),
            );
            onChange({ template_id: id, variables: proposal });
          }}
          testId="form-item-template-picker"
          searchable
        />
      </Field>
      {value && chosen?.variables.length ? (
        <section className="space-y-2" data-testid="form-item-template-vars">
          <h4 className="text-xs font-semibold text-fg-2">{t('forms.editor.itemTemplateVars')}</h4>
          {chosen.variables.map((v) => (
            <Field key={v.key} label={`${v.label}${v.required ? ' *' : ''}`}>
              <Picker
                label={v.label}
                value={value.variables[v.key] ?? NONE}
                options={[
                  { value: NONE, label: t('forms.editor.itemTemplateVarDefault') },
                  ...shown
                    .filter((q) => itemTemplateVarFits(v.type, columnOf(q)!.type))
                    .map((q) => ({ value: q.id, label: questionLabel(q) })),
                ]}
                onChange={(qid) => {
                  const variables = { ...value.variables };
                  if (qid === NONE) delete variables[v.key];
                  else variables[v.key] = qid;
                  onChange({ ...value, variables });
                }}
                testId={`form-item-template-var-${v.key}`}
                searchable
              />
            </Field>
          ))}
        </section>
      ) : null}
    </div>
  );
};
