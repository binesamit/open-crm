// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useMemo, useState, type ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  ACTIONS,
  actionSentence,
  conditionText,
  PLAN_FEATURE_ACTIONS,
  recipeItemLevel,
  recipeParentLevel,
  scopedSentenceBoard,
  t,
  TRIGGERS,
  triggerSentence,
  type Action,
  type ActionType,
  type Automation,
  type DraftRecipe,
  type ItemTemplateSummary,
  type FilterGroup,
  type FilterRule,
  type MessageKey,
  type SentenceBoard,
  type SentencePart,
  type Trigger,
  type TriggerType,
  tDynamic,
  type ComputedPreviewResult,
} from '@bines/shared';
import { Button, Card, cn, Dialog, Input, Menu, type MenuEntry, Notice, Switch, useActionMenu } from '@bines/ui';
import { useSmsStatus } from '../phone/phone-api';
import { Icon } from '../../lib/icons';
import { columnTypeLabel } from '../../lib/locale';
import { ApiError } from '@bines/sdk';
import { errorMessage } from '../../lib/api';
import { BoardAccountContext } from '../board/board-context';
import type { BoardDetail, Member } from '../board/board-api';
import { Popover } from '../board/cells/Popover';
import { FilterGroupEditor, type FilterCtx } from '../board/toolbar/FilterPanel';
import { PickerButton } from '../board/toolbar/parts';
import { useAllBoards, useAutomationMutations } from './automations-api';
import { api } from '../../lib/api';
import { boardKeys, useBoard } from '../board/board-api';
import { useAgents } from '../agents/agents-api';
import { useIdocTemplates } from '../idocs/idocs-api';
import { itemTemplateKeys } from '../item-templates/item-templates-api';
import { TemplateActionFields } from './TemplateActionFields';
import { Segments, SlotEditor, type SlotTarget } from './SlotEditor';
import { slotDisplay, type DisplayEnv, type Segment } from './slot-display';
import { MappingEditor } from './MappingEditor';
import { copyText } from '../../lib/entity-menu';
import { useExtensionBlocks } from '../extensions/extensions-api';
import { blockTitle, ExtensionBlockFields, ExtensionTriggerInputs } from './ExtensionBlockFields';
import { usePlanGates } from '../../lib/plan-gate';
import { gateMenuEntry, planUpgradeMenuEntries } from '../../lib/plan-limit';
import { useNavigate } from '@tanstack/react-router';
import { firstConditions, pruneConditions } from './recipe-draft';
import { actionSections, columnSections, triggerSections } from './scopes';
import { useFlowTriggerNames } from './flow-trigger';

/**
 * The sentence builder (04 §8.1): one trigger, "only if" rules (the filter model), then actions. Every blank
 * is a chip that opens its editor; the server validates on save and its issues outline the chips.
 */
type Issue = { path: string; code: string; detail?: string };

/** Defaults a new trigger / action of a type needs to read as a sentence. */
const TRIGGER_DEFAULTS: Partial<Record<TriggerType, Record<string, unknown>>> = {
  status_changed: { labels: 'any' },
  subitem_status_changed: { labels: 'any', all_subitems: false },
  date_arrived: { offset_days: 0, time: '09:00' },
  date_arrives_before: { days: 1, time: '09:00' },
  every_time_period: { period: 'day', time: '09:00', scope: 'each_item' },
  item_moved_to_group: { group: 'any' },
  checkbox_checked: { state: 'checked' },
  person_assigned: { who: 'any' },
  number_threshold: { operator: 'greater_than', value: 0 },
  flow_failed: { connection: 'any' },
  flow_recovered: { connection: 'any' },
};
const ACTION_DEFAULTS: Partial<Record<ActionType, Record<string, unknown>>> = {
  set_date: { value: 'today' },
  increment_number: { by: 1 },
  assign: { who: '@creator', mode: 'add' },
  unassign: { who: 'all' },
  notify: { to: '@board_owners', message: '{item.name}' },
  send_email: { subject: '{item.name}', body_html: '' },
  webhook: { url: '', method: 'POST', payload: 'item' },
  create_item: { board: '@self', name: '{item.name}' },
  create_subitem: { name: '{item.name}' },
  create_item_from_template: { board: '@self' },
  add_template_subitems: {},
  duplicate_item: { with_updates: false },
  create_update: { body: '' },
  send_document: { send: true },
  send_sms: { message: '' },
  connect_items: { target: 'created' },
  copy_from_linked: { source: 'name' },
  set_computed: {},
  run_agent: { prompt: '{item.name}' },
  generate_image: { prompt: '{item.name}' },
  send_to_integrations: {},
  // Whose timer: new timer actions act for whoever made the change.
  start_time_tracking: { who: '@actor' },
  stop_time_tracking: { who: '@actor' },
};

const issueAt = (issues: Issue[], slot: string | undefined) =>
  !!slot && issues.some((i) => i.path === slot || i.path.startsWith(`${slot}.`));

/**
 * A blank of the recipe: a neutral picker chip with a trailing chevron, like the system's other pickers (audit
 * 2026-10-10 ux #18 — amber is for the one main action, and six amber blanks in a sentence left no focal point).
 */
const chipCls =
  'inline-flex h-[2.125rem] items-center gap-1 rounded-[10px] border border-line-strong bg-surface px-3 text-[0.875rem] text-heading hover:border-primary';
const Chevron = () => <Icon name="chevronDown" size={14} className="shrink-0 opacity-70" />;

