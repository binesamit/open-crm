// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  cellMenu as buildCellMenu,
  columnMenu,
  columnTypes,
  conversionTargets,
  groupColorHex,
  groupMenu,
  MAX_SORT_LEVELS,
  normalizeLabelColor,
  paint,
  resolveField,
  summarize,
  summaryOptions,
  t,
  type ColumnSummary,
  type MessageKey,
  type SortLevel,
  type SummaryFn,
  type QueryEnv,
  type TextPerson,
  queryColumnOf,
} from '@bines/shared';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { arrayMove, horizontalListSortingStrategy, SortableContext, useSortable } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import {
  ClearSearchButton,
  cn,
  formatIsoDate,
  hasOpenLayers,
  Menu,
  MenuTrigger,
  Skeleton,
  useActionMenu,
  type MenuEntry,
} from '@bines/ui';
import { copyText, toMenuEntries } from '../../../lib/entity-menu';
import { ColorGrid, fill, inkFor } from '../../../lib/label-color';
import { Icon } from '../../../lib/icons';
import { usePlanGate } from '../../../lib/plan-gate';
import { gateMenuEntry, planGateAttrs } from '../../../lib/plan-limit';
import { columnTypeLabel } from '../../../lib/locale';
import { useItemMenu } from '../item-menu';
import { isTyping } from '../../../lib/keys';
import { MoveDialog } from '../MoveDialog';
import { SelectionContext, type Selection } from '../selection';
import { confirmDelete } from '../../../lib/dialogs';
import { rememberEdit, useUndoToast } from '../../../lib/undo';
import { showToast } from '../../../lib/toast';
import { errorMessage } from '../../../lib/api';
import {
  bulkHint,
  bulkLinks,
  bulkSettable,
  bulkTargets,
  linkDelta,
  setBulkHover,
  withCell,
  withLinkDelta,
} from './bulk-cells';
import { BoardAccountContext, ColoringContext } from '../board-context';
import { ConversionMarksContext, FailedMark } from '../convert/marks';
import { ConversionHistoryDialog } from '../convert/ConversionHistoryDialog';
import { ConvertColumnDialog } from '../convert/ConvertColumnDialog';
import { useConversion } from '../convert/convert-api';
import {
  type BoardDetail,
  type Column,
  type Group,
  type Item,
  type Member,
  type useBoardMutations,
  useTags,
  useTeams,
} from '../board-api';
import { openBatchMenu } from '../BatchBar';
import { isStub } from '../windowed';
import { cellFor, hasCellComponent } from '../cells';
import { cellIn, GridContext, useGrid, useGridState } from './grid';
import { revealNewItem } from './reveal-new-item';
import { useSearchHighlight } from './search-highlight';
import { ColumnSettings, hasColumnSettings } from '../ColumnSettings';
import { WorkflowDialog } from '../workflow/WorkflowDialog';
import { UpdateCountPill } from './UpdateCountPill';
import { TypeGlyph } from './type-glyphs';
import { ComputedNameMark } from '../name-source/ComputedName';
import { NameHeaderMenu } from '../name-source/NameHeaderMenu';
import { computedNameInfo, showNameComputedToast } from '../name-source/name-source-api';
import { ComputedNameEditor } from './ComputedNameEditor';
import { Popover } from '../cells/Popover';
import { GROUP_DROP, RowDnd, useDropTarget, useDropZone, usePressing, type Dragged, type Where } from './row-dnd';
import { foldedWhileDragging, keepInPlace } from './group-fold';
import {
  BucketDragContext,
  bucketDropOf,
  bucketMoveEntries,
  bucketTargets,
  publishBucketDrag,
  type BucketDrag,
} from './bucket';
import { useAiColumnMenu } from '../../ai2/AiBatch';
import { useAppearance } from '../../../lib/appearance';
import { useFreshRow } from '../../../lib/motion';
import { useOpenItem } from '../open-item';

/** The name column's width when the board has none of its own (the old generic 140/150 defaults). */
export const NAME_WIDTH = 280;
/** The name column never gets narrower than this (checkbox, arrow and a few letters). */
const NAME_MIN = 120;
/** The item name column's width: the personal one, else the board's own, else the default (owner fix 4). */
export const nameWidthOf = (column: Column | undefined, personal?: number) =>
  personal ?? (column && column.width > 150 ? column.width : NAME_WIDTH);
const ADD_COL_WIDTH = 44;
/** F4 + owner fix 2: a soft vertical line between columns, so each column's start and end shows. */
const COL_SEP = 'border-e border-line';
/** A group's column header row (F4 `.bh`) — every group has its own (round 7, reverses N6). */
const HEADER_PX = 32;
/** The group's colour rail on the box's leading edge. */
const RAIL_PX = 6;

type Mutations = ReturnType<typeof useBoardMutations>;

/**
 * One block of the table: a board group, or a bucket when the view is grouped by a column (13 §3).
 * Buckets have no group menu and no "add item" row.
 */
export type Section = {
  key: string;
  title: string;
  color: string;
  items: Item[];
  group?: Group;
  /**
   * Grouped by a column: where "+ item" creates the item (a board group) and the cell value that puts it in
   * this section. Absent = no "+ item" here (a computed column, a system field).
   */
  seed?: { groupId: string; cells: Record<string, unknown> };
  /**
   * A windowed board (perf review §7.1): `items` holds placeholders for rows not loaded yet, and the footer /
   * group-title summaries come computed by the server over the whole section (by column id; absent = none).
   */
  summaries?: Record<string, ColumnSummary | null>;
  groupSummary?: ColumnSummary | null;
  /**
   * Prod ק3 — a nested grouping: the section's level (0 = the first; absent = one level). A `header`
   * section is a parent: its title (and, when open, its summary after its children), never rows — `items` are all
   * its rows (the count and sums), or empty with `count` on a windowed board. The levels' sections come in tree
   * order. `column` / `bucket`: the grouping column of the section's own level and its bucket key there.
   */
  level?: number;
  header?: boolean;
  count?: number;
  column?: string;
  bucket?: string;
};

/** A nested grouping's level actions (ק3): collapse every section of a level, open everything again. */
export type LevelActions = { collapse: (level: number) => void; expandAll: () => void };
const LevelActionsContext = createContext<LevelActions | null>(null);

/** Each nested level's indent (ק3). */
const LEVEL_INDENT = 24;

/**
 * Subitems (D14) for the table: the sub-board, its items by parent, which rows are open, and how to open one.
 * Null on boards without subitem support in this view.
 */
export type SubitemsTable = {
  board: BoardDetail | undefined;
  mutations: Mutations;
  childrenOf: Map<string, Item[]>;
  expanded: Set<string>;
  setExpanded: (itemId: string, open: boolean) => void;
  /** Width change of a sub-board column (saved for everyone, debounced). */
  onWidth: (columnId: string, width: number) => void;
  /** The parent whose "add subitem" field should take focus once it shows. */
  focusAdd: string | null;
  requestAdd: (parentId: string) => void;
  /** Checked subitems — their own selection and batch bar, since bulk actions run per board. */
  selection: Selection;
  /** The view sorts the subitems (`subitems_sort`): no manual drag among siblings then. */
  sorted?: boolean;
  /** The view's subitem sort (`subitems_sort`) and how to change it (a draft) — the sub-board headers' sort. */
  sortLevels?: SortLevel[];
  onSort?: (sort: SortLevel[]) => void;
  /** Closes every open subitem list ("collapse all"). */
  collapseAll?: () => void;
  /** Round 13: the sub-board columns this view hides (`subitems_hidden_columns`). */
  hiddenColumns?: string[];
  /**
   * Round 18 (option א): subitems shown only as the path to a deeper filter match — the row
   * is dimmed with a tooltip saying why (from the shared evaluator's `pathOnly`).
   */
  pathOnly?: ReadonlySet<string>;
};
export const SubitemsContext = createContext<SubitemsTable | null>(null);

/** The footer calculation per column (the view's `summaries`) and how to change it. */
export type SummaryChoices = { choices: Record<string, SummaryFn>; choose: (columnId: string, fn: SummaryFn) => void };
export const SummaryChoicesContext = createContext<SummaryChoices | null>(null);

/** Each subitem level sits further in, like stairs (D14) — never on the parent's line. */
// The parent's name sits after its checkbox and arrow, so a level steps in further than that.
const SUB_INDENT = 64;

/** A group's colour as CSS (`var(--c-<key>)`, follows dark mode); unknown keys read as the first palette colour. */
export const groupColor = (g: Group) => paint(groupColorHex(g.color));

/**
 * The table as one flat list of rows, so only what is on screen is rendered (11-UI §12: 10k items).
 * Each open group: its name line, then its box — its own column headers (`head`, the box's rounded top), rows,
 * "+ add" and the summary. A collapsed group is one framed row (`folded`) with the column summaries.
 */
type Row = (
  | { kind: 'title'; s: Section }
  | { kind: 'folded'; s: Section }
  | { kind: 'head'; s: Section }
  | { kind: 'item'; s: Section; item: Item; end: boolean; at: number }
  | { kind: 'empty'; s: Section; end: boolean }
  | { kind: 'add'; s: Section; end: boolean }
  | { kind: 'summary'; s: Section; add: boolean }
  | { kind: 'gap'; s: Section }
  | { kind: 'subhead'; s: Section; parent: Item; depth: number; end: boolean }
  | { kind: 'subitem'; s: Section; item: Item; depth: number; end: boolean }
  | { kind: 'subsum'; s: Section; parent: Item; depth: number; end: boolean }
  | { kind: 'subadd'; s: Section; parent: Item; depth: number; end: boolean }
) & { top?: boolean };

/** Rows whose own markup holds the grid's cells (item rows, header rows); the others get one spanning cell. */
const holdsCells = (row: Row) =>
  (row.kind === 'item' && !isStub(row.item)) || row.kind === 'subitem' || row.kind === 'head' || row.kind === 'subhead';

/** Item rows by the view's row height (15 §7): one, two or three lines. */
export const ROW_PX = { single: 38, double: 56, triple: 76 } as const; // F4: --row-h 38

const HEIGHT: Record<Row['kind'], number> = {
  title: 44,
  folded: 68,
  head: HEADER_PX,
  item: 36,
  empty: 32,
  add: 34,
  summary: 34,
  gap: 28,
  subhead: 32,
  subitem: 36,
  subsum: 34,
  subadd: 34,
};

const buildRows = (
  sections: Section[],
  collapsed: Set<string>,
  canAdd: boolean,
  showSummary: boolean,
  sub: SubitemsTable | null,
): Row[] => {
  const rows: Row[] = [];
  // An open item is followed by its subitems' table: header, rows (open ones nest further), "add".
  const subtree = (s: Section, parent: Item, depth: number) => {
    rows.push({ kind: 'subhead', s, parent, depth, end: false });
    const children = sub?.childrenOf.get(parent.id) ?? [];
    for (const child of children) {
      rows.push({ kind: 'subitem', s, item: child, depth, end: false });
      if (sub?.expanded.has(child.id)) subtree(s, child, depth + 1);
    }
    // Owner fix: "+ add subitem" right under the last subitem, then the subitems' own footer (a sum, count or
    // range per sub-board column, like a group's) — the same order as a group's add row and summary.
    if (canAdd) rows.push({ kind: 'subadd', s, parent, depth, end: false });
    if (showSummary && children.length) rows.push({ kind: 'subsum', s, parent, depth, end: false });
  };
  // Nested (ק3): the open parents; a parent's summary row follows its last child. A collapsed parent hides its levels.
  const open: Section[] = [];
  const closeTo = (level: number) => {
    while (open.length && (open.at(-1)!.level ?? 0) >= level) {
      const p = open.pop()!;
      if (showSummary && (p.count ?? p.items.length) > 0) rows.push({ kind: 'summary', s: p, add: false });
      rows.push({ kind: 'gap', s: p });
    }
  };
  let hiddenBelow: number | null = null;
  for (const s of sections) {
    const level = s.level ?? 0;
    if (hiddenBelow !== null && level > hiddenBelow) continue;
    hiddenBelow = null;
    closeTo(level);
    if (s.header) {
      if (collapsed.has(s.key)) {
        rows.push({ kind: 'folded', s });
        rows.push({ kind: 'gap', s });
        hiddenBelow = level;
      } else {
        rows.push({ kind: 'title', s });
        open.push(s);
      }
      continue;
    }
    if (collapsed.has(s.key)) rows.push({ kind: 'folded', s });
    else {
      rows.push({ kind: 'title', s });
      rows.push({ kind: 'head', s, top: true });
      const add = (!!s.group || !!s.seed) && canAdd;
      const summary = showSummary && s.items.length > 0;
      s.items.forEach((item, at) => {
        rows.push({ kind: 'item', s, item, end: false, at });
        if (sub?.expanded.has(item.id)) subtree(s, item, 1);
      });
      // The section's last body row draws its bottom edge when nothing follows it.
      const last = rows.at(-1)!;
      if (s.items.length && !add && !summary && 'end' in last) last.end = true;
      if (!s.items.length) rows.push({ kind: 'empty', s, end: !add });
      // The add field keeps its own row, right under the last item and above the summary (owner fix): merging it
      // into the summary row would rebuild the field (and drop what is being typed) the moment the group's first
      // item appears and the summary row shows up.
      if (add) rows.push({ kind: 'add', s, end: !summary });
      if (summary) rows.push({ kind: 'summary', s, add: false });
    }
    rows.push({ kind: 'gap', s });
  }
  closeTo(0);
  return rows;
};

const FULL_RENDER_ROWS = 400;

const rowKey = (r: Row) => {
  switch (r.kind) {
    case 'item':
    case 'subitem':
      return `${r.kind}:${r.s.key}:${r.item.id}`;
    case 'subhead':
    case 'subsum':
    case 'subadd':
      return `${r.kind}:${r.s.key}:${r.parent.id}`;
    default:
      return `${r.kind}:${r.s.key}`;
  }
};

