// SPDX-License-Identifier: AGPL-3.0-only
import type { MessageKey } from '../i18n';

/**
 * Keyboard shortcuts that work today (14 §15) — the Shift+? list is rendered from here, so a shortcut is listed
 * only once it is wired. `keys` use "Ctrl" (shown as ⌘ on macOS).
 */
export type Shortcut = { keys: string; label: MessageKey; scope: 'global' | 'board' | 'menu' };

export const SHORTCUTS: Shortcut[] = [
  { keys: 'Shift+?', label: 'shortcuts.help', scope: 'global' },
  { keys: 'Ctrl+Z', label: 'shortcuts.undo', scope: 'global' },
  { keys: 'Ctrl+Shift+Z', label: 'shortcuts.redo', scope: 'global' },
  { keys: 'Ctrl+B', label: 'shortcuts.quickSearch', scope: 'global' },
  { keys: 'Esc', label: 'shortcuts.close', scope: 'global' },
  { keys: 'Ctrl+F', label: 'shortcuts.search', scope: 'board' },
  { keys: 'Ctrl+G', label: 'shortcuts.collapseGroups', scope: 'board' },
  { keys: 'Ctrl+Shift+L', label: 'shortcuts.activityLog', scope: 'board' },
  { keys: 'Ctrl+A', label: 'shortcuts.selectAll', scope: 'board' },
  { keys: 'Shift+click', label: 'shortcuts.range', scope: 'board' },
  { keys: '↑ ↓ ← →', label: 'shortcuts.gridMove', scope: 'board' },
  { keys: 'Tab', label: 'shortcuts.gridTab', scope: 'board' },
  { keys: 'Enter', label: 'shortcuts.gridEdit', scope: 'board' },
  { keys: 'Shift+↑ ↓ ← →', label: 'shortcuts.gridRange', scope: 'board' },
  { keys: 'Ctrl+C / X / V', label: 'shortcuts.gridCopy', scope: 'board' },
  { keys: 'Delete', label: 'shortcuts.gridClear', scope: 'board' },
  { keys: 'Delete', label: 'shortcuts.deleteSelection', scope: 'board' },
  { keys: 'Esc', label: 'shortcuts.clearSelection', scope: 'board' },
  { keys: 'Shift+F10', label: 'shortcuts.contextMenu', scope: 'menu' },
  { keys: '↑ ↓', label: 'shortcuts.menuMove', scope: 'menu' },
  { keys: 'Enter', label: 'shortcuts.menuChoose', scope: 'menu' },
];
