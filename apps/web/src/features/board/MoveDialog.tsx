// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ColumnMapping,
  columnCopyFor,
  columnTypes,
  effectiveDepthMax,
  mappingCandidates,
  normalizeTitle,
  proposeMapping,
  t,
} from '@bines/shared';
import { Button, cn, Dialog, Field, Input, type MenuEntry } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { columnTypeLabel } from '../../lib/locale';
import { showToast } from '../../lib/toast';
import {
  type BoardDetail,
  boardKeys,
  type Column,
  type Item,
  useBoard,
  useItems,
  useTree,
  useWorkspaces,
} from './board-api';
import { PickerButton } from './toolbar/parts';
import { SearchClear } from '../../lib/search-clear';

/** Columns whose values live in cells — the ones a move maps (the name moves with the item itself). */
const movable = (columns: Column[]) =>
  columns.filter((c) => c.type !== 'name' && columnTypes.get(c.type)?.storage === 'cell');
const proposal = (sources: Column[], targets: Column[]) =>
  proposeMapping(
    sources.map((c) => ({ id: c.id, type: c.type, title: c.title })),
    targets.map((c) => ({ id: c.id, type: c.type, title: c.title })),
  );

/**
 * "+ New column" choices of the mapping (fix3): source column ids that get a new column of the same type and
 * settings on the target, created on confirm (POST /boards/:id/columns — needs `column.create` there).
 */
