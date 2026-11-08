// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import {
  fillItemTemplateText,
  t,
  todayIn,
  type ItemTemplateNode,
  type ItemTemplateSummary,
  type ItemTemplateVariable,
} from '@bines/shared';
import { Button, Dialog, Field, Input, Notice, Picker, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { useMembers } from '../board/board-api';
import { DateField } from '../dashboards/DateField';
import { useItemTemplate, useItemTemplateMutations, useItemTemplates } from './item-templates-api';

type Answers = Record<string, string | string[]>;

/** The first answers: a date variable's "today", a text one's default. */
const initialAnswers = (vars: ItemTemplateVariable[]): Answers =>
  Object.fromEntries(
    vars.flatMap((v) =>
      v.type === 'date' && v.default === 'today'
        ? [[v.key, todayIn()]]
        : v.type === 'text' && v.default
          ? [[v.key, v.default]]
          : [],
    ),
  );

/** The tree as it will be made: names with the answers, and when each one's dates fall (working days after). */
const Preview = ({
  node,
  values,
  depth = 0,
}: {
  node: ItemTemplateNode;
  values: Record<string, string>;
  depth?: number;
}) => {
  const date = Object.values(node.cells).find((c) => c.kind === 'date');
  return (
    <>
      <li
        className="flex items-center gap-2 py-0.5 text-[0.8125rem]"
        style={{ paddingInlineStart: `${depth * 18}px` }}
        data-testid="item-template-preview-row"
      >
        <span className="min-w-0 flex-1 truncate text-fg">
          {fillItemTemplateText(node.name, values) || t('itemTemplates.unnamed')}
        </span>
        {date && date.kind === 'date' ? (
          <span className="shrink-0 text-xs text-muted">
            {date.from ? t('itemTemplates.afterDays', { n: date.from }) : t('itemTemplates.onStart')}
          </span>
        ) : null}
      </li>
      {node.children.map((c) => (
        <Preview key={c.id} node={c} values={values} depth={depth + 1} />
      ))}
    </>
  );
};

const VariableField = ({
  v,
  value,
  onChange,
  accountId,
}: {
  v: ItemTemplateVariable;
  value: string | string[] | undefined;
  onChange: (v: string | string[]) => void;
  accountId: string;
}) => {
  const members = useMembers(accountId).data?.data ?? [];
  const label = `${v.label}${v.required ? ' *' : ''}`;
  if (v.type === 'date')
    return <DateField label={label} value={(value as string) ?? null} onChange={(d) => onChange(d ?? '')} />;
  if (v.type === 'person')
    return (
      <Field label={label}>
        <Picker
          label={v.label}
          value={((value as string[] | undefined) ?? [])[0] ?? ''}
          placeholder={t('itemTemplates.pickPerson')}
          options={members
            .filter((m) => m.status === 'active' || !m.status)
            .map((m) => ({ value: m.user_id, label: m.name || m.email, keywords: m.email }))}
          onChange={(id) => onChange([id])}
          testId={`item-template-var-${v.key}`}
          searchable
        />
      </Field>
    );
  return (
    <Field label={label}>
      <Input
        value={(value as string) ?? ''}
        onChange={(e) => onChange(e.target.value)}
        data-testid={`item-template-var-${v.key}`}
      />
    </Field>
  );
};

/**
 * Applying a template: pick one of the board's templates (unless one was chosen), answer its
 * variables, see the tree, create — a new item, or the template's subitems under `parentItemId`. One undo.
 */
export const ApplyTemplateDialog = ({
  accountId,
  boardId,
  templateId: given,
  groupId,
  parentItemId,
  onClose,
}: {
  accountId: string;
  boardId: string;
  templateId?: string;
  groupId?: string;
  parentItemId?: string;
  onClose: () => void;
}) => {
  const list = useItemTemplates(accountId, boardId, !given);
  const [picked, setPicked] = useState<string | null>(given ?? null);
  const tpl = useItemTemplate(accountId, picked);
  const m = useItemTemplateMutations(accountId, boardId);
  const [answers, setAnswers] = useState<Answers | null>(null);
  const vars = tpl.data?.variables ?? [];
  const current = answers ?? (tpl.data ? initialAnswers(vars) : {});
  const values = Object.fromEntries(
    Object.entries(current).flatMap(([k, v]) => (typeof v === 'string' ? [[k, v]] : [])),
  );
  const missing = vars.filter(
    (v) => v.required && !(Array.isArray(current[v.key]) ? current[v.key]!.length : current[v.key]),
  );
  const apply = () =>
    picked &&
    m.apply.mutate(
      {
        id: picked,
        ...(groupId ? { group_id: groupId } : {}),
        ...(parentItemId ? { parent_item_id: parentItemId } : {}),
        position: 'bottom',
        variables: current,
      },
      { onSuccess: onClose },
    );

  const choosing = !picked;
  return (
    <Dialog
      open
      onClose={onClose}
      title={parentItemId ? t('itemTemplates.applyUnderTitle') : t('itemTemplates.applyTitle')}
      subtitle={tpl.data?.name}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          {choosing ? null : (
            <Button
              busy={m.apply.isPending}
              disabled={!tpl.data || missing.length > 0}
              onClick={apply}
              data-testid="item-template-apply"
            >
              {t('itemTemplates.create')}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3" data-testid="item-template-apply-dialog">
        {choosing ? (
          list.isPending ? (
            <SkeletonRows rows={4} label={t('app.loading')} />
          ) : !list.data?.length ? (
            <p className="text-sm text-muted">{t('itemTemplates.none')}</p>
          ) : (
            <ul className="grid gap-1">
              {list.data.map((x: ItemTemplateSummary) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(x.id)}
                    className="flex w-full items-center gap-2 rounded-[10px] border border-line px-3 py-2 text-start hover:bg-surface-2"
                    data-testid="item-template-choice"
                    data-name={x.name}
                  >
                    <span className="min-w-0 flex-1 truncate text-sm text-fg">{x.name}</span>
                    <span className="shrink-0 text-xs text-muted">
                      {x.category ? `${x.category} · ` : ''}
                      {t('itemTemplates.items', { n: x.nodes })}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : tpl.isError ? (
          <Notice tone="error">{errorMessage(tpl.error)}</Notice>
        ) : !tpl.data ? (
          <SkeletonRows rows={5} label={t('app.loading')} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div className="space-y-3">
              {vars.length ? (
                vars.map((v) => (
                  <VariableField
                    key={v.key}
                    v={v}
                    value={current[v.key]}
                    accountId={accountId}
                    onChange={(x) => setAnswers({ ...current, [v.key]: x })}
                  />
                ))
              ) : (
                <p className="text-sm text-muted">{t('itemTemplates.noQuestions')}</p>
              )}
            </div>
            <div className="min-w-0 rounded-[12px] border border-line p-3">
              <p className="mb-1 text-xs font-semibold text-fg-2">{t('itemTemplates.preview')}</p>
              <ul className="max-h-72 overflow-auto" data-testid="item-template-preview">
                {parentItemId ? (
                  tpl.data.root.children.map((c) => <Preview key={c.id} node={c} values={values} />)
                ) : (
                  <Preview node={tpl.data.root} values={values} />
                )}
              </ul>
              <p className="mt-2 text-xs text-muted">{t('itemTemplates.workdaysHint')}</p>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
};
