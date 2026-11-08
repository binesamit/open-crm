// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BOARD_DESCRIPTION_MAX,
  nextGroupColor,
  normalizeLabelColor,
  t,
  type ExportRequest,
  type GroupColor,
} from '@bines/shared';
import { Button, cn, Dialog, Menu, type MenuEntry, Notice, useActionMenu } from '@bines/ui';
import { api, errorMessage } from '../../../lib/api';
import { Icon } from '../../../lib/icons';
import { ColorGrid } from '../../../lib/label-color';
import { isTyping } from '../../../lib/keys';
import { usePlanGate } from '../../../lib/plan-gate';
import { gateMenuEntry } from '../../../lib/plan-limit';
import { useDesktop } from '../../../lib/use-desktop';
import { AutomationsButton, AutomationsDialog } from '../../automations/AutomationsDialog';
import { ScenariosDialog } from '../../scenarios/ScenariosDialog';
import { AssistantButton, AssistantPanel } from '../../ai2/AssistantPanel';
import { promptDialog } from '../../../lib/dialogs';
import { useBoardNotifications } from '../../notifications/BoardNotificationsButton';
import { TimeReportDialog } from '../../time/TimeReportDialog';
import { BoardActivityDialog } from '../ActivityLog';
import { TemplateEditBanner } from '../../account/Templates';
import { type BoardDetail, boardKeys, type useBoardMutations } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { exportMenuEntry } from '../ExportButton';
import { Popover, PopoverSheetContext } from '../cells/Popover';
import { BAR_BTN, MobileBarHost } from './MobileBoardBar';
import { PermissionsDialog } from '../PermissionsDialog';
import { BoardSecretUpdatesDialog } from '../../secrets/SecretUpdatesSettings';
import { InboundAddressDialog } from '../../inbound-email/InboundAddress';
import { BulkEditDialog } from '../bulk/BulkEditDialog';
import type { FilterCtx } from '../toolbar/FilterPanel';
import { useOpenItem } from '../open-item';
import { useExtensionActions } from '../../extensions/ExtensionSlots';
import { useItemTemplates } from '../../item-templates/item-templates-api';
import { openItemTemplates } from '../../item-templates/store';
import { BoardViewersButton, BoardViewersDialog, useBoardViewers, useReportBoardOpen } from './BoardViewers';

/**
 * The board header (11-UI §2, F4 `.ph`): the title (double-click renames), then who viewed it (r18boardviews),
 * "אוטומציות", one ⋯ menu for everything else (N20 — activity log, permissions, export, time report and the
 * board's notifications) and the split "+ add item" button whose arrow adds a group (N21). r23ui
 * the members' avatars that opened the permissions are gone — permissions open from ⋯ → "הרשאות" only.
 * Phones (fix): one compact bar in the shell's top bar — `phoneBar` (the board's name with the
 * view switch, search, tools) then ⋯ and "+" as icons; the description opens from ⋯.
 */
