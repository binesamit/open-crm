// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type ReactNode } from 'react';
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  actionSentence,
  ELSE_BRANCH,
  graphIssues,
  SCENARIO_EXCLUDED_ACTIONS,
  SCENARIO_MAX_BRANCHES,
  SCENARIO_MAX_WAIT_MINUTES,
  SCENARIO_TRIGGERS,
  t,
  triggerSentence,
  type Action,
  type DraftRecipe,
  type FilterGroup,
  type MessageKey,
  type ScenarioDto,
  type ScenarioGraph,
  type ScenarioNode,
  type SentenceBoard,
  type Trigger,
} from '@bines/shared';
import { Button, cn, Input, Menu, Notice, Segmented, Switch, type MenuEntry } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { Icon } from '../../lib/icons';
import { showToast } from '../../lib/toast';
import { useItems, useMembers, type BoardDetail } from '../board/board-api';
import type { FilterCtx } from '../board/toolbar/FilterPanel';
import { BoardFilterEditor } from '../board/RelationFilterSection';
import { emptyGroup } from '../board/toolbar/filter-model';
import { PickerButton } from '../board/toolbar/parts';
import { isStub } from '../board/windowed';
import { Builder } from '../automations/Builder';
import { freeOutputs, newEdgeId, newNodeId, placeInGraph, removeFromGraph, STEP, type Link } from './graph-edit';
import { useScenarioMutations } from './scenarios-api';
import { ScenarioRunsDialog } from './ScenarioRunsDialog';

/**
 * phase 3 — the scenario editor (the approved design): the blocks on the start side, the canvas in the middle
 * — the flow runs with the page's direction (right to left in Hebrew) — and the chosen block's settings on the end
 * side. Triggers and actions open the automation builder for that one block; filters, branches and waits are edited
 * in the panel. Saving writes the whole graph; a graph with issues cannot be switched on.
 */
type Kind = ScenarioNode['kind'];
type NodeData = {
  node: ScenarioNode;
  summary: string;
  flagged: boolean;
  rtl: boolean;
  /** The outputs with nothing connected ('' = a plain block's one output, else a router's branch id): they get a "+". */
  free: string[];
  onAddNext: (e: MouseEvent<HTMLElement>, link: Link) => void;
  onDelete: () => void;
};
type FlowNode = Node<NodeData>;
type EdgeData = {
  onInsert: (e: MouseEvent<HTMLElement>) => void;
  onRemove: () => void;
  shown: boolean;
  /** The pointer is on the line's buttons (keeps them shown after it left the line). */
  hold: (on: boolean) => void;
};
type FlowEdge = Edge<EdgeData>;

const KIND_STYLE: Record<Kind, { icon: string; tone: string }> = {
  trigger: { icon: 'bolt', tone: 'bg-accent-soft text-accent-fg' },
  filter: { icon: 'filter', tone: 'bg-info-soft text-info-fg' },
  router: { icon: 'split', tone: 'bg-info-soft text-info-fg' },
  action: { icon: 'edit', tone: 'bg-ok-soft text-ok-fg' },
  wait: { icon: 'clock', tone: 'bg-info-soft text-info-fg' },
};

const KindIcon = ({ kind, size = 13 }: { kind: Kind; size?: number }) => (
  <span className={cn('grid size-[22px] shrink-0 place-items-center rounded-[7px]', KIND_STYLE[kind].tone)}>
    <Icon name={KIND_STYLE[kind].icon as never} size={size} />
  </span>
);

/** A round 22px button on the canvas (the "+" of a free output or a line, the bin of a line or a block). */
const CanvasButton = ({
  icon,
  label,
  testId,
  onClick,
  className,
  style,
  danger,
}: {
  icon: 'plus' | 'trash';
  label: string;
  testId: string;
  onClick: (e: MouseEvent<HTMLElement>) => void;
  className?: string;
  style?: CSSProperties;
  danger?: boolean;
}) => (
  <button
    type="button"
    aria-label={label}
    data-tip={label}
    data-testid={testId}
    onClick={(e) => {
      e.stopPropagation();
      onClick(e);
    }}
    style={style}
    className={cn(
      'nodrag nopan grid size-[22px] cursor-pointer place-items-center rounded-full border border-line bg-surface text-fg-2 shadow-sm',
      danger ? 'hover:border-danger hover:text-danger-fg' : 'hover:border-primary hover:text-primary',
      className,
    )}
  >
    <Icon name={icon} size={12} />
  </button>
);

