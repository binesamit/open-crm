// SPDX-License-Identifier: AGPL-3.0-only
import { Fragment, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { JSONContent } from '@tiptap/react';
import {
  exactTime,
  findUpdateThread,
  MAX_REPLY_DEPTH,
  REACTION_EMOJI,
  REACTIONS,
  relativeTime,
  resolveCardTabs,
  t,
  type ActivityEntry,
  type BoardDetail,
  type CardTab,
  type Deleted,
  type EditedItem,
  type Item,
  type MessageKey,
  type MyAccount,
  type BoardSecretUpdates,
  type SecretUpdateReveal,
  type UpdateDto,
  updateLinkQuery,
  withUpdateLink,
  withoutUpdateLink,
  updateMenu,
} from '@bines/shared';
import {
  Avatar,
  Button,
  cn,
  dialogOpenNow,
  Menu,
  Notice,
  Skeleton,
  SkeletonRows,
  useActionMenu,
  useEscapeClose,
  usePanelOverModal,
} from '@bines/ui';
import { Icon, type IconName } from '../../lib/icons';
import { api, errorMessage, type Me } from '../../lib/api';
import { confirmDialog } from '../../lib/dialogs';
import { appLink, copyText, toMenuEntries } from '../../lib/entity-menu';
import { showToast } from '../../lib/toast';
import { useDeletedToast } from '../../lib/undo';
import { formatSize } from '../../lib/upload';
import { type Member, useBoard, useBoardMutations, useMembers } from '../board/board-api';
import { usePeople } from '../board/people';
import { BoardAccountContext } from '../board/board-context';
import { invalidateUpdateCounts } from '../board/update-counts';
import { draftKey as makeDraftKey } from './drafts';
import type { ComposerProps } from './Composer';
import { TimeLog } from '../time/TimeLog';
import { useFollow } from '../notifications/follow';
import { ActivityRow } from '../board/ActivityLog';
import { useCardItemMenu } from './card-menu';
import { AssistantButton } from '../ai2/AssistantPanel';
import { FieldsTab } from './FieldsTab';
import { ExtensionItemTab, extensionTabId, featureLabel, useExtensionItemTabs } from '../extensions/ExtensionSlots';
import { UpdateBody } from './UpdateBody';
import { emailImageSrc, EmailFilesLine, EmailFold, inlineImageIds } from './EmailUpdateParts';
import { SecretUpdateBody } from '../secrets/SecretUpdateBody';
import { useSecretStepUp } from '../secrets/step-up';
import { SubitemsTab, useSubitemCount } from './SubitemsTab';
import { DownloadAllButton, updateZipPath } from '../files/download-all';
import { FileViewer, type ViewerFile } from '../files/FileViewer';
import { isMedia, MediaAttachment } from '../files/MediaAttachment';
import { TranscribeAll } from '../files/Transcript';
import { cardTabName, CardTabsDialog } from './CardTabsDialog';
import { SeenBy, useMarkSeen } from './seen-by';
import { useSeenLive } from './seen-live';
import { ComputedNameMark } from '../board/name-source/ComputedName';
import type { ComputedNameEdit } from '../board/table/ComputedNameEditor';
import { useAccountDetail } from '../admin/account-settings';
import { useCardWidth } from '../../lib/card-width';
import { useDesktop } from '../../lib/use-desktop';
import { CardResizeHandle } from './CardResize';
import { DocumentsTab } from '../idocs/DocumentsTab';
import { PopoverSheetContext } from '../board/cells/Popover';

type Reaction = (typeof REACTIONS)[number];

const TAB_ICON: Record<CardTab['type'], IconName> = {
  updates: 'chat',
  fields: 'table',
  subitems: 'group',
  time: 'clock',
  activity: 'history',
  documents: 'doc',
};

const itemKey = (accountId: string, itemId: string) => ['account', accountId, 'item', itemId];
const updatesKey = (accountId: string, itemId: string) => [...itemKey(accountId, itemId), 'updates'];

/** The item's updates thread (the tab and its count share one query). */
const useItemUpdates = (accountId: string, itemId: string) =>
  useQuery({
    queryKey: updatesKey(accountId, itemId),
    queryFn: () => api(accountId).get<{ data: UpdateDto[] }>(`/items/${itemId}/updates`),
  });

/**
 * Owner fix (fix4-board 2): a subitem's ancestors, top item first, up to its parent — walked through
 * GET /items/{id} by `parent_item_id`. Each ancestor shares the card's own item cache, so a step already seen
 * (or opened) costs nothing.
 */
const MAX_ANCESTORS = 20;
const useAncestors = (accountId: string, parentId: string | null | undefined) => {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [...itemKey(accountId, parentId ?? ''), 'ancestors'],
    enabled: !!parentId,
    staleTime: 30_000,
    queryFn: async () => {
      const chain: Item[] = [];
      let next: string | null | undefined = parentId;
      while (next && chain.length < MAX_ANCESTORS && !chain.some((x) => x.id === next)) {
        const id: string = next;
        const it = await qc.fetchQuery({
          queryKey: itemKey(accountId, id),
          queryFn: () => api(accountId).get<Item>(`/items/${id}`),
          staleTime: 30_000,
        });
        chain.unshift(it);
        next = it.parent_item_id;
      }
      return chain;
    },
  });
};

/** "Now", once a minute — relative times ("לפני 20 דק׳") stay fresh while the card is open (N17). */
const useMinuteNow = () => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  return now;
};

/**
 * Item card (11-UI-DESIGN §3, N19): a panel from the inline-start edge — over the whole app on desktop (the
 * sidebar too), full screen with a back button on phones — deep-linkable at /b/:boardId/i/:itemId. Header: name,
 * key + "board / group" (N10), follow, the item's ⋯ menu. Tabs come from the board's settings (`resolveCardTabs`,
 * N19ב): updates first (with its count, N4), then fields / time / activity as the board arranged them.
 */
/**
 * The card's title (fix1): the item's name as the dialog's heading; with `item.update` a click turns it into an
 * input in place — Enter or blur saves, Esc cancels (like renaming in the sidebar and the table). Owner fix 2: a
 * long name wraps onto more lines (in the editor too) instead of being cut — the whole name is always visible.
 */
const CardTitle = ({
  name,
  canEdit,
  onSave,
  computedOn,
  computedEdit,
}: {
  name: string;
  canEdit: boolean;
  onSave: (name: string) => void;
  /** the name is computed from this board's columns — the ƒ mark, no renaming. */
  computedOn?: BoardDetail;
  /** the ƒ (and a click on the name) opens the source columns as editable cells. */
  computedEdit?: ComputedNameEdit;
}) => {
  const [draft, setDraft] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const title = 'font-display text-[1.375rem] leading-tight font-extrabold text-heading';
  if (computedOn) {
    return (
      <h2
        className={cn(title, 'flex min-w-0 items-start gap-1.5 break-words [overflow-wrap:anywhere]')}
        data-testid="card-title"
        data-tour="item.title"
        data-computed
      >
        <ComputedNameMark
          board={computedOn}
          className="mt-1.5"
          edit={computedEdit}
          open={sourcesOpen}
          onOpenChange={setSourcesOpen}
        />
        <span
          className={cn('block min-w-0 text-fg-2', canEdit && 'cursor-pointer')}
          data-testid="card-title-computed"
          onClick={canEdit ? () => setSourcesOpen(true) : undefined}
        >
          {name}
        </span>
      </h2>
    );
  }
  const finish = (save: boolean) => {
    const v = draft?.trim();
    setDraft(null);
    if (save && v && v !== name) onSave(v);
  };
  if (draft !== null) {
    return (
      <textarea
        autoFocus
        rows={1}
        value={draft}
        aria-label={t('menu.rename')}
        data-testid="card-title-input"
        onFocus={(e) => e.currentTarget.select()}
        // A name is one line: pasted line breaks become spaces.
        onChange={(e) => setDraft(e.target.value.replace(/\r?\n/g, ' '))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          }
          if (e.key === 'Escape') {
            // Cancels the edit only — the card stays open.
            e.preventDefault();
            e.stopPropagation();
            finish(false);
          }
        }}
        onBlur={() => finish(true)}
        className={cn(
          title,
          '-mx-1.5 block min-h-9 w-full min-w-0 resize-none overflow-hidden rounded-[8px] border border-primary bg-surface px-1.5 py-0.5 break-words outline-none [field-sizing:content]',
        )}
      />
    );
  }
  return (
    <h2
      className={cn(title, 'min-w-0 break-words [overflow-wrap:anywhere]')}
      data-testid="card-title"
      data-tour="item.title"
    >
      {canEdit ? (
        <button
          type="button"
          data-testid="card-title-edit"
          title={t('menu.rename')}
          onClick={() => setDraft(name)}
          className="-mx-1.5 block max-w-full cursor-text rounded-[8px] px-1.5 text-start whitespace-normal hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
        >
          {name}
        </button>
      ) : (
        <span className="block">{name}</span>
      )}
    </h2>
  );
};