export const BoardHeader = ({
  board,
  filterCtx,
  onRename,
  onNewItem,
  creating,
  mutations: m,
  exportRequest,
  phoneBar,
}: {
  board: BoardDetail;
  filterCtx: FilterCtx;
  onRename: (name: string) => void;
  /** The header's "+ add item" (F4): a new item at the top of the first group; absent without permission. */
  onNewItem?: () => void;
  creating: boolean;
  mutations: ReturnType<typeof useBoardMutations>;
  /** What "export" downloads: the view's query and visible columns. */
  exportRequest: () => Partial<ExportRequest>;
  /** Phones: the bar's own part (view switch, search, tools); told whether the search field is open. */
  phoneBar?: (search: { open: boolean; setOpen: (open: boolean) => void }) => ReactNode;
}) => {
  const [editing, setEditing] = useState(false);
  const [perms, setPerms] = useState(false);
  /** the board's secret-update settings (its own, or the account's). */
  const [secretUpdates, setSecretUpdates] = useState(false);
  const [inboundAddress, setInboundAddress] = useState(false);
  const [report, setReport] = useState(false);
  const [log, setLog] = useState(false);
  const [automations, setAutomations] = useState(false);
  // phase 3: the board's scenarios (graph automations).
  const [scenarios, setScenarios] = useState(false);
  // Phones: the bar's search field is open (it takes the whole bar); the add-group sheet; the assistant.
  const [searching, setSearching] = useState(false);
  const [addingGroup, setAddingGroup] = useState(false);
  const [assistant, setAssistant] = useState(false);
  // phones keep the description out of the way — ⋯ → "תיאור הבורד" opens it.
  const [describing, setDescribing] = useState(false);
  // "ייבוא ועריכה" (12-ROADMAP B1/B2; "עריכה גדולה" until): the view's query and columns as the sheet opens.
  const [bulk, setBulk] = useState<Partial<ExportRequest> | null>(null);
  const { id: accountId, slug: accountSlug, meId } = useContext(BoardAccountContext);
  const canUpdate = !!board.capabilities['board.update'];
  const aiGate = usePlanGate(accountId, 'ai');
  const desktop = useDesktop();
  const notifications = useBoardNotifications(accountId, board.id);
  const more = useActionMenu();
  // r18boardviews: count this open; "צפו בבורד" (header on desktop, ⋯ on phones) when the account shows it.
  const [viewersOpen, setViewersOpen] = useState(false);
  useReportBoardOpen(accountId, board.id);
  const viewersOn = !!useBoardViewers(accountId, board.id).data?.pages[0]?.enabled;
  // Installed extensions' board actions (D27 ת3): at the end of ⋯, each opens its page in a modal frame.
  const openItem = useOpenItem(board.id);
  const extActions = useExtensionActions({
    accountId,
    boardId: board.id,
    meId,
    where: 'board',
    itemIds: [],
    onOpenItem: openItem,
  });
  // Ctrl+Shift+L opens the activity log (07 §10).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || !(e.ctrlKey || e.metaKey) || !e.shiftKey || e.key.toLowerCase() !== 'l') return;
      e.preventDefault();
      setLog(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Time is logged on the board's time columns or its subitems' (D14).
  const tracksTime = board.columns.some((c) => c.type === 'time_tracking') || !!board.subitems_board_id;
  const canAutomate = !!board.capabilities['automation.read'];
  const canAddGroup = !!board.capabilities['group.create'];
  // Board owners and admins (board.update) who may edit items; a sheet needs a desktop screen.
  const canBulkEdit = desktop && canUpdate && !!board.capabilities['item.update'] && !board.archived_at;

  const item = board.item_terminology === 'item' ? t('board.itemDefault') : board.item_terminology;
  const entries: MenuEntry[] = [
    // Phones: what the one-row bar has no room for — rename, add a group, the assistant (fix).
    ...(!desktop && canUpdate
      ? [
          {
            label: t('mobilehead.renameBoard'),
            icon: <Icon name="edit" size={16} />,
            testId: 'board-rename',
            onSelect: () =>
              void promptDialog({
                title: t('mobilehead.renameBoard'),
                label: t('mobilehead.boardName'),
                initial: board.name,
              }).then((name) => {
                if (name?.trim() && name.trim() !== board.name) onRename(name.trim());
              }),
          },
        ]
      : []),
    // Product decision: no description line above the rows on phones; it opens from ⋯.
    ...(!desktop && (board.description || canUpdate)
      ? [
          {
            label: board.description ? t('board.description.title') : t('board.description.add'),
            icon: <Icon name="info" size={16} />,
            testId: 'board-description-open',
            onSelect: () => setDescribing(true),
          },
        ]
      : []),
    ...(!desktop && canAddGroup && onNewItem
      ? [
          {
            label: t('board.addGroup'),
            icon: <Icon name="group" size={16} />,
            testId: 'add-group-open',
            onSelect: () => setAddingGroup(true),
          },
        ]
      : []),
    ...(!desktop
      ? [
          gateMenuEntry(aiGate, {
            label: t('ai2.assistant.title'),
            icon: <Icon name="sparkle" size={16} />,
            testId: 'board-assistant',
            onSelect: () => setAssistant(true),
          }),
        ]
      : []),
    // Phones have no room for "אוטומציות" next to the add button (F4 .m): it moves into the menu.
    ...(!desktop && canAutomate
      ? [{ label: t('auto.button'), icon: <Icon name="bolt" size={16} />, onSelect: () => setAutomations(true) }]
      : []),
    {
      label: t('activity.button'),
      icon: <Icon name="history" size={16} />,
      shortcut: 'Ctrl+Shift+L',
      testId: 'board-activity-open',
      onSelect: () => setLog(true),
    },
    ...(canAutomate
      ? [
          {
            label: t('scenario.menu'),
            icon: <Icon name="split" size={16} />,
            testId: 'board-scenarios',
            onSelect: () => setScenarios(true),
          },
        ]
      : []),
    // the board's item templates (make items from one; save / edit / delete who may change setup).
    {
      label: t('itemTemplates.menu'),
      icon: <Icon name="template" size={16} />,
      testId: 'board-item-templates',
      onSelect: () => openItemTemplates({ kind: 'manage', boardId: board.id }),
    },
    {
      label: t('perm.button'),
      icon: <Icon name="lock" size={16} />,
      testId: 'board-permissions',
      onSelect: () => setPerms(true),
    },
    ...(canUpdate
      ? [
          {
            label: t('secretUpdates.board.menu'),
            icon: <Icon name="key" size={16} />,
            testId: 'board-secret-updates',
            onSelect: () => setSecretUpdates(true),
          },
          // mail to the board's address becomes a new item.
          {
            label: t('inboundEmail.board.menu'),
            icon: <Icon name="mail" size={16} />,
            testId: 'board-inbound-address',
            onSelect: () => setInboundAddress(true),
          },
        ]
      : []),
    {
      ...exportMenuEntry(accountId, board.id, exportRequest, !!board.subitems_board_id),
      testId: 'toolbar-export',
    } as MenuEntry,
    ...(tracksTime
      ? [
          {
            label: t('timeReport.button'),
            icon: <Icon name="clock" size={16} />,
            testId: 'board-time-report',
            onSelect: () => setReport(true),
          },
        ]
      : []),
    { ...notifications.entry, testId: 'board-notifications' },
    ...(!desktop && viewersOn
      ? [
          {
            label: t('boardviewers.menu'),
            icon: <Icon name="eye" size={16} />,
            testId: 'board-viewers-open',
            onSelect: () => setViewersOpen(true),
          },
        ]
      : []),
    ...(canBulkEdit
      ? [
          {
            label: t('bulk.menu'),
            icon: <Icon name="table" size={16} />,
            testId: 'board-bulk-edit',
            onSelect: () => setBulk(exportRequest()),
          },
        ]
      : []),
    ...extActions.entries,
  ];

  const dialogs = (
    <>
      {report ? <TimeReportDialog accountId={accountId} board={board} onClose={() => setReport(false)} /> : null}
      {perms ? <PermissionsDialog accountId={accountId} board={board} onClose={() => setPerms(false)} /> : null}
      {secretUpdates ? (
        <BoardSecretUpdatesDialog
          account={{ id: accountId, slug: accountSlug }}
          boardId={board.id}
          onClose={() => setSecretUpdates(false)}
        />
      ) : null}
      {inboundAddress ? (
        <InboundAddressDialog
          accountId={accountId}
          kind="board"
          id={board.id}
          onClose={() => setInboundAddress(false)}
        />
      ) : null}
      {log ? <BoardActivityDialog accountId={accountId} board={board} onClose={() => setLog(false)} /> : null}
      {automations ? (
        <AutomationsDialog board={board} filterCtx={filterCtx} onClose={() => setAutomations(false)} />
      ) : null}
      {scenarios ? (
        <ScenariosDialog
          accountId={accountId}
          board={board}
          filterCtx={filterCtx}
          onClose={() => setScenarios(false)}
        />
      ) : null}
      {notifications.dialog}
      {extActions.dialog}
      {describing ? (
        <DescriptionDialog
          accountId={accountId}
          board={board}
          canEdit={canUpdate}
          onClose={() => setDescribing(false)}
        />
      ) : null}
      {bulk ? <BulkEditDialog board={board} filterCtx={filterCtx} view={bulk} onClose={() => setBulk(null)} /> : null}
      {viewersOpen ? (
        <BoardViewersDialog
          accountId={accountId}
          boardId={board.id}
          boardName={board.name}
          meId={meId}
          onClose={() => setViewersOpen(false)}
        />
      ) : null}
    </>
  );
  const moreDots = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );

  if (!desktop)
    return (
      <>
        <TemplateEditBanner account={{ id: accountId, slug: accountSlug }} board={board} />
        <MobileBarHost>
          {phoneBar?.({ open: searching, setOpen: setSearching })}
          {searching ? null : (
            <>
              {/* The anchor of the add-group sheet (a bottom sheet on phones). */}
              <div className="relative shrink-0">
                <button
                  type="button"
                  className={BAR_BTN}
                  aria-label={t('board.more')}
                  title={t('board.more')}
                  aria-haspopup="menu"
                  data-testid="board-more"
                  data-tour="board.more"
                  data-notif-mode={notifications.mode}
                  data-notif-muted={notifications.silent ? 'true' : 'false'}
                  onClick={more.fromTrigger}
                >
                  {moreDots}
                </button>
                <PopoverSheetContext.Provider value>
                  <Popover open={addingGroup} onClose={() => setAddingGroup(false)} className="p-3">
                    {addingGroup ? (
                      <AddGroupPanel board={board} mutations={m} onDone={() => setAddingGroup(false)} />
                    ) : null}
                  </Popover>
                </PopoverSheetContext.Provider>
              </div>
              <Menu at={more.at} onClose={more.close} label={t('board.more')} items={entries} />
              {onNewItem ? (
                <button
                  type="button"
                  data-testid="board-new-item"
                  data-tour="board.new-item"
                  aria-label={t('board.newItem', { item })}
                  title={t('board.newItem', { item })}
                  disabled={creating}
                  onClick={onNewItem}
                  className="ms-0.5 grid size-9 shrink-0 place-items-center rounded-[10px] bg-accent text-on-accent hover:brightness-105 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)] disabled:opacity-60"
                >
                  <Icon name="plus" size={18} strokeWidth={2.4} />
                </button>
              ) : canAddGroup ? (
                <button
                  type="button"
                  data-testid="add-group-open"
                  aria-label={t('board.addGroupOpen')}
                  title={t('board.addGroupOpen')}
                  aria-haspopup="dialog"
                  aria-expanded={addingGroup}
                  onClick={() => setAddingGroup(true)}
                  className="ms-0.5 grid size-9 shrink-0 place-items-center rounded-[10px] bg-accent text-on-accent hover:brightness-105"
                >
                  <Icon name="plus" size={18} strokeWidth={2.4} />
                </button>
              ) : null}
            </>
          )}
        </MobileBarHost>
        {assistant ? (
          <AssistantPanel
            accountId={accountId}
            slug={accountSlug}
            boardId={board.id}
            title={board.name}
            onClose={() => setAssistant(false)}
          />
        ) : null}
        {dialogs}
      </>
    );

  return (
    <>
      {/* A template's working board (fix3): its "save to template / cancel" bar, from the server mark. */}
      <TemplateEditBanner account={{ id: accountId, slug: accountSlug }} board={board} />
      {/* Phones: the title takes its own full row; the actions go on the row below it, never squeezing the title. */}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 px-6 pt-5 pb-4">
        <div className="min-w-0 flex-1 max-md:basis-full">
          {editing && board.capabilities['board.update'] ? (
            <input
              autoFocus
              defaultValue={board.name}
              onBlur={(e) => {
                setEditing(false);
                if (e.target.value.trim() && e.target.value !== board.name) onRename(e.target.value.trim());
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                if (e.key === 'Escape') setEditing(false);
              }}
              className="w-full bg-transparent font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading outline-none max-sm:text-2xl"
            />
          ) : (
            <h1
              data-tour="board.title"
              className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] max-sm:text-2xl"
              onDoubleClick={() => setEditing(true)}
            >
              {board.name}
            </h1>
          )}
          <BoardDescription board={board} />
        </div>
        <div className="flex flex-wrap items-center gap-2 max-md:w-full max-md:justify-start">
          {desktop ? <BoardViewersButton accountId={accountId} boardId={board.id} meId={meId} /> : null}
          {desktop ? <AutomationsButton board={board} filterCtx={filterCtx} /> : null}
          <AssistantButton accountId={accountId} slug={accountSlug} boardId={board.id} title={board.name} />
          <Button
            variant="secondary"
            size="sm"
            className="w-8 px-0"
            aria-label={t('board.more')}
            title={t('board.more')}
            aria-haspopup="menu"
            data-testid="board-more"
            data-tour="board.more"
            data-notif-mode={notifications.mode}
            data-notif-muted={notifications.silent ? 'true' : 'false'}
            onClick={more.fromTrigger}
          >
            {moreDots}
          </Button>
          <Menu at={more.at} onClose={more.close} label={t('board.more')} items={entries} />
          {onNewItem || canAddGroup ? (
            <AddSplit board={board} onNewItem={onNewItem} creating={creating} canAddGroup={canAddGroup} mutations={m} />
          ) : null}
        </div>
        {dialogs}
      </div>
    </>
  );
};