/** One block on the canvas: its kind, its sentence; in-handle on the reading start, out-handles on the end. */
const BlockNode = ({ data, selected }: NodeProps<FlowNode>) => {
  const n = data.node;
  const inSide = data.rtl ? Position.Right : Position.Left;
  const outSide = data.rtl ? Position.Left : Position.Right;
  const branches =
    n.kind === 'router'
      ? [...n.branches.map((b) => ({ id: b.id, label: b.label })), { id: ELSE_BRANCH, label: t('scenario.else') }]
      : [];
  // The "+" beyond a free output, on the reading end (n8n: click it to add the next block there).
  const addNext = (branch: string, offset: number) =>
    data.free.includes(branch) ? (
      <CanvasButton
        icon="plus"
        label={t('scenario.addNext')}
        testId="scenario-add-next"
        onClick={(e) => data.onAddNext(e, { from: n.id, ...(branch ? { branch } : {}) })}
        className="absolute top-1/2 -translate-y-1/2"
        style={{ [outSide === Position.Left ? 'left' : 'right']: offset }}
      />
    ) : null;
  return (
    <div
      dir={data.rtl ? 'rtl' : 'ltr'}
      data-testid="scenario-node"
      data-node-id={n.id}
      data-kind={n.kind}
      className={cn(
        'group relative flex w-[180px] flex-col gap-1 rounded-[14px] border bg-surface px-3 py-2.5 text-start shadow-[0_2px_8px_rgba(13,59,53,0.08)]',
        selected ? 'border-primary ring-4 ring-[color-mix(in_srgb,var(--primary)_14%,transparent)]' : 'border-line',
        data.flagged && 'border-danger ring-2 ring-[var(--danger)]',
      )}
    >
      <CanvasButton
        icon="trash"
        danger
        label={t('scenario.deleteBlock')}
        testId="scenario-node-remove"
        onClick={data.onDelete}
        className={cn(
          'absolute -top-3 end-2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100',
          selected && 'opacity-100',
        )}
      />
      {n.kind !== 'trigger' ? (
        <Handle type="target" position={inSide} className="!size-2.5 !bg-[var(--muted)]" />
      ) : null}
      <span className="flex items-center gap-1.5 text-[11px] text-muted">
        <KindIcon kind={n.kind} size={11} />
        {n.label || t(`scenario.kind.${n.kind}` as MessageKey)}
      </span>
      <span className="line-clamp-3 text-[13px] leading-snug text-fg">{data.summary || t('scenario.notSet')}</span>
      {n.kind === 'router' ? (
        <div className="mt-1 flex flex-col gap-1">
          {branches.map((b) => (
            <div
              key={b.id}
              className="relative flex items-center rounded-[8px] bg-surface-2 px-2 py-0.5 text-[11px] text-fg-2"
            >
              <span className="truncate">{b.label || b.id}</span>
              <Handle
                type="source"
                id={b.id}
                position={outSide}
                className="!size-2.5 !bg-[var(--info)]"
                style={{ top: '50%' }}
              />
              {addNext(b.id, -46)}
            </div>
          ))}
        </div>
      ) : (
        <>
          <Handle type="source" position={outSide} className="!size-2.5 !bg-[var(--muted)]" />
          {addNext('', -34)}
        </>
      )}
    </div>
  );
};
const NODE_TYPES = { trigger: BlockNode, filter: BlockNode, router: BlockNode, action: BlockNode, wait: BlockNode };

