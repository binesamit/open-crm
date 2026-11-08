// SPDX-License-Identifier: AGPL-3.0-only
import { loadSettings, originOf, panelUrl, parsePanelUrl, saveSettings } from './settings.js';

const $ = (id) => document.getElementById(id);

const s = await loadSettings();
$('panel').value = panelUrl(s) ?? '';
$('sites').value = s.sites.join('\n');

$('save').addEventListener('click', async () => {
  const panel = parsePanelUrl($('panel').value);
  const sites = $('sites')
    .value.split('\n')
    .map((x) => originOf(x))
    .filter(Boolean);
  if (!panel) {
    $('msg').textContent = 'הכתובת לא נראית ככתובת פאנל. מעתיקים אותה ב-Bines: תוספות › "פאנל דפדפן".';
    return;
  }
  // Bines' origin: the session cookie reaches the panel only with it. The sites: so the panel can read their address.
  let ok = false;
  let why = '';
  try {
    ok = await chrome.permissions.request({ origins: [panel.address, ...sites].map((o) => `${o}/*`) });
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  await saveSettings({ ...panel, sites });
  $('msg').textContent = ok
    ? 'נשמר. אפשר לחזור לפאנל.'
    : `נשמר, אבל הדפדפן לא אישר הרשאה${why ? ` (${why})` : ''}. בפאנל יש כפתור "אשר הרשאה".`;
});