/**
 * Where the card lives in the URL: over its board (the default), or over a dashboard (an item
 * clicked in a widget opens here, and closing it goes back to the dashboard, never to the board).
 */
export type ItemCardRoutes = {
  /** The card of an item (this one, another one, or a subitem) at the same place. */
  card: (itemId: string) => { to: string; params: Record<string, string> };
  /** Where closing the card goes. */
  back: { to: string; params: Record<string, string> };
};

export const ItemCard = ({
  account,
  me,
  boardId,
  itemId,
  initialTab,
  focusUpdate,
  routes: given,
}: {
  account: MyAccount;
  me: Me;
  boardId: string;
  itemId: string;
  /** A tab id or type (`?tab=time` from a time cell). */
  initialTab?: string;
  /** s37reply (`?update=`): show only this update's thread (a reply: its thread, scrolled to the reply). */
  focusUpdate?: string;
  routes?: ItemCardRoutes;
}) => {
  const navigate = useNavigate();
  const routes: ItemCardRoutes = given ?? {
    card: (id) => ({
      to: '/a/$accountSlug/b/$boardId/i/$itemId',
      params: { accountSlug: account.slug, boardId, itemId: id },
    }),
    back: { to: '/a/$accountSlug/b/$boardId', params: { accountSlug: account.slug, boardId } },
  };
  const qc = useQueryClient();
  const [picked, setPicked] = useState<string | undefined>(initialTab ?? (focusUpdate ? 'updates' : undefined));
  // Another update link on the same item (the card stays open): back to the updates tab, on that thread.
  const lastFocus = useRef(focusUpdate);
  useEffect(() => {
    if (focusUpdate && focusUpdate !== lastFocus.current) setPicked('updates');
    lastFocus.current = focusUpdate;
  }, [focusUpdate]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const item = useQuery({
    queryKey: itemKey(account.id, itemId),
    queryFn: () => api(account.id).get<Item>(`/items/${itemId}`),
  });
  // The item's own board (it may be a linked item from another board, or a subitem on a sub-board) decides the
  // tabs, the fields and the permissions; the breadcrumb names the board the item lives under.
  const itemBoardId = item.data?.board_id ?? boardId;
  const itemBoard = useBoard(account.id, itemBoardId);
  const board = itemBoard.data;
  const rootBoard = useBoard(account.id, board?.parent_board_id ?? itemBoardId).data;
  // A subitem's card follows its parent board's "fields per row" unless the subitems board sets its own.
  const parentCard = board?.parent_board_id ? rootBoard?.card : undefined;
  // r16seen: "seen by" on this item's updates, live from its own board's channel (shared with the board page).
  useSeenLive(account.id, board ? (board.parent_board_id ?? board.id) : null);
  const m = useBoardMutations(account.id, itemBoardId);
  const timeColumns = (board?.columns ?? []).filter((c) => c.type === 'time_tracking');
  const members = usePeople(account.id, board?.parent_board_id ?? itemBoardId, true);
  const updates = useItemUpdates(account.id, itemId);
  const now = useMinuteNow();

  // Hidden tabs and the time tab of a board without a time column are left out; until the board is known, only
  // updates (always first).
  const all = resolveCardTabs(board?.card);
  const tabs = board ? all.filter((x) => !x.hidden && (x.type !== 'time' || timeColumns.length > 0)) : all.slice(0, 1);
  // Installed extensions' item tabs (D27 ת3), after the board's own tabs; on the item's root board.
  const extTabs = useExtensionItemTabs(account.id, board ? (board.parent_board_id ?? board.id) : undefined);
  const extActive = extTabs.find((f) => extensionTabId(f) === picked) ?? null;
  const active = tabs.find((x) => x.id === picked) ?? tabs.find((x) => x.type === picked) ?? tabs[0]!;

  // Back to the board with its view and draft (?view=&q=) as they were (or to the dashboard it opened over).
  const close = () =>
    navigate({
      ...routes.back,
      search: (prev: Record<string, unknown>) => prev,
    } as never);
  // s37reply: "all updates" leaves the thread — the link's `?update=` goes, the rest of the URL stays.
  const showAllUpdates = () =>
    navigate({
      ...routes.card(itemId),
      search: (prev: Record<string, unknown>) => withoutUpdateLink(prev),
      replace: true,
    } as never);
  // s37reply2: clicking an update's / reply's time opens that thread alone — the same
  // `?update=` as every other entry point (a new history entry, so the browser's back returns to all updates).
  const openUpdate = (updateId: string) =>
    navigate({
      ...routes.card(itemId),
      search: (prev: Record<string, unknown>) => withUpdateLink(prev, updateId),
    } as never);
  const refreshItem = () => void qc.invalidateQueries({ queryKey: itemKey(account.id, itemId) });
  const putItem = (it: EditedItem) => qc.setQueryData(itemKey(account.id, itemId), it);
  // Focus the card when it opens (from a click anywhere — a calendar chip, a Kanban card), so Esc closes it.
  const panel = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
  }, []);
  // Round 13: Esc closes the card (a subitem's too) — after an open menu / picker and a field being edited
  // (`useEscapeClose`: the first Esc cancels the edit or leaves the field, the next one closes the card).
  useEscapeClose(panel, true, () => void close());
  // P1-03: a dialog was open when the card opened (a linked item clicked in a popup) — the card goes over it.
  const [overModal] = useState(dialogOpenNow);
  usePanelOverModal(overModal);
  // F9 cardw: the card's width on desktop / tablet — mine (dragged) or the account's default, within its limits.
  const desktop = useDesktop();
  const cardLimits = useAccountDetail(account).data?.settings.defaults;
  const cardWidth = useCardWidth(cardLimits);

  const crumbBoard = rootBoard ?? board;
  // A top-level item: board / group. A subitem (any depth, fix5): only its ancestors — the top item first, down to
  // its parent, each one clickable; no board and no group (product decision).
  const ancestorsQuery = useAncestors(account.id, item.data?.parent_item_id);
  const ancestors = ancestorsQuery.data ?? [];
  const isSub = !!item.data?.parent_item_id;
  const group = isSub ? undefined : board?.groups.find((g) => g.id === item.data?.group_id);
  const updatesCount = updates.data?.data.length;
  const subitemCount = useSubitemCount(
    account.id,
    board,
    itemId,
    tabs.some((x) => x.type === 'subitems'),
  );
  // A subitem opens its own card (over the same board / dashboard, so closing it goes back there).
  const openItem = (id: string) =>
    navigate({
      ...routes.card(id),
      search: (prev: Record<string, unknown>) => prev,
    } as never);

  return (
    <BoardAccountContext.Provider value={{ id: account.id, slug: account.slug, meId: me.user.id }}>
      {/* F4 (canvas Item-Updates): over everything on desktop — the shell's bars included (`z-panel`, layers.css) —
          and full screen on phones; dialogs opened from it (`z-modal`) stay above it. P1-03: opened from inside a
          dialog (a linked item in a popup), it goes over that dialog, which stays open under it. */}
      <div
        className={cn(
          'anim-scrim fixed inset-0 flex justify-start bg-[var(--scrim)]',
          overModal ? 'z-panel-over-modal' : 'z-panel',
        )}
        onMouseDown={close}
      >
        <aside
          ref={panel}
          tabIndex={-1}
          role="dialog"
          // Audit 2026-10-10 ux #27: modal over the board, and a screen reader says what it is ("item card"), not
          // only the item's name (which stays the dialog's name).
          aria-modal="true"
          aria-roledescription={t('item.card.role')}
          aria-label={item.data?.name}
          className="anim-from-start relative flex h-full w-full flex-col bg-surface shadow-[var(--shadow-panel)] outline-none md:max-w-full md:rounded-e-[var(--radius-panel)] md:border-e md:border-[var(--panel-border)]"
          style={desktop ? { width: cardWidth.width } : undefined}
          onMouseDown={(e) => e.stopPropagation()}
          data-testid="item-card"
          data-width={desktop ? cardWidth.width : undefined}
        >
          {/* on a phone the card's cell editors (the status picker…) are bottom sheets with their own
              scroll, as on the board's phone table — never a panel wider than the screen. */}
          <PopoverSheetContext.Provider value={!desktop}>
            {/* A phone at a large text size: the actions move under the name rather than squeezing it to a few letters. */}
            <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-7 pb-1.5">
              <div className="flex min-w-[min(13rem,100%)] flex-1 items-start gap-2.5">
                <Button
                  variant="ghost"
                  onClick={close}
                  aria-label={t('item.close')}
                  className="w-9 shrink-0 px-0 md:hidden"
                >
                  <Icon name="back" size={18} />
                </Button>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  {item.data ? (
                    <CardTitle
                      name={item.data.name}
                      canEdit={!!board?.capabilities['item.update']}
                      computedOn={item.data.name_computed && board ? board : undefined}
                      computedEdit={
                        item.data.name_computed && board
                          ? {
                              item: item.data,
                              members,
                              accountId: account.id,
                              canEdit: !!board.capabilities['item.update'],
                              onWrite: (c, value) =>
                                m.setCell.mutate(
                                  { itemId: item.data!.id, columnId: c.id, value },
                                  { onSuccess: putItem, onError: refreshItem },
                                ),
                            }
                          : undefined
                      }
                      onSave={(name) =>
                        m.renameItem.mutate({ itemId, name }, { onSuccess: putItem, onError: refreshItem })
                      }
                    />
                  ) : (
                    <h2 className="truncate font-display text-[1.375rem] leading-tight font-extrabold text-heading">
                      <Skeleton className="my-1.5 h-4 w-52" />
                    </h2>
                  )}
                  <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
                    {item.data?.key ? (
                      <>
                        <span className="shrink-0 font-mono" dir="ltr">
                          {item.data.key}
                        </span>
                        {crumbBoard || isSub ? <span aria-hidden>•</span> : null}
                      </>
                    ) : null}
                    {isSub ? (
                      <span className="min-w-0 break-words [overflow-wrap:anywhere]" data-testid="card-breadcrumb">
                        {ancestors.map((a, i) => (
                          <Fragment key={a.id}>
                            {i ? <span aria-hidden> / </span> : null}
                            <button
                              type="button"
                              className="break-words [overflow-wrap:anywhere] hover:text-fg hover:underline"
                              data-testid="card-breadcrumb-item"
                              data-item-id={a.id}
                              onClick={() => void openItem(a.id)}
                            >
                              {a.name}
                            </button>
                          </Fragment>
                        ))}
                        {ancestorsQuery.isPending ? <Skeleton className="inline-block h-2.5 w-20" /> : null}
                      </span>
                    ) : crumbBoard ? (
                      <span className="min-w-0 break-words [overflow-wrap:anywhere]" data-testid="card-breadcrumb">
                        <Link
                          to="/a/$accountSlug/b/$boardId"
                          params={{ accountSlug: account.slug, boardId: crumbBoard.id }}
                          className="hover:text-fg hover:underline"
                          data-testid="card-breadcrumb-board"
                        >
                          {crumbBoard.name}
                        </Link>
                        {group ? <span> / {group.title}</span> : null}
                      </span>
                    ) : !item.data ? (
                      <Skeleton className="h-2.5 w-32" />
                    ) : null}
                  </p>
                </div>
              </div>
              <div className="ms-auto flex shrink-0 items-center gap-1">
                <FollowToggle accountId={account.id} itemId={itemId} />
                {item.data ? (
                  <AssistantButton
                    compact
                    accountId={account.id}
                    slug={account.slug}
                    boardId={itemBoardId}
                    itemId={itemId}
                    title={item.data.name}
                  />
                ) : null}
                {board && item.data ? (
                  <CardMore
                    resetWidth={desktop}
                    accountId={account.id}
                    slug={account.slug}
                    board={board}
                    item={item.data}
                    m={m}
                    refresh={refreshItem}
                    close={close}
                    inboundEmail={account.role !== 'viewer' && account.role !== 'guest' && !account.support}
                  />
                ) : null}
                <Button
                  variant="ghost"
                  onClick={close}
                  aria-label={t('item.close')}
                  className="w-9 px-0 text-muted max-md:hidden"
                >
                  <Icon name="x" size={18} />
                </Button>
              </div>
            </header>
            <div className="px-5">
              <nav
                className="flex items-center gap-[1.125rem] overflow-x-auto border-b border-line"
                data-tour="item.tabs"
              >
                {tabs.map((x) => (
                  <button
                    key={x.id}
                    type="button"
                    onClick={() => setPicked(x.id)}
                    data-testid="card-tab"
                    data-tab-id={x.id}
                    aria-current={!extActive && active.id === x.id ? 'page' : undefined}
                    className={cn(
                      '-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-0.5 text-[0.8125rem] whitespace-nowrap',
                      !extActive && active.id === x.id
                        ? 'border-accent font-semibold text-heading'
                        : 'border-transparent text-muted hover:text-fg',
                    )}
                  >
                    <Icon name={TAB_ICON[x.type]} size={15} />
                    {cardTabName(x)}
                    {x.type === 'updates' && updatesCount ? (
                      <span
                        className="inline-flex h-[1.125rem] items-center rounded-full bg-surface-2 px-1.5 text-xs font-semibold text-fg-2"
                        data-testid="card-updates-count"
                      >
                        {updatesCount}
                      </span>
                    ) : null}
                    {x.type === 'subitems' && subitemCount ? (
                      <span
                        className="inline-flex h-[1.125rem] items-center rounded-full bg-surface-2 px-1.5 text-xs font-semibold text-fg-2"
                        data-testid="card-subitems-count"
                      >
                        {subitemCount}
                      </span>
                    ) : null}
                  </button>
                ))}
                {extTabs.map((f) => (
                  <button
                    key={extensionTabId(f)}
                    type="button"
                    onClick={() => setPicked(extensionTabId(f))}
                    data-testid="card-tab"
                    data-tab-id={extensionTabId(f)}
                    title={f.extension_name}
                    aria-current={extActive === f ? 'page' : undefined}
                    className={cn(
                      '-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-0.5 text-[0.8125rem] whitespace-nowrap',
                      extActive === f
                        ? 'border-accent font-semibold text-heading'
                        : 'border-transparent text-muted hover:text-fg',
                    )}
                  >
                    <Icon name="ext" size={15} />
                    {featureLabel(f)}
                  </button>
                ))}
                {board?.capabilities['board.update'] ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('card.tabs.title')}
                    title={t('card.tabs.title')}
                    data-testid="card-tabs-settings"
                    onClick={() => setSettingsOpen(true)}
                    className="ms-auto h-8 w-8 shrink-0 px-0 text-muted"
                  >
                    <Icon name="gear" size={15} />
                  </Button>
                ) : null}
              </nav>
            </div>
            <div className="flex-1 overflow-auto px-5 pt-4 pb-5">
              {/* An item that can't be read (hidden, deleted): one message, no tabs that would fail the same way. */}
              {item.isError ? (
                <Notice tone="error">{errorMessage(item.error)}</Notice>
              ) : extActive && board ? (
                <ExtensionItemTab
                  accountId={account.id}
                  boardId={board.parent_board_id ?? board.id}
                  itemId={itemId}
                  meId={me.user.id}
                  feature={extActive}
                  onOpenItem={openItem}
                />
              ) : active.type === 'updates' ? (
                <Updates
                  account={account}
                  me={me}
                  itemId={itemId}
                  boardId={itemBoardId}
                  updates={updates}
                  now={now}
                  canManage={!!board?.capabilities['board.update']}
                  itemPath={`/a/${account.slug}/b/${boardId}/i/${itemId}`}
                  focus={focusUpdate}
                  onShowAll={showAllUpdates}
                  onOpenUpdate={openUpdate}
                />
              ) : active.type === 'documents' ? (
                <DocumentsTab
                  accountId={account.id}
                  itemId={itemId}
                  boardId={itemBoardId}
                  canEdit={
                    !!board?.capabilities['item.update'] && account.role !== 'viewer' && account.role !== 'guest'
                  }
                  isAdmin={account.role === 'admin'}
                />
              ) : active.type === 'time' ? (
                <TimeLog
                  accountId={account.id}
                  me={me}
                  itemId={itemId}
                  columns={timeColumns}
                  members={members}
                  canEdit={!!board?.capabilities['item.update']}
                  isAdmin={account.role === 'admin'}
                />
              ) : active.type === 'subitems' ? (
                board && item.data ? (
                  <SubitemsTab
                    key={active.id}
                    accountId={account.id}
                    board={board}
                    item={item.data}
                    columns={active.columns}
                    members={members}
                    onOpen={openItem}
                  />
                ) : (
                  <SkeletonRows rows={3} label={t('app.loading')} />
                )
              ) : active.type === 'fields' ? (
                board && item.data ? (
                  <FieldsTab
                    key={active.id}
                    accountId={account.id}
                    board={board}
                    parentCard={parentCard}
                    item={item.data}
                    columns={active.columns}
                    members={members}
                    m={m}
                    onItem={putItem}
                    subitems={
                      // cardsub: the main "Fields" tab shows the subitems under the fields (the subitems tab's columns).
                      active.id === 'fields'
                        ? { columns: all.find((x) => x.type === 'subitems')?.columns, onOpen: openItem }
                        : undefined
                    }
                  />
                ) : (
                  <SkeletonRows rows={4} label={t('app.loading')} />
                )
              ) : (
                // A linked item from another board opens over this one; its activity uses its own board's columns.
                <Activity account={account} board={board} itemId={itemId} />
              )}
            </div>
            {settingsOpen && board ? (
              <CardTabsDialog
                accountId={account.id}
                board={board}
                parentCard={parentCard}
                onClose={() => setSettingsOpen(false)}
              />
            ) : null}
            {/* Last in the tab order (after the card's own controls); placed on the inner edge by itself. */}
            {desktop ? (
              <CardResizeHandle
                width={cardWidth.width}
                viewport={cardWidth.viewport}
                limits={cardLimits}
                accountId={account.id}
              />
            ) : null}
          </PopoverSheetContext.Provider>
        </aside>
      </div>
    </BoardAccountContext.Provider>
  );
};