/** A chip that opens a menu (the trigger type, "+ action"). */
const MenuChip = ({
  label,
  menuLabel,
  items,
  testId,
  variant = 'chip',
}: {
  label: ReactNode;
  menuLabel: string;
  items: MenuEntry[];
  testId?: string;
  variant?: 'chip' | 'dashed';
}) => {
  const menu = useActionMenu();
  return (
    <>
      {variant === 'chip' ? (
        <button type="button" aria-haspopup="menu" data-testid={testId} onClick={menu.fromTrigger} className={chipCls}>
          {label}
          <Chevron />
        </button>
      ) : (
        <Button variant="dashed" size="sm" aria-haspopup="menu" data-testid={testId} onClick={menu.fromTrigger}>
          {label}
        </Button>
      )}
      <Menu at={menu.at} onClose={menu.close} items={items} label={menuLabel} />
    </>
  );
};

/** "+ x" → a plus icon and "x" (F4 buttons carry the icon, not the glyph). */
const plusLabel = (text: string) => (
  <>
    <Icon name="plus" size={15} />
    {text.replace(/^\+\s*/, '')}
  </>
);

/** One line of the recipe: a 64px word (מתי / ורק אם / אז), then its chips. */
const RecipeRow = ({ word, children, testId }: { word?: string; children: ReactNode; testId?: string }) => (
  <div className="flex items-start gap-2" data-testid={testId}>
    <span className="w-16 shrink-0 pt-[0.4375rem] font-display text-[0.9375rem] font-bold text-heading">{word}</span>
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
  </div>
);

/** A sentence part, with how its blank reads in the builder (r18board 5: names and variable chips). */
type ShownPart = SentencePart & { segs?: Segment[] | null };

const Sentence = ({
  parts: given,
  issues,
  onOpen,
  open,
  editor,
}: {
  parts: ShownPart[];
  issues: Issue[];
  onOpen: (slot: string) => void;
  open: string | null;
  editor: (slot: string) => React.ReactNode;
}) => {
  const chip = (p: ShownPart, i: number) => (
    <span key={i} className="relative inline-flex">
      <button
        type="button"
        data-testid="slot"
        data-slot={p.slot}
        data-empty={p.empty ? 'true' : undefined}
        onClick={() => onOpen(p.slot!)}
        className={cn(
          chipCls,
          issueAt(issues, p.slot)
            ? 'bg-danger-soft text-danger-fg ring-2 ring-[var(--danger)]'
            : p.empty
              ? 'text-muted'
              : undefined,
        )}
      >
        {p.segs && !p.empty ? (
          <span className="inline-flex items-center" data-testid="slot-readable">
            <Segments segs={p.segs} />
          </span>
        ) : (
          p.text
        )}
        <Chevron />
      </button>
      {open === p.slot ? editor(p.slot) : null}
    </span>
  );
  // Each chip is one nowrap unit with the last word before it and any punctuation after it, so a ":" or a
  // lone word never ends up alone at a line edge on a phone.
  const parts = [...given];
  const out: ReactNode[] = [];
  let pending = ''; // text before the next chip (its last word joins the chip)
  const flushText = (text: string, key: string) => {
    if (text.trim()) out.push(<span key={key}>{text.trim()}</span>);
  };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (!p.slot) {
      pending += p.text;
      continue;
    }
    const m = /^(.*?)(\S*)\s*$/s.exec(pending)!;
    flushText(m[1]!, `t${i}`);
    pending = '';
    const next = parts[i + 1];
    const punct = next && !next.slot ? /^\s*([:,.;!?)\]]+)/.exec(next.text) : null;
    if (punct) parts[i + 1] = { ...next!, text: next!.text.slice(punct[0].length) };
    out.push(
      <span key={i} className="inline-flex items-center gap-2 whitespace-nowrap">
        {m[2] ? <span>{m[2]}</span> : null}
        <span className="inline-flex items-center gap-0.5">
          {chip(p, i)}
          {punct ? <span>{punct[1]}</span> : null}
        </span>
      </span>,
    );
  }
  flushText(pending, 'end');
  return <>{out}</>;
};

/** The trigger's sentence without the words its type chip already says ("כשנוצר פריט" chip + "כשנוצר פריט"). */
const withoutKindPrefix = (parts: SentencePart[], kind: string): SentencePart[] => {
  const [first, ...rest] = parts;
  if (!first || first.slot || !first.text.trim().startsWith(kind.trim())) return parts;
  const left = first.text.trim().slice(kind.trim().length).trim();
  return left ? [{ ...first, text: left }, ...rest] : rest;
};

