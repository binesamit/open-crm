// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchMe, queryKeys } from '../../lib/api';
import { getLocale, t, type ExtensionFrameFeature } from '@bines/shared';
import type { MenuEntry } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { useMembers } from '../board/board-api';
import { AppFrame, ExtensionModal, type FrameContext } from './AppFrame';
import { useExtensionFeatures } from './extensions-api';

/**
 * Where installed extensions show up besides board views (D27 ת3/ת5) — every slot is one entry of
 * GET /extensions/features (enabled, not killed, allowed on the board, guests only where allowed):
 * item-card tabs, board ⋯ / item menu entries and batch-bar buttons (a modal frame with the selection as context),
 * dashboard widgets and settings pages. Nothing here is specific to any extension.
 */

/** "📊 Name" in the account's language. */
export const featureLabel = (f: Pick<ExtensionFrameFeature, 'icon' | 'name' | 'name_en'>) => {
  const name = (getLocale() === 'en' ? f.name_en : null) ?? f.name;
  return f.icon ? `${f.icon} ${name}` : name;
};

/** Who the page is shown to (id + name): the signed-in user. */
export const useMe = (accountId: string, meId?: string) => {
  const session = useQuery({ queryKey: queryKeys.me, queryFn: fetchMe, staleTime: 5 * 60_000 }).data?.user;
  const id = meId || session?.id || '';
  const member = useMembers(accountId).data?.data.find((m) => m.user_id === id);
  return { id, name: member?.name ?? session?.name ?? '' };
};

/** One menu / batch action open in its modal frame. */
const ActionDialog = ({
  accountId,
  boardId,
  meId,
  feature,
  context,
  onOpenItem,
  onClose,
}: {
  accountId: string;
  boardId: string;
  meId: string;
  feature: ExtensionFrameFeature;
  context: FrameContext;
  onOpenItem?: (itemId: string) => void;
  onClose: () => void;
}) => {
  const user = useMe(accountId, meId);
  return (
    <ExtensionModal
      accountId={accountId}
      view={feature}
      place={{ board_id: boardId }}
      context={context}
      user={user}
      width={feature.modal?.width ?? 560}
      height={feature.modal?.height ?? 420}
      onOpenItem={onOpenItem}
      onClose={onClose}
    />
  );
};

/**
 * Menu entries of the extensions' `board_menu_action` (the board ⋯ menu: `where = 'board'`; the item menu:
 * `'item'`) or `batch_action` (`'batch'`) features on this board, and the modal frame one of them opened.
 */
export const useExtensionActions = ({
  accountId,
  boardId,
  meId,
  where,
  itemIds,
  onOpenItem,
  enabled = true,
}: {
  accountId: string;
  /** The top-level board (a subitem's actions are its root board's). */
  boardId: string;
  meId: string;
  where: 'board' | 'item' | 'batch';
  itemIds: string[];
  onOpenItem?: (itemId: string) => void;
  enabled?: boolean;
}): {
  entries: MenuEntry[];
  features: ExtensionFrameFeature[];
  open: (f: ExtensionFrameFeature) => void;
  dialog: ReactNode;
} => {
  const all = useExtensionFeatures(accountId, boardId, enabled).data?.data ?? [];
  const [opened, setOpened] = useState<{ feature: ExtensionFrameFeature; itemIds: string[] } | null>(null);
  const features = all.filter((f) =>
    where === 'batch' ? f.type === 'batch_action' : f.type === 'board_menu_action' && !!f.contexts?.includes(where),
  );
  const open = (feature: ExtensionFrameFeature) => setOpened({ feature, itemIds: [...itemIds] });
  const entries: MenuEntry[] = features.length
    ? [
        { kind: 'separator' },
        ...features.map((f) => ({
          label: `${featureLabel(f)} · ${f.extension_name}`,
          icon: <Icon name="ext" size={16} />,
          testId: `ext-action-${f.extension_key}-${f.feature}`,
          onSelect: () => open(f),
        })),
      ]
    : [];
  const surface: FrameContext['surface'] = where === 'batch' ? 'batch_action' : 'board_menu_action';
  const dialog = opened ? (
    <ActionDialog
      accountId={accountId}
      boardId={boardId}
      meId={meId}
      feature={opened.feature}
      context={{
        surface,
        board_id: boardId,
        item_id: where === 'item' ? (opened.itemIds[0] ?? null) : null,
        selection: { item_ids: opened.itemIds },
      }}
      onOpenItem={onOpenItem}
      onClose={() => setOpened(null)}
    />
  ) : null;
  return { entries, features, open, dialog };
};

/** The item card's extension tabs (`item_view` features on the item's root board). */
export const useExtensionItemTabs = (accountId: string, rootBoardId: string | undefined) =>
  (useExtensionFeatures(accountId, rootBoardId, !!rootBoardId).data?.data ?? []).filter((f) => f.type === 'item_view');

