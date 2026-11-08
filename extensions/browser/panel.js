// SPDX-License-Identifier: AGPL-3.0-only
// The side panel: one iframe with Bines' panel page, told what the active tab shows. Everything the user sees inside
// is Bines itself (the app's own item card, signed in with the user's own session). This page keeps no data.
import { loadSettings, originOf, panelUrl } from './settings.js';

const frame = document.getElementById('bines');
let origin = null;
let selection = '';

/** What the active tab shows — its address only on sites the user allowed (optional host permissions). */
const tabFacts = async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) return { selection };
  return { url: tab.url, title: (tab.title ?? '').slice(0, 200), selection };
};

const send = async () => {
  if (!origin || frame.hidden || !frame.contentWindow) return;
  frame.contentWindow.postMessage({ type: 'bines-panel:context', params: await tabFacts() }, origin);
};

const start = async () => {
  const settings = await loadSettings();
  origin = originOf(settings.address);
  const url = panelUrl(settings, await tabFacts());
  document.getElementById('setup').hidden = !!url;
  document.getElementById('perm').hidden = true;
  frame.hidden = true;
  if (!url) return;
  // Without host permission for Bines the browser treats the frame as a third party: no session cookie.
  const granted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  document.getElementById('perm').hidden = granted;
  if (!granted) return;
  frame.src = url;
  frame.hidden = false;
};

document.getElementById('open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('grant').addEventListener('click', async () => {
  if (origin && (await chrome.permissions.request({ origins: [`${origin}/*`] }))) await start();
});

window.addEventListener('message', (e) => {
  if (e.source === frame.contentWindow && e.origin === origin && e.data?.type === 'bines-panel:ready') void send();
});
chrome.tabs.onActivated.addListener(() => void send());
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (tab.active && (change.url || change.title)) void send();
});
chrome.runtime.onMessage.addListener((m) => {
  if (m?.type === 'selection') {
    selection = String(m.text ?? '');
    void send();
  }
});

// Saved in the settings page, or a permission granted there, while the panel is open: start again.
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'sync') void start();
});
chrome.permissions.onAdded.addListener(() => void start());

chrome.storage.session.get('selection').then((s) => {
  if (typeof s.selection === 'string') selection = s.selection;
  void start();
});