/** A connection: on hover (or chosen) a "+" in its middle adds a block between the two, and a bin removes it. */
const LinkEdge = ({ id, data, selected, markerEnd, style, ...p }: EdgeProps<FlowEdge>) => {
  const [path, x, y] = getSmoothStepPath(p);
  const shown = !!data?.shown || !!selected;
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={24}
        style={{ ...style, ...(shown ? { stroke: 'var(--primary)' } : {}) }}
      />
      {data ? (
        <EdgeLabelRenderer>
          <div
            className={cn(
              'nodrag nopan absolute flex items-center gap-1 transition-opacity',
              shown ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0',
            )}
            style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
            onMouseEnter={() => data.hold(true)}
            onMouseLeave={() => data.hold(false)}
            data-testid="scenario-edge-tools"
            data-edge-id={id}
          >
            <CanvasButton
              icon="plus"
              label={t('scenario.insertHere')}
              testId="scenario-edge-insert"
              onClick={data.onInsert}
            />
            <CanvasButton
              icon="trash"
              danger
              label={t('scenario.removeLink')}
              testId="scenario-edge-remove"
              onClick={data.onRemove}
            />
          </div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
};
const EDGE_TYPES = { link: LinkEdge };

/** The palette: drag a block onto the canvas, or click it to add it after the chosen block. */
const PALETTE: { section: string; kinds: Kind[] }[] = [
  { section: 'scenario.palette.triggers', kinds: ['trigger'] },
  { section: 'scenario.palette.logic', kinds: ['filter', 'router', 'wait'] },
  { section: 'scenario.palette.actions', kinds: ['action'] },
];

export const ScenarioEditor = (props: {
  accountId: string;
  board: BoardDetail;
  filterCtx: FilterCtx;
  scenario: ScenarioDto;
  onClose: () => void;
}) => (
  <ReactFlowProvider>
    <Editor {...props} />
  </ReactFlowProvider>
);

const Editor = ({
  accountId,
  board,
  filterCtx,
  scenario,
  onClose,
}: {
  accountId: string;
  board: BoardDetail;
  filterCtx: FilterCtx;
  scenario: ScenarioDto;
  onClose: () => void;
}) => {
  const m = useScenarioMutations(accountId, board.id);
  const members = useMembers(accountId).data?.data ?? [];
  const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
  const flow = useReactFlow();
  // The canvas's size (the middle of the view is where a block lands when nothing is chosen).
  const pane = { w: useStore((s) => s.width), h: useStore((s) => s.height) };
  const [graph, setGraph] = useState<ScenarioGraph>(() => structuredClone(scenario.graph));
  const [name, setName] = useState(scenario.name);
  const [active, setActive] = useState(scenario.is_active);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [runs, setRuns] = useState(false);
  // The block whose trigger / action the builder edits; `pending` = a new one placed at x, y and joined by `link`.
  const [building, setBuilding] = useState<
    { id: string } | { pending: { kind: 'trigger' | 'action'; x: number; y: number; link: Link | null } } | null
  >(null);
  // The "+" menu of a line or a free output: which block to add there.
  const [adding, setAdding] = useState<{ x: number; y: number; link: Link } | null>(null);
  // The line under the pointer (its "+" and bin show); a short grace lets the pointer move onto them.
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const unhover = useRef<number | undefined>(undefined);
  const hoverOn = (id: string | null) => {
    window.clearTimeout(unhover.current);
    if (id) setHoverEdge(id);
    else unhover.current = window.setTimeout(() => setHoverEdge(null), 250);
  };
  const dir = rtl ? -1 : 1;
  const issues = useMemo(() => graphIssues(graph), [graph]);
  const flagged = new Set(issues.flatMap((i) => (i.node_id ? [i.node_id] : [])));

  const change = (fn: (g: ScenarioGraph) => ScenarioGraph) => {
    setGraph((g) => fn(structuredClone(g)));
    setDirty(true);
  };

  const sb: SentenceBoard = {
    columns: board.columns.map((c) => ({ key: c.id, title: c.title, type: c.type })),
    groups: board.groups,
    subColumns: [],
    subLevels: false,
    personName: (id) => members.find((x) => x.user_id === id)?.name,
  } as SentenceBoard;
  const text = (parts: { text: string }[]) =>
    parts
      .map((p) => p.text)
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
  const summary = (n: ScenarioNode): string => {
    try {
      if (n.kind === 'trigger') return text(triggerSentence(n.trigger as Trigger, sb));
      if (n.kind === 'action') return text(actionSentence(n.action as Action, 0, sb));
    } catch {
      return '';
    }
    if (n.kind === 'filter') return t('scenario.summary.filter', { n: n.conditions.rules.length });
    if (n.kind === 'router') return t('scenario.summary.router', { n: n.branches.length });
    return n.minutes % 1440 === 0
      ? t('scenario.summary.waitDays', { n: n.minutes / 1440 })
      : n.minutes % 60 === 0
        ? t('scenario.summary.waitHours', { n: n.minutes / 60 })
        : t('scenario.summary.waitMinutes', { n: n.minutes });
  };

  // The canvas's nodes come from the graph; React Flow's measured sizes are kept beside it (it needs them back).
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({});
  const rfNodes: FlowNode[] = graph.nodes.map((n) => ({
    id: n.id,
    type: n.kind,
    position: { x: n.x, y: n.y },
    data: {
      node: n,
      summary: summary(n),
      flagged: flagged.has(n.id),
      rtl,
      free: freeOutputs(graph, n),
      onAddNext: (e, link) => openAdd(e, link),
      onDelete: () => removeNodes([n.id]),
    },
    selected: n.id === selected,
    ...(measured[n.id] ? { measured: measured[n.id] } : {}),
  }));
  const rfEdges: FlowEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    sourceHandle: e.branch ?? null,
    type: 'link',
    selected: e.id === selEdge,
    style: { stroke: 'var(--muted)', strokeWidth: 2 },
    data: {
      shown: hoverEdge === e.id || adding?.link.edge === e.id,
      hold: (on) => hoverOn(on ? e.id : null),
      onInsert: (ev) => openAdd(ev, { from: e.from, edge: e.id }),
      onRemove: () => {
        change((g) => removeFromGraph(g, [], [e.id]));
        setHoverEdge(null);
        setSelEdge(null);
      },
    },
  }));

  /** Opens the "+" menu under the button that was pressed. */
  const openAdd = (e: MouseEvent<HTMLElement>, link: Link) => {
    const r = e.currentTarget.getBoundingClientRect();
    setAdding({ x: rtl ? r.right : r.left, y: r.bottom + 4, link });
  };
  const removeNodes = (ids: string[], edgeIds: string[] = []) => {
    change((g) => removeFromGraph(g, ids, edgeIds));
    if (selected && ids.includes(selected)) setSelected(null);
  };

  const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
    const sized = changes.filter((c) => c.type === 'dimensions' && c.dimensions);
    if (sized.length)
      setMeasured((m) => {
        const next = { ...m };
        for (const c of sized) if (c.type === 'dimensions' && c.dimensions) next[c.id] = c.dimensions;
        return next;
      });
    // Removals (the Delete key) arrive once, blocks and lines together, through `onDelete`.
    const moved = changes.filter((c) => c.type === 'position' && c.position);
    for (const c of changes)
      if (c.type === 'select' && c.selected) {
        setSelected(c.id);
        setSelEdge(null);
      }
    if (moved.length)
      change((g) => {
        for (const c of moved)
          if (c.type === 'position' && c.position) {
            const n = g.nodes.find((x) => x.id === c.id);
            if (n) {
              n.x = Math.round(c.position.x);
              n.y = Math.round(c.position.y);
            }
          }
        return g;
      });
  };
  const onEdgesChange = (changes: EdgeChange<FlowEdge>[]) => {
    for (const c of changes)
      if (c.type === 'select') {
        if (c.selected) {
          setSelEdge(c.id);
          setSelected(null);
        } else setSelEdge((s) => (s === c.id ? null : s));
      }
  };
  const onConnect = (c: Connection) => {
    if (!c.source || !c.target || c.source === c.target) return;
    change((g) => {
      const target = g.nodes.find((n) => n.id === c.target);
      if (!target || target.kind === 'trigger') return g;
      const branch = c.sourceHandle ?? undefined;
      if (g.edges.some((e) => e.from === c.source && e.to === c.target && e.branch === branch)) return g;
      g.edges.push({ id: newEdgeId(g), from: c.source!, to: c.target!, ...(branch ? { branch } : {}) });
      return g;
    });
  };

  /**
   * Where a new block goes: one step after the block it joins (towards the reading end; a router's branch at that
   * branch's height), else the middle of the view. A block into a line takes its place in `placeInGraph`.
   */
  const placeAfter = (link: Link | null) => {
    const a = link ? graph.nodes.find((n) => n.id === link.from) : null;
    if (a) {
      const outs = a.kind === 'router' ? [...a.branches.map((b) => b.id), ELSE_BRANCH] : [];
      const i = link?.branch ? Math.max(0, outs.indexOf(link.branch)) : 0;
      return { x: a.x + STEP * dir, y: a.y + (outs.length ? (i - (outs.length - 1) / 2) * 120 : 0) };
    }
    const v = flow.getViewport();
    return { x: Math.round((pane.w / 2 - v.x) / v.zoom), y: Math.round((pane.h / 2 - v.y) / v.zoom) };
  };
  const add = (kind: Kind, at: { x: number; y: number }, link: Link | null) => {
    // The split line's id is handed to its first half: the pointer is no longer on it.
    if (link?.edge) setHoverEdge(null);
    if (kind === 'trigger' || kind === 'action') {
      if (kind === 'trigger' && graph.nodes.some((n) => n.kind === 'trigger')) {
        showToast({ message: t('scenario.oneTrigger'), tone: 'error' });
        return;
      }
      setBuilding({ pending: { kind, x: at.x, y: at.y, link: kind === 'trigger' ? null : link } });
      return;
    }
    change((g) => {
      const id = newNodeId(g, kind);
      const base = { id, x: at.x, y: at.y };
      placeInGraph(
        g,
        kind === 'filter'
          ? { ...base, kind, conditions: emptyGroup() }
          : kind === 'router'
            ? { ...base, kind, mode: 'first', branches: [{ id: 'b1', label: t('scenario.branchN', { n: 1 }) }] }
            : { ...base, kind: 'wait', minutes: 60 },
        link,
        dir,
      );
      setSelected(id);
      return g;
    });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const kind = e.dataTransfer.getData('application/x-scenario-block') as Kind;
    if (!kind) return;
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    add(kind, { x: Math.round(p.x), y: Math.round(p.y) }, null);
  };
  // The "+" menu: every block but the trigger (nothing leads into a trigger).
  const addMenu: MenuEntry[] = adding
    ? (['action', 'filter', 'router', 'wait'] as const).map((k) => ({
        label: t(`scenario.kind.${k}` as MessageKey),
        icon: <KindIcon kind={k} size={11} />,
        testId: `scenario-pick-${k}`,
        onSelect: () => add(k, placeAfter(adding.link), adding.link),
      }))
    : [];

  const triggerNode = graph.nodes.find((n) => n.kind === 'trigger');
  const builderDraft = (): DraftRecipe | null => {
    if (!building) return null;
    const trig = (
      triggerNode?.kind === 'trigger' ? triggerNode.trigger : { type: 'item_created' }
    ) as DraftRecipe['trigger'];
    if ('pending' in building)
      return building.pending.kind === 'trigger'
        ? { trigger: { type: 'item_created' }, actions: [] }
        : { trigger: trig, actions: [] };
    const n = graph.nodes.find((x) => x.id === building.id);
    if (n?.kind === 'trigger')
      return { trigger: { ...(n.trigger as object), type: n.trigger.type } as DraftRecipe['trigger'], actions: [] };
    if (n?.kind === 'action')
      return {
        trigger: trig,
        actions: [{ ...(n.action as object), type: n.action.type } as DraftRecipe['actions'][number]],
      };
    return null;
  };
  const applyBuilt = (d: DraftRecipe) => {
    if (!building) return;
    change((g) => {
      if ('pending' in building) {
        const { kind, x, y, link } = building.pending;
        const id = newNodeId(g, kind);
        if (kind === 'trigger') g.nodes.push({ id, x, y, kind: 'trigger', trigger: d.trigger as never });
        else if (d.actions[0]) placeInGraph(g, { id, x, y, kind: 'action', action: d.actions[0] as never }, link, dir);
        else return g;
        setSelected(id);
        return g;
      }
      const n = g.nodes.find((x) => x.id === building.id);
      if (n?.kind === 'trigger') n.trigger = d.trigger as never;
      if (n?.kind === 'action' && d.actions[0]) n.action = d.actions[0] as never;
      return g;
    });
  };

  const save = async () => {
    try {
      const saved = await m.update.mutateAsync({ id: scenario.id, name: name.trim() || scenario.name, graph });
      setDirty(false);
      setActive(saved.is_active);
      showToast({ message: t('scenario.saved') });
      return true;
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
      return false;
    }
  };
  const toggle = async (on: boolean) => {
    if (dirty && !(await save())) return;
    try {
      const s = await m.setActive.mutateAsync({ id: scenario.id, active: on });
      setActive(s.is_active);
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };
  const close = async () => {
    if (
      dirty &&
      !(await confirmDialog({ title: t('scenario.leaveTitle'), message: t('scenario.leaveMessage'), danger: true }))
    )
      return;
    onClose();
  };
  const items = (useItems(accountId, board.id).data?.data ?? []).filter((i) => !isStub(i) && i.depth === 0);
  const test = async (itemId: string) => {
    if (dirty && !(await save())) return;
    try {
      const run = await m.test.mutateAsync({ id: scenario.id, itemId });
      showToast({
        message: t('scenario.tested', { status: t(`scenario.status.${run.status}` as MessageKey) }),
        tone: run.status === 'failed' ? 'error' : undefined,
      });
      setRuns(true);
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };

  const sel = graph.nodes.find((n) => n.id === selected) ?? null;
  const patchSel = (fn: (n: ScenarioNode) => void) =>
    change((g) => {
      const n = g.nodes.find((x) => x.id === selected);
      if (n) fn(n);
      return g;
    });
  const draft = builderDraft();

  return (
    <div className="fixed inset-0 z-modal flex flex-col bg-surface" data-testid="scenario-editor">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-surface px-5">
        <button
          type="button"
          onClick={() => void close()}
          className="flex cursor-pointer items-center gap-1 text-sm text-muted hover:text-fg"
        >
          <Icon name="chevronStart" size={16} />
          {t('scenario.back')}
        </button>
        <Input
          value={name}
          maxLength={120}
          aria-label={t('scenario.name')}
          data-testid="scenario-name"
          onChange={(e) => {
            setName(e.target.value);
            setDirty(true);
          }}
          className="h-9 w-72 font-display text-base"
        />
        <label
          className="flex items-center gap-2 text-sm"
          title={issues.length ? t('scenario.cannotActivate') : undefined}
        >
          <Switch
            checked={active}
            disabled={!!issues.length}
            onChange={(on) => void toggle(on)}
            label={t('scenario.active')}
            testId="scenario-active"
          />
          {t('scenario.active')}
        </label>
        <div className="flex-1" />
        {dirty ? <span className="text-xs text-muted">{t('scenario.unsaved')}</span> : null}
        <PickerButton
          className="w-48"
          testId="scenario-test"
          menuLabel={t('scenario.test')}
          placeholder={t('scenario.test')}
          searchable
          items={items.slice(0, 200).map((i) => ({ label: i.name, onSelect: () => void test(i.id) }))}
        />
        <Button variant="secondary" size="sm" onClick={() => setRuns(true)} data-testid="scenario-runs">
          <Icon name="history" size={15} />
          {t('scenario.runs')}
        </Button>
        <Button size="sm" busy={m.update.isPending} onClick={() => void save()} data-testid="scenario-save">
          {t('scenario.save')}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          aria-label={t('scenario.palette')}
          className="flex w-60 shrink-0 flex-col gap-3.5 overflow-y-auto border-e border-line bg-surface p-4"
          data-testid="scenario-palette"
        >
          {PALETTE.map((p) => (
            <div key={p.section} className="flex flex-col gap-1.5">
              <span className="text-xs text-muted">{t(p.section as MessageKey)}</span>
              {p.kinds.map((k) => (
                <button
                  key={k}
                  type="button"
                  draggable
                  data-testid={`scenario-add-${k}`}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('application/x-scenario-block', k);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onClick={() => {
                    const link = selected ? { from: selected } : null;
                    add(k, placeAfter(link), link);
                  }}
                  className="flex cursor-grab items-center gap-2 rounded-[10px] border border-line px-2.5 py-2 text-start text-sm hover:border-primary"
                >
                  <KindIcon kind={k} />
                  {t(`scenario.kind.${k}` as MessageKey)}
                </button>
              ))}
            </div>
          ))}
          <p className="text-xs leading-relaxed text-muted">{t('scenario.paletteHint')}</p>
        </aside>

        <main
          className="relative min-w-0 flex-1 bg-surface-2"
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          dir="ltr"
        >
          <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onDelete={({ nodes, edges }) =>
              removeNodes(
                nodes.map((n) => n.id),
                edges.map((e) => e.id),
              )
            }
            onEdgeMouseEnter={(_, e) => hoverOn(e.id)}
            onEdgeMouseLeave={() => hoverOn(null)}
            onConnect={onConnect}
            onPaneClick={() => {
              setSelected(null);
              setSelEdge(null);
            }}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            minZoom={0.3}
            maxZoom={1.5}
            deleteKeyCode={['Delete', 'Backspace']}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={20} size={1} color="var(--line-strong)" />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>
          {!graph.nodes.length ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center">
              <p className="rounded-[12px] bg-surface px-4 py-3 text-sm text-muted shadow-sm" dir="auto">
                {t('scenario.empty')}
              </p>
            </div>
          ) : null}
        </main>

        <aside
          aria-label={t('scenario.inspector')}
          className="flex w-80 shrink-0 flex-col gap-3.5 overflow-y-auto border-s border-line bg-surface p-4"
          data-testid="scenario-inspector"
        >
          {sel ? (
            <Inspector
              accountId={accountId}
              board={board}
              node={sel}
              summary={summary(sel)}
              patch={patchSel}
              onEdit={() => setBuilding({ id: sel.id })}
              onDelete={() => removeNodes([sel.id])}
            />
          ) : (
            <Overview issues={issues} scenario={scenario} />
          )}
        </aside>
      </div>

      <Menu
        at={adding}
        onClose={() => setAdding(null)}
        label={t('scenario.insertHere')}
        items={addMenu}
        testId="scenario-add-menu"
      />
      {building && draft ? (
        <Builder
          board={board}
          members={members}
          filterCtx={filterCtx}
          initial={draft}
          onClose={() => setBuilding(null)}
          single={{
            kind:
              'pending' in building
                ? building.pending.kind
                : graph.nodes.find((n) => n.id === building.id)?.kind === 'trigger'
                  ? 'trigger'
                  : 'action',
            onApply: applyBuilt,
            triggers: SCENARIO_TRIGGERS,
            excludedActions: SCENARIO_EXCLUDED_ACTIONS,
          }}
        />
      ) : null}
      {runs ? (
        <ScenarioRunsDialog
          accountId={accountId}
          scenario={{ ...scenario, graph }}
          summary={summary}
          onClose={() => setRuns(false)}
        />
      ) : null}
    </div>
  );
};