/** The table (11-UI §2): sections with a colour rail, column headers, inline cells, summaries — virtualised. */
export const BoardTable = ({
  board,
  sections,
  columns,
  members,
  mutations: m,
  collapsed,
  onToggle,
  onCollapseAll,
  onExpandAll,
  onWidth,
  scrollRef,
  env,
  showSummary,
  rowHeight = 'single',
  wrapText = false,
  search,
  manualOrder = false,
  onReorderColumns,
  canReorderColumns,
  groupSummary = null,
  nameWidth = NAME_WIDTH,
  sort,
  onSort,
  onRange,
  levelActions,
}: {
  /** A windowed board: the item ids on screen (and a margin around), whenever that range changes. */
  onRange?: (ids: string[]) => void;
  /** A nested grouping (ק3): collapse every section of a level, open them all again (a level title's menu). */
  levelActions?: LevelActions;
  board: BoardDetail;
  sections: Section[];
  /** Visible columns in order (the name column excluded), widths already personal. */
  columns: Column[];
  members: Member[];
  mutations: Mutations;
  collapsed: Set<string>;
  onToggle: (key: string) => void;
  onCollapseAll: () => void;
  /** Prod fix (r15board 1): every group is collapsed — the group menu offers "expand all" instead. */
  onExpandAll?: () => void;
  /** Live (while dragging) and final widths go to personal prefs (15 §9.5). */
  onWidth: (columnId: string, width: number) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  env: QueryEnv;
  showSummary: boolean;
  rowHeight?: keyof typeof ROW_PX;
  /** Long text wraps onto the row's lines instead of being cut. */
  wrapText?: boolean;
  /** The board search: its matches are marked in the cells. */
  search?: string;
  /** No sort and no grouping by a column: items can be dragged within and between groups. */
  manualOrder?: boolean;
  /** Header drag = the view's column order (a draft); `order` = every column but the name, in the new order. */
  onReorderColumns?: (order: string[]) => void;
  /** Who may drag columns here (default: `column.reorder`); a personal order on the default table lets anyone. */
  canReorderColumns?: boolean;
  /** N3: the view's one field summarised next to each group's name (off = null). */
  groupSummary?: GroupSummarySetting | null;
  /** The item name column's width (personal, like the others; `onWidth` with the name column's id changes it). */
  nameWidth?: number;
  /** The view's sort (`query.sort`) and how to change it (a draft) — the headers' sort buttons. */
  sort?: SortLevel[];
  onSort?: (sort: SortLevel[]) => void;
}) => {
  const sub = useContext(SubitemsContext);
  // Round 13: row heights follow the user's text size, and item rows their table density (lib/appearance.ts).
  const look = useAppearance();
  const rowPx = look.rowPx(ROW_PX[rowHeight]);
  const headerPx = look.rowPx(HEADER_PX, false);
  const fixedPx = look.scale;
  // while a group is dragged every group shows folded (not saved — `collapsed` comes back after).
  const [groupDrag, setGroupDrag] = useState<string | null>(null);
  const shownCollapsed = useMemo(
    () => (groupDrag ? foldedWhileDragging(sections, collapsed) : collapsed),
    [groupDrag, sections, collapsed],
  );
  const rows = useMemo(
    () => buildRows(sections, shownCollapsed, !!board.capabilities['item.create'], showSummary, sub),
    [sections, shownCollapsed, board.capabilities, showSummary, sub],
  );
  const template = useMemo(
    () => [`${nameWidth}px`, ...columns.map((c) => `${c.width}px`), `${ADD_COL_WIDTH}px`].join(' '),
    [columns, nameWidth],
  );
  // The box adds its 1px end line and the colour rail on the leading edge. r18board 2: when an open
  // subitems table is wider than the items' columns, the whole table takes its width — the item rows and headers
  // then continue to the end (their grids fill the row) instead of the subitems sticking out past the box.
  const mainWidth = nameWidth + columns.reduce((w, c) => w + c.width, 0) + ADD_COL_WIDTH;
  const subBoardCols = sub?.board?.columns;
  const subHidden = sub?.hiddenColumns;
  const subWidth = useMemo(() => {
    if (!subBoardCols) return 0;
    let depth = 0;
    for (const r of rows) if (r.kind === 'subhead' && r.depth > depth) depth = r.depth;
    if (!depth) return 0;
    const name = Math.max(NAME_MIN, subBoardCols.find((c) => c.type === 'name')?.width ?? 240);
    const cols = subBoardCols
      .filter((c) => c.type !== 'name' && !subHidden?.includes(c.id))
      .reduce((w, c) => w + c.width, 0);
    // Indent per level + the sub table's own 2px rail.
    return depth * SUB_INDENT + 2 + name + cols + ADD_COL_WIDTH;
  }, [rows, subBoardCols, subHidden]);
  const width = Math.max(mainWidth, subWidth) + RAIL_PX + 1;

  // Where the list starts inside the scroll area (the virtualiser counts from there).
  const listRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    if (listRef.current) setMargin(listRef.current.offsetTop);
  }, []);

  // The row being dragged stays rendered while the list scrolls under it (its drag would end otherwise).
  const [dragging, setDragging] = useState<string | null>(null);
  const draggingIndex = useMemo(
    () =>
      dragging
        ? rows.findIndex(
            (r) =>
              ((r.kind === 'item' || r.kind === 'subitem') && r.item.id === dragging) ||
              // A dragged group: its (folded) title.
              ((r.kind === 'folded' || r.kind === 'title') && r.s.group?.id === dragging),
          )
        : -1,
    [rows, dragging],
  );
  const rangeExtractor = useCallback(
    (range: Range) => {
      const list = defaultRangeExtractor(range);
      if (draggingIndex < 0 || list.includes(draggingIndex)) return list;
      return [...list, draggingIndex].sort((a, b) => a - b);
    },
    [draggingIndex],
  );

  const sizeOf = useCallback(
    (r: Row) => (r.kind === 'item' || r.kind === 'subitem' ? rowPx : Math.round(HEIGHT[r.kind] * fixedPx)),
    [rowPx, fixedPx],
  );

  // eslint-disable-next-line react-hooks/incompatible-library -- the compiler skips memoising this one component
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => sizeOf(rows[i]!),
    getItemKey: (i) => rowKey(rows[i]!),
    // Small boards render every row (find-in-page, keyboard and tests reach everything); big ones only the window.
    overscan: rows.length <= FULL_RENDER_ROWS ? rows.length : 12,
    rangeExtractor,
    scrollMargin: margin,
    // Rows scrolled to (keyboard grid) stop below the sticky header, not under it.
    scrollPaddingStart: headerPx,
  });

  // The dragged group's title stays where it was on screen as every group folds at the drag's start, and as they
  // open again at its end (the rows above it change height in between).
  const foldAnchor = useRef<{ groupId: string; top: number } | null>(null);
  const onGroupDrag = useCallback(
    (groupId: string | null) => {
      const id = groupId ?? groupDrag;
      const scroller = scrollRef.current;
      const key = id ? sections.find((s) => s.group?.id === id)?.key : undefined;
      const el =
        key && scroller
          ? scroller.querySelector<HTMLElement>(`[data-testid="group-header"][data-section="${CSS.escape(key)}"]`)
          : null;
      foldAnchor.current =
        id && el && scroller
          ? { groupId: id, top: el.getBoundingClientRect().top - scroller.getBoundingClientRect().top }
          : null;
      setGroupDrag(groupId);
    },
    [groupDrag, scrollRef, sections],
  );
  useLayoutEffect(() => {
    const a = foldAnchor.current;
    foldAnchor.current = null;
    const scroller = scrollRef.current;
    if (!a || !scroller) return;
    const index = rows.findIndex((r) => (r.kind === 'folded' || r.kind === 'title') && r.s.group?.id === a.groupId);
    const start = index < 0 ? undefined : virtualizer.measurementsCache[index]?.start;
    if (start !== undefined) scroller.scrollTop = keepInPlace(start, a.top);
  }, [groupDrag, rows, scrollRef, virtualizer]);

  useSearchHighlight(listRef, search);

  // Windowed boards: report the item rows in view (plus a screen's worth around them) so they get loaded.
  const shown = virtualizer.getVirtualItems();
  const firstShown = shown[0]?.index ?? 0;
  const lastShown = shown.at(-1)?.index ?? -1;
  useEffect(() => {
    if (!onRange || lastShown < 0) return;
    const span = lastShown - firstShown + 1;
    const ids: string[] = [];
    for (let i = Math.max(0, firstShown - span); i <= Math.min(rows.length - 1, lastShown + span); i++) {
      const r = rows[i]!;
      if (r.kind === 'item') ids.push(r.item.id);
    }
    if (ids.length) onRange(ids);
  }, [onRange, rows, firstShown, lastShown]);

  // A new row height changes every item row's size.
  useEffect(() => virtualizer.measure(), [sizeOf, virtualizer]);

  // Each open group's box, from its header row to its bottom edge (list coordinates, the sizes above): while the
  // box scrolls by, its header row sticks to the top of the table, and the next group's box pushes it away.
  const boxes = useMemo(() => {
    const out: { s: Section; start: number; end: number }[] = [];
    let y = 0;
    let open: { s: Section; start: number } | null = null;
    for (const r of rows) {
      if (r.kind === 'head') open = { s: r.s, start: y };
      if (r.kind === 'gap' && open) {
        out.push({ ...open, end: y });
        open = null;
      }
      y += sizeOf(r);
    }
    return out;
  }, [rows, sizeOf]);
  const [stuck, setStuck] = useState<{ key: string; top: number } | null>(null);
  // Fix: sticky offsets count from the scroll box's padding edge — the strip sticks at its very top edge
  // (minus the box's top padding), so no rows show through a gap above the stuck header.
  const [pad, setPad] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setPad(parseFloat(getComputedStyle(el).paddingTop) || 0);
    const onScroll = () => {
      const y = el.scrollTop - margin;
      const box = boxes.find((b) => b.start < y && y < b.end - headerPx / 2);
      const next = box ? { key: box.s.key, top: Math.min(0, box.end - headerPx - y) } : null;
      setStuck((cur) => (cur?.key === next?.key && cur?.top === next?.top ? cur : next));
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, margin, boxes, headerPx]);
  const stuckSection = stuck ? boxes.find((b) => b.s.key === stuck.key)?.s : undefined;

  // Keyboard grid over item and subitem rows (07 §10).
  const order = useMemo(
    () => rows.flatMap((r) => (r.kind === 'item' || r.kind === 'subitem' ? [r.item.id] : [])),
    [rows],
  );
  const reveal = useCallback(
    (itemId: string) => {
      const i = rows.findIndex((r) => (r.kind === 'item' || r.kind === 'subitem') && r.item.id === itemId);
      if (i >= 0) virtualizer.scrollToIndex(i, { align: 'auto' });
    },
    [rows, virtualizer],
  );
  const { id: accountId } = useContext(BoardAccountContext);
  const teams = useTeams(accountId).data?.data;
  const tags = useTags(accountId).data?.data;
  const people = useMemo<TextPerson[]>(
    () => [
      ...members.map((p) => ({ id: p.user_id, kind: 'person' as const, name: p.name, email: p.email })),
      ...(teams ?? []).map((x) => ({ id: x.id, kind: 'team' as const, name: x.name })),
    ],
    [members, teams],
  );
  const rowSelection = useContext(SelectionContext);
  const subSelection = useContext(SubitemsContext)?.selection;
  const grid = useGridState({
    order,
    tableRef: listRef,
    reveal,
    people,
    rowsSelected: !!rowSelection?.ids.length || !!subSelection?.ids.length,
  });

  // Fix: grouped by a column, a row dragged to another section takes that section's value (like a Kanban
  // lane) — the board's groups stay as they are. Within its own section it keeps its order logic (its own group).
  const latestM = useRef(m);
  useEffect(() => {
    latestM.current = m;
  });
  const bucketDrag = useMemo<BucketDrag | null>(() => {
    // Nested (ק3): rows live in the deepest level's sections; a drop sets that level's column (and the others').
    const leaves = sections.filter((x) => !x.header);
    const nested = leaves.length !== sections.length || leaves.some((x) => x.level !== undefined);
    const first = leaves[0];
    if (!first || leaves.some((x) => x.group)) return null;
    const columnId = first.column ?? first.key.slice(0, first.key.indexOf(':'));
    const column = board.columns.find((c) => c.id === columnId) ?? null;
    return {
      columnId,
      column,
      // Fix: "move to group" offers every value of the column, not only the sections shown (one level).
      targets: nested
        ? leaves
        : bucketTargets(sections, column, {
            groupId: board.groups[0]?.id,
            members,
            teams: teams ?? [],
            tags: tags ?? [],
            emptyLabel: t('group.empty'),
            checkedLabel: t('group.checked'),
          }),
      sorted: !!sort?.length,
      canMove: !!board.capabilities['item.move_group'],
      canEdit: !!board.capabilities['item.update'],
      place: (v) =>
        latestM.current.placeItem.mutate(v, {
          onSuccess: (res) => rememberEdit(accountId, (res as Item & { event_id?: string | null }).event_id),
        }),
      sections: leaves,
      set: (item, value, to, gesture) => {
        // At once on screen (the server's answer replaces it); Ctrl+Z undoes it like any cell edit.
        latestM.current.patchItem(item.id, (i) => {
          const cells = { ...i.cells };
          if (value === null) delete cells[columnId];
          else cells[columnId] = { value, text: to.title };
          return { ...i, cells };
        });
        const g = gesture ?? (nested ? `bucket:${item.id}:${Date.now()}` : undefined);
        latestM.current.setCell.mutate({ itemId: item.id, columnId, value, gesture: g });
        // ק3: the parent levels' values too, where the target section's differ (one Ctrl+Z for all).
        if (nested)
          for (const [col, v] of Object.entries(to.seed?.cells ?? {})) {
            if (col === columnId || JSON.stringify(item.cells[col]?.value ?? null) === JSON.stringify(v)) continue;
            latestM.current.setCell.mutate({ itemId: item.id, columnId: col, value: v, gesture: g });
          }
      },
    };
  }, [sections, board.columns, board.groups, board.capabilities, sort, accountId, members, teams, tags]);
  // Fix: b: the batch bar (outside the table) moves selected items between these sections too.
  useEffect(() => {
    publishBucketDrag(board.id, bucketDrag);
    return () => publishBucketDrag(board.id, null);
  }, [board.id, bucketDrag]);

  // Fix: Shift+Tab on checked subitems moves them one level up (a sub-subitem under its grandparent, a
  // subitem to an item). The keyboard grid's own Shift+Tab (previous cell) waits while subitems are checked.
  // the batch bar's "one level up" — one request, one batch, one undo; a checked subitem whose
  // parent is checked too goes along with it (the server's rule).
  const subChecked = sub?.selection;
  const subBulk = sub?.mutations.bulk;
  const canOutdent = !!board.capabilities['item.update'];
  const treeToast = useUndoToast(accountId);
  useEffect(() => {
    if (!subChecked?.ids.length || !subBulk || !canOutdent) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (hasOpenLayers() || isTyping(e.target)) return;
      e.preventDefault();
      const ids = subChecked.ids;
      subChecked.clear();
      subBulk.mutate(
        { item_ids: ids, action: { type: 'move_up' } },
        {
          onSuccess: (res) => treeToast(t('batch.done.up', { n: res.done }), res.event_id),
          onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
        },
      );
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [subChecked, subBulk, canOutdent, treeToast]);

  // The column headers, the same in every group's box (and in the one stuck to the top) — with the group's own
  // "select all" box (fix).
  const header = (s: Section) => (
    <HeaderRow
      board={board}
      columns={columns}
      template={template}
      nameWidth={nameWidth}
      mutations={m}
      onWidth={onWidth}
      onReorder={onReorderColumns}
      canReorder={canReorderColumns}
      sort={sort}
      onSort={onSort}
      select={
        <SelectAllBox
          ids={s.items.map((i) => i.id)}
          label={t('select.group', { name: s.title })}
          testId="section-select"
        />
      }
    />
  );

  return (
    <LevelActionsContext.Provider value={levelActions ?? null}>
      <GridContext.Provider value={grid}>
        <ManualOrderContext.Provider value={manualOrder && !!board.capabilities['item.move_group']}>
          <BucketDragContext.Provider value={bucketDrag}>
            {/*
          The header row of the group scrolled under the top edge, stuck there. A zero-height sticky
          strip in the same scroll box as the rows, so it follows them sideways. No transform (fixed popovers).
        */}
            <div className="sticky z-40 h-0" style={{ top: -pad, width, minWidth: '100%' }}>
              {stuck && stuckSection ? (
                <div
                  // Opaque under the box's rounded corners too: nothing scrolls through behind the stuck header.
                  className="absolute inset-x-0 overflow-hidden bg-surface"
                  style={{ top: stuck.top, height: headerPx }}
                  data-testid="sticky-header"
                  data-section={stuck.key}
                  // A visual copy of a header row that is in the grid already.
                  aria-hidden
                >
                  <Box top>{header(stuckSection)}</Box>
                </div>
              ) : null}
            </div>
            <RowDnd onActive={setDragging} onGroup={onGroupDrag}>
              <div
                ref={listRef}
                className="relative"
                style={
                  {
                    height: virtualizer.getTotalSize(),
                    width,
                    minWidth: '100%',
                    '--row-h': `${rowPx}px`,
                    '--name-w': `${nameWidth}px`,
                    '--row-lines': rowHeight === 'single' ? 1 : rowHeight === 'double' ? 2 : 3,
                  } as React.CSSProperties
                }
                data-wrap={wrapText || undefined}
                data-row-height={rowHeight}
                data-testid="board-table"
                data-tour="board.table"
                // Audit 2026-10-10 ux #6 (11-UI §12): a grid for screen readers. Every rendered line is a row with its
                // index in the whole list (rows are virtualized); item rows hold one gridcell per column.
                role="grid"
                aria-label={board.name}
                aria-rowcount={rows.length}
                aria-colcount={columns.length + 1}
              >
                {virtualizer.getVirtualItems().map((v) => {
                  const row = rows[v.index]!;
                  const view = (
                    <RowView
                      row={row}
                      board={board}
                      columns={columns}
                      template={template}
                      members={members}
                      mutations={m}
                      onToggle={onToggle}
                      onCollapseAll={onCollapseAll}
                      onExpandAll={onExpandAll}
                      env={env}
                      groupSummary={groupSummary}
                      header={header}
                    />
                  );
                  return (
                    <div
                      key={v.key}
                      className="absolute inset-x-0"
                      // `top`, not a transform: a transformed ancestor would trap the fixed-position cell popovers and menus.
                      style={{ height: v.size, top: v.start - margin }}
                      role="row"
                      aria-rowindex={v.index + 1}
                    >
                      {holdsCells(row) ? (
                        view
                      ) : (
                        // A group title, "+ add", an empty group or a summary: one cell across the row.
                        <div role="gridcell" aria-colspan={columns.length + 1} className="h-full">
                          {view}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </RowDnd>
          </BucketDragContext.Provider>
        </ManualOrderContext.Provider>
      </GridContext.Provider>
    </LevelActionsContext.Provider>
  );
};

/**
 * Rows inside a section's box get its frame (F4 .gbox): a 1px line, rounded top/bottom. Our look (11-UI §9.1): the
 * group's colour is the bar beside its name and the name itself — no colour rail down the rows.
 */
const Box = ({ top, end, children }: { top?: boolean; end?: boolean; children: React.ReactNode }) => (
  <div
    role="presentation"
    className={cn(
      'h-full border-x border-line bg-surface',
      // Clip the rows' fills to the rounded corners (clip, not hidden: no scroll box, so sticky cells still stick).
      (top || end) && 'overflow-clip',
      top && 'rounded-t-[12px] border-t',
      end && 'rounded-b-[12px] border-b',
    )}
  >
    {children}
  </div>
);

const RowView = ({
  row,
  board,
  columns,
  template,
  members,
  mutations: m,
  onToggle,
  onCollapseAll,
  onExpandAll,
  env,
  groupSummary,
  header,
}: {
  row: Row;
  board: BoardDetail;
  columns: Column[];
  template: string;
  members: Member[];
  mutations: Mutations;
  onToggle: (key: string) => void;
  onCollapseAll: () => void;
  onExpandAll?: () => void;
  env: QueryEnv;
  groupSummary: GroupSummarySetting | null;
  /** The group's column header row. */
  header: (s: Section) => ReactNode;
}) => {
  const manualOrder = useContext(ManualOrderContext);
  const bucketing = !!useContext(BucketDragContext);
  switch (row.kind) {
    case 'head':
      return (
        <Box top>
          <div className="h-full" data-testid="group-header" data-tour="board.group" data-section={row.s.key}>
            {header(row.s)}
          </div>
        </Box>
      );
    case 'title':
    case 'folded':
      return (
        <SectionTitle
          board={board}
          section={row.s}
          collapsed={row.kind === 'folded'}
          folded={row.kind === 'folded' ? { columns, template, env } : undefined}
          onToggle={() => onToggle(row.s.key)}
          onCollapseAll={onCollapseAll}
          onExpandAll={onExpandAll}
          mutations={m}
          summary={
            groupSummary && row.s.items.length ? (
              <GroupSummary
                setting={groupSummary}
                board={board}
                items={row.s.items}
                env={env}
                pre={row.s.groupSummary}
              />
            ) : null
          }
        />
      );
    case 'item': {
      // A windowed board's row that is not loaded yet: its place, until the window brings it.
      if (isStub(row.item))
        return (
          <Box top={row.top} end={row.end}>
            <div className="flex h-full items-center px-3" data-testid="row-loading" data-item={row.item.id}>
              <Skeleton className="h-3 w-48" />
            </div>
          </Box>
        );
      // Its index in the section (kept on the row: an indexOf per rendered row costs on a 30k-item section).
      const at = row.at;
      const drag =
        manualOrder && row.s.group
          ? {
              groupId: row.s.group.id,
              prevId: row.s.items[at - 1]?.id ?? null,
              nextId: row.s.items[at + 1]?.id ?? null,
            }
          : undefined;
      return (
        <Box top={row.top} end={row.end}>
          <ItemRow
            board={board}
            item={row.item}
            columns={columns}
            template={template}
            members={members}
            mutations={m}
            drag={drag}
            bucket={bucketing ? row.s : undefined}
            alt={at % 2 === 1}
          />
        </Box>
      );
    }
    case 'empty':
      return (
        <Box top={row.top} end={row.end}>
          <GroupEndDrop section={row.s} mutations={m}>
            <p className="px-3 py-2 text-xs text-muted">{t('board.empty')}</p>
          </GroupEndDrop>
        </Box>
      );
    case 'add':
      return (
        <Box top={row.top} end={row.end}>
          <GroupEndDrop section={row.s} mutations={m}>
            <div className="h-full bg-surface-3">
              <AddItemRow
                board={board}
                groupId={row.s.group?.id ?? row.s.seed!.groupId}
                cells={row.s.seed?.cells}
                mutations={m}
              />
            </div>
          </GroupEndDrop>
        </Box>
      );
    case 'summary':
      return (
        <Box end>
          {row.add ? (
            <GroupEndDrop section={row.s} mutations={m}>
              <SummaryRow
                items={row.s.items}
                columns={columns}
                template={template}
                env={env}
                pre={row.s.summaries}
                name={
                  <AddItemRow
                    board={board}
                    groupId={row.s.group?.id ?? row.s.seed!.groupId}
                    cells={row.s.seed?.cells}
                    mutations={m}
                  />
                }
              />
            </GroupEndDrop>
          ) : (
            <SummaryRow items={row.s.items} columns={columns} template={template} env={env} pre={row.s.summaries} />
          )}
        </Box>
      );
    case 'gap':
      return null;
    case 'subhead':
    case 'subitem':
    case 'subsum':
    case 'subadd':
      return <SubRow row={row} members={members} env={env} />;
  }
};

/** A row of a subitems table (D14): indented one step per level, with a rail in the section's colour. */
const SubRow = ({
  row,
  members,
  env,
}: {
  row: Extract<Row, { kind: 'subhead' | 'subitem' | 'subsum' | 'subadd' }>;
  members: Member[];
  env: QueryEnv;
}) => {
  const sub = useContext(SubitemsContext);
  const subBoard = sub?.board;
  const hiddenSub = sub?.hiddenColumns;
  const columns = useMemo(
    () => subBoard?.columns.filter((c) => c.type !== 'name' && !hiddenSub?.includes(c.id)) ?? [],
    [subBoard, hiddenSub],
  );
  // The sub-board's own columns for its footer calculations.
  const subEnv = useMemo<QueryEnv>(
    () => ({
      ...env,
      columns: (subBoard?.columns ?? []).map(queryColumnOf),
    }),
    [env, subBoard],
  );
  if (!sub || (!subBoard && row.kind !== 'subadd'))
    return (
      <Box top={row.top} end={row.end}>
        {/* N16: the sub-board is still loading — a placeholder line where its header will be. */}
        {sub && row.kind === 'subhead' ? (
          <div
            className="flex h-full items-center px-3"
            style={{ paddingInlineStart: row.depth * SUB_INDENT }}
            data-testid="subitems-loading"
          >
            <Skeleton className="h-3 w-48" />
          </div>
        ) : null}
      </Box>
    );
  const nameWidth = Math.max(NAME_MIN, subBoard?.columns.find((c) => c.type === 'name')?.width ?? 240);
  const template = [`${nameWidth}px`, ...columns.map((c) => `${c.width}px`), `${ADD_COL_WIDTH}px`].join(' ');
  return (
    <Box top={row.top} end={row.end}>
      <div
        className="h-full"
        style={{ paddingInlineStart: row.depth * SUB_INDENT }}
        data-testid={row.kind === 'subitem' ? undefined : row.kind}
        data-depth={row.depth}
      >
        {/*
          r18board 2: the subitems table runs to the full width of the table — when it has fewer
          columns than the items, its rows / header lines continue to the end instead of stopping in white.
        */}
        <div className="h-full w-max min-w-full border-s-2" style={{ borderInlineStartColor: row.s.color }}>
          {row.kind === 'subhead' ? (
            <HeaderRow
              board={subBoard!}
              columns={columns}
              template={template}
              nameWidth={nameWidth}
              mutations={sub.mutations}
              onWidth={sub.onWidth}
              sort={sub.sortLevels}
              onSort={sub.onSort}
              select={
                <SelectionContext.Provider value={sub.selection}>
                  <SelectAllBox
                    ids={(sub.childrenOf.get(row.parent.id) ?? []).map((c) => c.id)}
                    label={t('r15.select.subitems', { name: row.parent.name })}
                    testId="subitems-select"
                  />
                </SelectionContext.Provider>
              }
            />
          ) : row.kind === 'subsum' ? (
            // Footer choices are the main board's (per its column ids): the subitems use each type's default.
            <SummaryChoicesContext.Provider value={null}>
              <SummaryRow
                items={sub.childrenOf.get(row.parent.id) ?? []}
                columns={columns}
                template={template}
                env={subEnv}
                testId="subitems-summary"
              />
            </SummaryChoicesContext.Provider>
          ) : row.kind === 'subitem' ? (
            <SelectionContext.Provider value={sub.selection}>
              {sub.pathOnly?.has(row.item.id) ? (
                // r18board 1 (option א): shown only as the path to a deeper filter match — dimmed
                // and the tooltip says why (its own subitems, separate rows, keep full strength).
                <div
                  className="opacity-55"
                  data-tip={t('r18.board.pathOnly')}
                  data-testid="subitem-path-only"
                  data-path-only={row.item.id}
                >
                  <ItemRow
                    board={subBoard!}
                    item={row.item}
                    columns={columns}
                    template={template}
                    members={members}
                    mutations={sub.mutations}
                  />
                </div>
              ) : (
                <ItemRow
                  board={subBoard!}
                  item={row.item}
                  columns={columns}
                  template={template}
                  members={members}
                  mutations={sub.mutations}
                />
              )}
            </SelectionContext.Provider>
          ) : (
            <SubAddRow parent={row.parent} />
          )}
        </div>
      </div>
    </Box>
  );
};

/** "+ add subitem" under a parent's subitems. */
const SubAddRow = ({ parent }: { parent: Item }) => {
  const sub = useContext(SubitemsContext)!;
  const { id: accountId } = useContext(BoardAccountContext);
  const [name, setName] = useState('');
  const subComputed = computedNameInfo(sub.board).computed;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    // a computed sub-board names its subitems itself — the field only adds (no name is sent).
    if (subComputed) {
      sub.mutations.createSubitem.mutate({ parentId: parent.id });
      return;
    }
    if (!value) return;
    setName('');
    sub.mutations.createSubitem.mutate(
      { parentId: parent.id, name: value },
      { onError: () => setName((cur) => cur || value) },
    );
  };
  // fix6-table 5: a dragged subitem dropped here goes last under this parent (from this list or another one).
  const key = `subadd:${parent.id}`;
  useDropTarget(key, {
    zone: (d) => {
      if (!d.isSub || d.id === parent.id || d.branch.has(parent.id)) return null;
      if (d.parentId === parent.id) return sub.sorted ? null : 'end';
      return d.canReparent && parent.depth + 1 + d.height <= (sub.board?.hierarchy_depth_max ?? 1) ? 'end' : null;
    },
    drop: (d) => {
      if (d.parentId !== parent.id) {
        sub.mutations.reparentSubitem.mutate({ itemId: d.id, name: d.name, parentId: parent.id });
        return;
      }
      const siblings = sub.childrenOf.get(parent.id) ?? [];
      if (siblings.at(-1)?.id === d.id) return; // already last
      const last = siblings.filter((c) => c.id !== d.id).at(-1);
      if (!last) return;
      sub.mutations.reorderSubitem.mutate(
        { itemId: d.id, position: { after_id: last.id } },
        { onSuccess: (res) => rememberEdit(accountId, (res as Item & { event_id?: string | null }).event_id) },
      );
    },
  });
  const over = useDropZone(key);
  return (
    <form
      onSubmit={onSubmit}
      data-drop-key={key}
      data-drop={over || undefined}
      className={cn('flex h-[2.125rem] w-60 items-center px-3', over && 'shadow-[inset_0_2px_0_var(--primary)]')}
    >
      {subComputed ? (
        <button
          type="submit"
          data-testid="add-computed-subitem"
          autoFocus={sub.focusAdd === parent.id}
          className="truncate text-sm text-muted hover:text-primary"
        >
          + {t('subitems.add')}
        </button>
      ) : (
        <input
          autoFocus={sub.focusAdd === parent.id}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('subitems.add')}
          aria-label={t('subitems.add')}
          className="w-full rounded-[4px] bg-transparent text-sm outline-none placeholder:text-muted focus-visible:shadow-[0_0_0_2px_var(--focus-ring)]"
        />
      )}
    </form>
  );
};

const SectionTitle = ({
  board,
  section,
  collapsed,
  onToggle,
  onCollapseAll,
  onExpandAll,
  mutations: m,
  summary,
  folded,
}: {
  board: BoardDetail;
  section: Section;
  collapsed: boolean;
  /** Collapsed: the framed box with the column summaries (the table's columns and grid). */
  folded?: { columns: Column[]; template: string; env: QueryEnv };
  onToggle: () => void;
  onCollapseAll: () => void;
  onExpandAll?: () => void;
  mutations: Mutations;
  /** N3: the view's chosen field, summarised (muted, after the count). */
  summary?: ReactNode;
}) => {
  const menu = useActionMenu();
  const [palette, setPalette] = useState(false);
  const [moving, setMoving] = useState(false);
  const { id: accountId } = useContext(BoardAccountContext);
  const [renaming, setRenaming] = useState(false);
  const { group, color, items } = section;
  const caps = board.capabilities;
  const index = group ? board.groups.findIndex((g) => g.id === group.id) : -1;
  const prev = board.groups[index - 1];
  const next = board.groups[index + 1];
  const label = t('group.actions', { name: group?.title ?? section.title });
  const levelActions = useContext(LevelActionsContext);
  const entries: MenuEntry[] = group
    ? toMenuEntries(
        groupMenu({
          caps,
          collapsed,
          allCollapsed: !!onExpandAll,
          isFirst: !prev,
          isLast: !next,
          isOnly: board.groups.length <= 1,
        }),
        {
          collapse: onToggle,
          expand: onToggle,
          collapse_all: onCollapseAll,
          expand_all: () => onExpandAll?.(),
          rename: () => setRenaming(true),
          color: () => setPalette(true),
          add_above: () => m.createGroup.mutate({ title: t('board.newGroup'), position: { before_id: group.id } }),
          add_below: () => m.createGroup.mutate({ title: t('board.newGroup'), position: { after_id: group.id } }),
          move_up: () => prev && m.reorderGroup.mutate({ groupId: group.id, position: { before_id: prev.id } }),
          move_down: () => next && m.reorderGroup.mutate({ groupId: group.id, position: { after_id: next.id } }),
          archive: () => m.archiveGroup.mutate({ id: group.id, name: group.title }),
          duplicate: () => m.duplicateGroup.mutate({ id: group.id, name: group.title }),
          move_to_board: () => setMoving(true),
          delete: () =>
            void confirmDelete(group.title).then(
              (ok) => ok && m.deleteGroup.mutate({ id: group.id, name: group.title }),
            ),
        },
      )
    : [];
  // ק3: a nested level's title — collapse every section of its level, or open everything again.
  if (levelActions && section.level !== undefined)
    entries.push(
      {
        label: t('group.collapseLevel', { level: section.level + 1 }),
        onSelect: () => levelActions.collapse(section.level!),
        testId: 'group-collapse-level',
      },
      { label: t('group.expandEverything'), onSelect: levelActions.expandAll, testId: 'group-expand-everything' },
    );
  // a board group drags by the ⠿ on its title (like an item's row) and lands before / after another
  // group's title. Sections of a "group by" view are not groups; nested levels neither. The menu's "move up / down"
  // stays the keyboard way.
  const canDragGroup = !!group && section.level === undefined && !!caps['group.reorder'] && board.groups.length > 1;
  const groupKey = `${GROUP_DROP}${group?.id ?? section.key}`;
  const {
    setNodeRef: setGroupDragNode,
    listeners: groupDragListeners,
    node: groupDragNode,
  } = useDraggable({
    id: `group:${group?.id ?? section.key}`,
    disabled: !canDragGroup || renaming,
    data: {
      get: (): Dragged => ({
        id: group!.id,
        name: group!.title,
        isSub: false,
        parentId: null,
        branch: new Set(),
        height: 0,
        canReparent: false,
        width: groupDragNode.current?.offsetWidth ?? NAME_WIDTH,
        group: true,
      }),
    },
  });
  useDropTarget(
    groupKey,
    canDragGroup
      ? {
          zone: (d, y) => {
            if (d.id === group!.id) return null;
            const where = y < 0.5 ? 'before' : 'after';
            // Right beside itself already: nothing would change.
            return (where === 'before' ? prev : next)?.id === d.id ? null : where;
          },
          drop: (d, where) =>
            m.reorderGroup.mutate({
              groupId: d.id,
              position: where === 'before' ? { before_id: group!.id } : { after_id: group!.id },
            }),
        }
      : null,
  );
  const groupDrop = useDropZone(groupKey);
  const dropProps = canDragGroup
    ? { 'data-drop-key': groupKey, 'data-drop': groupDrop ?? undefined, ref: setGroupDragNode }
    : {};
  const handle = canDragGroup ? (
    <span
      data-drag-handle
      data-testid="group-drag"
      aria-hidden
      title={t('groups.drag')}
      className="cursor-grab touch-none select-none text-xs text-muted opacity-0 group-hover:opacity-100"
      {...groupDragListeners}
    >
      ⠿
    </span>
  ) : null;
  const toggle = (
    <button
      type="button"
      onClick={onToggle}
      className="grid size-6 shrink-0 place-items-center rounded-[7px] text-fg-2 hover:bg-surface-2"
      aria-expanded={!collapsed}
      aria-label={collapsed ? t('board.expandGroup') : t('board.collapseGroup')}
    >
      <Icon name={collapsed ? 'chevronEnd' : 'chevronDown'} size={13} strokeWidth={2.4} />
    </button>
  );
  // Our look (11-UI §9.1): a bar in the group's colour beside the name, and the name in the group's colour (kept
  // readable on the surface in every theme).
  const title = (
    <span data-testid="group-color" className="flex min-w-0 items-center gap-2" style={{ color: inkFor(color) }}>
      <span
        aria-hidden
        data-testid="group-bar"
        className="h-5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      {group ? (
        <EditableText
          value={group.title}
          editable={caps['group.update']}
          editing={renaming}
          onEditingChange={setRenaming}
          onSave={(title) => m.updateGroup.mutate({ groupId: group.id, title })}
          className="font-display text-base font-extrabold"
        />
      ) : (
        <span className="truncate font-display text-base font-extrabold">{section.title}</span>
      )}
    </span>
  );
  const tools = entries.length ? (
    <div className="relative">
      <MenuTrigger label={label} onClick={menu.fromTrigger} />
      <Menu at={menu.at} onClose={menu.close} items={entries} label={label} />
      {group && moving ? (
        <MoveDialog
          accountId={accountId}
          board={board}
          withGroup={false}
          title={t('move.title', { what: group.title })}
          onClose={() => setMoving(false)}
          onMove={(v) =>
            m.moveGroupToBoard.mutateAsync({ id: group.id, name: group.title, to: v.board, mapping: v.mapping })
          }
        />
      ) : null}
      {group ? (
        <Popover open={palette} onClose={() => setPalette(false)} className="w-56">
          {/* pal40: all forty colours. Prod fix (r15board 5): the palette stays open after a pick (outside click / Esc
              close it). */}
          <ColorGrid
            kind="pressed"
            label={t('board.groupColor')}
            testId="group-colors"
            itemTestId="group-color"
            selected={(k) => normalizeLabelColor(group.color) === k}
            onPick={(k) => m.updateGroup.mutate({ groupId: group.id, color: k })}
          />
        </Popover>
      ) : null}
    </div>
  ) : null;
  const n = section.count ?? items.length;
  const count = t('board.items', { n });
  // ק3: a nested level is indented under its parent.
  const indent = (section.level ?? 0) * LEVEL_INDENT;
  const menuProps = {
    onContextMenu: entries.length ? menu.onContextMenu : undefined,
    onKeyDown: entries.length ? menu.onKeyDown : undefined,
  };

  // Round 7 (product decision): a collapsed group is one framed box — the colour rail on its leading edge, the
  // name and "<n> items" in the name column, and each column's title over its summary (status battery, sums…).
  if (folded) {
    return (
      <div
        className={cn(
          'group grid h-[calc(100%-4px)] overflow-clip rounded-[12px] border border-line bg-surface',
          groupDrop && DROP_LINE[groupDrop],
        )}
        style={{ gridTemplateColumns: folded.template, marginInlineStart: indent }}
        data-testid="board-section"
        data-section={section.key}
        data-folded
        data-level={section.level}
        {...menuProps}
        {...dropProps}
      >
        <div className={cn('sticky start-0 z-10 flex min-w-0 items-center gap-2 bg-surface ps-2 pe-3', COL_SEP)}>
          {handle}
          {toggle}
          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
            {title}
            <span className="truncate text-xs text-muted" data-testid="group-count">
              {count}
            </span>
          </div>
          {summary}
          {tools}
        </div>
        <FoldedSummaries items={items} columns={folded.columns} env={folded.env} pre={section.summaries} />
        <div />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group sticky start-0 flex h-full w-max items-center gap-2 pt-1',
        groupDrop && DROP_LINE[groupDrop],
      )}
      style={indent ? { paddingInlineStart: indent } : undefined}
      data-level={section.level}
      data-testid="board-section"
      data-section={section.key}
      {...menuProps}
      {...dropProps}
    >
      {handle}
      {toggle}
      {title}
      {/* F4: the pill shows the number; the words stay for screen readers and the tooltip. */}
      <span className="rounded-full bg-surface-2 px-2 py-px text-xs font-normal text-fg-2 tabular-nums" title={count}>
        <span aria-hidden>{n}</span>
        <span className="sr-only">{count}</span>
      </span>
      {summary}
      {tools}
    </div>
  );
};

/** The columns of a collapsed group: each one's title over its summary; nothing where there is nothing to sum. */
const FoldedSummaries = ({
  items,
  columns,
  env,
  pre,
}: {
  items: Item[];
  columns: Column[];
  env: QueryEnv;
  pre?: Record<string, ColumnSummary | null>;
}) => {
  const summaries = useColumnSummaries(columns, items, env, pre);
  return (
    <>
      {columns.map((c, i) => {
        const s = summaries[i];
        return (
          <div
            key={c.id}
            className={cn('flex min-w-0 flex-col items-center justify-center gap-1 px-2', COL_SEP)}
            data-folded-column={c.id}
          >
            {s?.summary ? (
              <>
                <span className="max-w-full truncate text-xs font-semibold text-muted">{c.title}</span>
                <div className="flex w-full justify-center">
                  <SummaryCell summary={s.summary} defaultFn={s.options[0]} />
                </div>
              </>
            ) : null}
          </div>
        );
      })}
    </>
  );
};

/**
 * Selects / clears every row under a header (07 §6 "בחר הכל בקבוצה"): a group's items, or one parent's subitems —
 * always shown in the header row's name cell (fix); indeterminate when some are picked.
 */
export const SelectAllBox = ({ ids, label, testId }: { ids: string[]; label: string; testId: string }) => {
  const selection = useContext(SelectionContext);
  if (!selection) return null;
  const picked = ids.filter((id) => selection.has(id)).length;
  const state = !picked ? 'none' : picked === ids.length ? 'all' : 'some';
  return (
    <input
      type="checkbox"
      data-testid={testId}
      data-state={state}
      aria-label={label}
      disabled={!ids.length}
      checked={state === 'all'}
      ref={(el) => {
        if (el) el.indeterminate = state === 'some';
      }}
      onChange={() => selection.setMany(ids, picked < ids.length)}
      className="size-[0.9375rem] shrink-0 cursor-pointer accent-[var(--check)] disabled:cursor-default disabled:opacity-40"
    />
  );
};

const HeaderRow = ({
  board,
  columns,
  template,
  nameWidth,
  mutations: m,
  onWidth,
  onReorder,
  canReorder,
  sort,
  onSort,
  select,
}: {
  board: BoardDetail;
  columns: Column[];
  template: string;
  nameWidth: number;
  mutations: Mutations;
  onWidth: (columnId: string, width: number) => void;
  /** The main board's header: the order is the view's (a draft). Without it (sub-board) it is the board's. */
  onReorder?: (order: string[]) => void;
  /** Overrides `column.reorder` (a personal order on the default table). */
  canReorder?: boolean;
  /** The sort these columns take part in (the view's `query.sort` / `subitems_sort`); none = no sort buttons. */
  sort?: SortLevel[];
  onSort?: (sort: SortLevel[]) => void;
  /** The header's "select all" box, before the name column's title. */
  select?: ReactNode;
}) => {
  const sortBy = sort && onSort ? { levels: sort, set: onSort } : undefined;
  const caps = board.capabilities;
  const nameColumn = board.columns.find((c) => c.type === 'name');
  // Columns drag by their header (M1.1 #16); a 5px threshold keeps clicks (rename, menu) working.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const onColumnDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    // Reorder within the full column list (in the view's order), so hidden columns keep their place.
    const all = board.columns.filter((c) => c.type !== 'name').map((c) => c.id);
    const shown = columns.map((c) => c.id);
    const keys = [...shown, ...all.filter((id) => !shown.includes(id))];
    const moved = arrayMove(keys, keys.indexOf(String(active.id)), keys.indexOf(String(over.id)));
    if (onReorder) onReorder(moved);
    else m.reorderColumn.mutate({ columnId: String(active.id), order: [nameColumn!.id, ...moved] });
  };
  return (
    <DndContext
      accessibility={{ container: document.body }}
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onColumnDragEnd}
    >
      <SortableContext items={columns.map((c) => c.id)} strategy={horizontalListSortingStrategy}>
        <div
          className="grid h-full border-b border-line text-xs font-semibold text-muted"
          style={{ gridTemplateColumns: template }}
          data-testid="header-row"
          role="presentation"
        >
          <div
            className={cn('group sticky start-0 z-30 flex h-full items-center gap-2 bg-surface px-3', COL_SEP)}
            data-name-header={board.id}
            data-tour="board.column-header"
            role="columnheader"
            aria-colindex={1}
          >
            {select}
            <span className="truncate">{nameColumn?.title}</span>
            {nameColumn ? <ColumnInfo column={nameColumn} /> : null}
            {/*: "מקור שם הפריט" — this board's own setting (the sub-board's header has its own). */}
            {nameColumn ? (
              <span className={cn('ms-auto inline-flex', sortBy && 'me-5')}>
                <NameHeaderMenu board={board} column={nameColumn} />
              </span>
            ) : null}
            {nameColumn && sortBy ? <SortButton column={nameColumn} sortBy={sortBy} className="end-3" /> : null}
            {nameColumn ? (
              <ResizeHandle
                columnId={nameColumn.id}
                title={nameColumn.title}
                width={nameWidth}
                min={NAME_MIN}
                onWidth={onWidth}
                fit={() => fitNameWidth(board.id)}
                testId="name-resize"
              />
            ) : null}
          </div>
          {columns.map((c, i) => (
            <ColumnHeader
              key={c.id}
              colIndex={i + 2}
              board={board}
              column={c}
              canEdit={caps['column.update']}
              canReorder={canReorder ?? caps['column.reorder']}
              mutations={m}
              onWidth={onWidth}
              sortBy={sortBy}
            />
          ))}
          {caps['column.create'] ? <AddColumn mutations={m} /> : <div />}
        </div>
      </SortableContext>
    </DndContext>
  );
};

