// SPDX-License-Identifier: AGPL-3.0-only
import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  folderMenu,
  SIDEBAR_EVENTS,
  rankBetween,
  sidebarBoardMenu,
  sidebarDashboardMenu,
  sidebarDocMenu,
  t,
  workspaceMenu,
  type Deleted,
  type Favorite,
  type FavoriteType,
  type MessageKey,
  type MyAccount,
  type WorkspaceEntity,
} from '@bines/shared';
import { cn, EmptyState, Menu, MenuTrigger, Notice, SkeletonRows, useActionMenu, type MenuEntry } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { choiceDialog, confirmDelete, confirmDialog, promptDialog } from '../../lib/dialogs';
import { appLink, copyText, toMenuEntries } from '../../lib/entity-menu';
import { useDeletedToast, useUndoToast } from '../../lib/undo';
import { usePlanGates } from '../../lib/plan-gate';
import { gateMenuEntry, planUpgradeMenuEntries, type PlanGate } from '../../lib/plan-limit';
import { DuplicateBoardDialog } from './DuplicateBoardDialog';
import { NewBoardDialog } from './NewBoardDialog';
import { SaveTemplateDialog } from '../account/Templates';
import { boardKeys, useTree, useWorkspaces, type Workspace, type WorkspaceTree } from '../board/board-api';
import { showToast } from '../../lib/toast';
import { useEventStream } from '../../lib/realtime';
import { Icon } from '../../lib/icons';
import { type AllFavorites, favoriteKey, favoritesKey, favoritesOf, useAllFavorites } from './use-favorites';
import { docKeys, useDocMutations, useFavoriteDocs } from '../docs/doc-api';
import { changedIds, flattenTree, inRootZone, placesOf, rowById, type FlatItem } from './tree-rows';
import { patchTreeRow, reloadTrees } from './tree-cache';
import { useWindowedRows } from '../../lib/use-windowed-rows';
import { dashboardKeys, useDashboardMutations } from '../dashboards/dashboard-api';
import { DashboardGlyph } from '../dashboards/DashboardGlyph';

/**
 * Left pane (11-UI-DESIGN §1; inline-start in RTL): workspace switcher, nested folders, and what a workspace holds —
 * boards and docs (M8 ד0/ד1; dashboards next), in one order per folder. Every row has a ⋯ menu that also opens on
 * right click (14 §6–8); boards and docs drag onto folders, the root, or before / after one another.
 * `variant="page"`: the same tree full-screen on the panel (the phone "לוחות" tab, N1) — surface colours, taller rows.
 */
type TreeFolder = WorkspaceTree['folders'][number];
type TreeBoard = WorkspaceTree['boards'][number];

const MAX_FOLDER_DEPTH = 2; // ≤3 levels (0..2), 02 §3 — the API enforces it too
const ROOT = 'root';
/**
 * The root zone's drop targets: one per run of rows without a folder (folders may stand between
 * them), `root`, `root:1`…
 */
const isRoot = (id: string) => id === ROOT || id.startsWith(`${ROOT}:`);
/** Board rows are drop targets too (fix3: reorder among boards); their droppable ids carry this prefix. */
const BOARD_DROP = 'b:';

type DropSide = 'before' | 'after';
type DropAt = { id: string; side: DropSide };
type BoardPlace = { after_id: string } | { before_id: string };

/** The pointer's side of the row under it: its upper half = before, else after. */
const sideOf = (e: DragMoveEvent | DragEndEvent): DropSide | null => {
  if (!e.over) return null;
  const start = e.activatorEvent as PointerEvent | null;
  if (!start || typeof start.clientY !== 'number') return 'after';
  const y = start.clientY + e.delta.y;
  return y < e.over.rect.top + e.over.rect.height / 2 ? 'before' : 'after';
};

/**
 * Over a folder's header: its upper third = before the folder (in the folder's parent), the rest =
 * into it. Read from the pointer and the header as they are now (`pointerY`, the live rect): the sidebar scrolls
 * itself near its edges during a drag, and a third of a row is only a few pixels.
 */
const intoOrBefore = (e: DragMoveEvent | DragEndEvent, pointerY: number | null): 'before' | 'into' => {
  if (!e.over) return 'into';
  const start = e.activatorEvent as PointerEvent | null;
  const y = pointerY ?? (start && typeof start.clientY === 'number' ? start.clientY + e.delta.y : null);
  if (y === null) return 'into';
  const rect =
    document.querySelector(`[data-folder-id="${String(e.over.id)}"]`)?.getBoundingClientRect() ?? e.over.rect;
  return y < rect.top + rect.height / 3 ? 'before' : 'into';
};

/** Rows under the pointer win over the folder they are in, folders over the root zone around them. */
const collision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  const pick =
    hits.find((h) => String(h.id).startsWith(BOARD_DROP)) ?? hits.find((h) => !isRoot(String(h.id))) ?? hits[0];
  return pick ? [pick] : rectIntersection(args);
};

/**
 * Stable dnd-kit options (s4f-side): a new options object on each render made dnd-kit's context new, and with it
 * every draggable row of the tree rendered again.
 */
const POINTER = { activationConstraint: { distance: 5 } };
/** A windowed tree mounts rows (drop targets) while it scrolls during a drag: measure them as they come. */
const MEASURE_ALWAYS = { droppable: { strategy: MeasuringStrategy.Always } };

/**
 * Trees up to this many lines (folders, boards, docs, dashboards) render every line — so the browser's find-in-page,
 * the keyboard and the specs reach every row; longer ones render only the lines in view (s4f-side). A render
 * optimisation for very big workspaces, not a behaviour: a high constant, no setting.
 */
export const SIDEBAR_FULL_RENDER_ROWS = 1500;
/** Test / support override of that threshold (a number in localStorage), e.g. to see a windowed tree on a small one. */
const WINDOW_ROWS_KEY = 'bines:sidebar-window-rows';
const fullRenderRows = () => {
  try {
    const v = Number(localStorage.getItem(WINDOW_ROWS_KEY));
    return Number.isFinite(v) && v > 0 ? v : SIDEBAR_FULL_RENDER_ROWS;
  } catch {
    return SIDEBAR_FULL_RENDER_ROWS;
  }
};
/** The sidebar's scroll box (its own, on the shell); the windowed tree counts from it. */
const SCROLL_ATTR = 'data-sidebar-scroll';
const sidebarScroller = (list: HTMLElement) => list.closest<HTMLElement>(`[${SCROLL_ATTR}]`);
const remPx = () => {
  try {
    return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  } catch {
    return 16;
  }
};

const useSelectedWorkspace = (accountId: string, ids: string[] | undefined) => {
  const key = `bines:workspace:${accountId}`;
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  });
  const current = ids?.includes(selected ?? '') ? selected! : ids?.[0];
  const select = (id: string) => {
    setSelected(id);
    try {
      localStorage.setItem(key, id);
    } catch {
      // Private mode / blocked storage: the choice just isn't remembered.
    }
  };
  return [current, select] as const;
};

/** The workspace the sidebar shows (the remembered choice, else the first) — the collapsed rail's mark uses it. */
export const useCurrentWorkspace = (accountId: string) => {
  const workspaces = useWorkspaces(accountId);
  const [id] = useSelectedWorkspace(
    accountId,
    workspaces.data?.data.map((w) => w.id),
  );
  return workspaces.data?.data.find((w) => w.id === id);
};

/**
 * Which folders are closed (fix4): remembered per account on this device, shared by every copy of the tree (the
 * sidebar, the rail flyout, the "לוחות" screen). Folders are open unless closed.
 */
const closedKey = (accountId: string) => `bines:closed-folders:${accountId}`;
const closedCache = new Map<string, ReadonlySet<string>>();
const closedListeners = new Set<() => void>();
const readClosed = (accountId: string): ReadonlySet<string> => {
  const hit = closedCache.get(accountId);
  if (hit) return hit;
  let ids: string[] = [];
  try {
    const v: unknown = JSON.parse(localStorage.getItem(closedKey(accountId)) ?? '[]');
    if (Array.isArray(v)) ids = v.filter((x): x is string => typeof x === 'string');
  } catch {
    // Unreadable / blocked storage: everything open.
  }
  const set = new Set(ids);
  closedCache.set(accountId, set);
  return set;
};
const writeClosed = (accountId: string, next: Set<string>) => {
  closedCache.set(accountId, next);
  try {
    if (next.size) localStorage.setItem(closedKey(accountId), JSON.stringify([...next]));
    else localStorage.removeItem(closedKey(accountId));
  } catch {
    // Not remembered — still applies for this visit.
  }
  closedListeners.forEach((l) => l());
};
const subscribeClosed = (cb: () => void) => {
  closedListeners.add(cb);
  return () => closedListeners.delete(cb);
};

const useClosedFolders = (accountId: string) => {
  const closed = useSyncExternalStore(subscribeClosed, () => readClosed(accountId));
  const toggle = (id: string) => {
    const next = new Set(closed);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    writeClosed(accountId, next);
  };
  /** Closes (or opens) every folder and sub-folder in `ids` — "כיווץ הכל / פתיחת הכל". */
  const setAll = (ids: string[], close: boolean) => {
    const next = new Set(closed);
    for (const id of ids) {
      if (close) next.add(id);
      else next.delete(id);
    }
    writeClosed(accountId, next);
  };
  return { closed, toggle, setAll };
};

