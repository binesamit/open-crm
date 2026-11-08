// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_STATUS_WORKFLOW,
  formatDateTime,
  isOutsideWorkflow,
  popupAsks,
  t,
  workflowStates,
  type FilterGroup,
  type StatusLabel,
  type StatusWorkflow,
  type SubitemsRule,
  type WorkflowTransition,
} from '@bines/shared';
import { Button, cn, Dialog, Field, Input, Notice, Segmented, Switch } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { confirmDialog } from '../../../lib/dialogs';
import { tagVars } from '../../../lib/label-color';
import { showToast } from '../../../lib/toast';
import {
  boardKeys,
  useBoard,
  useBoardMutations,
  useItems,
  useMembers,
  useTeams,
  type BoardDetail,
  type Column,
} from '../board-api';
import { BoardFilterEditor } from '../RelationFilterSection';
import { emptyGroup } from '../toolbar/filter-model';
import { isStub } from '../windowed';
import { CountInput, EMPTY_POPUP, PopupEditor, subitemFillable, subitemsBoardOf } from './popup';

type Version = { version: number; workflow: StatusWorkflow; created_by: string | null; created_at: string };

const keyOf = (from: number | null, to: number) => `${from ?? 'any'}-${to}`;

/** Drops empty rule lists so a saved workflow stays small and compares equal when nothing changed. */
const tidy = (wf: StatusWorkflow): StatusWorkflow => ({
  ...wf,
  transitions: wf.transitions.map((x) => {
    const out: WorkflowTransition = { from: x.from, to: x.to };
    if (x.required?.length) out.required = x.required;
    if (x.who && (x.who.users.length || x.who.teams.length)) out.who = x.who;
    if (x.conditions?.rules.length) out.conditions = x.conditions;
    if (x.message?.trim()) out.message = x.message.trim();
    if (popupAsks(x.popup)) out.popup = x.popup;
    if (x.subitems) {
      const { conditions, each, ...rule } = x.subitems;
      out.subitems = {
        ...rule,
        ...(conditions?.rules.length ? { conditions } : {}),
        ...(each?.rules.length ? { each } : {}),
      };
    }
    return out;
  }),
});

/**
 * a status column's workflow (board owners and admins): a grid of "from → to" moves (a row "any label"
 * for moves allowed from everywhere), the rules of each move (required columns, who may make it, "only if"), the
 * general switches, the items that sit on a label the workflow does not name (moved together on purpose), and the
 * saved versions with "restore".
 */
