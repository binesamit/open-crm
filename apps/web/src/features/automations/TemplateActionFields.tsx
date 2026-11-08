// SPDX-License-Identifier: AGPL-3.0-only
import { itemTemplateVarFits, t, type ItemTemplateSummary } from '@bines/shared';
import { Field, Picker } from '@bines/ui';
import type { BoardDetail } from '../board/board-api';

/**
 * Item templates in automations (phase 2): the settings of `create_item_from_template` /
 * `add_template_subitems` the sentence has no blank for — the new item's group, where each of the template's
 * questions takes its answer on the trigger item, and the links between the two items. Every choice is the app's
 * own picker (never a native one); nothing is fixed in code.
 */
const NONE = '__none__';

export type TemplateActionValue = {
  type: string;
  group?: unknown;
  variables?: unknown;
  connect_column?: unknown;
  connect_back_column?: unknown;
};

export const TemplateActionFields = ({
  action,
  template,
  itemColumns,
  target,
  boardLevel,
  onChange,
}: {
  action: TemplateActionValue;
  /** The chosen template (undefined while none is chosen or the list loads). */
  template: ItemTemplateSummary | undefined;
  /** The trigger item's columns (the answers and the link on it come from these). */
  itemColumns: BoardDetail['columns'];
  /** The board the new item is made on (its groups, its link back); null for subitems. */
  target: BoardDetail | null;
  /** The trigger gives no item (a board-level run): nothing to answer from. */
  boardLevel: boolean;
  onChange: (patch: Record<string, unknown>) => void;
}) => {
  const variables = (action.variables as Record<string, string> | undefined) ?? {};
  const setVariable = (key: string, source: string) => {
    const next = { ...variables };
    if (source === NONE) delete next[key];
    else next[key] = source;
    onChange({ variables: Object.keys(next).length ? next : undefined });
  };
  const relations = (cols: BoardDetail['columns']) => [
    { value: NONE, label: t('auto.itemTemplate.noConnect') },
    ...cols.filter((c) => c.type === 'board_relation').map((c) => ({ value: c.id, label: c.title })),
  ];
  const creates = action.type === 'create_item_from_template';
  return (
    <div className="flex w-72 flex-col gap-3 text-sm" data-testid="auto-template-fields">
      {creates && target ? (
        <Field label={t('auto.itemTemplate.group')}>
          <Picker
            label={t('auto.itemTemplate.group')}
            value={typeof action.group === 'string' ? action.group : NONE}
            options={[
              { value: NONE, label: t('auto.itemTemplate.firstGroup') },
              ...target.groups.map((g) => ({ value: g.id, label: g.title })),
            ]}
            onChange={(v) => onChange({ group: v === NONE ? undefined : v })}
            testId="auto-template-group"
          />
        </Field>
      ) : null}
      <section className="flex flex-col gap-2" data-testid="auto-template-variables">
        <h4 className="text-xs font-semibold text-fg-2">{t('auto.itemTemplate.variables')}</h4>
        {!template ? (
          <p className="text-xs text-muted">{t('auto.itemTemplate.pickFirst')}</p>
        ) : !template.variables.length ? (
          <p className="text-xs text-muted">{t('auto.itemTemplate.noVariables')}</p>
        ) : boardLevel ? (
          <p className="text-xs text-muted">{t('auto.itemTemplate.needsItem')}</p>
        ) : (
          <>
            <p className="text-xs text-muted">{t('auto.itemTemplate.variablesHint')}</p>
            {template.variables.map((v) => (
              <Field key={v.key} label={`${v.label}${v.required ? ' *' : ''}`}>
                <Picker
                  label={v.label}
                  value={variables[v.key] ?? NONE}
                  options={[
                    { value: NONE, label: t('auto.itemTemplate.noSource') },
                    ...(v.type === 'text' ? [{ value: 'name', label: t('auto.itemTemplate.itemName') }] : []),
                    ...itemColumns
                      .filter((c) => c.type !== 'name' && itemTemplateVarFits(v.type, c.type))
                      .map((c) => ({ value: c.id, label: c.title })),
                  ]}
                  onChange={(source) => setVariable(v.key, source)}
                  testId={`auto-template-var-${v.key}`}
                  searchable
                />
              </Field>
            ))}
          </>
        )}
      </section>
      {creates ? (
        <>
          <Field label={t('auto.itemTemplate.connect')} hint={t('auto.itemTemplate.connectHint')}>
            <Picker
              label={t('auto.itemTemplate.connect')}
              value={typeof action.connect_column === 'string' ? action.connect_column : NONE}
              options={relations(boardLevel ? [] : itemColumns)}
              onChange={(v) => onChange({ connect_column: v === NONE ? undefined : v })}
              testId="auto-template-connect"
            />
          </Field>
          {target ? (
            <Field label={t('auto.itemTemplate.connectBack')} hint={t('auto.itemTemplate.connectBackHint')}>
              <Picker
                label={t('auto.itemTemplate.connectBack')}
                value={typeof action.connect_back_column === 'string' ? action.connect_back_column : NONE}
                options={relations(boardLevel ? [] : target.columns)}
                onChange={(v) => onChange({ connect_back_column: v === NONE ? undefined : v })}
                testId="auto-template-connect-back"
              />
            </Field>
          ) : null}
        </>
      ) : null}
    </div>
  );
};