export type GroupSummarySetting = { column_id: string; fn?: SummaryFn };

/** Group summaries offered for a column: the footer's, without "none" (N3). */
export const groupSummaryOptions = (columnId: string, env: QueryEnv): SummaryFn[] => {
  try {
    return summaryOptions(resolveField(columnId, env)).filter((fn) => fn !== 'none');
  } catch {
    return [];
  }
};

/** The group-title summary's calculation: the setting's own, else the footer's for that column, else the default. */
export const groupSummaryFn = (setting: GroupSummarySetting, footer: SummaryFn | undefined, options: SummaryFn[]) =>
  [setting.fn, footer].find((f): f is SummaryFn => !!f && options.includes(f)) ?? options[0]!;

/**
 * N3: one field summarised next to a group's name — the same calculation as the footer (the view's own choice,
 * else the footer's for that column). Nothing when the column is gone or the group has nothing to sum.
 */
export const GroupSummary = ({
  setting,
  board,
  items,
  env,
  pre,
}: {
  setting: GroupSummarySetting;
  board: BoardDetail;
  items: Item[];
  env: QueryEnv;
  /** Computed by the server over the whole section (a windowed board); undefined = compute here. */
  pre?: ColumnSummary | null;
}) => {
  const footer = useContext(SummaryChoicesContext)?.choices[setting.column_id];
  const column = board.columns.find((c) => c.id === setting.column_id);
  const result = useMemo(() => {
    const options = groupSummaryOptions(setting.column_id, env);
    if (!options.length) return null;
    const fn = groupSummaryFn(setting, footer, options);
    if (pre !== undefined) return pre ? { summary: pre, fn } : null;
    try {
      const summary = summarize(resolveField(setting.column_id, env), items, env.timezone, fn);
      return summary ? { summary, fn } : null;
    } catch {
      return null;
    }
  }, [setting, footer, items, env, pre]);
  if (!result || !column) return null;
  const { summary, fn } = result;
  const title = `${column.title} · ${t(`summary.${fn}` as MessageKey)}`;
  const text =
    summary.kind === 'value'
      ? summary.text
      : summary.kind === 'done'
        ? `${summary.done}/${summary.total}`
        : summary.kind === 'range'
          ? summary.from === summary.to || summary.fn
            ? formatIsoDate(summary.from)
            : `${formatIsoDate(summary.from)} – ${formatIsoDate(summary.to)}`
          : null;
  return (
    <span
      data-testid="group-summary"
      // A battery's segments carry their own tooltips (fix6-table 3); the column + function name is its label.
      title={summary.kind === 'battery' ? undefined : title}
      className="flex shrink-0 items-center text-xs text-muted tabular-nums"
    >
      {summary.kind === 'battery' ? (
        <span
          className="flex h-2 w-16 gap-px overflow-hidden rounded-full"
          role="img"
          aria-label={`${title}: ${summary.segments.map((x) => segmentTitle(x, summary.total)).join(', ')}`}
        >
          {summary.segments.map((x) => (
            <span
              key={x.key}
              data-testid="battery-segment"
              title={segmentTitle(x, summary.total)}
              data-color={x.color}
              style={{ flexGrow: x.count, ...fill(x.color) }}
            />
          ))}
        </span>
      ) : (
        <span dir="ltr">{text}</span>
      )}
    </span>
  );
};