export const extensionTabId = (f: Pick<ExtensionFrameFeature, 'installation_id' | 'feature'>) =>
  `ext:${f.installation_id}:${f.feature}`;

/** An extension's tab in the item card: its page with the item as context. */
export const ExtensionItemTab = ({
  accountId,
  boardId,
  itemId,
  meId,
  feature,
  onOpenItem,
}: {
  accountId: string;
  boardId: string;
  itemId: string;
  meId: string;
  feature: ExtensionFrameFeature;
  onOpenItem?: (itemId: string) => void;
}) => {
  const user = useMe(accountId, meId);
  return (
    <div data-testid="ext-item-tab" data-feature={feature.feature}>
      <AppFrame
        key={`${feature.installation_id}:${feature.feature}:${itemId}`}
        accountId={accountId}
        view={feature}
        place={{ board_id: boardId }}
        context={{ surface: 'item_view', board_id: boardId, item_id: itemId, selection: { item_ids: [itemId] } }}
        user={user}
        onOpenItem={onOpenItem}
        initialHeight={360}
      />
    </div>
  );
};

/** A dashboard widget of an extension (ת5): its page fills the widget; its token reads what this viewer may see. */
export const ExtensionWidget = ({
  accountId,
  dashboardId,
  widgetId,
  settings,
}: {
  accountId: string;
  dashboardId: string;
  widgetId: string;
  settings: { installation_id?: string | null; feature?: string | null };
}) => {
  const features = useExtensionFeatures(accountId).data;
  const user = useMe(accountId);
  const f = features?.data.find(
    (x) =>
      x.type === 'dashboard_widget' && x.installation_id === settings.installation_id && x.feature === settings.feature,
  );
  if (!features) return null;
  if (!f)
    return (
      <p className="p-3 text-sm text-muted" data-testid="ext-widget-unavailable">
        {t('ext.widget.unavailable')}
      </p>
    );
  return (
    <div className="h-full" data-testid="ext-widget">
      <AppFrame
        accountId={accountId}
        view={f}
        place={{ dashboard_id: dashboardId, widget_id: widgetId }}
        context={{ surface: 'dashboard_widget', board_id: '', dashboard_id: dashboardId, widget_id: widgetId }}
        user={user}
        fill
      />
    </div>
  );
};

/**
 * "+ widget" entries: one per extension widget (the generic `extension` type is never offered by itself) — only of
 * extensions that work in the dashboard's workspace.
 */
export const useExtensionWidgetEntries = (
  accountId: string,
  workspaceId: string,
  add: (v: { title: string; settings: Record<string, unknown> }) => void,
): MenuEntry[] =>
  (useExtensionFeatures(accountId, undefined, true, workspaceId).data?.data ?? [])
    .filter((f) => f.type === 'dashboard_widget')
    .map((f) => ({
      label: `${featureLabel(f)} · ${f.extension_name}`,
      icon: <Icon name="ext" size={16} />,
      testId: `widget-add-ext-${f.extension_key}-${f.feature}`,
      onSelect: () =>
        add({
          title: (getLocale() === 'en' ? f.name_en : null) ?? f.name,
          settings: { installation_id: f.installation_id, feature: f.feature },
        }),
    }));

/**
 * the extensions' pages for me (`user_settings_page`) under my profile — e.g. connecting my own calendar.
 * Each in its frame; the token reads no board and names me.
 */
export const ExtensionUserPages = ({ accountId }: { accountId: string }) => {
  const pages = (useExtensionFeatures(accountId).data?.data ?? []).filter((f) => f.type === 'user_settings_page');
  const user = useMe(accountId);
  if (!pages.length) return null;
  return (
    <section className="mt-4 space-y-3 border-t border-line pt-4" data-testid="profile-extension-pages">
      <h2 className="font-display text-base leading-snug font-bold text-heading">{t('profile.extensionPages')}</h2>
      {pages.map((f) => (
        <div key={`${f.installation_id}:${f.feature}`} className="space-y-1.5" data-testid="ext-user-page">
          <h3 className="text-sm font-semibold text-fg-2">{(getLocale() === 'en' ? f.name_en : null) ?? f.name}</h3>
          <AppFrame
            accountId={accountId}
            view={f}
            place={{}}
            context={{ surface: 'user_settings_page', board_id: '' }}
            user={user}
            initialHeight={320}
          />
        </div>
      ))}
    </section>
  );
};

/** An extension's settings page under Administration → תוספות (ת5): admins; no board content in its token. */
export const ExtensionSettingsPage = ({
  accountId,
  feature,
}: {
  accountId: string;
  feature: ExtensionFrameFeature;
}) => {
  const user = useMe(accountId);
  return (
    <div data-testid="ext-settings-page">
      <AppFrame
        accountId={accountId}
        view={feature}
        place={{}}
        context={{ surface: 'account_settings_page', board_id: '' }}
        user={user}
        initialHeight={420}
      />
    </div>
  );
};