/** The item's ⋯ in the header (N10): the item menu of the table, from inside the card. */
const CardMore = (props: Parameters<typeof useCardItemMenu>[0]) => {
  const { menu, entries, label, dialogs } = useCardItemMenu(props);
  return (
    <>
      <Button
        variant="ghost"
        aria-haspopup="menu"
        aria-label={label}
        title={t('menu.actions')}
        data-testid="card-more"
        onClick={menu.fromTrigger}
        className="w-9 px-0 text-muted"
      >
        <DotsIcon />
      </Button>
      <Menu at={menu.at} onClose={menu.close} items={entries} label={label} />
      {dialogs}
    </>
  );
};

// ---------------------------------------------------------------------------
// Composer: rich editor + attachments (Composer.tsx, lazy); the image thumbs of sent updates.
// ---------------------------------------------------------------------------
const isImage = (f: { mime: string }) => f.mime.startsWith('image/');

/** An attached image, shown (signed URL, refreshed before it expires); a click opens it in the file viewer. */
const ImageThumb = ({
  accountId,
  file,
  onOpen,
}: {
  accountId: string;
  file: { id: string; name: string };
  onOpen: () => void;
}) => {
  const url = useQuery({
    queryKey: ['account', accountId, 'file-url', file.id],
    queryFn: () => api(accountId).get<{ download_url: string }>(`/files/${file.id}`),
    staleTime: 4 * 60_000,
  }).data?.download_url;
  return (
    <button
      type="button"
      title={file.name}
      onClick={onOpen}
      // At least 64px square even for a tiny image, so the corner remove button never covers all of it.
      className="grid min-h-16 min-w-16 place-items-center overflow-hidden rounded-[var(--radius-sm)] border border-line bg-surface-2 hover:border-primary"
      data-testid="update-image"
    >
      {url ? (
        <img src={url} alt={file.name} className="max-h-48 max-w-64 object-contain" />
      ) : (
        <span className="block size-24 bg-surface-2" />
      )}
    </button>
  );
};