/**
 * Each column's calculation over `items` (the view's footer choice, else the type's default) and its options.
 * `pre`: computed by the server (a windowed board) — used as is.
 */
const useColumnSummaries = (
  columns: Column[],
  items: Item[],
  env: QueryEnv,
  pre?: Record<string, ColumnSummary | null>,
) => {
  const choices = useContext(SummaryChoicesContext)?.choices;
  return useMemo(
    () =>
      columns.map((c) => {
        try {
          const field = resolveField(c.id, env);
          return {
            options: summaryOptions(field),
            summary: pre ? (pre[c.id] ?? null) : summarize(field, items, env.timezone, choices?.[c.id]),
          };
        } catch {
          return { options: [] as SummaryFn[], summary: null };
        }
      }),
    [columns, items, env, choices, pre],
  );
};

/** The section footer (11-UI §2): a status battery, sums and averages, done counts, date ranges. */
const SummaryRow = ({
  items,
  columns,
  template,
  env,
  testId = 'summary-row',
  name,
  pre,
}: {
  items: Item[];
  columns: Column[];
  template: string;
  env: QueryEnv;
  testId?: string;
  /** What the name column holds (the group's "+ add item"). */
  name?: ReactNode;
  /** Summaries computed by the server (a windowed board). */
  pre?: Record<string, ColumnSummary | null>;
}) => {
  const ctx = useContext(SummaryChoicesContext);
  const choices = ctx?.choices;
  const summaries = useColumnSummaries(columns, items, env, pre);
  return (
    <div className="grid h-full bg-surface-3" style={{ gridTemplateColumns: template }} data-testid={testId}>
      <div className={cn('sticky start-0 z-10 bg-surface-3', COL_SEP)}>{name}</div>
      {columns.map((c, i) => (
        <SummarySlot
          key={c.id}
          column={c}
          options={summaries[i]?.options ?? []}
          current={choices?.[c.id]}
          onChoose={ctx ? (fn) => ctx.choose(c.id, fn) : undefined}
        >
          <SummaryCell summary={summaries[i]?.summary ?? null} defaultFn={summaries[i]?.options[0]} />
        </SummarySlot>
      ))}
      <div />
    </div>
  );
};

