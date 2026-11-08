// SPDX-License-Identifier: AGPL-3.0-only
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { EXT_VIEW_MAX_BOARDS, getLocale, t, type ViewSettings } from '@bines/shared';
import { Button, Dialog, Notice, SkeletonRows } from '@bines/ui';
import { promptDialog } from '../../lib/dialogs';
import { showToast } from '../../lib/toast';
import { useDesktop } from '../../lib/use-desktop';
import { useOfflineCapablePage } from '../../pwa/PwaHosts';
import { useMembers, useReadableBoards } from '../board/board-api';
import { useOpenItem } from '../board/open-item';
import { useViewMutations, type View } from '../board/views/views-api';
import { AppFrame } from './AppFrame';
import { useExtensionBoardViews } from './extensions-api';

/**
 * A view tab of type `extension` (D27 ת2): the extension's page for this board, in its sandboxed frame.
 * the tab may also use more boards, picked by a person in our own dialog when the page asks
 * (`pickBoards`) and saved on the tab (`settings.extension.board_ids`); on a phone the frame takes the screen's
 * height below the board's bar, so a full-screen app (a workout timer) fits without a page scroll around it.
 */
export const ExtensionBoardView = ({
  accountId,
  boardId,
  settings,
  meId,
  view,
}: {
  accountId: string;
  boardId: string;
  settings: ViewSettings;
  meId: string;
  /** The tab (its id goes with the token: the boards picked for it). */
  view?: View;
}) => {
  const views = useExtensionBoardViews(accountId, boardId);
  const me = useMembers(accountId).data?.data.find((m) => m.user_id === meId);
  const openItem = useOpenItem(boardId);
  const desktop = useDesktop();
  const sel = settings.extension;
  const [picking, setPicking] = useState<((ids: string[] | null) => void) | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [phoneHeight, setPhoneHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (desktop) return;
    const measure = () => {
      const top = box.current?.getBoundingClientRect().top ?? 0;
      setPhoneHeight(Math.max(420, Math.round(window.innerHeight - Math.max(0, top))));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [desktop]);

  const v = sel && views.data?.data.find((x) => x.installation_id === sel.installation_id && x.feature === sel.feature);
  useOfflineCapablePage(!!v?.offline);
  if (views.isLoading) return <SkeletonRows rows={6} label={t('app.loading')} />;
  if (!v)
    return (
      <div className="p-2" data-testid="ext-view-unavailable">
        <Notice tone="warn">{t('ext.view.unavailable')}</Notice>
      </div>
    );
  const frame = (
    <AppFrame
      accountId={accountId}
      view={v}
      place={view ? { board_id: boardId, view_id: view.id } : { board_id: boardId }}
      context={{ surface: 'board_view', board_id: boardId }}
      user={{ id: meId, name: me?.name ?? '' }}
      onOpenItem={openItem}
      fill={!desktop && phoneHeight !== null}
      onPickBoards={view ? () => new Promise((resolve) => setPicking(() => resolve)) : undefined}
    />
  );
  return (
    <>
      <div
        ref={box}
        data-testid="ext-view-box"
        style={!desktop && phoneHeight !== null ? { height: phoneHeight } : undefined}
        className={!desktop && phoneHeight !== null ? 'flex flex-col' : undefined}
      >
        {frame}
      </div>
      {picking && view ? (
        <PickBoardsDialog
          accountId={accountId}
          boardId={boardId}
          view={view}
          extensionName={v.extension_name}
          onDone={(ids) => {
            picking(ids);
            setPicking(null);
          }}
        />
      ) : null}
    </>
  );
};

/**
 * "Which boards may this tab use?" — the app's own dialog (never the extension's page): ticks over the boards the
 * person reads, saved on the tab. The server still keeps only those each viewer reads and the installation is
 * allowed on, so a tab shared with someone who cannot see a board gives them nothing more.
 */
const PickBoardsDialog = ({
  accountId,
  boardId,
  view,
  extensionName,
  onDone,
}: {
  accountId: string;
  boardId: string;
  view: View;
  extensionName: string;
  onDone: (ids: string[] | null) => void;
}) => {
  const boards = useReadableBoards(accountId);
  const mutations = useViewMutations(accountId, boardId);
  const ext = view.settings.extension;
  const [chosen, setChosen] = useState<string[]>(() => ext?.board_ids ?? []);
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    // The boards picked so far first (in their order), then the rest.
    const picked = new Set(ext?.board_ids ?? []);
    const all = (boards.data?.data ?? [])
      .filter((b) => b.id !== boardId)
      .sort((a, b) => Number(picked.has(b.id)) - Number(picked.has(a.id)));
    const needle = q.trim().toLowerCase();
    return needle
      ? all.filter((b) => b.name.toLowerCase().includes(needle) || b.workspace_name.toLowerCase().includes(needle))
      : all;
  }, [boards.data, boardId, q, ext?.board_ids]);
  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= EXT_VIEW_MAX_BOARDS ? c : [...c, id]));
  const save = async () => {
    if (!ext) return onDone(null);
    try {
      await mutations.save.mutateAsync({
        view,
        settings: { ...view.settings, extension: { ...ext, board_ids: chosen } },
      });
      onDone(chosen);
    } catch {
      showToast({ message: t('ext.boards.saveFailed'), tone: 'error' });
    }
  };
  const en = getLocale() === 'en';
  return (
    <Dialog
      open
      title={t('ext.boards.title')}
      subtitle={extensionName}
      onClose={() => onDone(null)}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onDone(null)}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={mutations.save.isPending} data-testid="ext-boards-save">
            {t('common.save')}
          </Button>
        </div>
      }
    >
      <div className="space-y-2" data-testid="ext-boards-dialog">
        <p className="text-sm text-fg-2">{t('ext.boards.hint', { app: extensionName })}</p>
        <input
          className="h-9 w-full rounded-[var(--radius-sm)] border border-line-strong bg-surface px-2 text-sm"
          placeholder={t('ext.boards.search')}
          aria-label={t('ext.boards.search')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {boards.isLoading ? (
          <SkeletonRows rows={4} label={t('app.loading')} />
        ) : (
          <ul className="max-h-[50vh] space-y-0.5 overflow-y-auto">
            {list.map((b) => (
              <li key={b.id}>
                <label className="flex items-center gap-2 rounded-[var(--radius-sm)] px-1 py-1 text-sm hover:bg-surface-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-[var(--primary)]"
                    checked={chosen.includes(b.id)}
                    onChange={() => toggle(b.id)}
                    data-testid="ext-boards-option"
                  />
                  <span className="min-w-0 flex-1 truncate">{b.name}</span>
                  <span className="shrink-0 text-xs text-muted">{b.workspace_name}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted" dir={en ? 'ltr' : 'rtl'}>
          {t('ext.boards.count', { n: chosen.length, max: EXT_VIEW_MAX_BOARDS })}
        </p>
      </div>
    </Dialog>
  );
};

/**
 * The "+ view" menu's entries for the board views of enabled extensions — one per feature. Choosing one asks for
 * the tab's name and creates a view of type `extension` that names the installation and feature.
 */
export const useExtensionViewEntries = (
  accountId: string,
  boardId: string,
  create: (v: { name: string; settings: Partial<ViewSettings> }) => Promise<void>,
) => {
  const views = useExtensionBoardViews(accountId, boardId).data?.data ?? [];
  const en = getLocale() === 'en';
  return views.map((v) => {
    const name = (en ? v.name_en : null) ?? v.name;
    return {
      label: `${v.icon ? `${v.icon} ` : ''}${name} · ${v.extension_name}`,
      testId: `view-add-ext-${v.extension_key}-${v.feature}`,
      onSelect: async () => {
        const chosen = await promptDialog({ title: t('view.new'), label: t('view.name'), initial: name });
        if (!chosen) return;
        await create({
          name: chosen,
          settings: { extension: { installation_id: v.installation_id, feature: v.feature } },
        });
      },
    };
  });
};