/**
 * The description (fix3): one line; a click opens all of it (edited there with board.update). Desktop only — on
 * phones it opens from the header's ⋯.
 */
export const BoardDescription = ({ board }: { board: BoardDetail }) => {
  const [open, setOpen] = useState(false);
  const { id: accountId } = useContext(BoardAccountContext);
  const canUpdate = !!board.capabilities['board.update'];
  return (
    <>
      {board.description ? (
        <button
          type="button"
          data-testid="board-description"
          title={t('board.description.open')}
          onClick={() => setOpen(true)}
          className="mt-0.5 block w-full max-w-[720px] truncate text-start text-sm text-muted hover:text-fg-2"
        >
          {board.description}
        </button>
      ) : canUpdate ? (
        <button
          type="button"
          data-testid="board-description-add"
          onClick={() => setOpen(true)}
          className="mt-0.5 text-sm text-muted hover:text-fg-2 hover:underline"
        >
          {t('board.description.add')}
        </button>
      ) : null}
      {open ? (
        <DescriptionDialog accountId={accountId} board={board} canEdit={canUpdate} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
};

/** The board's full description (fix3): read here, or edited by whoever may update the board. */
const DescriptionDialog = ({
  accountId,
  board,
  canEdit,
  onClose,
}: {
  accountId: string;
  board: BoardDetail;
  canEdit: boolean;
  onClose: () => void;
}) => {
  const qc = useQueryClient();
  const [text, setText] = useState(board.description ?? '');
  const save = useMutation({
    mutationFn: (description: string | null) => api(accountId).patch(`/boards/${board.id}`, { description }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: boardKeys.board(accountId, board.id) });
      onClose();
    },
  });
  return (
    <Dialog
      open
      title={t('board.description.title')}
      subtitle={board.name}
      onClose={onClose}
      footer={
        canEdit ? (
          <>
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="board-description-save"
              busy={save.isPending}
              onClick={() => save.mutate(text.trim() || null)}
            >
              {t('common.save')}
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
        )
      }
    >
      <div data-testid="board-description-dialog" className="space-y-2">
        {canEdit ? (
          <textarea
            autoFocus
            rows={8}
            maxLength={BOARD_DESCRIPTION_MAX}
            value={text}
            placeholder={t('board.description.placeholder')}
            aria-label={t('board.description.title')}
            data-testid="board-description-input"
            onChange={(e) => setText(e.target.value)}
            className="w-full resize-y rounded-[10px] border border-line-strong bg-surface px-2.5 py-2 text-sm leading-relaxed text-fg placeholder:text-muted focus:border-primary focus:ring-3 focus:ring-[var(--accent-soft)] focus:outline-none"
          />
        ) : (
          <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg" data-testid="board-description-full">
            {board.description}
          </p>
        )}
        {save.isError ? <Notice tone="error">{errorMessage(save.error)}</Notice> : null}
      </div>
    </Dialog>
  );
};

/**
 * N21: "+ add item" as a split button — the main part adds an item as before; the arrow opens a small panel that
 * adds a group (name + colour from the group palette), on top of the board.
 */
const AddSplit = ({
  board,
  onNewItem,
  creating,
  canAddGroup,
  mutations: m,
}: {
  board: BoardDetail;
  onNewItem?: () => void;
  creating: boolean;
  canAddGroup: boolean;
  mutations: ReturnType<typeof useBoardMutations>;
}) => {
  const [open, setOpen] = useState(false);
  const item = board.item_terminology === 'item' ? t('board.itemDefault') : board.item_terminology;
  // with item templates on the board, ▾ lists them (and a new group); without, it adds a group.
  const { id: accountId } = useContext(BoardAccountContext);
  const templates = useItemTemplates(accountId, board.id, !!onNewItem).data ?? [];
  const withTemplates = !!onNewItem && templates.length > 0;
  const menu = useActionMenu();
  const categories = [...new Set(templates.map((x) => x.category))];
  const templateEntries: MenuEntry[] = [
    ...categories.flatMap((c): MenuEntry[] => [
      { kind: 'label', label: c || t('itemTemplates.fromTemplate') },
      ...templates
        .filter((x) => x.category === c)
        .map((x) => ({
          label: x.name,
          icon: <Icon name="template" size={16} />,
          testId: 'board-new-from-template',
          onSelect: () => openItemTemplates({ kind: 'apply', boardId: board.id, templateId: x.id }),
        })),
    ]),
    { kind: 'separator' },
    {
      label: t('itemTemplates.manage'),
      testId: 'board-item-templates-manage',
      onSelect: () => openItemTemplates({ kind: 'manage', boardId: board.id }),
    },
    ...(canAddGroup
      ? [{ label: t('board.addGroup'), testId: 'add-group-from-menu', onSelect: () => setOpen(true) }]
      : []),
  ];
  return (
    <div className="relative flex items-stretch">
      {onNewItem ? (
        <Button
          variant="accent"
          busy={creating}
          data-testid="board-new-item"
          data-tour="board.new-item"
          className={cn((canAddGroup || withTemplates) && 'rounded-e-none')}
          onClick={onNewItem}
        >
          {creating ? null : <Icon name="plus" size={15} strokeWidth={2.4} />}
          {t('board.newItem', { item })}
        </Button>
      ) : null}
      {withTemplates ? (
        <>
          <Button
            variant="accent"
            data-testid="board-new-item-more"
            aria-label={t('itemTemplates.newItemMore')}
            title={t('itemTemplates.newItemMore')}
            aria-haspopup="menu"
            onClick={menu.fromTrigger}
            className="w-8 rounded-s-none border-s border-[color-mix(in_srgb,var(--on-accent)_22%,transparent)] px-0"
          >
            <Icon name="chevronDown" size={15} strokeWidth={2.2} />
          </Button>
          <Menu at={menu.at} onClose={menu.close} items={templateEntries} label={t('itemTemplates.newItemMore')} />
        </>
      ) : canAddGroup ? (
        <Button
          variant="accent"
          data-testid="add-group-open"
          aria-label={t('board.addGroupOpen')}
          title={t('board.addGroupOpen')}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={cn(
            'w-8 px-0',
            onNewItem && 'rounded-s-none border-s border-[color-mix(in_srgb,var(--on-accent)_22%,transparent)]',
          )}
        >
          {onNewItem ? <Icon name="chevronDown" size={15} strokeWidth={2.2} /> : <Icon name="plus" size={15} />}
        </Button>
      ) : null}
      <Popover open={open} onClose={() => setOpen(false)} align="end" className="w-64 p-3">
        {open ? <AddGroupPanel board={board} mutations={m} onDone={() => setOpen(false)} /> : null}
      </Popover>
    </div>
  );
};

const AddGroupPanel = ({
  board,
  mutations: m,
  onDone,
}: {
  board: BoardDetail;
  mutations: ReturnType<typeof useBoardMutations>;
  onDone: () => void;
}) => {
  // The next colour no group uses yet — what the server would pick — chosen up front.
  const [color, setColor] = useState<GroupColor>(() =>
    nextGroupColor(board.groups.map((g) => normalizeLabelColor(g.color))),
  );
  const [title, setTitle] = useState(() => t('board.newGroup'));
  const submit = () => {
    const name = title.trim();
    if (!name) return;
    m.createGroup.mutate(
      { title: name, color },
      {
        onSuccess: onDone,
      },
    );
  };
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="add-group-panel"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="font-display text-[0.9375rem] font-bold text-heading">{t('board.addGroup')}</div>
      <label className="flex flex-col gap-1 text-xs font-semibold text-fg-2">
        {t('board.groupName')}
        <input
          autoFocus
          value={title}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setTitle(e.target.value)}
          data-testid="add-group-name"
          className="h-9 rounded-[10px] border border-line-strong bg-surface px-2.5 text-sm font-normal text-fg outline-none focus:border-heading focus:ring-3 focus:ring-[var(--accent-soft)]"
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold text-fg-2" id="add-group-color-label">
          {t('board.groupColor')}
        </span>
        {/* pal40: all forty colours, the app's colour picker. */}
        <ColorGrid
          kind="radio"
          size="md"
          label={t('board.groupColor')}
          testId="add-group-colors"
          itemTestId="add-group-color"
          selected={(k) => color === k}
          onPick={setColor}
          itemClassName={(_, on) => cn('ring-offset-2 ring-offset-[var(--surface)]', on && 'ring-2 ring-heading')}
        />
      </div>
      <Button
        type="submit"
        size="sm"
        busy={m.createGroup.isPending}
        disabled={!title.trim()}
        data-testid="add-group-submit"
        className="self-end"
      >
        {t('board.addGroupSubmit')}
      </Button>
    </form>
  );
};