/** A footer cell; clicking it opens the calculations this column can show (the footer menu). */
export const SummarySlot = ({
  column,
  options,
  current,
  onChoose,
  children,
}: {
  column: Column;
  options: SummaryFn[];
  current: SummaryFn | undefined;
  onChoose?: (fn: SummaryFn) => void;
  children: React.ReactNode;
}) => {
  const menu = useActionMenu();
  const chosen = options.find((o) => o === current) ?? options[0];
  if (!onChoose || options.length < 2) {
    return (
      <div className={cn('flex min-w-0 items-center justify-center px-2', COL_SEP)} data-summary={column.id}>
        {children}
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        className={cn('flex min-w-0 cursor-pointer items-center justify-center px-2 hover:bg-surface-2', COL_SEP)}
        data-summary={column.id}
        aria-haspopup="menu"
        aria-label={t('summary.choose', { name: column.title })}
        title={t('summary.choose', { name: column.title })}
        onClick={menu.fromTrigger}
      >
        {children}
      </button>
      <Menu
        at={menu.at}
        onClose={menu.close}
        label={t('summary.choose', { name: column.title })}
        items={options.map((fn) => ({
          label: t(`summary.${fn}` as MessageKey),
          checked: fn === chosen,
          onSelect: () => onChoose(fn),
        }))}
      />
    </>
  );
};

/**
 * One battery segment's tooltip (fix6-table 3): "<label> · <n> (<pct>%)" — a blank label reads "(ריק)", so every
 * segment has one. Shown by the system tooltip from `title`.
 */
const segmentTitle = (s: { label: string; count: number }, total: number) =>
  `${s.label.trim() || t('filter.blank')} · ${s.count} (${total ? Math.round((s.count / total) * 100) : 0}%)`;

/** F4 footer: values 12px bold in the heading ink; the function's name only when it is not the column's default. */
export const SummaryCell = ({ summary, defaultFn }: { summary: ColumnSummary | null; defaultFn?: SummaryFn }) => {
  if (!summary) return null;
  const fnLabel = (fn: SummaryFn) =>
    fn === defaultFn ? null : <span className="text-[0.6875rem] text-muted">{t(`summary.${fn}`)}</span>;
  switch (summary.kind) {
    case 'battery':
      return (
        <div
          className="mx-0.5 flex h-2.5 min-w-0 flex-1 gap-px overflow-hidden rounded-full"
          role="img"
          aria-label={summary.segments.map((s) => segmentTitle(s, summary.total)).join(', ')}
        >
          {summary.segments.map((s) => (
            <div
              key={s.key}
              data-testid="battery-segment"
              title={segmentTitle(s, summary.total)}
              data-color={s.color}
              style={{ flexGrow: s.count, ...fill(s.color) }}
            />
          ))}
        </div>
      );
    case 'value':
      return (
        <div className="flex flex-col items-center leading-tight">
          <span dir="ltr" className="text-xs font-normal text-heading tabular-nums">
            {summary.text}
          </span>
          {fnLabel(summary.fn)}
        </div>
      );
    case 'done':
      return summary.fn ? (
        <div className="flex flex-col items-center leading-tight">
          <span dir="ltr" className="text-xs font-normal text-heading tabular-nums">
            {summary.done}/{summary.total}
          </span>
          {fnLabel(summary.fn)}
        </div>
      ) : (
        <span dir="ltr" className="text-xs font-normal text-heading tabular-nums">
          {summary.done}/{summary.total}
        </span>
      );
    case 'range':
      return summary.fn ? (
        <div className="flex flex-col items-center leading-tight">
          <span dir="ltr" className="text-xs font-normal text-heading">
            {formatIsoDate(summary.from)}
          </span>
          {fnLabel(summary.fn)}
        </div>
      ) : (
        <span dir="ltr" className="truncate text-xs font-normal text-heading">
          {summary.from === summary.to
            ? formatIsoDate(summary.from)
            : `${formatIsoDate(summary.from)} – ${formatIsoDate(summary.to)}`}
        </span>
      );
  }
};

export const EditableText = ({
  value,
  editable,
  onSave,
  className,
  style,
  editing: controlled,
  onEditingChange,
}: {
  value: string;
  editable: boolean;
  onSave: (v: string) => void;
  className?: string;
  style?: React.CSSProperties;
  /** Optional outside control, e.g. "rename" from a menu. */
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}) => {
  const [own, setOwn] = useState(false);
  const editing = controlled ?? own;
  const setEditing = (v: boolean) => (onEditingChange ? onEditingChange(v) : setOwn(v));
  if (editing) {
    return (
      <input
        autoFocus
        defaultValue={value}
        onBlur={(e) => {
          setEditing(false);
          const v = e.target.value.trim();
          if (v && v !== value) onSave(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setEditing(false);
        }}
        className={cn('min-w-0 border-b-2 border-primary bg-transparent outline-none', className)}
        style={style}
      />
    );
  }
  return (
    <span
      className={cn('truncate', editable && 'cursor-text', className)}
      style={style}
      onClick={() => editable && setEditing(true)}
    >
      {value}
    </span>
  );
};

const MIN_COL = 60;

/**
 * Double click on the name column's edge: wide enough for the longest name plus what sits beside it (check box,
 * arrow, update count, ⋯) and the padding.
 */
const fitNameWidth = (boardId: string) => {
  const sel = CSS.escape(boardId);
  let widest = 0;
  for (const cell of document.querySelectorAll<HTMLElement>(`[data-name-of="${sel}"]`)) {
    let w = 24; // px-3 on both sides
    let parts = 0;
    for (const el of Array.from(cell.children) as HTMLElement[]) {
      // The name itself may be cut: its full width. The spacer between the name and the tools takes nothing.
      const own = el.classList.contains('truncate')
        ? el.scrollWidth
        : el.classList.contains('flex-1')
          ? 0
          : el.offsetWidth;
      if (!own) continue;
      w += own;
      parts++;
    }
    widest = Math.max(widest, w + Math.max(0, parts - 1) * 8);
  }
  const title = document.querySelector<HTMLElement>(`[data-name-header="${sel}"] .truncate`);
  return Math.max(widest, (title?.scrollWidth ?? 0) + 24) + 8;
};
const MAX_COL = 800;
const clampWidth = (w: number) => Math.round(Math.min(MAX_COL, Math.max(MIN_COL, w)));

/**
 * Drag handle on a header's inline-end edge (M1.1 #16): drag to resize (live), double click = fit the widest
 * cell, ←/→ on the focused handle = ±10px. RTL flips the drag direction. Widths are personal (15 §9.5).
 */
const ResizeHandle = ({
  columnId,
  title,
  width,
  min = MIN_COL,
  onWidth,
  fit,
  testId = 'column-resize',
}: {
  columnId: string;
  title: string;
  width: number;
  min?: number;
  onWidth: (columnId: string, width: number) => void;
  /** Double click: the width that fits the widest content (default: the column's truncated texts). */
  fit?: () => number;
  testId?: string;
}) => {
  const clamp = (w: number) => Math.max(min, clampWidth(w));
  const onPointerDown = (e: React.PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation(); // not a column drag
    const startX = e.clientX;
    const start = width;
    const sign = getComputedStyle(e.currentTarget).direction === 'rtl' ? -1 : 1;
    const move = (ev: PointerEvent) => onWidth(columnId, clamp(start + sign * (ev.clientX - startX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const autofit = () => {
    if (fit) return onWidth(columnId, clamp(fit()));
    // The widest truncated text among this column's cells (and its title), plus the cell padding.
    const texts = document.querySelectorAll<HTMLElement>(
      `[data-column="${CSS.escape(columnId)}"] .truncate, [data-header="${CSS.escape(columnId)}"] .truncate`,
    );
    const widest = Math.max(0, ...Array.from(texts, (el) => el.scrollWidth));
    onWidth(columnId, clamp(widest + 36));
  };
  return (
    <span
      role="separator"
      aria-orientation="vertical"
      aria-label={t('column.resize', { name: title })}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={MAX_COL}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={autofit}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
        const grow = (e.key === 'ArrowRight') !== rtl;
        onWidth(columnId, clamp(width + (grow ? 10 : -10)));
      }}
      data-testid={testId}
      className="absolute inset-y-0 end-0 z-10 w-1.5 cursor-col-resize hover:bg-primary focus-visible:bg-primary focus-visible:outline-none"
    />
  );
};

const ColumnHeader = ({
  colIndex,
  board,
  column,
  canEdit,
  canReorder,
  mutations: m,
  onWidth,
  sortBy,
}: {
  /** Its place among the grid's columns (ARIA; 1 = the name). */
  colIndex: number;
  board: BoardDetail;
  column: Column;
  canEdit: boolean;
  canReorder: boolean;
  mutations: Mutations;
  onWidth: (columnId: string, width: number) => void;
  sortBy?: SortBy;
}) => {
  // A notification's link (`?column_settings=<key>`, r19relfilter: the column's view is gone) opens its settings.
  const navigate = useNavigate();
  const linkedSettings = useSearch({ strict: false }) as { column_settings?: string };
  const routeBoard = (useParams({ strict: false }) as { boardId?: string }).boardId;
  const openedByLink = canEdit && routeBoard === board.id && linkedSettings.column_settings === column.id;
  // The settings dialog: all of it, or just the description (fix6-table 4).
  const [settings, setSettings] = useState<false | 'all' | 'description'>(() => (openedByLink ? 'all' : false));
  const closeSettings = () => {
    setSettings(false);
    if (linkedSettings.column_settings)
      void navigate({
        to: '.',
        search: (prev: Record<string, unknown>) => ({ ...prev, column_settings: undefined }),
        replace: true,
      } as never);
  };
  // D28: "שינוי סוג עמודה" and its history (board owners and admins: `webhook.manage` is theirs).
  const [converting, setConverting] = useState<false | 'convert' | 'history'>(false);
  const ownerOrAdmin = !!board.capabilities['webhook.manage'] && !!board.capabilities['column.update'];
  const canConvert = ownerOrAdmin && column.type !== 'name' && conversionTargets(column.type).length > 0;
  const [renaming, setRenaming] = useState(false);
  // a status column's workflow (board owners and admins).
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const menu = useActionMenu();
  const { id: accountId } = useContext(BoardAccountContext);
  const hasSettings = hasColumnSettings(column.type);
  // Only the pointer listeners: dnd-kit's role/aria attributes would mark the header (and its inputs) disabled.
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: column.id,
    disabled: !canReorder || renaming,
  });

  // Plan feature gate: the AI column type needs `ai` — listed, disabled with the hint.
  const aiGate = usePlanGate(accountId, 'ai');
  const typeChoices = (side: 'before' | 'after'): MenuEntry[] =>
    columnTypes.creatable().map((def) =>
      gateMenuEntry(def.type === 'ai' ? aiGate : undefined, {
        label: columnTypeLabel(def.type),
        onSelect: () =>
          m.createColumn.mutate({
            title: columnTypeLabel(def.type),
            type: def.type,
            ...(side === 'before' ? { before_column_id: column.id } : { after_column_id: column.id }),
          }),
      }),
    );
  const menuItems = toMenuEntries(
    columnMenu({
      caps: board.capabilities,
      isName: column.type === 'name',
      hasSettings,
      canConvert,
      conversions: ownerOrAdmin && column.type !== 'name',
    }),
    {
      rename: () => setRenaming(true),
      convert: () => setConverting('convert'),
      conversions: () => setConverting('history'),
      settings: () => setSettings('all'),
      width_for_all: () => m.setColumnWidth.mutate({ columnId: column.id, width: column.width }),
      copy_id: () => copyText(column.id),
      delete: () =>
        void confirmDelete(column.title).then(
          (ok) => ok && m.deleteColumn.mutate({ id: column.id, name: column.title }),
        ),
    },
    { add_before: typeChoices('before'), add_after: typeChoices('after') },
  );
  // מ11: an AI column's "run on the empty cells / on all".
  const aiEntries = useAiColumnMenu(accountId, board, column);
  // fix6-table 4: "עריכת תיאור" right after rename (whoever may update the column).
  const described: MenuEntry[] = canEdit
    ? [
        ...menuItems.slice(0, 1),
        {
          label: t('column.editDescription'),
          onSelect: () => setSettings('description'),
          icon: <InfoIcon />,
          testId: 'column-edit-description',
        },
        ...menuItems.slice(1),
      ]
    : menuItems;
  const tagged = described.map((e) =>
    'label' in e && e.label === t('column.convert')
      ? { ...e, testId: 'column-convert' }
      : 'label' in e && e.label === t('column.conversions')
        ? { ...e, testId: 'column-conversions' }
        : 'label' in e && e.label === t('board.columnSettings')
          ? { ...e, testId: 'column-settings' }
          : e,
  ) as MenuEntry[];
  const withWorkflow: MenuEntry[] =
    column.type === 'status' && board.capabilities['board.update']
      ? [
          ...tagged,
          {
            label: t('workflow.menu'),
            onSelect: () => setWorkflowOpen(true),
            testId: 'column-workflow',
          },
        ]
      : tagged;
  const items: MenuEntry[] = aiEntries.length ? [...aiEntries, { kind: 'separator' }, ...withWorkflow] : withWorkflow;

  return (
    <div
      ref={setNodeRef}
      data-header={column.id}
      data-tour="board.column-header"
      role="columnheader"
      aria-colindex={colIndex}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
      className={cn(
        'group relative flex h-full items-center justify-center bg-surface px-2',
        COL_SEP,
        canReorder && !renaming && 'cursor-grab active:cursor-grabbing',
        isDragging && 'z-20 opacity-80 shadow-[var(--shadow-pop)]',
      )}
      {...listeners}
    >
      <EditableText
        value={column.title}
        editable={canEdit}
        editing={renaming}
        onEditingChange={setRenaming}
        onSave={(title) => m.updateColumn.mutate({ columnId: column.id, title })}
      />
      {!renaming ? <ColumnInfo column={column} /> : null}
      {settings ? (
        <ColumnSettings
          accountId={accountId}
          board={board}
          column={column}
          only={settings === 'description' ? 'description' : undefined}
          onClose={closeSettings}
          onSave={(patch) => m.updateColumn.mutateAsync({ columnId: column.id, ...patch })}
        />
      ) : null}
      {workflowOpen ? (
        <WorkflowDialog accountId={accountId} board={board} column={column} onClose={() => setWorkflowOpen(false)} />
      ) : null}
      {converting === 'convert' ? (
        <ConvertColumnDialog accountId={accountId} board={board} column={column} onClose={() => setConverting(false)} />
      ) : null}
      {converting === 'history' ? (
        <ConversionHistoryDialog
          accountId={accountId}
          board={board}
          column={column}
          onClose={() => setConverting(false)}
        />
      ) : null}
      {column.converting ? <ConvertingBadge accountId={accountId} boardId={board.id} id={column.converting} /> : null}
      {sortBy && !renaming ? <SortButton column={column} sortBy={sortBy} className="start-1" /> : null}
      <MenuTrigger
        label={t('column.actions', { name: column.title })}
        onClick={menu.fromTrigger}
        className="absolute end-2"
      />
      <Menu at={menu.at} onClose={menu.close} items={items} label={t('column.actions', { name: column.title })} />
      <ResizeHandle columnId={column.id} title={column.title} width={column.width} onWidth={onWidth} />
    </div>
  );
};

type SortBy = { levels: SortLevel[]; set: (sort: SortLevel[]) => void };

/** D28: a background conversion runs on the column — "ממירים… 40%" on its header (edits wait until it ends). */
const ConvertingBadge = ({ accountId, boardId, id }: { accountId: string; boardId: string; id: string }) => {
  const c = useConversion(accountId, boardId, id).data;
  const pct = c && c.total ? Math.round((c.done / c.total) * 100) : 0;
  return (
    <span
      data-testid="column-converting"
      data-pct={pct}
      className="absolute inset-x-1 bottom-0.5 truncate rounded bg-info-soft px-1 text-center text-[0.6875rem] text-info-fg"
    >
      {t('convert.headerRunning', { pct })}
    </span>
  );
};

/** A small (i) — the icon of a column's description. */
const InfoIcon = ({ size = 16 }: { size?: number }) => <Icon name="info" size={size} />;

/**
 * fix6-table 4: beside a header's title when the column has a description — the description is its tooltip
 * (`title`, shown by the system tooltip). Not a column drag.
 */
const ColumnInfo = ({ column }: { column: Column }) =>
  column.description ? (
    <span
      data-testid="column-info"
      title={column.description}
      onPointerDown={(e) => e.stopPropagation()}
      className="ms-1 flex shrink-0 cursor-help items-center text-muted hover:text-heading"
    >
      <InfoIcon size={13} />
    </span>
  ) : null;

/**
 * Owner fix 1: sort from the column's header. A small button laid over the header's edge (the title never moves)
 * shows on hover, and stays with its arrow while the column sorts. A click cycles ascending -> descending -> off;
 * a column not yet sorted becomes the first level (the others stay). It writes the view's sort as a draft, like
 * the sort panel.
 */
const SortButton = ({ column, sortBy, className }: { column: Column; sortBy: SortBy; className?: string }) => {
  if ((columnTypes.get(column.type)?.sortKey ?? 'none') === 'none') return null;
  const { levels, set } = sortBy;
  const at = levels.findIndex((l) => l.column_id === column.id);
  const dir = at >= 0 ? levels[at]!.direction : null;
  const next = () => {
    if (!dir) {
      const first: SortLevel = { column_id: column.id, direction: 'asc', nulls: 'last' };
      set([first, ...levels].slice(0, MAX_SORT_LEVELS));
    } else if (dir === 'asc') set(levels.map((l, i) => (i === at ? { ...l, direction: 'desc' as const } : l)));
    else set(levels.filter((_, i) => i !== at));
  };
  const label = t(
    (dir === 'asc' ? 'column.sortDesc' : dir === 'desc' ? 'column.sortOff' : 'column.sortAsc') as MessageKey,
    { name: column.title },
  );
  return (
    <button
      type="button"
      data-testid="column-sort"
      data-sort={dir ?? 'none'}
      aria-label={label}
      title={label}
      // Not a column drag, not the header's rename.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        next();
      }}
      className={cn(
        'absolute inset-y-0 z-[2] my-auto grid size-5 place-items-center rounded-[6px] hover:bg-surface-2 hover:text-heading focus-visible:opacity-100',
        dir ? 'text-heading' : 'text-muted opacity-0 group-hover:opacity-100',
        className,
      )}
    >
      <svg
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        {dir === 'asc' ? (
          <path d="M12 19V5M6 11l6-6 6 6" />
        ) : dir === 'desc' ? (
          <path d="M12 5v14M6 13l6 6 6-6" />
        ) : (
          <path d="M8 20V4M4 8l4-4 4 4M16 4v16M12 16l4 4 4-4" />
        )}
      </svg>
    </button>
  );
};

