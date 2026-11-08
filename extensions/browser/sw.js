// SPDX-License-Identifier: AGPL-3.0-only
// The service worker: opens the side panel from the toolbar button, and offers "Search in Bines" on selected text.
const MENU = 'bines-search-selection';

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.create({ id: MENU, title: 'חפש ב-Bines', contexts: ['selection'] });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU || !tab?.windowId) return;
  const text = String(info.selectionText ?? '').slice(0, 500);
  await chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  // The panel may still be loading: it also reads the last selection when it starts.
  await chrome.storage.session.set({ selection: text });
  chrome.runtime.sendMessage({ type: 'selection', text }).catch(() => {});
});