/** Nothing chosen: what stops the scenario from running, and the last run. */
const Overview = ({ issues, scenario }: { issues: ReturnType<typeof graphIssues>; scenario: ScenarioDto }) => (
  <div className="flex flex-col gap-3" data-testid="scenario-overview">
    <h2 className="font-display text-base font-semibold text-heading">{t('scenario.overview')}</h2>
    {issues.length ? (
      <Notice tone="warn">
        <div className="flex flex-col gap-1">
          <span>{t('scenario.issuesTitle')}</span>
          <ul className="list-disc ps-4 text-xs" data-testid="scenario-issues">
            {[...new Set(issues.map((i) => i.code))].map((c) => (
              <li key={c}>{t(`scenario.issue.${c}` as MessageKey)}</li>
            ))}
          </ul>
        </div>
      </Notice>
    ) : (
      <p className="text-sm text-muted">{t('scenario.ready')}</p>
    )}
    {scenario.deactivated_reason ? (
      <Notice tone="error">{t(`scenario.off.${scenario.deactivated_reason}` as MessageKey)}</Notice>
    ) : null}
    <p className="text-xs leading-relaxed text-muted">{t('scenario.overviewHint')}</p>
  </div>
);

const Field = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="flex flex-col gap-1.5">
    <span className="text-xs text-fg-2">{label}</span>
    {children}
  </div>
);