export const WorkflowDialog = ({
  accountId,
  board,
  column,
  onClose,
}: {
  accountId: string;
  board: BoardDetail;
  column: Column;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const m = useBoardMutations(accountId, board.id);
  const stored = column.settings.workflow as StatusWorkflow | undefined;
  const [draft, setDraft] = useState<StatusWorkflow>(() => stored ?? DEFAULT_STATUS_WORKFLOW);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const labels = ((column.settings.labels as StatusLabel[] | undefined) ?? [])
    .filter((l) => !l.is_deactivated)
    .sort((a, b) => a.index - b.index);
  const labelOf = (id: number | null) => labels.find((l) => l.id === id);

  const find = (from: number | null, to: number) => draft.transitions.findIndex((x) => x.from === from && x.to === to);
  const toggle = (from: number | null, to: number) => {
    const i = find(from, to);
    setDraft((d) => ({
      ...d,
      transitions: i >= 0 ? d.transitions.filter((_, j) => j !== i) : [...d.transitions, { from, to }],
    }));
    if (i < 0) setOpen(keyOf(from, to));
  };
  const patch = (from: number | null, to: number, p: Partial<WorkflowTransition>) =>
    setDraft((d) => ({
      ...d,
      transitions: d.transitions.map((x) => (x.from === from && x.to === to ? { ...x, ...p } : x)),
    }));

  const save = async () => {
    setBusy(true);
    try {
      await m.updateColumn.mutateAsync({
        columnId: column.id,
        settings: { ...column.settings, workflow: tidy(draft) },
      });
      await qc.invalidateQueries({ queryKey: versionsKey });
      showToast({ message: t('workflow.saved') });
      onClose();
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const versionsKey = [...boardKeys.board(accountId, board.id), 'workflow-versions', column.id];
  const footer = (
    <div className="flex w-full items-center justify-end gap-2">
      <Button variant="ghost" onClick={onClose}>
        {t('workflow.cancel')}
      </Button>
      <Button busy={busy} onClick={() => void save()} data-testid="workflow-save">
        {t('workflow.save')}
      </Button>
    </div>
  );

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('workflow.title', { name: column.title })}
      subtitle={t('workflow.subtitle')}
      className="max-w-4xl!"
      footer={footer}
    >
      <div className="space-y-5" data-testid="workflow-dialog">
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={draft.enabled}
            onChange={(on) => setDraft((d) => ({ ...d, enabled: on }))}
            label={t('workflow.enabled')}
            testId="workflow-enabled"
          />
          {t('workflow.enabled')}
        </label>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-heading">{t('workflow.moves')}</h3>
          <p className="text-xs text-muted">{t('workflow.movesHint')}</p>
          <div className="max-h-[22rem] overflow-auto rounded-[var(--radius)] border border-line">
            <table className="border-collapse text-sm" data-testid="workflow-grid">
              <thead>
                <tr>
                  <th className="sticky start-0 top-0 z-[2] bg-surface px-2 py-1.5 text-start text-xs font-normal text-muted">
                    {t('workflow.fromTo')}
                  </th>
                  {labels.map((l) => (
                    <th key={l.id} className="sticky top-0 z-[1] bg-surface px-1 py-1.5 font-normal">
                      <span
                        className="label-tag inline-flex rounded-[var(--radius-sm)] px-2 py-0.5 text-xs"
                        style={tagVars(l.color)}
                      >
                        {l.label || ' '}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[null, ...labels.map((l) => l.id)].map((from) => (
                  <tr key={from ?? 'any'} className="border-t border-line">
                    <th className="sticky start-0 z-[1] bg-surface px-2 py-1 text-start font-normal whitespace-nowrap">
                      {from === null ? (
                        <span className="text-xs text-muted">{t('workflow.anyLabel')}</span>
                      ) : (
                        <span
                          className="label-tag inline-flex rounded-[var(--radius-sm)] px-2 py-0.5 text-xs"
                          style={tagVars(labelOf(from)?.color)}
                        >
                          {labelOf(from)?.label || ' '}
                        </span>
                      )}
                    </th>
                    {labels.map((to) => {
                      const same = from === to.id;
                      const on = !same && find(from, to.id) >= 0;
                      return (
                        <td key={to.id} className="px-1 py-1 text-center">
                          {same ? (
                            <span className="text-muted">·</span>
                          ) : (
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={on}
                              aria-label={t('workflow.cellLabel', {
                                from: from === null ? t('workflow.anyLabel') : (labelOf(from)?.label ?? ''),
                                to: to.label,
                              })}
                              data-testid={`workflow-cell-${keyOf(from, to.id)}`}
                              onClick={() => toggle(from, to.id)}
                              className={cn(
                                'size-7 cursor-pointer rounded-[8px] border text-sm',
                                on
                                  ? 'border-primary bg-primary text-on-primary'
                                  : 'border-line-strong hover:bg-surface-2',
                              )}
                            >
                              {on ? '✓' : ''}
                            </button>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {draft.transitions.length ? (
          <section className="space-y-2">
            <h3 className="text-sm font-semibold text-heading">{t('workflow.rules')}</h3>
            <ul className="space-y-1.5" data-testid="workflow-moves">
              {draft.transitions.map((x) => {
                const k = keyOf(x.from, x.to);
                const ruled = !!(
                  x.required?.length ||
                  x.who?.users.length ||
                  x.who?.teams.length ||
                  x.conditions?.rules.length ||
                  x.message ||
                  popupAsks(x.popup) ||
                  x.subitems
                );
                return (
                  <li key={k} className="rounded-[var(--radius)] border border-line" data-testid={`workflow-move-${k}`}>
                    <button
                      type="button"
                      aria-expanded={open === k}
                      onClick={() => setOpen(open === k ? null : k)}
                      className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-start text-sm"
                    >
                      <MoveLabel label={x.from === null ? null : labelOf(x.from)} />
                      <span className="inline-block text-muted rtl:-scale-x-100">→</span>
                      <MoveLabel label={labelOf(x.to)} />
                      <span className="ms-auto text-xs text-muted">
                        {ruled ? t('workflow.hasRules') : t('workflow.noRules')}
                      </span>
                    </button>
                    {open === k ? (
                      <MoveRules
                        accountId={accountId}
                        board={board}
                        column={column}
                        move={x}
                        onChange={(p) => patch(x.from, x.to, p)}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-heading">{t('workflow.general')}</h3>
          <Toggle
            on={draft.free_start !== false}
            label={t('workflow.freeStart')}
            testId="workflow-free-start"
            onChange={(on) => setDraft((d) => ({ ...d, free_start: on }))}
          />
          <Toggle
            on={draft.allow_clear !== false}
            label={t('workflow.allowClear')}
            testId="workflow-allow-clear"
            onChange={(on) => setDraft((d) => ({ ...d, allow_clear: on }))}
          />
          <Toggle
            on={draft.allow_override !== false}
            label={t('workflow.allowOverride')}
            testId="workflow-allow-override"
            onChange={(on) => setDraft((d) => ({ ...d, allow_override: on }))}
          />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>{t('workflow.automations')}</span>
            <Segmented
              label={t('workflow.automations')}
              value={draft.automations ?? 'obey'}
              onChange={(v) => setDraft((d) => ({ ...d, automations: v }))}
              options={[
                { value: 'obey', label: t('workflow.automations.obey'), testId: 'workflow-automations-obey' },
                { value: 'bypass', label: t('workflow.automations.bypass'), testId: 'workflow-automations-bypass' },
              ]}
            />
          </div>
        </section>

        {stored && workflowStates(stored).size ? (
          <Outside accountId={accountId} board={board} column={column} workflow={stored} labels={labels} />
        ) : null}

        <Versions accountId={accountId} board={board} column={column} queryKey={versionsKey} onRestored={onClose} />
      </div>
    </Dialog>
  );
};

const MoveLabel = ({ label }: { label: StatusLabel | null | undefined }) =>
  label === null ? (
    <span className="text-xs text-muted">{t('workflow.anyLabel')}</span>
  ) : (
    <span
      className="label-tag inline-flex rounded-[var(--radius-sm)] px-2 py-0.5 text-xs"
      style={tagVars(label?.color)}
    >
      {label?.label || ' '}
    </span>
  );

const Toggle = ({
  on,
  label,
  testId,
  onChange,
}: {
  on: boolean;
  label: string;
  testId: string;
  onChange: (on: boolean) => void;
}) => (
  <label className="flex items-center gap-2 text-sm">
    <Switch checked={on} onChange={onChange} label={label} testId={testId} />
    {label}
  </label>
);

/**
 * a move's subitems rule: at least N subitems with these sub-board columns filled, optionally all of them
 * counting only the subitems that match "only if". The move then opens a popup to add and fill in subitems.
 */
const SubitemsRule = ({
  accountId,
  board,
  move,
  onChange,
}: {
  accountId: string;
  board: BoardDetail;
  move: WorkflowTransition;
  onChange: (p: Partial<WorkflowTransition>) => void;
}) => {
  const subId = subitemsBoardOf(board);
  const subBoard = useBoard(accountId, subId).data;
  const rule = move.subitems;
  const set = (p: Partial<SubitemsRule>) => onChange({ subitems: { min: 1, required: [], ...rule, ...p } });
  const columns = subitemFillable(subBoard);
  return (
    <div className="space-y-1.5" data-testid="workflow-subitems">
      <label className="flex items-center gap-2 text-xs text-fg-2">
        <Switch
          checked={!!rule}
          label={t('workflow.subitems.on')}
          testId="workflow-subitems-on"
          onChange={(on) => onChange({ subitems: on ? { min: 1, required: [] } : undefined })}
        />
        {t('workflow.subitems.on')}
      </label>
      {rule ? (
        <div className="space-y-2 ps-1">
          <p className="text-xs text-muted">{t('workflow.subitems.hint')}</p>
          <label className="flex items-center gap-2 text-xs text-fg-2">
            {t('workflow.subitems.min')}
            <CountInput
              value={rule.min}
              label={t('workflow.subitems.min')}
              testId="workflow-subitems-min"
              onChange={(min) => set({ min })}
            />
          </label>
          <div className="space-y-1">
            <p className="text-xs text-fg-2">{t('workflow.subitems.required')}</p>
            {!subId ? <p className="text-xs text-muted">{t('workflow.subitems.noSubBoard')}</p> : null}
            <div className="flex flex-wrap gap-1.5">
              {(columns.length ? columns : [{ id: 'name', title: t('popup.subitems.name') }]).map((c) => (
                <Chip
                  key={c.id}
                  on={rule.required.includes(c.id)}
                  label={c.title}
                  testId={`workflow-subitems-required-${c.id}`}
                  onClick={() => set({ required: flip(rule.required, c.id) })}
                />
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-xs text-fg-2">
            <Switch
              checked={!!rule.all}
              label={t('workflow.subitems.all')}
              testId="workflow-subitems-all"
              onChange={(all) => set({ all: all || undefined })}
            />
            {t('workflow.subitems.all')}
          </label>
          {subId ? (
            <div className="space-y-1">
              <p className="text-xs text-fg-2">{t('workflow.subitems.onlyIf')}</p>
              {rule.conditions ? (
                <>
                  <BoardFilterEditor
                    accountId={accountId}
                    boardId={subId}
                    group={rule.conditions as FilterGroup}
                    onChange={(g) => set({ conditions: g })}
                    testId="workflow-subitems-conditions"
                  />
                  <Button variant="ghost" size="sm" onClick={() => set({ conditions: undefined })}>
                    {t('workflow.removeConditions')}
                  </Button>
                </>
              ) : (
                <Button variant="ghost" size="sm" onClick={() => set({ conditions: emptyGroup() })}>
                  {t('workflow.addConditions')}
                </Button>
              )}
            </div>
          ) : null}
          {subId ? (
            <div className="space-y-1">
              <p className="text-xs text-fg-2">{t('workflow.subitems.each')}</p>
              {rule.each ? (
                <>
                  <BoardFilterEditor
                    accountId={accountId}
                    boardId={subId}
                    group={rule.each as FilterGroup}
                    onChange={(g) => set({ each: g })}
                    testId="workflow-subitems-each"
                  />
                  <Button variant="ghost" size="sm" onClick={() => set({ each: undefined })}>
                    {t('workflow.removeConditions')}
                  </Button>
                </>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="workflow-subitems-each-add"
                  onClick={() => set({ each: emptyGroup() })}
                >
                  {t('workflow.addConditions')}
                </Button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

/** A chip that is on or off (required columns, people, teams). */
const Chip = ({ on, label, onClick, testId }: { on: boolean; label: string; onClick: () => void; testId?: string }) => (
  <button
    type="button"
    aria-pressed={on}
    data-testid={testId}
    onClick={onClick}
    className={cn(
      'cursor-pointer rounded-full border px-2.5 py-0.5 text-xs',
      on ? 'border-primary bg-primary-soft text-fg' : 'border-line text-fg-2 hover:bg-surface-2',
    )}
  >
    {label}
  </button>
);

const flip = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

type WhoOption = { kind: 'user' | 'team'; id: string; name: string };
const WHO_SHOWN = 8;

/** Who may make a move: the chosen people / teams as chips (× removes), and a search that adds more. */
const WhoPicker = ({
  options,
  who,
  onChange,
}: {
  options: WhoOption[];
  who: { users: string[]; teams: string[] };
  onChange: (who: { users: string[]; teams: string[] }) => void;
}) => {
  const [q, setQ] = useState('');
  const chosen = (o: WhoOption) => (o.kind === 'team' ? who.teams : who.users).includes(o.id);
  const toggle = (o: WhoOption) =>
    onChange(o.kind === 'team' ? { ...who, teams: flip(who.teams, o.id) } : { ...who, users: flip(who.users, o.id) });
  const query = q.trim().toLocaleLowerCase();
  const matches = options
    .filter((o) => !chosen(o) && (!query || o.name.toLocaleLowerCase().includes(query)))
    .slice(0, WHO_SHOWN);
  return (
    <div className="space-y-1.5">
      {options.some(chosen) ? (
        <div className="flex flex-wrap gap-1.5" data-testid="workflow-who-chosen">
          {options.filter(chosen).map((o) => (
            <button
              key={`${o.kind}-${o.id}`}
              type="button"
              onClick={() => toggle(o)}
              aria-label={t('workflow.whoRemove', { name: o.name })}
              className="flex cursor-pointer items-center gap-1 rounded-full border border-primary bg-primary-soft px-2.5 py-0.5 text-xs"
            >
              {o.name}
              <span aria-hidden>×</span>
            </button>
          ))}
        </div>
      ) : null}
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={t('workflow.whoSearch')}
        aria-label={t('workflow.whoSearch')}
        data-testid="workflow-who-search"
        className="h-8 w-full max-w-xs rounded-[10px] border border-line-strong bg-surface px-2.5 text-sm outline-none focus:border-primary"
      />
      {matches.length ? (
        <div className="flex flex-wrap gap-1.5">
          {matches.map((o) => (
            <Chip
              key={`${o.kind}-${o.id}`}
              on={false}
              label={o.kind === 'team' ? t('workflow.whoTeam', { name: o.name }) : o.name}
              testId={`workflow-who-${o.id}`}
              onClick={() => {
                toggle(o);
                setQ('');
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
};

/** One move's rules: the columns it needs filled, who may make it, and "only if". */
const MoveRules = ({
  accountId,
  board,
  column,
  move,
  onChange,
}: {
  accountId: string;
  board: BoardDetail;
  column: Column;
  move: WorkflowTransition;
  onChange: (p: Partial<WorkflowTransition>) => void;
}) => {
  const members = useMembers(accountId).data?.data ?? [];
  const teams = useTeams(accountId).data?.data ?? [];
  const fillable = board.columns.filter((c) => c.id !== column.id && !c.read_only);
  const required = move.required ?? [];
  const who = move.who ?? { users: [], teams: [] };
  return (
    <div className="space-y-3 border-t border-line px-3 py-3" data-testid="workflow-rules">
      <div className="space-y-1.5">
        <p className="text-xs text-fg-2">{t('workflow.required')}</p>
        <div className="flex flex-wrap gap-1.5">
          {fillable.map((c) => (
            <Chip
              key={c.id}
              on={required.includes(c.id)}
              label={c.title}
              testId={`workflow-required-${c.id}`}
              onClick={() => onChange({ required: flip(required, c.id) })}
            />
          ))}
        </div>
      </div>
      <SubitemsRule accountId={accountId} board={board} move={move} onChange={onChange} />
      <div className="space-y-1.5">
        <p className="text-xs text-fg-2">{t('workflow.who')}</p>
        <p className="text-xs text-muted">{t('workflow.whoHint')}</p>
        <WhoPicker
          options={[
            ...teams.map((x) => ({ kind: 'team' as const, id: x.id, name: x.name })),
            ...members.map((x) => ({ kind: 'user' as const, id: x.user_id, name: x.name || x.email })),
          ].filter((o) => o.name.trim())}
          who={who}
          onChange={(next) => onChange({ who: next })}
        />
      </div>
      <div className="space-y-1.5">
        <p className="text-xs text-fg-2">{t('workflow.onlyIf')}</p>
        <p className="text-xs text-muted">{t('workflow.conditionsHint')}</p>
        {move.conditions ? (
          <>
            <BoardFilterEditor
              accountId={accountId}
              boardId={board.id}
              group={move.conditions as FilterGroup}
              onChange={(g) => onChange({ conditions: g })}
              testId="workflow-conditions"
            />
            <Button variant="ghost" size="sm" onClick={() => onChange({ conditions: undefined })}>
              {t('workflow.removeConditions')}
            </Button>
          </>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => onChange({ conditions: emptyGroup() })}>
            {t('workflow.addConditions')}
          </Button>
        )}
      </div>
      <Field label={t('workflow.message')}>
        <Input
          value={move.message ?? ''}
          maxLength={300}
          placeholder={t('workflow.messagePlaceholder')}
          data-testid="workflow-message"
          onChange={(e) => onChange({ message: e.target.value || undefined })}
        />
      </Field>
      <div className="space-y-1.5">
        <label className="flex items-center gap-2 text-xs text-fg-2">
          <Switch
            checked={!!move.popup}
            label={t('workflow.popup')}
            testId="workflow-popup"
            onChange={(on) => onChange({ popup: on ? EMPTY_POPUP : undefined })}
          />
          {t('workflow.popup')}
        </label>
        {move.popup ? (
          <>
            <p className="text-xs text-muted">{t('workflow.popupHint')}</p>
            <PopupEditor
              accountId={accountId}
              board={board}
              excludeColumnId={column.id}
              popup={move.popup}
              onChange={(popup) => onChange({ popup })}
            />
          </>
        ) : null}
      </div>
    </div>
  );
};

/**
 * Items on a label the saved workflow does not name stay there (nothing changes by itself); here they can be moved
 * to one of its labels together — on purpose, past the workflow, each move logged.
 */
const Outside = ({
  accountId,
  board,
  column,
  workflow,
  labels,
}: {
  accountId: string;
  board: BoardDetail;
  column: Column;
  workflow: StatusWorkflow;
  labels: StatusLabel[];
}) => {
  const m = useBoardMutations(accountId, board.id);
  const items = useItems(accountId, board.id).data;
  const states = workflowStates(workflow);
  const outsideIds = labels.filter((l) => !states.has(l.id)).map((l) => l.id);
  const loaded = (items?.data ?? []).filter((i) => !isStub(i));
  const count = loaded.filter((i) => {
    const v = (i.cells[column.id]?.value as { index?: number } | null | undefined)?.index;
    return v !== undefined && isOutsideWorkflow(workflow, v);
  }).length;
  const [target, setTarget] = useState<number | null>(null);
  if (!count) return null;
  const move = async () => {
    if (target === null) return;
    const ok = await confirmDialog({
      title: t('workflow.outside.confirmTitle'),
      message: t('workflow.outside.confirmMessage', { n: count }),
      confirmLabel: t('workflow.outside.move'),
    });
    if (!ok) return;
    m.bulkQuery.mutate(
      {
        query: {
          filter: {
            kind: 'group',
            operator: 'and',
            negate: false,
            rules: [{ kind: 'rule', column_id: column.id, operator: 'any_of', values: outsideIds, negate: false }],
          },
          sort: [],
        },
        action: { type: 'set_cell', column_id: column.id, value: { index: target }, workflow_override: true },
      } as never,
      {
        onSuccess: (r) => showToast({ message: t('workflow.outside.moved', { n: r.done }) }),
        onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
      },
    );
  };
  return (
    <section className="space-y-2" data-testid="workflow-outside">
      <h3 className="text-sm font-semibold text-heading">{t('workflow.outside.title')}</h3>
      <Notice tone="warn">
        {items?.windowed ? t('workflow.outside.countLoaded', { n: count }) : t('workflow.outside.count', { n: count })}
      </Notice>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm">{t('workflow.outside.moveTo')}</span>
        {labels
          .filter((l) => states.has(l.id))
          .map((l) => (
            <button
              key={l.id}
              type="button"
              aria-pressed={target === l.id}
              onClick={() => setTarget(l.id)}
              className={cn(
                'label-tag cursor-pointer rounded-[var(--radius-sm)] px-2 py-0.5 text-xs',
                target === l.id && 'outline-2 outline-offset-1 outline-[var(--focus-ring)]',
              )}
              style={tagVars(l.color)}
            >
              {l.label || ' '}
            </button>
          ))}
        <Button size="sm" disabled={target === null} onClick={() => void move()} data-testid="workflow-outside-move">
          {t('workflow.outside.move')}
        </Button>
      </div>
    </section>
  );
};

/** The saved versions, newest first; "restore" saves that one again as the newest. */
const Versions = ({
  accountId,
  board,
  column,
  queryKey,
  onRestored,
}: {
  accountId: string;
  board: BoardDetail;
  column: Column;
  queryKey: readonly unknown[];
  onRestored: () => void;
}) => {
  const qc = useQueryClient();
  const members = useMembers(accountId).data?.data ?? [];
  const versions = useQuery({
    queryKey,
    queryFn: () =>
      api(accountId).get<{ versions: Version[] }>(`/boards/${board.id}/columns/${column.id}/workflow-versions`),
  });
  const list = versions.data?.versions ?? [];
  if (!list.length) return null;
  const restore = async (v: Version) => {
    const ok = await confirmDialog({
      title: t('workflow.versions.restoreTitle', { n: v.version }),
      message: t('workflow.versions.restoreMessage'),
      confirmLabel: t('workflow.versions.restore'),
    });
    if (!ok) return;
    try {
      await api(accountId).post(`/boards/${board.id}/columns/${column.id}/workflow-versions/${v.version}/restore`, {});
      await qc.invalidateQueries({ queryKey: boardKeys.board(accountId, board.id) });
      showToast({ message: t('workflow.versions.restored', { n: v.version }) });
      onRestored();
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  return (
    <section className="space-y-2" data-testid="workflow-versions">
      <h3 className="text-sm font-semibold text-heading">{t('workflow.versions.title')}</h3>
      <ul className="max-h-40 space-y-1 overflow-auto">
        {list.map((v, i) => (
          <li key={v.version} className="flex items-center gap-2 text-sm">
            <span>{t('workflow.versions.item', { n: v.version })}</span>
            <span className="text-xs text-muted">
              {members.find((x) => x.user_id === v.created_by)?.name ?? ''} · {formatDateTime(v.created_at)}
            </span>
            {i === 0 ? (
              <span className="text-xs text-muted">{t('workflow.versions.current')}</span>
            ) : (
              <Button variant="ghost" size="sm" className="ms-auto" onClick={() => void restore(v)}>
                {t('workflow.versions.restore')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
};