export const Builder = ({
  board,
  members,
  filterCtx,
  initial,
  existing,
  onClose,
  onSaved,
  lockedTriggerInputs,
  single,
}: {
  board: BoardDetail;
  members: Member[];
  filterCtx: FilterCtx;
  initial: DraftRecipe;
  existing?: Automation;
  onClose: () => void;
  /** After a save (before `onClose`): the automation as saved (`openAutomationBuilder` answers it). */
  onSaved?: (saved: { id: string }) => void;
  /** an extension trigger's inputs its page prefilled — shown, not editable. */
  lockedTriggerInputs?: string[];
  /**
   * phase 3: one block of a scenario — only its trigger, or only its one action (the trigger scopes the
   * columns) — with the same editors; "apply" hands the draft back instead of saving an automation.
   */
  single?: {
    kind: 'trigger' | 'action';
    onApply: (draft: DraftRecipe) => void;
    triggers?: ReadonlySet<string>;
    excludedActions?: ReadonlySet<string>;
  };
}) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const planGate = usePlanGates(accountId);
  const navigate = useNavigate();
  const boards = useAllBoards(accountId);
  const m = useAutomationMutations(accountId, board.id);
  const [draft, setDraft] = useState<DraftRecipe>(() => structuredClone(initial));
  const [title, setTitle] = useState(existing?.title ?? '');
  const [open, setOpen] = useState<string | null>(null);
  const [mappingOf, setMappingOf] = useState<number | null>(null);
  const [templateOf, setTemplateOf] = useState<number | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Save was pressed with no action: the "then" line turns red until one is added.
  const [noActions, setNoActions] = useState(false);
  // run_agent: the agents I manage; copy_from_linked: the columns of the boards its relations link to.
  const agentList = useAgents(accountId).data?.data;
  const agents = useMemo(() => (agentList ?? []).map((x) => ({ id: x.id, name: x.name })), [agentList]);
  // send_document: the board's interactive document templates.
  const idocList = useIdocTemplates(accountId, board.id).data;
  const idocTemplates = useMemo(() => (idocList ?? []).map((x) => ({ id: x.id, name: x.name })), [idocList]);
  // D14: subitem triggers and parent / subitem actions read the sub-board's columns.
  const subColumns = useBoard(accountId, board.subitems_board_id ?? '').data?.columns ?? [];
  // A relation of the board or (a subitem trigger) of the sub-board.
  const linkedBoardOf = (relation: unknown) =>
    (
      [...board.columns, ...subColumns].find((c) => c.id === relation && c.type === 'board_relation')?.settings as
        { board_ids?: string[] } | undefined
    )?.board_ids?.[0];
  // set_computed: the columns of every board the item's relations link to, for its picker.
  const computedRelations = draft.actions.some((a) => a.type === 'set_computed')
    ? [...board.columns, ...subColumns].filter((c) => c.type === 'board_relation').map((c) => c.id)
    : [];
  const linkedIds = [
    ...new Set([
      ...draft.actions.flatMap((a) => (a.type === 'copy_from_linked' ? [linkedBoardOf(a.relation)] : [])),
      ...computedRelations.map(linkedBoardOf),
    ]),
  ].filter((x): x is string => !!x);
  const linked = useQueries({
    queries: linkedIds.map((id) => ({
      queryKey: boardKeys.board(accountId, id),
      queryFn: () => api(accountId).get<BoardDetail>(`/boards/${id}`),
    })),
  });
  const linkedColumns = (relation: unknown) => {
    const id = linkedBoardOf(relation);
    return linked.find((q) => q.data?.id === id)?.data?.columns;
  };
  // Item templates (phase 2): this board's, and those of the boards template actions create on.
  const templateBoardOf = (a: DraftRecipe['actions'][number]) =>
    a.type === 'create_item_from_template' && typeof a.board === 'string' && a.board !== '@self' ? a.board : board.id;
  const templateBoardIds = [
    ...new Set([
      board.id,
      ...draft.actions.flatMap((a) => (a.type === 'create_item_from_template' ? [templateBoardOf(a)] : [])),
    ]),
  ];
  const templateLists = useQueries({
    queries: templateBoardIds.map((id) => ({
      queryKey: itemTemplateKeys.list(accountId, id),
      queryFn: async () =>
        (await api(accountId).get<{ data: ItemTemplateSummary[] }>(`/boards/${id}/item-templates`)).data,
      staleTime: 30_000,
    })),
  });
  const itemTemplatesOf = (boardId: string) =>
    templateLists[templateBoardIds.indexOf(boardId)]?.data ?? ([] as ItemTemplateSummary[]);
  const allItemTemplates = templateLists.flatMap((q) => q.data ?? []);
  // The boards template actions create on (their groups and relation columns, for the settings popover).
  const targetIds = templateBoardIds.filter((id) => id !== board.id);
  const targets = useQueries({
    queries: targetIds.map((id) => ({
      queryKey: boardKeys.board(accountId, id),
      queryFn: () => api(accountId).get<BoardDetail>(`/boards/${id}`),
    })),
  });
  const targetBoard = (id: string) =>
    id === board.id ? board : (targets.find((q) => q.data?.id === id)?.data ?? null);
  // Installed extensions' blocks on this board (D27 ת4): offered by name, with their own forms.
  const blocks = useExtensionBlocks(accountId, board.id).data;
  const blockName = (block: string) => {
    const b = blocks?.actions.find((x) => x.block === block) ?? blocks?.triggers.find((x) => x.block === block);
    return b ? blockTitle(b) : undefined;
  };

  // send_sms: the account's saved SMS texts, for the message blank and the sentence.
  const smsTemplates = useSmsStatus(
    accountId,
    draft.actions.some((a) => a.type === 'send_sms'),
  ).data?.templates;
  // a flow trigger's connection / flow names and its `{flow.*}` variables.
  const flowNames = useFlowTriggerNames(accountId, draft.trigger as Record<string, unknown>);
  const sub = subColumnsOf(board, subColumns, draft);
  const sbBoard: SentenceBoard = {
    subColumns: subColumns.map((c) => ({ key: c.id, title: c.title, type: c.type })),
    subLevels: board.hierarchy_depth_max > 1,
    columns: board.columns.map((c) => ({ key: c.id, title: c.title, type: c.type })),
    groups: board.groups,
    boardName: (id) => boards.find((b) => b.id === id)?.name,
    personName: (id) => members.find((x) => x.user_id === id)?.name,
    agentName: (id) => agents.find((x) => x.id === id)?.name,
    idocTemplateName: (id) => idocTemplates.find((x) => x.id === id)?.name,
    itemTemplateName: (id) => allItemTemplates.find((x) => x.id === id)?.name,
    linkedColumnTitle: (relation, key) => linkedColumns(relation)?.find((c) => c.id === key)?.title,
    linkedColumns: (relation) => linkedColumns(relation)?.map((c) => ({ key: c.id, title: c.title, type: c.type })),
    extensionBlockName: blockName,
    smsTemplateName: (id) => smsTemplates?.find((x) => x.id === id)?.name,
    ...flowNames.sentence,
    // notifyfix: "מנהל של Projects" for a parent people column picked from a subitem trigger.
    parentBoardName: board.name,
  };
  const sb = scopedSentenceBoard(sbBoard, draft.trigger as unknown as Trigger);
  // r18board 5: the run item's columns (a subitem trigger's item is a subitem) and its parent's.
  const itemColumns = sub.itemLevel === 'sub' && subColumns.length ? subColumns : board.columns;
  const parentColumns = sub.parentLevel === 'sub' ? subColumns : sub.parentLevel === 'main' ? board.columns : [];
  const displayEnv: DisplayEnv = {
    itemColumns,
    parentColumns,
    subColumns: board.subitems_board_id ? subColumns : [],
    mainColumns: board.columns,
    groups: board.groups,
    personName: (id) => {
      const x = members.find((mb) => mb.user_id === id);
      return x ? x.name || x.email : undefined;
    },
  };
  /** Each blank as people read it: column titles, names, labels, `{variables}` as chips. */
  const shown = (parts: SentencePart[]): ShownPart[] =>
    parts.map((p) => {
      if (!p.slot || p.empty) return p;
      const target = slotTarget(p.slot);
      if (!target.owner) return p;
      const own = sub.columnsOf(target, 'column');
      return { ...p, segs: slotDisplay(target.owner, target.field, displayEnv, own) };
    });
  const ctx = {
    board,
    boards,
    members,
    agents,
    idocTemplates,
    itemTemplatesOf: (owner: SlotTarget['owner']) => itemTemplatesOf(templateBoardOf(owner as never)),
    linkedColumns,
    columnsOf: sub.columnsOf,
    // r17ui: column blanks list every level the run reaches (item / subitems / parent), in sections.
    columnSections: (s: SlotTarget) =>
      columnSections(s.owner.type, s.isTrigger, {
        itemLevel: sub.itemLevel,
        parentLevel: sub.parentLevel,
        main: board.columns,
        sub: board.subitems_board_id ? subColumns : [],
        subLevels: board.hierarchy_depth_max > 1,
      }),
    extraVariables: [...sub.variables, ...flowNames.variables],
    smsTemplates,
    itemColumns,
    // generate_image's style examples: the run item's board, for the filter of "which items".
    accountId,
    itemBoardId: sub.itemLevel === 'sub' && board.subitems_board_id ? board.subitems_board_id : board.id,
    itemColumnsLabel: t(sub.itemLevel === 'sub' ? 'auto.cols.subitem' : 'auto.cols.item'),
    // notifyfix: a subitem run also reaches its parent's people columns (the engine reads the parent's cell).
    // Any subitem level: the engine climbs up to 3 ancestors to the board that has the column (notifyfix2).
    parentColumns: sub.itemLevel === 'sub' ? board.columns : undefined,
    parentColumnsLabel: t('auto.picker.parent_board_people', { board: board.name }),
    displayEnv,
    // set_computed: the run item's columns, its parent's and its linked items', by name; the preview.
    computed: {
      env: {
        item: itemColumns.map((c) => ({ id: c.id, title: c.title })),
        parent: parentColumns.map((c) => ({ id: c.id, title: c.title })),
        relations: itemColumns
          .filter((c) => c.type === 'board_relation')
          .map((r) => {
            const cols = linkedColumns(r.id);
            return {
              id: r.id,
              title: r.title,
              ...(cols ? { columns: cols.map((c) => ({ id: c.id, title: c.title })) } : {}),
            };
          }),
      },
      preview: (body: { expression: string; column?: string; round?: number }) =>
        api(accountId).post<ComputedPreviewResult>(`/boards/${board.id}/automations/computed-preview`, {
          ...body,
          level: sub.itemLevel === 'sub' ? 'sub' : 'main',
        }),
    },
  };

  const triggerParts = withoutKindPrefix(
    triggerSentence(draft.trigger as unknown as Trigger, sb),
    t(`auto.kind.${draft.trigger.type}` as MessageKey),
  );
  const conditions = (draft.conditions as FilterGroup | undefined) ?? undefined;
  // A board-level run (no trigger item): template questions cannot be answered from an item.
  const triggerDef = TRIGGERS[draft.trigger.type as TriggerType];
  const boardLevelTrigger = triggerDef ? !triggerDef.hasItem(draft.trigger as never) : false;

  const setTriggerType = (type: TriggerType) =>
    setDraft((d) => ({ ...d, trigger: { type, ...(TRIGGER_DEFAULTS[type] ?? {}) } }));
  const patchOwner = (slot: string, patch: Record<string, unknown>) =>
    setDraft((d) => {
      const [where, idx] = slot.split('.');
      const clean = (o: Record<string, unknown>) =>
        Object.fromEntries(Object.entries({ ...o, ...patch }).filter(([, v]) => v !== undefined));
      if (where === 'trigger') return { ...d, trigger: clean(d.trigger) as DraftRecipe['trigger'] };
      const i = Number(idx);
      return { ...d, actions: d.actions.map((a, j) => (j === i ? (clean(a) as DraftRecipe['actions'][number]) : a)) };
    });
  const slotTarget = (slot: string): SlotTarget => {
    const [where, idx, field] = slot.split('.');
    return where === 'trigger'
      ? { owner: draft.trigger, field: idx!, isTrigger: true }
      : { owner: draft.actions[Number(idx)]!, field: field!, isTrigger: false };
  };
  const editor = (slot: string) => (
    <Popover open onClose={() => setOpen(null)} className="p-3">
      {/^actions\.\d+\.block$/.test(slot) ? (
        // Another of the extensions' actions (its form starts empty).
        <ul className="flex max-h-72 w-64 flex-col gap-1 overflow-y-auto [&>*]:shrink-0" data-testid="auto-ext-blocks">
          {(blocks?.actions ?? []).map((b) => (
            <li key={b.block}>
              <button
                type="button"
                className="w-full truncate rounded px-2 py-1 text-start text-sm hover:bg-surface-2"
                onClick={() => {
                  patchOwner(slot, { block: b.block, input: {} });
                  setOpen(null);
                }}
              >
                {blockTitle(b)}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <SlotEditor
          slot={slotTarget(slot)}
          ctx={ctx}
          onSet={(patch) => {
            patchOwner(slot, patch);
            // Multi-choice editors stay open (the style examples' settings, a trigger's columns and a computed
            // value's options too); single choices close.
            if (!['labels', 'style_examples', 'columns', 'round', 'on_empty'].some((k) => k in patch)) setOpen(null);
          }}
        />
      )}
    </Popover>
  );

  // r16: "only if" is the board filter's group editor — "and" / "or", nested groups (up to the filter's depth) and
  // "not". The tree is kept as it is while editing; empty groups are dropped on save (pruneConditions).
  const setConditions = (g: FilterGroup | undefined) =>
    setDraft((d) => ({ ...d, conditions: g?.rules.length ? g : undefined }));
  const firstColumn = itemColumns.find((c) => c.type !== 'name') ?? itemColumns[0]!;
  const makeRule = (): FilterRule => ({
    kind: 'rule',
    column_id: firstColumn.id,
    operator: 'is_not_empty',
    values: [],
    negate: false,
  });
  const conditionsLine = conditionText(conditions, sb);

  const save = async (activate: boolean) => {
    setError(null);
    setIssues([]);
    // Nothing to do yet: say so next to "+ action" instead of a server error about a missing field.
    if (!draft.actions.length) {
      setNoActions(true);
      return;
    }
    const recipe: DraftRecipe = { ...draft, conditions: pruneConditions(conditions) };
    if (!recipe.conditions) delete recipe.conditions;
    const body = { title: title.trim() || undefined, recipe, is_active: activate };
    try {
      const saved = existing
        ? await m.update.mutateAsync({
            id: existing.id,
            revision: existing.revision,
            body: { ...body, is_active: activate || existing.is_active },
          })
        : await m.create.mutateAsync(body);
      onSaved?.({ id: saved.id });
      onClose();
    } catch (e) {
      const details = e instanceof ApiError ? (e.body.details as { issues?: Issue[] } | undefined) : undefined;
      if (details?.issues?.length) setIssues(details.issues);
      setError(errorMessage(e));
    }
  };
  const busy = m.create.isPending || m.update.isPending;
  const addAction = (action: DraftRecipe['actions'][number]) => {
    setNoActions(false);
    setDraft((d) => ({ ...d, actions: [...d.actions, action] }));
  };

  // Extension blocks are offered per installed extension, by name — never as a bare "extension" type.
  const triggerTypes = (Object.keys(TRIGGERS) as TriggerType[]).filter(
    (k) =>
      TRIGGERS[k].available !== false && k !== 'extension_trigger' && (!single?.triggers || single.triggers.has(k)),
  );
  const actionTypes = (Object.keys(ACTIONS) as ActionType[]).filter(
    (k) => ACTIONS[k].available !== false && k !== 'run_extension' && !single?.excludedActions?.has(k),
  );
  const apply = () => {
    if (single?.kind === 'action' && !draft.actions.length) {
      setNoActions(true);
      return;
    }
    single?.onApply(draft);
    onClose();
  };
  const showTrigger = single?.kind !== 'action';
  const showActions = single?.kind !== 'trigger';
  // Plan feature gates: the actions in PLAN_FEATURE_ACTIONS stay listed, disabled with the hint.
  const actionGate = (type: string) => {
    const feature = PLAN_FEATURE_ACTIONS[type];
    return feature ? planGate(feature) : undefined;
  };
  const extTriggerEntries: MenuEntry[] = (blocks?.triggers ?? []).map((b) => ({
    label: blockTitle(b),
    testId: `auto-ext-trigger-${b.block}`,
    checked: draft.trigger.type === 'extension_trigger' && draft.trigger.block === b.block,
    onSelect: () =>
      setDraft((d) => ({ ...d, trigger: { type: 'extension_trigger', block: b.block, with_item: false } })),
  }));
  const extActionEntries: MenuEntry[] = (blocks?.actions ?? []).map((b) => ({
    label: blockTitle(b),
    testId: `auto-ext-action-${b.block}`,
    onSelect: () => addAction({ type: 'run_extension', block: b.block, input: {} }),
  }));
  const extTriggerName =
    draft.trigger.type === 'extension_trigger' ? blockName(String(draft.trigger.block ?? '')) : undefined;

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        single
          ? t(single.kind === 'trigger' ? 'scenario.editTrigger' : 'scenario.editAction')
          : existing
            ? t('auto.builder.edit')
            : t('auto.builder.new')
      }
      subtitle={board.name}
      className="max-w-[720px]"
      footer={
        single ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="accent" onClick={apply} data-testid="auto-apply">
              {t('scenario.apply')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant="secondary" busy={busy} onClick={() => void save(false)} data-testid="auto-save-inactive">
              {t('auto.builder.save_inactive')}
            </Button>
            <Button variant="accent" busy={busy} onClick={() => void save(true)} data-testid="auto-save">
              {t('auto.builder.save_active')}
            </Button>
          </>
        )
      }
    >
      <div className="flex flex-col gap-3.5" data-testid="automation-builder">
        <Card soft className="flex flex-col gap-3.5 text-[0.9375rem]">
          {showTrigger ? (
            <RecipeRow word={t('auto.builder.when')} testId="auto-trigger">
              <MenuChip
                testId="auto-trigger-type"
                menuLabel={t('auto.builder.trigger')}
                label={extTriggerName ?? t(`auto.kind.${draft.trigger.type}` as MessageKey)}
                items={[
                  // r17ui: in sections — subitem triggers ("when a subitem's column changes"…) in their own.
                  ...triggerSections(triggerTypes).flatMap(({ section, types }): MenuEntry[] => [
                    { kind: 'label', label: t(`auto.category.${section}`) },
                    ...types.map((k): MenuEntry => ({
                      label: t(`auto.kind.${k}` as MessageKey),
                      checked: k === draft.trigger.type,
                      testId: `auto-trigger-${k}`,
                      onSelect: () => setTriggerType(k),
                    })),
                  ]),
                  ...(extTriggerEntries.length
                    ? [{ kind: 'label', label: t('ext.auto.fromExtensions') } as MenuEntry, ...extTriggerEntries]
                    : []),
                ]}
              />
              {draft.trigger.type === 'extension_trigger' ? (
                <>
                  <label className="inline-flex items-center gap-2 text-sm" data-testid="auto-ext-with-item">
                    <Switch
                      checked={draft.trigger.with_item === true}
                      label={t('ext.auto.withItem')}
                      onChange={(on) => patchOwner('trigger', { with_item: on })}
                    />
                    <span className="text-muted">{t('ext.auto.withItem')}</span>
                  </label>
                  <ExtensionTriggerInputs
                    block={blocks?.triggers.find((b) => b.block === draft.trigger.block)}
                    value={(draft.trigger.inputs ?? {}) as Record<string, string>}
                    locked={lockedTriggerInputs}
                    issues={issues}
                    onChange={(inputs) => patchOwner('trigger', { inputs })}
                  />
                </>
              ) : (
                <Sentence parts={shown(triggerParts)} issues={issues} open={open} onOpen={setOpen} editor={editor} />
              )}
            </RecipeRow>
          ) : null}
          {!single ? (
            <RecipeRow word={t('auto.word.only_if')} testId="auto-conditions">
              {conditions?.rules.length ? (
                <div className="flex w-full flex-col gap-2">
                  <FilterGroupEditor
                    group={conditions}
                    depth={1}
                    ctx={sub.filterCtx(filterCtx)}
                    makeRule={makeRule}
                    onChange={setConditions}
                  />
                  {conditionsLine ? (
                    // The readable sentence: "and" / "or" with parentheses around each group.
                    <p className="text-xs text-muted" data-testid="auto-condition-text">
                      {t('auto.word.only_if')} {conditionsLine}
                    </p>
                  ) : null}
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="auto-add-condition"
                  onClick={() => setConditions(firstConditions(makeRule()))}
                >
                  {plusLabel(t('auto.builder.add_condition'))}
                </Button>
              )}
              {issues.some((i) => i.path === 'conditions') ? (
                <p className="w-full text-xs text-danger-fg">{issues.find((i) => i.path === 'conditions')!.detail}</p>
              ) : null}
            </RecipeRow>
          ) : null}
          {showActions ? (
            <>
              <ol className="flex flex-col gap-2.5">
                {draft.actions.map((a, i) => (
                  <li key={i} data-testid="auto-action" data-type={a.type} className="flex items-start gap-2">
                    <span className="w-16 shrink-0 pt-[0.6875rem] font-display text-[0.9375rem] font-bold text-heading">
                      {i === 0 ? (
                        t('auto.word.then')
                      ) : (
                        <span className="text-xs font-semibold text-muted">{t('auto.word.and').trim()}</span>
                      )}
                    </span>
                    {/* One action = one framed row: its sentence, then its own delete button. */}
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 rounded-[12px] border border-line bg-surface px-2.5 py-1.5">
                      <Sentence
                        parts={shown(actionSentence(a as unknown as Action, i, sb))}
                        issues={issues}
                        open={open}
                        onOpen={setOpen}
                        editor={editor}
                      />
                      {(a.type === 'create_item' || a.type === 'move_to_board') && typeof a.board === 'string' ? (
                        <span className="relative inline-flex">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setMappingOf(mappingOf === i ? null : i)}
                            data-testid="auto-mapping"
                          >
                            {t('auto.mapping.button', {
                              n:
                                Object.keys((a.mapping as object | undefined) ?? {}).length +
                                Object.keys((a.fixed as object | undefined) ?? {}).length,
                            })}
                          </Button>
                          {mappingOf === i ? (
                            <Popover open onClose={() => setMappingOf(null)} className="p-3">
                              <MappingEditor
                                board={board}
                                sourceColumns={itemColumns}
                                targetBoardId={a.board}
                                mapping={a.mapping as Record<string, string> | undefined}
                                fixed={a.fixed as Record<string, unknown> | undefined}
                                allowFixed={a.type === 'create_item'}
                                onChange={(next) => patchOwner(`actions.${i}.mapping`, next)}
                              />
                            </Popover>
                          ) : null}
                        </span>
                      ) : null}
                      {a.type === 'create_item_from_template' || a.type === 'add_template_subitems' ? (
                        <span className="relative inline-flex">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setTemplateOf(templateOf === i ? null : i)}
                            data-testid="auto-template-setup"
                          >
                            {t('auto.itemTemplate.setup', {
                              n: Object.keys((a.variables as object | undefined) ?? {}).length,
                            })}
                          </Button>
                          {templateOf === i ? (
                            <Popover open onClose={() => setTemplateOf(null)} className="p-3">
                              <TemplateActionFields
                                action={a}
                                template={itemTemplatesOf(templateBoardOf(a)).find((x) => x.id === a.template)}
                                itemColumns={itemColumns}
                                target={a.type === 'create_item_from_template' ? targetBoard(templateBoardOf(a)) : null}
                                boardLevel={boardLevelTrigger}
                                onChange={(patch) => patchOwner(`actions.${i}`, patch)}
                              />
                            </Popover>
                          ) : null}
                        </span>
                      ) : null}
                      {a.type === 'run_extension' && !String(a.block ?? '').startsWith('mcp:') ? (
                        <ExtensionBlockFields
                          block={blocks?.actions.find((b) => b.block === a.block)}
                          board={board}
                          value={(a.input as Record<string, unknown> | undefined) ?? {}}
                          issues={
                            new Set(
                              issues
                                .filter((x) => x.path.startsWith(`actions.${i}.input.`))
                                .map((x) => x.path.slice(`actions.${i}.input.`.length)),
                            )
                          }
                          onChange={(input) =>
                            setDraft((d) => ({
                              ...d,
                              actions: d.actions.map((x, j) => (j === i ? { ...x, input } : x)),
                            }))
                          }
                        />
                      ) : null}
                      {/* Every action can go — the first one too (it looked stuck). */}
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={t('auto.builder.remove_action')}
                        title={t('auto.builder.remove_action')}
                        data-testid="auto-remove-action"
                        className="ms-auto w-8 shrink-0 px-0 text-muted hover:bg-danger-soft hover:text-danger-fg"
                        onClick={() => {
                          setOpen(null);
                          setMappingOf(null);
                          setTemplateOf(null);
                          setIssues([]);
                          setDraft((d) => ({ ...d, actions: d.actions.filter((_, j) => j !== i) }));
                        }}
                      >
                        <Icon name="trash" size={15} />
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
              {single && draft.actions.length ? null : (
                <RecipeRow word={draft.actions.length ? undefined : t('auto.word.then')}>
                  {!draft.actions.length ? (
                    <span
                      className={cn('w-full text-sm', noActions ? 'font-semibold text-danger-fg' : 'text-muted')}
                      data-testid="auto-no-actions"
                    >
                      {t('auto.builder.no_actions')}
                    </span>
                  ) : null}
                  <MenuChip
                    variant="dashed"
                    testId="auto-add-action"
                    menuLabel={t('auto.builder.add_action')}
                    label={plusLabel(
                      draft.actions.length ? t('auto.builder.add_action') : t('auto.builder.add_first_action'),
                    )}
                    items={[
                      // r17ui: in sections — "subitems & parent item" (set / copy on the parent or the subitems).
                      ...actionSections(actionTypes).flatMap(({ section, types }): MenuEntry[] => [
                        { kind: 'label', label: t(`auto.actionSection.${section}`) },
                        ...types.map((k): MenuEntry =>
                          gateMenuEntry(actionGate(k), {
                            label: t(`auto.kind.${k}` as MessageKey),
                            testId: `auto-action-${k}`,
                            onSelect: () => addAction({ type: k, ...(ACTION_DEFAULTS[k] ?? {}) }),
                          }),
                        ),
                      ]),
                      ...(extActionEntries.length
                        ? [{ kind: 'label', label: t('ext.auto.fromExtensions') } as MenuEntry, ...extActionEntries]
                        : []),
                      ...planUpgradeMenuEntries(actionTypes.map(actionGate), (path) => void navigate({ to: path })),
                    ]}
                  />
                </RecipeRow>
              )}
            </>
          ) : null}
        </Card>

        {draft.trigger.type === 'webhook_in' && !single ? (
          <section className="space-y-2 rounded-[14px] border border-line p-3.5 text-sm" data-testid="auto-inbound">
            <p className="text-muted">{existing ? t('auto.inbound.saved') : t('auto.inbound.after_save')}</p>
            <label className="block space-y-1">
              <span className="text-xs font-semibold">{t('auto.inbound.secret_required')}</span>
              <span className="flex items-center gap-2">
                <Input
                  dir="ltr"
                  value={(draft.trigger.secret as string | undefined) ?? ''}
                  placeholder={t('auto.inbound.secret_auto')}
                  onChange={(e) => patchOwner('trigger', { secret: e.target.value || undefined })}
                  data-testid="auto-inbound-secret"
                />
                {draft.trigger.secret ? (
                  <button
                    type="button"
                    className="shrink-0 text-xs underline"
                    onClick={() => copyText(String(draft.trigger.secret))}
                    data-testid="auto-inbound-secret-copy"
                  >
                    {t('tokens.copy')}
                  </button>
                ) : null}
              </span>
              <span className="block text-xs text-muted">{t('auto.inbound.secret_header')}</span>
            </label>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-48">
                <span className="text-xs font-semibold">{t('auto.inbound.lookup_column')}</span>
                <PickerButton
                  menuLabel={t('auto.inbound.lookup_column')}
                  placeholder={t('auto.inbound.no_lookup')}
                  label={
                    (draft.trigger.item_lookup as { column?: string } | undefined)?.column === 'id'
                      ? t('auto.inbound.by_id')
                      : board.columns.find(
                          (c) => c.id === (draft.trigger.item_lookup as { column?: string } | undefined)?.column,
                        )?.title
                  }
                  items={[
                    {
                      label: t('auto.inbound.no_lookup'),
                      onSelect: () => patchOwner('trigger', { item_lookup: undefined }),
                    },
                    {
                      label: t('auto.inbound.by_id'),
                      onSelect: () => patchOwner('trigger', { item_lookup: { column: 'id', path: 'item_id' } }),
                    },
                    ...board.columns
                      .filter((c) => ['text', 'email', 'phone', 'numbers', 'link'].includes(c.type))
                      .map((c) => ({
                        label: c.title,
                        keywords: columnTypeLabel(c.type),
                        onSelect: () =>
                          patchOwner('trigger', {
                            item_lookup: {
                              column: c.id,
                              path: (draft.trigger.item_lookup as { path?: string } | undefined)?.path ?? c.id,
                            },
                          }),
                      })),
                  ]}
                />
              </div>
              {draft.trigger.item_lookup ? (
                <label className="block space-y-1">
                  <span className="text-xs font-semibold">{t('auto.inbound.lookup_path')}</span>
                  <Input
                    dir="ltr"
                    className="w-48"
                    value={(draft.trigger.item_lookup as { path: string }).path}
                    onChange={(e) =>
                      patchOwner('trigger', {
                        item_lookup: { ...(draft.trigger.item_lookup as object), path: e.target.value },
                      })
                    }
                  />
                </label>
              ) : null}
            </div>
            <p className="text-xs text-muted">{t('auto.inbound.payload_hint')}</p>
          </section>
        ) : null}

        <section className={cn('flex flex-col gap-1.5', single && 'hidden')}>
          <h3 className="text-xs font-semibold text-fg-2">{t('auto.builder.title')}</h3>
          <Input
            value={title}
            placeholder={t('auto.builder.title_hint')}
            onChange={(e) => setTitle(e.target.value)}
            data-testid="auto-title"
          />
        </section>

        {error ? (
          <Notice tone="error">
            <p>{error}</p>
            {issues.length ? (
              <ul className="mt-1 list-disc ps-5 text-xs" data-testid="auto-issues">
                {issues.map((i, k) => (
                  <li key={k}>{t(`auto.issue.${i.code}` as MessageKey, { detail: i.detail ?? '' })}</li>
                ))}
              </ul>
            ) : null}
          </Notice>
        ) : null}
      </div>
    </Dialog>
  );
};

/** A recipe of an existing automation, as a draft. */
export const draftOf = (a: Automation): DraftRecipe => ({
  trigger: { ...(a.recipe.trigger as Record<string, unknown>), type: a.recipe.trigger.type },
  conditions: a.recipe.conditions,
  actions: a.recipe.actions.map((x) => ({ ...(x as Record<string, unknown>), type: x.type })),
});

/**
 * D14 — where each blank's columns come from: a subitem trigger's item is a subitem (the sub-board's columns), and
 * parent / subitem actions reach the other level. Also the "only if" columns and the extra template variables.
 */
const subColumnsOf = (board: BoardDetail, subColumns: BoardDetail['columns'], draft: DraftRecipe) => {
  const trigger = draft.trigger as unknown as Trigger;
  const known = !!TRIGGERS[trigger.type as TriggerType];
  const itemLevel = known ? recipeItemLevel(trigger) : 'main';
  const parentLevel = known ? recipeParentLevel(trigger) : null;
  const at = (l: 'main' | 'sub' | null) => (l === 'sub' ? subColumns : l === 'main' ? board.columns : []);
  const columnsOf = (s: SlotTarget, field: 'column' | 'source'): BoardDetail['columns'] | undefined => {
    if (s.isTrigger) return TRIGGERS[s.owner.type as TriggerType]?.sub ? subColumns : undefined;
    const def = ACTIONS[s.owner.type as ActionType];
    if (field === 'source') return def?.sourceOn ? at(def.sourceOn === 'parent' ? parentLevel : itemLevel) : undefined;
    if (def?.columnOn === 'parent') return at(parentLevel);
    if (def?.columnOn === 'subitems') return subColumns;
    return itemLevel === 'sub' ? subColumns : undefined;
  };
  const vars = (root: string, cols: BoardDetail['columns']) =>
    cols
      .filter((c) => c.type !== 'name')
      .map((c) => ({ v: `{${root}.${c.id}}`, label: `${tDynamic(`auto.var.${root}`)} › ${c.title}` }));
  const variables = [
    ...(parentLevel ? [{ v: '{parent.name}', label: t('auto.var.parent') }, ...vars('parent', at(parentLevel))] : []),
    ...(board.subitems_board_id ? vars('subitem', subColumns) : []),
  ];
  const filterCtx = (f: FilterCtx): FilterCtx =>
    itemLevel === 'sub'
      ? {
          ...f,
          columns: subColumns,
          subColumns: [],
          env: {
            ...f.env,
            columns: subColumns.map((c) => ({
              id: c.id,
              type: c.type,
              settings: c.settings as Record<string, unknown>,
            })),
          },
        }
      : f;
  return { itemLevel, parentLevel, columnsOf, variables, filterCtx };
};