/** The add-column menu (F4 Board-AddColumn): a search over the types, then a tile per type in two columns. */
const AddColumn = ({ mutations: m }: { mutations: Mutations }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Plan feature gate: the AI tile stays, disabled with the upgrade hint, without `ai`.
  const aiGate = usePlanGate(useContext(BoardAccountContext).id, 'ai');
  const gated = (type: string) => type === 'ai' && !aiGate.allowed;
  const needle = query.trim().toLowerCase();
  const types = columnTypes
    .creatable()
    .filter((def) => !needle || columnTypeLabel(def.type).toLowerCase().includes(needle) || def.type.includes(needle));
  const close = () => {
    setOpen(false);
    setQuery('');
  };
  const pick = (def: (typeof types)[number]) => {
    if (gated(def.type)) return;
    close();
    m.createColumn.mutate({ title: columnTypeLabel(def.type), type: def.type });
  };
  return (
    // A cell of the header row (a row holds cells only — axe aria-required-children).
    <div role="gridcell" className="relative flex h-full items-center justify-center">
      {/* The "+" itself anchors the menu, which lines up with its inline-end edge and grows into the table. */}
      <span className="relative inline-grid">
        <button
          type="button"
          aria-label={t('board.addColumn')}
          title={t('board.addColumn')}
          data-tour="board.add-column"
          onClick={() => setOpen(true)}
          className="grid size-[1.625rem] place-items-center rounded-[8px] text-fg-2 hover:bg-surface-2 hover:text-heading"
        >
          <Icon name="plus" size={14} strokeWidth={2} />
        </button>
        <Popover
          open={open}
          onClose={close}
          align="end"
          className="w-[320px] max-w-[calc(100vw-16px)] rounded-[14px] p-2.5"
        >
          <label className="flex h-[2.125rem] items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-2.5 text-muted focus-within:border-heading focus-within:shadow-[0_0_0_3px_var(--accent-soft)]">
            <Icon name="search" size={14} strokeWidth={2} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter adds the first match.
                if (e.key !== 'Enter') return;
                e.preventDefault();
                if (types[0]) pick(types[0]);
              }}
              placeholder={t('board.searchColumnType')}
              aria-label={t('board.searchColumnType')}
              data-testid="add-column-search"
              className="w-full min-w-0 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
            />
            <ClearSearchButton value={query} onClear={() => setQuery('')} testId="add-column-search-clear" />
          </label>
          <div className="px-2.5 pt-2.5 pb-1 text-[0.6875rem] font-semibold text-muted">{t('board.addColumn')}</div>
          {types.length ? null : <p className="px-2.5 py-2 text-sm text-muted">{t('board.noResults')}</p>}
          <div className="grid grid-cols-2 gap-0.5">
            {types.map((def, i) => (
              <button
                key={def.type}
                type="button"
                data-testid="add-column-type"
                data-type={def.type}
                {...(gated(def.type) ? planGateAttrs(aiGate) : {})}
                className={cn(
                  gated(def.type) && 'cursor-not-allowed opacity-45',
                  'flex h-[2.125rem] min-w-0 items-center gap-2.5 rounded-[9px] px-2.5 text-start text-[0.8125rem] text-fg hover:bg-surface-2',
                  // What Enter would add.
                  needle && i === 0 && 'bg-surface-2',
                )}
                onClick={() => pick(def)}
              >
                <span
                  aria-hidden
                  className="grid size-6 shrink-0 place-items-center rounded-[7px] bg-surface-2 text-heading"
                >
                  <TypeGlyph type={def.type} size={14} />
                </span>
                <span className="truncate">{columnTypeLabel(def.type)}</span>
              </button>
            ))}
          </div>
        </Popover>
      </span>
    </div>
  );
};

/** The table is in manual order (no sort, no grouping by a column): items may be dragged. */
const ManualOrderContext = createContext(false);