/** The composer (and TipTap with it) loads on first use — see Composer.tsx. */
const LazyComposer = lazy(() => import('./Composer'));
const Composer = (props: ComposerProps) => (
  <Suspense fallback={<Skeleton className="h-24 w-full rounded-[var(--radius)]" />}>
    <LazyComposer {...props} />
  </Suspense>
);

/** "מעקב" / "במעקב ✓" (D15): following = new updates on the item notify me. */
const FollowToggle = ({ accountId, itemId }: { accountId: string; itemId: string }) => {
  const { following, set } = useFollow(accountId, itemId);
  if (following === undefined) return null;
  return (
    <Button
      variant="secondary"
      size="sm"
      data-testid="item-follow"
      aria-pressed={following}
      title={t('item.follow.hint')}
      disabled={set.isPending}
      onClick={() => set.mutate(!following)}
    >
      <Icon name="bell" size={15} />
      {following ? t('item.following') : t('item.follow')}
    </Button>
  );
};

// ---------------------------------------------------------------------------
// Updates thread
// ---------------------------------------------------------------------------
const Updates = ({
  account,
  me,
  itemId,
  boardId,
  updates,
  now,
  canManage,
  itemPath,
  focus,
  onShowAll,
  onOpenUpdate,
}: {
  account: MyAccount;
  me: Me;
  itemId: string;
  /** The item's board: its update counts (N4) change when an update is posted or deleted. */
  boardId: string;
  updates: ReturnType<typeof useItemUpdates>;
  now: number;
  /** A board owner or admin: may remove anyone's update and its attachments (the server's rule). */
  canManage: boolean;
  /** The card's own path (`/a/…/b/…/i/…`): an update's copied link is this + `?tab=updates&update=<id>`. */
  itemPath: string;
  /** s37reply: the update / reply the card was opened on — only its thread shows. */
  focus?: string;
  /** Leave the thread for all the item's updates. */
  onShowAll: () => void;
  /** s37reply2: show only this update's thread (a reply: its thread, at the reply) — an update's time was clicked. */
  onOpenUpdate: (id: string) => void;
}) => {
  const qc = useQueryClient();
  const members = usePeople(account.id, boardId, true);
  const refresh = () => qc.invalidateQueries({ queryKey: updatesKey(account.id, itemId) });
  const countsChanged = () => invalidateUpdateCounts(qc, account.id, boardId);
  // whether this board lets people write secret updates (the lock in the composer).
  const secretSettings = useQuery({
    queryKey: ['account', account.id, 'board', boardId, 'secret-updates'],
    queryFn: () => api(account.id).get<BoardSecretUpdates>(`/boards/${boardId}/secret-updates`),
    staleTime: 60_000,
    enabled: account.role !== 'guest' && !account.support,
  });
  const secretEnabled = !!secretSettings.data?.effective.enabled;
  const stepUp = useSecretStepUp(account);
  const post = useMutation({
    // A secret update needs 2FA: without it the step-up dialog says so and the text stays (false = not sent).
    mutationFn: async (v: { doc: JSONContent; fileIds: string[]; secret: boolean }) =>
      (await stepUp.run(() =>
        api(account.id).post(`/items/${itemId}/updates`, {
          doc: v.doc,
          file_ids: v.fileIds,
          ...(v.secret ? { secret: true } : {}),
        }),
      )) ?? false,
    onSuccess: async (sent) => {
      if (sent === false) return;
      await refresh();
      await countsChanged();
    },
  });
  const canPost = account.role !== 'viewer';
  const cardProps = {
    account,
    me,
    members,
    canPost,
    canManage,
    secretEnabled,
    now,
    linkOf: (id: string) => appLink(`${itemPath}${updateLinkQuery(id)}`),
    onOpen: onOpenUpdate,
    onChanged: refresh,
    onDeleted: countsChanged,
  };
  // s37reply2: entering a thread (or switching to another one) from further down the list starts at its top; a
  // reply link is scrolled to the reply by its entry instead.
  const focusRef = useRef<HTMLDivElement>(null);
  const focusThread = focus && updates.data ? findUpdateThread(updates.data.data, focus) : null;
  const focusTop = focusThread && !focusThread.reply ? focusThread.thread.id : null;
  useEffect(() => {
    if (focusTop) focusRef.current?.scrollIntoView?.({ block: 'start' });
  }, [focusTop]);

  // s37reply: opened from a link to an update or reply — that thread alone, with a way back.
  if (focus) {
    const all = updates.data?.data;
    const found = focusThread;
    return (
      <div
        ref={focusRef}
        className="flex scroll-mt-4 flex-col gap-3.5"
        data-testid="update-focus"
        data-tour="item.updates"
        data-focus-id={focus}
      >
        {/* s37reply2: a clear strip says that one update is shown (not all of them), with the way back. */}
        <div
          role="status"
          data-testid="update-focus-banner"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--radius)] bg-info-soft px-3 py-2 text-info-fg"
        >
          <span className="flex min-w-0 flex-1 items-center gap-2 text-[0.8125rem] font-semibold">
            <Icon name="filter" size={15} />
            <span className="min-w-0">
              {t('item.updateFocus.banner')}
              {found?.reply ? <span className="font-normal"> · {t('item.updateFocus.bannerReply')}</span> : null}
            </span>
          </span>
          <Button variant="secondary" size="sm" data-testid="update-focus-all" onClick={onShowAll} className="shrink-0">
            <Icon name="back" size={14} />
            {t('item.updateFocus.all')}
            {all?.length ? (
              <span
                data-testid="update-focus-count"
                className="inline-flex h-[1.125rem] items-center rounded-full bg-surface-2 px-1.5 text-xs font-semibold text-fg-2"
              >
                {all.length}
              </span>
            ) : null}
          </Button>
        </div>
        {updates.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
        {updates.isError ? <Notice tone="error">{errorMessage(updates.error)}</Notice> : null}
        {all && !found ? (
          <div data-testid="update-focus-missing">
            <Notice>{t('item.updateFocus.missing')}</Notice>
          </div>
        ) : null}
        {found ? <UpdateCard key={found.thread.id} update={found.thread} anchor={found.reply} {...cardProps} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3.5" data-tour="item.updates">
      {canPost ? (
        <Composer
          accountId={account.id}
          members={members}
          placeholder={t('item.writeUpdate')}
          submitLabel={t('item.post')}
          busy={post.isPending}
          key={itemId}
          collapsible
          avatar={{ name: me.user.name || me.user.email, url: me.user.avatar_url }}
          draftKey={makeDraftKey(account.id, 'item', itemId)}
          secret={secretEnabled ? 'optional' : 'off'}
          onSubmit={(doc, fileIds, _removed, secret) => post.mutateAsync({ doc, fileIds, secret })}
        />
      ) : null}
      {stepUp.dialog}
      {updates.isPending ? <SkeletonRows rows={3} label={t('app.loading')} /> : null}
      {updates.isError ? <Notice tone="error">{errorMessage(updates.error)}</Notice> : null}
      {updates.data && !updates.data.data.length ? <p className="text-sm text-muted">{t('item.noUpdates')}</p> : null}
      {updates.data?.data.map((u) => (
        <UpdateCard key={u.id} update={u} {...cardProps} />
      ))}
    </div>
  );
};

/** A plain-text update reopened in the editor: one paragraph per line. */
const docFromText = (text: string): JSONContent => ({
  type: 'doc',
  content: text.split('\n').map((line) => ({
    type: 'paragraph',
    content: line ? [{ type: 'text', text: line }] : [],
  })),
});

type UpdateEntry = UpdateDto | UpdateDto['replies'][number];
type EntryProps = {
  accountId: string;
  me: Me;
  u: UpdateEntry;
  members: Member[];
  /** For relative times (N17). */
  now: number;
  /** 0 = the update; 1.. = replies (a reply to a reply is one deeper, up to MAX_REPLY_DEPTH). */
  depth?: number;
  canDelete: (authorId: string | undefined) => boolean;
  canReply: boolean;
  /** s37reply: this entry is the reply a link pointed at — scrolled into view and marked. */
  anchored?: boolean;
  /** An update's / reply's own link (copy link). */
  linkOf: (id: string) => string;
  /** s37reply2: its time was clicked — show this update's thread alone (a reply: its thread, at the reply). */
  onOpen: (id: string) => void;
  onReact: (u: UpdateEntry, reaction: Reaction, on: boolean) => void;
  onDelete: (id: string) => void;
  onReply: (id: string) => void;
  onEdited: () => void;
  /** The card's two-factor step-up for secret updates (reveal, edit). */
  stepUp: ReturnType<typeof useSecretStepUp>['run'];
};

/** Reaction chips (fixed order) + a picker; 👍 is the old "like" (M1.1 #14). */
const Reactions = ({
  u,
  onReact,
  children,
}: {
  u: UpdateEntry;
  onReact: (reaction: Reaction, on: boolean) => void;
  /** More actions in the same row (the reply button). */
  children?: ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative flex flex-wrap items-center gap-1.5">
      {u.reactions.map((r) => (
        <button
          key={r.reaction}
          type="button"
          aria-pressed={r.me}
          aria-label={t('reactions.toggle', {
            emoji: REACTION_EMOJI[r.reaction as Reaction] ?? r.reaction,
            n: r.count,
          })}
          onClick={() => onReact(r.reaction as Reaction, !r.me)}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-full px-[0.5625rem] text-xs font-semibold',
            r.me ? 'bg-info-soft text-info-fg' : 'bg-surface-2 text-fg-2 hover:text-fg',
          )}
        >
          <span aria-hidden>{REACTION_EMOJI[r.reaction as Reaction] ?? '•'}</span>
          {r.count}
        </button>
      ))}
      <Button
        variant="ghost"
        size="sm"
        aria-label={t('reactions.add')}
        title={t('reactions.add')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="h-[1.625rem] w-[1.625rem] px-0"
      >
        <Icon name="smile" size={15} />
      </Button>
      {children}
      {open ? (
        <div
          role="menu"
          className="absolute start-0 top-full z-20 mt-1 flex gap-0.5 rounded-full border border-line bg-surface p-1 shadow-[var(--shadow-pop)]"
        >
          {REACTIONS.map((r) => {
            const mine = u.reactions.some((x) => x.reaction === r && x.me);
            return (
              <button
                key={r}
                type="button"
                role="menuitemcheckbox"
                aria-checked={mine}
                aria-label={t(`reactions.${r}` as MessageKey)}
                onClick={() => {
                  setOpen(false);
                  onReact(r, !mine);
                }}
                className={cn('size-8 rounded-full text-lg hover:bg-surface-2', mine && 'bg-primary-soft')}
              >
                {REACTION_EMOJI[r]}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
};

const Entry = ({
  accountId,
  me,
  u,
  members,
  now,
  depth = 0,
  canDelete,
  canReply,
  anchored = false,
  linkOf,
  onOpen,
  onReact,
  onDelete,
  onReply,
  onEdited,
  stepUp,
}: EntryProps) => {
  const nested = depth > 0;
  const [editing, setEditing] = useState(false);
  /** A secret update being edited: its revealed document (the thread itself never holds the text). */
  const [secretDoc, setSecretDoc] = useState<JSONContent | null>(null);
  /** The attached file open in the viewer (an index into `u.files`). */
  const [viewing, setViewing] = useState<number | null>(null);
  // an email's images load through the app; its body images show in the text, not again below it.
  // an image pasted / uploaded into an update's text loads the same way, and stays listed below too.
  const imageSrc = useMemo(() => emailImageSrc(accountId, u.id), [accountId, u.id]);
  const listed = useMemo(() => {
    if (!u.email) return u.files;
    const inline = inlineImageIds(u.body_html);
    return u.files.filter((f) => !inline.has(f.id));
  }, [u.body_html, u.files, u.email]);
  // fix5 (the product owner): an attached image or file (pasted or uploaded) can be removed from the update — by its author, a
  // board owner or an admin (DELETE /updates/{id}/files/{fileId}, the file viewer's "remove").
  const canRemoveFiles = canDelete(u.author?.id);
  const removeFile = useMutation({
    mutationFn: (fileId: string) => api(accountId).delete(`/updates/${u.id}/files/${fileId}`),
    onSuccess: onEdited,
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const askRemoveFile = async (f: { id: string; name: string }) => {
    if (
      await confirmDialog({
        title: t('files.viewer.removeTitle', { name: f.name }),
        danger: true,
        confirmLabel: t('files.viewer.remove'),
      })
    )
      removeFile.mutate(f.id);
  };
  const removeButton = (f: { id: string; name: string }) =>
    canRemoveFiles ? (
      <button
        type="button"
        aria-label={`${t('files.viewer.remove')}: ${f.name}`}
        title={t('files.viewer.remove')}
        data-testid="update-file-remove"
        disabled={removeFile.isPending}
        onClick={() => void askRemoveFile(f)}
        className="absolute -end-1.5 -top-1.5 grid size-6 place-items-center rounded-full border border-line bg-surface text-muted shadow-[var(--shadow-pop)] group-hover/att:opacity-100 hover:text-danger-fg focus-visible:opacity-100 md:opacity-0"
      >
        <Icon name="x" size={12} strokeWidth={2.4} />
      </button>
    ) : null;
  // f9-updedit: an edit may attach files (📎, drop, pasted images) and take attached ones off
  // under the same conditions as posting — the server checks them (PATCH /updates/{id}).
  const edit = useMutation({
    // A secret update: the text only, through the step-up (a fresh code when the board asks); false = not saved.
    mutationFn: async (v: { doc: JSONContent; fileIds: string[]; removedFileIds: string[] }) =>
      u.secret
        ? ((await stepUp(() => api(accountId).patch(`/updates/${u.id}`, { doc: v.doc }), { change: true })) ?? false)
        : api(accountId).patch(`/updates/${u.id}`, {
            doc: v.doc,
            ...(v.fileIds.length ? { file_ids: v.fileIds } : {}),
            ...(v.removedFileIds.length ? { remove_file_ids: v.removedFileIds } : {}),
          }),
    onSuccess: (saved) => {
      if (saved === false) return;
      setEditing(false);
      setSecretDoc(null);
      onEdited();
    },
  });
  const mine = u.author?.id === me.user.id;
  // "Seen by": this update / reply counts as seen once it was on screen for a moment (never my own).
  const rootRef = useRef<HTMLDivElement>(null);
  useMarkSeen(rootRef, accountId, u.id, mine);
  // s37reply: the anchor — the linked reply comes into view (inside the card's scroll area) once it is drawn.
  useEffect(() => {
    if (anchored) rootRef.current?.scrollIntoView?.({ block: 'center' });
  }, [anchored]);
  const menu = useActionMenu();
  const entries = toMenuEntries(
    // A secret update is edited from its revealed card (the menu has no text to open).
    updateMenu({
      canReply,
      isAuthor: mine && !editing && !u.secret,
      canDelete: canDelete(u.author?.id),
      secret: u.secret,
    }),
    {
      reply: () => onReply(u.id),
      edit: () => setEditing(true),
      copy_text: () => copyText(u.body_text),
      copy_link: () => copyText(linkOf(u.id)),
      delete: () => onDelete(u.id),
    },
  );
  // mail from outside the account has no author — the sender's name (or address) stands in.
  // a client's question from an interactive document has no author either — the client's name.
  const author = u.author?.name ?? u.document?.name ?? u.email?.name ?? u.email?.from ?? t('activity.system');
  const avatar = (
    <Avatar name={author} url={members.find((m) => m.user_id === u.author?.id)?.avatar_url} size={nested ? 24 : 28} />
  );
  // N17: "לפני 20 דק׳" with the exact time on hover (the system tooltip); "• נערך" after an edit (canvas
  // Item-Updates). s37reply2: the time opens this update alone.
  const stamp = (
    <span>
      <button
        type="button"
        data-testid="update-time"
        data-tip={exactTime(u.created_at)}
        onClick={() => onOpen(u.id)}
        // A 24px tap target (WCAG 2.5.8) without moving the line: taller box, same line height.
        className="-my-1 inline-flex min-h-6 cursor-pointer items-center rounded-[4px] underline-offset-2 hover:text-fg hover:underline focus-visible:underline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
      >
        <time dateTime={u.created_at}>{relativeTime(u.created_at, now)}</time>
      </button>
      {u.edited_at ? ` • ${t('item.edited')}` : ''}
      {/* Plan: an SMS sent from the item, logged as its update — to which number. */}
      {u.email ? (
        <span data-testid="update-email" className="ms-1 text-fg-2" dir="auto">
          •{' '}
          {t(u.email.external ? 'inboundEmail.update.external' : 'inboundEmail.update.member', { from: u.email.from })}
        </span>
      ) : null}
      {/* a reply sent by email from the item — to whom. */}
      {u.email_reply ? (
        <span data-testid="update-email-reply" className="ms-1 text-fg-2" dir="auto">
          • {t('inboundEmail.update.replied', { to: u.email_reply.to })}
        </span>
      ) : null}
      {u.document ? (
        <span data-testid="update-document" className="ms-1 text-info-fg" dir="auto">
          • {t('idoc.update.from', { doc: u.document.doc_name })}
          {u.document.section_title ? ` · ${u.document.section_title}` : ''}
        </span>
      ) : null}
      {u.source === 'sms' ? (
        <span data-testid="update-sms" className="ms-1 font-semibold text-accent-fg">
          • {t('phone.update.sms', { to: u.sms?.to ?? '' })}
        </span>
      ) : null}
    </span>
  );
  const more = (
    <>
      <Button
        variant="ghost"
        size="sm"
        aria-haspopup="menu"
        aria-label={t('update.actions')}
        title={t('menu.actions')}
        onClick={menu.fromTrigger}
        className={cn('shrink-0 px-0 text-muted', nested ? 'h-[1.625rem] w-[1.625rem]' : 'w-8')}
      >
        <DotsIcon />
      </Button>
      <Menu at={menu.at} onClose={menu.close} items={entries} label={t('update.actions')} />
    </>
  );
  const body = (
    <>
      {editing ? (
        // r17reply: a refused save is shown by the composer (an error toast), which keeps the text.
        <Composer
          accountId={accountId}
          members={members}
          autoFocus
          allowFiles={canReply && !u.secret}
          initialFiles={u.files}
          imageSrc={imageSrc}
          initial={u.secret ? secretDoc : ((u.body_json as JSONContent | null) ?? docFromText(u.body_text))}
          placeholder={t('item.writeUpdate')}
          submitLabel={t('common.save')}
          busy={edit.isPending}
          secret={u.secret ? 'forced' : 'off'}
          onCancel={() => {
            setEditing(false);
            setSecretDoc(null);
          }}
          onSubmit={(doc, fileIds, removedFileIds) => edit.mutateAsync({ doc, fileIds, removedFileIds })}
        />
      ) : u.secret ? (
        // a locked card; revealed with a fresh code for a few seconds (its author edits from there).
        <SecretUpdateBody
          accountId={accountId}
          updateId={u.id}
          className={nested ? 'text-sm leading-6' : 'text-[0.875rem] leading-[1.6]'}
          run={stepUp}
          onEdit={
            mine
              ? (shown: SecretUpdateReveal) => {
                  setSecretDoc((shown.body_json as JSONContent | null) ?? docFromText(shown.body_text));
                  setEditing(true);
                }
              : undefined
          }
        />
      ) : (
        // Fix: the update's check boxes tick without opening it for editing —: by anyone
        // who may comment on the item, not only its author.
        <EmailFold watch={u.body_html} enabled={!!u.email}>
          <UpdateBody
            html={u.body_html}
            json={u.body_json}
            className={nested ? 'text-sm leading-6' : 'text-[0.875rem] leading-[1.6]'}
            imageSrc={imageSrc}
            onImage={(ref) => {
              const at = u.files.findIndex((f) => `asset:${f.id}` === ref);
              if (at >= 0) setViewing(at);
            }}
            onToggle={
              mine || canReply
                ? (index, checked) =>
                    api(accountId)
                      .put(`/updates/${u.id}/tasks/${index}`, { checked })
                      .then(() => onEdited())
                : undefined
            }
          />
        </EmailFold>
      )}
      {!editing && u.email?.files ? <EmailFilesLine files={u.email.files} /> : null}
      {/* f9-updedit: while editing, the files show (and come off) in the composer. */}
      {!editing && listed.some(isImage) ? (
        <div className="flex flex-wrap gap-2">
          {listed.filter(isImage).map((f) => (
            <span key={f.id} className="group/att relative" data-testid="update-attachment" data-name={f.name}>
              <ImageThumb accountId={accountId} file={f} onOpen={() => setViewing(u.files.indexOf(f))} />
              {removeButton(f)}
            </span>
          ))}
        </div>
      ) : null}
      {/*: audio and video play right in the update. */}
      {!editing && listed.some(isMedia) ? (
        <div className="flex flex-col gap-2">
          {/* 2+ recordings without text — one click transcribes them all. */}
          <TranscribeAll accountId={accountId} fileIds={listed.filter(isMedia).map((f) => f.id)} />
          {listed.filter(isMedia).map((f) => (
            <span key={f.id} className="group/att relative" data-testid="update-attachment" data-name={f.name}>
              <MediaAttachment accountId={accountId} file={f} onOpen={() => setViewing(u.files.indexOf(f))} />
              {removeButton(f)}
            </span>
          ))}
        </div>
      ) : null}
      {!editing && listed.some((f) => !isImage(f) && !isMedia(f)) ? (
        <div className="flex flex-wrap gap-2">
          {listed
            .filter((f) => !isImage(f) && !isMedia(f))
            .map((f) => (
              <span key={f.id} className="group/att relative" data-testid="update-attachment" data-name={f.name}>
                <button
                  type="button"
                  onClick={() => setViewing(u.files.indexOf(f))}
                  data-testid="update-file"
                  className="flex items-center gap-2 rounded-[10px] border border-line p-2 text-start hover:border-line-strong hover:bg-surface-3"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-[8px] bg-danger-soft text-danger-fg">
                    <Icon name="file" size={16} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-xs font-semibold text-fg">{f.name}</span>
                    <span className="text-xs text-muted" dir="ltr">
                      {formatSize(f.size)}
                    </span>
                  </span>
                </button>
                {removeButton(f)}
              </span>
            ))}
        </div>
      ) : null}
      {/* an update with several files downloads them together as one ZIP. */}
      {!editing && u.files.length > 1 ? (
        <DownloadAllButton accountId={accountId} path={updateZipPath(u.id)} testId="update-download-all" compact />
      ) : null}
      {viewing !== null && u.files.length ? (
        <FileViewer
          accountId={accountId}
          files={u.files as ViewerFile[]}
          startIndex={viewing}
          source={{ kind: 'update', itemId: u.item_id, updateId: u.id, canRemove: canDelete(u.author?.id) }}
          canComment={canReply}
          onRemoved={onEdited}
          onClose={() => setViewing(null)}
        />
      ) : null}
      <Reactions u={u} onReact={(r, on) => onReact(u, r, on)}>
        {canReply ? (
          <Button variant="ghost" size="sm" className="h-[1.625rem] px-2 text-xs" onClick={() => onReply(u.id)}>
            <Icon name="reply" size={14} />
            {t('item.reply')}
          </Button>
        ) : null}
        <span className="ms-auto">
          <SeenBy
            accountId={accountId}
            updateId={u.id}
            seen={u.seen}
            now={now}
            photoOf={(id) => members.find((m) => m.user_id === id)?.avatar_url}
          />
        </span>
      </Reactions>
    </>
  );

  // F4: a reply sits in a soft box (24px avatar, "name time" on one line); the update has a two-line header.
  return nested ? (
    <div
      ref={rootRef}
      id={`update-${u.id}`}
      className={cn(
        'group flex items-start gap-2.5 rounded-[12px] bg-surface-3 p-2.5',
        anchored && 'ring-2 ring-[var(--focus-ring)]',
      )}
      style={{ marginInlineStart: `${(depth - 1) * 1.25}rem` }}
      data-depth={depth}
      data-update-id={u.id}
      data-anchored={anchored ? 'true' : undefined}
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
      data-testid="update-entry"
    >
      {avatar}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 text-xs">
            <b className="font-bold text-fg">{author}</b> <span className="text-muted">{stamp}</span>
          </span>
          {more}
        </div>
        {body}
      </div>
    </div>
  ) : (
    <div
      ref={rootRef}
      id={`update-${u.id}`}
      className="group flex flex-col gap-2.5"
      data-depth={depth}
      data-update-id={u.id}
      onContextMenu={menu.onContextMenu}
      onKeyDown={menu.onKeyDown}
      data-testid="update-entry"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          {avatar}
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-bold text-fg">{author}</span>
            <span className="text-xs text-muted">{stamp}</span>
          </span>
        </span>
        {more}
      </div>
      {body}
    </div>
  );
};

/** ⋯ (three dots) — icons.tsx has no such glyph. */
const DotsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <circle cx="5" cy="12" r="1.3" />
    <circle cx="12" cy="12" r="1.3" />
    <circle cx="19" cy="12" r="1.3" />
  </svg>
);

const UpdateCard = ({
  account,
  me,
  update,
  members,
  canPost,
  canManage,
  secretEnabled,
  now,
  linkOf,
  onOpen,
  anchor = null,
  onChanged,
  onDeleted,
}: {
  account: MyAccount;
  me: Me;
  update: UpdateDto;
  members: Member[];
  canPost: boolean;
  canManage: boolean;
  /** The board lets people write secret updates (a reply may be one). */
  secretEnabled: boolean;
  now: number;
  linkOf: (id: string) => string;
  onOpen: (id: string) => void;
  /** s37reply: the reply a link pointed at (scrolled to and marked). */
  anchor?: string | null;
  onChanged: () => void;
  /** An update or reply was deleted (the board's update counts change). */
  onDeleted: () => void;
}) => {
  /** The update or reply being answered (its composer opens under it). */
  const [replying, setReplying] = useState<string | null>(null);
  const client = api(account.id);
  const react = useMutation({
    mutationFn: (v: { id: string; reaction: Reaction; on: boolean }) =>
      v.on
        ? client.put(`/updates/${v.id}/reactions/${v.reaction}`, {})
        : client.delete(`/updates/${v.id}/reactions/${v.reaction}`),
    onSuccess: onChanged,
  });
  const deleted = useDeletedToast(account.id);
  // a secret update's reveal, edit and delete may ask for a fresh two-factor code (one dialog).
  const stepUp = useSecretStepUp(account);
  const remove = useMutation({
    mutationFn: (id: string) => stepUp.run(() => client.delete<Deleted>(`/updates/${id}`), { change: true }),
    onSuccess: (res) => {
      if (!res) return;
      deleted(t('item.update'), res);
      onChanged();
      onDeleted();
    },
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });
  const reply = useMutation({
    mutationFn: async (v: { to: string; doc: JSONContent; fileIds: string[]; secret: boolean }) =>
      (await stepUp.run(() =>
        client.post(`/updates/${v.to}/replies`, {
          doc: v.doc,
          file_ids: v.fileIds,
          ...(v.secret ? { secret: true } : {}),
        }),
      )) ?? false,
    onSuccess: (sent) => {
      if (sent === false) return;
      setReplying(null);
      onChanged();
    },
  });
  // Depth of each reply (they come in thread order with the update they answer).
  const depthOf = new Map<string, number>([[update.id, 0]]);
  for (const r of update.replies) depthOf.set(r.id, (depthOf.get(r.parent_update_id) ?? 0) + 1);
  /** The last entry of `id`'s subtree: a reply composer goes right after it. */
  const lastOfThread = (id: string) => {
    let last = id;
    for (const r of update.replies) if (ancestors(r.id).includes(id)) last = r.id;
    return last;
  };
  const ancestors = (id: string): string[] => {
    const r = update.replies.find((x) => x.id === id);
    return r ? [r.parent_update_id, ...ancestors(r.parent_update_id)] : [];
  };
  const composerAfter = replying ? lastOfThread(replying) : null;
  // A reply anywhere in a secret thread is secret (the server says the same); else the lock is offered when allowed.
  const secretThread = (id: string) =>
    !!update.secret || [id, ...ancestors(id)].some((x) => update.replies.find((r) => r.id === x)?.secret);
  const replySecret = replying && secretThread(replying) ? 'forced' : secretEnabled ? 'optional' : 'off';
  const replyComposer = (
    <div style={{ marginInlineStart: `${Math.min(depthOf.get(replying ?? '') ?? 0, MAX_REPLY_DEPTH - 1) * 1.25}rem` }}>
      <Composer
        key={replying}
        accountId={account.id}
        members={members}
        autoFocus
        draftKey={replying ? makeDraftKey(account.id, 'reply', replying) : undefined}
        placeholder={t('item.writeReply')}
        submitLabel={t('item.reply')}
        busy={reply.isPending}
        secret={replySecret}
        onCancel={() => setReplying(null)}
        onSubmit={(doc, fileIds, _removed, secret) => reply.mutateAsync({ to: replying!, doc, fileIds, secret })}
      />
    </div>
  );
  const canDelete = (authorId: string | undefined) => authorId === me.user.id || account.role === 'admin' || canManage;
  const entryProps = {
    accountId: account.id,
    me,
    members,
    now,
    canDelete,
    canReply: canPost,
    linkOf,
    onOpen,
    onReact: (u: UpdateEntry, reaction: Reaction, on: boolean) => react.mutate({ id: u.id, reaction, on }),
    onDelete: (id: string) =>
      void confirmDialog({ title: t('item.deleteUpdate'), danger: true }).then((ok) => ok && remove.mutate(id)),
    onReply: (id: string) => setReplying((r) => (r === id ? null : id)),
    onEdited: onChanged,
    stepUp: stepUp.run,
  };

  return (
    <article className="flex flex-col gap-2.5 rounded-[var(--radius-lg)] border border-line bg-surface p-4">
      {stepUp.dialog}
      <Entry u={update} {...entryProps} />
      {composerAfter === update.id ? replyComposer : null}
      {update.replies.map((r) => (
        <Fragment key={r.id}>
          <Entry u={r} depth={depthOf.get(r.id)} anchored={anchor === r.id} {...entryProps} />
          {composerAfter === r.id ? replyComposer : null}
        </Fragment>
      ))}
    </article>
  );
};

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------
const Activity = ({
  account,
  board,
  itemId,
}: {
  account: MyAccount;
  board: BoardDetail | undefined;
  itemId: string;
}) => {
  const activity = useQuery({
    queryKey: ['account', account.id, 'item', itemId, 'activity'],
    queryFn: () => api(account.id).get<{ data: ActivityEntry[] }>(`/items/${itemId}/activity`),
  });
  const titleOf = (key: string | null) => board?.columns.find((c) => c.id === key)?.title ?? key ?? '';
  // Before → after of each change, as the column shows its values.
  const members = useMembers(account.id).data?.data;
  const changeCtx = board ? { columns: board.columns, groups: board.groups, members: members ?? [] } : undefined;
  if (activity.isPending) return <SkeletonRows rows={4} label={t('app.loading')} />;
  if (activity.isError) return <Notice tone="error">{errorMessage(activity.error)}</Notice>;
  if (!activity.data.data.length) return <p className="text-sm text-muted">{t('item.noActivity')}</p>;
  return (
    <ol className="overflow-hidden rounded-[14px] border border-line">
      {activity.data.data.map((e) => (
        <ActivityRow key={e.id} accountId={account.id} entry={e} columnTitle={titleOf} changeCtx={changeCtx} />
      ))}
    </ol>
  );
};
