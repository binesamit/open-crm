// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState } from 'react';
import {
  ACTIONS,
  conditionLines,
  conditionText,
  recipeItemLevel,
  recipeParentLevel,
  scopedSentenceBoard,
  t,
  triggerDef,
  TRIGGERS,
  type ActionType,
  type Automation,
  type AutomationTestResult,
  type FilterGroup,
  type MessageKey,
  type SentenceBoard,
  type Trigger,
  type TriggerType,
} from '@bines/shared';
import { Button, Dialog, Input, Notice } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { BoardAccountContext } from '../board/board-context';
import { useBoard, useMembers, type BoardDetail } from '../board/board-api';
import { useAllBoards, useAutomationMutations, useItemSearch } from './automations-api';
import { failedConditionPart } from './recipe-draft';
import { previewFieldLabel, previewFieldText, type DisplayEnv } from './slot-display';

/**
 * "Run a test" (04 §8.4): pick an item → preview (conditions + every action rendered, nothing written) →
 * optionally run it for real once.
 */
export const TestDialog = ({
  board,
  automation,
  onClose,
}: {
  board: BoardDetail;
  automation: Automation;
  onClose: () => void;
}) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const m = useAutomationMutations(accountId, board.id);
  const needsItem = triggerDef(automation.recipe.trigger).hasItem(automation.recipe.trigger as never);
  const [q, setQ] = useState('');
  const [item, setItem] = useState<{ id: string; name: string } | null>(null);
  const [preview, setPreview] = useState<AutomationTestResult | null>(null);
  const hits = useItemSearch(accountId, board.id, q);
  // The conditions in words, to say which part failed (r16: "and" / "or" and nested groups).
  const subColumns = useBoard(accountId, board.subitems_board_id ?? '').data?.columns ?? [];
  const sb = scopedSentenceBoard(
    {
      columns: board.columns.map((c) => ({ key: c.id, title: c.title, type: c.type })),
      subColumns: subColumns.map((c) => ({ key: c.id, title: c.title, type: c.type })),
      groups: board.groups,
    } satisfies SentenceBoard,
    automation.recipe.trigger,
  );
  const conditions = automation.recipe.conditions as FilterGroup | undefined;
  // r27: the preview's fields by name (groups, people refs, columns, labels), like the builder's sentence.
  const members = useMembers(accountId).data?.data;
  const boards = useAllBoards(accountId);
  const trigger = automation.recipe.trigger as unknown as Trigger;
  const known = !!TRIGGERS[trigger.type as TriggerType];
  const itemLevel = known ? recipeItemLevel(trigger) : 'main';
  const parentLevel = known ? recipeParentLevel(trigger) : null;
  const at = (l: 'main' | 'sub' | null) => (l === 'sub' ? subColumns : l === 'main' ? board.columns : []);
  const displayEnv: DisplayEnv = {
    itemColumns: itemLevel === 'sub' && subColumns.length ? subColumns : board.columns,
    parentColumns: at(parentLevel),
    subColumns: board.subitems_board_id ? subColumns : [],
    mainColumns: board.columns,
    groups: board.groups,
    personName: (id) => {
      const x = members?.find((mb) => mb.user_id === id);
      return x ? x.name || x.email : undefined;
    },
  };
  const columnsOfAction = (type: string) => {
    const def = ACTIONS[type as ActionType];
    if (def?.columnOn === 'parent') return at(parentLevel);
    if (def?.columnOn === 'subitems') return subColumns;
    return itemLevel === 'sub' ? subColumns : undefined;
  };
  const boardName = (id: string) => boards.find((b) => b.id === id)?.name;

  const run = (dry: boolean) =>
    m.test.mutate(
      { id: automation.id, item_id: item?.id, dry_run: dry },
      {
        onSuccess: (r) => {
          if (dry) setPreview(r);
          else {
            showToast({ message: t('auto.test.ran') });
            onClose();
          }
        },
      },
    );

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('auto.test.title', { title: automation.title })}
      className="max-w-[720px]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            variant="secondary"
            busy={m.test.isPending}
            disabled={needsItem && !item}
            onClick={() => run(true)}
            data-testid="auto-test-preview"
          >
            {t('auto.test.preview')}
          </Button>
          <Button
            busy={m.test.isPending}
            disabled={needsItem && !item}
            onClick={() => run(false)}
            data-testid="auto-test-run"
          >
            {t('auto.test.run')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3.5" data-testid="automation-test-dialog">
        {needsItem ? (
          <section className="space-y-2">
            <h3 className="text-xs font-semibold text-fg-2">{t('auto.test.item')}</h3>
            {item ? (
              <p className="text-sm">
                <span className="font-medium" data-testid="auto-test-item">
                  {item.name}
                </span>{' '}
                <button type="button" className="text-xs text-muted underline" onClick={() => setItem(null)}>
                  {t('auto.test.change')}
                </button>
              </p>
            ) : (
              <>
                <Input
                  autoFocus
                  value={q}
                  placeholder={t('auto.test.search')}
                  onChange={(e) => setQ(e.target.value)}
                  data-testid="auto-test-search"
                />
                <ul className="max-h-48 overflow-y-auto">
                  {(hits.data?.data ?? []).slice(0, 20).map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        className="w-full rounded-[8px] px-2.5 py-1.5 text-start text-sm hover:bg-surface-2"
                        data-testid="auto-test-hit"
                        data-name={h.name}
                        onClick={() => {
                          setItem(h);
                          setPreview(null);
                        }}
                      >
                        {h.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        ) : null}

        {m.test.isError ? <Notice tone="error">{errorMessage(m.test.error)}</Notice> : null}

        {preview ? (
          <section className="space-y-2" data-testid="auto-test-result">
            <p
              className={
                preview.conditions.matched ? 'text-sm font-semibold text-ok-fg' : 'text-sm font-semibold text-danger-fg'
              }
              data-testid="auto-test-conditions"
              data-matched={preview.conditions.matched ? 'true' : 'false'}
            >
              {preview.conditions.matched ? t('auto.test.matched') : t('auto.test.not_matched')}
            </p>
            {conditions?.rules.length ? (
              <FailedConditions
                conditions={conditions}
                matched={preview.conditions.matched}
                failedRule={preview.conditions.failed_rule}
                sb={sb}
              />
            ) : null}
            <ol className="space-y-2">
              {preview.actions.map((a) => (
                <li
                  key={a.index}
                  className="rounded-[12px] border border-line p-3 text-sm"
                  data-testid="auto-test-action"
                >
                  <p className="font-semibold">{t(`auto.kind.${a.type}` as MessageKey)}</p>
                  {a.skipped ? <p className="text-xs text-muted">{t('auto.test.not_available')}</p> : null}
                  <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 text-xs">
                    {Object.entries(a.rendered).map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-muted">{previewFieldLabel(k)}</dt>
                        <dd className="whitespace-pre-wrap break-words" data-testid="auto-test-rendered" data-field={k}>
                          {previewFieldText(
                            { ...a.rendered, type: a.type },
                            k,
                            displayEnv,
                            columnsOfAction(a.type),
                            boardName,
                          ) || (typeof v === 'string' ? v : JSON.stringify(v))}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ol>
          </section>
        ) : null}
      </div>
    </Dialog>
  );
};

/** The conditions in words and, when they failed, the part that failed (a rule or a whole group). */
const FailedConditions = ({
  conditions,
  matched,
  failedRule,
  sb,
}: {
  conditions: FilterGroup;
  matched: boolean;
  failedRule: string | null;
  sb: SentenceBoard;
}) => {
  const part = matched ? null : failedConditionPart(conditions, failedRule);
  const lines = conditionLines(conditions, sb);
  return (
    <div className="space-y-1 text-xs" data-testid="auto-test-condition-detail">
      <p className="text-muted" data-testid="auto-test-condition-text">
        {t('auto.test.conditions_text', { text: conditionText(conditions, sb) })}
      </p>
      {matched ? null : part === 'none_or' ? (
        <p className="font-semibold text-danger-fg" data-testid="auto-test-failed" data-part="none_or">
          {t('auto.test.failed_none_or')}
        </p>
      ) : typeof part === 'number' ? (
        <p
          className="font-semibold text-danger-fg"
          data-testid="auto-test-failed"
          data-part={String(part)}
          data-kind={conditions.rules[part]!.kind}
        >
          {t('auto.test.failed_at', { part: lines[part] ?? '' })}
        </p>
      ) : failedRule === 'group' ? (
        <p className="font-semibold text-danger-fg" data-testid="auto-test-failed" data-part="group">
          {t('auto.test.failed_at', { part: t('auto.test.failed_group') })}
        </p>
      ) : null}
    </div>
  );
};