const WAIT_UNITS = [
  { value: 'minutes', size: 1 },
  { value: 'hours', size: 60 },
  { value: 'days', size: 1440 },
] as const;

/** The chosen block's settings. */
const Inspector = ({
  accountId,
  board,
  node,
  summary,
  patch,
  onEdit,
  onDelete,
}: {
  accountId: string;
  board: BoardDetail;
  node: ScenarioNode;
  summary: string;
  patch: (fn: (n: ScenarioNode) => void) => void;
  onEdit: () => void;
  onDelete: () => void;
}) => {
  const unit =
    node.kind === 'wait'
      ? ([...WAIT_UNITS].reverse().find((u) => node.minutes % u.size === 0) ?? WAIT_UNITS[0])
      : WAIT_UNITS[0];
  return (
    <div className="flex flex-col gap-3.5" data-testid="scenario-node-settings" data-kind={node.kind}>
      <div className="flex items-center gap-2">
        <KindIcon kind={node.kind} size={15} />
        <h2 className="font-display text-base font-semibold text-heading">
          {t(`scenario.kind.${node.kind}` as MessageKey)}
        </h2>
      </div>
      <Field label={t('scenario.label')}>
        <Input
          value={node.label ?? ''}
          maxLength={80}
          placeholder={t('scenario.labelHint')}
          data-testid="scenario-node-label"
          onChange={(e) => patch((n) => void (n.label = e.target.value || undefined))}
        />
      </Field>

      {node.kind === 'trigger' || node.kind === 'action' ? (
        <>
          <p className="rounded-[10px] bg-surface-2 px-3 py-2 text-sm">{summary || t('scenario.notSet')}</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={onEdit}
            data-testid="scenario-node-edit"
            className="self-start"
          >
            {t('scenario.editBlock')}
          </Button>
        </>
      ) : null}

      {node.kind === 'filter' ? (
        <Field label={t('scenario.filterIf')}>
          <BoardFilterEditor
            accountId={accountId}
            boardId={board.id}
            group={node.conditions as FilterGroup}
            onChange={(g) => patch((n) => void (n.kind === 'filter' && (n.conditions = g as never)))}
            testId="scenario-filter-editor"
          />
        </Field>
      ) : null}

      {node.kind === 'router' ? (
        <>
          <p className="text-xs leading-relaxed text-muted">{t('scenario.routerHint')}</p>
          <Segmented
            label={t('scenario.routerMode')}
            value={node.mode}
            onChange={(v) => patch((n) => void (n.kind === 'router' && (n.mode = v)))}
            options={[
              { value: 'first', label: t('scenario.routerFirst') },
              { value: 'all', label: t('scenario.routerAll') },
            ]}
          />
          {node.branches.map((b, i) => (
            <div
              key={b.id}
              className="flex flex-col gap-2 rounded-[12px] border border-line p-3"
              data-testid="scenario-branch"
            >
              <div className="flex items-center gap-2">
                <Input
                  value={b.label}
                  maxLength={60}
                  aria-label={t('scenario.branchName')}
                  onChange={(e) => patch((n) => void (n.kind === 'router' && (n.branches[i]!.label = e.target.value)))}
                  className="h-8"
                />
                {node.branches.length > 1 ? (
                  <button
                    type="button"
                    aria-label={t('scenario.removeBranch')}
                    className="cursor-pointer px-1 text-muted hover:text-fg"
                    onClick={() => patch((n) => void (n.kind === 'router' && n.branches.splice(i, 1)))}
                  >
                    ✕
                  </button>
                ) : null}
              </div>
              <BoardFilterEditor
                accountId={accountId}
                boardId={board.id}
                group={(b.conditions ?? emptyGroup()) as FilterGroup}
                onChange={(g) =>
                  patch(
                    (n) =>
                      void (
                        n.kind === 'router' && (n.branches[i]!.conditions = g.rules.length ? (g as never) : undefined)
                      ),
                  )
                }
                testId="scenario-branch-filter"
              />
            </div>
          ))}
          <div className="rounded-[12px] border border-line p-3 text-xs text-muted">{t('scenario.elseHint')}</div>
          {node.branches.length < SCENARIO_MAX_BRANCHES ? (
            <Button
              variant="dashed"
              size="sm"
              className="self-start"
              data-testid="scenario-add-branch"
              onClick={() =>
                patch((n) => {
                  if (n.kind !== 'router') return;
                  let k = n.branches.length + 1;
                  while (n.branches.some((b) => b.id === `b${k}`)) k++;
                  n.branches.push({ id: `b${k}`, label: t('scenario.branchN', { n: n.branches.length + 1 }) });
                })
              }
            >
              {t('scenario.addBranch')}
            </Button>
          ) : null}
        </>
      ) : null}

      {node.kind === 'wait' ? (
        <Field label={t('scenario.waitFor')}>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              value={node.minutes / unit.size}
              data-testid="scenario-wait-amount"
              onChange={(e) => {
                const v = Math.max(1, Math.round(Number(e.target.value) || 1));
                patch(
                  (n) => void (n.kind === 'wait' && (n.minutes = Math.min(SCENARIO_MAX_WAIT_MINUTES, v * unit.size))),
                );
              }}
              className="h-8 w-20"
            />
            <Segmented
              label={t('scenario.waitFor')}
              value={unit.value}
              onChange={(v) => {
                const size = WAIT_UNITS.find((u) => u.value === v)!.size;
                patch(
                  (n) =>
                    void (
                      n.kind === 'wait' &&
                      (n.minutes = Math.min(SCENARIO_MAX_WAIT_MINUTES, (n.minutes / unit.size) * size))
                    ),
                );
              }}
              options={WAIT_UNITS.map((u) => ({ value: u.value, label: t(`scenario.unit.${u.value}` as MessageKey) }))}
            />
          </div>
        </Field>
      ) : null}

      <div className="flex-1" />
      <Button
        variant="ghost"
        size="sm"
        onClick={onDelete}
        className="self-start text-danger-fg"
        data-testid="scenario-node-delete"
      >
        <Icon name="trash" size={15} />
        {t('scenario.deleteBlock')}
      </Button>
    </div>
  );
};