const useSidebarMutations = (accountId: string) => {
  const deleted = useDeletedToast(accountId);
  const undoToast = useUndoToast(accountId);
  const qc = useQueryClient();
  const client = api(accountId);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ['account', accountId, 'tree'] });
    await qc.invalidateQueries({ queryKey: boardKeys.workspaces(accountId) });
    // A renamed / archived / deleted board changes my favourites too.
    await qc.invalidateQueries({ queryKey: favoritesKey(accountId) });
  };
  const onSuccess = () => refresh();
  return {
    createWorkspace: useMutation({
      mutationFn: (name: string) => client.post<{ id: string }>('/workspaces', { name }),
      onSuccess,
    }),
    renameWorkspace: useMutation({
      mutationFn: (v: { id: string; name: string }) => client.patch(`/workspaces/${v.id}`, { name: v.name }),
      onSuccess,
    }),
    deleteWorkspace: useMutation({
      mutationFn: (v: { id: string; name: string }) => client.delete<Deleted>(`/workspaces/${v.id}`),
      onSuccess: (res, v) => {
        deleted(v.name, res);
        return refresh();
      },
    }),
    createFolder: useMutation({
      mutationFn: (v: { workspace_id: string; parent_folder_id: string | null; name: string }) =>
        client.post('/folders', v),
      onSuccess,
    }),
    // A rename shows at once in the cached trees (s4f-side): only that folder's row renders again, no tree reloads.
    renameFolder: useMutation({
      mutationFn: (v: { id: string; name: string }) => client.patch(`/folders/${v.id}`, { name: v.name }),
      onMutate: (v) => patchTreeRow(qc, accountId, v.id, { name: v.name }),
      onError: () => reloadTrees(qc, accountId),
    }),
    // Prod (sidebar drag): into another folder or the root, and / or before / after a row or folder there.
    moveFolder: useMutation({
      mutationFn: (v: { id: string; parent_folder_id: string | null; position?: BoardPlace }) =>
        client.patch(`/folders/${v.id}`, { parent_folder_id: v.parent_folder_id, position: v.position }),
      onSettled: () => refresh(),
    }),
    deleteFolder: useMutation({
      mutationFn: (v: { id: string; name: string; boards?: 'root' | 'trash' }) =>
        client.delete<Deleted>(`/folders/${v.id}${v.boards === 'trash' ? '?boards=trash' : ''}`),
      onSuccess: (res, v) => {
        deleted(v.name, res);
        return refresh();
      },
    }),
    // Rename / move to a folder (s4f-side): shown at once in the cached trees. A rename reloads only what shows the
    // name elsewhere (favourites, the board, the all-boards list); a move reloads the trees (the server places it).
    updateBoard: useMutation({
      mutationFn: (v: { id: string; name?: string; folder_id?: string | null }) =>
        client.patch(`/boards/${v.id}`, { name: v.name, folder_id: v.folder_id }),
      onMutate: (v) => patchTreeRow(qc, accountId, v.id, { name: v.name, folder_id: v.folder_id }),
      onError: () => reloadTrees(qc, accountId),
      onSuccess: async (_d, v) => {
        if (v.folder_id !== undefined) await refresh();
        else {
          await qc.invalidateQueries({ queryKey: favoritesKey(accountId) });
          await qc.invalidateQueries({ queryKey: [...boardKeys.tree(accountId, ''), 'all'], exact: true });
        }
        await qc.invalidateQueries({ queryKey: boardKeys.board(accountId, v.id) });
      },
    }),
    // Sidebar drag (fix3): before / after another board, in its folder (or the root). Shown at once.
    moveBoard: useMutation({
      mutationFn: (v: { id: string; workspaceId: string; folder_id: string | null; position: BoardPlace }) =>
        client.patch(`/boards/${v.id}`, { folder_id: v.folder_id, position: v.position }),
      onMutate: (v) => {
        const key = boardKeys.tree(accountId, v.workspaceId);
        qc.setQueryData<WorkspaceTree>(key, (old) => {
          if (!old) return old;
          const siblings = old.boards.filter((b) => b.folder_id === v.folder_id && b.id !== v.id);
          const anchorId = 'after_id' in v.position ? v.position.after_id : v.position.before_id;
          const i = siblings.findIndex((b) => b.id === anchorId);
          if (i < 0) return old;
          let position: string;
          try {
            position =
              'after_id' in v.position
                ? rankBetween(siblings[i]!.position, siblings[i + 1]?.position ?? null)
                : rankBetween(siblings[i - 1]?.position ?? null, siblings[i]!.position);
          } catch {
            return old; // equal ranks: the server's answer will do
          }
          const boards = old.boards
            .map((b) => (b.id === v.id ? { ...b, folder_id: v.folder_id, position } : b))
            .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
          return { ...old, boards };
        });
      },
      onSettled: () => refresh(),
    }),
    // fix8 (product owner: "אפשרות להעביר בורדים בין ווארקספייס"): a board, or a folder with its boards, to another workspace.
    moveToWorkspace: useMutation({
      mutationFn: (v: { kind: 'board' | 'folder' | 'doc' | 'dashboard'; id: string; name: string; to: Workspace }) =>
        client.patch(
          `/${{ board: 'boards', doc: 'docs', dashboard: 'dashboards', folder: 'folders' }[v.kind]}/${v.id}`,
          {
            workspace_id: v.to.id,
          },
        ),
      onSuccess: async (_d, v) => {
        showToast({ message: t('sidebar.movedToWorkspace', { what: v.name, to: v.to.name }) });
        await refresh();
        if (v.kind === 'board') await qc.invalidateQueries({ queryKey: boardKeys.board(accountId, v.id) });
        if (v.kind === 'doc') await qc.invalidateQueries({ queryKey: docKeys.doc(accountId, v.id) });
        if (v.kind === 'dashboard')
          await qc.invalidateQueries({ queryKey: dashboardKeys.dashboard(accountId, v.id), exact: true });
      },
    }),
    archiveBoard: useMutation({
      mutationFn: (v: { id: string; name: string }) => client.post<Deleted>(`/boards/${v.id}/archive`, {}),
      onSuccess: (res, v) => {
        undoToast(t('archive.toast', { what: v.name }), res.event_id);
        // The board page (cached) must show the archive banner when it is opened again.
        void qc.invalidateQueries({ queryKey: boardKeys.board(accountId, v.id), exact: true });
        return refresh();
      },
    }),
    deleteBoard: useMutation({
      mutationFn: (v: { id: string; name: string }) => client.delete<Deleted>(`/boards/${v.id}`),
      onSuccess: (res, v) => {
        deleted(v.name, res);
        return refresh();
      },
    }),
  };
};
type SidebarMutations = ReturnType<typeof useSidebarMutations>;

/** In-place rename: Enter or blur saves, Esc cancels. */
const RenameInput = ({
  initial,
  onDone,
  className,
}: {
  initial: string;
  onDone: (name: string | null) => void;
  className?: string;
}) => {
  const [v, setV] = useState(initial);
  const finish = (save: boolean) => onDone(save && v.trim() && v.trim() !== initial ? v.trim() : null);
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  };
  return (
    <input
      autoFocus
      value={v}
      aria-label={t('sidebar.rename')}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setV(e.target.value)}
      onKeyDown={onKey}
      onBlur={() => finish(true)}
      className={cn(
        'h-7 w-full min-w-0 rounded-[var(--radius-sm)] border border-primary bg-surface px-2 text-sm outline-none',
        className,
      )}
    />
  );
};