/** A subitem's descendants (as loaded) and how many levels deep they go below it. */
const branchOf = (childrenOf: Map<string, Item[]> | undefined, id: string) => {
  const branch = new Set<string>();
  let height = 0;
  const walk = (parentId: string, level: number) => {
    for (const child of childrenOf?.get(parentId) ?? []) {
      branch.add(child.id);
      height = Math.max(height, level);
      walk(child.id, level + 1);
    }
  };
  walk(id, 1);
  return { branch, height };
};

/** Neighbours of a top-level row in manual order: where a dropped item lands (before / after this row). */
type RowDrag = { groupId: string; prevId: string | null; nextId: string | null };

/** The drop line of a zone (F4: a 2px primary line on the edge it lands on). */
const DROP_LINE: Record<Where, string> = {
  before: 'shadow-[inset_0_2px_0_var(--primary)]',
  after: 'shadow-[inset_0_-2px_0_var(--primary)]',
  // fix6-table 5: into this row — it becomes the dragged subitem's parent.
  inside: 'bg-primary-soft shadow-[inset_0_0_0_2px_var(--primary)]',
  end: 'shadow-[inset_0_2px_0_var(--primary)]',
};

/** "+ add item" / "no items" of a group: dropping an item there moves it to the end of that group. */
const GroupEndDrop = ({
  section,
  mutations: m,
  children,
}: {
  section: Section;
  mutations: Mutations;
  children: ReactNode;
}) => {
  const manual = useContext(ManualOrderContext);
  const bucket = useContext(BucketDragContext);
  const { id: accountId } = useContext(BoardAccountContext);
  const groupId = manual ? section.group?.id : undefined;
  const key = `end:${groupId ?? section.key}`;
  useDropTarget(
    key,
    bucket
      ? {
          zone: (d) => (bucketDropOf(bucket, d, section, null) ? 'end' : null),
          drop: (d) => bucketDropOf(bucket, d, section, null)?.(),
        }
      : groupId
        ? {
            zone: (d) => (d.isSub ? null : 'end'),
            drop: (d) => {
              const last = section.items.filter((i) => i.id !== d.id).at(-1)?.id ?? null;
              if (last && section.items.at(-1)?.id === d.id) return; // already last
              m.placeItem.mutate(
                { itemId: d.id, groupId, afterId: last, beforeId: null },
                { onSuccess: (res) => rememberEdit(accountId, (res as Item & { event_id?: string | null }).event_id) },
              );
            },
          }
        : null,
  );
  const over = useDropZone(key);
  if (!groupId && !bucket) return <>{children}</>;
  return (
    <div data-testid="group-end-drop" data-drop-key={key} className={cn('h-full', over && DROP_LINE.end)}>
      {children}
    </div>
  );
};

/** The active cell of the keyboard grid. */
const ACTIVE_RING = 'ring-2 ring-inset ring-primary';
const ACTIVE_CELL = `relative z-[1] ${ACTIVE_RING}`;
/** Cells of a selected range (Shift+arrows). */
const RANGE_CELL = 'bg-primary-soft';

const ItemRow = ({
  board,
  item,
  columns,
  template,
  members,
  mutations: m,
  drag,
  bucket,
  alt = false,
}: {
  board: BoardDetail;
  item: Item;
  columns: Column[];
  template: string;
  members: Member[];
  mutations: Mutations;
  /** Top-level rows in manual order: draggable within and between groups. */
  drag?: RowDrag;
  /** Fix: — top-level rows of a view grouped by a column: their section (a drop elsewhere sets its value). */
  bucket?: Section;
  /** Every second row of a group gets the zebra tint (F4 .br:nth-child(even)). */
  alt?: boolean;
}) => {
  const canEdit = board.capabilities['item.update'];
  const { id: accountId, slug: accountSlug } = useContext(BoardAccountContext);
  const [renaming, setRenaming] = useState(false);
  // a computed name opens its columns in the row.
  const [nameEditor, setNameEditor] = useState(false);
  const sub = useContext(SubitemsContext);
  const children = sub?.childrenOf.get(item.id) ?? [];
  const open = !!sub?.expanded.has(item.id);
  const canNest = !!sub && item.depth + 1 <= board.hierarchy_depth_max && board.capabilities['item.create'];
  // Fix: b: grouped by a column, "move to group" lists the view's sections (sets the value, like a drag).
  const bx = useContext(BucketDragContext);
  const { menu, entries, label, dialogs, tree } = useItemMenu(
    board,
    item,
    m,
    () => setRenaming(true),
    sub ? () => sub.requestAdd(item.id) : undefined,
    bucketMoveEntries(bx, item, bucket?.key),
    bx ? bucket?.seed?.cells : undefined,
  );
  // Items and subitems each have their own selection (SubRow provides the sub-board's).
  const selection = useContext(SelectionContext);
  const selected = !!selection?.has(item.id);
  // Round 12: with 2+ rows checked, a cell edit in one of them sets that column on all of them — one
  // batch, one undo (`bulk-cells.ts`); hovering lights the column across the checked rows.
  const bulkIds = bulkTargets(selection, item.id);
  const [bulkCol, setBulkCol] = useState<string | null>(null);
  const undoToast = useUndoToast(accountId);
  useEffect(() => {
    if (!bulkCol) return;
    return () => setBulkHover(null);
  }, [bulkCol]);
  /**
   * `whole`: the value replaces every checked row's (a paste / clear); otherwise a relation picker's toggle
   * becomes "link / unlink this item" on every checked row, each keeping its other links.
   */
  const writeCell = (c: Column, value: unknown, workflowOverride?: boolean, whole = false) => {
    const links = bulkLinks(c);
    if (whole && !bulkIds && JSON.stringify(item.cells[c.id]?.value ?? null) === JSON.stringify(value ?? null)) return;
    if (!bulkIds || !(bulkSettable(c) || links)) {
      m.setCell.mutate({ itemId: item.id, columnId: c.id, value, ...(workflowOverride ? { workflowOverride } : {}) });
      return;
    }
    const delta = links && !whole ? linkDelta(item.cells[c.id]?.value, value) : null;
    for (const id of bulkIds)
      m.patchItem(id, (i) =>
        withCell(i, c.id, delta ? withLinkDelta(i.cells[c.id]?.value, delta, c.settings.allow_multiple) : value),
      );
    // The edit is done: drop the "applies to N items" hint — its mouseleave never comes when the cell's editor
    // replaced the element under the pointer.
    bulkHover(null);
    m.bulk.mutate(
      {
        item_ids: bulkIds,
        action: delta
          ? { type: 'change_links', column_id: c.id, add: delta.add, remove: delta.remove }
          : { type: 'set_cell', column_id: c.id, value, ...(workflowOverride ? { workflow_override: true } : {}) },
      },
      {
        onSuccess: (res) => {
          const skipped = res.skipped ? ` · ${t('batch.skipped', { n: res.skipped })}` : '';
          undoToast(`${t('r12.bulk.done', { n: res.done, column: c.title })}${skipped}`, res.event_id);
        },
        onError: (err) => showToast({ message: errorMessage(err), tone: 'error' }),
      },
    );
  };
  // Clearing never reads `bulkCol`: a mouseenter's hint may not be rendered yet when the pointer leaves (e.g. the
  // browser's own mouseenter after an inline editor closed under a still pointer, then a quick move away) — a
  // check of the rendered state (or a leave handler bound only once it is) would leave the hint stuck in the cell.
  const bulkHover = (c: Column | null) => {
    if (c && bulkIds && (bulkSettable(c) || bulkLinks(c)) && canEdit) {
      setBulkHover(board.id, c.id);
      setBulkCol(c.id);
    } else {
      setBulkHover(null);
      setBulkCol(null);
    }
  };
  // The grid's paste / clear (registered once per row change) calls the latest `writeCell`.
  const writeRef = useRef(writeCell);
  useEffect(() => {
    writeRef.current = writeCell;
  });
  // Conditional coloring (the main board's rules; subitems have their own columns).
  const colorOf = useContext(ColoringContext);
  const colors = useMemo(() => (colorOf && !item.parent_item_id ? colorOf(item) : null), [colorOf, item]);
  const conversionMarks = useContext(ConversionMarksContext);
  const tint = (color: string, pct: number) => `color-mix(in srgb, ${paint(color)} ${pct}%, var(--surface))`;

  // Keyboard grid: this row's cells, while it is rendered.
  const grid = useGrid();
  const rowRef = useRef<HTMLDivElement>(null);
  // r16motion: a row the user just added gets a soft highlight that fades (never on a plain mount / scroll).
  const fresh = useFreshRow(item.id);
  const activeCol = grid?.active?.itemId === item.id ? grid.active.col : null;
  const register = grid?.register;
  useEffect(
    () =>
      register?.(item.id, {
        boardId: board.id,
        columns,
        cellEl: (col) => cellIn(rowRef.current, col),
        value: (col) => (col < 0 ? item.name : (item.cells[columns[col]!.id]?.value ?? null)),
        text: (col) => (col < 0 ? item.name : (item.cells[columns[col]!.id]?.text ?? '')),
        editable: (col) => {
          if (!canEdit) return false;
          const c = columns[col];
          // a computed name is the server's — no typing, paste or clear into it.
          if (col < 0) return !item.name_computed;
          return !!c && !c.read_only && !c.restricted_edit;
        },
        // a paste / clear on ONE cell of a checked row fills the column on every checked row.
        write: (col, value, gesture, spread) =>
          col < 0
            ? m.renameItem.mutate({ itemId: item.id, name: String(value), gesture })
            : spread
              ? writeRef.current(columns[col]!, value, undefined, true)
              : m.setCell.mutate({ itemId: item.id, columnId: columns[col]!.id, value, gesture }),
        rename: () => (item.name_computed ? showNameComputedToast() : canEdit && setRenaming(true)),
      }),
    [register, board.id, item, columns, canEdit, m.setCell, m.renameItem],
  );
  // Rows drag with dnd-kit (Fix: , row-dnd.tsx): by the ⋮⋮ handle, or by a long press on the name cell.
  // Items move within and between groups; subitems (any level) among their siblings and, fix6-table 5, to
  // another parent — before / after a subitem of another parent, or into an item / subitem (the middle of its
  // row; into a sibling after resting there) — as long as the board's depth limit holds and never into itself.
  const isSub = !!item.parent_item_id;
  const mayMove = !!board.capabilities['item.move_group'];
  const inBucket = !isSub && bucket && bx ? bucket : undefined;
  const canDrag = isSub
    ? mayMove && !sub?.sorted
    : (mayMove && !!drag) || (!!inBucket && (!!bx?.canEdit || !!bx?.canMove));
  // Grouped by a multi-value column, one item can show in several sections: each copy is its own drag / drop.
  const dropKey = inBucket ? `${inBucket.key}|${item.id}` : item.id;
  const dragId = `row:${dropKey}`;
  const {
    setNodeRef: setDragNode,
    listeners: dragListeners,
    isDragging,
    node: dragNode,
  } = useDraggable({
    id: dragId,
    disabled: !canDrag || renaming,
    data: {
      get: (): Dragged => ({
        id: item.id,
        name: item.name,
        isSub,
        parentId: item.parent_item_id ?? null,
        ...branchOf(sub?.childrenOf, item.id),
        canReparent: !!board.capabilities['item.update'],
        width: dragNode.current?.offsetWidth ?? NAME_WIDTH,
        ...(inBucket ? { bucket: inBucket.key, item } : {}),
      }),
    },
  });
  const pressing = usePressing(dragId);
  const subMutations = sub?.mutations ?? m;
  /** A move without a toast: Ctrl+Z undoes it for a minute, like an edit. */
  const remember = (res: Item) => rememberEdit(accountId, (res as Item & { event_id?: string | null }).event_id);
  const zone = (d: Dragged, y: number, dwell: boolean): Where | null => {
    if (d.id === item.id || d.branch.has(item.id)) return null;
    const half = y < 0.5 ? 'before' : 'after';
    if (!d.isSub && inBucket && bx) {
      return bucketDropOf(bx, d, inBucket, { id: item.id, before: half === 'before' }) ? half : null;
    }
    if (!d.isSub) return !isSub && drag ? half : null;
    const max = board.hierarchy_depth_max;
    const canInside = d.canReparent && item.id !== d.parentId && item.depth + 1 + d.height <= max;
    if (!isSub) return canInside ? 'inside' : null;
    if (item.parent_item_id === d.parentId) {
      // Among its own siblings the edges reorder (owner fix, round 7); resting on the middle nests it.
      if (canInside && dwell) return 'inside';
      return sub?.sorted ? null : half;
    }
    const canSide = d.canReparent && item.depth + d.height <= max;
    if (canInside && (!canSide || (y > 0.3 && y < 0.7))) return 'inside';
    return canSide ? half : null;
  };
  const dropHere = (d: Dragged, where: Where) => {
    if (d.isSub) {
      if (where === 'inside') {
        subMutations.reparentSubitem.mutate({ itemId: d.id, name: d.name, parentId: item.id });
        sub?.setExpanded(item.id, true); // show where it went
        return;
      }
      const position = where === 'before' ? { before_id: item.id } : { after_id: item.id };
      if (item.parent_item_id !== d.parentId) {
        subMutations.reparentSubitem.mutate({ itemId: d.id, name: d.name, parentId: item.parent_item_id!, position });
        return;
      }
      // Already there (dropped right beside itself): nothing to save, nothing to undo.
      const siblings = sub?.childrenOf.get(item.parent_item_id!) ?? [];
      const at = siblings.findIndex((s) => s.id === item.id);
      const neighbour = siblings[where === 'before' ? at - 1 : at + 1];
      if (neighbour?.id === d.id) return;
      subMutations.reorderSubitem.mutate({ itemId: d.id, position }, { onSuccess: remember });
      return;
    }
    if (inBucket && bx) {
      bucketDropOf(bx, d, inBucket, { id: item.id, before: where === 'before' })?.();
      return;
    }
    if (!drag) return;
    const before = where === 'before';
    if ((before ? drag.prevId : drag.nextId) === d.id) return;
    const other = (x: string | null) => (x === d.id ? null : x);
    m.placeItem.mutate(
      {
        itemId: d.id,
        groupId: drag.groupId,
        afterId: before ? other(drag.prevId) : item.id,
        beforeId: before ? item.id : other(drag.nextId),
      },
      { onSuccess: remember },
    );
  };
  useDropTarget(dropKey, { zone, drop: dropHere });
  const drop = useDropZone(dropKey);

  const cellProps = (col: number) => ({
    'data-cell': col,
    role: 'gridcell',
    'aria-colindex': col + 2,
    tabIndex: -1,
    onMouseDownCapture: (e: React.MouseEvent) => {
      // Checking the row (its check box) selects the item, not the cell: no active-cell outline.
      if ((e.target as HTMLElement).closest('[data-testid="row-select"]')) return;
      // A right click inside a selected range keeps the range (the menu acts on all of it).
      if (e.button !== 2 || !grid?.inRange(item.id, col)) grid?.setActive({ itemId: item.id, col });
    },
  });

  // Cell menu (14 §3): right click or Shift+F10 on a value cell.
  const cellMenu = useActionMenu();
  const [menuCol, setMenuCol] = useState(0);
  const navigate = useNavigate();
  const openItem = () =>
    void navigate({
      to: '/a/$accountSlug/b/$boardId/i/$itemId',
      params: { accountSlug, boardId: board.parent_board_id ?? board.id, itemId: item.id },
      search: (prev: Record<string, unknown>) => prev,
    } as never);
  const mc = columns[menuCol];
  const mcValue = mc ? (item.cells[mc.id]?.value ?? null) : null;
  const href = mc ? linkHref(mc.type, mcValue) : undefined;
  const cellEntries =
    cellMenu.at && mc
      ? toMenuEntries(
          buildCellMenu({
            editable: canEdit && !mc.read_only && !mc.restricted_edit,
            hasValue: mcValue != null,
            link: !!href,
            // "move to item ▸" from any of the row's cells too (the row menu's entry and hook)
            // not on a row of a checked selection: the batch bar and its menu move the selection.
            ...(selected && (selection?.ids.length ?? 0) > 1 ? {} : { tree: tree.rights }),
          }),
          {
            edit: () => grid?.edit(),
            open_link: () => href && window.open(href, '_blank', 'noopener'),
            copy: () => grid?.copy(false),
            cut: () => grid?.copy(true),
            paste: () => grid?.paste(),
            clear: () => grid?.clear(),
            open_item: openItem,
            ...tree.treeHandlers,
          },
        )
      : [];
  const valueCellMenu = (col: number) => ({
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
      setMenuCol(col);
      cellMenu.onContextMenu(e);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      setMenuCol(col);
      cellMenu.onKeyDown(e);
    },
  });

  return (
    <div
      ref={rowRef}
      className={cn(
        'group grid border-b border-line hover:bg-surface-3',
        alt ? 'bg-row-alt' : 'bg-surface',
        selected && 'bg-info-soft',
        drop && DROP_LINE[drop],
        fresh && 'row-fresh',
      )}
      data-drop-key={dropKey}
      data-drop={drop ?? undefined}
      data-color={colors?.row}
      style={{
        gridTemplateColumns: template,
        height: 'var(--row-h)',
        ...(colors?.row && !selected ? { backgroundColor: tint(colors.row, 22) } : {}),
      }}
      data-testid="item-row"
      role="presentation"
      data-item-name={item.name}
      data-item-id={item.id}
      data-selected={selected || undefined}
      data-bulk-board={board.id}
    >
      <div
        {...cellProps(-1)}
        className={cn(
          'sticky start-0 z-10 flex items-center gap-2 px-3 outline-none',
          COL_SEP,
          selected ? 'bg-info-soft' : cn(alt ? 'bg-row-alt' : 'bg-surface', 'group-hover:bg-surface-3'),
          // The name cell stays sticky (and above the scrolling cells) while active: the ring only, no `relative`.
          activeCol === -1 && ACTIVE_RING,
          grid?.inRange(item.id, -1) && RANGE_CELL,
          // A long press charging: the outline fills in while the button is held (then the row lifts).
          canDrag && 'transition-shadow duration-[350ms] ease-linear',
          pressing && 'cursor-grab select-none shadow-[inset_0_0_0_2px_var(--primary)]',
          // Lifted (a copy follows the pointer): the row stays as a dimmed placeholder.
          isDragging && 'cursor-grabbing select-none opacity-50 ring-2 ring-inset ring-primary',
        )}
        style={colors?.row && !selected ? { backgroundColor: tint(colors.row, 22) } : undefined}
        data-name-of={board.id}
        data-pressing={pressing || undefined}
        data-armed={isDragging || undefined}
        ref={setDragNode}
        {...(canDrag && !renaming ? dragListeners : {})}
        // Several rows selected and this one among them: the batch actions instead of the item's (14 §2).
        onContextMenu={(e) => (selected && (selection?.ids.length ?? 0) > 1 ? openBatchMenu(e) : menu.onContextMenu(e))}
        onKeyDown={menu.onKeyDown}
      >
        {canDrag ? (
          <span
            data-drag-handle
            data-testid={isSub ? 'subitem-drag' : 'item-drag'}
            aria-hidden
            title={isSub ? t('subitems.drag') : t('items.drag')}
            className="cursor-grab touch-none select-none text-xs text-muted opacity-0 group-hover:opacity-100"
          >
            ⠿
          </span>
        ) : null}
        {selection ? (
          <input
            type="checkbox"
            data-testid="row-select"
            aria-label={t('select.item', { name: item.name })}
            checked={selected}
            onChange={() => undefined}
            onClick={(e) => selection.toggle(item.id, e.shiftKey)}
            className="size-[0.9375rem] shrink-0 cursor-pointer accent-[var(--check)]"
          />
        ) : null}
        {sub && (children.length || canNest) ? (
          <button
            type="button"
            data-testid="subitems-toggle"
            aria-expanded={open}
            aria-label={t('subitems.toggle', { name: item.name })}
            title={children.length ? t('subitems.count', { n: children.length }) : t('menu.item.addSubitem')}
            onClick={() => sub.setExpanded(item.id, !open)}
            className={cn(
              'flex h-5 shrink-0 items-center gap-0.5 rounded px-1 text-xs text-muted hover:bg-surface-2 hover:text-fg',
              !children.length && !open && 'opacity-0 group-hover:opacity-100 focus:opacity-100',
            )}
          >
            {/* Owner fix (fix5-board 2): the count, then the chevron after it in reading order (left of
                the number in Hebrew); closed it points along the reading direction, open it points down. An SVG —
                the "›" glyph was mirrored by the bidi algorithm in RTL and pointed up when open. */}
            {children.length ? <span data-testid="subitems-count">{children.length}</span> : null}
            <svg
              aria-hidden
              data-testid="subitems-chevron"
              data-open={open || undefined}
              viewBox="0 0 24 24"
              width={12}
              height={12}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.4}
              strokeLinecap="round"
              strokeLinejoin="round"
              className={cn('shrink-0 transition-transform', open ? 'rotate-90' : 'rtl:rotate-180')}
            >
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        ) : null}
        {item.name_computed ? (
          // the name comes from columns — the secondary ink, the ƒ mark (its columns); no inline rename.
          // a click opens those columns right here in the row (the card is one click further).
          <>
            <ComputedNameMark
              board={board}
              edit={{ item, members, accountId, canEdit, onWrite: (c, value) => writeCell(c, value) }}
            />
            <ComputedNameEditor
              open={nameEditor}
              onClose={() => setNameEditor(false)}
              item={item}
              board={board}
              members={members}
              accountId={accountId}
              canEdit={canEdit}
              onWrite={(c, value) => writeCell(c, value)}
              onOpenItem={openItem}
            >
              <span
                data-testid="computed-name"
                className="min-w-0 cursor-pointer truncate text-sm font-normal text-fg-2"
                onClick={(e) => {
                  e.stopPropagation();
                  setNameEditor(true);
                }}
              >
                {item.name}
              </span>
            </ComputedNameEditor>
          </>
        ) : (
          <EditableText
            value={item.name}
            editable={canEdit}
            editing={renaming}
            onEditingChange={setRenaming}
            onSave={(name) => m.renameItem.mutate({ itemId: item.id, name })}
            // Owner fix 3: the name in the regular weight — long lists read easier than in semibold.
            className={cn('text-sm font-normal', renaming ? 'flex-1' : 'min-w-0')}
          />
        )}
        {/* N4: the item's update count right after its name (F4 .upd); a click opens the Updates tab. */}
        {renaming ? null : (
          <>
            <UpdateCountPill boardId={board.id} cardBoardId={board.parent_board_id ?? board.id} itemId={item.id} />
            {/* Owner fix 3: a click on the cell's empty part opens the item; a click on the name renames it. */}
            <span
              aria-hidden
              data-testid="item-open-area"
              className="flex-1 cursor-pointer self-stretch"
              onClick={openItem}
            />
          </>
        )}
        <Link
          to="/a/$accountSlug/b/$boardId/i/$itemId"
          params={{ accountSlug, boardId: board.parent_board_id ?? board.id, itemId: item.id }}
          search={(prev) => prev}
          className="hidden shrink-0 rounded-[7px] border border-line-strong px-1.5 text-xs text-fg-2 hover:border-primary hover:text-primary group-hover:inline"
        >
          {t('item.open')}
        </Link>
        <MenuTrigger label={label} onClick={menu.fromTrigger} />
        <Menu at={menu.at} onClose={menu.close} items={entries} label={label} />
        {dialogs}
      </div>
      {columns.map((c, i) => {
        const Cell = cellFor(c);
        const cell = item.cells[c.id];
        // D28: the cell failed in a type conversion (empty now; its original value is in the backup).
        const failed = cell ? undefined : conversionMarks?.get(c.id)?.get(item.id);
        return (
          <div
            key={c.id}
            {...cellProps(i)}
            {...valueCellMenu(i)}
            onMouseEnter={bulkIds ? () => bulkHover(c) : undefined}
            onMouseLeave={bulkIds ? () => bulkHover(null) : undefined}
            className={cn(
              // Owner fix 1: whatever a click opens shows the hand (cells set it on their own triggers too).
              'relative outline-none [&_button:enabled]:cursor-pointer',
              COL_SEP,
              grid?.inRange(item.id, i) && RANGE_CELL,
              activeCol === i && ACTIVE_CELL,
            )}
            data-column={c.id}
            data-column-type={c.type}
            data-color={colors?.cells[c.id]}
            style={colors?.cells[c.id] ? { backgroundColor: tint(colors.cells[c.id]!, 45) } : undefined}
          >
            {!hasCellComponent(c) ? (
              // Read-only text (creation log, last updated…) often holds an LTR name / email: `dir="auto"` keeps
              // the ellipsis at the end of the text instead of cutting its start.
              <div
                className="relative flex h-full w-full items-center px-2 text-sm text-muted"
                title={t('board.readOnly')}
              >
                <span className="truncate" dir={c.type === 'item_id' ? 'ltr' : 'auto'}>
                  {cell?.text ?? null}
                </span>
              </div>
            ) : (
              <Cell
                column={c}
                value={cell?.value ?? null}
                text={cell?.text ?? null}
                names={cell?.names}
                editable={canEdit && !c.read_only && !c.restricted_edit}
                members={members}
                accountId={accountId}
                itemId={item.id}
                boardId={board.id}
                rowCells={item.cells}
                onChange={(value, opts) => writeCell(c, value, opts?.workflowOverride)}
                canEditSettings={!!board.capabilities['column.update']}
                canManageBoard={!!board.capabilities['board.update']}
                onSettingsChange={(settings) => m.updateColumn.mutateAsync({ columnId: c.id, settings })}
              />
            )}
            {bulkIds && bulkCol === c.id ? (
              <span
                data-testid="bulk-hint"
                className="pointer-events-none absolute end-0.5 top-0.5 z-[3] rounded-full bg-primary px-1.5 text-[0.6875rem] leading-4 font-semibold whitespace-nowrap text-on-primary shadow-sm"
              >
                {bulkHint(bulkIds.length)}
              </span>
            ) : null}
            {failed !== undefined ? <FailedMark text={failed} /> : null}
          </div>
        );
      })}
      <div />
      <Menu
        at={cellMenu.at}
        onClose={cellMenu.close}
        items={cellEntries}
        label={t('menu.cell.label', { column: mc?.title ?? '' })}
      />
    </div>
  );
};