const useNewColumns = (accountId: string, sources: Column[]) => {
  const qc = useQueryClient();
  const [fresh, setFresh] = useState<ReadonlySet<string>>(() => new Set());
  const set = (sourceId: string, on: boolean) =>
    setFresh((prev) => {
      const next = new Set(prev);
      if (on) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
  /** Creates the chosen columns on `target` (in source order); `onMade` gets each one as it is made. */
  const create = async (target: BoardDetail, onMade: (sourceId: string, columnId: string) => void) => {
    const chosen = sources.filter((s) => fresh.has(s.id));
    if (!chosen.length) return;
    const client = api(accountId);
    try {
      for (const s of chosen) {
        const col = await client.post<Column>(`/boards/${target.id}/columns`, {
          ...columnCopyFor(s),
          width: Math.min(800, Math.max(60, Math.round(s.width))),
        });
        onMade(s.id, col.id);
        set(s.id, false);
      }
    } finally {
      await qc.invalidateQueries({ queryKey: boardKeys.board(accountId, target.id) });
    }
  };
  return { fresh, set, create, clear: () => setFresh(new Set()) };
};

/** Why "+ New column" is off on a target board, or null when the user may add columns there. */
const newColumnBlock = (target: BoardDetail | undefined) =>
  target && !target.capabilities['column.create'] ? t('move.newColumn.denied') : null;

/**
 * The mapping table (07 §3.4.1): every source column → a target column of the same type, "+ new column" (fix3),
 * or "don't move" (red: its values stay behind; undo brings them back). Pre-filled by type + title.
 */
const MappingTable = ({
  sources,
  targets,
  mapping,
  onChange,
  fresh,
  onFresh,
  blocked,
}: {
  sources: Column[];
  targets: Column[];
  mapping: ColumnMapping;
  onChange: (next: ColumnMapping) => void;
  fresh: ReadonlySet<string>;
  onFresh: (sourceId: string, on: boolean) => void;
  /** Why "+ New column" is off (no `column.create` on the target), or null. */
  blocked: string | null;
}) => {
  if (!sources.length) return <p className="text-sm text-muted">{t('move.noColumns')}</p>;
  return (
    <div className="space-y-1.5" data-testid="mapping-table">
      {sources.map((s) => {
        const isNew = fresh.has(s.id);
        const chosen = isNew ? undefined : targets.find((c) => c.id === mapping[s.id]);
        // A same-type column with the same title already exists → no "+ new" (it would be a duplicate).
        const twin = targets.some((c) => c.type === s.type && normalizeTitle(c.title) === normalizeTitle(s.title));
        const newLabel = t('move.newColumn', { title: s.title, type: columnTypeLabel(s.type) });
        const pick = (id: string | null) => {
          onFresh(s.id, false);
          onChange({ ...mapping, [s.id]: id });
        };
        const newEntries: MenuEntry[] = twin
          ? []
          : [
              { kind: 'separator' },
              {
                label: newLabel,
                testId: 'mapping-new-option',
                disabled: !!blocked,
                checked: isNew,
                onSelect: () => {
                  onFresh(s.id, true);
                  onChange({ ...mapping, [s.id]: null });
                },
              },
              ...(blocked ? [{ kind: 'label' as const, label: blocked }] : []),
            ];
        return (
          <div
            key={s.id}
            className="grid grid-cols-[1fr_auto_1fr] items-center gap-2"
            data-testid="mapping-row"
            data-source={s.title}
          >
            <span className="truncate text-sm">{s.title}</span>
            <span aria-hidden className="text-muted rtl:-scale-x-100">
              →
            </span>
            <div className="flex items-center gap-2">
              <PickerButton
                className="min-w-0 flex-1"
                menuLabel={s.title}
                placeholder={t('move.dontMove')}
                label={isNew ? newLabel : chosen?.title}
                items={[
                  ...mappingCandidates({ id: s.id, type: s.type, title: s.title }, targets).map((c) => ({
                    label: c.type === s.type ? c.title : `${c.title} · ${t('move.converted')}`,
                    keywords: columnTypeLabel(c.type),
                    checked: !isNew && c.id === mapping[s.id],
                    onSelect: () => pick(c.id),
                  })),
                  ...newEntries,
                  { kind: 'separator' as const },
                  { label: t('move.dontMove'), danger: true, onSelect: () => pick(null) },
                ]}
              />
              {isNew ? (
                <span className="shrink-0 text-xs font-medium text-accent-fg" data-testid="mapping-new">
                  {t('move.newColumn.tag')}
                </span>
              ) : chosen ? (
                chosen.type !== s.type ? (
                  <span className="shrink-0 text-xs text-muted" data-testid="mapping-converted">
                    {t('move.converted')}
                  </span>
                ) : null
              ) : (
                <span className="shrink-0 text-xs text-[var(--danger)]">{t('move.willBeLost')}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};

/** The last mapping per pair of boards — personal, in this browser (07 §3.4.1 "remember the mapping"). */
const mappingKey = (from: string, to: string) => `bos:move-map:${from}:${to}`;
const readMapping = (from: string, to: string): ColumnMapping | null => {
  try {
    const raw = localStorage.getItem(mappingKey(from, to));
    return raw ? (JSON.parse(raw) as ColumnMapping) : null;
  } catch {
    return null;
  }
};
const saveMapping = (from: string, to: string, mapping: ColumnMapping) => {
  try {
    localStorage.setItem(mappingKey(from, to), JSON.stringify(mapping));
  } catch {
    // storage blocked: the next move proposes again
  }
};

const unmappedCount = (sources: Column[], mapping: ColumnMapping, fresh: ReadonlySet<string>) =>
  sources.filter((s) => !mapping[s.id] && !fresh.has(s.id)).length;

/**
 * "Move to another board" (07 §3.4): workspace → board → group → mapping → move. For one item, a group
 * (`withGroup = false`: the group comes as a whole) or the batch selection.
 */
export const MoveDialog = ({
  accountId,
  board,
  title,
  withGroup = true,
  onClose,
  onMove,
}: {
  accountId: string;
  board: BoardDetail;
  title: string;
  withGroup?: boolean;
  onClose: () => void;
  onMove: (v: { board: BoardDetail; groupId?: string; mapping: ColumnMapping }) => Promise<unknown>;
}) => {
  const workspaces = useWorkspaces(accountId).data?.data ?? [];
  const [wsId, setWsId] = useState<string | undefined>(board.workspace_id);
  const tree = useTree(accountId, wsId).data;
  const [targetId, setTargetId] = useState('');
  const target = useBoard(accountId, targetId).data;
  const [groupId, setGroupId] = useState<string | undefined>(undefined);
  const [edited, setEdited] = useState<ColumnMapping | null>(null);
  // The mapping used last time for this pair of boards comes back (columns since deleted are left out).
  const remembered = useMemo(() => (targetId ? readMapping(board.id, targetId) : null), [board.id, targetId]);
  const [busy, setBusy] = useState(false);
  const sources = useMemo(() => movable(board.columns), [board.columns]);
  const targets = useMemo(() => movable(target?.columns ?? []), [target]);
  const mapping = useMemo(() => {
    if (edited) return edited;
    const auto = proposal(sources, targets);
    if (!remembered) return auto;
    const valid = (k: string, v: string | null) =>
      sources.some((c) => c.id === k) && (v === null || targets.some((c) => c.id === v));
    return { ...auto, ...Object.fromEntries(Object.entries(remembered).filter(([k, v]) => valid(k, v))) };
  }, [edited, sources, targets, remembered]);
  const fresh = useNewColumns(accountId, sources);
  const lost = unmappedCount(sources, mapping, fresh.fresh);
  const boards = (tree?.boards ?? []).filter((b) => b.id !== board.id);
  const group = target?.groups.find((g) => g.id === groupId) ?? target?.groups[0];

  const submit = async () => {
    if (!target) return;
    setBusy(true);
    try {
      // New columns first; each one made is kept in the mapping, so a retry does not make it again.
      const final = { ...mapping };
      try {
        await fresh.create(target, (sourceId, columnId) => {
          final[sourceId] = columnId;
          setEdited({ ...final });
        });
      } catch (err) {
        showToast({ message: errorMessage(err), tone: 'error' });
        return;
      }
      await onMove({ board: target, groupId: withGroup ? group?.id : undefined, mapping: final });
      saveMapping(board.id, target.id, final);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      className="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="move-confirm" disabled={!target} busy={busy} onClick={() => void submit()}>
            {lost ? t('move.confirmLost', { n: lost }) : t('move.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="move-dialog">
        <div className="grid gap-3 sm:grid-cols-2">
          {workspaces.length > 1 ? (
            <Field label={t('move.workspace')}>
              <PickerButton
                menuLabel={t('move.workspace')}
                placeholder={t('move.workspace')}
                label={workspaces.find((w) => w.id === wsId)?.name}
                items={workspaces.map((w) => ({
                  label: w.name,
                  checked: w.id === wsId,
                  onSelect: () => {
                    setWsId(w.id);
                    setTargetId('');
                    setEdited(null);
                    fresh.clear();
                  },
                }))}
              />
            </Field>
          ) : null}
          <Field label={t('move.board')}>
            <PickerButton
              testId="move-board"
              menuLabel={t('move.board')}
              placeholder={t('move.pickBoard')}
              label={boards.find((b) => b.id === targetId)?.name}
              items={boards.map((b) => ({
                label: b.name,
                checked: b.id === targetId,
                onSelect: () => {
                  setTargetId(b.id);
                  setGroupId(undefined);
                  setEdited(null);
                  fresh.clear();
                },
              }))}
            />
          </Field>
          {withGroup && target ? (
            <Field label={t('move.group')}>
              <PickerButton
                testId="move-group"
                menuLabel={t('move.group')}
                placeholder={t('move.group')}
                label={group?.title}
                items={target.groups.map((g) => ({
                  label: g.title,
                  checked: g.id === group?.id,
                  onSelect: () => setGroupId(g.id),
                }))}
              />
            </Field>
          ) : null}
        </div>
        {target ? (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{t('move.mapping')}</h3>
            <p className="text-xs text-muted">{t('move.mapping.hint')}</p>
            <MappingTable
              sources={sources}
              targets={targets}
              mapping={mapping}
              onChange={setEdited}
              fresh={fresh.fresh}
              onFresh={fresh.set}
              blocked={newColumnBlock(target)}
            />
          </section>
        ) : null}
      </div>
    </Dialog>
  );
};

/**
 * Item ↔ subitem (07 §3.7). To a subitem: pick the parent among the board's items; its columns map onto the
 * sub-board's (automatic when the board has no subitems yet). To an item: pick the group.
 */
export const ConvertDialog = ({
  accountId,
  board,
  item,
  mode,
  onClose,
  onConvert,
}: {
  accountId: string;
  /** The item's own board (the board, or its sub-board for a subitem). */
  board: BoardDetail;
  item: Item;
  mode: 'to_subitem' | 'to_item';
  onClose: () => void;
  onConvert: (v: { parentItemId?: string; groupId?: string; mapping?: ColumnMapping }) => Promise<unknown>;
}) => {
  const rootId = board.parent_board_id ?? board.id;
  const root = useBoard(accountId, rootId).data;
  const rootItems = useItems(accountId, mode === 'to_subitem' ? rootId : '').data?.data ?? [];
  const otherId = mode === 'to_subitem' ? (root?.subitems_board_id ?? '') : rootId;
  const other = useBoard(accountId, otherId).data;
  const [parentId, setParentId] = useState('');
  const [q, setQ] = useState('');
  const [groupId, setGroupId] = useState<string | undefined>(undefined);
  const [edited, setEdited] = useState<ColumnMapping | null>(null);
  const [busy, setBusy] = useState(false);
  const sources = useMemo(() => movable(board.columns), [board.columns]);
  const targets = useMemo(() => movable(other?.columns ?? []), [other]);
  const auto = mode === 'to_subitem' && !root?.subitems_board_id;
  const mapping = edited ?? proposal(sources, targets);
  const fresh = useNewColumns(accountId, sources);
  const group = mode === 'to_item' ? (root?.groups.find((g) => g.id === groupId) ?? root?.groups[0]) : undefined;
  const candidates = rootItems
    .filter((i) => i.id !== item.id && i.name.toLowerCase().includes(q.trim().toLowerCase()))
    .slice(0, 50);
  const ready = mode === 'to_subitem' ? !!parentId : !!group;

  const submit = async () => {
    setBusy(true);
    try {
      const final = { ...mapping };
      if (!auto && other) {
        try {
          await fresh.create(other, (sourceId, columnId) => {
            final[sourceId] = columnId;
            setEdited({ ...final });
          });
        } catch (err) {
          showToast({ message: errorMessage(err), tone: 'error' });
          return;
        }
      }
      await onConvert({
        ...(mode === 'to_subitem' ? { parentItemId: parentId } : { groupId: group!.id }),
        ...(auto ? {} : { mapping: final }),
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={
        mode === 'to_subitem'
          ? t('convert.toSubitem.title', { what: item.name })
          : t('convert.toItem.title', { what: item.name })
      }
      onClose={onClose}
      className="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="convert-confirm" disabled={!ready} busy={busy} onClick={() => void submit()}>
            {t('convert.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="convert-dialog">
        {mode === 'to_subitem' ? (
          <Field label={t('convert.parent')}>
            <div className="space-y-2">
              <div className="relative">
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={t('convert.searchParent')}
                  aria-label={t('convert.searchParent')}
                  className="pe-7"
                />
                <SearchClear value={q} onClear={() => setQ('')} testId="convert-search-clear" />
              </div>
              <div className="max-h-48 space-y-0.5 overflow-auto rounded-[var(--radius-sm)] border border-line p-1">
                {candidates.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    data-testid="convert-parent"
                    aria-pressed={i.id === parentId}
                    onClick={() => setParentId(i.id)}
                    className={
                      i.id === parentId
                        ? 'block w-full truncate rounded px-2 py-1 text-start text-sm bg-primary-soft font-medium text-primary'
                        : 'block w-full truncate rounded px-2 py-1 text-start text-sm hover:bg-surface-2'
                    }
                  >
                    {i.name}
                  </button>
                ))}
              </div>
            </div>
          </Field>
        ) : (
          <Field label={t('move.group')}>
            <PickerButton
              menuLabel={t('move.group')}
              placeholder={t('move.group')}
              label={group?.title}
              items={(root?.groups ?? []).map((g) => ({
                label: g.title,
                checked: g.id === group?.id,
                onSelect: () => setGroupId(g.id),
              }))}
            />
          </Field>
        )}
        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t('move.mapping')}</h3>
          {auto ? (
            <p className="text-xs text-muted">{t('convert.auto')}</p>
          ) : (
            <MappingTable
              sources={sources}
              targets={targets}
              mapping={mapping}
              onChange={setEdited}
              fresh={fresh.fresh}
              onFresh={fresh.set}
              blocked={newColumnBlock(other)}
            />
          )}
        </section>
      </div>
    </Dialog>
  );
};

/**
 * "Move to item → under an item" of the batch bar: the new parent among the board's items and
 * subitems (search, tree order), never one of the moved rows or their own subitems, and only where the moved
 * branches fit the board's hierarchy depth. Items of the board map their columns onto the sub-board's (automatic
 * while the board has no subitems yet); subitems stay on the sub-board, so there is nothing to map.
 */
export const TreeMoveDialog = ({
  accountId,
  board,
  ids,
  onClose,
  onMove,
}: {
  accountId: string;
  /** The selected rows' board (the board, or its sub-board for subitems). */
  board: BoardDetail;
  ids: string[];
  onClose: () => void;
  onMove: (v: { parent: Item; mapping?: ColumnMapping }) => Promise<unknown>;
}) => {
  const rootId = board.parent_board_id ?? board.id;
  const root = useBoard(accountId, rootId).data;
  const subId = root?.subitems_board_id ?? '';
  const sub = useBoard(accountId, subId).data;
  const rootItems = useItems(accountId, rootId).data?.data;
  const subItems = useItems(accountId, subId).data?.data;
  const [parentId, setParentId] = useState('');
  const [q, setQ] = useState('');
  const [edited, setEdited] = useState<ColumnMapping | null>(null);
  const [busy, setBusy] = useState(false);
  const fromItems = !board.parent_board_id;
  const sources = useMemo(() => movable(fromItems ? board.columns : []), [fromItems, board.columns]);
  const targets = useMemo(() => movable(sub?.columns ?? []), [sub]);
  const auto = !fromItems || !sub;
  const mapping = edited ?? proposal(sources, targets);
  const fresh = useNewColumns(accountId, sources);

  // The board's tree in order (items, each followed by its subitems), the moved branches left out.
  const { rows, need } = useMemo(() => {
    const kids = new Map<string, Item[]>();
    for (const s of subItems ?? []) {
      if (!s.parent_item_id) continue;
      kids.set(s.parent_item_id, [...(kids.get(s.parent_item_id) ?? []), s]);
    }
    const moved = new Set(ids);
    // How deep the deepest moved branch reaches below its top row.
    const below = (id: string): number => Math.max(0, ...(kids.get(id) ?? []).map((k) => 1 + below(k.id)));
    const out: { item: Item; parent: Item | null }[] = [];
    const walk = (item: Item, parent: Item | null) => {
      if (moved.has(item.id)) return;
      out.push({ item, parent });
      for (const k of kids.get(item.id) ?? []) walk(k, item);
    };
    for (const i of rootItems ?? []) walk(i, null);
    return { rows: out, need: Math.max(0, ...ids.map(below)) };
  }, [rootItems, subItems, ids]);
  const max = effectiveDepthMax(root?.hierarchy_depth_max ?? board.hierarchy_depth_max);
  const term = q.trim().toLowerCase();
  const candidates = rows
    .filter(({ item }) => item.depth + 1 + need <= max && (!term || item.name.toLowerCase().includes(term)))
    .slice(0, 200);
  const picked = rows.find((r) => r.item.id === parentId)?.item;

  const submit = async () => {
    if (!picked) return;
    setBusy(true);
    try {
      const final = { ...mapping };
      if (!auto && sub) {
        try {
          await fresh.create(sub, (sourceId, columnId) => {
            final[sourceId] = columnId;
            setEdited({ ...final });
          });
        } catch (err) {
          showToast({ message: errorMessage(err), tone: 'error' });
          return;
        }
      }
      await onMove({ parent: picked, ...(auto ? {} : { mapping: final }) });
      onClose();
    } catch {
      // The caller showed why (a toast); the dialog stays open.
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t('tree.title', { n: ids.length })}
      onClose={onClose}
      className="max-w-xl"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button data-testid="tree-confirm" disabled={!picked} busy={busy} onClick={() => void submit()}>
            {t('tree.confirm')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="tree-dialog">
        <Field label={t('tree.parent')}>
          <div className="space-y-2">
            <div className="relative">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('tree.search')}
                aria-label={t('tree.search')}
                className="pe-7"
              />
              <SearchClear value={q} onClear={() => setQ('')} testId="tree-search-clear" />
            </div>
            <div
              className="max-h-60 space-y-0.5 overflow-auto rounded-[var(--radius-sm)] border border-line p-1"
              role="listbox"
              aria-label={t('tree.parent')}
            >
              {candidates.length ? (
                candidates.map(({ item, parent }) => (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    data-testid="tree-parent"
                    data-depth={item.depth}
                    aria-selected={item.id === parentId}
                    onClick={() => setParentId(item.id)}
                    // Tree order shows the level by its indent; a search lists matches flat, with their parent.
                    style={{ paddingInlineStart: `${0.5 + (term ? 0 : item.depth)}rem` }}
                    className={cn(
                      'block w-full rounded py-1 pe-2 text-start text-sm',
                      item.id === parentId ? 'bg-primary-soft text-primary' : 'hover:bg-surface-2',
                    )}
                  >
                    <span className="block truncate">{item.name}</span>
                    {parent && term ? (
                      <span className="block truncate text-xs text-muted">
                        {t('tree.subitemOf', { parent: parent.name })}
                      </span>
                    ) : null}
                  </button>
                ))
              ) : (
                <p className="px-2 py-1 text-sm text-muted">{t('tree.empty')}</p>
              )}
            </div>
          </div>
        </Field>
        {fromItems ? (
          <section className="space-y-2">
            <h3 className="text-sm">{t('move.mapping')}</h3>
            <p className="text-xs text-muted">{t('tree.mappingHint')}</p>
            {auto ? (
              <p className="text-xs text-muted">{t('convert.auto')}</p>
            ) : (
              <MappingTable
                sources={sources}
                targets={targets}
                mapping={mapping}
                onChange={setEdited}
                fresh={fresh.fresh}
                onFresh={fresh.set}
                blocked={newColumnBlock(sub)}
              />
            )}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
};