export const Sidebar = ({ account, variant = 'shell' }: { account: MyAccount; variant?: 'shell' | 'page' }) => {
  const page = variant === 'page';
  const workspaces = useWorkspaces(account.id);
  const [workspaceId, selectWorkspace] = useSelectedWorkspace(
    account.id,
    workspaces.data?.data.map((w) => w.id),
  );
  const tree = useTree(account.id, workspaceId);
  const liveQc = useQueryClient();
  // Plan feature gates: "new doc" / "new dashboard" stay listed, disabled with the hint.
  const planGate = usePlanGates(account.id);
  const gates = { new_doc: planGate('docs'), new_dashboard: planGate('dashboards') };
  // Someone else created / renamed / moved / shared / deleted a doc (M8 ד2): refetch what I may see.
  useEventStream(page ? null : '/me/events', account.id, (e) => {
    if (!SIDEBAR_EVENTS.has(e.type)) return;
    void liveQc.invalidateQueries({ queryKey: ['account', account.id, 'tree'] });
    void liveQc.invalidateQueries({ queryKey: docKeys.favorites(account.id) });
    void liveQc.invalidateQueries({ queryKey: favoritesKey(account.id) });
  });
  const mut = useSidebarMutations(account.id);
  const docMut = useDocMutations(account.id);
  const dashMut = useDashboardMutations(account.id);
  // One favourites list (Fix: ): boards, docs and dashboards, each row's star reads its type's view.
  const allFavorites = useAllFavorites(account.id);
  const favorites = favoritesOf(allFavorites, 'board');
  const docFavorites = favoritesOf(allFavorites, 'doc');
  const dashFavorites = favoritesOf(allFavorites, 'dashboard');
  // A doc starred on its own page (its own list, GET /me/favorite-docs) joins the sidebar's list.
  const docStamp = useFavoriteDocs(account.id)
    .list.map((d) => d.id)
    .join(',');
  const lastDocStamp = useRef<string | null>(null);
  useEffect(() => {
    if (lastDocStamp.current !== null && lastDocStamp.current !== docStamp)
      void liveQc.invalidateQueries({ queryKey: favoritesKey(account.id) });
    lastDocStamp.current = docStamp;
  }, [docStamp, liveQc, account.id]);
  const folders = useClosedFolders(account.id);
  const [newBoardIn, setNewBoardIn] = useState<string | null | undefined>(undefined); // undefined = closed
  // "בורד מתבנית" from the "+" menu: the same dialog, starting at the template.
  const [fromTemplate, setFromTemplate] = useState(false);
  const addMenu = useActionMenu();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragging, setDragging] = useState<TreeBoard | WorkspaceEntity | TreeFolder | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  // Where the pointer is during a drag (before / into a folder — `intoOrBefore`). Captured on the
  // window, so it is current before dnd-kit's own handlers run.
  const pointerY = useRef<number | null>(null);
  useEffect(() => {
    if (!dragging) return;
    const track = (ev: PointerEvent) => {
      pointerY.current = ev.clientY;
    };
    window.addEventListener('pointermove', track, true);
    return () => {
      window.removeEventListener('pointermove', track, true);
      pointerY.current = null;
    };
  }, [dragging]);
  const wsMenu = useActionMenu();
  const switcher = useActionMenu();
  const navigate = useNavigate();
  const goUpgrade = (path: string) => void navigate({ to: path });
  const sensors = useSensors(useSensor(PointerSensor, POINTER));
  // The open board / doc / dashboard — read here once, so a row renders again only when it becomes / stops being it.
  const params = useParams({ strict: false }) as { boardId?: string; docId?: string; dashboardId?: string };
  const deleted = useDeletedToast(account.id);

  const error =
    Object.values(mut).find((x) => x.isError)?.error ??
    Object.values(docMut).find((x) => x.isError)?.error ??
    Object.values(dashMut).find((x) => x.isError)?.error ??
    allFavorites.error;
  const data = tree.data;

  /** A new doc (M8): created at once with a default name, opened with the title ready to rename. */
  const newDoc = (folderId: string | null) => {
    if (!data) return;
    docMut.create.mutate(
      { workspaceId: data.workspace.id, folder_id: folderId, name: t('docs.untitled') },
      {
        onSuccess: (doc) =>
          void navigate({ to: '/a/$accountSlug/d/$docId', params: { accountSlug: account.slug, docId: doc.id } }),
      },
    );
  };

  /** A new dashboard (M8 ד4): created at once, opened so its owner picks boards and adds widgets. */
  const newDashboard = (folderId: string | null) => {
    if (!data) return;
    dashMut.create.mutate(
      { workspaceId: data.workspace.id, folder_id: folderId, name: t('dashboards.untitled') },
      {
        onSuccess: (d) =>
          void navigate({
            to: '/a/$accountSlug/dash/$dashboardId',
            params: { accountSlug: account.slug, dashboardId: d.id },
          }),
      },
    );
  };

  const newFolder = async (parent: string | null) => {
    if (!data) return;
    const name = await promptDialog({
      title: parent ? t('sidebar.newSubfolder') : t('sidebar.newFolder'),
      label: t('sidebar.folderName'),
      confirmLabel: t('dialog.create'),
    });
    if (name) mut.createFolder.mutate({ workspace_id: data.workspace.id, parent_folder_id: parent, name });
  };

  // The line between rows while a board is dragged over another board (fix3) — or above a folder.
  const onDragMove = (e: DragMoveEvent) => {
    const overId = e.over ? String(e.over.id) : '';
    const onFolder = !!data?.folders.some((f) => f.id === overId);
    const id = overId.startsWith(BOARD_DROP) ? overId.slice(BOARD_DROP.length) : onFolder ? overId : null;
    const side = onFolder ? (intoOrBefore(e, pointerY.current) === 'before' ? 'before' : null) : sideOf(e);
    setDropAt((prev) =>
      !id || id === e.active.id || !side ? null : prev?.id === id && prev.side === side ? prev : { id, side },
    );
  };

  /** The folder and every folder inside it (it never goes into one of them). */
  const subtree = (id: string) => {
    const ids = [id];
    for (let i = 0; i < ids.length; i++)
      ids.push(...(data?.folders ?? []).filter((f) => f.parent_folder_id === ids[i]).map((f) => f.id));
    return ids;
  };
  /** How deep a folder sits (0 = the root's; -1 = the root itself). */
  const depthOf = (id: string | null): number => {
    const f = id ? data?.folders.find((x) => x.id === id) : undefined;
    return f ? 1 + depthOf(f.parent_folder_id) : -1;
  };

  /**
   * A folder dropped (product owner: "drag folders like everything else, and put one between boards"): on a
   * row = before / after it, in the row's folder; on a folder's upper third = before it; on the rest of a folder
   * = into it (after its folders); on the root zone = to the root. Never into itself or deeper than three levels.
   */
  const dropFolder = (e: DragEndEvent, folder: TreeFolder, overId: string) => {
    if (!data || overId === folder.id) return;
    let parent: string | null;
    let position: BoardPlace | undefined;
    if (overId.startsWith(BOARD_DROP)) {
      const anchor = rowById(data, overId.slice(BOARD_DROP.length));
      if (!anchor) return;
      parent = anchor.folder_id;
      position = (sideOf(e) ?? 'after') === 'before' ? { before_id: anchor.id } : { after_id: anchor.id };
    } else if (isRoot(overId)) parent = null;
    else {
      const target = data.folders.find((f) => f.id === overId);
      if (!target) return;
      if (intoOrBefore(e, pointerY.current) === 'before') {
        parent = target.parent_folder_id;
        position = { before_id: target.id };
      } else parent = target.id;
    }
    const inside = subtree(folder.id);
    if (parent && inside.includes(parent)) return;
    const height = Math.max(...inside.map((id) => depthOf(id))) - depthOf(folder.id);
    if (depthOf(parent) + 1 + height > MAX_FOLDER_DEPTH)
      return void showToast({ message: t('sidebar.folderTooDeep'), tone: 'error' });
    if (parent === folder.parent_folder_id && !position) return;
    mut.moveFolder.mutate({ id: folder.id, parent_folder_id: parent, position });
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    setDragging(null);
    setDropAt(null);
    if (!over || !data) return;
    const overId = String(over.id);
    const folder = data.folders.find((f) => f.id === active.id);
    if (folder) return dropFolder(e, folder, overId);
    // Onto a folder's upper third: before the folder, in its parent — a board, doc or dashboard.
    const above = data.folders.find((f) => f.id === overId && intoOrBefore(e, pointerY.current) === 'before');
    // A doc (M8): before / after any row of a folder, or onto a folder / the root — like a board.
    const doc = (data.entities ?? []).find((x) => x.id === active.id);
    if (doc) {
      // Docs and dashboards (ד4) move the same way, each through its own endpoint.
      const update = (v: {
        id: string;
        folder_id?: string | null;
        position?: { after_id: string } | { before_id: string };
      }) => (doc.type === 'dashboard' ? dashMut.update.mutate(v) : docMut.update.mutate(v));
      if (above)
        return void update({ id: doc.id, folder_id: above.parent_folder_id, position: { before_id: above.id } });
      if (overId.startsWith(BOARD_DROP)) {
        const anchor = rowById(data, overId.slice(BOARD_DROP.length));
        if (!anchor || anchor.id === doc.id) return;
        const side = sideOf(e) ?? 'after';
        update({
          id: doc.id,
          folder_id: anchor.folder_id,
          position: side === 'before' ? { before_id: anchor.id } : { after_id: anchor.id },
        });
        return;
      }
      const target = isRoot(overId) ? null : overId;
      if (target !== doc.folder_id) update({ id: doc.id, folder_id: target });
      return;
    }
    const board = data.boards.find((b) => b.id === active.id);
    if (!board) return;
    if (above)
      return void mut.moveBoard.mutate({
        id: board.id,
        workspaceId: data.workspace.id,
        folder_id: above.parent_folder_id,
        position: { before_id: above.id },
      });
    // Onto a board (or a doc): before / after it, in its folder (fix3).
    if (overId.startsWith(BOARD_DROP)) {
      const anchor = rowById(data, overId.slice(BOARD_DROP.length));
      if (!anchor || anchor.id === board.id) return;
      const side = sideOf(e) ?? 'after';
      mut.moveBoard.mutate({
        id: board.id,
        workspaceId: data.workspace.id,
        folder_id: anchor.folder_id,
        position: side === 'before' ? { before_id: anchor.id } : { after_id: anchor.id },
      });
      return;
    }
    // Onto a folder (its end) or the root.
    const target = isRoot(overId) ? null : overId;
    if (target !== board.folder_id) mut.updateBoard.mutate({ id: board.id, folder_id: target });
  };

  // "כיווץ הכל / פתיחת הכל" for the folders and sub-folders of this workspace (fix4): when any is open, close all.
  const folderIds = data?.folders.map((f) => f.id) ?? [];
  const anyOpen = folderIds.some((id) => !folders.closed.has(id));
  const foldersLabel = t((anyOpen ? 'sidebar.collapseFolders' : 'sidebar.expandFolders') as MessageKey);
  const toggleAllFolders = () => folders.setAll(folderIds, anyOpen);

  // "דף המרחב" (account admin plan): the workspace's own page — description, boards, access — first in its ⋯ menu.
  const wsPage: MenuEntry[] = data
    ? [
        {
          label: t('workspace.page'),
          testId: 'workspace-page-link',
          onSelect: () =>
            void navigate({
              to: '/a/$accountSlug/w/$workspaceId',
              params: { accountSlug: account.slug, workspaceId: data.workspace.id },
            }),
        },
        ...(folderIds.length
          ? [{ label: foldersLabel, testId: 'workspace-folders-toggle', onSelect: toggleAllFolders }]
          : []),
      ]
    : [];
  const wsActions: MenuEntry[] = data
    ? toMenuEntries(
        workspaceMenu({
          canCreate: data.workspace.can_create,
          canEdit: data.workspace.can_edit,
          canDelete: data.workspace.can_delete,
        }),
        {
          new_board: () => setNewBoardIn(null),
          new_doc: () => newDoc(null),
          new_dashboard: () => newDashboard(null),
          new_folder: () => void newFolder(null),
          rename: () => setRenaming(`ws:${data.workspace.id}`),
          delete: () =>
            void confirmDialog({
              title: t('dialog.delete.title', { what: data.workspace.name }),
              message: t('sidebar.deleteWorkspace.message'),
              danger: true,
            }).then((ok) => ok && mut.deleteWorkspace.mutate({ id: data.workspace.id, name: data.workspace.name })),
        },
        {},
        gates,
      )
    : [];
  const wsItems: MenuEntry[] = wsActions.length
    ? [...wsPage, { kind: 'separator' }, ...wsActions, ...planUpgradeMenuEntries(Object.values(gates), goUpgrade)]
    : wsPage;

  // "+ Workspace חדש" comes first: the list below it loads after the menu opens, and an entry under a loading
  // list would move away from the pointer (a click would land on a workspace).
  const canCreateWorkspace = account.role === 'admin' || account.role === 'member';
  const switchItems: MenuEntry[] = [
    ...(canCreateWorkspace
      ? [
          {
            label: `+ ${t('sidebar.newWorkspace')}`,
            onSelect: () =>
              void promptDialog({
                title: t('sidebar.newWorkspace'),
                label: t('sidebar.workspaceName'),
                confirmLabel: t('dialog.create'),
              }).then(
                (name) =>
                  name &&
                  mut.createWorkspace.mutate(name, {
                    onSuccess: (w) => selectWorkspace((w as { id: string }).id),
                  }),
              ),
          },
          { kind: 'separator' as const },
        ]
      : []),
    ...(workspaces.data?.data ?? []).map((w) => ({
      label: w.name,
      checked: w.id === workspaceId,
      onSelect: () => selectWorkspace(w.id),
    })),
  ];

  const ctx: TreeCtx | null = data
    ? {
        account,
        data,
        mut,
        docMut,
        dashMut,
        renaming,
        setRenaming,
        setNewBoardIn,
        newDoc,
        newDashboard,
        newFolder,
        gates,
        goUpgrade,
        page,
        favorites,
        docFavorites,
        dashFavorites,
        workspaces: workspaces.data?.data ?? [],
        toggleFolder: folders.toggle,
        current: params,
        navigate,
        deleted,
        qc: liveQc,
      }
    : null;
  // Rows read the latest context in their handlers (set after each commit), and only an open ⋯ menu reads the live
  // one — so a row renders again only when its own props change (s4f-side).
  const latest = useRef<TreeCtx | null>(null);
  useLayoutEffect(() => {
    latest.current = ctx;
  });

  // The tree as lines (folders open / closed), windowed when long (s4f-side).
  const rootHint =
    !!dragging && ('parent_folder_id' in dragging ? dragging.parent_folder_id : dragging.folder_id) !== null;
  const flat = useMemo(
    () => (data ? flattenTree(data, folders.closed, rootHint) : []),
    [data, folders.closed, rootHint],
  );
  const [rem] = useState(remPx);
  const [fullRows] = useState(fullRenderRows);
  const rowPx = (page ? 2.75 : 1.875) * rem;
  const hintPx = 1.875 * rem;
  const {
    attach,
    rows: inView,
    before,
    after,
    windowed,
    scrollToIndex,
  } = useWindowedRows<HTMLElement>({
    count: flat.length,
    estimate: (i) => (flat[i]?.kind === 'hint' ? hintPx : rowPx) + (flat[i]?.gap ? 2 : 0),
    getKey: (i) => flat[i]?.key ?? String(i),
    scroll: 'page',
    scroller: page ? undefined : sidebarScroller,
    fullRows,
    overscan: 12,
  });
  // The open board / doc / dashboard is scrolled into view once (a long, windowed tree would not even mount it).
  const currentId = params.boardId ?? params.docId ?? params.dashboardId;
  const scrolledTo = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (page || !windowed || !currentId || scrolledTo.current === currentId) return;
    const i = flat.findIndex((it) => it.kind === 'row' && it.key === currentId);
    if (i < 0) return;
    scrolledTo.current = currentId;
    scrollToIndex(i);
  }, [page, windowed, currentId, flat, scrollToIndex]);
  // Windowed: what was just created, moved or renamed — here or by someone else — and the row being renamed are
  // scrolled into view, so they are mounted (a new folder at the end of a long tree would otherwise not be there).
  const places = useRef<{ ws: string; at: Map<string, string> } | null>(null);
  useEffect(() => {
    if (!data) return;
    const before = places.current;
    const at = placesOf(data);
    places.current = { ws: data.workspace.id, at };
    if (page || !windowed || !before || before.ws !== data.workspace.id) return;
    const id = changedIds(before.at, at).at(-1);
    const i = id ? flat.findIndex((it) => it.key === id) : -1;
    if (i >= 0) scrollToIndex(i);
  }, [data, page, windowed, flat, scrollToIndex]);
  useEffect(() => {
    if (page || !windowed || !renaming) return;
    const i = flat.findIndex((it) => it.key === renaming);
    if (i >= 0) scrollToIndex(i);
  }, [renaming, page, windowed, flat, scrollToIndex]);
  const favoriteSet = useMemo(() => new Set(allFavorites.list.map(favoriteKey)), [allFavorites.list]);
  // Skeleton while the workspaces or the tree load (N16) — not while there is no workspace at all.
  const loading = workspaces.isPending || (!!workspaceId && tree.isPending);
  const addLabel = t('sidebar.add');
  const addItems: MenuEntry[] = data?.workspace.can_create
    ? [
        {
          label: t('board.new'),
          icon: <BoardIcon />,
          testId: 'add-new-board',
          onSelect: () => {
            setFromTemplate(false);
            setNewBoardIn(null);
          },
        },
        {
          label: t('sidebar.add.fromTemplate'),
          icon: <TemplateIcon />,
          testId: 'add-board-template',
          onSelect: () => {
            setFromTemplate(true);
            setNewBoardIn(null);
          },
        },
        { kind: 'separator' },
        gateMenuEntry(gates.new_doc, {
          label: t('docs.new'),
          icon: <DocIcon />,
          testId: 'add-new-doc',
          disabled: docMut.create.isPending,
          onSelect: () => newDoc(null),
        }),
        gateMenuEntry(gates.new_dashboard, {
          label: t('dashboards.new'),
          icon: <DashboardGlyph size={15} />,
          testId: 'add-new-dashboard',
          disabled: dashMut.create.isPending,
          onSelect: () => newDashboard(null),
        }),
        { kind: 'separator' },
        {
          label: t('sidebar.newFolder'),
          icon: <FolderIcon />,
          testId: 'add-new-folder',
          onSelect: () => void newFolder(null),
        },
        // "How to start?": a full template or "Build with AI" — account admins.
        ...(account.role === 'admin'
          ? [
              {
                label: t('onboarding.menu'),
                icon: <Icon name="sparkle" size={15} />,
                testId: 'add-start',
                onSelect: () => void navigate({ to: '/a/$accountSlug/start', params: { accountSlug: account.slug } }),
              },
            ]
          : []),
        ...planUpgradeMenuEntries(Object.values(gates), goUpgrade),
      ]
    : [];

  // A guest nothing is shared with (fix4): no workspace switcher, no empty tree — the "לוחות" screen says so.
  if (account.role === 'guest' && workspaces.isSuccess && !workspaces.data.data.length) {
    return page ? (
      <EmptyState testId="boards-page-empty" title={t('guest.noBoards.title')}>
        {t('guest.noBoards.body', { account: account.name })}
      </EmptyState>
    ) : (
      <div className="min-h-0 flex-1" data-testid="sidebar-no-boards" />
    );
  }

  return (
    // On the shell (F4): `.on-shell` maps the tokens to light-on-green, so the tree and its forms keep their classes.
    <div
      className={cn('flex flex-col', !page && 'on-shell min-h-0 flex-1 overflow-y-auto')}
      data-testid={page ? 'boards-tree' : undefined}
      data-tour="nav.boards"
      data-sidebar-scroll={page ? undefined : ''}
    >
      <div className={cn('flex-[1_0_auto]', page ? 'pb-2' : 'px-3 pb-3')}>
        <FavoritesSection account={account} favorites={allFavorites} page={page} />
        {/* "מרחב עבודה" + "+" (canvas `.s-label`, N13): the "+" opens the "add new" menu (Fix: ). */}
        <div
          className={cn(
            'mb-1.5 flex items-center gap-0.5 px-1 font-semibold',
            page ? 'text-xs text-muted' : 'text-[0.6875rem] text-shell-muted',
          )}
        >
          <span className="me-auto">{t('nav.workspace')}</span>
          {folderIds.length ? (
            <button
              type="button"
              aria-label={foldersLabel}
              title={foldersLabel}
              aria-pressed={!anyOpen}
              data-testid={page ? 'boards-page-folders-toggle' : 'sidebar-folders-toggle'}
              onClick={toggleAllFolders}
              className={cn(
                'grid place-items-center rounded-[8px] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
                page
                  ? 'size-9 text-fg-2 hover:bg-surface-2 hover:text-fg'
                  : 'size-[1.375rem] text-shell-fg hover:bg-[var(--shell-hover)] hover:text-shell-strong',
              )}
            >
              {/* Arrows together = collapse all; apart = expand all. */}
              <svg
                width={page ? 18 : 14}
                height={page ? 18 : 14}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d={anyOpen ? 'M7 4l5 5 5-5M7 20l5-5 5 5' : 'M7 9l5-5 5 5M7 15l5 5 5-5'} />
              </svg>
            </button>
          ) : null}
          {addItems.length ? (
            // One "+" (Fix: , product decision; "Add new"): new board, board from a template, doc,
            // dashboard, folder — instead of a button per kind.
            <button
              type="button"
              aria-label={addLabel}
              title={addLabel}
              aria-haspopup="menu"
              data-testid={page ? 'boards-page-add' : 'sidebar-add'}
              onClick={addMenu.fromTrigger}
              className={cn(
                'grid place-items-center rounded-[8px] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
                page
                  ? 'size-9 text-fg-2 hover:bg-surface-2 hover:text-fg'
                  : 'size-[1.375rem] text-shell-fg hover:bg-[var(--shell-hover)] hover:text-shell-strong',
              )}
            >
              <svg
                width={page ? 18 : 14}
                height={page ? 18 : 14}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          ) : null}
          <Menu at={addMenu.at} onClose={addMenu.close} items={addItems} label={addLabel} />
        </div>
        <div
          className="group relative mb-1.5"
          onContextMenu={data ? wsMenu.onContextMenu : undefined}
          onKeyDown={data ? wsMenu.onKeyDown : undefined}
        >
          {data && renaming === `ws:${data.workspace.id}` ? (
            <RenameInput
              initial={data.workspace.name}
              onDone={(name) => {
                setRenaming(null);
                if (name) mut.renameWorkspace.mutate({ id: data.workspace.id, name });
              }}
            />
          ) : (
            <button
              type="button"
              aria-haspopup="menu"
              aria-label={t('sidebar.switchWorkspace')}
              onClick={switcher.fromTrigger}
              data-testid={page ? 'boards-workspace-switcher' : undefined}
              className={cn(
                'flex w-full min-w-0 items-center gap-2 rounded-[10px] px-2.5 text-start font-semibold',
                page
                  ? 'h-11 border border-line bg-surface-3 text-[0.9375rem] text-heading hover:bg-surface-2'
                  : 'h-9 bg-[var(--shell-input)] text-sm text-shell-strong hover:bg-[var(--shell-active)]',
              )}
            >
              <span
                aria-hidden
                className="grid size-[1.375rem] shrink-0 place-items-center rounded-[7px] bg-accent text-[0.6875rem] font-bold text-on-accent"
              >
                {(data?.workspace.name ?? t('nav.workspace')).trim().charAt(0)}
              </span>
              <span className="min-w-0 flex-1 truncate">{data?.workspace.name ?? t('nav.workspace')}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                aria-hidden
              >
                <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
          {wsItems.length ? (
            // Over the switcher, before its chevron: the switcher keeps the full width (no reserved slot).
            <MenuTrigger
              label={t('sidebar.actionsFor', { name: data!.workspace.name })}
              onClick={wsMenu.fromTrigger}
              className={cn(
                'absolute end-7 top-1/2 h-6 -translate-y-1/2',
                page ? 'text-muted' : 'text-shell-fg hover:bg-[var(--shell-active)] hover:text-shell-strong',
              )}
            />
          ) : null}
        </div>
        <Menu at={switcher.at} onClose={switcher.close} items={switchItems} label={t('sidebar.switchWorkspace')} />
        <Menu
          at={wsMenu.at}
          onClose={wsMenu.close}
          items={wsItems}
          label={t('sidebar.actionsFor', { name: data?.workspace.name ?? '' })}
        />

        {error ? (
          <div className="mb-2">
            <Notice tone="error">{errorMessage(error)}</Notice>
          </div>
        ) : null}

        {loading ? (
          <SkeletonRows rows={5} label={t('app.loading')} testId="sidebar-skeleton" className="px-2.5" />
        ) : null}

        {ctx ? (
          <DndContext
            sensors={sensors}
            collisionDetection={collision}
            onDragStart={({ active }) =>
              setDragging(rowById(data!, String(active.id)) ?? data!.folders.find((f) => f.id === active.id) ?? null)
            }
            onDragMove={onDragMove}
            onDragCancel={() => {
              setDragging(null);
              setDropAt(null);
            }}
            onDragEnd={onDragEnd}
            measuring={windowed ? MEASURE_ALWAYS : undefined}
          >
            <LatestCtx.Provider value={latest}>
              <LiveCtx.Provider value={ctx}>
                <nav ref={attach}>
                  {before ? <div aria-hidden style={{ height: before }} /> : null}
                  {treeLines(
                    flat,
                    inView.map((r) => r.index),
                    (it, gap) => {
                      if (it.kind === 'hint')
                        return (
                          <p
                            key={it.key}
                            className={cn(
                              'rounded-[var(--radius-sm)] border border-dashed border-line px-2 py-1.5 text-center text-xs text-muted',
                              gap && 'mt-0.5',
                            )}
                          >
                            {t('sidebar.dropRoot')}
                          </p>
                        );
                      if (it.kind === 'folder')
                        return (
                          <FolderNode
                            folder={it.folder}
                            depth={it.depth}
                            closed={it.closed}
                            renaming={renaming === it.folder.id}
                            page={page}
                            canCreate={data!.workspace.can_create}
                            otherWorkspaces={(workspaces.data?.data.length ?? 0) > 1}
                            line={dropAt?.id === it.folder.id ? dropAt.side : null}
                          />
                        );
                      const r = it.row;
                      const props: RowProps = {
                        accountId: account.id,
                        accountSlug: account.slug,
                        workspaceId: data!.workspace.id,
                        gap,
                        current:
                          (r.type === 'board'
                            ? params.boardId
                            : r.type === 'doc'
                              ? params.docId
                              : params.dashboardId) === r.row.id,
                        favorite: favoriteSet.has(favoriteKey({ type: r.type, id: r.row.id })),
                        favLoaded: allFavorites.loaded,
                        line: dropAt?.id === r.row.id ? dropAt.side : null,
                        renaming: renaming === r.row.id,
                        page,
                      };
                      return r.type === 'board' ? (
                        <BoardNode key={it.key} board={r.row} {...props} />
                      ) : r.type === 'doc' ? (
                        <DocNode key={it.key} doc={r.row} {...props} />
                      ) : r.type === 'dashboard' ? (
                        <DashboardNode key={it.key} dashboard={r.row} {...props} />
                      ) : null;
                    },
                  )}
                  {after ? <div aria-hidden style={{ height: after }} /> : null}
                  {!data!.boards.length && !data!.entities?.length ? (
                    <p className="mt-0.5 px-2 text-xs text-muted">{t('nav.noBoards')}</p>
                  ) : null}
                </nav>
              </LiveCtx.Provider>
            </LatestCtx.Provider>
            <DragOverlay dropAnimation={null}>
              {dragging ? (
                <div className="rounded-[var(--radius-sm)] bg-surface px-2 py-1 text-sm shadow-[var(--shadow-pop)] ring-1 ring-[var(--line)]">
                  {dragging.name}
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        ) : null}
      </div>
      {data && newBoardIn !== undefined ? (
        <NewBoardDialog
          key={newBoardIn ?? ROOT}
          account={account}
          tree={data}
          folderId={newBoardIn}
          fromTemplate={fromTemplate}
          onClose={() => {
            setNewBoardIn(undefined);
            setFromTemplate(false);
          }}
        />
      ) : null}
    </div>
  );
};

const FolderIcon = () => <Icon name="folder" size={15} />;

const TemplateIcon = () => <Icon name="boardTemplate" size={15} />;

/**
 * The shareable mark (round 16): a board, doc or dashboard that guests may be invited to shows the same small
 * "people" icon after its name (the icon of "shareable" in the share dialogs).
 */
const ShareableMark = ({ kind }: { kind: string }) =>
  kind === 'shareable' ? (
    <span
      className="shrink-0 text-muted"
      data-testid="shareable-mark"
      title={t('perm.kind.short.shareable')}
      aria-label={t('perm.kind.short.shareable')}
      role="img"
    >
      <Icon name="people" size={13} />
    </span>
  ) : null;

const BoardIcon = () => <Icon name="board" size={15} />;

type Favorites = ReturnType<typeof favoritesOf>;
/** What a star needs: boards', docs' and dashboards' favourites alike (one list, Fix: ). */
type Starred = Pick<Favorites, 'isFavorite' | 'toggle' | 'loaded'>;

const DocIcon = () => <Icon name="doc" size={15} />;

/** A 5-point star (favourite boards): filled when on (the state, so in every icon style), else in the user's style. */
const StarIcon = ({ on, size = 14 }: { on: boolean; size?: number }) =>
  on ? (
    <svg
      style={{ width: `${size / 16}rem`, height: `${size / 16}rem` }}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M12 3.5l2.6 5.5 6 .7-4.5 4.1 1.2 5.9L12 16.8l-5.3 2.9 1.2-5.9-4.5-4.1 6-.7z" />
    </svg>
  ) : (
    <Icon name="star" size={size} />
  );

/** The star on a board row: shown on hover / focus (always on a phone), always when the board is a favourite. */
const FavoriteToggle = ({
  name,
  on,
  loaded,
  onToggle,
  page,
  testId = 'board-favorite-toggle',
}: {
  name: string;
  on: boolean;
  loaded: boolean;
  onToggle: () => void;
  page: boolean;
  testId?: string;
}) => {
  const label = t((on ? 'sidebar.unfavorite' : 'sidebar.favorite') as MessageKey);
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${label}: ${name}`}
      title={label}
      data-testid={testId}
      disabled={!loaded}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        'grid shrink-0 place-items-center rounded-[var(--radius-sm)] group-focus-within:opacity-100 group-hover:opacity-100 focus:opacity-100',
        page ? 'size-9' : 'size-6',
        on ? 'text-[var(--rating)] opacity-100' : 'text-muted opacity-0 hover:text-fg max-md:opacity-100',
      )}
    >
      <StarIcon on={on} size={page ? 18 : 14} />
    </button>
  );
};

/**
 * The dragged favourite moves with the pointer, so the release lands on its own link: the browser would follow it
 * (dnd-kit only stops the click's propagation, not the link's default). Swallow that one click.
 */
const swallowClick = () => {
  const stop = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
};

/**
 * "מועדפים" at the top of the tree (fix2; Fix: docs and dashboards too, in ONE list): my starred boards,
 * docs and dashboards from every workspace, in my order, each with its type's icon — dragged to reorder (the order
 * is saved with PUT /me/favorites). Nothing shows until there is one.
 */
const FavoritesSection = ({
  account,
  favorites,
  page,
}: {
  account: MyAccount;
  favorites: AllFavorites;
  page: boolean;
}) => {
  const params = useParams({ strict: false }) as { boardId?: string; docId?: string; dashboardId?: string };
  const sensors = useSensors(useSensor(PointerSensor, POINTER));
  const list = favorites.list;
  if (!list.length) return null;
  const label = t('sidebar.favorites');
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    swallowClick();
    if (over && active.id !== over.id) favorites.move(String(active.id), String(over.id));
  };
  const currentOf = (f: Favorite) =>
    (f.type === 'board' ? params.boardId : f.type === 'doc' ? params.docId : params.dashboardId) === f.id;
  return (
    <section aria-label={label} data-testid="favorites-section" className="mb-3">
      <h2
        className={cn(
          'mb-1.5 flex items-center gap-1.5 px-1 font-semibold',
          page ? 'text-xs text-muted' : 'text-[0.6875rem] text-shell-muted',
        )}
      >
        <StarIcon on size={12} />
        {label}
      </h2>
      <DndContext
        sensors={sensors}
        collisionDetection={rectIntersection}
        onDragEnd={onDragEnd}
        onDragCancel={swallowClick}
      >
        <SortableContext items={list.map(favoriteKey)} strategy={verticalListSortingStrategy}>
          <div className="space-y-0.5">
            {list.map((f) => (
              <FavoriteRow
                key={favoriteKey(f)}
                favorite={f}
                account={account}
                star={favoritesOf(favorites, f.type)}
                loaded={favorites.loaded}
                page={page}
                current={currentOf(f)}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </section>
  );
};

const FAVORITE_ROW_TEST_ID: Record<FavoriteType, string> = {
  board: 'favorite-board-row',
  doc: 'favorite-doc-row',
  dashboard: 'favorite-dashboard-row',
};
const FAVORITE_TOGGLE_TEST_ID: Record<FavoriteType, string> = {
  board: 'board-favorite-toggle',
  doc: 'doc-favorite-toggle',
  dashboard: 'dashboard-favorite-toggle',
};

/** One favourite: a link to the board / doc / dashboard that is also dragged to reorder (after a 5px move). */
const FavoriteRow = ({
  favorite: f,
  account,
  star,
  loaded,
  page,
  current,
}: {
  favorite: Favorite;
  account: MyAccount;
  star: Starred;
  loaded: boolean;
  page: boolean;
  current: boolean;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: favoriteKey(f),
    disabled: !loaded,
  });
  const linkClass = cn(
    'flex min-w-0 flex-1 items-center gap-2 px-2.5',
    page ? 'h-11 text-[0.9375rem]' : 'h-[1.875rem] text-sm',
    current && 'font-semibold',
  );
  const body = (
    <>
      {f.type === 'board' ? (
        <BoardIcon />
      ) : f.type === 'dashboard' ? (
        <DashboardGlyph />
      ) : f.icon ? (
        <span aria-hidden className="w-[0.9375rem] shrink-0 text-center text-[0.8125rem] leading-none">
          {f.icon}
        </span>
      ) : (
        <DocIcon />
      )}
      <span className="truncate">{f.name}</span>
    </>
  );
  const linkProps = { ...attributes, ...listeners, 'aria-disabled': undefined, role: 'link', className: linkClass };
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-testid={FAVORITE_ROW_TEST_ID[f.type]}
      data-type={f.type}
      data-name={f.name}
      className={cn(
        'group relative flex items-center rounded-[10px] pe-1 hover:bg-surface-2',
        current &&
          (page
            ? 'bg-primary-soft hover:bg-primary-soft'
            : 'bg-[var(--shell-active)] text-shell-strong hover:bg-[var(--shell-active)]'),
        isDragging && 'z-10 bg-surface-2 opacity-80 shadow-[var(--shadow-pop)]',
      )}
    >
      {f.type === 'board' ? (
        <Link to="/a/$accountSlug/b/$boardId" params={{ accountSlug: account.slug, boardId: f.id }} {...linkProps}>
          {body}
        </Link>
      ) : f.type === 'doc' ? (
        <Link to="/a/$accountSlug/d/$docId" params={{ accountSlug: account.slug, docId: f.id }} {...linkProps}>
          {body}
        </Link>
      ) : (
        <Link
          to="/a/$accountSlug/dash/$dashboardId"
          params={{ accountSlug: account.slug, dashboardId: f.id }}
          {...linkProps}
        >
          {body}
        </Link>
      )}
      <FavoriteToggle
        name={f.name}
        on={star.isFavorite(f.id)}
        loaded={star.loaded}
        onToggle={() => star.toggle(f)}
        page={page}
        testId={FAVORITE_TOGGLE_TEST_ID[f.type]}
      />
    </div>
  );
};
type TreeCtx = {
  /** My favourite boards (the star on each row, the "מועדפים" section). */
  favorites: Favorites;
  /** Every workspace I see — the "move to workspace" menu offers the others. */
  workspaces: Workspace[];
  account: MyAccount;
  data: WorkspaceTree;
  mut: SidebarMutations;
  /** Docs (M8): rename, move, duplicate, delete — and my favourite docs. */
  docMut: ReturnType<typeof useDocMutations>;
  /** Dashboards (M8 ד4): rename, move, duplicate, delete. */
  dashMut: ReturnType<typeof useDashboardMutations>;
  newDashboard: (folderId: string | null) => void;
  docFavorites: Favorites;
  /** My favourite dashboards (Fix: ). */
  dashFavorites: Favorites;
  renaming: string | null;
  setRenaming: (key: string | null) => void;
  setNewBoardIn: (folderId: string | null) => void;
  newDoc: (folderId: string | null) => void;
  newFolder: (parent: string | null) => Promise<void>;
  /** Plan feature gates of the "new …" rows (by menu id), and the way to "My plan". */
  gates: Record<string, PlanGate>;
  goUpgrade: (path: string) => void;
  /** The full-screen variant (phone "לוחות"): taller rows for touch, the open board in the soft primary. */
  page: boolean;
  toggleFolder: (id: string) => void;
  /** The open board / doc / dashboard (route params). */
  current: { boardId?: string; docId?: string; dashboardId?: string };
  navigate: ReturnType<typeof useNavigate>;
  /** The "deleted — undo" toast. */
  deleted: ReturnType<typeof useDeletedToast>;
  qc: ReturnType<typeof useQueryClient>;
};

/**
 * s4f-side: rows are memoised and get only their own data as props. What they do on a click (rename, star, open a
 * dialog) reads the latest tree context from `LatestCtx` (a ref, set after each commit); an open ⋯ menu reads the
 * live one (`LiveCtx`) — only open menus re-render with the tree, never the rows.
 */
const LatestCtx = createContext<{ current: TreeCtx | null }>({ current: null });
const LiveCtx = createContext<TreeCtx | null>(null);

/** What a board / doc / dashboard row is given — its own state only, so it renders again only when that changes. */
type RowProps = {
  accountId: string;
  accountSlug: string;
  workspaceId: string;
  /** 2 px above it: it is not the first thing in its folder (or the root). */
  gap: boolean;
  /** It is open (the route). */
  current: boolean;
  favorite: boolean;
  favLoaded: boolean;
  /** Where a dragged row would land next to it (the line), if over it. */
  line: DropSide | null;
  renaming: boolean;
  page: boolean;
};

/**
 * The lines in view (`indices` into `flat`) nested the way the tree is: each folder a block of its header and its
 * children (indented, with the guide line), the rows without a folder in the root zone. A folder whose header is
 * above the window still wraps its rows in view (no header), so they keep their indent.
 */
const treeLines = (
  flat: FlatItem[],
  indices: number[],
  render: (it: FlatItem, gap: boolean) => ReactNode,
): ReactNode[] => {
  type Frame = { id: string; header: ReactNode; open: boolean; gap: boolean; depth: number; kids: ReactNode[] };
  const top: ReactNode[] = [];
  let root: ReactNode[] = [];
  const stack: Frame[] = [];
  let rootGap = false;
  // folders may stand between the rows without a folder — each run of them is a root zone of its own.
  let zones = 0;
  const flushRoot = () => {
    if (!root.length) return;
    const id = zones ? `${ROOT}:${zones}` : ROOT;
    zones++;
    top.push(
      <RootZone key={id} id={id} gap={rootGap}>
        {root}
      </RootZone>,
    );
    root = [];
  };
  const close = () => {
    const f = stack.pop()!;
    (stack.at(-1)?.kids ?? top).push(
      <div key={f.id} className={f.gap ? 'mt-0.5' : undefined}>
        {f.header}
        {f.open ? (
          // Inside a folder (fix3): indented like sub-items, with a guide line under the folder's chevron.
          <div
            className="ms-[0.9375rem] border-s border-line ps-2.5"
            data-testid="folder-children"
            data-depth={f.depth + 1}
          >
            {f.kids}
          </div>
        ) : null}
      </div>,
    );
  };
  for (const i of indices) {
    const it = flat[i];
    if (!it) continue;
    if (inRootZone(it)) {
      while (stack.length) close();
      // The space above a root zone is the zone's own (its highlight starts at its first row).
      const first = !root.length;
      if (first) rootGap = it.gap;
      root.push(render(it, first ? false : it.gap));
      continue;
    }
    flushRoot();
    let keep = 0;
    while (keep < stack.length && keep < it.parents.length && stack[keep]!.id === it.parents[keep]) keep++;
    while (stack.length > keep) close();
    for (let d = stack.length; d < it.parents.length; d++)
      stack.push({ id: it.parents[d]!, header: null, open: true, gap: false, depth: d, kids: [] });
    if (it.kind === 'folder')
      stack.push({ id: it.key, header: render(it, false), open: !it.closed, gap: it.gap, depth: it.depth, kids: [] });
    else (stack.at(-1)?.kids ?? top).push(render(it, it.gap));
  }
  while (stack.length) close();
  flushRoot();
  return top;
};

/** Drop target for "no folder" (the rows without a folder; the hint while a row from a folder is dragged). */
const RootZone = ({ id, gap, children }: { id: string; gap: boolean; children: ReactNode }) => {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      className={cn(
        'rounded-[var(--radius-sm)]',
        gap && 'mt-0.5',
        isOver && 'bg-primary-soft ring-1 ring-[var(--primary)]',
      )}
    >
      {children}
    </div>
  );
};

/**
 * "העברה למרחב עבודה…" (fix8): a submenu of the other workspaces (the menu adds a search when they are many).
 * Out of a closed workspace into an open one asks first — a main board becomes visible to the whole account
 * (private and shareable boards keep their own subscribers either way).
 */
const moveToWorkspaceEntry = (
  ctx: TreeCtx,
  what: { kind: 'board' | 'folder' | 'doc' | 'dashboard'; id: string; name: string },
): MenuEntry[] => {
  const others = ctx.workspaces.filter((w) => w.id !== ctx.data.workspace.id);
  if (!others.length) return [];
  const move = async (to: Workspace) => {
    if (ctx.data.workspace.kind === 'closed' && to.kind === 'open') {
      const ok = await confirmDialog({
        title: t('sidebar.moveToWorkspace.confirmTitle', { what: what.name, to: to.name }),
        message: t('sidebar.moveToWorkspace.openWarning'),
        confirmLabel: t('sidebar.moveToWorkspace.confirm'),
      });
      if (!ok) return;
    }
    ctx.mut.moveToWorkspace.mutate({ ...what, to });
  };
  return [
    {
      kind: 'submenu',
      label: t('sidebar.moveToWorkspace'),
      icon: <Icon name="move" size={16} />,
      testId: `${what.kind}-menu-move-workspace`,
      items: others.map((w) => ({
        label: w.name,
        testId: 'move-workspace-option',
        onSelect: () => void move(w),
      })),
    },
  ];
};

/**
 * "Move to" (a folder): the root first, then every folder with its parents (e.g. "01 · מכירות / ארכיון"), sorted.
 * Built only while a ⋯ menu is open.
 */
const folderDestinations = (
  folders: TreeFolder[],
  at: string | null,
  moveTo: (folderId: string | null) => void,
): MenuEntry[] => {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const pathOf = (f: TreeFolder): string => {
    const parent = f.parent_folder_id ? byId.get(f.parent_folder_id) : undefined;
    return parent ? `${pathOf(parent)} / ${f.name}` : f.name;
  };
  return [
    { label: t('sidebar.root'), checked: !at, onSelect: () => moveTo(null) },
    ...folders
      .map((f) => ({ f, path: pathOf(f) }))
      .sort((a, b) => a.path.localeCompare(b.path))
      .map(({ f, path }) => ({ label: path, checked: at === f.id, onSelect: () => moveTo(f.id) })),
  ];
};

/** "Move to workspace" right after "move to" (folder) when there is one, else at the end. */
const withWorkspaceMove = (actions: MenuEntry[], destinations: MenuEntry[], moveItems: MenuEntry[]) => {
  if (!moveItems.length) return actions;
  const at = actions.findIndex((e) => e.kind === 'submenu' && e.items === destinations);
  return at >= 0 ? [...actions.slice(0, at + 1), ...moveItems, ...actions.slice(at + 1)] : [...actions, ...moveItems];
};

type MenuAt = NonNullable<ReturnType<typeof useActionMenu>['at']>;

const DropLine = ({ side }: { side: DropSide }) => (
  <span
    aria-hidden
    data-testid="board-drop-indicator"
    data-side={side}
    className={cn(
      'pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-accent',
      side === 'before' ? '-top-px' : '-bottom-px',
    )}
  />
);

const rowClass = (page: boolean, current: boolean, gap: boolean, isDragging: boolean) =>
  cn(
    'group relative flex items-center rounded-[10px] pe-1 hover:bg-surface-2',
    gap && 'mt-0.5',
    current &&
      (page
        ? 'bg-primary-soft hover:bg-primary-soft'
        : 'bg-[var(--shell-active)] text-shell-strong hover:bg-[var(--shell-active)]'),
    isDragging && 'opacity-40',
  );

const rowLinkClass = (page: boolean, current: boolean) =>
  cn(
    'flex min-w-0 flex-1 items-center gap-2 px-2.5',
    page ? 'h-11 text-[0.9375rem]' : 'h-[1.875rem] text-sm',
    current && (page ? 'font-semibold' : 'font-semibold text-shell-strong'),
  );

/** A folder's header row (its block — the header and its children — is built by `treeLines`). */
const FolderNode = memo(function FolderNode({
  folder,
  depth,
  closed,
  renaming,
  page,
  canCreate,
  otherWorkspaces,
  line,
}: {
  folder: TreeFolder;
  depth: number;
  closed: boolean;
  renaming: boolean;
  page: boolean;
  /** I may create in this workspace. */
  canCreate: boolean;
  /** I see another workspace (the "move to workspace" entry). */
  otherWorkspaces: boolean;
  /** Something dragged would land before it (its upper third); else over it = into it. */
  line: DropSide | null;
}) {
  const latest = useContext(LatestCtx);
  const menu = useActionMenu();
  const { setNodeRef, isOver } = useDroppable({ id: folder.id });
  // a folder is dragged like a board — by its header — with all that is in it.
  const drag = useDraggable({ id: folder.id, disabled: !folder.can_edit });
  const hasMenu =
    folderMenu({ canCreate, canEdit: folder.can_edit, canNest: depth < MAX_FOLDER_DEPTH }).length > 0 ||
    (folder.can_edit && canCreate && otherWorkspaces);
  return (
    <>
      <div
        ref={(el) => {
          setNodeRef(el);
          drag.setNodeRef(el);
        }}
        onContextMenu={hasMenu ? menu.onContextMenu : undefined}
        onKeyDown={hasMenu ? menu.onKeyDown : undefined}
        className={cn(
          'group relative flex items-center gap-1 rounded-[10px] pe-1 hover:bg-surface-2',
          isOver && !line && 'bg-primary-soft ring-1 ring-[var(--primary)]',
          drag.isDragging && 'opacity-40',
        )}
        data-testid="folder-row"
        data-name={folder.name}
        data-folder-id={folder.id}
      >
        {line ? <DropLine side={line} /> : null}
        {renaming ? (
          <RenameInput
            initial={folder.name}
            onDone={(name) => {
              const ctx = latest.current;
              if (!ctx) return;
              ctx.setRenaming(null);
              if (name) ctx.mut.renameFolder.mutate({ id: folder.id, name });
            }}
          />
        ) : (
          <button
            type="button"
            {...drag.attributes}
            {...drag.listeners}
            // Still a working toggle when it may not move (dnd-kit sets "disabled" when drag is off).
            aria-disabled={undefined}
            onClick={() => latest.current?.toggleFolder(folder.id)}
            className={cn(
              'flex min-w-0 flex-1 items-center gap-2 px-2.5 text-start',
              page ? 'h-11 text-[0.9375rem]' : 'h-[1.875rem] text-sm',
            )}
            aria-expanded={!closed}
          >
            <svg
              width="11"
              height="11"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.6"
              aria-hidden
              className="shrink-0 text-muted"
            >
              <path d={closed ? 'M15 6l-6 6 6 6' : 'M6 9l6 6 6-6'} strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <FolderIcon />
            <span className="truncate">{folder.name}</span>
          </button>
        )}
        {hasMenu ? (
          <MenuTrigger label={t('sidebar.actionsFor', { name: folder.name })} onClick={menu.fromTrigger} />
        ) : null}
      </div>
      {menu.at ? <FolderMenu folder={folder} depth={depth} at={menu.at} onClose={menu.close} /> : null}
    </>
  );
});

const FolderMenu = ({
  folder,
  depth,
  at,
  onClose,
}: {
  folder: TreeFolder;
  depth: number;
  at: MenuAt;
  onClose: () => void;
}) => {
  const ctx = useContext(LiveCtx);
  if (!ctx) return null;
  const { data, mut } = ctx;
  const folderItems = toMenuEntries(
    folderMenu({
      canCreate: data.workspace.can_create,
      canEdit: folder.can_edit,
      canNest: depth < MAX_FOLDER_DEPTH,
    }),
    {
      new_board: () => ctx.setNewBoardIn(folder.id),
      new_doc: () => ctx.newDoc(folder.id),
      new_dashboard: () => ctx.newDashboard(folder.id),
      new_subfolder: () => void ctx.newFolder(folder.id),
      rename: () => ctx.setRenaming(folder.id),
      delete: () => {
        // with boards inside (sub-folders too), the person chooses — to the root (default) or to
        // trash with the folder; restoring the folder brings them back either way.
        const ids = [folder.id];
        for (let i = 0; i < ids.length; i++)
          ids.push(...data.folders.filter((f) => f.parent_folder_id === ids[i]).map((f) => f.id));
        const boards = data.boards.filter((b) => b.folder_id && ids.includes(b.folder_id)).length;
        if (!boards) {
          void confirmDialog({
            title: t('dialog.delete.title', { what: folder.name }),
            message: t('sidebar.deleteFolder.message'),
            danger: true,
          }).then((ok) => ok && mut.deleteFolder.mutate({ id: folder.id, name: folder.name }));
          return;
        }
        void choiceDialog({
          title: t('dialog.delete.title', { what: folder.name }),
          message:
            boards === 1
              ? t('sidebar.deleteFolder.withBoards.one')
              : t('sidebar.deleteFolder.withBoards', { count: boards }),
          danger: true,
          options: [
            {
              value: 'root',
              label: t('sidebar.deleteFolder.toRoot'),
              hint: t('sidebar.deleteFolder.toRootHint'),
              testId: 'folder-delete-root',
            },
            {
              value: 'trash',
              label: t('sidebar.deleteFolder.withFolder'),
              hint: t('sidebar.deleteFolder.withFolderHint'),
              testId: 'folder-delete-trash',
            },
          ],
        }).then(
          (choice) =>
            choice && mut.deleteFolder.mutate({ id: folder.id, name: folder.name, boards: choice as 'root' | 'trash' }),
        );
      },
    },
    {},
    ctx.gates,
  );
  const moveItems =
    folder.can_edit && data.workspace.can_create
      ? moveToWorkspaceEntry(ctx, { kind: 'folder', id: folder.id, name: folder.name })
      : [];
  const items: MenuEntry[] = [
    ...(moveItems.length
      ? [...folderItems, ...(folderItems.length ? [{ kind: 'separator' as const }] : []), ...moveItems]
      : folderItems),
    ...(folderItems.length ? planUpgradeMenuEntries(Object.values(ctx.gates), ctx.goUpgrade) : []),
  ];
  return <Menu at={at} onClose={onClose} items={items} label={t('sidebar.actionsFor', { name: folder.name })} />;
};

const BoardNode = memo(function BoardNode({
  board,
  accountId,
  accountSlug,
  workspaceId,
  gap,
  current,
  favorite,
  favLoaded,
  line,
  renaming,
  page,
}: RowProps & { board: TreeBoard }) {
  const latest = useContext(LatestCtx);
  const [copying, setCopying] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const menu = useActionMenu();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: board.id,
    disabled: !board.can_update,
  });
  // Also a drop target: another board lands before / after it (fix3).
  const drop = useDroppable({ id: `${BOARD_DROP}${board.id}` });

  if (renaming) {
    return (
      <RenameInput
        className={gap ? 'mt-0.5' : undefined}
        initial={board.name}
        onDone={(name) => {
          const ctx = latest.current;
          if (!ctx) return;
          ctx.setRenaming(null);
          if (name) ctx.mut.updateBoard.mutate({ id: board.id, name });
        }}
      />
    );
  }
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        drop.setNodeRef(el);
      }}
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
      className={rowClass(page, current, gap, isDragging)}
      data-testid="board-row"
      data-name={board.name}
    >
      {line ? <DropLine side={line} /> : null}
      <Link
        to="/a/$accountSlug/b/$boardId"
        params={{ accountSlug, boardId: board.id }}
        {...attributes}
        {...listeners}
        // A board I may not move is still a working link — not "disabled" (dnd-kit sets it when drag is off).
        aria-disabled={undefined}
        role="link"
        data-testid={page ? 'boards-page-board' : undefined}
        className={rowLinkClass(page, current)}
      >
        <BoardIcon />
        <span className="truncate">{board.name}</span>
        <ShareableMark kind={board.kind} />
      </Link>
      {copying ? (
        <DuplicateBoardDialog
          accountId={accountId}
          accountSlug={accountSlug}
          board={board}
          onClose={() => setCopying(false)}
        />
      ) : null}
      {savingTemplate ? (
        <SaveTemplateDialog accountId={accountId} board={board} onClose={() => setSavingTemplate(false)} />
      ) : null}
      <FavoriteToggle
        name={board.name}
        on={favorite}
        loaded={favLoaded}
        onToggle={() => latest.current?.favorites.toggle({ id: board.id, name: board.name, workspace_id: workspaceId })}
        page={page}
      />
      <MenuTrigger label={t('sidebar.actionsFor', { name: board.name })} onClick={menu.fromTrigger} />
      {menu.at ? (
        <BoardMenu
          board={board}
          at={menu.at}
          onClose={menu.close}
          onCopy={() => setCopying(true)}
          onSaveTemplate={() => setSavingTemplate(true)}
        />
      ) : null}
    </div>
  );
});

/** A board's ⋯ menu — built only while it is open, from the live tree. */
const BoardMenu = ({
  board,
  at,
  onClose,
  onCopy,
  onSaveTemplate,
}: {
  board: TreeBoard;
  at: MenuAt;
  onClose: () => void;
  onCopy: () => void;
  onSaveTemplate: () => void;
}) => {
  const ctx = useContext(LiveCtx);
  if (!ctx) return null;
  const { account, data, mut } = ctx;
  const path = `/a/${account.slug}/b/${board.id}`;
  const moveTo = (folderId: string | null) => {
    if (folderId !== board.folder_id) mut.updateBoard.mutate({ id: board.id, folder_id: folderId });
  };
  const leaveIfOpen = () => {
    if (ctx.current.boardId === board.id)
      void ctx.navigate({ to: '/a/$accountSlug', params: { accountSlug: account.slug } });
  };
  const destinations = folderDestinations(data.folders, board.folder_id, moveTo);
  const favorite = ctx.favorites.isFavorite(board.id);
  // First in the ⋯ menu: add to / remove from favourites (every board I see — it is personal).
  const favoriteEntry: MenuEntry[] = [
    {
      label: t((favorite ? 'sidebar.unfavorite' : 'sidebar.favorite') as MessageKey),
      icon: <StarIcon on={favorite} size={16} />,
      disabled: !ctx.favorites.loaded,
      testId: 'board-menu-favorite',
      onSelect: () => ctx.favorites.toggle({ id: board.id, name: board.name, workspace_id: data.workspace.id }),
    },
    { kind: 'separator' },
  ];
  const actions = toMenuEntries(
    sidebarBoardMenu({
      canUpdate: board.can_update,
      canDelete: board.can_delete,
      canCreate: data.workspace.can_create,
    }),
    {
      open_new_tab: () => window.open(appLink(path), '_blank', 'noopener'),
      copy_link: () => copyText(appLink(path)),
      copy_id: () => copyText(board.id),
      rename: () => ctx.setRenaming(board.id),
      duplicate: onCopy,
      save_as_template: onSaveTemplate,
      archive: () => mut.archiveBoard.mutate({ id: board.id, name: board.name }, { onSuccess: leaveIfOpen }),
      delete: () =>
        void confirmDelete(board.name).then((ok) => {
          if (!ok) return;
          mut.deleteBoard.mutate({ id: board.id, name: board.name }, { onSuccess: leaveIfOpen });
        }),
    },
    { move_to: destinations },
  );
  const moveItems =
    board.can_delete && data.workspace.can_create
      ? moveToWorkspaceEntry(ctx, { kind: 'board', id: board.id, name: board.name })
      : [];
  const items = [...favoriteEntry, ...withWorkspaceMove(actions, destinations, moveItems)];
  return <Menu at={at} onClose={onClose} items={items} label={t('sidebar.actionsFor', { name: board.name })} />;
};

/**
 * A doc in the tree (M8 ד1): opens the doc page; dragged like a board (onto folders, the root, before / after any
 * row); its ⋯ menu — favourite, open in a new tab, copy link / id, rename, move to a folder or a workspace,
 * duplicate, delete (to trash, with undo).
 */
const DocNode = memo(function DocNode({
  doc,
  accountSlug,
  workspaceId,
  gap,
  current,
  favorite,
  favLoaded,
  line,
  renaming,
  page,
}: RowProps & { doc: WorkspaceEntity }) {
  const latest = useContext(LatestCtx);
  const menu = useActionMenu();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: doc.id, disabled: !doc.can_update });
  const drop = useDroppable({ id: `${BOARD_DROP}${doc.id}` });

  if (renaming) {
    return (
      <RenameInput
        className={gap ? 'mt-0.5' : undefined}
        initial={doc.name}
        onDone={(name) => {
          const ctx = latest.current;
          if (!ctx) return;
          ctx.setRenaming(null);
          if (!name) return;
          patchTreeRow(ctx.qc, ctx.account.id, doc.id, { name });
          ctx.docMut.update.mutate({ id: doc.id, name }, { onError: () => void reloadTrees(ctx.qc, ctx.account.id) });
        }}
      />
    );
  }
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        drop.setNodeRef(el);
      }}
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
      className={rowClass(page, current, gap, isDragging)}
      data-testid="doc-row"
      data-name={doc.name}
    >
      {line ? <DropLine side={line} /> : null}
      <Link
        to="/a/$accountSlug/d/$docId"
        params={{ accountSlug, docId: doc.id }}
        {...attributes}
        {...listeners}
        aria-disabled={undefined}
        role="link"
        data-testid={page ? 'boards-page-doc' : undefined}
        className={rowLinkClass(page, current)}
      >
        {doc.icon ? (
          <span aria-hidden className="w-[0.9375rem] shrink-0 text-center text-[0.8125rem] leading-none">
            {doc.icon}
          </span>
        ) : (
          <DocIcon />
        )}
        <span className="truncate">{doc.name}</span>
        <ShareableMark kind={doc.kind} />
        {doc.open_threads ? (
          <span
            className="ms-auto shrink-0 rounded-full bg-accent px-1.5 text-[0.6875rem] leading-4 font-bold text-on-accent"
            data-testid="doc-row-comments"
            title={t('docs2.comments')}
          >
            {doc.open_threads}
          </span>
        ) : null}
      </Link>
      <FavoriteToggle
        name={doc.name}
        on={favorite}
        loaded={favLoaded}
        onToggle={() => latest.current?.docFavorites.toggle({ id: doc.id, name: doc.name, workspace_id: workspaceId })}
        page={page}
        testId="doc-favorite-toggle"
      />
      <MenuTrigger label={t('sidebar.actionsFor', { name: doc.name })} onClick={menu.fromTrigger} />
      {menu.at ? <DocMenu doc={doc} at={menu.at} onClose={menu.close} /> : null}
    </div>
  );
});

/** A doc's ⋯ menu — built only while it is open, from the live tree. */
const DocMenu = ({ doc, at, onClose }: { doc: WorkspaceEntity; at: MenuAt; onClose: () => void }) => {
  const ctx = useContext(LiveCtx);
  if (!ctx) return null;
  const { account, data, docMut } = ctx;
  const path = `/a/${account.slug}/d/${doc.id}`;
  const leaveIfOpen = () => {
    if (ctx.current.docId === doc.id)
      void ctx.navigate({ to: '/a/$accountSlug', params: { accountSlug: account.slug } });
  };
  const moveTo = (folderId: string | null) => {
    if (folderId !== doc.folder_id) docMut.update.mutate({ id: doc.id, folder_id: folderId });
  };
  const destinations = folderDestinations(data.folders, doc.folder_id, moveTo);
  const actions = toMenuEntries(
    sidebarDocMenu({ canUpdate: doc.can_update, canDelete: doc.can_delete, canCreate: data.workspace.can_create }),
    {
      open_new_tab: () => window.open(appLink(path), '_blank', 'noopener'),
      copy_link: () => copyText(appLink(path)),
      copy_id: () => copyText(doc.id),
      rename: () => ctx.setRenaming(doc.id),
      duplicate: () =>
        docMut.duplicate.mutate(
          { id: doc.id },
          {
            onSuccess: (copy) =>
              void ctx.navigate({
                to: '/a/$accountSlug/d/$docId',
                params: { accountSlug: account.slug, docId: copy.id },
              }),
          },
        ),
      delete: () =>
        void confirmDelete(doc.name).then(
          (ok) =>
            ok &&
            docMut.remove.mutate(
              { id: doc.id, name: doc.name },
              {
                onSuccess: (res) => {
                  ctx.deleted(doc.name, res);
                  leaveIfOpen();
                },
              },
            ),
        ),
    },
    { move_to: destinations },
  );
  const moveItems =
    doc.can_delete && data.workspace.can_create
      ? moveToWorkspaceEntry(ctx, { kind: 'doc', id: doc.id, name: doc.name })
      : [];
  const favorite = ctx.docFavorites.isFavorite(doc.id);
  const items: MenuEntry[] = [
    {
      label: t((favorite ? 'sidebar.unfavorite' : 'sidebar.favorite') as MessageKey),
      icon: <StarIcon on={favorite} size={16} />,
      disabled: !ctx.docFavorites.loaded,
      testId: 'doc-row-menu-favorite',
      onSelect: () => ctx.docFavorites.toggle({ id: doc.id, name: doc.name, workspace_id: data.workspace.id }),
    },
    { kind: 'separator' },
    ...withWorkspaceMove(actions, destinations, moveItems),
  ];
  return <Menu at={at} onClose={onClose} items={items} label={t('sidebar.actionsFor', { name: doc.name })} />;
};

/**
 * A dashboard in the tree (M8 ד4): opens the dashboard page; dragged like a doc (onto folders, the root, before /
 * after any row); its ⋯ menu — open in a new tab, copy link / id, rename, move to a folder or a workspace,
 * duplicate, delete (to trash, with undo).
 */
const DashboardNode = memo(function DashboardNode({
  dashboard,
  accountSlug,
  workspaceId,
  gap,
  current,
  favorite,
  favLoaded,
  line,
  renaming,
  page,
}: RowProps & { dashboard: WorkspaceEntity }) {
  const latest = useContext(LatestCtx);
  const menu = useActionMenu();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dashboard.id,
    disabled: !dashboard.can_update,
  });
  const drop = useDroppable({ id: `${BOARD_DROP}${dashboard.id}` });

  if (renaming) {
    return (
      <RenameInput
        className={gap ? 'mt-0.5' : undefined}
        initial={dashboard.name}
        onDone={(name) => {
          const ctx = latest.current;
          if (!ctx) return;
          ctx.setRenaming(null);
          if (!name) return;
          patchTreeRow(ctx.qc, ctx.account.id, dashboard.id, { name });
          ctx.dashMut.update.mutate(
            { id: dashboard.id, name },
            { onError: () => void reloadTrees(ctx.qc, ctx.account.id) },
          );
        }}
      />
    );
  }
  return (
    <div
      ref={(el) => {
        setNodeRef(el);
        drop.setNodeRef(el);
      }}
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
      className={rowClass(page, current, gap, isDragging)}
      data-testid="dashboard-row"
      data-name={dashboard.name}
    >
      {line ? <DropLine side={line} /> : null}
      <Link
        to="/a/$accountSlug/dash/$dashboardId"
        params={{ accountSlug, dashboardId: dashboard.id }}
        {...attributes}
        {...listeners}
        aria-disabled={undefined}
        role="link"
        data-testid={page ? 'boards-page-dashboard' : undefined}
        className={rowLinkClass(page, current)}
      >
        <DashboardGlyph />
        <span className="truncate">{dashboard.name}</span>
        <ShareableMark kind={dashboard.kind} />
      </Link>
      <FavoriteToggle
        name={dashboard.name}
        on={favorite}
        loaded={favLoaded}
        onToggle={() =>
          latest.current?.dashFavorites.toggle({ id: dashboard.id, name: dashboard.name, workspace_id: workspaceId })
        }
        page={page}
        testId="dashboard-favorite-toggle"
      />
      <MenuTrigger label={t('sidebar.actionsFor', { name: dashboard.name })} onClick={menu.fromTrigger} />
      {menu.at ? <DashboardMenu dashboard={dashboard} at={menu.at} onClose={menu.close} /> : null}
    </div>
  );
});

/** A dashboard's ⋯ menu — built only while it is open, from the live tree. */
const DashboardMenu = ({ dashboard, at, onClose }: { dashboard: WorkspaceEntity; at: MenuAt; onClose: () => void }) => {
  const ctx = useContext(LiveCtx);
  if (!ctx) return null;
  const { account, data, dashMut } = ctx;
  const path = `/a/${account.slug}/dash/${dashboard.id}`;
  const current = ctx.current.dashboardId === dashboard.id;
  const open = (id: string) =>
    void ctx.navigate({
      to: '/a/$accountSlug/dash/$dashboardId',
      params: { accountSlug: account.slug, dashboardId: id },
    });
  // A guest's ⋯ (round 16): favourite, open in a new tab and copy link only — rename / move / duplicate / delete
  // follow can_update / can_delete (false for guests), and the id is for the API, which guests do not use.
  const guest = account.role === 'guest';
  const moveTo = (folderId: string | null) => {
    if (folderId !== dashboard.folder_id) dashMut.update.mutate({ id: dashboard.id, folder_id: folderId });
  };
  const destinations = folderDestinations(data.folders, dashboard.folder_id, moveTo);
  const actions = toMenuEntries(
    sidebarDashboardMenu({
      canUpdate: dashboard.can_update,
      canDelete: dashboard.can_delete,
      canCreate: data.workspace.can_create && !guest,
    }).filter((n) => !(guest && n.kind === 'action' && n.id === 'copy_id')),
    {
      open_new_tab: () => window.open(appLink(path), '_blank', 'noopener'),
      copy_link: () => copyText(appLink(path)),
      copy_id: () => copyText(dashboard.id),
      rename: () => ctx.setRenaming(dashboard.id),
      duplicate: () => dashMut.duplicate.mutate({ id: dashboard.id }, { onSuccess: (copy) => open(copy.id) }),
      delete: () =>
        void confirmDelete(dashboard.name).then(
          (ok) =>
            ok &&
            dashMut.remove.mutate(
              { id: dashboard.id, name: dashboard.name },
              {
                onSuccess: (res) => {
                  ctx.deleted(dashboard.name, res);
                  if (current) void ctx.navigate({ to: '/a/$accountSlug', params: { accountSlug: account.slug } });
                },
              },
            ),
        ),
    },
    { move_to: destinations },
  );
  const moveItems =
    dashboard.can_delete && data.workspace.can_create
      ? moveToWorkspaceEntry(ctx, { kind: 'dashboard', id: dashboard.id, name: dashboard.name })
      : [];
  // First in the ⋯ menu (Fix: ): add to / remove from favourites, like boards and docs.
  const favorite = ctx.dashFavorites.isFavorite(dashboard.id);
  const items: MenuEntry[] = [
    {
      label: t((favorite ? 'sidebar.unfavorite' : 'sidebar.favorite') as MessageKey),
      icon: <StarIcon on={favorite} size={16} />,
      disabled: !ctx.dashFavorites.loaded,
      testId: 'dashboard-menu-favorite',
      onSelect: () =>
        ctx.dashFavorites.toggle({ id: dashboard.id, name: dashboard.name, workspace_id: data.workspace.id }),
    },
    { kind: 'separator' },
    ...withWorkspaceMove(actions, destinations, moveItems),
  ];
  return <Menu at={at} onClose={onClose} items={items} label={t('sidebar.actionsFor', { name: dashboard.name })} />;
};