/** Where a link-like cell points (link, email, phone) — the cell menu's "open". */
const linkHref = (type: string, value: unknown): string | undefined => {
  const v = value as { url?: string; email?: string; phone?: string } | null;
  if (!v) return undefined;
  if (type === 'link') return v.url;
  if (type === 'email' && v.email) return `mailto:${v.email}`;
  if (type === 'phone' && v.phone) return `tel:${v.phone.replace(/[^\d+*#]/g, '')}`;
  return undefined;
};

const AddItemRow = ({
  board,
  groupId,
  cells,
  mutations: m,
}: {
  board: BoardDetail;
  groupId: string;
  /** Grouped by a column: the value that keeps the new item in this section. */
  cells?: Record<string, unknown>;
  mutations: Mutations;
}) => {
  const [name, setName] = useState('');
  const openItem = useOpenItem(board.parent_board_id ?? board.id);
  // Clear at once so the next name can be typed right away; a failed create puts its name back if the field is
  // still empty (clearing on success used to wipe whatever was typed meanwhile).
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (!value) return;
    setName('');
    m.createItem.mutate(
      { name: value, groupId, ...(cells ? { cells } : {}) },
      { onError: () => setName((cur) => cur || value) },
    );
  };
  const term = board.item_terminology === 'item' ? t('board.itemDefault') : board.item_terminology;
  const grid = useGrid();
  const named = computedNameInfo(board);
  // the board computes names — nothing to type. Prod (product owner: "it opens the side panel — I want it
  // in its row"): the new row shows with its name's first source column active, so typing fills it; the board's
  // name source can still open the card instead (`open_on_create`).
  const created = (it: Item) => {
    if (named.source.open_on_create) {
      openItem(it.id);
      return;
    }
    const first = named.columns[0]?.id;
    revealNewItem(
      it.id,
      'item',
      first && grid
        ? {
            columnKey: first,
            setActive: (col) => {
              grid.setActive({ itemId: it.id, col });
              // Its editor opens once the active cell is committed: typing goes straight in.
              setTimeout(() => grid.edit(), 0);
            },
          }
        : undefined,
    );
  };
  if (named.computed)
    return (
      <div className="sticky start-0 flex h-full items-center px-3" style={{ maxWidth: 'var(--name-w)' }}>
        <button
          type="button"
          data-testid="add-computed-item"
          disabled={m.createItem.isPending}
          onClick={() => m.createItem.mutate({ groupId, ...(cells ? { cells } : {}) }, { onSuccess: created })}
          className="truncate text-sm text-muted hover:text-primary disabled:opacity-50"
        >
          + {t('name.newItem')}
        </button>
      </div>
    );
  return (
    <form
      onSubmit={onSubmit}
      // A visible focus (WCAG 2.4.7): the field's box is outlined while it is focused.
      className="sticky start-0 flex h-full items-center px-3 focus-within:shadow-[inset_0_0_0_2px_var(--focus-ring)]"
      style={{ maxWidth: 'var(--name-w)' }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('board.addItem', { item: term })}
        aria-label={t('board.addItem', { item: term })}
        data-add-item
        className="w-full bg-transparent text-sm outline-none placeholder:text-muted"
      />
    </form>
  );
};
