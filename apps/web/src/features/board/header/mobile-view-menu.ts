// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { t, type MessageKey, type ViewType } from '@bines/shared';
import type { MenuEntry } from '@bines/ui';
import type { View } from '../views/views-api';

/**
 * f9 views (product owner: "on the phone the views bar at the top should be a dropdown menu"): the entries
 * of the phone's views dropdown — every view (its type's icon, the current one marked), then the current view's
 * ⋯ actions, "+ new view" (the types, as the tab bar's "+") and "all views" (the sheet with every view's actions).
 * The app's `Menu` adds its search on top when there are many views.
 */
export const mobileViewMenuEntries = ({
  views,
  current,
  icon,
  onSelect,
  currentActions,
  addEntries,
  onManage,
  addIcon,
  actionsIcon,
  manageIcon,
}: {
  views: View[];
  current: View;
  icon: (type: ViewType) => ReactNode;
  onSelect: (id: string) => void;
  /** The current view's ⋯ menu (`useViewActions`); empty → no submenu. */
  currentActions: MenuEntry[];
  /** The "+ new view" choices; empty → no submenu. */
  addEntries: MenuEntry[];
  onManage: () => void;
  addIcon?: ReactNode;
  actionsIcon?: ReactNode;
  manageIcon?: ReactNode;
}): MenuEntry[] => [
  ...views.map((v): MenuEntry => ({
    label: v.name,
    icon: icon(v.type),
    current: v.id === current.id,
    testId: 'mobile-view-item',
    // The search finds a view by its type too ("kanban", "calendar").
    keywords: t(`view.type.${v.type}` as MessageKey),
    onSelect: () => {
      if (v.id !== current.id) onSelect(v.id);
    },
  })),
  { kind: 'separator' },
  ...(currentActions.length
    ? [
        {
          kind: 'submenu' as const,
          label: t('view.actions', { name: current.name }),
          items: currentActions,
          testId: 'mobile-view-actions',
          icon: actionsIcon,
        },
      ]
    : []),
  ...(addEntries.length
    ? [
        {
          kind: 'submenu' as const,
          label: t('view.add'),
          items: addEntries,
          testId: 'mobile-view-add-menu',
          icon: addIcon,
        },
      ]
    : []),
  {
    label: t('mobilehead.viewsManage'),
    onSelect: onManage,
    testId: 'mobile-view-manage',
    icon: manageIcon,
  },
];
